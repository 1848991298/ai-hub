#!/usr/bin/env python3
"""问题与任务台账：飞书多维表格是主数据，Hub 服务存活期间轮询并写回。"""
import json
import os
from datetime import datetime
from pathlib import Path
import subprocess
import threading
import copy
import sqlite3
from zoneinfo import ZoneInfo

from tracker_config import load_settings
from tracker_outbox import TrackerOutbox

BASE_TOKEN, BASE_URL, TABLES, CONFIG_ERROR = load_settings(
    Path(os.environ.get('AI_HUB_ROOT') or Path(__file__).resolve().parent.parent)
)
INTERVAL = 30
ZONE = ZoneInfo('Asia/Shanghai')
STATUSES = ('未启动', '开发中', '测试中', '已完成')
STATUS_ALIASES = {'进行中': '开发中', '已结束': '已完成'}
PRIORITIES = ('P0', 'P1', 'P2')
NAMES = {'content': '内容', 'status': '状态', 'due': '截止时间', 'priority': '优先级', 'note': '备注', 'tags': '标签', 'archived': '已归档'}
EDITABLE = ('content', 'status', 'due', 'priority', 'note', 'tags', 'archived')


def canonical_status(value):
    return STATUS_ALIASES.get(value, value) if isinstance(value, str) else value


class TrackerError(Exception):
    def __init__(self, message, status=400, missing=None, uncertain=False):
        super().__init__(message)
        self.status = status
        self.missing = list(missing or [])
        self.uncertain = uncertain


def now():
    return datetime.now(ZONE)


def date_only(value):
    if value in (None, ''):
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        stamp = value / 1000 if value > 10**11 else value
        return datetime.fromtimestamp(stamp, ZONE).strftime('%Y-%m-%d')
    text = str(value).strip()
    if len(text) >= 10 and text[4] == '-' and text[7] == '-':
        try:
            datetime.strptime(text[:10], '%Y-%m-%d')
        except ValueError:
            return None
        return text[:10]
    return None


def clock_label(value):
    if value in (None, ''):
        return None
    if isinstance(value, str) and 'T' in value:
        moment = datetime.fromisoformat(value)
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=ZONE)
        return moment.astimezone(ZONE).strftime('%Y-%m-%d %H:%M')
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        stamp = value / 1000 if value > 10**11 else value
        return datetime.fromtimestamp(stamp, ZONE).strftime('%Y-%m-%d %H:%M')
    return None


def tag_list(value):
    if value in (None, ''):
        return []
    items = value if isinstance(value, list) else [value]
    names = []
    for item in items:
        name = item.get('name') if isinstance(item, dict) else item
        if isinstance(name, str) and name.strip() and name.strip() not in names:
            names.append(name.strip())
    return names


def choice(value):
    if isinstance(value, list):
        value = value[0] if value else None
    if value in (None, ''):
        return None
    return str(value)


def text_cell(value):
    if value in (None, ''):
        return ''
    if isinstance(value, list):
        return text_cell(value[0] if value else '')
    return str(value)


def normalize(kind, field_ids, record_id, cells):
    expected = TABLES[kind]['fields']
    missing = [name for name, field_id in expected.items() if field_id not in field_ids]
    if missing:
        raise TrackerError('飞书表字段与台账不一致，已停止同步。', 502)
    by_id = {field_id: cells[index] if index < len(cells) else None for index, field_id in enumerate(field_ids)}
    status = canonical_status(choice(by_id[expected['status']]))
    priority = choice(by_id[expected['priority']])
    if status not in STATUSES:
        status = None
    if priority not in PRIORITIES:
        priority = None
    return {
        'id': record_id,
        'kind': kind,
        'content': text_cell(by_id[expected['content']]),
        'status': status,
        'created_at': clock_label(by_id[expected['created']]),
        'due': date_only(by_id[expected['due']]),
        'priority': priority,
        'note': text_cell(by_id[expected['note']]),
        'tags': tag_list(by_id.get(expected.get('tags'))),
        'archived': by_id.get(expected.get('archived')) is True,
    }


