import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, calendarPoints, changeRatio } from './market-board.js';

const points = [
  { date: '2026-10-04', total: 0, parts: { xiaomi: 0 } },
  { date: '2026-10-22', total: 1, parts: { vivo: 1, xiaomi: 0 } },
  { date: '2026-10-29', total: 6819, parts: { oppo: 930, tencent: 90, vivo: 597, xiaomi: 5202 } },
  { date: '2026-10-30', total: 2462, parts: { honor: 38, oppo: 339, tencent: 43, vivo: 213, xiaomi: 1829 } },
  { date: '2026-10-31', total: 615, parts: { honor: 20, oppo: 86, tencent: 10, vivo: 60, xiaomi: 439 } },
  { date: '2026-11-01', total: 319, parts: { honor: 12, oppo: 53, tencent: 3, vivo: 33, xiaomi: 218 } },
];

test('上期没有正数时不计算涨跌', () => {
  assert.equal(changeRatio(319, 0), null);
  assert.equal(changeRatio(null, 615), null);
  assert.equal(Math.round(changeRatio(319, 615) * 100), -48);
});

test('有下载日可筛选，合计用覆盖一致的前一日比较', () => {
  const board = buildBoard(points, ['oppo', 'vivo', 'xiaomi', 'tencent', 'honor']);
  assert.deepEqual(board.active.map(point => point.date), ['2026-10-22', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(board.latest.total, 319);
  assert.equal(board.previous.date, '2026-10-31');
  assert.equal(Math.round(board.change * 100), -48);
  assert.equal(board.total, 10216);
});

test('某一天没有记录的商店不记成 0 次', () => {
  const board = buildBoard(points, ['honor', 'xiaomi']);
  const honor = board.stores.find(store => store.id === 'honor');
  const xiaomi = board.stores.find(store => store.id === 'xiaomi');
  assert.equal(honor.latest, 12);
  assert.equal(honor.previous, 20);
  assert.equal(xiaomi.total, 7688);
  assert.equal(board.stores[0].id, 'xiaomi');
});

test('同样的渠道数也必须有相同的渠道，且比较相邻日', () => {
  const items = [
    { date: '2026-10-30', total: 15, parts: { vivo: 15 } },
    { date: '2026-10-31', total: 12, parts: { oppo: 12 } },
  ];
  const result = buildBoard(items, ['oppo', 'vivo']);
  assert.equal(result.change, null);
  assert.equal(result.comparison, '前后两天覆盖渠道不同');
  assert.equal(buildBoard([items[0], { ...items[1], date: '2026-11-01' }], ['oppo', 'vivo']).comparison, '前一天缺少记录');
});

test('真实零仍是有记录，日历空缺保持未知', () => {
  const items = [
    { date: '2026-10-30', total: 12, parts: { oppo: 12 } },
    { date: '2026-10-31', total: 0, parts: { oppo: 0 } },
  ];
  const result = buildBoard(items, ['oppo', 'vivo']);
  assert.equal(result.latest.total, 0);
  assert.equal(result.change, -1);
  assert.deepEqual(result.covered, ['oppo']);
  assert.deepEqual(calendarPoints(items, '2026-10-30', '2026-11-01', false).map(item => item.total), [12, 0, null]);
  assert.equal(calendarPoints(items, '2026-10-30', '2026-11-01', true).length, 1);
});
