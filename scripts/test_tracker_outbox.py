"""持久队列、失败隔离、冲突与安全重启；只使用临时目录和内存飞书。"""
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch
from tracker_hub import TABLES, TrackerError, TrackerService, text_cell
from test_tracker_hub import MemoryClient, sample


def op(record_id='recFixtureIssue', change=None, baseline=None, job_id=None):
    return {'operation': 'update', 'kind': 'issue', 'record_id': record_id,
            'client_operation_id': job_id or str(uuid.uuid4()), 'base': baseline or sample(record_id),
            'patch': change or {'status': '测试中'}}

PNG = b'\x89PNG\r\n\x1a\nfixture'


class AttachmentClient(MemoryClient):
    def __init__(self):
        super().__init__()
        self.uploads = []
        self.images = {}
        self.fail_once = set()
        self.lose_reply_once = set()

    def attachments(self, kind, record_id):
        return [dict(item) for item in next(row for row in self.rows[kind] if row['id'] == record_id).get('attachments', [])]

    def append_image(self, kind, record_id, path):
        name = path.name.split('-', 1)[0]
        self.uploads.append(name)
        if name in self.fail_once:
            self.fail_once.remove(name)
            raise TrackerError('上传中断', 502)
        row = next(row for row in self.rows[kind] if row['id'] == record_id)
        token = 'image' + str(len(self.uploads))
        row.setdefault('attachments', []).append({'file_token': token, 'name': path.name, 'type': 'image/png'})
        self.images[token] = path.read_bytes()
        if name in self.lose_reply_once:
            self.lose_reply_once.remove(name)
            raise TrackerError('响应超时', 504, uncertain=True)

    def download_image(self, kind, record_id, file_token, path):
        path.write_bytes(self.images[file_token])


class OutboxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.client = MemoryClient()
        self.client.rows['issue'] = [sample()]
        self.service = TrackerService(self.client, self.root, queue_autostart=False)
        self.service.refresh()

    def drain(self):
        for _ in range(30):
            if not self.service.process_next():
                return
        self.fail('队列没有结束')

    def test_acceptance_never_waits_for_cloud_and_overlay_survives_refresh(self):
        body = op()
        with patch.object(self.client, 'update', side_effect=AssertionError('不应在入队调用飞书')):
            result = self.service.enqueue(body)
        self.assertTrue(result['accepted'])
        self.assertEqual(result['snapshot']['issues'][0]['status'], '测试中')
        self.assertEqual(self.client.rows['issue'][0]['status'], '未启动')
        self.assertEqual(self.service.refresh()['issues'][0]['status'], '测试中')
        self.drain()
        self.assertEqual(self.service.snapshot()['sync']['pending'], 0)
        self.assertEqual(self.client.rows['issue'][0]['status'], '测试中')

    def test_image_retry_survives_restart_without_recreating_or_reuploading(self):
        client = AttachmentClient()
        client.fail_once.add('retry')
        client.lose_reply_once.add('readback')
        service = TrackerService(client, self.root, queue_autostart=False)
        image_ids = [str(uuid.uuid4()) for _ in range(3)]
        for image_id, name in zip(image_ids, ('done.png', 'retry.png', 'readback.png')):
            service.stage_image(image_id, name, PNG)
        fields = {**TABLES['task']['fields'], 'attachments':'fldFixtureImages'}
        with patch.dict(TABLES['task'], {'fields':fields}):
            queued = service.enqueue({'operation':'create', 'kind':'task', 'content':'附图\n下一行',
                                      'client_operation_id':str(uuid.uuid4()), 'image_ids':image_ids})
            self.assertEqual(queued['snapshot']['tasks'][0]['pending_images'], 3)
            self.assertFalse(client.creates)
            service.process_next()
            failure = service.snapshot()['sync']['jobs'][0]
            self.assertTrue(failure['text_synced'])
            self.assertEqual(failure['pending_images'], 2)
            self.assertIn('文字已同步', failure['error'])
            restarted = TrackerService(client, self.root, queue_autostart=False)
            restarted.queue_control({'operation':'retry', 'job_id':failure['id']})
            restarted.process_next()
            row = restarted.snapshot()['tasks'][0]
            self.assertEqual(len(client.creates), 1)
            self.assertEqual(client.uploads, ['done','retry','readback','retry'])
            self.assertEqual(len(row['attachments']), 3)
            self.assertEqual(row['content'], '附图\n下一行')
            token = row['attachments'][0]['file_token']
            self.assertEqual(restarted.preview_image('task', row['id'], token), ('image/png', PNG))
            with self.assertRaises(TrackerError):
                restarted.preview_image('task', row['id'], 'other')
            self.assertEqual(restarted.snapshot()['sync']['failed'], 0)

    def test_image_only_update_avoids_text_writes_and_caches_long_text(self):
        client = AttachmentClient()
        client.rows['issue'] = [sample()]
        service = TrackerService(client, self.root, queue_autostart=False)
        service.refresh()
        image_id = str(uuid.uuid4())
        service.stage_image(image_id, 'screenshot.png', PNG)
        body = {**op(), 'patch':{}, 'image_ids':[image_id]}
        fields = {**TABLES['issue']['fields'], 'attachments':'fldFixtureImages'}
        with patch.dict(TABLES['issue'], {'fields':fields}):
            service.enqueue(body)
            service.process_next()
        self.assertFalse(client.updates)
        self.assertEqual(len(service.snapshot()['issues'][0]['attachments']), 1)
        self.assertEqual(text_cell([{'text':'原文\n'}, {'text':'下一行 '}, {'link':'https://example.com'}]),
                         '原文\n下一行 https://example.com')

    def test_worker_does_not_hold_http_snapshot_lock_during_slow_cloud(self):
        entered, release = threading.Event(), threading.Event()
        original = self.client.update
        def delayed(*args):
            entered.set()
            release.wait(3)
            return original(*args)
        self.service._queue_autostart = True
        with patch.object(self.client, 'update', side_effect=delayed):
            start = time.monotonic()
            self.service.enqueue(op())
            self.assertLess(time.monotonic() - start, .5)
            self.assertTrue(entered.wait(1))
            start = time.monotonic()
            self.assertEqual(self.service.snapshot()['sync']['pending'], 1)
            self.assertLess(time.monotonic() - start, .5)
            release.set()
            self.service.stop()
        if self.service._queue_thread:
            self.service._queue_thread.join(2)

    def test_job_and_cloud_cache_survive_restart_without_duplicate_enqueue(self):
        body = op()
        self.service.enqueue(body)
        restarted = TrackerService(self.client, self.root, queue_autostart=False)
        self.assertEqual(restarted.snapshot()['issues'][0]['status'], '测试中')
        restarted.enqueue(body)
        self.assertEqual(len(restarted.outbox.jobs()), 1)
        restarted.process_next()
        self.assertEqual(len(self.client.updates), 1)

    def test_batch_local_transaction_is_atomic_for_duplicate_id_conflict(self):
        a = op()
        b = op(change={'status': '已完成'}, job_id=a['client_operation_id'])
        with self.assertRaises(TrackerError):
            self.service.enqueue({'operations': [a, b]})
        self.assertEqual(self.service.snapshot()['sync']['pending'], 0)

    def test_conflict_does_not_overwrite_cloud_and_draft_is_retained(self):
        self.service.enqueue(op())
        self.client.rows['issue'][0]['status'] = '开发中'
        self.drain()
        s = self.service.snapshot()
        self.assertEqual(s['sync']['failed'], 1)
        job = s['sync']['jobs'][0]
        self.assertEqual(job['status'], 409)
        self.assertEqual(job['draft']['status'], '测试中')
        self.assertEqual(job['cloud_record']['status'], '开发中')
        self.assertFalse(self.client.updates)

    def test_failed_first_job_holds_later_same_record_but_not_other_record(self):
        self.client.rows['issue'].append(sample('recOther'))
        a = op()
        self.service.enqueue(a)
        self.client.fail = 'update'
        self.service.process_next()
        self.client.fail = None
        self.service.enqueue(op(change={'note': '后续修改'}, baseline={**sample(), 'status': '测试中'}))
        self.service.enqueue(op('recOther'))
        self.service.process_next()
        self.assertEqual(self.client.rows['issue'][1]['status'], '测试中')
        self.assertFalse(self.service.process_next())
        self.service.queue_control({'operation': 'retry', 'job_id': a['client_operation_id']})
        self.drain()
        self.assertEqual(self.client.rows['issue'][0]['note'], '后续修改')
        self.assertEqual(self.service.snapshot()['sync']['failed'], 0)

    def test_failed_edit_can_be_reviewed_and_superseded(self):
        a = op()
        self.service.enqueue(a)
        self.client.rows['issue'][0]['status'] = '开发中'
        self.drain()
        reviewed = op(baseline={**sample(), 'status': '开发中'})
        self.service.enqueue({**reviewed, 'supersedes': a['client_operation_id']})
        self.drain()
        self.assertEqual(self.client.rows['issue'][0]['status'], '测试中')
        self.assertEqual(self.service.snapshot()['sync']['failed'], 0)

    def test_discard_restores_cloud_view_without_deleting_records(self):
        body = op()
        self.service.enqueue(body)
        self.service.queue_control({'operation': 'discard', 'job_id': body['client_operation_id']})
        self.assertEqual(self.service.snapshot()['issues'][0]['status'], '未启动')
        self.assertEqual(len(self.client.rows['issue']), 1)
        self.assertFalse(self.service.process_next())

    def test_archive_and_restore_are_sequential_and_preserve_all_other_fields(self):
        fields = {**TABLES['issue']['fields'], 'archived': 'fldFixtureArchive'}
        with patch.dict(TABLES['issue'], {'fields': fields}):
            self.service.enqueue(op(change={'archived': True}))
            self.service.enqueue(op(change={'archived': False}, baseline={**sample(), 'archived': True}))
            self.drain()
            self.assertFalse(self.client.rows['issue'][0]['archived'])
            self.assertEqual(self.client.rows['issue'][0]['content'], sample()['content'])
            self.assertEqual(self.client.rows['issue'][0]['status'], '未启动')

    def test_completed_remote_update_reconciles_after_restart_without_second_write(self):
        body = op()
        self.service.enqueue(body)
        claimed = self.service.outbox.claim()
        self.client.update('issue', body['record_id'], {'状态': '测试中'})
        restarted = TrackerService(self.client, self.root, queue_autostart=False)
        restarted.process_next()
        self.assertEqual(len(self.client.updates), 1)
        self.assertEqual(restarted.snapshot()['sync']['pending'], 0)

    def test_interrupted_create_is_not_blindly_replayed(self):
        body = {'operation': 'create', 'kind': 'task', 'client_operation_id': str(uuid.uuid4()), 'content': '新任务'}
        self.service.enqueue(body)
        self.service.outbox.claim()
        restarted = TrackerService(self.client, self.root, queue_autostart=False)
        self.assertFalse(restarted.process_next())
        job = restarted.snapshot()['sync']['jobs'][0]
        self.assertEqual(job['state'], 'uncertain')
        self.assertFalse(self.client.creates)
        with self.assertRaises(TrackerError):
            restarted.queue_control({'operation': 'retry', 'job_id': job['id']})
        new = {**body, 'client_operation_id': str(uuid.uuid4()), 'supersedes': job['id']}
        with self.assertRaises(TrackerError):
            restarted.enqueue(new)
        restarted.enqueue({**new, 'confirmed_not_created': True})
        restarted.process_next()
        self.assertEqual(len(self.client.creates), 1)

    def test_create_idempotency_known_record_is_reconciled_after_interruption(self):
        body = {'operation': 'create', 'kind': 'task', 'client_operation_id': str(uuid.uuid4()), 'content': '新任务'}
        self.service.enqueue(body)
        job = self.service.outbox.claim()
        self.service.create(job['payload']['body'])
        restarted = TrackerService(self.client, self.root, queue_autostart=False)
        restarted.process_next()
        self.assertEqual(len(self.client.creates), 1)
        self.assertEqual(restarted.snapshot()['sync']['failed'], 0)

    def test_invalid_batch_is_rejected_before_any_durable_item(self):
        for bad in [{'status': 'unknown'}, {'created_at': '2026-01-01'}, {'archived': 'true'}]:
            with self.assertRaises(TrackerError):
                self.service.enqueue({'operations': [op(), op(change=bad)]})
            self.assertEqual(self.service.snapshot()['sync']['pending'], 0)

    def test_task_category_default_bulk_conflict_and_legacy_edit(self):
        fields = {**TABLES['task']['fields'], 'category': 'fldFixtureCategory'}
        with patch.dict(TABLES['task'], {'fields': fields}):
            create = {'operation': 'create', 'kind': 'task', 'client_operation_id': str(uuid.uuid4()), 'content': '新需求'}
            self.service.enqueue(create)
            job = self.service.outbox.jobs()[0]
            self.assertEqual(job['payload']['body']['category'], '需求')
            self.service.process_next()
            row = self.client.rows['task'][0]
            self.assertEqual(row['category'], '需求')
            self.service.update({'kind':'task','record_id':row['id'],'base':dict(row),'patch':{'category':'优化'}})
            self.assertEqual(self.client.updates[-1][2], {'类型':'优化'})
            legacy = dict(sample('recLegacy'), kind='task', category=None)
            self.client.rows['task'].append(legacy)
            self.service.update({'kind':'task','record_id':legacy['id'],'base':dict(legacy),'patch':{'note':'保留未分类'}})
            self.assertIsNone(legacy['category'])
            self.assertEqual(self.client.updates[-1][2], {'备注':'保留未分类'})
            base = dict(row)
            row['category'] = '需求'
            with self.assertRaises(TrackerError) as caught:
                self.service.update({'kind':'task','record_id':row['id'],'base':base,'patch':{'category':'优化','note':'本次说明'}})
            self.assertEqual(caught.exception.status, 409)

    def test_category_requires_task_binding_and_one_of_two_choices(self):
        fields = {**TABLES['task']['fields'], 'category': 'fldFixtureCategory'}
        with patch.dict(TABLES['task'], {'fields': fields}):
            for value in ('修复', '', None):
                with self.assertRaises(TrackerError):
                    self.service._clean_patch('task', {'category':value})
            with self.assertRaises(TrackerError):
                self.service._clean_patch('issue', {'category':'需求'})
        with patch.dict(TABLES['task'], {'fields': {key:value for key,value in fields.items() if key != 'category'}}):
            with self.assertRaises(TrackerError):
                self.service._clean_patch('task', {'category':'需求'})

    def test_generic_error_never_exposes_exception_secrets(self):
        self.service.enqueue(op())
        with patch.object(self.client, 'update', side_effect=RuntimeError('fixture-private-secret')):
            self.drain()
        self.assertNotIn('fixture-private-secret', json.dumps(self.service.snapshot()))


if __name__ == '__main__':
    unittest.main()
