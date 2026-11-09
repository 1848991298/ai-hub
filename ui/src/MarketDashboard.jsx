import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Maximize2, RotateCcw, X } from 'lucide-react';
import { aggregateTimeline, buildBoard, calendarPoints, chartTicks, selectChannels, timelineRows } from './market-board.js';
import './market-dashboard.css';

const colors = { oppo: '#24956c', vivo: '#4d78dc', xiaomi: '#d89429', tencent: '#9670ce', honor: '#c77495' };
const color = id => colors[id] || '#517d9c';
const number = value => value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
const span = row => row.start === row.end ? row.start : `${row.start} — ${row.end}`;
const short = date => date.slice(5).replace('-', '/');
const compact = n => n >= 10000 ? number(n / 10000) + '万' : n >= 1000 ? number(n / 1000) + '千' : number(n);

export default function MarketDashboard({ points, stores, orderedIds, start, end, onRange }) {
  const [chosen, setChosen] = useState(orderedIds);
  const [unit, setUnit] = useState('auto');
  const [style, setStyle] = useState('line');
  const [scale, setScale] = useState('linear');
  const [zoom, setZoom] = useState(null);
  const idsKey = orderedIds.join('|');
  useEffect(() => { setChosen(orderedIds); }, [idsKey]);
  useEffect(() => { setZoom(null); }, [start, end]);
  const ids = orderedIds.filter(id => chosen.includes(id));
  const from = zoom?.[0] || start, to = zoom?.[1] || end;
  const selected = selectChannels(points.filter(p => p.date >= from && p.date <= to), ids);
  const recorded = selected.filter(p => p.total != null);
  const daily = calendarPoints(selected, from, to, false);
  const resolvedUnit = unit === 'auto' ? daily.length > 120 ? 'month' : daily.length > 45 ? 'week' : 'day' : unit;
  const buckets = aggregateTimeline(points, ids, from, to, resolvedUnit);
  const board = buildBoard(recorded, ids);
  const peak = [...recorded].sort((a, b) => b.total - a.total || b.date.localeCompare(a.date))[0];
  const cells = recorded.reduce((sum, p) => sum + Object.keys(p.parts).length, 0);
  const expected = daily.length * ids.length;
  const coverage = expected ? Math.round(cells / expected * 100) : null;
  const total = board.total;
  function toggle(id) { setChosen(current => current.includes(id) ? current.filter(v => v !== id) : [...current, id]); }
  return <div className="market-dashboard">
    <div className="market-insight-head">
      <div><span className="market-eyebrow">下载总览</span><strong>{from} <span>—</span> {to}</strong></div>
      <span className="market-data-status"><i/>{board.latest ? `最近有记录：${board.latest.date} · ${recorded.length}/${daily.length} 天` : '所选范围暂无记录'}</span>
    </div>
    <div className="market-overview-stats">
      <article><span>已记录下载合计</span><strong>{number(total)}<small>次</small></strong><p>{ids.length} 个所选渠道 · 仅汇总已取得数值</p></article>
      <article><span>有记录日期均值</span><strong>{number(recorded.length ? total / recorded.length : null)}<small>次 / 天</small></strong><p>{recorded.length} 天有记录，不将缺失日期计作零</p></article>
      <article><span>单日峰值</span><strong>{number(peak?.total)}<small>次</small></strong><p>{peak ? `${peak.date} · 点击图表可查看渠道贡献` : '等待有效记录'}</p></article>
      <article><span>记录覆盖</span><strong>{coverage == null ? '—' : coverage}<small>{coverage == null ? '' : '%'}</small></strong><p>{cells} / {expected} 个渠道日有数值</p></article>
    </div>
    <div className="market-analysis-grid">
      <section className="market-panel market-trend-panel" aria-label="下载趋势分析">
        <div className="market-chart-heading"><div><h2>下载趋势</h2><p>按渠道观察变化，拖选时间段可放大</p></div><div className="market-chart-switch" role="group" aria-label="趋势图类型">{[['line','折线'],['bar','柱图']].map(([v,l]) => <button type="button" key={v} aria-pressed={style === v} onClick={() => setStyle(v)}>{l}</button>)}</div></div>
        <div className="market-trend-controls"><div className="market-chart-options">
          <div className="market-chart-switch" role="group" aria-label="汇总周期">{[['auto','自动'],['day','日'],['week','周'],['month','月']].map(([v,l]) => <button type="button" key={v} aria-pressed={unit === v} onClick={() => setUnit(v)}>{l}</button>)}</div>
          <div className="market-chart-switch" role="group" aria-label="数值刻度">{[['linear','线性'],['log','对数']].map(([v,l]) => <button type="button" key={v} aria-pressed={scale === v} onClick={() => setScale(v)}>{l}</button>)}</div>
          {zoom && <button type="button" className="market-zoom-reset" onClick={() => setZoom(null)}><RotateCcw size={13}/>恢复完整区间</button>}
        </div>
        <div className="market-series-filter" role="group" aria-label="趋势渠道筛选">
          {orderedIds.map(id => <button type="button" key={id} aria-pressed={ids.includes(id)} onClick={() => toggle(id)}><i style={{ background: color(id) }}/>{stores[id] || id}<span>{ids.includes(id) ? '✓' : '+'}</span></button>)}
          <button type="button" className="market-series-all" onClick={() => setChosen(orderedIds)}>全选</button>
        </div></div>
        {ids.length && buckets.length ? <TrendChart key={`${from}|${to}|${resolvedUnit}|${ids.join('|')}`} buckets={buckets} ids={ids} stores={stores} style={style} logarithmic={scale === 'log'} onZoom={(a,b) => setZoom([a,b])} onInspect={row => onRange(row.start, row.end, ids)}/> : <div className="market-chart-empty">{ids.length ? '当前日期范围无效，请调整起止日期。' : '请选择至少一个渠道，再查看趋势。'}</div>}
        <div className="market-chart-foot"><span>{resolvedUnit === 'day' ? '每日' : resolvedUnit === 'week' ? '每周' : '每月'}汇总 · {style === 'bar' ? '柱图展示已记录合计' : '各渠道独立折线'}{scale === 'log' ? ' · 对数刻度 log(1+x)，数值仍显示原值' : ''}</span><span>断点为缺失记录 · 0 为真实零值</span></div>
      </section>
      <section className="market-panel market-ranking" aria-label="渠道对比">
        <div className="market-chart-heading"><div><h2>渠道对比</h2><p>当前区间已记录下载</p></div></div>
        {board.stores.map((store, i) => <button type="button" key={store.id} className="market-rank-row" onClick={() => setChosen([store.id])} title={'仅看' + stores[store.id]}>
          <span className="market-rank-name"><em>{i + 1}</em><i style={{ background: color(store.id) }}/>{stores[store.id] || store.id}<strong>{number(store.total)}</strong></span>
          <span className="market-rank-track"><i style={{ background: color(store.id), width: `${total > 0 && store.total != null ? store.total / total * 100 : 0}%` }}/></span>
          <small>{store.total == null ? '区间暂无记录' : `占已记录合计 ${total > 0 ? number(store.total / total * 100) : '0'}%`}<span>{recorded.filter(p => p.parts[store.id] != null).length}/{daily.length} 天</span></small>
        </button>)}
        {!ids.length && <p className="market-caption">选择渠道后显示区间对比。</p>}
        <p className="market-ranking-note">点击渠道可单独查看。覆盖不完整时，合计与占比仅代表已取得的记录；各商店下载口径按来源核对。</p>
        {ids.length !== orderedIds.length && <button type="button" className="market-rank-restore" onClick={() => setChosen(orderedIds)}>显示全部渠道</button>}
      </section>
    </div>
    <TimelineDetails key={`${from}|${to}|${resolvedUnit}|${ids.join('|')}`} buckets={buckets} ids={ids} stores={stores} onInspect={onRange}/>
  </div>;
}

