import React, { useEffect, useRef, useState } from 'react';
import { Activity, Clock3, Database, RefreshCw, ShieldCheck, Terminal, Code2, Info, SlidersHorizontal, ChevronDown } from 'lucide-react';
import { known, count, money, recentDates, selectDates, chartBuckets, summarize, filterModels, pricingCoverage } from './usage-data.js';
import './usage.css';

const stamp = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚未读取';
const stateName = { ready: '已读取', stale: '旧快照', unavailable: '暂不可用', missing_dependency: '待安装工具' };
function Status({ state }) { return <span className={`usage-status ${state}`}><i />{stateName[state] || '等待采集'}</span>; }

function QuotaCard({ provider }) {
  const quota = provider.quota;
  const Icon = provider.id === 'codex' ? Terminal : Code2;
  const windows = quota.windows || [];
  const renderWindow = window => <div className="quota-window" key={window.id}>
      <div><span>{window.label}</span><strong>{known(window.remaining_percent) && quota.state === 'ready' ? `${window.remaining_percent.toFixed(1)}%` : '—'}<small>剩余</small></strong></div>
      <div className="quota-track" aria-label={`${provider.name} ${window.label}剩余额度`} {...(known(window.remaining_percent) && quota.state === 'ready' ? { role:'meter', 'aria-valuemin':0, 'aria-valuemax':100, 'aria-valuenow':window.remaining_percent } : {})}><span style={{width: `${quota.state === 'ready' && known(window.remaining_percent) ? Math.min(100,window.remaining_percent) : 0}%`}} /></div>
      <p>{window.expired ? '窗口已到期或快照过旧，等待更新' : `已用 ${window.used_percent.toFixed(1)}%`}{window.resets_at && <> · {stamp(window.resets_at)} 重置</>}</p>
    </div>;
  return <section className="usage-quota" aria-label={`${provider.name} 账号额度`}>
    <header><span className="usage-app-icon"><Icon size={21}/></span><div><h2>{provider.name}</h2><span>账号额度</span></div><Status state={quota.state}/></header>
    {windows.length ? renderWindow(windows[0]) : <p className="usage-unavailable">{quota.reason}</p>}
    {windows.length>1 && <details className="quota-more"><summary>{provider.id==='cursor'?'模型分项额度':'其他额度窗口'} · {windows.length-1} 项</summary>{windows.slice(1).map(renderWindow)}</details>}
    {quota.reason && !!quota.windows?.length && <p className="usage-unavailable">{quota.reason}</p>}
    <footer><Database size={12}/>{quota.source}<span>{stamp(quota.updated_at)}</span></footer>
  </section>;
}

function ModelPicker({ names, selected, onChange }) {
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    const close = event => { if (ref.current && !ref.current.contains(event.target)) ref.current.open = false; };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  const checked = name => selected === null || selected.includes(name);
  return <details className="usage-model-picker" ref={ref} onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary').focus(); } }}>
    <summary><SlidersHorizontal size={14}/>模型 <span>{selected === null ? '全部' : `${selected.length}/${names.length}`}</span><ChevronDown size={13}/></summary>
    <div className="usage-model-menu"><header><strong>显示的模型</strong><button onClick={() => onChange(null)}>全选</button><button onClick={() => onChange([])}>清空</button></header>
      <input aria-label="搜索模型" placeholder="搜索模型…" value={query} onChange={e => setQuery(e.target.value)}/>
      <div>{names.filter(name => name.toLowerCase().includes(query.toLowerCase())).map(name => <label key={name}><input type="checkbox" checked={checked(name)} onChange={() => { const current = selected ?? names; onChange(checked(name) ? current.filter(value => value !== name) : [...current, name]); }}/><code>{name}</code></label>)}</div>
      <p>筛选同时作用于趋势、数值和模型明细。账号额度独立展示。</p>
    </div>
  </details>;
}

