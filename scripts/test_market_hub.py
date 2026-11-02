#!/usr/bin/env python3
"""临时数据库验证运营数据、批量导入、权限和服务隔离；不写真实运营记录。"""
import base64
from functools import partial
from http.server import ThreadingHTTPServer
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from market_hub import MarketService,MarketError,clean
from market_server import MarketHandler,MarketBridge

class MarketTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.service=MarketService(self.root/'market.sqlite')
 def save(self,kind,row,revision=None):return self.service.dispatch('save',dict(kind=kind,row=row,revision=self.service.snapshot()['revision'] if revision is None else revision))
 def test_empty_is_real_unknown_not_demo(self):
  s=self.service.snapshot();self.assertEqual(s['product']['package'],'com.jryx.isho');self.assertEqual(len(s['channels']),5);self.assertTrue(all(r['status']=='unknown' for r in s['channels']));self.assertEqual(s['metrics'],[])
 def test_release_and_pending_are_independent(self):
  self.save('channels',dict(channel='oppo',status='reviewing',live_version='1.0.0',pending_version='1.0.1',as_of='2026-01-01'))
  r=self.service.snapshot()['channels'][0];self.assertEqual(r['live_version'],'1.0.0');self.assertEqual(r['status'],'reviewing');self.assertEqual(len(self.service.snapshot()['history']),1)
 def test_stale_write_and_noop(self):
  row=dict(channel='vivo',status='unknown');a=self.save('channels',row,0)
  self.assertEqual(self.save('channels',row)['changed'],0)
  with self.assertRaises(MarketError) as ctx:self.save('channels',dict(row,status='live'),0)
  self.assertEqual(ctx.exception.status,409)
 def test_download_zero_and_missing_are_different(self):
  self.save('metrics',dict(channel='oppo',date='2026-01-01',downloads='0',source='商店报表'))
  row=self.service.snapshot()['metrics'][0];self.assertEqual(row['downloads'],0);self.assertIsNone(row['active_users'])
 def test_daily_active_never_has_store_scope(self):
  with self.assertRaises(MarketError):self.save('metrics',dict(channel='oppo',date='2026-01-01',active_users='9',source='后台'))
  with self.assertRaises(MarketError):self.save('metrics',dict(channel='all',date='2026-01-01',downloads='9',source='后台'))
 def test_invalid_values_are_rejected(self):
  for v in ['-1','nan','1.5',True,10**30]:
   with self.subTest(v=v),self.assertRaises(MarketError):self.save('metrics',dict(channel='oppo',date='2026-01-01',downloads=v,source='报表'))
  for date in ['2099-01-01','2026-02-30','2026-1-1']:
   with self.assertRaises(MarketError):self.save('metrics',dict(channel='oppo',date=date,downloads='1',source='报表'))
 def test_retention_cohort_and_maturity(self):
  self.save('metrics',dict(channel='all',date='2026-01-01',cohort_users='100',retained_d1='30',source='业务后台'))
  with self.assertRaises(MarketError):self.save('metrics',dict(channel='all',date='2026-01-02',cohort_users='10',retained_d7='11',source='业务后台'))
 def test_credentials_and_js_urls_rejected(self):
  for url in ['javascript:alert(1)','https://user:password@example.com','file:///tmp/x']:
   with self.assertRaises(MarketError):self.save('channels',dict(channel='xiaomi',status='live',url=url))
 def test_preview_no_write_and_atomic_import(self):
  text='date,channel,downloads,source\n2026-01-01,oppo,12,报表\n2026-01-02,oppo,13,报表\n'
  p=self.service.dispatch('import',dict(kind='metrics',csv=text,revision=0,apply=False));self.assertEqual(p['count'],2);self.assertEqual(self.service.snapshot()['revision'],0)
  self.service.dispatch('import',dict(kind='metrics',csv=text,revision=p['revision'],apply=True));self.assertEqual(len(self.service.snapshot()['metrics']),2)
  bad=text+'2026-01-03,oppo,-1,报表\n'
  with self.assertRaises(MarketError):self.service.dispatch('import',dict(kind='metrics',csv=bad,revision=1,apply=True))
  self.assertEqual(len(self.service.snapshot()['metrics']),2)
 def test_import_duplicate_and_changed_preview(self):
  text='date,channel,downloads,source\n2026-01-01,oppo,12,报表\n'
  with self.assertRaises(MarketError):self.service.parse_csv('metrics',text+'2026-01-01,oppo,12,报表\n')
  self.save('channels',dict(channel='oppo',status='reviewing'))
  with self.assertRaises(MarketError):self.service.dispatch('import',dict(kind='metrics',csv=text,revision=0,apply=True))
 def test_reviews_upsert_without_duplicates(self):
  r=dict(channel='oppo',external_id='review-1',date='2026-01-01',rating='5',body='很好',source='商店导出');self.save('reviews',r);self.save('reviews',dict(r,rating='4'))
  self.assertEqual(len(self.service.snapshot()['reviews']),1);self.assertEqual(self.service.snapshot()['reviews'][0]['rating'],4)
 def test_restart_persists_and_other_rows_untouched(self):
  self.save('channels',dict(channel='oppo',status='reviewing'));again=MarketService(self.root/'market.sqlite');self.assertEqual(again.snapshot()['revision'],1);self.assertEqual(again.snapshot()['channels'][1]['status'],'unknown')
 def test_remote_invalid_config_does_not_use_local_silently(self):
  (self.root/'.local').mkdir();(self.root/'.local/market-remote.json').write_text('{"url":"http://remote.example"}')
  with self.assertRaises(MarketError):MarketBridge(self.root).call('snapshot')

