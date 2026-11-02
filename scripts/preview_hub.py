#!/usr/bin/env python3
"""AI Hub 工作台：来源只读、本机偏好与登记单独保存；工程操作仅开放固定目录选择与 SourceTree 入口。"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import webbrowser
from urllib.parse import urlsplit
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from usage_hub import UsageService
from project_hub import ProjectService, ProjectError
from rules_hub import RulesService, RulesError
from market_server import MarketBridge, handle_market
from tracker_hub import TrackerService, handle_tracker

ROOT = Path(os.environ.get('AI_HUB_ROOT', Path(__file__).resolve().parent.parent)).expanduser().resolve()
THEMES = {'graphite', 'midnight', 'forest', 'plum'}
PREFERENCES_LOCK = threading.Lock()
USAGE_SERVICE = None
USAGE_SERVICE_LOCK = threading.Lock()
PROJECT_SERVICE = None
PROJECT_SERVICE_LOCK = threading.Lock()
MARKET_BRIDGE = MarketBridge(ROOT)
TRACKER = TrackerService()
RULES_SERVICE = None
RULES_SERVICE_LOCK = threading.Lock()

def rules_service():
    global RULES_SERVICE
    with RULES_SERVICE_LOCK:
        if RULES_SERVICE is None or RULES_SERVICE.root != ROOT:
            RULES_SERVICE = RulesService(ROOT)
        return RULES_SERVICE



def project_service():
    global PROJECT_SERVICE
    with PROJECT_SERVICE_LOCK:
        if PROJECT_SERVICE is None or PROJECT_SERVICE.root != ROOT:
            PROJECT_SERVICE = ProjectService(ROOT)
        return PROJECT_SERVICE

def usage_service():
    global USAGE_SERVICE
    with USAGE_SERVICE_LOCK:
        if USAGE_SERVICE is None or USAGE_SERVICE.root != ROOT:
            USAGE_SERVICE = UsageService(ROOT)
        return USAGE_SERVICE


def preferences():
    try:
        value = json.loads((ROOT / '.local/ui-preferences.json').read_text())
        if isinstance(value, dict) and isinstance(value.get('theme'), str) and value['theme'] in THEMES:
            return {'theme': value['theme']}
    except (OSError, ValueError, AttributeError):
        pass
    return {'theme': 'graphite'}


def save_preferences(value):
    if not isinstance(value, dict) or set(value) != {'theme'} or not isinstance(value['theme'], str) or value['theme'] not in THEMES:
        raise ValueError('请选择支持的界面主题')
    with PREFERENCES_LOCK:
        directory = ROOT / '.local'
        directory.mkdir(exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=directory, delete=False) as temp:
            json.dump(value, temp, ensure_ascii=False)
            temp.write('\n')
            temp_path = Path(temp.name)
        try:
            temp_path.replace(directory / 'ui-preferences.json')
        finally:
            temp_path.unlink(missing_ok=True)
    return value


def git(path, *args):
    try:
        return subprocess.run(['git', '-C', str(path), *args], capture_output=True,
                              text=True, timeout=6, check=True).stdout.rstrip('\n')
    except (OSError, subprocess.SubprocessError):
        return ''


def modified(path):
    return datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat()


def project_snapshot(entry):
    return project_service().snapshot(entry)


def snapshot():
    now = datetime.now().astimezone().isoformat()
    raw_entries = project_service().entries()
    with ThreadPoolExecutor(max_workers=4) as pool:
        projects = list(pool.map(project_snapshot, raw_entries))
    skills = []
    categories = {
        'adb-wireless-connect': ('设备连接', '无线 ADB 连接', 'terminal'),
        'sync-isho-main': ('工程协作', '仓库分支同步', 'git'),
        'sync-isho-ble': ('设备连接', '蓝牙能力同步', 'bluetooth'),
        'publish-app': ('应用发布', '应用打包与发布', 'package'),
        'publish-feishu': ('应用发布', '飞书版本通知', 'send'),
        'weekly-report': ('工作效率', '个人与部门周报', 'file'),
        'commit-by-business': ('工程协作', '按业务分批提交', 'git'),
    }
    for line in (ROOT / 'manifest.tsv').read_text().splitlines():
        if not line.startswith('canonical\t'):
            continue
        _, name, origin = line.split('\t')[:3]
        path = ROOT / 'skills' / name / 'SKILL.md'
        text = path.read_text()
        front, body = text.split('---', 2)[1:]
        description = re.search(r'^description:\s*(.+?)(?=\n[^\s]|\Z)', front, re.M | re.S)
        description = re.sub(r'\s+', ' ', description.group(1)).strip(' >-\n"') if description else ''
        category, title, icon = categories.get(name, ('其他', name, 'file'))
        mappings = []
        for client, location in (('Cursor', '.cursor/skills'), ('Codex', '.codex/skills'), ('Agents', '.agents/skills')):
            target = Path.home() / location / name
            mappings.append(dict(client=client, path=str(target),
                                 mapped=target.is_symlink() and target.resolve() == path.parent.resolve()))
        skills.append(dict(id=name, title=title, category=category, icon=icon, origin=origin,
                           description=description, body=body.strip(), source=text, path=str(path),
                           modified=modified(path), mappings=mappings))
    rule_path = ROOT / 'rules/global.md'
    source = rule_path.read_text()
    sections = []
    for index, match in enumerate(re.finditer(r'^## ([^\n]+)\n(.*?)(?=^## |\Z)', source, re.M | re.S)):
        sections.append(dict(id=f'rule-{index}', title=match.group(1), body=match.group(2).strip()))
    raw_status = git(ROOT, 'status', '--porcelain', '--untracked-files=all')
    changes = [dict(status=line[:2].strip(), path=line[3:]) for line in raw_status.splitlines() if line]
    history = []
    for line in git(ROOT, 'log', '-6', '--format=%h%x09%s%x09%cI').splitlines():
        parts = line.split('\t', 2)
        if len(parts) == 3:
            history.append(dict(hash=parts[0], message=parts[1], date=parts[2]))
    codex_entry = Path.home() / '.codex/AGENTS.md'
    return dict(generated_at=now, hub_root=str(ROOT), mode='规则可保存并同步', preferences=preferences(),
                projects=projects, skills=skills,
                rules=dict(path=str(rule_path), source=source, sections=sections, modified=modified(rule_path)),
                changes=changes, history=history,
                clients=[
                    dict(id='cursor', name='Cursor', subtitle='用户规则与个人技能', icon='cursor',
                         path=str(Path.home() / '.cursor/skills'),
                         mapped=sum(next(m for m in s['mappings'] if m['client'] == 'Cursor')['mapped'] for s in skills),
                         rules_state='用户入口待检查', session_state='待核实'),
                    dict(id='codex', name='Codex', subtitle='全局规则与个人技能', icon='hub',
                         path=str(Path.home() / '.codex/skills'),
                         mapped=sum(next(m for m in s['mappings'] if m['client'] == 'Codex')['mapped'] for s in skills),
                         rules_state='全局入口已映射' if codex_entry.is_symlink() and codex_entry.resolve() == rule_path else '全局入口待检查',
                         session_state='待核实')])


class Handler(SimpleHTTPRequestHandler):
    def is_local_host(self):
        allowed = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        return self.headers.get('Host', '') in allowed

    def send_json(self, value, status=200):
        payload = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        path = urlsplit(self.path).path
        if not self.is_local_host():
            self.send_error(403)
            return
        if path.startswith('/api/market/'):
            return handle_market(self, MARKET_BRIDGE)
        if path.startswith('/api/tracker/'):
            return handle_tracker(self, TRACKER)
        if path == '/api/rules':
            self.send_json(rules_service().snapshot())
            return
        if path == '/api/usage':
            self.send_json(usage_service().snapshot())
            return
        if path == '/api/projects/capabilities':
            self.send_json(project_service().capabilities())
            return
        if path.startswith('/api/projects/') and path.endswith('/branches') and len(path.split('/')) == 5:
            try:
                self.send_json(project_service().details(path.split('/')[3]))
            except ProjectError as error:
                self.send_json({'error':str(error)},status=error.status)
            return
        if path == '/api/preferences':
            self.send_json(preferences())
            return
        if path == '/api/snapshot':
            try:
                value = snapshot()
            except (OSError, ValueError, ProjectError) as error:
                self.send_error(500, 'Cannot read Hub snapshot')
                print(f'快照读取失败：{error}', flush=True)
                return
            self.send_json(value)
            return
        if path.startswith('/api/') or any(part.startswith('.') for part in path.split('/') if part):
            self.send_error(404)
            return
        super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        if path.startswith('/api/market/') or path.startswith('/api/tracker/'):
            if not self.is_local_host() or self.headers.get('Origin') != f'http://{self.headers.get("Host")}':
                self.send_error(403)
                return
            if path.startswith('/api/tracker/'):
                return handle_tracker(self, TRACKER, post=True)
            return handle_market(self, MARKET_BRIDGE, post=True)
        project_actions = {'/api/projects/pick', '/api/projects/add', '/api/projects/open-sourcetree'}
        if path in {'/api/rules/sync', '/api/rules/save', '/api/rules/resolve', '/api/rules/permissions'}:
            if not self.is_local_host() or self.headers.get('Origin') != f'http://{self.headers.get("Host")}':
                self.send_error(403)
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 160 * 1024: raise RulesError('规则请求长度不合法。')
                value = json.loads(self.rfile.read(length))
                service = rules_service()
                if path == '/api/rules/permissions':
                    if value != {}: raise RulesError('权限入口不接受路径或命令。')
                    result = subprocess.run(['/usr/bin/open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], capture_output=True, timeout=5)
                    if result.returncode: raise RulesError('无法打开系统设置，请手动前往隐私与安全性 → 辅助功能。', 503)
                    result = {'opened': True}
                elif path == '/api/rules/sync':
                    if not isinstance(value, dict) or set(value) - {'force'} or ('force' in value and not isinstance(value['force'], bool)):
                        raise RulesError('同步不接受路径或命令。')
                    result = {'started': service.start_sync(value.get('force', False), deep=value.get('force', False)), 'snapshot': service.snapshot()}
                elif path == '/api/rules/save':
                    result = service.save(value)
                    service.start_sync(True)
                else:
                    result = {'snapshot': service.resolve(value)}
                    service.start_sync(True)
                self.send_json(result)
            except RulesError as error:
                self.send_json({'error': str(error)}, status=error.status)
            except (ValueError, TypeError):
                self.send_json({'error': '规则请求格式不合法。'}, status=400)
            except OSError:
                self.send_json({'error': '规则文件暂不可读写，请检查目录权限。'}, status=500)
            return
        if path not in project_actions and path != '/api/usage/refresh':
            self.send_error(501)
            return
        if not self.is_local_host() or self.headers.get('Origin') != f'http://{self.headers.get("Host")}':
            self.send_error(403)
            return
        if path in project_actions:
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=4096: raise ProjectError('请求长度不合法。')
                value=json.loads(self.rfile.read(length))
                service=project_service()
                if path=='/api/projects/pick':
                    if value != {}: raise ProjectError('文件夹选择不接受路径或命令参数。')
                    result=service.pick()
                elif path=='/api/projects/add': result=service.add(value)
                else: result=service.open_sourcetree(value)
                self.send_json(result)
            except ProjectError as error:
                self.send_json({'error':str(error)},status=error.status)
            except (ValueError,TypeError): self.send_json({'error':'请求格式不合法。'},status=400)
            except OSError: self.send_json({'error':'本机工程清单暂不可读写，请检查目录权限。'},status=500)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 <= length <= 16 or self.rfile.read(length).strip() not in (b'', b'{}'):
                raise ValueError('不接受命令或路径参数')
        except ValueError:
            self.send_error(400)
            return
        service = usage_service()
        started = service.refresh()
        self.send_json({'started': started, **service.snapshot()}, status=202)

    def do_PUT(self):
        if urlsplit(self.path).path != '/api/preferences':
            self.send_error(404)
            return
        if not self.is_local_host() or self.headers.get('Origin') != f'http://{self.headers.get("Host")}':
            self.send_error(403)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 1024:
                raise ValueError('偏好数据长度不合法')
            value = save_preferences(json.loads(self.rfile.read(length)))
        except (ValueError, TypeError):
            self.send_error(400, 'Unsupported appearance preference')
            return
        except OSError:
            self.send_error(500, 'Cannot save appearance preference')
            return
        self.send_json(value)

    def list_directory(self, path):
        self.send_error(404)
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=4317)
    parser.add_argument('--open', action='store_true', dest='open_browser')
    parser.add_argument('--no-open', action='store_false', dest='open_browser')
    parser.add_argument('--assets', type=Path, help='桌面 App 内打包的界面资源目录')
    args = parser.parse_args()
    directory = args.assets or ROOT / 'ui/dist'
    if not (directory / 'index.html').exists():
        parser.error('请先在 ui/ 执行 npm install 和 npm run build')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(Handler, directory=str(directory)))
    print(f'AI Hub 本地预览：http://127.0.0.1:{server.server_port}（规则可保存并同步）', flush=True)
    MARKET_BRIDGE.start_collecting()
    TRACKER.start()
    if args.open_browser:
        timer = threading.Timer(0.5, webbrowser.open, args=(f'http://127.0.0.1:{server.server_port}',))
        timer.daemon = True
        timer.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        TRACKER.stop()
        server.server_close()


if __name__ == '__main__':
    main()
