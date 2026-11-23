#!/usr/bin/env python3
import argparse
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from branch_registry import read_records, record, refresh_all, registry_path, remote_heads
from project_hub import remote_info


class BranchRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.hub = root / 'hub'
        self.hub.mkdir()
        self.remote = root / 'remote.git'
        self.remote.mkdir()
        self.repo = root / 'repo'
        self.repo.mkdir()
        self.tree = root / 'feature'
        self.git(self.remote, 'init', '--bare')
        self.git(self.repo, 'init', '-b', 'master')
        (self.repo / 'base.txt').write_text('base\n')
        self.git(self.repo, 'add', 'base.txt')
        self.git(self.repo, 'commit', '-m', 'base')
        self.git(self.repo, 'remote', 'add', 'origin', str(self.remote))
        self.git(self.repo, 'push', 'origin', 'HEAD:master', 'HEAD:dev', 'HEAD:release/1')
        self.git(self.repo, 'worktree', 'add', '-b', 'codex/feature', str(self.tree))

    def git(self, repo, *args):
        env = dict(os.environ, GIT_AUTHOR_NAME='Test', GIT_AUTHOR_EMAIL='test@example.com',
                   GIT_COMMITTER_NAME='Test', GIT_COMMITTER_EMAIL='test@example.com')
        return subprocess.run(['git', '-C', str(repo), *args], capture_output=True, check=True,
                              env=env, text=True).stdout.strip()

    def params(self, **overrides):
        params = dict(repo=str(self.tree), branch=None, purpose=None, base=None, remote=None, main=None,
                      dev=None, release=None, landing=None, compare=None, candidate=False, online=True,
                      proof=[], archive=None, keep=False)
        return argparse.Namespace(**{**params, **overrides})

    def update(self, **overrides):
        return record(self.hub, self.params(**overrides))

    def register(self, **overrides):
        return self.update(purpose='记录手机时区', base='origin/master', main='master', dev='dev',
                           release='release/1', landing=['main', 'dev'], **overrides)

    def task_commit(self):
        (self.tree / 'task.txt').write_text('new behavior\n')
        self.git(self.tree, 'add', 'task.txt')
        self.git(self.tree, 'commit', '-m', 'work')
        return self.git(self.tree, 'rev-parse', 'HEAD')

    def test_base_commit_is_not_a_merge_and_uncommitted_files_remain(self):
        self.assertEqual(read_records(self.hub), [])
        self.assertFalse(registry_path(self.hub).exists())
        (self.tree / 'work-in-progress').write_text('keep')
        before = self.git(self.tree, 'status', '--porcelain')
        row = self.register()
        self.assertEqual(row['verification'], 'remote')
        self.assertEqual(row['targets']['main']['state'], 'uncommitted')
        self.assertEqual(row['targets']['dev']['name'], 'dev')
        self.assertEqual(row['targets']['release']['state'], 'uncommitted')
        self.assertTrue(row['directories'][0]['dirty'])
        self.assertEqual(row['cleanup'], 'waiting')
        self.assertIsNone(row['publication'])
        self.assertEqual(self.git(self.tree, 'status', '--porcelain'), before)
        self.assertEqual(registry_path(self.hub).stat().st_mode & 0o777, 0o600)

    def test_updates_one_row_and_requires_all_planned_remote_targets(self):
        original = self.register()
        candidate = self.task_commit()
        self.git(self.tree, 'push', 'origin', 'HEAD:dev')
        row = self.update(candidate=True)
        self.assertEqual(row['targets']['dev']['state'], 'merged')
        self.assertEqual(row['targets']['main']['state'], 'not_contained')
        self.assertEqual(row['cleanup'], 'waiting')
        self.git(self.tree, 'push', 'origin', 'HEAD:master')
        self.assertEqual(self.update(online=False)['cleanup'], 'waiting')
        row = self.update()
        self.assertEqual(row['id'], original['id'])
        self.assertEqual(len(read_records(self.hub)), 1)
        self.assertEqual(row['targets']['dev']['head'], candidate)
        self.assertEqual(row['targets']['release']['state'], 'not_contained')
        self.assertEqual(row['cleanup'], 'review')
        (self.tree / 'local-note').write_text('saved locally')
        self.assertEqual(self.update()['cleanup'], 'blocked')
        self.assertEqual(self.update(keep=True)['cleanup'], 'kept')
        self.assertTrue((self.tree / 'local-note').exists())
        self.git(self.tree, 'commit', '--allow-empty', '-m', 'another change')
        self.assertEqual(self.update()['targets']['dev']['state'], 'candidate_pending')

    def test_squash_receipt_verifies_candidate_and_target_containment(self):
        candidate = self.task_commit()
        self.git(self.repo, 'merge', '--squash', 'codex/feature')
        self.git(self.repo, 'commit', '-m', 'squash')
        merged = self.git(self.repo, 'rev-parse', 'HEAD')
        self.git(self.repo, 'push', 'origin', 'HEAD:master')
        with patch('branch_registry.remote_info', return_value=remote_info('origin', 'https://codeup.aliyun.com/example/repo.git')):
            self.register()
            self.assertEqual(self.update(candidate=True)['targets']['main']['state'], 'not_contained')
            row = self.update(proof=[('main', candidate, merged, 'https://codeup.aliyun.com/example/repo/merges/8')])
        self.assertEqual(row['targets']['main']['method'], 'receipt')
        self.assertEqual(row['targets']['main']['evidence']['merge'], merged)
        self.assertEqual(row['targets']['dev']['state'], 'not_contained')

    def test_remote_comparison_fetches_missing_target_without_changing_source_repo(self):
        self.register()
        candidate = self.task_commit()
        self.git(self.tree, 'push', 'origin', 'HEAD:codex/feature')
        other = self.repo.parent / 'publisher'
        self.git(self.repo.parent, 'clone', '--branch', 'release/1', str(self.remote), str(other))
        self.git(other, 'merge', '--ff-only', 'origin/codex/feature')
        self.git(other, 'commit', '--allow-empty', '-m', 'release update')
        new_release = self.git(other, 'rev-parse', 'HEAD')
        self.git(other, 'push', 'origin', 'HEAD:release/1')
        locally_known = self.git(self.repo, 'rev-parse', 'origin/release/1')
        fetch_head = self.repo / '.git' / 'FETCH_HEAD'
        before = fetch_head.read_bytes() if fetch_head.exists() else None
        row = self.update(candidate=True)
        self.assertEqual(row['candidate'], candidate)
        self.assertEqual(row['targets']['release']['head'], new_release)
        self.assertEqual(row['targets']['release']['state'], 'merged')
        self.assertEqual(self.git(self.repo, 'rev-parse', 'origin/release/1'), locally_known)
        self.assertEqual(fetch_head.read_bytes() if fetch_head.exists() else None, before)
        with self.assertRaises(subprocess.CalledProcessError):
            self.git(self.repo, 'cat-file', '-e', new_release)

    def test_refresh_all_reuses_remote_snapshot_and_reports_primary_checkout(self):
        self.register()
        (self.repo / 'local-note').write_text('in progress')
        self.update(repo=str(self.repo), branch='master', purpose='主检出目录',
                    base='origin/master', main='master', compare=['dev'])
        with patch('branch_registry.remote_heads', wraps=remote_heads) as lookup:
            result = refresh_all(self.hub, self.params(repo=None))
        self.assertEqual(result['errors'], [])
        self.assertEqual(len(result['records']), 2)
        self.assertEqual(lookup.call_count, 1)
        root = next(row for row in result['records'] if row['branch'] == 'master')
        self.assertTrue(root['primary_directory']['dirty'])
        self.assertEqual(root['comparisons']['dev']['name'], 'dev')
        self.assertEqual(root['targets']['main']['state'], 'on_source')
        self.assertEqual(root['directories'], [])

    def test_integration_branch_cannot_treat_its_own_remote_as_a_merge(self):
        dev_tree = self.repo.parent / 'dev-tree'
        self.git(self.repo, 'worktree', 'add', '-b', 'dev', str(dev_tree))
        self.git(dev_tree, 'commit', '--allow-empty', '-m', 'dev integration')
        self.git(dev_tree, 'push', 'origin', 'HEAD:dev')
        row = self.update(repo=str(dev_tree), branch='dev', purpose='集成目录', base='origin/master',
                          dev='dev', candidate=True, landing=['dev'])
        self.assertEqual(row['targets']['dev']['state'], 'on_source')
        self.assertEqual(row['cleanup'], 'integration')

    def test_recognizes_codeup_without_forwarding_remote_credentials(self):
        row = remote_info('origin', 'https://someone:secret@example.codeup.aliyun.com/team/isho.git?q=auth')
        self.assertEqual(row['repository'], 'team/isho')
        self.assertNotIn('secret', str(row))
        self.assertEqual(remote_info('origin', 'git@codeup.aliyun.com:team/isho.git')['platform'], '云效 Codeup')


if __name__ == '__main__':
    unittest.main()