function TrendChart({ buckets, ids, stores, style, logarithmic, onZoom, onInspect }) {
  const frame = useRef(null), drag = useRef(null), moved = useRef(false);
  const [width, setWidth] = useState(760);
  const [hover, setHover] = useState(null), [pinned, setPinned] = useState(null), [brush, setBrush] = useState(null);
  const clip = useId();
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(Math.max(280, entries[0].contentRect.width)));
    if (frame.current) observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  const left = 48, right = width - 16, top = 24, bottom = 228, height = 270;
  const maximum = style === 'line' ? Math.max(0, ...buckets.flatMap(b => ids.map(id => b.parts[id] || 0))) : Math.max(0, ...buckets.map(b => b.total || 0));
  const ticks = chartTicks(maximum, logarithmic);
  const max = ticks.at(-1);
  const transform = value => logarithmic ? Math.log1p(value) : value;
  const y = value => bottom - transform(value) / transform(max) * (bottom - top);
  const step = (right - left) / Math.max(1, buckets.length);
  const x = index => left + step * (index + .5);
  const indexAt = value => Math.max(0, Math.min(buckets.length - 1, Math.floor((value - left) / step)));
  const active = pinned ?? hover, current = active == null ? null : buckets[active];
  const axisEvery = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor((right - left) / 95))));
  function localX(event) { return Math.max(left, Math.min(right, event.clientX - event.currentTarget.getBoundingClientRect().left)); }
  function pin(index) { if (moved.current) { moved.current = false; return; } setPinned(value => value === index ? null : index); setHover(index); }
  function keyboard(event, index) {
    const next = event.key === 'ArrowRight' ? Math.min(index + 1, buckets.length - 1) : event.key === 'ArrowLeft' ? Math.max(index - 1, 0) : event.key === 'Home' ? 0 : event.key === 'End' ? buckets.length - 1 : null;
    if (next != null) { event.preventDefault(); setPinned(null); setHover(next); frame.current.querySelector(`[data-bucket="${next}"]`)?.focus(); }
    if (['Enter',' '].includes(event.key)) { event.preventDefault(); pin(index); }
    if (event.key === 'Escape') { setPinned(null); setHover(null); }
  }
  function path(id) {
    let connected = false;
    return buckets.map((b,i) => { if (b.parts[id] == null) { connected = false; return ''; } const command = connected ? 'L' : 'M'; connected = true; return `${command}${x(i)},${y(b.parts[id])}`; }).join(' ');
  }
  return <div className="market-trend-frame" ref={frame}>
    <div className="market-trend-instruction"><span>{pinned == null ? '悬停查看数值 · 点击固定' : '已固定数值 · 再次点击取消'}</span><span><Maximize2 size={12}/>拖选区间放大</span></div>
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="下载趋势图"
      onPointerDown={e => { if (e.button !== 0 || !e.isPrimary) return; drag.current = localX(e); moved.current = false; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { const pos = localX(e); if (drag.current != null && Math.abs(pos - drag.current) > 6) { moved.current = true; setBrush([drag.current,pos]); } else if (pinned == null) setHover(indexAt(pos)); }}
      onPointerLeave={() => { if (drag.current == null) setHover(null); }}
      onPointerCancel={() => { drag.current = null; setBrush(null); }}
      onPointerUp={e => { const origin = drag.current; drag.current = null; setBrush(null); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); if (origin != null && moved.current) { const a = indexAt(Math.min(origin,localX(e))), b = indexAt(Math.max(origin,localX(e))); if (a !== b) onZoom(buckets[a].start,buckets[b].end); } else if (origin != null) pin(indexAt(localX(e))); }}>
      <defs><clipPath id={clip}><rect x={left - 3} y={top - 4} width={right - left + 6} height={bottom - top + 8}/></clipPath></defs>
      {ticks.map(t => <g key={t} className="market-chart-grid"><line x1={left} x2={right} y1={y(t)} y2={y(t)}/><text x={left - 10} y={y(t) + 4} textAnchor="end">{compact(t)}</text></g>)}
      <g clipPath={`url(#${clip})`}>
        {style === 'line' ? ids.map(id => <g key={id}><path d={path(id)} fill="none" stroke={color(id)} strokeWidth="2.2" strokeLinejoin="round"/>{buckets.length <= 16 && buckets.map((b,i) => b.parts[id] != null && <circle key={b.key} cx={x(i)} cy={y(b.parts[id])} r="2.6" fill={color(id)} stroke="var(--mo-card)" strokeWidth="1.5"/>)}</g>)
          : buckets.map((b,i) => b.total != null && <rect key={b.key} x={x(i) - Math.min(36, step * .62) / 2} y={b.total === 0 ? bottom - 2 : y(b.total)} width={Math.min(36, step * .62)} height={b.total === 0 ? 2 : bottom - y(b.total)} rx="3" fill="var(--mo-accent)" opacity={active == null || active === i ? .88 : .45}/>)}
        {active != null && <g className="market-chart-cursor"><line x1={x(active)} x2={x(active)} y1={top} y2={bottom}/>{style === 'line' && ids.map(id => current.parts[id] != null && <circle key={id} cx={x(active)} cy={y(current.parts[id])} r="4" fill={color(id)} stroke="var(--mo-card)" strokeWidth="2"/>)}</g>}
      </g>
      {buckets.map((b,i) => <g key={b.key}>
        {(i % axisEvery === 0 || i === buckets.length - 1) && (i !== buckets.length - 2 || buckets.length < 8) && <text className="market-chart-date" x={x(i)} y={bottom + 25} textAnchor="middle">{short(b.start)}</text>}
        <rect data-bucket={i} role="button" tabIndex={i === (active ?? 0) ? 0 : -1} aria-label={`${span(b)}，已记录合计 ${b.total == null ? '缺少记录' : number(b.total) + '次'}${b.partial ? '，记录不完整' : ''}`} aria-pressed={pinned === i} x={left + step * i} y={top} width={step} height={bottom - top} fill="transparent" className="market-chart-hit" onClick={e => { if (e.detail === 0) pin(i); }} onFocus={() => setHover(i)} onKeyDown={e => keyboard(e,i)}/>
      </g>)}
      {brush && <rect className="market-chart-brush" x={Math.min(...brush)} y={top} width={Math.abs(brush[0]-brush[1])} height={bottom - top} pointerEvents="none"/>}
    </svg>
    {current && <div className={'market-chart-tooltip' + (pinned != null ? ' is-pinned' : '')} style={{ left: Math.max(0, Math.min(width - Math.min(270,width), x(active) + (x(active) < width / 2 ? 16 : -286))) }} role="status">
      <header><strong>{span(current)}</strong>{pinned != null && <button type="button" aria-label="取消固定数值" onClick={() => { setPinned(null); setHover(null); }}><X size={14}/></button>}</header>
      <p>已记录合计 <b>{number(current.total)}<small> 次</small></b></p>
      <ul>{ids.map(id => <li key={id}><i style={{ background: color(id) }}/><span>{stores[id] || id}</span><strong>{number(current.parts[id])}</strong><small>{current.days > 1 ? `${current.coverage[id] || 0}/${current.days}天` : current.parts[id] == null ? '未记录' : '次'}</small></li>)}</ul>
      {current.partial && <small className="market-tooltip-note">部分渠道或日期缺少记录，未按零补齐。</small>}
      {pinned != null && <button type="button" className="market-tooltip-inspect" onClick={() => onInspect(current)}>查看来源记录<ChevronRight size={13}/></button>}
    </div>}
  </div>;
}