class LarkClient:
    def __init__(self, runner=None):
        self.runner = runner or subprocess.run

    def invoke(self, args):
        if not BASE_TOKEN:
            raise TrackerError(CONFIG_ERROR or '请先配置本机 tracker-config.json。', 503)
        writing = any(command in args for command in ('+record-batch-create', '+record-batch-update'))
        try:
            completed = self.runner(
                ['lark-cli', *args, '--as', 'user', '--format', 'json'],
                capture_output=True, text=True, timeout=45,
            )
        except subprocess.TimeoutExpired as error:
            raise TrackerError('飞书响应超时，请核对同步结果。', 504, uncertain=writing) from error
        raw = (completed.stdout or completed.stderr or '').strip()
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError as error:
            raise TrackerError('飞书没有返回可识别的结果，请核对同步结果。', 502, uncertain=writing) from error
        if payload.get('ok') is False or completed.returncode not in (0, None):
            err = payload.get('error') if isinstance(payload.get('error'), dict) else {}
            missing = err.get('missing_scopes') or []
            if 'base:record:update' in missing:
                raise TrackerError('当前授权不能修改飞书记录，缺少 base:record:update。输入已保留，完成授权后再保存。', 403, missing)
            if 'base:record:create' in missing:
                raise TrackerError('当前授权不能新建飞书记录，缺少 base:record:create。输入已保留。', 403, missing)
            message = err.get('message') or '飞书暂时无法完成这次操作。'
            raise TrackerError(message, 502, missing)
        return payload

    def list_kind(self, kind):
        table_id = TABLES[kind]['id']
        rows, offset = [], 0
        while True:
            payload = self.invoke([
                'base', '+record-list', '--base-token', BASE_TOKEN, '--table-id', table_id,
                '--limit', '200', '--offset', str(offset),
            ])
            data = payload.get('data') or {}
            ids = data.get('record_id_list') or []
            cells = data.get('data') or []
            field_ids = data.get('field_id_list') or []
            for record_id, row in zip(ids, cells):
                rows.append(normalize(kind, field_ids, record_id, row))
            if not data.get('has_more') or not ids:
                return rows
            offset += len(ids)
            if offset > 2000:
                return rows

    def create(self, kind, fields):
        payload = self.invoke([
            'base', '+record-batch-create', '--base-token', BASE_TOKEN, '--table-id', TABLES[kind]['id'],
            '--json', json.dumps({'create_records': [fields]}, ensure_ascii=False),
        ])
        data = payload.get('data') or {}
        ids = data.get('record_id_list') or data.get('record_ids') or []
        if not ids and isinstance(data.get('records'), list):
            ids = [item.get('record_id') or item.get('id') for item in data['records'] if isinstance(item, dict)]
        ids = [item for item in ids if isinstance(item, str) and item]
        if len(ids) != 1:
            raise TrackerError('飞书已收到新建请求，但没有返回唯一记录编号。请先刷新，不要重复提交。', 502, uncertain=True)
        return ids[0]

    def update(self, kind, record_id, fields):
        self.invoke([
            'base', '+record-batch-update', '--base-token', BASE_TOKEN, '--table-id', TABLES[kind]['id'],
            '--json', json.dumps({'update_records': {record_id: fields}}, ensure_ascii=False),
        ])


