#!/usr/bin/env python3
"""AI Hub 工作台：本机目录登记、Git 浏览、规则与偏好管理。"""
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
from urllib.parse import parse_qs, urlsplit
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from usage_hub import UsageService
from project_hub import ProjectService, ProjectError, git as project_git
from rules_hub import RulesService, RulesError
from market_server import MarketBridge, handle_market
from tracker_hub import TrackerService, handle_tracker

ROOT = Path(os.environ.get('AI_HUB_ROOT', Path(__file__).resolve().parent.parent)).expanduser().resolve()
THEMES = {'graphite', 'midnight', 'forest', 'plum'}
PREFERENCES_LOCK = threading.Lock()
TASK_CONTEXT_LOCK = threading.Lock()
TASK_CONTEXT_ROUTE = re.compile(r'/api/task-context/(task|issue)/(rec[A-Za-z0-9_-]{1,120})')
TASK_CONTEXT_LIMITS = {'project_id': 128, 'tree_id': 16, 'path': 4096, 'branch': 512,
                       'source_ref': 512, 'source_sha': 64, 'scope': 2000, 'acceptance': 2000,
                       'delivery': 32, 'evidence': 1000, 'codex_tokens': 15, 'codex_usage_url': 1000,
                       'cursor_tokens': 15, 'cursor_usage_url': 1000}
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


def system_name():
    try:
        full = subprocess.run(['id', '-F'], capture_output=True, text=True, timeout=2).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        full = ''
    return full or os.environ.get('USER') or '用户'


def profile():
    fallback = system_name()
    value = {'name': fallback, 'mark': fallback[:1].upper() or '用', 'subtitle': ''}
    try:
        saved = json.loads((ROOT / '.local/profile.json').read_text())
        if isinstance(saved, dict):
            value.update({key: saved.get(key, value[key]) for key in value})
    except (OSError, ValueError, AttributeError):
        pass
    return sanitize_profile(value, fallback)


def sanitize_profile(value, fallback):
    name = value.get('name') if isinstance(value.get('name'), str) else ''
    name = name.strip()[:40] or fallback[:40]
    mark = value.get('mark') if isinstance(value.get('mark'), str) else ''
    mark = mark.strip()[:2] or name[:1].upper() or '用'
    subtitle = value.get('subtitle') if isinstance(value.get('subtitle'), str) else ''
    return {'name': name, 'mark': mark, 'subtitle': subtitle.strip()[:40]}


def save_profile(value):
    if not isinstance(value, dict):
        raise ValueError('显示名只接受名字、头像字和一句话')
    saved = sanitize_profile(value, system_name())
    directory = ROOT / '.local'
    directory.mkdir(exist_ok=True)
    path = directory / 'profile.json'
    temporary = path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(saved, ensure_ascii=False) + '\n')
    os.chmod(temporary, 0o600)
    temporary.replace(path)
    return saved


def redact(line):
    return re.sub(r'(?i)(token|secret|password|authorization|cookie)([=: ]+)\S+', r'\1\2[已隐藏]', line)[:240]


def diagnostics():
    def when(path):
        try:
            return datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat(timespec='seconds')
        except OSError:
            return None
    local = ROOT / '.local'
    caches = [
        {'id': 'usage', 'label': '用量缓存', 'detail': '上次成功的日统计。采集失败时保留这份，不把缺失日当成 0。', 'updated': when(local / 'usage-snapshot.json')},
        {'id': 'market', 'label': '商店数据库', 'detail': '版本、下载和评论。服务开着时每 30 分钟再读商店。', 'updated': when(local / 'market.sqlite')},
        {'id': 'rules', 'label': '规则同步状态', 'detail': '上次和客户端对过的正文。不是规则本身。', 'updated': when(local / 'rules-state.json')},
    ]
    log = Path.home() / 'Library/Logs/AI Hub/service.log'
    lines = []
    try:
        lines = [redact(line) for line in log.read_text(errors='replace').splitlines()[-40:]]
    except OSError:
        lines = []
    from usage_hub import detected_sources
    return {'caches': caches, 'sources': detected_sources(ROOT), 'log_path': '~/Library/Logs/AI Hub/service.log', 'log': lines}


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
        save_local_json(ROOT / '.local/ui-preferences.json', value)
    return value


def save_local_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as temp:
        temp_path = Path(temp.name)
        try:
            json.dump(value, temp, ensure_ascii=False)
            temp.write('\n')
            temp.flush()
            temp_path.replace(path)
        finally:
            temp_path.unlink(missing_ok=True)


def task_context_path(kind, record_id):
    return ROOT / '.local/task-context' / f'{kind}-{record_id}.json'


