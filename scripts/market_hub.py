#!/usr/bin/env python3
"""ISHO 应用运营数据：独立 SQLite、显式来源、乐观锁和原子报表导入。"""
from contextlib import contextmanager
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import sqlite3
from datetime import date, datetime
from zoneinfo import ZoneInfo
ZONE=ZoneInfo("Asia/Shanghai")
from urllib.parse import urlsplit

CHANNELS = {'oppo':'OPPO', 'vivo':'vivo', 'xiaomi':'小米', 'tencent':'应用宝', 'honor':'荣耀'}
STATES = {'unknown':'待核实', 'not_submitted':'未提交', 'reviewing':'审核中', 'rejected':'已驳回', 'approved':'待发布', 'live':'已上架', 'offline':'已下架'}
COUNTS = ('downloads','new_users','active_users','uploaded_records','uploaded_bytes','upload_failures','cohort_users','retained_d1','retained_d7')
FIELDS = {
 'channels': ('channel','live_version','live_code','pending_version','pending_code','status','submitted_at','released_at','reason','url','rating','rating_count','as_of','notes'),
 'metrics': ('date','channel',*COUNTS,'source','notes'),
 'reviews': ('channel','external_id','date','rating','version','body','source'),
}

class MarketError(Exception):
 def __init__(self, message, status=400):
  super().__init__(message); self.status=status

def stamp(): return datetime.now(ZONE).isoformat()
def dump(v): return json.dumps(v,ensure_ascii=False,sort_keys=True,allow_nan=False)
def integer(v, field):
 if v in ('',None): return None
 if isinstance(v,bool) or not str(v).isdigit() or len(str(v))>15: raise MarketError(f'{field} 必须是非负整数或留空。')
 return int(v)
def day(v,field='date'):
 if not isinstance(v,str): raise MarketError(f'{field} 需要 YYYY-MM-DD 日期。')
 try:
  d=date.fromisoformat(v)
  if d.isoformat()!=v or d>datetime.now(ZONE).date(): raise ValueError()
 except ValueError: raise MarketError(f'{field} 日期不合法或晚于今天。')
 return v

def clean(kind, value):
 if kind not in FIELDS or not isinstance(value,dict) or set(value)-set(FIELDS[kind]): raise MarketError('数据类型或字段不受支持。')
 row={f:value.get(f,'') for f in FIELDS[kind]}
 for k,v in row.items():
  if v is not None and not isinstance(v,(str,int,float)): raise MarketError(f'{k} 数据类型不合法。')
  if isinstance(v,str) and (len(v)>5000 or '\x00' in v): raise MarketError(f'{k} 内容过长或含不合法字符。')
  if isinstance(v,float) and not math.isfinite(v): raise MarketError(f'{k} 数值不合法。')
 numeric=set(COUNTS)|{'live_code','pending_code','rating','rating_count'}
 for f,v in row.items():
  if f not in numeric and not isinstance(v,str): raise MarketError(f'{f} 必须为文本。')
 if row['channel'] not in CHANNELS and not (kind=='metrics' and row['channel']=='all'): raise MarketError('请选择已支持的五个商店；全应用指标使用 all。')
 if kind=='channels':
  if row['status'] not in STATES: raise MarketError('审核状态不受支持。')
  for f in ('live_code','pending_code','rating_count'): row[f]=integer(row[f],f)
  for f in ('submitted_at','released_at','as_of'):
   if row[f]: day(row[f],f)
  if row['url']:
   u=urlsplit(row['url'])
   if u.scheme!='https' or not u.hostname or u.username or u.password: raise MarketError('商店链接必须为不含凭据的 HTTPS 链接。')
  if row['rating'] not in ('',None):
   try: row['rating']=float(row['rating'])
   except (ValueError,TypeError): raise MarketError('评分需要 0–5 分的数值。')
   if not math.isfinite(row['rating']) or not 0<=row['rating']<=5: raise MarketError('评分需要 0–5 分的数值。')
  else: row['rating']=None
 elif kind=='metrics':
  day(row['date'])
  for f in COUNTS: row[f]=integer(row[f],f)
  if row['channel']=='all' and row['downloads'] is not None: raise MarketError('下载量按商店分别填写，不能在 all 重复汇总。')
  if row['channel']!='all' and any(row[f] is not None for f in COUNTS if f!='downloads'): raise MarketError('新增、活跃和业务上传数据请使用 all，避免跨商店重复计数。')
  for lag in (1,7):
   value=row['retained_d'+str(lag)]
   if value is not None:
    if row['cohort_users'] is None or value>row['cohort_users']: raise MarketError('留存人数需要对应的 cohort_users，且不能大于该批新增人数。')
    if (datetime.now(ZONE).date()-date.fromisoformat(row['date'])).days<lag: raise MarketError('该新增批次尚未达到对应留存统计日。')
  if all(row[f] is None for f in COUNTS): raise MarketError('至少填写一个真实指标；未知值请留空。')
  if not row['source'].strip(): raise MarketError('请填写数据来源，如商店报表或业务统计接口。')
 else:
  day(row['date'])
  row['rating']=integer(row['rating'],'rating')
  if row['rating'] not in range(1,6): raise MarketError('评论评分必须为 1–5 分。')
  if not row['external_id'] or not row['source']: raise MarketError('评论需要稳定 ID 和数据来源，用于避免重复导入。')
 return row

