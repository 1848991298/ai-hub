#!/usr/bin/env python3
"""在临时目录验证安装和迁移；不触碰真实客户端安装。"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parent.parent


class HubTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ai-hub-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / '维护源 有空格'
        self.home = self.base / '新用户 有空格'
        shutil.copytree(SOURCE, self.root, ignore=shutil.ignore_patterns('.backups', '__pycache__', 'archive', '.git', 'node_modules', 'dist', '.build', '.local'))
        fixture = self.root / 'skills/publish-app/SKILL.md'
        if not fixture.exists():
            fixture.parent.mkdir(parents=True, exist_ok=True)
            fixture.write_text('---\nname: publish-app\ndescription: 隔离测试夹具\n---\n仅用于临时目录测试。\n')
            with (self.root / 'manifest.tsv').open('a') as manifest:
                manifest.write('canonical\tpublish-app\tfixture\n')
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('AI_HUB_') and k != 'CODEX_HOME'}

    def command(self, *args, root=None, success=True):
        root = root or self.root
        result = subprocess.run([sys.executable, str(root / 'scripts/hub.py'), *args], env=self.env, capture_output=True, text=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def pull(self, *args, **kwargs):
        return self.command('pull', '--home', str(self.home), *args, **kwargs)

    def test_check_apply_idempotence_and_shared_edit(self):
        self.pull('--check')
        self.assertFalse(self.home.exists())
        self.assertFalse((self.root / '.backups').exists())
        self.pull('--apply')
        for side in ('.cursor', '.codex', '.agents'):
            path = self.home / side / 'skills/publish-app/SKILL.md'
            self.assertEqual(path.resolve(), self.root / 'skills/publish-app/SKILL.md')
        original = (self.root / 'skills/publish-app/SKILL.md').read_text()
        (self.root / 'skills/publish-app/SKILL.md').write_text(original + '\n共享变更\n')
        self.assertIn('共享变更', (self.home / '.cursor/skills/publish-app/SKILL.md').read_text())
        before = sorted((self.root / '.backups').iterdir())
        self.pull('--apply')
        self.assertEqual(before, sorted((self.root / '.backups').iterdir()))
        self.command('doctor', '--home', str(self.home))

    def test_divergence_prevents_all_writes(self):
        target = self.home / '.cursor/skills/publish-app'
        target.mkdir(parents=True)
        (target / 'SKILL.md').write_text('另一个客户端尚未整合的修改')
        self.pull('--check', success=False)
        self.pull('--apply', success=False)
        self.assertFalse((self.home / '.ai-hub').exists())
        self.assertEqual((target / 'SKILL.md').read_text(), '另一个客户端尚未整合的修改')

    def test_global_rule_divergence_is_preserved(self):
        target = self.home / '.codex/AGENTS.md'
        target.parent.mkdir(parents=True)
        target.write_text('另一台机器自己的规则')
        self.pull('--apply', success=False)
        self.assertEqual(target.read_text(), '另一台机器自己的规则')

    def test_move_hub_relinks_stable_anchor(self):
        self.pull('--apply')
        moved = self.base / '另一个任意位置'
        self.root.rename(moved)
        self.pull('--apply', root=moved, success=False)
        self.pull('--apply', '--relocate', root=moved)
        self.assertEqual((self.home / '.codex/AGENTS.md').resolve(), moved / 'rules/global.md')
        self.command('doctor', '--home', str(self.home), root=moved)

    def test_restore_original_files_and_preserve_unrelated_skills(self):
        rules = self.home / '.codex/AGENTS.md'
        rules.parent.mkdir(parents=True)
        shutil.copyfile(self.root / 'rules/global.md', rules)
        readme = self.home / '.agents/README.md'
        readme.parent.mkdir(parents=True)
        readme.write_text('其他技能说明，不能丢\n')
        other = self.home / '.agents/skills/another/SKILL.md'
        other.parent.mkdir(parents=True)
        other.write_text('其他技能')
        self.pull('--apply')
        self.assertTrue(readme.read_text().startswith('其他技能说明，不能丢'))
        backup = next((self.root / '.backups').iterdir())
        self.command('restore', '--backup', str(backup))
        self.assertTrue(rules.is_symlink())
        self.command('restore', '--backup', str(backup), '--apply')
        self.assertFalse(rules.is_symlink())
        self.assertEqual(readme.read_text(), '其他技能说明，不能丢\n')
        self.assertEqual(other.read_text(), '其他技能')
        self.assertFalse((self.home / '.ai-hub').is_symlink())

    def test_restore_refuses_new_changes(self):
        self.pull('--apply')
        readme = self.home / '.agents/README.md'
        readme.write_text(readme.read_text() + '\n安装之后的新说明\n')
        backup = next((self.root / '.backups').iterdir())
        self.command('restore', '--backup', str(backup), '--apply', success=False)
        self.assertIn('安装之后的新说明', readme.read_text())
        self.assertTrue((self.home / '.codex/AGENTS.md').is_symlink())

    def test_failed_mapping_rolls_back_existing_file(self):
        spec = importlib.util.spec_from_file_location('temporary_hub', self.root / 'scripts/hub.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        dest = self.home / 'standalone-file'
        dest.parent.mkdir(parents=True)
        dest.write_text('原文')
        with patch.object(Path, 'symlink_to', side_effect=OSError('模拟写入失败')):
            with self.assertRaises(OSError):
                module.apply_jobs([dict(label='故障', dest=str(dest), target=str(self.root / 'RULE.md'), kind='link')])
        self.assertEqual(dest.read_text(), '原文')

    def test_export_and_install_without_original_paths(self):
        self.pull('--apply')
        (self.root / '.backups/private.txt').write_text('不能带走')
        for folder in ('.local', '.build', 'ui/node_modules', 'ui/dist'):
            (self.root / folder).mkdir(parents=True, exist_ok=True)
            (self.root / folder / 'private.txt').write_text('不得进入来源包')
        output = self.base / '迁移包.tar.gz'
        self.command('export', '--output', str(output))
        extracted = self.base / '迁移后'
        with tarfile.open(output) as archive:
            names = archive.getnames()
            for excluded in ('.backups/', '/archive/', '/.local/', '/.build/', '/node_modules/', '/dist/'):
                self.assertFalse(any(excluded in name for name in names), excluded)
            self.assertIn('ai-hub/ui/src/themes.js', names)
            self.assertIn('ai-hub/desktop/macos/main.swift', names)
            self.assertIn('ai-hub/scripts/build_macos_app.py', names)
            archive.extractall(extracted)
        new_root = extracted / 'ai-hub'
        checksums = json.loads((new_root / 'CHECKSUMS.json').read_text())
        for name, digest in checksums.items():
            self.assertEqual(hashlib.sha256((new_root / name).read_bytes()).hexdigest(), digest)
        shutil.rmtree(self.root)
        self.command('pull', '--home', str(self.base / '另一台机器'), '--apply', root=new_root)
        self.command('doctor', '--home', str(self.base / '另一台机器'), root=new_root)


if __name__ == '__main__':
    unittest.main(verbosity=2)