class TrackerService:
    def __init__(self, client=None, root=None, queue_autostart=True):
        self.client = client or LarkClient()
        self.root = Path(root or os.environ.get('AI_HUB_ROOT') or Path(__file__).resolve().parent.parent)
        self.lock = threading.Lock()
        self._write_lock = threading.RLock()
        self.rows = {'issue': [], 'task': []}
        self.synced_at = None
        self.error = None
        self.missing = []
        self.polling = False
        self._stop = threading.Event()
        self._thread = None
        self._inflight = set()
        self._seen = self._load_seen()
        self.outbox = TrackerOutbox(self.root)
        cached = self.outbox.cached() or {}
        if isinstance(cached.get('rows'), dict):
            self.rows = {kind: cached['rows'].get(kind, []) for kind in TABLES}
            self.synced_at = cached.get('synced_at')
        self._queue_autostart = queue_autostart
        self._queue_thread = None
        self._queue_wake = threading.Event()
        for job in self.outbox.jobs():
            if job['state'] == 'uncertain' and job['payload']['body'].get('client_request_id') in self._seen:
                self.outbox.finish(job['id'], 'pending')

    def _load_seen(self):
        path = self.root / '.local' / 'tracker-idempotency.json'
        try:
            value = json.loads(path.read_text())
        except (OSError, ValueError):
            return {}
        if not isinstance(value, dict):
            return {}
        clean = {}
        for key, item in value.items():
            if isinstance(key, str) and isinstance(item, dict) and item.get('kind') in TABLES and isinstance(item.get('record_id'), str):
                clean[key] = {'kind': item['kind'], 'record_id': item['record_id']}
        return clean

    def _store_seen(self):
        directory = self.root / '.local'
        directory.mkdir(exist_ok=True)
        active = {job['payload']['body'].get('client_request_id') for job in self.outbox.jobs()}
        recent = dict(list(self._seen.items())[-100:])
        self._seen = {key: value for key, value in self._seen.items() if key in recent or key in active}
        path = directory / 'tracker-idempotency.json'
        temporary = path.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(self._seen, ensure_ascii=False))
        temporary.replace(path)

    def snapshot(self):
        with self.lock:
            rows = copy.deepcopy(self.rows)
            cloud = copy.deepcopy(self.rows)
            seen = dict(self._seen)
            value = {
                'base_url': BASE_URL,
                'interval_seconds': INTERVAL,
                'synced_at': self.synced_at,
                'error': self.error,
                'missing_scopes': list(self.missing),
                'polling': self.polling,
                'mode': 'poll',
                'delay': f'服务运行期间约每 {INTERVAL} 秒拉取一次；打开页面和手动刷新会立即读飞书。不是即时推送。',
                'boundary': '退出 Hub 后保留待同步修改，下次打开继续。截止到期不会自动完成任务。',
                'status_options': list(STATUSES),
                'priority_options': list(PRIORITIES),
                'tag_options': self._tag_options(),
                'tag_fields': {kind: 'tags' in table['fields'] for kind, table in TABLES.items()},
                'archive_supported': {kind: 'archived' in table['fields'] for kind, table in TABLES.items()},
            }
        jobs = self.outbox.jobs()
        shown = []
        for row_list in rows.values():
            for row in row_list:
                row['status'] = canonical_status(row.get('status'))
                row['archived'] = row.get('archived') is True
        for job in jobs:
            payload = job['payload']
            body, operation = payload['body'], payload['operation']
            kind = body['kind']
            record_id = body.get('record_id') or seen.get(body.get('client_request_id'), {}).get('record_id') or 'local-' + job['id']
            current = next((row for row in cloud[kind] if row['id'] == record_id), None)
            row = next((row for row in rows[kind] if row['id'] == record_id), None)
            if operation == 'create':
                draft = {'content': '', 'status': '未启动', 'due': None, 'priority': None, 'note': '', 'tags': [], 'archived': False,
                         **{key: body[key] for key in EDITABLE if key in body}}
                draft.update(status=canonical_status(body.get('status') or '未启动'), archived=False)
                if not row:
                    row = dict(draft, id=record_id, kind=kind, created_at=None)
                    rows[kind].append(row)
            else:
                draft = {**body.get('base', {}), **body['patch']}
                if row:
                    row.update(body['patch'])
            if row:
                row.update(sync_state=job['state'], sync_job_id=job['id'])
            shown.append({'id': job['id'], 'kind': kind, 'operation': operation, 'record_id': record_id,
                          'title': draft.get('content') or (current or {}).get('content') or '记录',
                          'state': job['state'], 'error': job['error'], 'status': job['status'],
                          'draft': draft, 'patch': body.get('patch'), 'cloud_record': current})
        value.update(issues=rows['issue'], tasks=rows['task'], sync={
            'pending': sum(job['state'] in ('pending', 'writing') for job in jobs),
            'failed': sum(job['state'] in ('failed', 'uncertain') for job in jobs), 'jobs': shown})
        return value

    def refresh(self):
        try:
            issues = self.client.list_kind('issue')
            tasks = self.client.list_kind('task')
        except TrackerError as error:
            with self.lock:
                self.error = str(error)
                self.missing = error.missing
            return self.snapshot()
        with self.lock:
            self.rows['issue'] = issues
            self.rows['task'] = tasks
            self.synced_at = now().isoformat(timespec='seconds')
            self.error = None
            self.missing = []
            self.outbox.cache({'rows': self.rows, 'synced_at': self.synced_at})
        return self.snapshot()

    def start(self):
        if isinstance(self.client, LarkClient) and not BASE_TOKEN:
            with self.lock:
                self.error = CONFIG_ERROR or '请先配置本机 tracker-config.json。'
            return
        with self.lock:
            if self._thread and self._thread.is_alive():
                return
            self.polling = True
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name='tracker-sync', daemon=True)
            self._thread.start()
        if self._queue_autostart:
            self._start_queue()

    def stop(self):
        self._stop.set()
        self._queue_wake.set()
        thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=2)
        with self.lock:
            self.polling = False

    def _start_queue(self):
        with self.lock:
            if self._queue_thread and self._queue_thread.is_alive():
                self._queue_wake.set()
                return
            self._queue_thread = threading.Thread(target=self._queue_loop, name='tracker-outbox', daemon=True)
            self._queue_thread.start()

    def _queue_loop(self):
        while not self._stop.is_set():
            self._queue_wake.clear()
            if not self.process_next():
                self._queue_wake.wait(2)

    def process_next(self):
        job = self.outbox.claim()
        if not job:
            return False
        operation, body = job['payload']['operation'], job['payload']['body']
        try:
            self.create(body) if operation == 'create' else self.update(body)
        except TrackerError as error:
            state = 'uncertain' if operation == 'create' and error.uncertain else 'failed'
            self.outbox.finish(job['id'], state, str(error)[:400], error.status)
        except Exception:
            state = 'uncertain' if operation == 'create' else 'failed'
            self.outbox.finish(job['id'], state, '本次同步结果未确认，修改已保留，请核对后继续。', 502)
        else:
            self.outbox.finish(job['id'])
        return True

    def enqueue(self, body):
        if not isinstance(body, dict):
            raise TrackerError('提交参数不合法。')
        operations = body.get('operations', [body])
        if not isinstance(operations, list) or not 1 <= len(operations) <= 100:
            raise TrackerError('一次请选择 1–100 条记录。')
        items = []
        for item in operations:
            if not isinstance(item, dict) or item.get('operation') not in ('create', 'update'):
                raise TrackerError('不支持的队列操作。')
            kind = self._kind(item)
            job_id = item.get('client_operation_id')
            if not isinstance(job_id, str) or not 8 <= len(job_id) <= 64 or any(ch not in '0123456789abcdef-' for ch in job_id):
                raise TrackerError('缺少操作编号，请重新打开后保存。')
            if item['operation'] == 'create':
                form = self._clean_patch(kind, {key: item.get(key) for key in EDITABLE if key in item})
                form.setdefault('status', '未启动')
                if 'content' not in form:
                    raise TrackerError('请填写内容。')
                data = dict(form, kind=kind, client_request_id=job_id)
                target = kind + ':local-' + job_id
            else:
                record_id, base = item.get('record_id'), item.get('base')
                if not isinstance(record_id, str) or not record_id.startswith('rec') or not isinstance(base, dict):
                    raise TrackerError('这条记录尚未创建完成，请同步后再编辑。')
                patch = self._clean_patch(kind, item.get('patch'))
                baseline = {key: base.get(key) for key in EDITABLE}
                baseline['status'] = canonical_status(baseline.get('status'))
                data = {'kind': kind, 'record_id': record_id, 'base': baseline, 'patch': patch}
                target = kind + ':' + record_id
            items.append({'id': job_id, 'target': target, 'payload': {'operation': item['operation'], 'body': data}})
        supersedes = body.get('supersedes')
        if supersedes:
            old = self.outbox.get(supersedes)
            if old and old['state'] == 'uncertain' and body.get('confirmed_not_created') is not True:
                raise TrackerError('新建结果未确认，请先核对飞书后再继续。', 409)
        try:
            self.outbox.enqueue(items, supersedes)
        except ValueError as error:
            raise TrackerError(str(error), 409) from error
        if self._queue_autostart:
            self._start_queue()
        return {'accepted': True, 'job_ids': [item['id'] for item in items], 'snapshot': self.snapshot()}

    def queue_control(self, body):
        if not isinstance(body, dict) or body.get('operation') not in ('retry', 'discard') or not isinstance(body.get('job_id'), str):
            raise TrackerError('同步操作参数不合法。')
        try:
            if body['operation'] == 'retry':
                self.outbox.retry(body['job_id'])
                if self._queue_autostart:
                    self._start_queue()
            else:
                self.outbox.discard(body['job_id'])
        except ValueError as error:
            raise TrackerError(str(error), 409) from error
        return {'snapshot': self.snapshot()}

    def _clean_patch(self, kind, values):
        if not isinstance(values, dict) or not values or set(values) - set(EDITABLE):
            raise TrackerError('没有可保存的字段，或包含不支持的字段。')
        result = {}
        for key, value in values.items():
            if key == 'status':
                value = canonical_status(value)
                if value not in STATUSES:
                    raise TrackerError('状态只能是未启动、开发中、测试中或已完成。')
                result[key] = value
            elif key == 'archived':
                if 'archived' not in TABLES[kind]['fields']:
                    raise TrackerError('飞书归档字段尚未配置，请先完成台账配置。')
                if not isinstance(value, bool):
                    raise TrackerError('归档标记需要是布尔值。')
                result[key] = value
            else:
                if key == 'tags' and value and 'tags' not in TABLES[kind]['fields']:
                    raise TrackerError('此表还未配置标签字段。')
                validator = {'content': self._content, 'due': self._due, 'priority': self._priority, 'note': self._note, 'tags': self._tags}[key]
                result[key] = validator(value)
        return result

    def _loop(self):
        while not self._stop.is_set():
            self.refresh()
            if self._stop.wait(INTERVAL):
                return

    def _find(self, kind, record_id):
        for row in self.rows[kind]:
            if row['id'] == record_id:
                return row
        fresh = self.client.list_kind(kind)
        self.rows[kind] = fresh
        for row in fresh:
            if row['id'] == record_id:
                return row
        raise TrackerError('飞书里已经没有这条记录。', 404)

    def create(self, body):
        with self._write_lock:
            return self._create(body)

    def _create(self, body):
        kind = self._kind(body)
        request_id = body.get('client_request_id')
        if not isinstance(request_id, str) or not 8 <= len(request_id) <= 64 or any(ch not in '0123456789abcdef-' for ch in request_id):
            raise TrackerError('缺少本次提交编号，请重新打开表单后再保存。')
        content = self._content(body.get('content'))
        status = canonical_status(body.get('status') or '未启动')
        if status not in STATUSES:
            raise TrackerError('状态只能是未启动、开发中、测试中或已完成。')
        priority = self._priority(body.get('priority'))
        due = self._due(body.get('due'))
        note = self._note(body.get('note'))
        tags = self._tags(body.get('tags'))
        if tags and 'tags' not in TABLES[kind]['fields']:
            raise TrackerError('此表还未配置标签字段。')
        self._ensure_tags(tags)
        with self.lock:
            seen = self._seen.get(request_id)
            if request_id in self._inflight:
                raise TrackerError('正在提交，请不要重复点击。', 409)
            if not seen:
                self._inflight.add(request_id)
        if seen:
            if seen['kind'] != kind:
                raise TrackerError('这次提交编号已经用在另一张表。')
            self.refresh()
            if self.error:
                raise TrackerError('飞书已接收新建，暂未读回确认；本次修改仍保留。', 502)
            with self.lock:
                row = next((item for item in self.rows[kind] if item['id'] == seen['record_id']), None)
            if not row:
                raise TrackerError('这次提交已经发给飞书，但列表里还没有它。请刷新，不要重新新建。', 409)
            return {'record': row, 'snapshot': self.snapshot(), 'duplicate': True}
        fields = {'内容': content, '状态': status}
        if priority:
            fields['优先级'] = priority
        if due:
            fields['截止时间'] = due + ' 00:00:00'
        if note:
            fields['备注'] = note
        if tags:
            fields['标签'] = tags
        try:
            record_id = self.client.create(kind, fields)
        except TrackerError as error:
            with self.lock:
                self._inflight.discard(request_id)
                self.error = str(error)
                self.missing = error.missing or self.missing
            raise
        with self.lock:
            self._inflight.discard(request_id)
            self._seen[request_id] = {'kind': kind, 'record_id': record_id}
            self._store_seen()
        self.refresh()
        if self.error:
            raise TrackerError('飞书已接收新建，暂未读回确认；本次修改仍保留。', 502)
        with self.lock:
            row = next((item for item in self.rows[kind] if item['id'] == record_id), None)
        if not row:
            raise TrackerError('飞书已接收新建，但尚未读回记录；请核对后重试同步。', 502)
        return {'record': row, 'snapshot': self.snapshot(), 'duplicate': False}

    def update(self, body):
        with self._write_lock:
            return self._update(body)

    def _update(self, body):
        kind = self._kind(body)
        record_id = body.get('record_id')
        if not isinstance(record_id, str) or not record_id.startswith('rec'):
            raise TrackerError('缺少要修改的飞书记录。')
        baseline = body.get('base')
        patch = self._clean_patch(kind, body.get('patch'))
        if not isinstance(baseline, dict) or not isinstance(patch, dict) or not patch:
            raise TrackerError('没有可保存的修改。')
        unknown = set(patch) - set(EDITABLE)
        if unknown or 'created_at' in patch:
            raise TrackerError('创建时间不能修改，也只能改内容、状态、截止时间、优先级、备注和标签。')
        self.refresh()
        if self.error:
            raise TrackerError('未能核对飞书最新值，本次尚未写入；修改已保留。', 502)
        with self.lock:
            current = self._find(kind, record_id)
        if all(self._same(key, current.get(key), value) for key, value in patch.items()):
            return {'record': current, 'snapshot': self.snapshot(), 'changed': False}
        for key, value in patch.items():
            if self._same(key, current.get(key), baseline.get(key)) or self._same(key, current.get(key), value):
                continue
            raise TrackerError('这条记录在飞书已有新修改，本次未覆盖。请看列表里的新值后再保存。', 409)
        fields = {}
        for key, value in patch.items():
            if key == 'content':
                fields['内容'] = self._content(value)
            elif key == 'status':
                if value not in STATUSES:
                    raise TrackerError('状态只能是未启动、开发中、测试中或已完成。')
                fields['状态'] = value
            elif key == 'priority':
                priority = self._priority(value)
                fields['优先级'] = priority
            elif key == 'due':
                due = self._due(value)
                fields['截止时间'] = None if due is None else due + ' 00:00:00'
            elif key == 'note':
                fields['备注'] = self._note(value) or ''
            elif key == 'tags':
                if 'tags' not in TABLES[kind]['fields']:
                    raise TrackerError('此表还未配置标签字段。')
                tags = self._tags(value)
                self._ensure_tags(tags)
                fields['标签'] = tags
            elif key == 'archived':
                fields['已归档'] = value
        if not fields:
            return {'record': current, 'snapshot': self.snapshot(), 'changed': False}
        try:
            self.client.update(kind, record_id, fields)
        except TrackerError as error:
            with self.lock:
                self.error = str(error)
                self.missing = error.missing or self.missing
            raise
        self.refresh()
        if self.error:
            raise TrackerError('飞书已收到修改，暂未读回确认；本次修改仍保留。', 502)
        with self.lock:
            row = self._find(kind, record_id)
        if not all(self._same(key, row.get(key), value) for key, value in patch.items()):
            raise TrackerError('写入后读回的值已有变化，请核对后继续编辑。', 409)
        return {'record': row, 'snapshot': self.snapshot(), 'changed': True}

    def _kind(self, body):
        kind = body.get('kind') if isinstance(body, dict) else None
        if kind not in TABLES:
            raise TrackerError('请选择问题或任务。')
        return kind

    def _content(self, value):
        if not isinstance(value, str) or not value.strip():
            raise TrackerError('请填写内容。')
        text = value.strip()
        if len(text) > 2000:
            raise TrackerError('内容过长。')
        return text

    def _note(self, value):
        if value in (None, ''):
            return ''
        if not isinstance(value, str):
            raise TrackerError('备注需要是文字。')
        if len(value) > 2000:
            raise TrackerError('备注过长。')
        return value.strip()

    def _priority(self, value):
        if value in (None, ''):
            return None
        if value not in PRIORITIES:
            raise TrackerError('优先级只能是 P0、P1、P2 或留空。')
        return value

    def _due(self, value):
        if value in (None, ''):
            return None
        if not isinstance(value, str):
            raise TrackerError('截止日期请选年月日，或留空。')
        parsed = date_only(value)
        if parsed is None:
            raise TrackerError('截止日期请选年月日，或留空。')
        return parsed

    def _tag_options(self):
        found = []
        for rows in self.rows.values():
            for row in rows:
                for name in row.get('tags') or []:
                    if name not in found:
                        found.append(name)
        return found

    def _ensure_tags(self, names):
        if not names or all(name in self._tag_options() for name in names):
            return
        for kind, table in TABLES.items():
            if 'tags' in table['fields']:
                self._ensure_kind_tags(kind, names)

    def _ensure_kind_tags(self, kind, names):
        table_id = TABLES[kind]['id']
        field_id = TABLES[kind]['fields']['tags']
        payload = self.client.invoke(['base', '+field-get', '--base-token', BASE_TOKEN, '--table-id', table_id, '--field-id', field_id])
        field = (payload.get('data') or {}).get('field') or payload.get('data') or {}
        options = [dict(item) for item in field.get('options') or [] if isinstance(item, dict) and item.get('name')]
        have = {item['name'] for item in options}
        added = False
        for name in names:
            if name not in have:
                options.append({'name': name})
                have.add(name)
                added = True
        if not added:
            return
        body = json.dumps({'name': '标签', 'type': 'select', 'multiple': True, 'options': options}, ensure_ascii=False)
        self.client.invoke(['base', '+field-update', '--base-token', BASE_TOKEN, '--table-id', table_id, '--field-id', field_id, '--json', body, '--yes'])

    def _tags(self, value):
        if value in (None, '', []):
            return []
        if not isinstance(value, list):
            raise TrackerError('标签需要是一组名称。')
        clean = []
        for item in value:
            if not isinstance(item, str):
                raise TrackerError('标签需要是文字。')
            name = item.strip()
            if not name or len(name) > 16:
                raise TrackerError('标签请用 1 到 16 个字。')
            if name not in clean:
                clean.append(name)
        if len(clean) > 8:
            raise TrackerError('一条记录最多 8 个标签。')
        return clean

    def _same(self, key, current, previous):
        if key == 'status':
            return canonical_status(current) == canonical_status(previous)
        if key == 'archived':
            return bool(current) == bool(previous)
        if key == 'tags':
            return list(current or []) == list(previous or [])
        if key in ('content', 'note'):
            return (current or '') == (previous or '')
        return (current or None) == (previous or None)