class ServerTests(unittest.TestCase):
 setUp=MarketTests.setUp
 def test_auth_readonly_csrf_and_local_api_isolation(self):
  (self.root/'market.html').write_text('<html>test</html>');(self.root/'index.html').write_text('private hub')
  server=ThreadingHTTPServer(('127.0.0.1',0),partial(MarketHandler,directory=str(self.root)));server.market=self.service;server.passwords={'admin':'admin-password-for-test','screen':'view-password-for-test'};server.public_origin=''
  worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
  def req(path,user='admin',method='GET',body=None,origin=None,host=None):
   c=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3);headers={}
   if user:headers['Authorization']='Basic '+base64.b64encode((user+':'+server.passwords[user]).encode()).decode()
   if host:headers['Host']=host
   if origin:headers['Origin']=origin
   c.request(method,path,body=None if body is None else json.dumps(body),headers=headers);r=c.getresponse();raw=r.read();c.close();return r.status,raw
  try:
   self.assertEqual(req('/api/market/snapshot',None)[0],401)
   s,raw=req('/api/market/snapshot','screen');self.assertEqual(s,200);self.assertTrue(json.loads(raw)['read_only'])
   self.assertEqual(req('/api/market/collect','admin','POST',{'operation':'sync'},f'http://127.0.0.1:{server.server_port}')[0],404)
   self.assertEqual(req('/api/rules')[0],404);self.assertEqual(req('/index.html')[0],404);self.assertEqual(req('/.local/x')[0],404)
   body=dict(kind='channels',row=dict(channel='oppo',status='live'),revision=0)
   self.assertEqual(req('/api/market/save','screen','POST',body)[0],403)
   self.assertEqual(req('/api/market/save','admin','POST',body,'https://evil.test')[0],403)
   self.assertEqual(req('/api/market/save','admin','POST',body,f'http://127.0.0.1:{server.server_port}')[0],200)
   self.assertEqual(req('/api/market/snapshot',host='evil.test')[0],403)
   (self.root/'.local').mkdir(exist_ok=True)
   config=self.root/'.local/market-remote.json'
   config.write_text(json.dumps(dict(url=f'http://127.0.0.1:{server.server_port}',username='admin',password=server.passwords['admin'])))
   bridge=MarketBridge(self.root)
   snapshot=bridge.call('snapshot');self.assertEqual(snapshot['connection']['mode'],'remote');self.assertEqual(snapshot['revision'],1)
   result=bridge.call('save',dict(kind='metrics',row=dict(channel='all',date='2026-01-01',active_users='3',source='测试服务器'),revision=1))
   self.assertEqual(result['snapshot']['revision'],2)
   config.write_text(json.dumps(dict(url=f'http://127.0.0.1:{server.server_port}',username='screen',password=server.passwords['screen'])))
   self.assertTrue(bridge.call('snapshot')['read_only'])
   with self.assertRaises(MarketError):bridge.call('save',body)

  finally:server.shutdown();server.server_close();worker.join()

if __name__=='__main__':unittest.main()
