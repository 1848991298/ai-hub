#!/usr/bin/env python3
"""为任务表添加需求／优化单选字段；默认只读，不修改历史记录。"""
import argparse
import copy
import json
import os
from datetime import datetime
from pathlib import Path
from tracker_config import load_settings
from tracker_hub import CATEGORIES, LarkClient, TrackerError
from configure_tracker_workflow import field_data, raw_records


def configure(root, apply=False, client=None):
    root = Path(root)
    token, _, tables, error = load_settings(root)
    if error:
        raise TrackerError(error)
    client = client or LarkClient()
    table = tables['task']
    fields = client.invoke(['base', '+field-list', '--base-token', token, '--table-id', table['id']])['data'].get('fields', [])
    matches = [field for field in fields if field.get('name') == '类型']
    if len(matches) > 1:
        raise TrackerError('任务表存在多个类型字段，请先核对。')
    field = None
    if matches:
        field = field_data(client.invoke(['base', '+field-get', '--base-token', token, '--table-id', table['id'], '--field-id', matches[0]['id']]))
        if field.get('type') != 'select' or field.get('multiple') or {item.get('name') for item in field.get('options') or []} - set(CATEGORIES):
            raise TrackerError('现有类型字段不是需求／优化单选，已停止配置。')
    configured = table['fields'].get('category')
    if configured and (not field or configured != field.get('id')):
        raise TrackerError('现有类型绑定与字段不同，已停止配置。')
    before = raw_records(client, token, table['id'])
    report = {'applied': False, 'records': len(before), 'needs_field': not bool(field), 'options': list(CATEGORIES), 'historical_records_updated': 0}
    if not apply:
        return report
    directory = root / '.local/tracker-type-backups' / datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    directory.mkdir(parents=True, mode=0o700)
    config_path = root / '.local/tracker-config.json'
    config = json.loads(config_path.read_text())
    for name, value in [('tracker-config.json', config), ('task-before.json', {'fields': fields, 'type': field, 'records': before})]:
        path = directory / name
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2)); path.chmod(0o600)
    options = [{'name': name} for name in CATEGORIES]
    if not field:
        field = field_data(client.invoke(['base', '+field-create', '--base-token', token, '--table-id', table['id'], '--json', json.dumps({'name': '类型', 'type': 'select', 'multiple': False, 'options': options}, ensure_ascii=False)]))
    elif {item['name'] for item in field.get('options') or []} != set(CATEGORIES):
        body = {key: copy.deepcopy(field[key]) for key in ('name', 'type', 'multiple', 'description', 'default_value') if key in field}
        body['options'] = copy.deepcopy(field.get('options') or [])
        body['options'] += [item for item in options if item['name'] not in {old['name'] for old in body['options']}]
        client.invoke(['base', '+field-update', '--base-token', token, '--table-id', table['id'], '--field-id', field['id'], '--json', json.dumps(body, ensure_ascii=False), '--yes'])
    field_id = field.get('id')
    if not isinstance(field_id, str) or not field_id.startswith('fld'):
        raise TrackerError('类型字段未返回有效编号，未写入本机绑定。')
    readback = field_data(client.invoke(['base', '+field-get', '--base-token', token, '--table-id', table['id'], '--field-id', field_id]))
    if readback.get('type') != 'select' or readback.get('multiple') or {item['name'] for item in readback.get('options') or []} != set(CATEGORIES):
        raise TrackerError('类型字段读回不一致，未写入本机绑定。')
    after = raw_records(client, token, table['id'])
    previous = {row['id']: row['cells'] for row in before}
    volatile = {item['id'] for item in fields if item.get('type') in ('updated_at', 'updated_by')}
    if {row['id'] for row in after} != set(previous) or any(row['cells'].get(key) != value for row in after for key, value in previous.get(row['id'], {}).items() if key not in volatile):
        raise TrackerError('配置期间历史记录发生变化，已保留备份，请核对后重试。')
    config['tables']['task']['fields']['category'] = field_id
    temp = config_path.with_suffix('.json.tmp')
    temp.write_text(json.dumps(config, ensure_ascii=False, indent=2)); temp.chmod(0o600); temp.replace(config_path)
    report.update(applied=True, backup=str(directory))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='添加并绑定类型字段；不批量修改历史记录')
    args = parser.parse_args()
    root = Path(os.environ.get('AI_HUB_ROOT') or Path(__file__).resolve().parent.parent)
    print(json.dumps(configure(root, args.apply), ensure_ascii=False, indent=2))
