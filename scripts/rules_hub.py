#!/usr/bin/env python3
"""规则真实来源管理；白名单保存、版本检查、备份和原生 Cursor 同步。"""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import uuid


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def normalized(text):
    return ' '.join(text.split())

def same(a, b):
    return a.rstrip('\n') == b.rstrip('\n')


class RulesError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class CursorRules:
    def __init__(self, script=None):
        self.script = script or Path(__file__).with_name('cursor_rules.applescript')
        self.cache = {}
        self.last_deep = 0
        self.deep_next = False

    def call(self, action, old='', new=''):
        with tempfile.TemporaryDirectory(prefix='ai-hub-cursor-') as directory:
            args = ['/usr/bin/osascript', str(self.script), action]
            if action not in ('read', 'list'):
                for name, value in [('old', old), ('new', new)]:
                    p = Path(directory) / name
                    p.write_text(value)
                    args.append(str(p))
                args.append(normalized(old))
            try:
                result = subprocess.run(args, capture_output=True, text=True, timeout=300)
            except (OSError, subprocess.TimeoutExpired):
                raise RulesError('Cursor 原生同步不可用或超时；请检查 Cursor 及系统设置中的辅助功能、自动化权限。', 503)
            if result.returncode:
                if '-25211' in result.stderr:
                    raise RulesError('macOS 未授予当前 AI Hub 辅助功能权限。请在系统设置 → 隐私与安全性 → 辅助功能重新授权 AI Hub，再检查同步。', 503)
                if '-1743' in result.stderr:
                    raise RulesError('macOS 未允许 AI Hub 自动化控制 Cursor / System Events。请在系统设置 → 隐私与安全性 → 自动化中授权后重试。', 503)
                # 只返回脚本自己的说明，避免客户端或系统输出混入正文。
                message = result.stderr.strip().split('execution error:')[-1].strip()[:300]
                raise RulesError(message or 'Cursor 原生同步失败。', 503)
            return result.stdout.rstrip('\n')

    @contextmanager
    def transaction(self):
        # 多个网页 / 桌面服务也不能同时操作同一个 Cursor 编辑器。
        path = Path(tempfile.gettempdir()) / ('ai-hub-cursor-' + str(os.getuid()) + '.lock')
        fd = os.open(str(path), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        previous_pid = None
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                previous = subprocess.run(['/usr/bin/osascript', '-e', 'tell application "System Events" to get unix id of first application process whose frontmost is true'], capture_output=True, text=True, timeout=5)
                if previous.returncode == 0 and previous.stdout.strip().isdigit():
                    previous_pid = int(previous.stdout.strip())
            except (OSError, subprocess.TimeoutExpired):
                pass
            yield
        finally:
            if previous_pid is not None:
                try:
                    subprocess.run(['/usr/bin/osascript', '-e', 'tell application "System Events" to set frontmost of first application process whose unix id is ' + str(previous_pid) + ' to true'], capture_output=True, timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def read(self):
        with self.transaction():
            return self._read()

    def _read(self):
        if not self.cache or self.deep_next or time.monotonic() - self.last_deep > 600:
            self.deep_next = False
            output = self.call('read')
            values = output.split(chr(30)) if output else []
            self.last_deep = time.monotonic()
        else:
            output = self.call('list')
            summaries = output.split(chr(30)) if output else []
            values = [self.cache.get(normalized(t)) or self.call('get', t) for t in summaries]
        self.cache = {normalized(t): t for t in values}
        return values

    def write(self, old, new):
        with self.transaction():
            return self._write(old, new)

    def _write(self, old, new):
        self.call('update' if old is not None else 'add', old or '', new)
        saved = self.call('get', normalized(new))
        matches = [saved] if same(saved, new) else []
        if len(matches) != 1:
            raise RulesError('Cursor 保存后的读回未确认；保留待同步状态，请重新检查。', 503)
        self.cache[normalized(new)] = matches[0]
        return matches[0]


class RulesService:
    def __init__(self, root, home=None, cursor=None):
        self.root = Path(root).resolve()
        self.home = Path(home) if home else Path.home()
        self.cursor = cursor or CursorRules()
        self.lock = threading.RLock()
        self.file = self.root / '.local/rules-state.json'
        self.running = False
        self.last_attempt = 0
        self.error = ''
        self.checked_at = None
        try:
            self.state = json.loads(self.file.read_text())
            if self.state.get('schema_version') != 1 or not isinstance(self.state.get('cursor'), dict):
                raise ValueError()
        except (OSError, ValueError, AttributeError):
            self.state = {'schema_version': 1, 'cursor': {}}
        if isinstance(self.cursor, CursorRules):
            baselines = [r.get('synced') for r in self.state['cursor'].values()] + [self.state.get('bootstrap', {}).get('synced')]
            self.cursor.cache = {normalized(t): t for t in baselines if isinstance(t, str) and t}

    def atomic(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as f:
            f.write(text)
            temp = Path(f.name)
        try:
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)

    def persist(self):
        self.atomic(self.file, json.dumps(self.state, ensure_ascii=False, indent=2) + '\n')

    def path(self, rule_id):
        fixed = {'global': 'rules/global.md', 'cursor-bootstrap': 'rules/cursor-bootstrap.md'}
        if rule_id in fixed:
            p = self.root / fixed[rule_id]
        elif rule_id in self.state['cursor']:
            p = self.root / 'rules/clients/cursor' / (rule_id + '.md')
        else:
            raise RulesError('未知规则。', 404)
        if p.is_symlink() or not p.resolve().is_relative_to(self.root / 'rules'):
            raise RulesError('规则来源路径不合法。')
        return p

    def backup(self, path):
        if path.exists():
            name = time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8]
            target = self.root / '.backups/rules' / name / path.relative_to(self.root)
            self.atomic(target, path.read_text())
            return str(target.relative_to(self.root))
        return None

    def snapshot(self):
        with self.lock:
            docs = []
            ids = ['global', 'cursor-bootstrap'] + list(self.state['cursor'])
            global_path = self.root / 'rules/global.md'
            entry = self.home / '.codex/AGENTS.md'
            codex_ok = entry.is_symlink() and entry.resolve() == global_path
            codex_source = entry.read_text() if entry.is_file() else None
            for rule_id in ids:
                p = self.path(rule_id)
                if not p.is_file():
                    continue
                source = p.read_text()
                record = self.state['cursor'].get(rule_id, {})
                if rule_id == 'global':
                    title, client = '共享全局规则', 'shared'
                    state = 'synced' if codex_ok else 'conflict' if codex_source is not None else 'pending'
                elif rule_id == 'cursor-bootstrap':
                    title, client = 'Cursor 共享规则入口', 'cursor'
                    record = self.state.get('bootstrap', {})
                    state = record.get('status', 'unchecked')
                else:
                    title, client = record.get('title', rule_id), 'cursor'
                    state = record.get('status', 'unchecked')
                if record and state == 'synced' and not same(source, record.get('synced', '')):
                    state = 'pending'
                docs.append(dict(id=rule_id, title=title, client=client, path=str(p), source=source,
                                 revision=digest(source), status=state, remote=record.get('remote'),
                                 remote_revision=digest(record['remote']) if record.get('remote') is not None else None))
            if not codex_ok and codex_source is not None:
                docs.append(dict(id='codex-entry', title='Codex 独立全局入口（待整合）', client='codex', path=str(entry), source=codex_source, revision=digest(codex_source), status='conflict', remote=global_path.read_text(), remote_revision=digest(global_path.read_text())))
            return dict(schema_version=1, documents=docs, running=self.running, error=self.error,
                        checked_at=self.checked_at,
                        clients=[dict(id='codex', status='synced' if codex_ok else 'conflict' if codex_source is not None else 'pending',
                                      path=str(entry), remote=codex_source if not codex_ok else None,
                                      message='直接读取 Hub 共享正文' if codex_ok else '全局入口缺失或存在独立修改；需修复映射'),
                                 dict(id='cursor', status='error' if self.error else 'checking' if self.running else 'checked' if self.checked_at else 'unchecked',
                                      message=self.error or '通过 Cursor 原生 User Rules 读取、保存并读回；会话加载另行核实')])

    def save(self, value):
        if not isinstance(value, dict) or set(value) != {'id', 'source', 'revision'}:
            raise RulesError('保存参数不合法。')
        if not isinstance(value['id'], str) or not isinstance(value['source'], str) or not value['source'].strip() or len(value['source'].encode()) > 128 * 1024:
            raise RulesError('规则正文为空或过长。')
        with self.lock:
            if value['id'] == 'codex-entry':
                raise RulesError('Codex 独立入口与共享正文有差异。请先对比并明确整合到共享规则，避免影响另一端。', 409)
            p = self.path(value['id'])
            current = p.read_text()
            if digest(current) != value['revision']:
                raise RulesError('来源已被其他窗口修改；请对比后重新保存，编辑内容仍保留。', 409)
            backup = None
            if current != value['source']:
                backup = self.backup(p)
                self.atomic(p, value['source'])
            return {'backup': backup, 'snapshot': self.snapshot()}

    def resolve(self, value):
        if not isinstance(value, dict) or set(value) != {'id', 'choice', 'revision', 'remote_revision'} or value['choice'] not in ('hub', 'client'):
            raise RulesError('请选择 Hub 或客户端版本。')
        with self.lock:
            rule_id = value['id']
            record = self.state.get('bootstrap', {}) if rule_id == 'cursor-bootstrap' else self.state['cursor'].get(rule_id, {})
            p = self.path(rule_id)
            source = p.read_text()
            remote = record.get('remote')
            if digest(source) != value['revision'] or remote is None or digest(remote) != value['remote_revision']:
                raise RulesError('冲突版本已变化，请重新检查。', 409)
            if value['choice'] == 'client' and not remote:
                raise RulesError('客户端条目已删除；为保留原文，请使用 Hub 版本恢复。', 409)
            if value['choice'] == 'client':
                self.backup(p)
                self.atomic(p, remote + '\n')
                record['synced'] = remote
                record['status'] = 'synced'
                record.pop('remote', None)
            else:
                # 下一次原生同步会再次读取客户端，只有它仍是该版本时才覆盖。
                record['synced'] = remote
                record['recreate'] = not bool(remote)
                record['status'] = 'pending'
                record.pop('remote', None)
            self.persist()
        return self.snapshot()

    def start_sync(self, force=False, deep=False):
        with self.lock:
            if self.running or (not force and time.monotonic() - self.last_attempt < 60):
                return False
            if deep and isinstance(self.cursor, CursorRules):
                self.cursor.deep_next = True
            self.running = True
            self.last_attempt = time.monotonic()
            threading.Thread(target=self.sync, daemon=True).start()
            return True

    def reconcile(self, rule_id, record, remote):
        p = self.path(rule_id)
        source = p.read_text()
        previous = record.get('synced')
        if remote is not None and same(remote, source):
            record.update(status='synced', synced=remote)
            record.pop('remote', None)
            return
        if remote is None and record.pop('recreate', False):
            saved = self.cursor.write(None, source)
            record.update(status='synced', synced=saved)
            record.pop('remote', None)
            return
        if remote is None:
            record.update(status='conflict', remote='')
            return
        if previous is None or not same(remote, previous):
            record.update(status='conflict', remote=remote)
            return
        saved = self.cursor.write(remote, source)
        record.update(status='synced', synced=saved)
        record.pop('remote', None)

    def sync(self):
        try:
            entry = self.home / '.codex/AGENTS.md'
            target = self.root / 'rules/global.md'
            if not entry.exists() and not entry.is_symlink():
                entry.parent.mkdir(parents=True, exist_ok=True)
                entry.symlink_to(target)
            remotes = self.cursor.read()
            if len({normalized(t) for t in remotes}) != len(remotes):
                raise RulesError('Cursor 存在重复规则，无法唯一定位；请先在客户端整理。', 409)
            with self.lock:
                records = self.state['cursor']
                bootstrap = [text for text in remotes if text.startswith('AI Hub 共享规则入口')]
                if len(bootstrap) > 1:
                    raise RulesError('Cursor 有多个 Hub 入口，停止自动覆盖。', 409)
                record = self.state.setdefault('bootstrap', {})
                if not bootstrap:
                    source = self.path('cursor-bootstrap').read_text()
                    saved = self.cursor.write(None, source)
                    record.update(status='synced', synced=saved)
                else:
                    self.reconcile('cursor-bootstrap', record, bootstrap[0])
                remaining = [t for t in remotes if t not in bootstrap]
                # 先匹配已同步正文，再保守匹配同序号；插入/删除或重排时产生冲突。
                claimed = set()
                for rule_id, rec in records.items():
                    matches = [i for i,t in enumerate(remaining) if i not in claimed and same(t, rec.get('synced', ''))]
                    i = matches[0] if len(matches) == 1 else rec.get('index')
                    remote = remaining[i] if isinstance(i,int) and i < len(remaining) and i not in claimed else None
                    if remote is not None:
                        claimed.add(i)
                        rec['index'] = i
                    self.reconcile(rule_id, rec, remote)
                for i, text in enumerate(remaining):
                    if i in claimed: continue
                    rule_id = 'cursor-' + uuid.uuid4().hex
                    records[rule_id] = dict(title=text.splitlines()[0][:65], index=i, synced=text, status='synced')
                    self.atomic(self.path(rule_id), text + '\n')
                self.persist()
                self.error = ''
                self.checked_at = time.strftime('%Y-%m-%dT%H:%M:%S%z')
        except (RulesError, OSError, ValueError, subprocess.SubprocessError) as error:
            with self.lock:
                self.error = str(error)
                self.persist()
        finally:
            with self.lock:
                self.running = False
