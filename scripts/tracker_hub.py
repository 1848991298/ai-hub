#!/usr/bin/env python3
"""问题与任务台账：飞书多维表格是主数据，Hub 服务存活期间轮询并写回。"""
import json
import os
from datetime import datetime
from pathlib import Path
import subprocess
import threading
from zoneinfo import ZoneInfo

from tracker_config import load_settings

BASE_TOKEN, BASE_URL, TABLES, CONFIG_ERROR = load_settings(
    Path(os.environ.get('AI_HUB_ROOT') or Path(__file__).resolve().parent.parent)
)
INTERVAL = 30
ZONE = ZoneInfo('Asia/Shanghai')
STATUSES = ('未启动', '进行中', '已结束')
PRIORITIES = ('P0', 'P1', 'P2')
NAMES = {'content': '内容', 'status': '状态', 'due': '截止时间', 'priority': '优先级', 'note': '备注', 'tags': '标签'}
EDITABLE = ('content', 'status', 'due', 'priority', 'note', 'tags')


class TrackerError(Exception):
    def __init__(self, message, status=400, missing=None):
        super().__init__(message)
        self.status = status
        self.missing = list(missing or [])


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
    status = choice(by_id[expected['status']])
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
    }


class LarkClient:
    def __init__(self, runner=None):
        self.runner = runner or subprocess.run

    def invoke(self, args):
        if not BASE_TOKEN:
            raise TrackerError(CONFIG_ERROR or '请先配置本机 tracker-config.json。', 503)
        completed = self.runner(
            ['lark-cli', *args, '--as', 'user', '--format', 'json'],
            capture_output=True, text=True, timeout=45,
        )
        raw = (completed.stdout or completed.stderr or '').strip()
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError as error:
            raise TrackerError('飞书没有返回可识别的结果。', 502) from error
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
            raise TrackerError('飞书已收到新建请求，但没有返回唯一记录编号。请先刷新，不要重复提交。', 502)
        return ids[0]

    def update(self, kind, record_id, fields):
        self.invoke([
            'base', '+record-batch-update', '--base-token', BASE_TOKEN, '--table-id', TABLES[kind]['id'],
            '--json', json.dumps({'update_records': {record_id: fields}}, ensure_ascii=False),
        ])


class TrackerService:
    def __init__(self, client=None, root=None):
        self.client = client or LarkClient()
        self.root = Path(root or os.environ.get('AI_HUB_ROOT') or Path(__file__).resolve().parent.parent)
        self.lock = threading.Lock()
        self.rows = {'issue': [], 'task': []}
        self.synced_at = None
        self.error = None
        self.missing = []
        self.polling = False
        self._stop = threading.Event()
        self._thread = None
        self._inflight = set()
        self._seen = self._load_seen()

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
        items = list(self._seen.items())[-100:]
        self._seen = dict(items)
        path = directory / 'tracker-idempotency.json'
        temporary = path.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(self._seen, ensure_ascii=False))
        temporary.replace(path)

    def snapshot(self):
        with self.lock:
            return {
                'base_url': BASE_URL,
                'interval_seconds': INTERVAL,
                'synced_at': self.synced_at,
                'error': self.error,
                'missing_scopes': list(self.missing),
                'polling': self.polling,
                'mode': 'poll',
                'delay': f'服务运行期间约每 {INTERVAL} 秒拉取一次；打开页面和手动刷新会立即读飞书。不是即时推送。',
                'boundary': '退出 AI Hub 或本地服务后停止同步，下次打开再补拉。截止时间到期不会把状态改成已结束。',
                'status_options': list(STATUSES),
                'priority_options': list(PRIORITIES),
                'tag_options': self._tag_options(),
                'tag_fields': {kind: 'tags' in table['fields'] for kind, table in TABLES.items()},
                'issues': [dict(row) for row in self.rows['issue']],
                'tasks': [dict(row) for row in self.rows['task']],
            }

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

    def stop(self):
        self._stop.set()
        thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=2)
        with self.lock:
            self.polling = False

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
        kind = self._kind(body)
        request_id = body.get('client_request_id')
        if not isinstance(request_id, str) or not 8 <= len(request_id) <= 64 or any(ch not in '0123456789abcdef-' for ch in request_id):
            raise TrackerError('缺少本次提交编号，请重新打开表单后再保存。')
        content = self._content(body.get('content'))
        status = body.get('status') or '未启动'
        if status not in STATUSES:
            raise TrackerError('状态只能是未启动、进行中或已结束。')
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
        with self.lock:
            row = next((item for item in self.rows[kind] if item['id'] == record_id), None)
        if not row:
            row = {'id': record_id, 'kind': kind, 'content': content, 'status': status, 'created_at': None, 'due': due, 'priority': priority, 'note': note or '', 'tags': tags}
        return {'record': row, 'snapshot': self.snapshot(), 'duplicate': False}

    def update(self, body):
        kind = self._kind(body)
        record_id = body.get('record_id')
        if not isinstance(record_id, str) or not record_id.startswith('rec'):
            raise TrackerError('缺少要修改的飞书记录。')
        baseline = body.get('base')
        patch = body.get('patch')
        if not isinstance(baseline, dict) or not isinstance(patch, dict) or not patch:
            raise TrackerError('没有可保存的修改。')
        unknown = set(patch) - set(EDITABLE)
        if unknown or 'created_at' in patch:
            raise TrackerError('创建时间不能修改，也只能改内容、状态、截止时间、优先级、备注和标签。')
        self.refresh()
        with self.lock:
            current = self._find(kind, record_id)
        for key in patch:
            if self._same(key, current.get(key), baseline.get(key)):
                continue
            raise TrackerError('这条记录在飞书已有新修改，本次未覆盖。请看列表里的新值后再保存。', 409)
        fields = {}
        for key, value in patch.items():
            if key == 'content':
                fields['内容'] = self._content(value)
            elif key == 'status':
                if value not in STATUSES:
                    raise TrackerError('状态只能是未启动、进行中或已结束。')
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
        with self.lock:
            row = self._find(kind, record_id)
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
        if action not in ('refresh', 'create', 'update'):
            raise TrackerError('台账接口不存在。', 404)
        length = int(handler.headers.get('Content-Length', '0'))
        if not 0 <= length <= 32 * 1024:
            raise TrackerError('请求过大或为空。')
        raw = handler.rfile.read(length)
        body = json.loads(raw or b'{}')
        if action == 'refresh':
            if body not in ({}, None):
                raise TrackerError('刷新不接受其他参数。')
            handler.send_json(service.refresh())
            return
        result = service.create(body) if action == 'create' else service.update(body)
        handler.send_json(result)
    except TrackerError as error:
        payload = {'error': str(error)}
        if error.missing:
            payload['missing_scopes'] = error.missing
        handler.send_json(payload, error.status)
    except (ValueError, TypeError):
        handler.send_json({'error': '台账请求格式不合法。'}, 400)
    except OSError:
        handler.send_json({'error': '本机台账状态暂不可写。'}, 500)
