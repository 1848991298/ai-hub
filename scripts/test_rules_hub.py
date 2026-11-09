#!/usr/bin/env python3
"""隔离 HOME 和来源，验证真实保存、并发冲突与客户端同步闭环。"""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from rules_hub import RulesService, RulesError, digest, plain_title

class FakeCursor:
    def __init__(self, texts):
        self.texts = texts[:]
        self.writes = []
    def read(self): return self.texts[:]
    def write(self, old, new):
        if old is not None:
            if self.texts.count(old) != 1: raise RulesError('外部冲突', 409)
            self.texts[self.texts.index(old)] = new
        else: self.texts.append(new)
        self.writes.append((old,new))
        return new

class RulesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)/'hub'; self.home=Path(self.tmp.name)/'home'
        (self.root/'rules').mkdir(parents=True); (self.home/'.codex').mkdir(parents=True)
        (self.root/'rules/global.md').write_text('# 共享规则\n')
        (self.root/'rules/cursor-bootstrap.md').write_text('AI Hub 共享规则入口\n\n读取共享规则。\n')
        (self.home/'.codex/AGENTS.md').symlink_to(self.root/'rules/global.md')
        self.cursor=FakeCursor(['AI Hub 共享规则入口\n\n读取共享规则。\n', '# Cursor 独有\n\n保留格式。\n'])
        self.service=RulesService(self.root,self.home,self.cursor)
    def doc(self,id): return next(d for d in self.service.snapshot()['documents'] if d['id']==id)
    def save(self,id,source): return self.service.save(dict(id=id,source=source,revision=self.doc(id)['revision']))
    def test_permission_recheck_clears_only_permission_error_without_marking_synced(self):
        self.service.error='当前同步进程未通过辅助功能检测'
        self.cursor.check_access=Mock(return_value={'status':'ready','message':'检测通过'})
        result=self.service.recheck_access()
        self.assertEqual(result['access']['status'],'ready')
        self.assertEqual(result['snapshot']['error'],'')
        self.assertIsNone(result['snapshot']['checked_at'])
        self.assertEqual(self.cursor.writes,[])
        self.service.error='外部冲突'
        self.service.recheck_access()
        self.assertEqual(self.service.error,'外部冲突')

    def test_title_drops_markdown_markers(self):
        self.assertEqual(plain_title('**核心理念与原则**'), '核心理念与原则')
        self.assertEqual(plain_title('## `lark-cli` 用法'), 'lark-cli 用法')
    def test_get_never_writes_or_uses_cursor(self):
        self.service.snapshot(); self.assertFalse((self.root/'.local').exists());self.assertEqual(self.cursor.writes,[])
    def test_shared_save_visible_to_codex_and_backup(self):
        result=self.save('global','# 新正文\n')
        self.assertEqual((self.home/'.codex/AGENTS.md').read_text(),'# 新正文\n')
        self.assertEqual((self.root/result['backup']).read_text(),'# 共享规则\n')
    def test_stale_save_retains_latest(self):
        revision=self.doc('global')['revision']; self.save('global','# 窗口一\n')
        with self.assertRaises(RulesError) as ctx: self.service.save(dict(id='global',source='# 窗口二',revision=revision))
        self.assertEqual(ctx.exception.status,409);self.assertEqual(self.doc('global')['source'],'# 窗口一\n')
    def test_import_preserves_multiline_and_does_not_change_client(self):
        self.service.sync(); d=self.service.snapshot()['documents'][-1]
        self.assertEqual(d['source'],'# Cursor 独有\n\n保留格式。\n\n'); self.assertEqual(self.cursor.writes,[])
    def test_save_cursor_then_sync_and_readback(self):
        self.service.sync(); id=self.service.snapshot()['documents'][-1]['id']
        self.save(id,'# 修改后的 Cursor 规则\n\n- 只改这一条\n'); self.service.sync()
        self.assertIn('# 修改后的 Cursor 规则\n\n- 只改这一条\n', self.cursor.texts)
        self.assertEqual(self.doc(id)['status'],'synced')
    def test_external_conflict_does_not_overwrite(self):
        self.service.sync();id=self.service.snapshot()['documents'][-1]['id']
        self.save(id,'# Hub 新版本');self.cursor.texts[1]='# 客户端新版本';self.service.sync()
        d=self.doc(id);self.assertEqual(d['status'],'conflict');self.assertEqual(self.cursor.writes,[])
        self.service.resolve(dict(id=id,choice='client',revision=d['revision'],remote_revision=d['remote_revision']))
        self.assertEqual(self.doc(id)['source'],'# 客户端新版本\n')
    def test_conflict_choose_hub_rechecks_remote(self):
        self.service.sync();id=self.service.snapshot()['documents'][-1]['id'];self.cursor.texts[1]='# 外部版本';self.service.sync()
        d=self.doc(id);self.service.resolve(dict(id=id,choice='hub',revision=d['revision'],remote_revision=d['remote_revision']))
        self.cursor.texts[1]='# 再次变化';self.service.sync()
        self.assertEqual(self.doc(id)['status'],'conflict');self.assertEqual(self.cursor.writes,[])
    def test_bootstrap_missing_creates_and_verifies(self):
        self.cursor.texts=[];self.service.sync();self.assertEqual(len(self.cursor.writes),1)
        self.assertEqual(self.doc('cursor-bootstrap')['status'],'synced')
    def test_path_injection_and_empty_body_rejected(self):
        for id,source in [('../global','content'),('global',''),('global',' '*30)]:
            with self.assertRaises(RulesError):self.service.save(dict(id=id,source=source,revision='x'))
    def test_external_symlink_refused(self):
        p=self.root/'rules/global.md';p.unlink(); p.symlink_to(self.home/'secret')
        with self.assertRaises(RulesError):self.service.snapshot()
    def test_client_offline_keeps_hub_saved_and_pending(self):
        self.service.sync(); self.save('cursor-bootstrap','AI Hub 共享规则入口\n\n修改。')
        def fail(): raise RulesError('Cursor 未运行',503)
        self.cursor.read=fail;self.service.sync()
        self.assertIn('未运行',self.service.snapshot()['error']); self.assertEqual(self.doc('cursor-bootstrap')['status'],'pending')
    def test_restart_keeps_sync_baseline(self):
        self.service.sync();again=RulesService(self.root,self.home,self.cursor);again.sync()
        self.assertEqual(len(again.snapshot()['documents']),3);self.assertEqual(self.cursor.writes,[])