function TimelineDetails({ buckets, ids, stores, onInspect }) {
  const [filter, setFilter] = useState('recorded'), [sort, setSort] = useState('newest'), [page, setPage] = useState(0), [size, setSize] = useState(10);
  const rows = timelineRows(buckets, filter, sort), pages = Math.max(1, Math.ceil(rows.length / size)), index = Math.min(page, pages - 1);
  function setting(setter, value) { setter(value); setPage(0); }
  return <details className="market-panel market-period-details">
    <summary><ChevronDown size={16}/><span><strong>下载明细</strong><small>按需展开 · 当前 {rows.length} 个周期</small></span></summary>
    <div className="market-detail-controls"><span>数值按当前渠道、时间和周期汇总</span><div>
      <select aria-label="明细记录筛选" value={filter} onChange={e => setting(setFilter,e.target.value)}>{[['recorded','有记录'],['positive','有下载'],['partial','记录不完整'],['all','全部日期']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select>
      <select aria-label="明细排序" value={sort} onChange={e => setting(setSort,e.target.value)}>{[['newest','日期从新到旧'],['oldest','日期从旧到新'],['highest','下载从高到低'],['lowest','下载从低到高']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select>
    </div></div>
    <div className="market-table-scroll"><table className="market-board-table"><thead><tr><th>周期</th><th>已记录合计</th>{ids.map(id => <th key={id}>{stores[id] || id}</th>)}<th>记录完整度</th></tr></thead><tbody>
      {rows.slice(index * size, (index + 1) * size).map(row => <tr key={row.key}><td><button type="button" className="market-period-link" onClick={() => onInspect(row.start,row.end,ids)}>{span(row)}</button></td><td><strong>{number(row.total)}</strong></td>{ids.map(id => <td key={id}><button type="button" className="market-period-link" disabled={row.parts[id] == null} onClick={() => onInspect(row.start,row.end,[id])}>{number(row.parts[id])}</button></td>)}<td><span className={row.partial ? 'market-coverage-partial' : 'market-coverage-full'}>{Object.values(row.coverage).reduce((a,b) => a+b,0)}/{row.days * ids.length} 渠道日</span></td></tr>)}
    </tbody></table></div>
    {!rows.length && <p className="market-caption">当前筛选没有匹配的记录。</p>}
    <footer className="market-detail-pagination"><span>{rows.length ? index * size + 1 : 0}–{Math.min((index + 1) * size,rows.length)} / {rows.length} 条</span><label>每页<select aria-label="明细每页条数" value={size} onChange={e => setting(setSize,Number(e.target.value))}>{[10,20,50].map(n => <option key={n} value={n}>{n} 条</option>)}</select></label><button type="button" aria-label="上一页明细" disabled={index === 0} onClick={() => setPage(index - 1)}><ChevronLeft size={16}/></button><span>{index + 1} / {pages}</span><button type="button" aria-label="下一页明细" disabled={index + 1 >= pages} onClick={() => setPage(index + 1)}><ChevronRight size={16}/></button></footer>
  </details>;
}
