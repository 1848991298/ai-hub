import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnSequence, columnWidths, cycleFacet, cycleMode, emptyFilters, fillColumnWidths, filterRecords, fitColumnWidths, knownTags, ledgerColumnDefaults, ledgerColumnLimits, ledgerColumnOrder, moveItem, nextSort, orderedRows, sortRecords, changedFields } from './ledger-model.js';

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

test('列宽允许内容缩到 64 像素，越界仍收回合法范围', () => {
  const widths = columnWidths({ content: 20, note: 1900, status: 120, created: 'wide' });
  assert.equal(widths.content, 64);
  assert.equal(widths.note, 1600);
  assert.equal(widths.status, 120);
  assert.equal(widths.created, ledgerColumnDefaults.created);
});

test('已保存列序剔除无效项并补回新列，拖放可插入到目标列两侧', () => {
  assert.deepEqual(columnSequence(['note', 'missing', 'note']), ['note', ...ledgerColumnOrder.filter(key => key !== 'note')]);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 'a', 'c', true), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 'c', 'b'), ['a', 'c', 'b']);
});

test('主动适配当前窗宽，过窄窗口保留可滚动的列宽', () => {
  const widths = columnWidths();
  const fit = fitColumnWidths(widths, 930);
  assert.ok(Math.abs(Object.values(fit).reduce((sum, width) => sum + width, 0) - 930) < 4);
  assert.ok(ledgerColumnOrder.every(key => fit[key] >= ledgerColumnLimits[key][0]));
  assert.deepEqual(fitColumnWidths(widths, 200), widths);
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
  assert.deepEqual(moveItem(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 'a', 'a'), ['a', 'b']);
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


test('未配置标签字段的六列布局按可见列适配，不丢失隐藏列偏好', () => {
  const keys=ledgerColumnOrder.filter(key => key !== 'tags');
  const fitted=fitColumnWidths(columnWidths(),1100,keys);
  assert.equal(Object.hasOwn(fitted,'tags'),false);
  assert.ok(Math.abs(Object.values(fitted).reduce((a,b)=>a+b,0)-1100)<4);
  assert.ok(columnWidths({...columnWidths(),...fitted}).tags>=44);
});

test('自适应优先扩大正文列，窄窗口保留可读宽度并允许横向滚动', () => {
  const result=fillColumnWidths(1800);
  assert.equal(Object.values(result).reduce((a,b)=>a+b,0),1800);
  assert.equal(result.status,ledgerColumnDefaults.status);
  assert.equal(result.due,ledgerColumnDefaults.due);
  assert.ok(result.content>ledgerColumnDefaults.content);
  assert.ok(result.note>ledgerColumnDefaults.note);
  assert.deepEqual(fillColumnWidths(500),ledgerColumnDefaults);
  const withoutNote=fillColumnWidths(1500,ledgerColumnOrder.filter(k=>k!=='note'));
  assert.equal(Object.values(withoutNote).reduce((a,b)=>a+b,0),1500);
  assert.ok(!Object.hasOwn(withoutNote,'note'));
});
