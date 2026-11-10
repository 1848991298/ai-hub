import copy
import json
from pathlib import Path
import tempfile
import unittest
from configure_tracker_workflow import configure
from tracker_hub import STATUSES, TrackerError


class SchemaClient:
    def __init__(self, tables):
        self.fields = {}
        self.records = {}
        self.calls = []
        for kind, table in tables.items():
            status = table['fields']['status']
            self.fields[table['id']] = [{'id': status, 'name': '状态', 'type': 'select', 'multiple': False, 'description': '保留说明',
                                        'default_value': ['未启动'], 'options': [{'name': name} for name in ['未启动', '进行中', '已结束']]}]
            self.records[table['id']] = [{'id': 'rec' + kind + 'A', 'cells': {status: ['进行中'], table['fields']['content']: '保留内容'}},
                                        {'id': 'rec' + kind + 'B', 'cells': {status: ['已结束'], table['fields']['note']: '保留备注'}}]

    def invoke(self, args):
        self.calls.append(args)
        command = args[1]
        table = args[args.index('--table-id') + 1]
        fields = self.fields[table]
        if command == '+field-list':
            return {'data': {'fields': copy.deepcopy(fields)}}
        if command == '+field-get':
            field = args[args.index('--field-id') + 1]
            return {'data': {'field': copy.deepcopy(next(item for item in fields if item['id'] == field))}}
        if command == '+field-create':
            body = json.loads(args[args.index('--json') + 1])
            new = {**body, 'id': 'fld' + table + 'archive'}
            fields.append(new)
            return {'data': {'field': copy.deepcopy(new)}}
        if command == '+field-update':
            field = args[args.index('--field-id') + 1]
            body = json.loads(args[args.index('--json') + 1])
            allowed = {item['name'] for item in body['options']}
            # 模拟删除选项会清空仍引用它的记录，确保迁移顺序保护旧值。
            for row in self.records[table]:
                values = row['cells'].get(field)
                if values and values[0] not in allowed:
                    row['cells'][field] = None
            fields[fields.index(next(item for item in fields if item['id'] == field))] = {**body, 'id': field}
            return {'data': {}}
        if command == '+record-list':
            ids = list(dict.fromkeys(key for row in self.records[table] for key in row['cells']))
            return {'data': {'record_id_list': [row['id'] for row in self.records[table]], 'field_id_list': ids,
                             'data': [[row['cells'].get(key) for key in ids] for row in self.records[table]], 'has_more': False}}
        if command == '+record-batch-update':
            updates = json.loads(args[args.index('--json') + 1])['update_records']
            status = next(item['id'] for item in fields if item['name'] == '状态')
            for row in self.records[table]:
                if row['id'] in updates:
                    self.assert_no_other = set(updates[row['id']]) == {'状态'}
                    row['cells'][status] = [updates[row['id']]['状态']]
            return {'data': {}}
        raise AssertionError(command)


class WorkflowMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        local = self.root / '.local'; local.mkdir()
        self.path = local / 'tracker-config.json'
        self.config = {'base_token': 'ExampleBase', 'base_url': 'https://example.feishu.cn/base/ExampleBase',
                       'tables': {kind: {'id': 'tbl' + kind, 'fields': {name: 'fld' + kind + name for name in ('content','status','created','due','priority','note','tags')}} for kind in ('issue','task')}}
        self.path.write_text(json.dumps(self.config))
        self.client = SchemaClient(self.config['tables'])

    def test_check_is_read_only(self):
        result = configure(self.root, client=self.client)
        self.assertFalse(result['applied'])
        self.assertTrue(all(row['legacy_status_records'] == 2 for row in result['tables']))
        self.assertTrue(all(args[1] in ('+field-get', '+field-list', '+record-list') for args in self.client.calls))
        self.assertFalse((self.root / '.local/tracker-workflow-backups').exists())

    def test_migration_keeps_records_and_other_cells_then_removes_legacy_options(self):
        before = copy.deepcopy(self.client.records)
        result = configure(self.root, apply=True, client=self.client)
        self.assertTrue(result['applied'])
        self.assertTrue(self.client.assert_no_other)
        after = json.loads(self.path.read_text())
        for kind, table in self.config['tables'].items():
            self.assertIn('archived', after['tables'][kind]['fields'])
            field = next(item for item in self.client.fields[table['id']] if item['name'] == '状态')
            self.assertEqual([item['name'] for item in field['options']], list(STATUSES))
            self.assertEqual(field['description'], '保留说明')
            rows = self.client.records[table['id']]
            self.assertEqual([row['id'] for row in rows], [row['id'] for row in before[table['id']]])
            self.assertEqual([row['cells'][field['id']] for row in rows], [['开发中'], ['已完成']])
            for row, previous in zip(rows, before[table['id']]):
                for key, value in previous['cells'].items():
                    if key != field['id']:
                        self.assertEqual(row['cells'][key], value)
        self.assertTrue((Path(result['backup']) / 'tables-before.json').is_file())
        creations = sum(args[1] == '+field-create' for args in self.client.calls)
        configure(self.root, apply=True, client=self.client)
        self.assertEqual(sum(args[1] == '+field-create' for args in self.client.calls), creations)

    def test_unrecognized_field_options_stop_before_writes(self):
        self.client.fields['tblissue'][0]['options'].append({'name': '未确认的新状态'})
        with self.assertRaises(TrackerError):
            configure(self.root, apply=True, client=self.client)
        self.assertTrue(all(args[1] in ('+field-get', '+field-list') for args in self.client.calls))

    def test_invalid_archive_type_is_not_converted(self):
        self.client.fields['tblissue'].append({'id': 'fldwrong', 'name': '已归档', 'type': 'text'})
        with self.assertRaises(TrackerError):
            configure(self.root, apply=True, client=self.client)
        self.assertFalse(any(args[1].endswith('update') or args[1].endswith('create') for args in self.client.calls))


if __name__ == '__main__':
    unittest.main()
