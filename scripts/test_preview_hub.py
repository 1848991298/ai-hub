#!/usr/bin/env python3
"""界面只读快照的契约回归，不访问真实工程或客户端配置。"""
import importlib.util
import json
import http.client
from functools import partial
from http.server import ThreadingHTTPServer
import threading
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('preview_hub', Path(__file__).with_name('preview_hub.py'))
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='hub-preview-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for directory in ('ui', 'rules', 'skills/example'):
            (self.root / directory).mkdir(parents=True)
        (self.root / 'ui/projects.json').write_text('[]')
        (self.root / 'manifest.tsv').write_text('canonical\texample\ttest\n')
        (self.root / 'skills/example/SKILL.md').write_text('---\nname: example\ndescription: 一个测试技能\n---\n# 正文\n')
        (self.root / 'rules/global.md').write_text('# 全局规则\n\n## 第一章\n- 第一条\n\n## 第二章\n- 第二条\n')
        self.patch_root = patch.object(preview, 'ROOT', self.root)
        self.patch_root.start()
        self.addCleanup(self.patch_root.stop)

    def test_rules_sections_do_not_swallow_later_headings(self):
        with patch.object(preview, 'git', return_value=''):
            data = preview.snapshot()
        self.assertEqual([r['title'] for r in data['rules']['sections']], ['第一章', '第二章'])
        self.assertEqual(data['rules']['sections'][0]['body'], '- 第一条')
        self.assertEqual(data['rules']['sections'][1]['body'], '- 第二条')

    def test_worktree_status_keeps_leading_space_and_full_path(self):
        def git(path, *args):
            return ' M rules/global.md\n?? ui/new.txt' if args[0] == 'status' else ''
        with patch.object(preview, 'git', side_effect=git):
            data = preview.snapshot()
        self.assertEqual(data['changes'], [{'status': 'M', 'path': 'rules/global.md'}, {'status': '??', 'path': 'ui/new.txt'}])

    def test_snapshot_does_not_modify_sources(self):
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with patch.object(preview, 'git', return_value=''):
            data = preview.snapshot()
        after = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        self.assertEqual(data['skills'][0]['description'], '一个测试技能')
        self.assertEqual(len(data['skills'][0]['mappings']), 3)
        self.assertEqual((data['skills'][0]['title'], data['skills'][0]['category']), ('正文', '其他'))

    def test_skill_category_comes_from_manifest(self):
        (self.root / 'manifest.tsv').write_text('canonical\texample\ttest\t工程协作\tgit\n')
        with patch.object(preview, 'git', return_value=''):
            skill = preview.snapshot()['skills'][0]
        self.assertEqual((skill['category'], skill['icon']), ('工程协作', 'git'))

    def test_profile_uses_system_name_until_saved(self):
        with patch.object(preview, 'system_name', return_value='Leo'):
            self.assertEqual(preview.profile(), {'name': 'Leo', 'mark': 'L', 'subtitle': ''})
            saved = preview.save_profile({'name': '示例用户', 'mark': '示', 'subtitle': '构建自己的工作方式', 'extra': 'no'})
        self.assertEqual(saved['mark'], '示')
        self.assertNotIn('extra', (self.root / '.local/profile.json').read_text())
        self.assertEqual(preview.redact('token=abc.def'), 'token=[已隐藏]')

    def test_preferences_default_without_creating_local_files(self):
        self.assertEqual(preview.preferences(), {'theme': 'graphite'})
        self.assertFalse((self.root / '.local').exists())

    def test_preferences_save_only_the_local_theme(self):
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        for theme in preview.THEMES:
            self.assertEqual(preview.save_preferences({'theme': theme}), {'theme': theme})
            self.assertEqual(preview.preferences(), {'theme': theme})
        after = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file() and '.local' not in p.parts}
        self.assertEqual(before, after)
        self.assertEqual(len(list((self.root / '.local').iterdir())), 1)

    def test_preferences_reject_unsupported_fields_and_values(self):
        for value in ({'theme': '../rules/global.md'}, {'theme': 'midnight', 'path': 'rules/global.md'}, {'theme': []}, [], {}, None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                preview.save_preferences(value)
        self.assertFalse((self.root / '.local').exists())

    def test_damaged_preferences_fall_back_to_default(self):
        local = self.root / '.local'; local.mkdir()
        for content in ('{bad', '[]', '{"theme": []}', '{"theme": "unknown"}'):
            (local / 'ui-preferences.json').write_text(content)
            self.assertEqual(preview.preferences(), {'theme': 'graphite'})

    def test_http_theme_write_requires_same_origin_and_preserves_sources(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(preview.Handler, directory=str(self.root / 'ui')))
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        def request(method, path, body=None, origin=None, host=None):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
            headers = {'Host': host or f'127.0.0.1:{server.server_port}'}
            if origin: headers['Origin'] = origin
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse(); status = response.status; data = response.read(); connection.close()
            return status, data
        try:
            local = f'http://127.0.0.1:{server.server_port}'
            self.assertEqual(request('PUT', '/api/preferences', '{"theme":"plum"}', 'https://other.test')[0], 403)
            self.assertEqual(request('PUT', '/api/preferences', '{"theme":"plum"}')[0], 403)
            self.assertFalse((self.root / '.local').exists())
            self.assertEqual(request('PUT', '/api/preferences', '{"theme":"plum"}', local)[0], 200)
            self.assertEqual(json.loads(request('GET', '/api/preferences')[1]), {'theme': 'plum'})
            self.assertEqual(request('PUT', '/api/preferences', '{"theme":"bad"}', local)[0], 400)
            self.assertEqual(preview.preferences(), {'theme': 'plum'})
            self.assertEqual(request('PUT', '/api/preferences', 'x' * 1025, local)[0], 400)
            self.assertEqual(request('PUT', '/api/snapshot', '{}', local)[0], 404)
            self.assertEqual(request('GET', '/api/preferences', host='other.test')[0], 403)
            self.assertEqual(request('GET', '/.git/config')[0], 404)
            self.assertEqual(request('POST', '/api/preferences', '{}', local)[0], 501)
        finally:
            server.shutdown(); server.server_close(); worker.join()

    def test_task_context_rejects_stale_revision_and_unattributed_usage(self):
        path = preview.task_context_path('task', 'recExample')
        branch, folder = 'example', '/test/repo'
        value = dict.fromkeys(preview.TASK_CONTEXT_LIMITS, '')
        value.update(project_id='test', tree_id='a' * 16, branch=branch, path=folder,
                     source_ref='HEAD', source_sha='a' * 40, delivery='review')
        body = {'revision': 0, 'context': value}
        self.assertEqual(preview.task_context(path), {'revision': 0, 'context': None})
        with patch.object(preview, 'project_service') as service, patch.object(preview, 'project_git', return_value='commit'):
            service.return_value.worktree_context.return_value = {'path': folder, 'branch': branch}
            saved = preview.save_task_context(path, body)
            self.assertEqual(saved['revision'], 1)
            with self.assertRaisesRegex(preview.ProjectError, '另一窗口'):
                preview.save_task_context(path, body)
            body['revision'] = 1
            value['cursor_tokens'] = '10'
            with self.assertRaisesRegex(preview.ProjectError, '证据'):
                preview.save_task_context(path, body)
            value['cursor_usage_url'] = 'https://example.test/run'
            value['delivery'] = 'verified'
            with self.assertRaisesRegex(preview.ProjectError, '验收结果'):
                preview.save_task_context(path, body)
        self.assertEqual(preview.task_context(path), saved)

    def test_existing_non_repository_is_not_reported_clean(self):
        path = self.root / 'not-a-repo'
        path.mkdir()
        with patch.object(preview, 'git', return_value=''):
            result = preview.project_snapshot({'id': 'test', 'path': str(path)})
        self.assertIsNone(result['changes'])
        self.assertIsNone(result['branch'])

    def test_usage_http_requires_same_origin_and_accepts_no_command_parameters(self):
        service = preview.UsageService(self.root)
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(preview.Handler, directory=str(self.root / 'ui')))
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        def request(method, body=None, origin=None):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
            headers = {'Host': f'127.0.0.1:{server.server_port}'}
            if origin: headers['Origin'] = origin
            connection.request(method, '/api/usage' if method == 'GET' else '/api/usage/refresh', body=body, headers=headers)
            response = connection.getresponse(); status = response.status; value = response.read(); connection.close()
            return status, value
        try:
            with patch.object(preview, 'usage_service', return_value=service), patch.object(service, 'refresh', return_value=True) as refresh:
                self.assertEqual(request('GET')[0], 200); refresh.assert_not_called()
                self.assertEqual(request('POST', '{}')[0], 403)
                self.assertEqual(request('POST', '{}', 'https://other.test')[0], 403)
                local = f'http://127.0.0.1:{server.server_port}'
                self.assertEqual(request('POST', '{"cmd":"id"}', local)[0], 400)
                self.assertEqual(request('POST', '{}', local)[0], 202)
                self.assertEqual(refresh.call_count, 1)
                self.assertFalse((self.root / '.local').exists())
        finally:
            server.shutdown(); server.server_close(); worker.join()

    def test_project_actions_require_same_origin_and_do_not_accept_arbitrary_paths(self):
        service=preview.ProjectService(self.root)
        server=ThreadingHTTPServer(('127.0.0.1',0),partial(preview.Handler,directory=str(self.root/'ui')))
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        def request(path,body,origin=None):
            connection=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
            headers={'Host':f'127.0.0.1:{server.server_port}'}
            if origin:headers['Origin']=origin
            connection.request('POST',path,body=body,headers=headers)
            response=connection.getresponse();status=response.status;response.read();connection.close();return status
        try:
            local=f'http://127.0.0.1:{server.server_port}'
            with patch.object(preview,'project_service',return_value=service),patch.object(service,'pick',return_value={'status':'cancelled'}) as picker:
                self.assertEqual(request('/api/projects/pick','{}'),403)
                self.assertEqual(request('/api/projects/pick','{}','https://other.test'),403)
                self.assertEqual(request('/api/projects/pick','{"path":"/tmp"}',local),400)
                picker.assert_not_called()
                self.assertEqual(request('/api/projects/pick','{}',local),200)
                self.assertEqual(request('/api/projects/add','{"path":"/tmp"}',local),400)
                self.assertEqual(request('/api/projects/open-sourcetree','{"path":"/tmp"}',local),400)
                self.assertEqual(request('/api/projects/switch','{}',local),501)
                self.assertFalse(service.registry.exists())
        finally:
            server.shutdown();server.server_close();worker.join()


if __name__ == '__main__':
    unittest.main(verbosity=2)
