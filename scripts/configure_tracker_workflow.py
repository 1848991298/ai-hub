#!/usr/bin/env python3
"""只读检查或显式迁移现有飞书台账：四状态和可恢复归档，不删除记录。"""
import argparse
import copy
import json
import os
from datetime import datetime
from pathlib import Path
from tracker_config import load_settings
from tracker_hub import LarkClient, STATUSES, STATUS_ALIASES, TrackerError, choice


def field_data(value):
    data = value.get('data') or {}
    return data.get('field') or data


def field_body(field, options):
    body = {key: copy.deepcopy(field[key]) for key in ('name', 'type', 'multiple', 'description', 'default_value') if key in field}
    body['options'] = options
    if isinstance(body.get('default_value'), list):
        body['default_value'] = [STATUS_ALIASES.get(value, value) for value in body['default_value']]
    return body


def raw_records(client, token, table_id):
    result = []
    offset = 0
    while True:
        data = client.invoke(['base', '+record-list', '--base-token', token, '--table-id', table_id, '--limit', '200', '--offset', str(offset)])['data']
        ids = data.get('field_id_list') or []
        records = data.get('record_id_list') or []
        result.extend({'id': record_id, 'cells': dict(zip(ids, cells))} for record_id, cells in zip(records, data.get('data') or []))
        if not data.get('has_more'):
            return result
        if not records or offset > 10000:
            raise TrackerError('台账分页未完整读取，已停止迁移。')
        offset += len(records)