def task_context(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return {'revision': 0, 'context': None}


def evidence_url(value):
    url = urlsplit(value)
    return url.scheme in ('http', 'https') and url.hostname and not url.username and not url.password


def save_task_context(path, body):
    if not isinstance(body, dict) or set(body) != {'revision', 'context'} or type(body['revision']) is not int:
        raise ProjectError('执行资料请求格式无效。')
    value = body['context']
    if not isinstance(value, dict) or set(value) != set(TASK_CONTEXT_LIMITS) or any(
            not isinstance(value[key], str) or len(value[key]) > limit for key, limit in TASK_CONTEXT_LIMITS.items()):
        raise ProjectError('执行资料字段无效或过长。')
    value = {key: item.strip() for key, item in value.items()}
    if (not re.fullmatch(r'[A-Za-z0-9_-]+', value['project_id'])
            or not re.fullmatch(r'[a-f0-9]{16}', value['tree_id'])
            or not re.fullmatch(r'(?:[a-f0-9]{40}|[a-f0-9]{64})', value['source_sha'])
            or not value['source_ref']):
        raise ProjectError('请选择已登记工作树和可核实的来源提交。')
    if value['delivery'] not in ('pending', 'review', 'verified'):
        raise ProjectError('请选择有效的交付阶段。')
    if value['delivery'] == 'verified' and (not value['acceptance'] or not value['evidence']):
        raise ProjectError('标记已验收前请填写验收结果和证据。')
    if value['evidence'] and not evidence_url(value['evidence']):
        raise ProjectError('交付证据应使用可访问的 HTTP(S) 链接。')
    for provider in ('codex', 'cursor'):
        tokens, evidence = value[provider + '_tokens'], value[provider + '_usage_url']
        if (tokens or evidence) and (not re.fullmatch(r'[0-9]+', tokens) or not evidence_url(evidence)):
            raise ProjectError(f'{provider} 任务用量需要非负整数 tokens 和本次任务的证据链接。')
    project = project_service().worktree_context(value['project_id'], value['tree_id'])
    if (value['path'], value['branch']) != (project['path'], project['branch']):
        raise ProjectError('目标工作树的分支或路径已改变，请重新选择。', 409)
    if project_git(project['path'], 'cat-file', '-t', value['source_sha']) != 'commit':
        raise ProjectError('本机无法核对来源提交，请重新选择来源。', 409)
    with TASK_CONTEXT_LOCK:
        current = task_context(path)
        if current['revision'] != body['revision']:
            raise ProjectError('执行资料已被另一窗口更新，请重新打开后核对。', 409)
        saved = dict(revision=current['revision'] + 1, context=value,
                     updated_at=datetime.now().astimezone().isoformat(timespec='seconds'))
        save_local_json(path, saved)
        return saved


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
    for line in (ROOT / 'manifest.tsv').read_text().splitlines():
        if not line.startswith('canonical\t'):
            continue
        _, name, origin, category, icon = (line.split('\t') + ['', ''])[:5]
        category, icon = category or '其他', icon or 'file'
        path = ROOT / 'skills' / name / 'SKILL.md'
        text = path.read_text()
        front, body = text.split('---', 2)[1:]
        description = re.search(r'^description:\s*(.+?)(?=\n[^\s]|\Z)', front, re.M | re.S)
        description = re.sub(r'\s+', ' ', description.group(1)).strip(' >-\n"') if description else ''
        heading = re.search(r'^# (.+)$', body, re.M)
        title = heading.group(1).strip() if heading else name
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
    return dict(generated_at=now, hub_root=str(ROOT), mode='规则可保存并同步', preferences=preferences(), profile=profile(),
                projects=projects, skills=skills, features={'task_context': True},
                rules=dict(path=str(rule_path), source=source, sections=sections, modified=modified(rule_path)),
                changes=changes, history=history)


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
        url = urlsplit(self.path)
        path = url.path
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
        git_view = re.fullmatch(r'/api/projects/([a-zA-Z0-9_-]+)/git/(history|files|changes|diff)', path)
        if git_view:
            try:
                query = parse_qs(url.query, keep_blank_values=True, max_num_fields=3)
                self.send_json(project_service().git_view(*git_view.groups(), query))
            except ProjectError as error:
                self.send_json({'error': str(error)}, status=error.status)
            except ValueError:
                self.send_json({'error': 'Git 浏览参数无效。'}, status=400)
            return
        worktree = re.fullmatch(r'/api/projects/([a-zA-Z0-9_-]+)/worktree/([a-f0-9]{16})', path)
        context = TASK_CONTEXT_ROUTE.fullmatch(path)
        if worktree or context:
            try:
                value = (project_service().worktree_context(*worktree.groups()) if worktree
                         else task_context(task_context_path(*context.groups())))
                self.send_json(value)
            except ProjectError as error:
                self.send_json({'error': str(error)}, status=error.status)
            except (OSError, ValueError):
                self.send_json({'error': '本机执行资料暂不可读取。'}, status=500)
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
        if path == '/api/profile':
            self.send_json(profile())
            return
        if path == '/api/diagnostics':
            self.send_json(diagnostics())
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
        path = urlsplit(self.path).path
        context = TASK_CONTEXT_ROUTE.fullmatch(path)
        if not context and path not in ('/api/preferences', '/api/profile'):
            self.send_error(404)
            return
        if not self.is_local_host() or self.headers.get('Origin') != f'http://{self.headers.get("Host")}':
            self.send_error(403)
            return
        if context:
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 64 * 1024:
                    raise ValueError()
                self.send_json(save_task_context(task_context_path(*context.groups()), json.loads(self.rfile.read(length))))
            except ProjectError as error:
                self.send_json({'error': str(error)}, status=error.status)
            except (ValueError, TypeError):
                self.send_json({'error': '执行资料请求格式无效。'}, status=400)
            except OSError:
                self.send_json({'error': '无法保存本机执行资料，请检查目录权限。'}, status=500)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 1024:
                raise ValueError('数据长度不合法')
            body = json.loads(self.rfile.read(length))
            value = save_preferences(body) if path == '/api/preferences' else save_profile(body)
        except (ValueError, TypeError):
            self.send_error(400, 'Unsupported preference')
            return
        except OSError:
            self.send_error(500, 'Cannot save preference')
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
