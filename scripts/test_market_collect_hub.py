import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from market_hub import MarketService,MarketError
from market_collect import MarketCollector,MarketCollectors
class CollectorTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.service=MarketService(self.root/'.local/market.sqlite');self.collector=MarketCollector(self.root,self.service)
 def groups(self):return {'channels':[{'channel':'oppo','status':'rejected','pending_version':'1.0.2','pending_code':25229}],'metrics':[{'date':'2026-01-01','channel':'oppo','downloads':930,'source':'OPPO 每日净下载'}],'reviews':[{'channel':'oppo','external_id':'1234567890123456789','date':'2026-01-01','rating':5,'body':'好','source':'OPPO'}]}
 def test_atomic_idempotent_preserve_unrelated_fields_and_channels(self):
  self.service.dispatch('save',{'kind':'channels','revision':0,'row':{'channel':'oppo','status':'unknown','url':'https://example.com','notes':'人工备注'}})
  groups=self.groups();self.assertEqual(self.service.ingest_oppo(groups),3);revision=self.service.snapshot()['revision'];self.assertEqual(self.service.ingest_oppo(groups),0)
  s=self.service.snapshot();self.assertEqual(s['revision'],revision);self.assertEqual(s['channels'][0]['url'],'https://example.com');self.assertEqual(s['channels'][0]['notes'],'人工备注');self.assertTrue(all(c['status']=='unknown' for c in s['channels'][1:]));self.assertEqual(len(s['reviews']),1)
 def test_validation_failure_rolls_back_whole_batch(self):
  groups=self.groups();groups['reviews'][0]['rating']=9
  with self.assertRaises(MarketError):self.service.ingest_oppo(groups)
  self.assertEqual(self.service.snapshot()['revision'],0)
 def test_cannot_inject_other_channel_secrets_or_business_scope(self):
  for key,value in [('channel','vivo'),('access_token','secret'),('active_users',999)]:
   groups=self.groups();groups['metrics'][0][key]=value
   with self.assertRaises(MarketError):self.service.ingest_oppo(groups)
 def test_failure_does_not_delete_real_data_and_no_secret_error_logs(self):
  self.service.ingest_oppo(self.groups());before=self.service.snapshot();lockfile=open(self.root/'.local/test.lock','a')
  with patch('market_collect.subprocess.run',side_effect=RuntimeError('secret must not surface')):self.collector.run(lockfile,False)
  after=self.service.snapshot();self.assertEqual(before['revision'],after['revision']);self.assertEqual(self.collector.snapshot()['state'],'read_failed');self.assertNotIn('secret',self.collector.status_file.read_text())
 def test_disabled_timer_and_parameters(self):
  self.assertFalse(self.collector.enabled());self.collector.start_scheduler();self.assertIsNone(self.collector.timer)
  with self.assertRaises(MarketError):self.collector.control({'operation':'sync','url':'https://example.com'})
  self.collector.control({'operation':'pause'});self.assertFalse(self.collector.snapshot()['automatic'])
 def test_scheduler_checks_due_without_page_visibility(self):
  self.collector.config.write_text(json.dumps({'oppo':True,'interval_seconds':1800}))
  class OneTick:
   def is_set(self):return False
   def wait(self,seconds):raise StopIteration()
  self.collector.stop=OneTick()
  with patch.object(self.collector,'start') as start:
   with self.assertRaises(StopIteration):self.collector.loop()
   start.assert_called_once()
  self.collector.persist({'last_attempt':__import__('market_hub').stamp()})
  with patch.object(self.collector,'start') as start:
   with self.assertRaises(StopIteration):self.collector.loop()
   start.assert_not_called()
 def test_platform_flags_are_independent_and_keep_oppo(self):
  self.collector.enable(True)
  vivo=MarketCollector(self.root,self.service,'vivo');honor=MarketCollector(self.root,self.service,'honor')
  vivo.enable(True);honor.enable(True);vivo.enable(False)
  self.assertTrue(self.collector.enabled());self.assertTrue(honor.enabled());self.assertFalse(vivo.enabled())
 def test_provider_binding_and_five_channels(self):
  groups=self.groups()
  for rows in groups.values():
   for row in rows:row['channel']='honor'
  self.assertEqual(self.service.ingest_provider('honor',groups),3)
  self.assertTrue(all(c['status']=='unknown' for c in self.service.snapshot()['channels'] if c['channel']!='honor'))
  with self.assertRaises(MarketError):self.service.ingest_provider('vivo',groups)
  self.assertEqual(len(MarketCollectors(self.root,self.service).snapshot()['providers']),5)
 def test_partial_result_enables_only_verified_platform(self):
  payload={'provider':'vivo','package':'com.jryx.isho','state':'partial','rows':{'channels':[{'channel':'vivo','status':'live','live_version':'1.0.2'}],'metrics':[],'reviews':[]},'parts':{'channels':{'state':'ok'},'reviews':{'state':'unsupported'}}}
  from types import SimpleNamespace
  vivo=MarketCollector(self.root,self.service,'vivo')
  with patch('market_collect.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(payload))):vivo.run(open(self.root/'.local/vivo-test.lock','a'),False)
  self.assertTrue(vivo.enabled());self.assertTrue(vivo.stored()['last_partial_success']);self.assertNotIn('last_success',vivo.stored())
  self.assertFalse(self.collector.enabled())
 def test_all_failed_partial_result_keeps_history_and_does_not_claim_success(self):
  from types import SimpleNamespace
  collector=MarketCollector(self.root,self.service,'tencent')
  collector.persist({'state':'partial','last_partial_success':'2026-11-03T12:00:00+08:00','parts':{'channels':{'state':'read_failed'}}})
  self.assertEqual(collector.snapshot()['state'],'read_failed')
  before=self.service.snapshot()['revision']
  payload={'provider':'tencent','package':'com.jryx.isho','state':'partial','rows':{'channels':[],'metrics':[],'reviews':[]},'parts':{'channels':{'state':'read_failed'},'downloads':{'state':'read_failed'},'reviews':{'state':'unsupported'}}}
  with patch('market_collect.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(payload))):collector.run(open(self.root/'.local/tencent-test.lock','a'),False)
  self.assertEqual(collector.stored()['state'],'read_failed')
  self.assertEqual(collector.stored()['last_partial_success'],'2026-11-03T12:00:00+08:00')
  self.assertEqual(self.service.snapshot()['revision'],before)
  self.assertFalse(collector.enabled())
 def test_sync_once_respects_explicit_pause(self):
  from types import SimpleNamespace
  vivo=MarketCollector(self.root,self.service,'vivo');vivo.enable(False)
  payload={'provider':'vivo','package':'com.jryx.isho','state':'partial','rows':{'channels':[{'channel':'vivo','status':'live','live_version':'1.0.2'}],'metrics':[],'reviews':[]},'parts':{'channels':{'state':'ok'}}}
  with patch('market_collect.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(payload))):vivo.run(open(self.root/'.local/paused-vivo-test.lock','a'),False)
  self.assertFalse(vivo.enabled());self.assertEqual(vivo.stored()['state'],'partial')
 def test_unverified_developer_is_not_connected_or_scheduled(self):
  honor=MarketCollector(self.root,self.service,'honor');honor.persist({'state':'developer_unverified','auth_saved':True})
  state=honor.snapshot();self.assertEqual(state['state'],'developer_unverified');self.assertFalse(state['automatic']);self.assertIn('实名认证',state['reason']);self.assertNotIn('last_success',state)
 def test_control_rejects_paths_and_unknown_provider(self):
  manager=MarketCollectors(self.root,self.service)
  for body in ({'operation':'login','provider':'../other'},{'operation':'login','provider':'honor','url':'https://evil.example'}):
   with self.assertRaises(MarketError):manager.control(body)
 def test_profile_job_has_cross_process_lock(self):
  with patch('market_collect.subprocess.run',side_effect=RuntimeError('offline')):
   # 外部持有锁时，同步请求不应启动另一个浏览器。
   import fcntl
   with open(self.root/'.local/market-collector.lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);self.assertFalse(self.collector.start())
if __name__=='__main__':unittest.main()
