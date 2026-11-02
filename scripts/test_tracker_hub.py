#!/usr/bin/env python3
"""台账同步的内存验证：不调用飞书，不改两条真实模拟记录。"""
import tempfile
import unittest
from pathlib import Path
from tracker_hub import TABLES, TrackerError, TrackerService, normalize


class MemoryClient:
    def __init__(self):
        self.rows = {'issue': [], 'task': []}
        self.creates = []
        self.updates = []
        self.fail = None

    def list_kind(self, kind):
        return [dict(row) for row in self.rows[kind]]

    def create(self, kind, fields):
        if self.fail == 'create':
            raise TrackerError('当前授权不能新建飞书记录，缺少 base:record:create。', 403, ['base:record:create'])
        self.creates.append((kind, dict(fields)))
        row = {
            'id': 'rec' + str(len(self.creates)), 'kind': kind, 'content': fields['内容'], 'status': fields['状态'],
            'created_at': '2026-11-01 17:00', 'due': fields['截止时间'][:10] if fields.get('截止时间') else None,
            'priority': fields.get('优先级'), 'note': fields.get('备注') or '',
        }
        self.rows[kind].append(row)
        return row['id']

    def update(self, kind, record_id, fields):
        if self.fail == 'update':
            raise TrackerError('当前授权不能修改飞书记录，缺少 base:record:update。', 403, ['base:record:update'])
        self.updates.append((kind, record_id, dict(fields)))
        for row in self.rows[kind]:
            if row['id'] == record_id:
                if '内容' in fields: row['content'] = fields['内容']
                if '状态' in fields: row['status'] = fields['状态']
                if '优先级' in fields: row['priority'] = fields['优先级']
                if '截止时间' in fields: row['due'] = None if fields['截止时间'] is None else fields['截止时间'][:10]
                if '备注' in fields: row['note'] = fields['备注']
                return
        raise TrackerError('飞书里已经没有这条记录。', 404)


def sample(record_id='recFixtureIssue', due='2026-11-01'):
    return {'id': record_id, 'kind': 'issue', 'content': '模拟问题', 'status': '未启动', 'created_at': '2026-11-01 16:31', 'due': due, 'priority': 'P1', 'note': '模拟'}


class TrackerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.client = MemoryClient()
        self.service = TrackerService(self.client, Path(self.tmp.name))

    def test_real_column_order_does_not_decide_fields(self):
        issue_ids = [TABLES['issue']['fields'][name] for name in ('content','created','status','priority','due','note')]
        issue = ['示例问题内容', '2026-11-01T16:31:54.000+08:00', ['未启动'], ['P1'], '2026-11-02T00:00:00.000+08:00', '模拟']
        row = normalize('issue', issue_ids, 'recFixtureIssue', issue)
        self.assertEqual(row['content'], '示例问题内容')
        self.assertEqual(row['created_at'], '2026-11-01 16:31')
        self.assertEqual(row['due'], '2026-11-02')
        self.assertEqual(row['priority'], 'P1')
        task_ids = [TABLES['task']['fields'][name] for name in ('content','note','status','created','due','priority')]
        task = ['任务内容', '备注文字', ['未启动'], '2026-11-01T16:35:07.000+08:00', None, ['P2']]
        parsed = normalize('task', task_ids, 'recFixtureTask', task)
        self.assertEqual(parsed['note'], '备注文字')
        self.assertIsNone(parsed['due'])
        self.assertEqual(parsed['priority'], 'P2')

    def test_create_defaults_and_empty_due_are_not_invented(self):
        result = self.service.create({'kind': 'task', 'client_request_id': 'abc12345-def', 'content': '  新任务  ', 'priority': '', 'due': ''})
        self.assertEqual(result['record']['status'], '未启动')
        self.assertIsNone(result['record']['due'])
        self.assertIsNone(result['record']['priority'])
        self.assertNotIn('截止时间', self.client.creates[0][1])
        self.assertNotIn('优先级', self.client.creates[0][1])
        self.assertNotIn('创建时间', self.client.creates[0][1])
        self.assertEqual(self.client.creates[0][1]['状态'], '未启动')

    def test_duplicate_submit_does_not_create_again(self):
        body = {'kind': 'issue', 'client_request_id': 'abc12345-def', 'content': '只建一次'}
        self.service.create(body)
        again = self.service.create(body)
        self.assertTrue(again['duplicate'])
        self.assertEqual(len(self.client.creates), 1)
        restarted = TrackerService(self.client, Path(self.tmp.name))
        self.assertTrue(restarted.create(body)['duplicate'])
        self.assertEqual(len(self.client.creates), 1)

    def test_update_sends_only_changed_field_and_keeps_other_cloud_edits(self):
        self.client.rows['issue'] = [sample()]
        self.service.refresh()
        self.client.rows['issue'][0]['note'] = '飞书刚改的备注'
        result = self.service.update({'kind': 'issue', 'record_id': 'recFixtureIssue', 'base': sample(), 'patch': {'status': '进行中'}})
        self.assertEqual(self.client.updates[0][2], {'状态': '进行中'})
        self.assertEqual(result['record']['note'], '飞书刚改的备注')
        self.assertEqual(result['record']['status'], '进行中')

    def test_conflict_and_failed_update_do_not_overwrite_or_drop_input(self):
        self.client.rows['issue'] = [sample()]
        self.client.rows['issue'][0]['status'] = '进行中'
        with self.assertRaises(TrackerError) as conflict:
            self.service.update({'kind': 'issue', 'record_id': 'recFixtureIssue', 'base': sample(), 'patch': {'status': '已结束'}})
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual(self.client.updates, [])
        self.assertEqual(self.client.rows['issue'][0]['status'], '进行中')
        self.client.fail = 'update'
        self.client.rows['issue'][0]['status'] = '未启动'
        with self.assertRaises(TrackerError) as denied:
            self.service.update({'kind': 'issue', 'record_id': 'recFixtureIssue', 'base': sample(), 'patch': {'note': '仍要保存的备注'}})
        self.assertEqual(denied.exception.missing, ['base:record:update'])
        self.assertEqual(self.client.updates, [])
        self.assertEqual(self.service.snapshot()['missing_scopes'], ['base:record:update'])

    def test_past_due_does_not_become_finished_and_bad_values_stop(self):
        self.client.rows['task'] = [dict(sample('recFixtureTask', '2020-01-01'), kind='task', status='未启动')]
        self.service.refresh()
        self.assertEqual(self.service.snapshot()['tasks'][0]['status'], '未启动')
        with self.assertRaises(TrackerError):
            self.service.create({'kind': 'issue', 'client_request_id': 'abc12345-def', 'content': ' ', 'due': '2026-02-31'})
        with self.assertRaises(TrackerError):
            self.service.create({'kind': 'issue', 'client_request_id': 'abc12345-def', 'content': '事项', 'priority': 'P3'})
        self.assertEqual(self.client.creates, [])


if __name__ == '__main__':
    unittest.main()
