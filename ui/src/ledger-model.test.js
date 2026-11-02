import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterRecords, sortRecords, changedFields } from './ledger-model.js';

const rows = [
  { id: 'a', content: '过期未结束', status: '未启动', priority: 'P1', due: '2026-10-01', created_at: '2026-10-01 09:00', note: '' },
  { id: 'b', content: '无日期', status: '已结束', priority: null, due: null, created_at: '2026-11-01 10:00', note: '' },
  { id: 'c', content: '紧急', status: '进行中', priority: 'P0', due: '2026-11-08', created_at: '2026-11-01 08:00', note: '' },
];

test('筛选不把过期改成已结束，结束项仍可按状态看到', () => {
  assert.deepEqual(filterRecords(rows, { status: 'all', priority: 'all', due: 'past' }, '2026-11-01').map(row => row.id), ['a']);
  assert.equal(rows[0].status, '未启动');
  assert.deepEqual(filterRecords(rows, { status: '已结束', priority: 'all', due: 'all' }, '2026-11-01').map(row => row.id), ['b']);
  assert.deepEqual(filterRecords(rows, { status: 'all', priority: 'none', due: 'empty' }, '2026-11-01').map(row => row.id), ['b']);
});

test('排序按优先级或截止日期，空日期在后', () => {
  assert.deepEqual(sortRecords(rows, 'priority').map(row => row.id), ['c', 'a', 'b']);
  assert.deepEqual(sortRecords(rows, 'due').map(row => row.id), ['a', 'c', 'b']);
});

test('只提交改动字段，未改表单不会被刷新覆盖', () => {
  const base = { content: '事项', status: '未启动', due: '', priority: 'P2', note: '原备注' };
  const editing = { ...base, note: '正在写' };
  assert.deepEqual(changedFields(base, editing), { note: '正在写' });
  assert.deepEqual(changedFields(base, base), {});
  assert.equal(editing.note, '正在写');
});
