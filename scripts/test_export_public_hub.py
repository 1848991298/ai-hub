from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import export_public_hub as public

class PublicExportTests(unittest.TestCase):
    def test_only_generic_configuration_is_exported(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'public';count=public.export(root)
            files=[p for p in root.rglob('*') if p.is_file()]
            self.assertEqual(count,len(files))
            self.assertEqual({p.relative_to(root/'skills').as_posix() for p in (root/'skills').rglob('*') if p.is_file()},
                             {'README.md','commit-by-business/SKILL.md',
                              'git-worktree-audit/SKILL.md','git-worktree-audit/agents/openai.yaml',
                              'git-worktree-audit/scripts/audit.py','git-worktree-audit/scripts/test_audit.py'})
            self.assertEqual((root/'skills/commit-by-business/SKILL.md').read_bytes(),
                             (public.ROOT/'distribution/public/skills/commit-by-business/SKILL.md').read_bytes())
            for name in ('SKILL.md','agents/openai.yaml','scripts/audit.py','scripts/test_audit.py'):
                rel='skills/git-worktree-audit/'+name
                self.assertEqual((root/rel).read_bytes(),(public.ROOT/'distribution/public'/rel).read_bytes())
            self.assertFalse((root/'rules/clients').exists())
            self.assertFalse((root/'.local').exists())
            self.assertEqual([line.split('\t')[1] for line in (root/'manifest.tsv').read_text().splitlines() if line.startswith('canonical\t')],
                             ['commit-by-business','git-worktree-audit'])
            self.assertEqual([p['id'] for p in json.loads((root/'ui/projects.json').read_text())],['hub'])
            self.assertTrue((root/'desktop/macos/main.swift').is_file())
            self.assertTrue((root/'scripts/tracker_hub.py').is_file())
            self.assertTrue((root/'standalone/operations/server.py').is_file())
            for name in public.SCREENSHOTS:
                self.assertEqual((root/name).read_bytes(), (public.ROOT/name).read_bytes())
    def test_private_resource_token_and_path_are_blocked(self):
        for text in ('gh'+'p_'+'x'*35,'https://'+'private-team'+'.feishu.cn/base/ExampleResource'):
            with self.assertRaises(ValueError):public.audit({'test.py':text.encode()})
        with self.assertRaises(ValueError):public.audit({'test.py':b'fixturePrivateMarker'},['fixturePrivateMarker'])
        with self.assertRaises(ValueError):public.audit({'.local/config.json':b'fixture'})
    def test_screenshot_whitelist_does_not_allow_other_binary_content(self):
        for name in public.SCREENSHOTS:
            with self.assertRaises(ValueError): public.audit({name:b'not an image'})
        with self.assertRaises(ValueError): public.audit({'.local/overview.png':b'fixture'})
        with self.assertRaises(UnicodeDecodeError): public.audit({'unexpected.bin':b'\xff\x00'})

    def test_existing_content_is_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'keep').write_text('keep')
            with self.assertRaises(ValueError):public.export(root)
            self.assertEqual((root/'keep').read_text(),'keep')

    def test_exported_auditor_runs_without_maintenance_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'public';public.export(root)
            result=subprocess.run([sys.executable,str(root/'skills/git-worktree-audit/scripts/test_audit.py')],
                                  cwd=root,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)

    def test_missing_worktree_audit_files_never_fall_back_to_personal_source(self):
        names=('SKILL.md','agents/openai.yaml','scripts/audit.py','scripts/test_audit.py')
        for missing in names:
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as temp:
                source=Path(temp)/'source'
                for rel in public.PUBLIC_SKILLS:
                    path=source/'distribution/public'/rel
                    if rel=='skills/git-worktree-audit/'+missing:continue
                    path.parent.mkdir(parents=True,exist_ok=True);path.write_text('generic fixture')
                private=source/'skills/git-worktree-audit'/missing
                private.parent.mkdir(parents=True,exist_ok=True);private.write_text('private fixture must not be exported')
                target=Path(temp)/'public'
                with patch.object(public,'ROOT',source),patch.object(public,'TOP',()), \
                     patch.object(public,'SCREENSHOTS',()),patch.object(public,'TEMPLATES',()):
                    with self.assertRaisesRegex(ValueError,'来源缺失'):public.export(target)
                self.assertFalse(target.exists())

    def test_missing_generic_skill_never_falls_back_to_personal_skill(self):
        with tempfile.TemporaryDirectory() as temp:
            source=Path(temp)/'source'
            private=source/'skills/commit-by-business/SKILL.md'
            private.parent.mkdir(parents=True)
            private.write_text('private skill that must not be published')
            target=Path(temp)/'public'
            with patch.object(public,'ROOT',source), patch.object(public,'TOP',()), \
                 patch.object(public,'SCREENSHOTS',()), patch.object(public,'TEMPLATES',()):
                with self.assertRaisesRegex(ValueError,'来源缺失'):
                    public.export(target)
            self.assertFalse(target.exists())

if __name__=='__main__':unittest.main()