def key(kind,r):
 return r['channel'] if kind=='channels' else r['date']+':'+r['channel'] if kind=='metrics' else r['channel']+':'+r['external_id']

class MarketService:
 def __init__(self, path):
  self.path=Path(path)
  self.path.parent.mkdir(parents=True,exist_ok=True)
  with self.connect() as db:
   db.executescript('CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); INSERT OR IGNORE INTO meta VALUES(1,0); CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL);')
 @contextmanager
 def connect(self):
  db=sqlite3.connect(self.path,timeout=10);db.row_factory=sqlite3.Row
  try:
   with db: yield db
  finally: db.close()
 def snapshot(self):
  with self.connect() as db:
   db.execute('BEGIN')
   revision=db.execute('SELECT revision FROM meta').fetchone()[0]
   rows=db.execute('SELECT * FROM records ORDER BY kind,id').fetchall()
   history=[dict(r) for r in db.execute('SELECT id,at,actor,action FROM history ORDER BY id DESC LIMIT 20')]
  groups={k:[] for k in FIELDS}
  for r in rows: groups[r['kind']].append({**json.loads(r['body']),'updated_at':r['updated_at']})
  registered={r['channel']:r for r in groups['channels']}
  groups['channels']=[registered.get(k,{'channel':k,'status':'unknown','updated_at':None}) for k in CHANNELS]
  return dict(schema_version=1,product={'name':'ISHO','package':'com.jryx.isho'},revision=revision,generated_at=stamp(),channels_map=CHANNELS,statuses=STATES,fields=FIELDS,history=history,**groups,connection={'mode':'local','label':'本机数据库 · 网页与 App 共用'},collection={'state':'manual','reason':'尚未配置商店 API 或业务统计接口；支持手动录入和 CSV 导入。'})
 def parse_csv(self,kind,content):
  if kind not in FIELDS or not isinstance(content,str) or len(content.encode('utf-8'))>512*1024: raise MarketError('请选择支持的 CSV 类型，文件不超过 512 KB。')
  try:
   reader=csv.DictReader(io.StringIO(content.lstrip('\ufeff')))
   if not reader.fieldnames or len(set(reader.fieldnames))!=len(reader.fieldnames) or set(reader.fieldnames)-set(FIELDS[kind]): raise MarketError('CSV 表头不合法；请使用下载的模板。')
   rows=[];seen=set()
   for index,r in enumerate(reader,2):
    if len(rows)>=2000: raise MarketError('每次最多导入 2000 行。')
    try: row=clean(kind,r)
    except MarketError as e: raise MarketError(f'第 {index} 行：{e}')
    k=key(kind,row)
    if k in seen: raise MarketError(f'第 {index} 行与文件内其他记录重复。')
    seen.add(k);rows.append(row)
  except csv.Error: raise MarketError('CSV 格式无法解析。')
  if not rows: raise MarketError('CSV 中没有可导入的记录。')
  return rows
 def write_rows(self,kind,rows,revision,actor='local'):
  if not isinstance(revision,int) or isinstance(revision,bool): raise MarketError('缺少数据版本，请重新读取。')
  with self.connect() as db:
   db.execute('BEGIN IMMEDIATE')
   if db.execute('SELECT revision FROM meta').fetchone()[0]!=revision: raise MarketError('数据已被另一窗口更新；请重新读取或重新预览导入。',409)
   before=[];after=[]
   for row in rows:
    k=key(kind,row);old=db.execute('SELECT body FROM records WHERE kind=? AND id=?',(kind,k)).fetchone()
    if old and json.loads(old[0])==row: continue
    before.append(json.loads(old[0]) if old else None);after.append(row)
    db.execute('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at',(kind,k,dump(row),stamp()))
   if after:
    db.execute('INSERT INTO history(at,actor,action,before_json,after_json) VALUES(?,?,?,?,?)',(stamp(),actor,kind,dump(before),dump(after)))
    db.execute('UPDATE meta SET revision=revision+1')
  return {'changed':len(after),'snapshot':self.snapshot()}
 def ingest_oppo(self,groups):
  return self.ingest_provider('oppo',groups)
 def ingest_provider(self,provider,groups):
  """合并白名单采集字段，一次事务写入；采集失败不清除旧记录。"""
  if provider not in CHANNELS: raise MarketError('不支持的采集平台。')
  allowed={'channels':{'channel','live_version','live_code','pending_version','pending_code','status','submitted_at','released_at','reason','rating','rating_count','as_of','notes'},'metrics':{'channel','date','downloads','source'},'reviews':set(FIELDS['reviews'])}
  if not isinstance(groups,dict) or set(groups)!=set(FIELDS): raise MarketError('采集数据格式错误。')
  for kind,rows in groups.items():
   if not isinstance(rows,list) or len(rows)>10000: raise MarketError('采集数据数量不合法。')
   seen=set()
   for row in rows:
    if not isinstance(row,dict) or set(row)-allowed[kind] or row.get('channel')!=provider: raise MarketError('采集字段或渠道不合法。')
    normalized=clean(kind,row);identity=key(kind,normalized)
    if identity in seen: raise MarketError('采集分页出现重复记录。')
    seen.add(identity)
  before=[];after=[]
  with self.connect() as db:
   db.execute('BEGIN IMMEDIATE')
   for kind,rows in groups.items():
    for patch in rows:
     identity=key(kind,patch);old=db.execute('SELECT body FROM records WHERE kind=? AND id=?',(kind,identity)).fetchone()
     prior=json.loads(old[0]) if old else {}
     row=clean(kind,{**prior,**patch})
     if prior==row:continue
     before.append({'kind':kind,'row':prior});after.append({'kind':kind,'row':row})
     db.execute('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at',(kind,identity,dump(row),stamp()))
   if after:
    db.execute('INSERT INTO history(at,actor,action,before_json,after_json) VALUES(?,?,?,?,?)',(stamp(),provider+'-collector','sync',dump(before),dump(after)))
    db.execute('UPDATE meta SET revision=revision+1')
  return len(after)
 def dispatch(self,action,body,actor='local'):
  if not isinstance(body,dict): raise MarketError('请求必须是对象。')
  if action=='save':
   if set(body)!={'kind','row','revision'}: raise MarketError('保存字段不合法。')
   return self.write_rows(body['kind'],[clean(body['kind'],body['row'])],body['revision'],actor)
  if action=='import':
   if set(body)!={'kind','csv','revision','apply'} or not isinstance(body['apply'],bool): raise MarketError('导入参数不合法。')
   rows=self.parse_csv(body['kind'],body['csv'])
   if body['apply']: return self.write_rows(body['kind'],rows,body['revision'],actor)
   snapshot=self.snapshot()
   old={key(body['kind'],r) for r in snapshot[body['kind']] if r.get('updated_at')}
   return {'count':len(rows),'replace':sum(key(body['kind'],r) in old for r in rows),'preview':rows[:8],'revision':snapshot['revision'],'checksum':hashlib.sha256(body['csv'].encode()).hexdigest()}
  raise MarketError('不支持该运营操作。',404)
