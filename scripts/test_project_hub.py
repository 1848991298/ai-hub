#!/usr/bin/env python3
"""隔离验证工程识别、登记与外部客户端边界，不读取真实工程、不打开窗口。"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock
import project_hub as projects


class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='hub-project-test-'); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); (self.root/'ui').mkdir(); (self.root/'ui/projects.json').write_text('[]')
        self.service=projects.ProjectService(self.root)
        self.repo=self.root/'中文 项目'; self.repo.mkdir()
        self.command('init','-b','main')
        (self.repo/'package.json').write_text('{"name":"test"}')

    def command(self,*args):
        return subprocess.run(['git','-C',str(self.repo),*args],capture_output=True,text=True,check=True,
                              env=dict(os.environ,GIT_AUTHOR_NAME='Fixture',GIT_AUTHOR_EMAIL='fixture@example.invalid',GIT_COMMITTER_NAME='Fixture',GIT_COMMITTER_EMAIL='fixture@example.invalid')).stdout

    def register(self,path=None):
        selected=self.service.prepare_selection(path or self.repo)
        return self.service.add({'selection_token':selected['selection_token'],'name':'示例工程','description':'测试'})

    def test_remote_detection_redacts_credentials_and_does_not_guess_private_host(self):
        for raw in ['https://alice:SECRET@github.com/org/repo.git?token=SECRET#secret','git@github.com:org/repo.git','ssh://git@github.com:2222/org/repo.git']:
            result=projects.remote_info('origin',raw)
            self.assertEqual(result['platform'],'GitHub'); self.assertEqual(result['repository'],'org/repo'); self.assertNotIn('SECRET',json.dumps(result))
        self.assertEqual(projects.remote_info('origin','git@192.168.1.2:team/repo.git')['platform'],'自建 Git')
        self.assertEqual(projects.remote_info('origin','https://gitlab.com/group/repo.git')['platform'],'GitLab')

    def test_git_local_plain_and_unknown_paths_are_distinct(self):
        self.assertEqual(projects.inspect_project(self.repo)['platform'],'本地 Git')
        ordinary=self.root/'ordinary';ordinary.mkdir()
        self.assertEqual(projects.inspect_project(ordinary)['platform'],'普通目录')
        self.assertEqual(projects.inspect_project(self.root/'absent')['platform'],'路径不可用')
        self.command('remote','add','origin','https://github.com/org/repo.git')
        entry=self.service.snapshot({'id':'x','path':str(self.repo),'platform':'待核实'})
        self.assertEqual(entry['platform'],'GitHub');self.assertEqual(entry['registered_platform'],'待核实')

    def test_subdirectory_normalizes_to_worktree_root_and_duplicate_is_explained(self):
        child=self.repo/'lib';child.mkdir()
        self.assertEqual(self.service.prepare_selection(child)['candidate']['path'],str(self.repo.resolve()))
        self.register()
        self.assertIsNotNone(self.service.prepare_selection(child)['candidate']['existing_id'])
        with self.assertRaises(projects.ProjectError):self.register(child)

    def test_registration_persists_across_clients_and_preserves_repository(self):
        before=(self.repo/'package.json').read_bytes()
        entry=self.register()
        self.assertIn('JavaScript / TypeScript',entry['tags'])
        self.assertEqual(entry['branch'],'main')
        self.assertEqual(projects.ProjectService(self.root).entries()[0]['id'],entry['id'])
        self.assertEqual(self.service.registry.stat().st_mode & 0o777,0o600)
        self.assertEqual((self.root/'ui/projects.json').read_text(),'[]')
        self.assertEqual((self.repo/'package.json').read_bytes(),before)
        self.assertEqual(self.command('branch','--show-current').strip(),'main')

    def test_add_rejects_raw_paths_commands_and_expired_tokens(self):
        for value in [{'path':str(self.repo)}, {'selection_token':'bad','name':'x','description':''}, {'selection_token':'bad','name':'x','description':'','command':'id'}]:
            with self.assertRaises(projects.ProjectError):self.service.add(value)
        selected=self.service.prepare_selection(self.repo)
        self.service.selections[selected['selection_token']]['created']-=601
        with self.assertRaises(projects.ProjectError):self.service.add({'selection_token':selected['selection_token'],'name':'x','description':''})
        self.assertFalse(self.service.registry.exists())

    def test_cancelled_or_failed_picker_does_not_register_anything(self):
        def cancelled(args,**options):
            Path(args[-1]).write_text('{"status":"cancelled"}');return Mock(returncode=0)
        executable='/fixed/ProjectPicker.app/Contents/MacOS/AIHubProjectPicker'
        with patch.object(self.service,'picker',return_value=executable), patch.object(projects.subprocess,'run',side_effect=cancelled) as run:
            self.assertEqual(self.service.pick(),{'status':'cancelled'});self.assertEqual(run.call_args.args[0][:4],['/usr/bin/open','-W','-n','/fixed/ProjectPicker.app'])
        with patch.object(self.service,'picker',return_value=executable), patch.object(projects.subprocess,'run',side_effect=subprocess.TimeoutExpired('picker',315)):
            with self.assertRaises(projects.ProjectError):self.service.pick()
        self.assertFalse(self.service.picker_lock.locked());self.assertFalse(self.service.registry.exists())

    def test_missing_picker_is_explicit(self):
        with patch.object(self.service,'picker',return_value=None):
            self.assertFalse(self.service.capabilities()['directory_picker'])
            with self.assertRaises(projects.ProjectError) as error:self.service.pick()
            self.assertEqual(error.exception.status,503)

    def test_branch_and_worktree_view_does_not_checkout(self):
        self.command('add','package.json');self.command('commit','-m','fixture')
        self.command('branch','feature/example')
        worktree=self.root/'另一个 工作树';self.command('worktree','add',str(worktree),'feature/example')
        entry=self.register();details=self.service.details(entry['id'])
        self.assertEqual(len(details['worktrees']),2)
        target=next(branch for branch in details['branches'] if branch['name']=='feature/example')
        self.assertEqual(len(target['worktree_ids']),1)
        self.assertEqual(self.command('branch','--show-current').strip(),'main')
        self.assertTrue(any(tree['path']==str(worktree.resolve()) for tree in details['worktrees']))

    def test_git_view_reads_alternate_ref_history_and_commit_rename_without_checkout(self):
        original = self.repo / 'package.json'
        original.write_text('old line\n' + 'shared line\n' * 12)
        self.command('add', 'package.json')
        self.command('commit', '-m', '起始提交')
        main = self.command('rev-parse', 'HEAD').strip()
        tree = self.root / 'feature'
        self.command('worktree', 'add', '-b', 'feature/diff', str(tree))
        self.command('-C', str(tree), 'mv', 'package.json', '新 名.json')
        (tree / '新 名.json').write_text('new line\n' + 'shared line\n' * 12)
        self.command('-C', str(tree), 'add', '--', '新 名.json')
        self.command('-C', str(tree), 'commit', '-m', '重命名并修改')
        project_id = self.register()['id']
        branch = next(item for item in self.service.details(project_id)['branches'] if item['name'] == 'feature/diff')
        history = self.service.git_view(project_id, 'history', {'head': [branch['oid']], 'offset': ['0']})
        self.assertEqual([row['title'] for row in history['commits']], ['重命名并修改', '起始提交'])
        query = {'commit': [branch['oid']]}
        file, = self.service.git_view(project_id, 'files', query)['files']
        self.assertEqual((file['path'], file['previous_path'], file['status'][0]), ('新 名.json', 'package.json', 'R'))
        patch = self.service.git_view(project_id, 'diff', {**query, 'file': [file['id']]})['patch']
        self.assertIn('-old line\n+new line', patch)
        root_file, = self.service.git_view(project_id, 'files', {'commit': [main]})['files']
        self.assertEqual(root_file['status'], 'A')
        self.assertEqual(self.command('rev-parse', 'HEAD').strip(), main)
        self.assertEqual(self.command('status', '--porcelain'), '')

    def test_git_view_separates_worktree_diffs_and_only_reads_listed_paths(self):
        self.command('add', 'package.json')
        self.command('commit', '-m', 'baseline')
        tracked = self.repo / 'package.json'
        tracked.write_text('staged\n')
        self.command('add', 'package.json')
        tracked.write_text('unstaged\n')
        (self.repo / 'new [file].txt').write_text('untracked\n')
        outside = self.root / 'outside'
        outside.write_text('outside content')
        (self.repo / 'link').symlink_to(outside)
        project_id = self.register()['id']
        worktree = self.service.details(project_id)['worktrees'][0]['id']
        query = {'worktree': [worktree]}
        before = self.command('status', '--porcelain')
        groups = self.service.git_view(project_id, 'changes', query)

        def diff(group, file):
            return self.service.git_view(project_id, 'diff', {**query, 'group': [group], 'file': [file]})['patch']

        self.assertIn('+staged\n', diff('staged', groups['staged'][0]['id']))
        self.assertIn('-staged\n+unstaged\n', diff('unstaged', groups['unstaged'][0]['id']))
        new_files = {file['path']: file['id'] for file in groups['untracked']}
        self.assertIn('+untracked\n', diff('untracked', new_files['new [file].txt']))
        self.assertEqual(diff('untracked', new_files['link']), '')
        with self.assertRaises(projects.ProjectError):
            diff('untracked', '../outside')
        with self.assertRaises(projects.ProjectError):
            self.service.git_view(project_id, 'history', {'head': ['--all'], 'offset': ['0']})
        self.assertEqual(self.command('status', '--porcelain'), before)

    def test_open_client_only_accepts_registered_ids_and_fixed_arguments(self):
        entry=self.register()
        with self.assertRaises(projects.ProjectError):self.service.open_sourcetree({'project_id':'../other'})
        details=self.service.details(entry['id'])
        with patch.object(self.service,'details',return_value=details),patch.object(self.service,'sourcetree',return_value='/fixed/stree'),patch.object(projects.subprocess,'Popen') as popen:
            self.service.open_sourcetree({'project_id':entry['id']})
            self.assertEqual(popen.call_args.args[0],['/fixed/stree',str(self.repo.resolve())])
            self.assertNotIn('shell',popen.call_args.kwargs)
            for value in [{'path':'/tmp/other'},{'project_id':entry['id'],'worktree_id':'made-up'}]:
                with self.assertRaises(projects.ProjectError):self.service.open_sourcetree(value)
            self.assertEqual(popen.call_count,1)

    def test_corrupt_registry_is_preserved_instead_of_overwritten(self):
        self.service.registry.parent.mkdir();self.service.registry.write_text('{broken')
        with self.assertRaises(projects.ProjectError):self.service.entries()
        self.assertEqual(self.service.registry.read_text(),'{broken')

    def test_read_failures_and_rename_counts_do_not_become_clean(self):
        self.assertIsNone(projects.change_count(None))
        self.assertEqual(projects.change_count('R  新名\0旧名\0 M changed\0'),2)
        with patch.object(projects,'git',return_value=None):self.assertIsNone(projects.inspect_project(self.repo)['changes'])

if __name__=='__main__':unittest.main(verbosity=2)
