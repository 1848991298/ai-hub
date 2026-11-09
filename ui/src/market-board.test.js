import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateTimeline, buildBoard, calendarPoints, changeRatio, chartTicks, selectChannels, timelineRows } from './market-board.js';

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

test('渠道筛选重算合计，不把未选渠道或缺失记录混入', () => {
  const chosen = selectChannels(points, ['honor']);
  assert.equal(chosen[0].total, null);
  assert.equal(chosen[3].total, 38);
  assert.deepEqual(chosen[3].parts, { honor: 38 });
  assert.equal(selectChannels(points, ['xiaomi'])[0].total, 0);
  assert.equal(points[3].total, 2462);
});

test('跨月周汇总按周一分组并裁切边界，部分记录保留覆盖数', () => {
  const rows = [
    {date:'2026-01-30',parts:{oppo:0,vivo:5}},
    {date:'2026-01-31',parts:{oppo:10}},
    {date:'2026-02-02',parts:{oppo:0,vivo:1}},
  ];
  const weeks = aggregateTimeline(rows, ['oppo','vivo'], '2026-01-30','2026-02-03','week');
  assert.equal(weeks.length,2);
  assert.deepEqual([weeks[0].start,weeks[0].end,weeks[0].total,weeks[0].days,weeks[0].knownDays],['2026-01-30','2026-02-01',15,3,2]);
  assert.deepEqual(weeks[0].coverage,{oppo:2,vivo:1});
  assert.equal(weeks[0].partial,true);
  assert.equal(weeks[1].total,1);
  const months = aggregateTimeline(rows,['oppo'],'2026-01-30','2026-02-03','month');
  assert.equal(months[1].total,0);
  assert.equal(months[1].knownDays,1);
  const unknown = aggregateTimeline(rows,['honor'],'2026-01-30','2026-02-03','month');
  assert.equal(unknown[0].total,null);
  assert.deepEqual(unknown[0].parts,{});
});

test('明细筛选和排序保留真实零，缺失值始终排在数值后', () => {
  const rows=aggregateTimeline([{date:'2026-10-30',parts:{oppo:12}},{date:'2026-10-31',parts:{oppo:0}}],['oppo'],'2026-10-30','2026-11-01');
  assert.deepEqual(timelineRows(rows).map(x=>x.total),[0,12]);
  assert.deepEqual(timelineRows(rows,'positive').map(x=>x.total),[12]);
  assert.deepEqual(timelineRows(rows,'all','lowest').map(x=>x.total),[0,12,null]);
  assert.deepEqual(timelineRows(rows,'partial').map(x=>x.total),[null]);
});

test('全部历史不再默默截断为一年，刻度覆盖峰值且兼容真实零', () => {
  assert.equal(calendarPoints([], '2025-01-01','2026-02-01',false).length,397);
  assert.deepEqual(chartTicks(37),[0,10,20,30,40]);
  assert.deepEqual(chartTicks(37,true),[0,1,10,100]);
  assert.deepEqual(chartTicks(0,true),[0,1]);
});
