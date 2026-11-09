"""OPPO 本机自动同步。固定采集器、跨进程互斥、失败保留旧数据。"""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
from datetime import datetime
from market_hub import MarketError,stamp,CHANNELS

INTERVAL=1800
class MarketCollector:
 def __init__(self,root,service,provider='oppo'):
  if provider not in CHANNELS:raise MarketError('不支持的平台。')
  self.provider=provider;self.name=CHANNELS[provider]
  self.root=Path(root);self.service=service;self.directory=self.root/'.local'
  self.config=self.directory/'market-collector.json';self.status_file=self.directory/('market-collection-state.json' if provider=='oppo' else 'market-collection-state-'+provider+'.json')
  self.lock_path=self.directory/('market-collector.lock' if provider=='oppo' else 'market-collector-'+provider+'.lock')
  self.lock=threading.Lock();self.worker=None;self.timer=None;self.stop=threading.Event()
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
 def snapshot(self):
  state=self.stored();running=self.active();scheduled=bool(self.enabled() and self.timer and self.timer.is_alive())
  if not state and not self.enabled():state={'state':'needs_login' if self.provider!='oppo' else 'manual'}
  if state.get('state')=='running' and not running:state={**state,'state':'interrupted'}
  messages={'ready':'OPPO 版本、审核、每日下载量与评论已自动同步（下载口径见数据来源）。','partial':'OPPO 部分数据同步成功；未成功的部分保留上次记录。','needs_login':'请在 OPPO 官方窗口完成登录并核实 ISHO 查询权限；无需上传报表。','profile_busy':'OPPO 专用浏览器正在使用，请关闭该窗口后重试。','read_failed':'OPPO 暂时读取失败，已保留上次数据；稍后自动重试。','running':'正在读取 OPPO 登录后台…','needs_adapter':'浏览器会话已保留；登录与 ISHO 数据权限尚待核实，未标记同步成功。','app_not_found':'未找到 com.jryx.isho，请核对登录账号所属团队与应用权限。','access_denied':'该账号尚无应用数据查询权限。','developer_unverified':'当前荣耀会话进入实名认证视图；请先切换 ISHO 已认证企业／团队，再核实应用查询权限。','auth_restore_failed':'本机会话无法恢复，请重新登录该平台。','auth_key_unavailable':'无法访问本机登录钥匙串，请检查系统权限后重试。','interrupted':'上次采集被中断，已保留上次成功数据。'}
  shown='running' if running else state.get('state','waiting')
  if shown in ('ready','partial') and state.get('parts') and not any(p.get('state')=='ok' for p in state['parts'].values()):
   shown='needs_login' if any(p.get('state')=='needs_login' for p in state['parts'].values()) else 'read_failed'
  reason=messages.get(shown,'OPPO 等待首次自动同步。').replace('OPPO',self.name)
  return {**state,'provider':self.provider,'name':self.name,'state':shown,'reason':reason,'automatic':scheduled,'interval_seconds':INTERVAL,'scope':'本机 Hub 服务运行期间定时同步；仅已验证的数据源标记为已接入。'}
 def control(self,body):
  if not isinstance(body,dict) or set(body)!={'operation'} or body['operation'] not in ('sync','login','pause','resume'):raise MarketError('同步参数不合法。')
  operation=body['operation']
  if operation in ('pause','resume'):
   self.enable(operation=='resume');self.start_scheduler();return {'started':False,'collection':self.snapshot()}
  return {'started':self.start(login=operation=='login'),'collection':self.snapshot()}
 def start(self,login=False):
  with self.lock:
   if self.worker and self.worker.is_alive():return False
   self.directory.mkdir(parents=True,exist_ok=True)
   lockfile=open(self.lock_path,'a')
   try:fcntl.flock(lockfile,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:lockfile.close();return False
   last=self.stored();self.persist({**last,'state':'running','last_attempt':stamp(),'last_operation':'login' if login else 'sync'})
   self.worker=threading.Thread(target=self.run,args=(lockfile,login),daemon=True,name=self.name+' collector');self.worker.start();return True
 def run(self,lockfile,login):
  state=self.stored()
  try:
   node=shutil.which('node') or next((p for p in ('/opt/homebrew/bin/node','/usr/local/bin/node') if Path(p).is_file()),None)
   if not node:raise ValueError('runtime unavailable')
   script=['oppo.mjs'] if self.provider=='oppo' else ['portal.mjs',self.provider]
   result=subprocess.run([node,str(self.root/'scripts/market-browser'/script[0]),*script[1:],*(['--login'] if login else [])],cwd=self.root,env={**os.environ,'AI_HUB_ROOT':str(self.root)},capture_output=True,text=True,timeout=12*60*60+120 if login else 180)
   if result.returncode or len(result.stdout)>4*1024*1024:raise ValueError('collector failed')
   payload=json.loads(result.stdout)
   if payload.get('provider')!=self.provider or payload.get('package')!='com.jryx.isho' or (self.provider=='oppo' and payload.get('app_id')!='37892440'):raise ValueError('binding mismatch')
   current=payload.get('state');allowed={'ready','partial','needs_login','profile_busy','read_failed','needs_adapter','app_not_found','access_denied','developer_unverified','auth_restore_failed','auth_key_unavailable'}
   if current not in allowed:raise ValueError('invalid state')
   if current in ('ready','partial') and not any(part.get('state')=='ok' for part in payload.get('parts',{}).values()):
    current='needs_login' if any(part.get('state')=='needs_login' for part in payload.get('parts',{}).values()) else 'read_failed'
   changed=0
   if current in ('ready','partial'):
    changed=self.service.ingest_provider(self.provider,payload['rows'])
   state={**state,'state':current,'last_finished':stamp(),'parts':payload.get('parts',{}),'changed':changed}
   if current=='ready':
    state['last_success']=stamp()
    if self.provider not in self.settings():self.enable(True)
   elif current=='partial' and any(v.get('state')=='ok' for v in payload.get('parts',{}).values()):
    state['last_partial_success']=stamp()
    if self.provider not in self.settings():self.enable(True)
  except Exception:
   state={**state,'state':'read_failed','last_finished':stamp(),'parts':{}}
  finally:
   self.persist(state);lockfile.close()

class MarketCollectors:
 def __init__(self,root,service):self.items={p:MarketCollector(root,service,p) for p in CHANNELS}
 def start_scheduler(self):
  for item in self.items.values():item.start_scheduler()
 def snapshot(self):
  providers={p:item.snapshot() for p,item in self.items.items()}
  return {**providers['oppo'],'providers':providers}
 def control(self,body):
  if not isinstance(body,dict) or set(body)-{'operation','provider'} or 'operation' not in body:raise MarketError('同步参数不合法。')
  provider=body.get('provider','oppo')
  if provider not in self.items:raise MarketError('不支持的平台。')
  return self.items[provider].control({'operation':body['operation']})