class RulesHTTPTests(unittest.TestCase):
    def test_http_save_checks_origin_version_and_scope(self):
        from functools import partial
        from http.server import ThreadingHTTPServer
        import http.client
        import json
        import threading
        from unittest.mock import patch
        import preview_hub as preview
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'rules').mkdir(); (root/'home').mkdir()
            (root/'rules/global.md').write_text('old')
            (root/'rules/cursor-bootstrap.md').write_text('AI Hub 共享规则入口')
            service=RulesService(root,root/'home',FakeCursor([]))
            server=ThreadingHTTPServer(('127.0.0.1',0),partial(preview.Handler,directory=str(root)))
            worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
            def req(path,body=None,origin=True):
                c=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
                headers={'Content-Type':'application/json'}
                if origin:headers['Origin']=f'http://127.0.0.1:{server.server_port}'
                c.request('GET' if body is None else 'POST',path,headers=headers,body=None if body is None else json.dumps(body))
                r=c.getresponse();data=r.read();c.close();return r.status,data
            try:
                with patch.object(preview,'rules_service',return_value=service),patch.object(service,'start_sync',return_value=True) as sync:
                    body=dict(id='global',source='new',revision=digest('old'))
                    self.assertEqual(req('/api/rules/save',body,False)[0],403)
                    self.assertEqual(req('/api/rules/save',body)[0],200)
                    self.assertEqual((root/'rules/global.md').read_text(),'new')
                    sync.assert_called_once_with(True)
                    self.assertEqual(req('/api/rules/save',body)[0],409)
                    self.assertEqual(req('/api/rules/save',dict(body,path='/tmp/test'))[0],400)
                    self.assertEqual(req('/api/rules/sync',{'command':'evil'})[0],400)
                    self.assertEqual(req('/api/rules/sync',{})[0],200)
                    self.assertEqual(req('/api/rules')[0],200)
            finally:server.shutdown();server.server_close();worker.join()

class NativeTransactionTests(unittest.TestCase):
    def test_optional_focus_timeout_does_not_cancel_rule_operation(self):
        import subprocess
        from unittest.mock import patch
        from rules_hub import CursorRules
        cursor = CursorRules()
        with tempfile.TemporaryDirectory() as lock_directory:
            with patch('rules_hub.tempfile.gettempdir', return_value=lock_directory), patch('rules_hub.subprocess.run', side_effect=subprocess.TimeoutExpired('focus', 5)):
                with cursor.transaction():
                    operation_reached = True
        self.assertTrue(operation_reached)

if __name__=='__main__':unittest.main()