def handle_tracker(handler, service, post=False):
    path = handler.path.split('?', 1)[0]
    action = path[len('/api/tracker/'):]
    try:
        if not post:
            if action != 'snapshot':
                raise TrackerError('台账接口不存在。', 404)
            value = service.snapshot() if service.synced_at or service.error else service.refresh()
            handler.send_json(value)
            return
        if action not in ('refresh', 'create', 'update', 'enqueue', 'queue-control'):
            raise TrackerError('台账接口不存在。', 404)
        length = int(handler.headers.get('Content-Length', '0'))
        if not 0 <= length <= 1024 * 1024:
            raise TrackerError('请求过大或为空。')
        raw = handler.rfile.read(length)
        body = json.loads(raw or b'{}')
        if action == 'refresh':
            if body not in ({}, None):
                raise TrackerError('刷新不接受其他参数。')
            handler.send_json(service.refresh())
            return
        if action == 'enqueue':
            handler.send_json(service.enqueue(body), 202)
        elif action == 'queue-control':
            handler.send_json(service.queue_control(body))
        else:
            result = service.create(body) if action == 'create' else service.update(body)
            handler.send_json(result)
    except TrackerError as error:
        payload = {'error': str(error)}
        if error.missing:
            payload['missing_scopes'] = error.missing
        handler.send_json(payload, error.status)
    except (ValueError, TypeError):
        handler.send_json({'error': '台账请求格式不合法。'}, 400)
    except (OSError, sqlite3.Error):
        handler.send_json({'error': '本机台账状态暂不可写。'}, 500)
