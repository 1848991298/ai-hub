import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnWidths, cycleFacet, cycleMode, emptyFilters, filterRecords, knownTags, ledgerColumnDefaults, moveRow, nextSort, orderedRows, sortRecords, changedFields } from './ledger-model.js';

const rows = [
  { id: 'a', content: '过期未结束', status: '未启动', priority: 'P1', due: '2026-10-01', created_at: '2026-10-01 09:00', note: '' },
  { id: 'b', content: '无日期', status: '已结束', priority: null, due: null, created_at: '2026-11-01 10:00', note: '' },
  { id: 'c', content: '紧急', status: '进行中', priority: 'P0', due: '2026-11-08', created_at: '2026-11-01 08:00', note: '' },
];

test('纳入和排除可叠加，过期筛选不改状态', () => {
  const filters = { ...emptyFilters(), status: { '未启动': 'include' }, overdue: 'include' };
  assert.deepEqual(filterRecords(rows, filters, '2026-11-01').map(row => row.id), ['a']);
  assert.equal(rows[0].status, '未启动');
  const ended = { ...emptyFilters(), status: { '已结束': 'include' } };
  assert.deepEqual(filterRecords(rows, ended, '2026-11-01').map(row => row.id), ['b']);
  const excludeDone = { ...emptyFilters(), status: { '已结束': 'exclude' } };
  assert.deepEqual(filterRecords(rows, excludeDone, '2026-11-01').map(row => row.id), ['a', 'c']);
  const notOverdue = { ...emptyFilters(), overdue: 'exclude' };
  assert.deepEqual(filterRecords(rows, notOverdue, '2026-11-01').map(row => row.id), ['b', 'c']);
});

test('同一项按纳入、排除、清除循环', () => {
  assert.equal(cycleMode(null), 'include');
  assert.equal(cycleMode('include'), 'exclude');
  assert.equal(cycleMode('exclude'), null);
  const once = cycleFacet({}, 'P0');
  const twice = cycleFacet(once, 'P0');
  const thrice = cycleFacet(twice, 'P0');
  assert.equal(once.P0, 'include');
  assert.equal(twice.P0, 'exclude');
  assert.equal(thrice.P0, undefined);
});

test('表头排序可升降，空日期和空优先级留在后面', () => {
  assert.deepEqual(sortRecords(rows, { key: 'priority', dir: 'asc' }).map(row => row.id), ['c', 'a', 'b']);
  assert.deepEqual(sortRecords(rows, { key: 'priority', dir: 'desc' }).map(row => row.id), ['a', 'c', 'b']);
  assert.deepEqual(sortRecords(rows, { key: 'due', dir: 'asc' }).map(row => row.id), ['a', 'c', 'b']);
  assert.deepEqual(sortRecords(rows, { key: 'due', dir: 'desc' }).map(row => row.id), ['c', 'a', 'b']);
  assert.deepEqual(nextSort({ key: 'due', dir: 'asc' }, 'due'), { key: 'due', dir: 'desc' });
  assert.deepEqual(nextSort({ key: 'due', dir: 'asc' }, 'created'), { key: 'created', dir: 'desc' });
});

test('已结束默认沉底，关掉后回到表头排序', () => {
  const mixed = [
    ...rows,
    { id: 'd', content: '已结束但截止日期更晚', status: '已结束', priority: 'P0', due: '2026-12-01', created_at: '2026-11-02 09:00', note: '' },
  ];
  assert.deepEqual(sortRecords(mixed, { key: 'due', dir: 'desc' }).map(row => row.id), ['c', 'a', 'd', 'b']);
  assert.deepEqual(sortRecords(mixed, { key: 'due', dir: 'desc' }, false).map(row => row.id), ['d', 'c', 'a', 'b']);
  assert.deepEqual(sortRecords(mixed, { key: 'status', dir: 'desc' }).map(row => row.status).slice(-2), ['已结束', '已结束']);
});

test('列宽记住合法值，越界收回默认范围内', () => {
  const widths = columnWidths({ content: 20, note: 900, status: 120, created: 'wide' });
  assert.equal(widths.content, 160);
  assert.equal(widths.note, 560);
  assert.equal(widths.status, 120);
  assert.equal(widths.created, ledgerColumnDefaults.created);
});

test('标签纳入要同时具备，排除掉带有该标签的记录', () => {
  const tagged = [
    { id: 'a', status: '未启动', priority: 'P1', due: '2026-11-08', tags: ['充电仓', 'TSDB'] },
    { id: 'b', status: '未启动', priority: 'P1', due: '2026-11-08', tags: ['充电仓'] },
    { id: 'c', status: '进行中', priority: 'P0', due: '2026-11-08', tags: ['安卓'] },
  ];
  const both = { ...emptyFilters(), tags: { '充电仓': 'include', TSDB: 'include' } };
  assert.deepEqual(filterRecords(tagged, both, '2026-11-01').map(row => row.id), ['a']);
  const hide = { ...emptyFilters(), tags: { '充电仓': 'exclude' } };
  assert.deepEqual(filterRecords(tagged, hide, '2026-11-01').map(row => row.id), ['c']);
});

test('手动顺序优先，新记录排在已排过的后面', () => {
  const rows = [{ id: 'a', created_at: '2026-11-01' }, { id: 'b', created_at: '2026-11-02' }, { id: 'c', created_at: '2026-11-03' }];
  assert.deepEqual(orderedRows(rows, ['c', 'a']).map(row => row.id), ['c', 'a', 'b']);
  assert.deepEqual(moveRow(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveRow(['a', 'b'], 'a', 'a'), ['a', 'b']);
});

test('已有标签合并选项和问题、任务上的标签，并去掉重复', () => {
  const tags = knownTags({
    tag_options: ['充电仓', ''],
    issues: [{ tags: ['充电仓', 'TSDB'] }, { tags: null }],
    tasks: [{ tags: ['安卓', 'TSDB'] }, {}],
  });
  assert.deepEqual(tags, ['充电仓', 'TSDB', '安卓']);
  assert.deepEqual(knownTags(null), []);
  assert.deepEqual(knownTags({ issues: [{ tags: ['  ', 1] }] }), []);
});

test('只提交改动字段，未改表单不会被刷新覆盖', () => {
  const base = { content: '事项', status: '未启动', due: '', priority: 'P2', note: '原备注' };
  const editing = { ...base, note: '正在写' };
  assert.deepEqual(changedFields(base, editing), { note: '正在写' });
  assert.deepEqual(changedFields({ ...base, tags: ['充电仓'] }, { ...base, tags: ['充电仓', 'TSDB'] }), { tags: ['充电仓', 'TSDB'] });
  assert.deepEqual(changedFields(base, base), {});
  assert.equal(editing.note, '正在写');
});
