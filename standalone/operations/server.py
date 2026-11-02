#!/usr/bin/env python3
"""独立运营工作台：仅本机服务，数据和登录资料不与 AI Hub 混用。"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading
from urllib.parse import urlsplit, unquote
import webbrowser

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'scripts'))
from market_hub import MarketError
from market_server import MarketBridge, handle_market


def remote_config(value):
    if not isinstance(value, dict) or set(value) != {'url', 'username', 'password'}:
        raise MarketError('请填写服务器地址、账号和访问密码。')
    if not all(isinstance(v, str) for v in value.values()):
        raise MarketError('服务器配置格式不正确。')
    u = urlsplit(value['url'])
    if (not u.hostname or u.username or u.password or u.query or u.fragment
            or u.path not in ('', '/')
            or (u.scheme != 'https' and not (u.scheme == 'http' and u.hostname in ('localhost', '127.0.0.1')))
            or value['username'] not in ('admin', 'screen') or not value['password']):
        raise MarketError('服务器使用 HTTPS 地址和 admin / screen 账号；本机测试可用 HTTP。')
    return {**value, 'url': value['url'].rstrip('/')}


class OperationsBridge(MarketBridge):
    def __init__(self, root):
        super().__init__(root)
        self.config_path = self.root / '.local/connection.json'
        self.mutex = threading.RLock()

    def config(self):
        if not self.config_path.exists():
            return {'mode': 'local', 'remote': None}
        try:
            value = json.loads(self.config_path.read_text())
            if not isinstance(value, dict) or set(value) != {'mode', 'remote'} or value['mode'] not in ('local', 'shared'):
                raise ValueError()
            if value['remote'] is not None:
                value['remote'] = remote_config(value['remote'])
            if value['mode'] == 'shared' and value['remote'] is None:
                raise ValueError()
            return value
        except (ValueError, OSError, MarketError):
            raise MarketError('本机连接配置不可读；请检查 .local/connection.json，未切换为其他数据源。', 503)

    def remote(self):
        value = self.config()
        return value['remote'] if value['mode'] == 'shared' else None

    def public_config(self):
        value = self.config()
        remote = value['remote'] or {}
        return {'mode': value['mode'], 'url': remote.get('url', ''),
                'username': remote.get('username', 'screen'), 'has_password': bool(remote.get('password'))}

    def set_config(self, body):
        if not isinstance(body, dict) or set(body) - {'mode', 'url', 'username', 'password'} or body.get('mode') not in ('local', 'shared') or any(not isinstance(v, str) for v in body.values()):
            raise MarketError('模式设置格式不正确。')
        with self.mutex:
            old = self.config()
            remote = old['remote']
            if body['mode'] == 'shared':
                url = body.get('url', remote['url'] if remote else '').rstrip('/')
                username = body.get('username', remote['username'] if remote else 'screen')
                password = body.get('password', '')
                if not password and remote and (url, username) == (remote['url'], remote['username']):
                    password = remote['password']
                remote = remote_config({'url': url, 'username': username, 'password': password})
            value = {'mode': body['mode'], 'remote': remote}
            if value == old:
                return self.public_config()
            if self.collector and any(c.active() for c in self.collector.items.values()):
                raise MarketError('仍有商店采集或登录任务运行，请完成或关闭登录窗口后再切换。', 409)
            if self.collector:
                for collector in self.collector.items.values():
                    collector.stop.set()
                    if collector.timer:
                        collector.timer.join(timeout=2)
            self.config_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(self.config_path.parent, 0o700)
            temp = self.config_path.with_suffix('.tmp')
            descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, 'w') as stream:
                json.dump(value, stream, ensure_ascii=False)
            os.chmod(temp, 0o600)
            temp.replace(self.config_path)
            self.collector = None
            return self.public_config()

    def call(self, action, body=None):
        with self.mutex:
            return super().call(action, body)

    def close(self):
        if self.collector:
            for collector in self.collector.items.values():
                collector.stop.set()


class Handler(SimpleHTTPRequestHandler):
    def send_json(self, value, status=200):
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def allowed(self, post=False):
        port = self.server.server_port
        if self.headers.get('Host') not in (f'127.0.0.1:{port}', f'localhost:{port}'):
            self.send_error(403)
            return False
        if post and self.headers.get('Origin') not in (f'http://127.0.0.1:{port}', f'http://localhost:{port}'):
            self.send_error(403)
            return False
        return True

    def do_GET(self):
        if not self.allowed():
            return
        path = urlsplit(self.path).path
        if path == '/api/connection':
            try:
                return self.send_json(self.server.market.public_config())
            except MarketError as error:
                return self.send_json({'error': str(error)}, error.status)
        if path.startswith('/api/market/'):
            return handle_market(self, self.server.market)
        if path in ('/', '/index.html'):
            self.path = '/index.html'
        elif path == '/market.html':
            pass
        elif not path.startswith('/assets/'):
            self.send_error(404)
            return
        clean = unquote(urlsplit(self.path).path)
        target = (Path(self.directory) / clean.lstrip('/')).resolve()
        if any(part.startswith('.') for part in Path(clean).parts) or Path(self.directory).resolve() not in target.parents:
            self.send_error(404)
            return
        super().do_GET()

    def do_POST(self):
        if not self.allowed(post=True):
            return
        path = urlsplit(self.path).path
        if path == '/api/connection':
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 16384:
                    raise MarketError('模式设置请求过大或为空。')
                return self.send_json(self.server.market.set_config(json.loads(self.rfile.read(size))))
            except MarketError as error:
                return self.send_json({'error': str(error)}, error.status)
            except (ValueError, TypeError, AttributeError):
                return self.send_json({'error': '模式设置格式不正确。'}, 400)
            except OSError:
                return self.send_json({'error': '模式设置未保存，请检查本机目录权限。'}, 503)
        if path.startswith('/api/market/'):
            return handle_market(self, self.server.market, post=True)
        self.send_error(404)

    def list_directory(self, path):
        self.send_error(404)
        return None

    def log_message(self, format, *args):
        # 不将请求正文、认证信息或异常原文写入日志。
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=4321)
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    if not (ROOT / 'ui/dist/index.html').is_file():
        parser.error('请先运行 setup.command 构建页面。')
    os.environ['AI_HUB_MARKET_KEYCHAIN_SERVICE'] = 'com.isho.operations.market.auth-state.v1'
    server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(Handler, directory=str(ROOT / 'ui/dist')))
    server.market = OperationsBridge(ROOT)
    server.market.start_collecting()
    if not args.no_open:
        timer = threading.Timer(0.5, webbrowser.open, args=(f'http://127.0.0.1:{server.server_port}',))
        timer.daemon = True
        timer.start()
    print(f'ISHO 运营大屏：http://127.0.0.1:{server.server_port}；关闭终端将停止服务。', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.market.close()
        server.server_close()


if __name__ == '__main__':
    main()
