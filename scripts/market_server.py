#!/usr/bin/env python3
"""只提供应用运营网页/API 的独立服务；不包含 Hub 本机文件与规则接口。"""
import argparse
import base64
from functools import partial
import hmac
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
import json
import os
import sqlite3
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request,build_opener,HTTPRedirectHandler
from urllib.error import HTTPError,URLError
from market_hub import MarketService,MarketError

class NoRedirect(HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): raise MarketError('运营服务发生重定向，请核对配置中的最终 HTTPS 地址。',502)

class MarketBridge:
 def __init__(self,root):
  self.root=Path(root);self.local=None;self.collector=None
 def start_collecting(self):
  if not (self.root/'.local/market-collector.json').exists() or self.remote():return
  if self.local is None:self.local=MarketService(self.root/'.local/market.sqlite')
  if self.collector is None:
   from market_collect import MarketCollectors
   self.collector=MarketCollectors(self.root,self.local)
  self.collector.start_scheduler()
 def remote(self):
  path=self.root/'.local/market-remote.json'
  if not path.exists(): return None
  try:
   value=json.loads(path.read_text())
   if not isinstance(value,dict) or not isinstance(value.get('url'),str): raise ValueError()
   u=urlsplit(value['url'])
   if set(value)!={'url','username','password'} or u.username or u.password or u.query or u.fragment or u.path not in ('','/') or not u.hostname: raise ValueError()
   if u.scheme!='https' and not(u.scheme=='http' and u.hostname in ('localhost','127.0.0.1')): raise ValueError()
   if value['username'] not in ('admin','screen') or not isinstance(value['password'],str) or not value['password']: raise ValueError()
   return value
  except (ValueError,KeyError,TypeError): raise MarketError('运营服务器配置不合法，请检查本机 market-remote.json；不要将凭据发到聊天中。',503)
 def call(self,action,body=None):
  config=self.remote()
  if config:
   if action=='collect': raise MarketError('当前连接运营服务器；商店登录采集仅在本机模式运行。',403)
   url=config['url'].rstrip('/');auth=base64.b64encode((config['username']+':'+config['password']).encode()).decode()
   request=Request(url+'/api/market/'+action,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),headers={'Authorization':'Basic '+auth,'Content-Type':'application/json','Origin':url})
   try:
    with build_opener(NoRedirect).open(request,timeout=20) as response:
     raw=response.read(4*1024*1024+1)
     if len(raw)>4*1024*1024: raise MarketError('运营服务响应过大。',502)
     value=json.loads(raw)
     if not isinstance(value,dict): raise ValueError()
   except HTTPError as e:
    message={400:'运营数据校验失败，请核对日期、数值和数据来源。',409:'运营数据已被其他窗口更新；请重新读取或重新预览导入。',401:'运营服务器认证失败，请核对本机连接配置。',403:'运营服务器拒绝写入，请核对只读账号与权限。'}.get(e.code,'运营服务器暂时无法处理请求。')
    raise MarketError(message,e.code if e.code in (400,401,403,409) else 502)
   except (URLError,TimeoutError,ValueError): raise MarketError('运营服务器暂不可达，未使用本机旧数据代替。',503)
   snapshot=value if action=='snapshot' else value.get('snapshot')
   if isinstance(snapshot,dict): snapshot['connection']={'mode':'remote','label':'运营服务器 · 与独立网页共用'}
   return value
  if self.local is None:self.local=MarketService(self.root/'.local/market.sqlite')
  if self.collector is None:
   from market_collect import MarketCollectors
   self.collector=MarketCollectors(self.root,self.local)
  self.collector.start_scheduler()
  if action=='collect':return self.collector.control(body)
  value=self.local.snapshot() if action=='snapshot' else self.local.dispatch(action,body)
  snapshot=value if action=='snapshot' else value.get('snapshot')
  if snapshot is not None:snapshot['collection']=self.collector.snapshot()
  return value