const exact = value => known(value) ? new Intl.NumberFormat('zh-CN').format(value) : '—';
function DayDetail({ row, date }) {
  return <div className="usage-day-detail" aria-live="polite"><header><div><strong>{date || '选择日期'}</strong><small>{row ? `${exact(row.total_tokens)} tokens · ${row.pricing_complete ? '完整定价' : '含回退定价或缺少价格'}` : '该日未返回所选模型的数据'}</small></div><div><span>参考估算</span><strong>{money(row?.reference_usd ?? row?.estimated_usd)}</strong></div></header>
    {row && <><div className="usage-day-counters"><span>输入 <b>{exact(row.input_tokens)}</b></span><span>其中缓存 <b>{exact(row.cached_tokens)}</b></span><span>输出 <b>{exact(row.output_tokens)}</b></span></div>
    <div className="usage-day-models"><table><thead><tr><th>当日模型</th><th>Tokens</th><th>参考费用</th><th>定价状态</th></tr></thead><tbody>{(row.models || []).map(model => <tr key={model.name}><td><code>{model.name}</code></td><td>{exact(model.total_tokens)}</td><td>{money(model.reference_usd ?? model.estimated_usd ?? (row.models.length === 1 ? row.reference_usd ?? row.estimated_usd : null))}</td><td>{model.fallback_pricing ? '回退定价' : '来源已匹配'}</td></tr>)}</tbody></table></div></>}
  </div>;
}

