import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentDates, selectDates, chartBuckets, summarize, count, money } from './usage-data.js';

test('自然日跨月；缺失日期、金额不作为零加入',()=>{
  const dates=recentDates('2026-10-01',7);
  assert.equal(dates[0],'2026-09-25');
  const summary=summarize([
    {date:'2026-09-30',total_tokens:135,input_tokens:115,cached_tokens:100,output_tokens:20,estimated_usd:null},
    {date:'2026-10-01',total_tokens:0,input_tokens:0,cached_tokens:0,output_tokens:0,estimated_usd:0},
    {date:'2026-09-01',total_tokens:999,estimated_usd:999},
  ],dates);
  assert.equal(summary.total,135); assert.equal(summary.estimate,0); assert.equal(summary.priced,1); assert.equal(summary.tokenDays,2);
  assert.equal(summary.hit,100/115*100); assert.equal(count(null),'—'); assert.equal(money(null),'—'); assert.equal(money(0),'$0.00');
});

test('未知构成不推算命中率；模型缺失明细不变成零',()=>{
  const summary=summarize([{date:'2026-10-01',total_tokens:135,input_tokens:null,cached_tokens:null,models:[{name:'unknown',total_tokens:null}]}],['2026-10-01']);
  assert.equal(summary.hit,null); assert.equal(summary.estimate,null); assert.equal(summary.models[0].total_tokens,null);
  assert.equal(summarize([],['2026-10-01']).total,null);
});

test('全部从实际最早日开始，切换来源后重新计算，不采用来源的巨大哨兵天数',()=>{
  const all=selectDates([{date:'2025-12-02'},{date:'2026-10-28'}],'2026-10-29','all');
  assert.equal(all.dates[0],'2025-12-02'); assert.equal(all.dates.at(-1),'2026-10-29'); assert.equal(all.dates.length,332);
  assert.equal(selectDates([{date:'2026-09-05'}],'2026-10-29','all').dates[0],'2026-09-05');
  assert.equal(selectDates([],'2026-10-29','all').dates.length,1);
});

test('自选范围支持跨年、闰日；拒绝倒序、无效和未来日期',()=>{
  assert.equal(selectDates([],'2026-10-29','custom','2024-02-28','2024-03-01').dates.length,3);
  for(const [start,end] of [['2026-10-29','2026-10-01'],['2026-02-30','2026-03-01'],['','2026-10-29'],['2026-10-01','2026-10-30']]) {
    const result=selectDates([],'2026-10-29','custom',start,end);assert.equal(result.dates.length,0);assert.ok(result.error);
  }
});

test('长历史图表至多 60 组，按已知值汇总且空组仍未知',()=>{
  const dates=recentDates('2026-10-29',332), daily=[{date:dates[0],total_tokens:5},{date:dates[1],total_tokens:10},{date:dates.at(-1),total_tokens:0}];
  const buckets=chartBuckets(dates,daily,'total_tokens');
  assert.ok(buckets.length<=60);assert.equal(buckets[0].value,15);assert.equal(buckets[0].observed,2);
  assert.equal(buckets[1].value,null);assert.equal(buckets.at(-1).value,0);
  assert.equal(buckets.filter(row=>row.value!==null).reduce((sum,row)=>sum+row.value,0),15);
});