def configure(root, apply=False, client=None):
    root = Path(root)
    token, url, tables, error = load_settings(root)
    if error:
        raise TrackerError(error)
    client = client or LarkClient()
    plans = []
    known = set(STATUSES) | set(STATUS_ALIASES)
    for kind, table in tables.items():
        field = field_data(client.invoke(['base', '+field-get', '--base-token', token, '--table-id', table['id'], '--field-id', table['fields']['status']]))
        if field.get('type') != 'select' or field.get('multiple') or {option.get('name') for option in field.get('options', [])} - known:
            raise TrackerError('状态字段存在未确认配置，已停止迁移。')
        fields = client.invoke(['base', '+field-list', '--base-token', token, '--table-id', table['id']])['data'].get('fields', [])
        archive = [item for item in fields if item.get('name') == '已归档']
        if len(archive) > 1 or (archive and archive[0].get('type') != 'checkbox'):
            raise TrackerError('已归档字段不是唯一复选框，已停止迁移。')
        rows = raw_records(client, token, table['id'])
        plans.append({'kind': kind, 'table': table, 'status': field, 'archive': archive[0] if archive else None, 'rows': rows,
                      'volatile': [item['id'] for item in fields if item.get('type') in ('updated_at', 'updated_by')],
                      'legacy': sum(choice(row['cells'].get(table['fields']['status'])) in STATUS_ALIASES for row in rows)})
    report = [{'kind': p['kind'], 'records': len(p['rows']), 'legacy_status_records': p['legacy'], 'needs_archive_field': not bool(p['archive'])} for p in plans]
    if not apply:
        return {'applied': False, 'tables': report}
    directory = root / '.local' / 'tracker-workflow-backups' / datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    directory.mkdir(parents=True, mode=0o700)
    config_path = root / '.local/tracker-config.json'
    config = json.loads(config_path.read_text())
    def backup(name, value):
        path = directory / name
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2))
        path.chmod(0o600)
    backup('tracker-config.json', config)
    backup('tables-before.json', plans)
    for plan in plans:
        kind, table = plan['kind'], plan['table']
        current = field_data(client.invoke(['base', '+field-get', '--base-token', token, '--table-id', table['id'], '--field-id', table['fields']['status']]))
        options = copy.deepcopy(current.get('options') or [])
        if {item['name'] for item in options} - known:
            raise TrackerError('迁移期间状态选项已变化，停止后续操作。')
        names = {item['name'] for item in options}
        colors = {'未启动': 'Gray', '开发中': 'Blue', '测试中': 'Orange', '已完成': 'Green'}
        for status in STATUSES:
            if status not in names:
                options.append({'name': status, 'hue': colors[status], 'lightness': 'Lighter'})
        # 先添加新选项并保留旧选项，避免旧值在字段更新时被清空。
        if options != current.get('options'):
            client.invoke(['base', '+field-update', '--base-token', token, '--table-id', table['id'], '--field-id', table['fields']['status'], '--json', json.dumps(field_body(current, options), ensure_ascii=False), '--yes'])
        archive = plan['archive']
        if not archive:
            archive = field_data(client.invoke(['base', '+field-create', '--base-token', token, '--table-id', table['id'], '--json', json.dumps({'name': '已归档', 'type': 'checkbox'}, ensure_ascii=False)]))
        archive_id = archive.get('id')
        if not isinstance(archive_id, str) or not archive_id.startswith('fld'):
            raise TrackerError('归档字段未返回有效编号，停止配置写入。')
        config['tables'][kind]['fields']['archived'] = archive_id
        fresh = raw_records(client, token, table['id'])
        updates = {row['id']: {'状态': STATUS_ALIASES[choice(row['cells'].get(table['fields']['status']))]}
                   for row in fresh if choice(row['cells'].get(table['fields']['status'])) in STATUS_ALIASES}
        if updates:
            items = list(updates.items())
            for offset in range(0, len(items), 200):
                client.invoke(['base', '+record-batch-update', '--base-token', token, '--table-id', table['id'], '--json', json.dumps({'update_records': dict(items[offset:offset + 200])}, ensure_ascii=False)])
        after = raw_records(client, token, table['id'])
        previous = {row['id']: row for row in fresh}
        if {row['id'] for row in after} != set(previous):
            raise TrackerError('迁移期间记录集合发生变化，保留兼容选项并停止后续收口。')
        for row in after:
            old = previous[row['id']]['cells']
            actual = choice(row['cells'].get(table['fields']['status']))
            expected = STATUS_ALIASES.get(choice(old.get(table['fields']['status'])), choice(old.get(table['fields']['status'])))
            if actual != expected:
                raise TrackerError('状态读回与迁移目标不同，保留兼容选项并停止。')
            if any(row['cells'].get(key) != value for key, value in old.items() if key != table['fields']['status'] and key not in plan['volatile']):
                raise TrackerError('迁移期间其他字段发生变化，停止后续收口。')
        current = field_data(client.invoke(['base', '+field-get', '--base-token', token, '--table-id', table['id'], '--field-id', table['fields']['status']]))
        options = current.get('options') or []
        if {item['name'] for item in options} - known:
            raise TrackerError('状态选项已变化，停止后续收口。')
        canonical = [{**next(item for item in options if item['name'] == status)} for status in STATUSES]
        client.invoke(['base', '+field-update', '--base-token', token, '--table-id', table['id'], '--field-id', table['fields']['status'], '--json', json.dumps(field_body(current, canonical), ensure_ascii=False), '--yes'])
        readback = field_data(client.invoke(['base', '+field-get', '--base-token', token, '--table-id', table['id'], '--field-id', table['fields']['status']]))
        if [item['name'] for item in readback.get('options') or []] != list(STATUSES):
            raise TrackerError('四状态字段读回失败，请核对备份。')
        backup(kind + '-after.json', {'status': readback, 'records': raw_records(client, token, table['id'])})
        # 每张表独立保存已完成的绑定；失败后可安全重跑，不重复建字段。
        temp = config_path.with_suffix('.json.tmp')
        temp.write_text(json.dumps(config, ensure_ascii=False, indent=2))
        temp.chmod(0o600)
        temp.replace(config_path)
    return {'applied': True, 'tables': report, 'backup': str(directory)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='明确授权后迁移状态并添加归档字段；默认只读检查')
    args = parser.parse_args()
    root = Path(os.environ.get('AI_HUB_ROOT') or Path(__file__).resolve().parent.parent)
    print(json.dumps(configure(root, apply=args.apply), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