function Trend({ dates, daily, metric }) {
  const [width, setWidth] = useState(900), [hover, setHover] = useState(null), [pinned, setPinned] = useState(null), [chosenDay, setChosenDay] = useState(null);
  const chartRef = useRef(null);
  useEffect(() => { const observer = new ResizeObserver(entries => setWidth(Math.max(300, entries[0].contentRect.width))); observer.observe(chartRef.current); return () => observer.disconnect(); }, []);
  const buckets = chartBuckets(dates, daily, metric);
  const maximum = Math.max(...buckets.map(row => row.value).filter(known), 1);
  const selected = buckets.find(row => row.start === (pinned || hover)) || buckets.at(-1);
  const selectedDates = selected ? recentDates(selected.end, selected.days) : [];
  const date = selectedDates.includes(chosenDay) ? chosenDay : selectedDates.at(-1);
  const row = daily.find(row => row.date === date);
  const plot = Math.max(1, width - 65), unit = plot / Math.max(buckets.length, 1), bottom = 190;
  const valueLabel = value => metric === 'total_tokens' ? `${exact(value)} tokens` : money(value);
  return <div ref={chartRef} className="usage-chart" onKeyDown={e => { if(e.key==='Escape') { setPinned(null); setHover(null); } }}>
    <div className="usage-chart-hint"><span><i/>{selected?.start}{selected?.end !== selected?.start ? ` — ${selected?.end}` : ''} <strong>{known(selected?.value) ? valueLabel(selected.value) : selected?.missingReason || '选择日期'}</strong></span><small>{pinned ? '已固定 · 再次点击取消' : '移入预览 · 点击固定 · 方向键切换'}</small></div>
    <svg viewBox={`0 0 ${width} 220`} role="group" aria-label="每日用量趋势，点击柱状图查看每天明细">
      {[0,.25,.5,.75,1].map(fraction => <g key={fraction}><line x1="54" x2={width-10} y1={bottom-fraction*155} y2={bottom-fraction*155} className="usage-grid-line"/><text x="46" y={bottom-fraction*155+4} textAnchor="end">{metric === 'total_tokens' ? count(maximum*fraction) : money(maximum*fraction)}</text></g>)}
      {buckets.map((bucket,index) => {
        const value=bucket.value, height=known(value) ? Math.max(2,value/maximum*155) : 8;
        const step=Math.max(1,Math.ceil(buckets.length/9));
        const activate = () => { setPinned(pinned === bucket.start ? null : bucket.start); setChosenDay(null); };
        return <g key={bucket.start} role="button" tabIndex={0} aria-label={`${bucket.start}${bucket.end !== bucket.start ? ` 至 ${bucket.end}` : ''}：${known(value) ? valueLabel(value) : bucket.missingReason}，查看日明细`} aria-pressed={pinned === bucket.start} className={`usage-chart-point ${selected?.start===bucket.start ? 'is-selected' : ''}`} onPointerEnter={() => setHover(bucket.start)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(bucket.start)} onBlur={() => setHover(null)} onClick={activate} onKeyDown={event => { if(['Enter',' '].includes(event.key)) { event.preventDefault(); activate(); } if(['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); (event.key === 'ArrowLeft' ? event.currentTarget.previousElementSibling : event.currentTarget.nextElementSibling)?.focus(); } }}>
          <title>{bucket.start}：{known(value) ? valueLabel(value) : bucket.missingReason}</title><rect className="usage-chart-hit" x={54+index*unit} y="22" width={unit} height="174"/><rect className={known(value) ? 'usage-bar' : `usage-bar missing ${bucket.excluded ? 'excluded' : ''}`} x={54+index*unit+unit*.18} y={bottom-height} width={Math.max(1,unit*.64)} height={height} rx="3"/>{(index%step===0 && index<buckets.length-Math.max(2,step*.6) || index===buckets.length-1) && <text x={54+index*unit+unit/2} y="213" textAnchor="middle">{(index===buckets.length-1?bucket.end:bucket.start).slice(5).replace('-','/')}</text>}
        </g>;
      })}
    </svg>
    {selectedDates.length>1 && <label className="usage-group-date">组内逐日明细 <select aria-label="组内明细日期" value={date} onChange={e => setChosenDay(e.target.value)}>{selectedDates.map(day => <option key={day}>{day}</option>)}</select></label>}
    <DayDetail row={row} date={date}/>
  </div>;
}

export default function UsagePage({ onDiagnostics }) {
  const [data,setData]=useState(null), [error,setError]=useState(''), [providerId,setProvider]=useState('codex'), [range,setRange]=useState('all'), [metric,setMetric]=useState('total_tokens');
  const [modelSelection, setModelSelection] = useState(() => { try { const saved=JSON.parse(localStorage.getItem('ai-hub-usage-models') || '{}'); return Object.fromEntries(['codex','cursor'].map(id => [id, Array.isArray(saved[id]) ? saved[id].filter(name => typeof name === 'string') : null])); } catch { return {codex:null,cursor:null}; } });
  useEffect(() => { try { localStorage.setItem('ai-hub-usage-models', JSON.stringify(modelSelection)); } catch {} }, [modelSelection]);
  const [customStart,setStart]=useState(''), [customEnd,setEnd]=useState('');
  const refreshRef=useRef(null);
  useEffect(() => {
    let alive=true, busy=false, lastRefresh=0, timer;
    async function read(refresh=false) {
      if (busy || !alive) return;
      busy=true;
      try {
        const response=await fetch(refresh ? '/api/usage/refresh' : '/api/usage', refresh ? {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'} : {});
        if (!response.ok) throw new Error('用量服务暂不可用，请检查本地服务版本或重新打开 App。');
        const value=await response.json();
        if (alive) { setData(value); setError(''); }
        if (refresh) lastRefresh=Date.now();
      } catch (failure) { if(alive) setError(failure.message); }
      finally { busy=false; }
    }
    refreshRef.current=()=>read(true);
    const resume=()=>{ if(!document.hidden) read(Date.now()-lastRefresh>=300000); };
    const manual=()=>read(true);
    read().then(()=>{if(alive && !document.hidden) read(true);});
    timer=setInterval(()=>{if(!document.hidden) read(Date.now()-lastRefresh>=300000);},4000);
    document.addEventListener('visibilitychange',resume);
    window.addEventListener('ai-hub-refresh-usage',manual);
    return ()=>{alive=false;clearInterval(timer);document.removeEventListener('visibilitychange',resume);window.removeEventListener('ai-hub-refresh-usage',manual);refreshRef.current=null;};
  },[]);
  if(!data) return <div className="usage-initial" role="status"><Activity size={26}/><p>{error || '正在读取本地用量快照…'}</p>{error && <button className="button" onClick={()=>refreshRef.current?.()}>重试</button>}</div>;
  const provider=data.providers.find(item=>item.id===providerId), history=provider.history;
  const today=data.served_at.slice(0,10), selection=selectDates(history.daily || [],today,range,customStart,customEnd), dates=selection.dates;
  const names = [...new Set((history.daily || []).flatMap(row => (row.models || []).map(model => model.name)))].sort();
  const selectedModels = modelSelection[providerId];
  const filteredDaily = filterModels(history.daily || [], selectedModels);
  const chartDaily = filteredDaily.map(row => ({...row, reference_usd:row.reference_usd ?? row.estimated_usd}));
  const coverage = pricingCoverage(filteredDaily, dates);
  const summary=summarize(filteredDaily,dates), rangeLabel=range==='all'?'全部可读历史':range==='custom'?'自选区间':`近 ${range} 天`;
  const recordedDates=(history.daily || []).map(row=>row.date).sort();
  function chooseRange(value) {
    if(value==='custom' && !customStart && !customEnd) {setStart(recordedDates[0] || recentDates(today,30)[0]);setEnd(today);}
    setRange(value);
  }
  const todayRow=filteredDaily.find(row=>row.date===today);
  return <div className="usage-page">
    <div className="usage-toolbar"><span className="usage-pulse"><i className={data.refreshing?'pulsing':''}/>{data.refreshing ? '正在读取两端用量…' : '页面可见时，每 5 分钟更新'}<small>上海时区</small></span><button className="button" disabled={data.refreshing} onClick={()=>refreshRef.current?.()}><RefreshCw size={14} className={data.refreshing?'spin':''}/>{data.refreshing?'采集中':'刷新用量'}</button></div>
    {error && <div className="usage-notice" role="alert">{error} 当前保留上次读取结果。</div>}
    <div className="usage-quotas">{data.providers.map(item=><QuotaCard key={item.id} provider={item}/>)}</div>
    <div className="usage-history-heading"><div><h2>每日消耗</h2></div><div className="usage-controls"><ModelPicker names={names} selected={selectedModels} onChange={value => setModelSelection(current => ({...current,[providerId]:value}))}/><div className="segmented" role="group" aria-label="用量来源">{data.providers.map(item=><button key={item.id} aria-pressed={providerId===item.id} className={providerId===item.id?'active':''} onClick={()=>setProvider(item.id)}>{item.name}</button>)}</div><div className="segmented" role="group" aria-label="统计范围">{[['7','近 7 天'],['30','近 30 天'],['all','全部'],['custom','自选日期']].map(([value,label])=><button key={value} aria-pressed={range===value} className={range===value?'active':''} onClick={()=>chooseRange(value)}>{label}</button>)}</div></div></div>
    {range==='custom' && <div className="usage-date-range"><label>开始日期<input type="date" aria-label="开始日期" min="1970-01-01" max={today} value={customStart} onChange={event=>setStart(event.target.value)}/></label><span>至</span><label>结束日期<input type="date" aria-label="结束日期" min="1970-01-01" max={today} value={customEnd} onChange={event=>setEnd(event.target.value)}/></label></div>}
    {selection.error && <p className="usage-notice" role="alert">{selection.error}</p>}
    <div className="usage-health" aria-label={provider.name + ' 数据来源与状态'}>
      <section><header><strong>账号额度</strong><Status state={provider.quota.state}/></header><small>{provider.quota.source} · {stamp(provider.quota.updated_at)}</small>{provider.quota.reason && <p>{provider.quota.reason}</p>}</section>
      <section><header><strong>历史消耗</strong><Status state={history.state}/></header><small>{history.source} · {stamp(history.updated_at)}</small><p>{recordedDates.length ? `${recordedDates.length} 天 · ${recordedDates[0]} 至 ${recordedDates.at(-1)}` : '尚未读到日记录'}{history.coverage_mode === 'legacy_30' && ' · 旧版近 30 天缓存'}</p></section>
      <section><header><strong>费用口径</strong><span className="usage-price-badge">{coverage.fallbackModels.length ? '含回退定价' : '来源定价'}</span></header><small>参考估算保留采集器原值；完整定价小计单独核对</small><p>{coverage.referenceDays}/{summary.selected.length} 天返回参考费用 · {summary.priced} 天完整定价</p></section>
    </div>
    {(history.reason || !summary.selected.length || provider.quota.state !== 'ready') && <div className="usage-notice usage-health-actions"><Info size={16}/><span>{history.reason || (!summary.selected.length ? '所选日期没有日记录。' : '账号额度需要重新核对。')}{history.state === 'missing_dependency' && ' 安装步骤见 Hub README 的「用量中心」。'}</span><button className="button" disabled={data.refreshing} onClick={() => refreshRef.current?.()}>重新读取</button>{onDiagnostics && <button className="button" onClick={onDiagnostics}>查看本机诊断</button>}</div>}
    <div className="usage-metrics">
      <div><span>今日 tokens</span><strong>{count(todayRow?.total_tokens)}</strong><small>{today} · {todayRow ? '已返回记录' : '尚无日记录'}</small></div>
      <div><span>{rangeLabel}记录量</span><strong>{count(summary.total)}</strong><small>{summary.tokenDays}/{dates.length} 天有 token 记录</small></div>
      <div className={coverage.fallbackModels.length ? 'usage-estimate-partial' : ''}><span>API 参考费用估算</span><strong>{money(coverage.reference)}</strong><small>{coverage.fallbackModels.length ? `含回退定价 · ${coverage.fallbackPercent?.toFixed(1) ?? '—'}% tokens` : '按采集器返回的 API 定价'}<br/>完整定价日小计 {money(summary.estimate)}</small></div>
      <div><span>输入缓存命中率</span><strong>{known(summary.hit)?`${summary.hit.toFixed(1)}%`:'—'}</strong><small>缓存读取 / 全部输入 tokens</small></div>
    </div>
    <section className="usage-panel"><header><div><h3>{provider.name} · 消耗趋势</h3><span>{dates.length?`${dates[0]} — ${dates.at(-1)}`:'待选择有效日期'} · {selectedModels === null ? '全部模型' : `${selectedModels.length} 个所选模型`} · 空柱表示缺少数据{dates.length>92?' · 更长的历史才把相邻几天并成一根，最后一根标结束日':''}</span></div><div className="segmented" role="group" aria-label="趋势指标">{[['total_tokens','Tokens'],['reference_usd','参考费用'],['estimated_usd','完整定价']].map(([key,label])=><button key={key} className={metric===key?'active':''} aria-pressed={metric===key} onClick={()=>setMetric(key)}>{label}</button>)}</div></header>{metric==='estimated_usd' && summary.priced<summary.selected.length && <div className="usage-notice"><Info size={15}/><span>{summary.tokenDays} 天有用量，{summary.priced} 天进入完整定价；其余日期含回退定价或缺少分项价格。空框不表示没有消耗。</span><button className="button" onClick={() => setMetric('reference_usd')}>查看参考费用</button></div>}<Trend key={`${providerId}:${selectedModels?.join(',') ?? 'all'}`} dates={dates} daily={chartDaily} metric={metric}/><p className="usage-fine-print">参考费用含采集器的回退定价，仅供比较，不代表订阅账单。完整定价排除含回退价格的日期；模型分项费用未返回时显示 —，不按 token 比例分摊。</p></section>
    {!!coverage.fallbackModels.length && <details className="usage-pricing-note"><summary><Info size={14}/>为什么金额是参考值？{coverage.fallbackModels.length} 个模型存在回退定价</summary><p>采集器无法为部分记录匹配精确价格，采用回退价格估算。旧界面整日排除这类记录导致总额偏低；现在同时保留参考估算和完整定价日小计。</p><code>{coverage.fallbackModels.join(' · ')}</code></details>}
    {selectedModels?.length === 0 && <p className="usage-notice">当前隐藏了全部模型，请在「模型」菜单勾选要查看的项目。</p>}
    <div className="usage-details-grid"><section className="usage-panel"><header><h3>Token 构成</h3><Database size={16}/></header><dl className="usage-composition"><div><dt>全部输入（含缓存）</dt><dd>{count(summary.input)}</dd></div><div><dt>其中：缓存读取</dt><dd>{count(summary.cached)}</dd></div><div><dt>输出</dt><dd>{count(summary.output)}</dd></div></dl><p className="usage-fine-print">推理 tokens 已含在输出内，不重复累加。</p></section>
    <section className="usage-panel"><header><h3>模型分布</h3><span>按已返回记录</span></header><div className="usage-models">{summary.models.length ? summary.models.map(model=><div key={model.name}><code>{model.name}</code><strong>{count(model.total_tokens)}</strong></div>) : <p className="usage-fine-print">暂无模型明细。</p>}</div></section></div>
    {known(history.metered_period?.usd) && <div className="usage-billing"><Clock3 size={17}/><span>Cursor 数据源返回的{history.metered_period.label || `近 ${history.metered_period.days} 日`}计费口径金额<strong>{money(history.metered_period.usd)}</strong><small>来源区间金额与上方日期筛选独立；订阅实际应付以官方账单为准。</small></span></div>}
    <details className="usage-provenance"><summary><ShieldCheck size={15}/>数据来源与边界<span>{stamp(history.updated_at)} 更新</span></summary><div><p>{history.source} · {history.note}</p><p>只保存规范化统计，不保存账号标识、凭据或对话正文。Codex 本机记录与 Cursor 云端记录分别展示，不跨来源合并费用。</p><p>离开此页或隐藏窗口后暂停页面定时采集；下次打开重新读取。采集失败时保留标注的旧快照，过期额度隐藏。</p><a href="https://github.com/steipete/CodexBar" target="_blank" rel="noreferrer">CodexBar</a><a href="https://github.com/ccusage/ccusage" target="_blank" rel="noreferrer">ccusage</a></div></details>
  </div>;
}
