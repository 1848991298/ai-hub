"""本机商店采集。固定采集器、跨进程互斥、失败保留旧数据。"""
import copy
from concurrent.futures import Future, TimeoutError as FutureTimeout
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
from datetime import datetime
from uuid import uuid4
from market_hub import MarketError,stamp,CHANNELS

INTERVAL=1800
SYNC_TIMEOUT=180

def verified_state(state, parts):
 if state not in ('ready','partial'):return state
 states={p.get('state') for p in parts.values()}-{'unsupported'}
 if 'ok' in states:return 'ready' if states=={'ok'} else 'partial'
 return next((failure for failure in ('needs_login','app_not_found','access_denied') if failure in states),'read_failed')
class MarketCollector:
 def __init__(self,root,service,provider='oppo'):
  if provider not in CHANNELS:raise MarketError('不支持的平台。')
  self.provider=provider;self.name=CHANNELS[provider]
  self.root=Path(root);self.service=service;self.directory=self.root/'.local'
  self.config=self.directory/'market-collector.json';self.status_file=self.directory/('market-collection-state.json' if provider=='oppo' else 'market-collection-state-'+provider+'.json')
  self.lock_path=self.directory/('market-collector.lock' if provider=='oppo' else 'market-collector-'+provider+'.lock')
  self.lock=threading.Lock();self.worker=None;self.timer=None;self.stop=threading.Event()
  self.attempt=None
 def enabled(self):
  try:return self.settings().get(self.provider) is True
  except (OSError,ValueError):return False
 def settings(self):
  try:
   value=json.loads(self.config.read_text())
   if not isinstance(value,dict) or set(value)-set(CHANNELS)-{'interval_seconds'} or value.get('interval_seconds')!=INTERVAL:return {}
   if any(not isinstance(v,bool) for k,v in value.items() if k!='interval_seconds'):return {}
   return value
  except (OSError,ValueError):return {}
 def enable(self,enabled):
  self.directory.mkdir(parents=True,exist_ok=True)
  with open(self.directory/'market-collector-config.lock','a') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX)
   config={**self.settings(),self.provider:enabled,'interval_seconds':INTERVAL}
   path=self.config.with_suffix('.tmp');path.write_text(json.dumps(config));os.chmod(path,0o600);path.replace(self.config)
 def stored(self):
  try:return json.loads(self.status_file.read_text())
  except (OSError,ValueError):return {}
 def persist(self,value):
  self.directory.mkdir(parents=True,exist_ok=True)
  temp=self.status_file.with_suffix('.tmp');temp.write_text(json.dumps(value,ensure_ascii=False));os.chmod(temp,0o600);temp.replace(self.status_file)
 def start_scheduler(self):
  with self.lock:
   if self.timer and self.timer.is_alive():return
   if not self.enabled():return
   self.timer=threading.Thread(target=self.loop,daemon=True,name=self.name+' scheduler');self.timer.start()
 def loop(self):
  while not self.stop.is_set():
   if self.enabled():
    last=self.stored().get('last_attempt')
    try:due=time.time()-datetime.fromisoformat(last).timestamp()>=INTERVAL
    except (TypeError,ValueError):due=True
    if due:self.start()
   self.stop.wait(5)
 def active(self):
  if self.worker and self.worker.is_alive():return True
  self.directory.mkdir(parents=True,exist_ok=True)
  with open(self.lock_path,'a') as lock:
   try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:return True
  return False
 def reason(self, state):
  messages={'ready':'OPPO 已同步接入的分项。','partial':'OPPO 部分分项同步失败，请查看下方读取结果。','needs_login':'请在 OPPO 官方窗口完成登录并核实 ISHO 查询权限；无需上传报表。','profile_busy':'OPPO 专用浏览器正在使用，请关闭该窗口后重试。','browser_missing':'没找到本机采集浏览器，这次没开始同步；找到后会自动再试。','read_failed':'OPPO 暂时读取失败，已保留上次数据；稍后自动重试。','running':'正在读取 OPPO 登录后台…','needs_adapter':'浏览器会话已保留；登录与 ISHO 数据权限尚待核实，未标记同步成功。','app_not_found':'未找到 com.jryx.isho，请核对登录账号所属团队与应用权限。','access_denied':'该账号尚无应用数据查询权限。','developer_unverified':'当前荣耀会话进入实名认证视图；请先切换 ISHO 已认证企业／团队，再核实应用查询权限。','auth_restore_failed':'本机会话无法恢复，请重新登录该平台。','auth_key_unavailable':'无法访问本机登录钥匙串，请检查系统权限后重试。','interrupted':'上次采集被中断，已保留上次成功数据。'}
  return messages.get(state,'OPPO 等待首次自动同步。').replace('OPPO',self.name)
 def snapshot(self):
  state=self.stored();running=self.active();scheduled=bool(self.enabled() and self.timer and self.timer.is_alive())
  if not state and not self.enabled():state={'state':'needs_login' if self.provider!='oppo' else 'manual'}
  if state.get('state')=='running' and not running:state={**state,'state':'interrupted'}
  shown='running' if running else state.get('state','waiting')
  if state.get('parts'):
   shown=verified_state(shown,state['parts'])
  if shown=='ready' and state.get('state')=='partial':
   state={**state,'last_success':state.get('last_finished') or state.get('last_partial_success') or state.get('last_success'),'last_partial_success':None}
  return {**state,'provider':self.provider,'name':self.name,'state':shown,'reason':self.reason(shown),'automatic':scheduled,'interval_seconds':INTERVAL,'scope':'本机 Hub 服务运行期间定时同步；仅已验证的数据源标记为已接入。'}
 def control(self,body):
  if not isinstance(body,dict) or set(body)!={'operation'} or body['operation'] not in ('sync','login','pause','resume'):raise MarketError('同步参数不合法。')
  operation=body['operation']
  if operation in ('pause','resume'):
   self.enable(operation=='resume');self.start_scheduler();return {'started':False,'collection':self.snapshot()}
  return {'started':self.start(login=operation=='login'),'collection':self.snapshot()}
 def start(self,login=False):
  return self.start_attempt(login)[0]
 def start_attempt(self, login=False):
  with self.lock:
   if self.worker and self.worker.is_alive():
    return False, self.attempt
   self.directory.mkdir(parents=True,exist_ok=True)
   lockfile=open(self.lock_path,'a')
   try:fcntl.flock(lockfile,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:
    lockfile.close()
    return False, None
   try:
    self.persist({**self.stored(),'state':'running','last_attempt':stamp(),'last_operation':'login' if login else 'sync'})
    future = Future()
    self.attempt = (future, login)
    self.worker = threading.Thread(target=self.run,args=(lockfile,login,future),daemon=True,name=self.name+' collector')
    self.worker.start()
   except Exception:
    lockfile.close()
    raise
   return True, self.attempt
 def collect_for_batch(self):
  _, attempt = self.start_attempt()
  if attempt:
   future, login = attempt
   if login:
    return {'state':'needs_login', 'reason':'请先完成已打开的官方登录窗口，再重试。'}
   return future.result(timeout=SYNC_TIMEOUT + 15)
  # 其他进程已持有同一渠道的锁，等待读取它写下的结果。
  deadline = time.monotonic() + SYNC_TIMEOUT + 15
  while self.active():
   state = self.stored()
   if state.get('state') == 'running' and state.get('last_operation') == 'login':
    return {'state':'needs_login', 'reason':'请先完成已打开的官方登录窗口，再重试。'}
   if time.monotonic() >= deadline:
    return {'state':'profile_busy', 'reason':'等待另一窗口采集超时，可单独重试。'}
   time.sleep(0.4)
  result = self.stored()
  return result if result.get('state') not in (None, 'running') else {'state':'interrupted'}
 def run(self,lockfile,login,future=None):
  state=self.stored()
  try:
   node=shutil.which('node') or next((p for p in ('/opt/homebrew/bin/node','/usr/local/bin/node') if Path(p).is_file()),None)
   if not node:raise ValueError('runtime unavailable')
   script=['oppo.mjs'] if self.provider=='oppo' else ['portal.mjs',self.provider]
   result=subprocess.run([node,str(self.root/'scripts/market-browser'/script[0]),*script[1:],*(['--login'] if login else [])],cwd=self.root,env={**os.environ,'AI_HUB_ROOT':str(self.root)},capture_output=True,text=True,timeout=12*60*60+120 if login else SYNC_TIMEOUT)
   if result.returncode or len(result.stdout)>4*1024*1024:raise ValueError('collector failed')
   payload=json.loads(result.stdout)
   if payload.get('provider')!=self.provider or payload.get('package')!='com.jryx.isho' or (self.provider=='oppo' and payload.get('app_id')!='37892440'):raise ValueError('binding mismatch')
   current=payload.get('state');allowed={'ready','partial','needs_login','profile_busy','read_failed','needs_adapter','app_not_found','access_denied','developer_unverified','auth_restore_failed','auth_key_unavailable'}
   if current not in allowed:raise ValueError('invalid state')
   parts=payload.get('parts',{})
   current=verified_state(current,parts)
   changed=0
   if current in ('ready','partial'):
    changed=self.service.ingest_provider(self.provider,payload['rows'])
   state={**state,'state':current,'last_finished':stamp(),'parts':parts,'changed':changed}
   if current=='ready':
    state['last_success']=stamp()
    if self.provider not in self.settings():self.enable(True)
   elif current=='partial':
    state['last_partial_success']=stamp()
    if self.provider not in self.settings():self.enable(True)
  except Exception:
   state={**state,'state':'read_failed','last_finished':stamp(),'parts':{}}
  finally:
   try:
    self.persist(state)
   except OSError:
    state = {'state':'read_failed', 'reason':'采集结果无法保存到本机，请重试。'}
   finally:
    lockfile.close()
    if future is not None:
     future.set_result(state)

class MarketCollectors:
 def __init__(self,root,service):
  self.items={p:MarketCollector(root,service,p) for p in CHANNELS}
  self.batch_lock=threading.Lock()
  self.batch=None
 def start_scheduler(self):
  for item in self.items.values():item.start_scheduler()
 def batch_active(self):
  with self.batch_lock:
   return bool(self.batch and self.batch['state'] == 'running')
 def snapshot(self):
  providers={p:item.snapshot() for p,item in self.items.items()}
  with self.batch_lock:
   return {**providers['oppo'],'providers':providers,'batch':copy.deepcopy(self.batch)}
 def start_batch(self):
  with self.batch_lock:
   if self.batch and self.batch['state'] == 'running':
    return {'started':False, 'batch':copy.deepcopy(self.batch)}
   batch = {
    'id':uuid4().hex, 'state':'running', 'started_at':stamp(),
    'results':{provider:{'state':'running'} for provider in self.items},
   }
   self.batch = batch
   for provider, item in self.items.items():
    worker = threading.Thread(target=self.finish_batch_channel,args=(batch,provider,item),daemon=True)
    worker.start()
   return {'started':True, 'batch':copy.deepcopy(batch)}
 def finish_batch_channel(self, batch, provider, item):
  try:
   result = item.collect_for_batch()
  except FutureTimeout:
   result = {'state':'read_failed', 'reason':'本次采集超时，可单独重试。'}
  except Exception:
   result = {'state':'read_failed'}
  state = result['state']
  with self.batch_lock:
   batch['results'][provider] = {
    'state':state, 'reason':result.get('reason') or item.reason(state),
    'parts':result.get('parts',{}), 'changed':result.get('changed',0),
    'finished_at':result.get('last_finished') or stamp(),
   }
   if all(row['state'] != 'running' for row in batch['results'].values()):
    batch.update(state='finished', finished_at=stamp())
 def control(self,body):
  if not isinstance(body,dict) or set(body)-{'operation','provider'} or 'operation' not in body:raise MarketError('同步参数不合法。')
  if body['operation'] == 'sync_all':
   if set(body) != {'operation'}:raise MarketError('全部同步使用固定渠道范围。')
   return self.start_batch()
  provider=body.get('provider','oppo')
  if provider not in self.items:raise MarketError('不支持的平台。')
  return self.items[provider].control({'operation':body['operation']})