def handle_market(handler, service, post=False, actor='local'):
 path=urlsplit(handler.path).path
 action=path.removeprefix('/api/market/') if hasattr(path,'removeprefix') else path[len('/api/market/'):]
 try:
  if post:
   if action not in ('save','import','collect') or (action=='collect' and not isinstance(service,MarketBridge)): raise MarketError('运营接口不存在。',404)
   size=int(handler.headers.get('Content-Length','0'))
   if not 0<size<=700*1024: raise MarketError('请求过大或为空。')
   body=json.loads(handler.rfile.read(size))
   value=service.call(action,body) if isinstance(service,MarketBridge) else service.dispatch(action,body,actor)
  else:
   if action!='snapshot': raise MarketError('运营接口不存在。',404)
   value=service.call(action) if isinstance(service,MarketBridge) else service.snapshot()
   value['read_only']=actor=='screen' or value.get('read_only',False)
  handler.send_json(value)
 except MarketError as e: handler.send_json({'error':str(e)},e.status)
 except (ValueError,TypeError): handler.send_json({'error':'运营请求格式不合法。'},400)
 except (OSError,sqlite3.Error): handler.send_json({'error':'运营数据暂不可读写，请稍后重试。'},503)

class MarketHandler(SimpleHTTPRequestHandler):
 def send_json(self,value,status=200):
  raw=json.dumps(value,ensure_ascii=False,allow_nan=False).encode();self.send_response(status)
  self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def role(self):
  try:
   kind,encoded=self.headers.get('Authorization','').split(' ',1)
   if kind!='Basic': return None
   user,password=base64.b64decode(encoded,validate=True).decode().split(':',1)
   expected=self.server.passwords.get(user)
   if expected and hmac.compare_digest(password.encode(),expected.encode()):return user
  except (ValueError,UnicodeError):pass
  return None
 def access(self):
  allowed={f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}
  if self.server.public_origin: allowed.add(urlsplit(self.server.public_origin).netloc)
  if self.headers.get('Host') not in allowed:self.send_error(403);return None
  role=self.role()
  if role:return role
  self.send_response(401);self.send_header('WWW-Authenticate','Basic realm="ISHO Operations", charset="UTF-8"');self.send_header('Cache-Control','no-store');self.end_headers();return None
 def do_GET(self):
  role=self.access()
  if not role:return
  path=urlsplit(self.path).path
  if path.startswith('/api/market/'):return handle_market(self,self.server.market,actor=role)
  if path in ('/','/market.html'):self.path='/market.html'
  elif not path.startswith('/assets/') or any(p.startswith('.') or p=='..' for p in path.split('/')):self.send_error(404);return
  super().do_GET()
 def do_POST(self):
  role=self.access()
  if not role:return
  origins={f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}'}
  if self.server.public_origin:origins.add(self.server.public_origin)
  if role!='admin' or self.headers.get('Origin') not in origins:self.send_error(403);return
  if not urlsplit(self.path).path.startswith('/api/market/'):self.send_error(404);return
  handle_market(self,self.server.market,post=True,actor=role)
 def list_directory(self,path):self.send_error(404);return None

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--bind',default='127.0.0.1');p.add_argument('--port',type=int,default=4320);p.add_argument('--assets',type=Path,default=Path(__file__).resolve().parent.parent/'ui/dist');p.add_argument('--data',type=Path,default=Path('/data/market.sqlite'));a=p.parse_args()
 password=os.environ.get('MARKET_PASSWORD','');viewer=os.environ.get('MARKET_VIEW_PASSWORD','');origin=os.environ.get('MARKET_PUBLIC_ORIGIN','').rstrip('/')
 if len(password)<20 or (viewer and (len(viewer)<20 or viewer==password)):p.error('设置至少 20 字符的 MARKET_PASSWORD；可选只读密码必须不同。')
 if origin and (urlsplit(origin).scheme!='https' or urlsplit(origin).path or urlsplit(origin).username or urlsplit(origin).query or urlsplit(origin).fragment):p.error('MARKET_PUBLIC_ORIGIN 必须为 HTTPS 源地址，不含路径或凭据。')
 if not(a.assets/'market.html').is_file():p.error('先构建运营网页。')
 server=ThreadingHTTPServer((a.bind,a.port),partial(MarketHandler,directory=str(a.assets)));server.market=MarketService(a.data);server.passwords={'admin':password,'screen':viewer};server.public_origin=origin
 print('运营服务已启动；首次浏览器访问需登录。凭据不输出。',flush=True)
 try:server.serve_forever()
 except KeyboardInterrupt:pass
 finally:server.server_close()
if __name__=='__main__':main()
