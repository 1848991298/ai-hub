import React, { useEffect, useRef, useState } from 'react';
import { Activity, Clock3, Database, RefreshCw, ShieldCheck, Terminal, Code2, Info } from 'lucide-react';
import { known, count, money, recentDates, selectDates, chartBuckets, summarize } from './usage-data.js';
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

function Trend({ dates, daily, metric }) {
  const buckets = chartBuckets(dates,daily,metric);
  const maximum = Math.max(...buckets.map(row=>row.value).filter(known), 1);
  const unit = 700 / Math.max(buckets.length,1);
  return <div className="usage-chart">
    <svg viewBox="0 0 720 175" role="img" aria-label={`每日${metric === 'total_tokens' ? 'token' : 'API 等价费用估算'}趋势；空框表示未取得数据`}>
      <title>每日用量趋势，空框表示未取得数据</title>
      {[25,70,115,150].map(y => <line key={y} x1="10" x2="710" y1={y} y2={y} className="usage-grid-line"/>)}
      {buckets.map((bucket,index) => {
        const value=bucket.value, height=known(value) ? Math.max(2,value/maximum*120) : 10;
        const label=known(value) ? (metric==='total_tokens' ? `${new Intl.NumberFormat('zh-CN').format(value)} tokens` : money(value)) : '未取得数据';
        const step=Math.max(1,Math.ceil(buckets.length/7));
        return <g key={bucket.start}><title>{bucket.start}{bucket.end!==bucket.start?` — ${bucket.end}`:''}：{label}；{bucket.observed}/{bucket.days} 天有值</title><rect className={known(value) ? 'usage-bar' : 'usage-bar missing'} x={10+index*unit+unit*.17} y={150-height} width={unit*.66} height={height} rx="3"/>{(index%step===0 || index===buckets.length-1) && <text x={10+index*unit+unit/2} y="170" textAnchor="middle">{(index===buckets.length-1?bucket.end:bucket.start).slice(5).replace('-','/')}</text>}</g>;
      })}
    </svg>
  </div>;
}

export default function UsagePage({ onDiagnostics }) {
  const [data,setData]=useState(null), [error,setError]=useState(''), [providerId,setProvider]=useState('codex'), [range,setRange]=useState('all'), [metric,setMetric]=useState('total_tokens');
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
  const summary=summarize(history.daily || [],dates), rangeLabel=range==='all'?'全部可读历史':range==='custom'?'自选区间':`近 ${range} 天`;
  const recordedDates=(history.daily || []).map(row=>row.date).sort();
  function chooseRange(value) {
    if(value==='custom' && !customStart && !customEnd) {setStart(recordedDates[0] || recentDates(today,30)[0]);setEnd(today);}
    setRange(value);
  }
  const todayRow=history.daily?.find(row=>row.date===today);
  return <div className="usage-page">
    <div className="usage-toolbar"><span className="usage-pulse"><i className={data.refreshing?'pulsing':''}/>{data.refreshing ? '正在读取两端用量…' : '页面可见时，每 5 分钟更新'}<small>上海时区</small></span><button className="button" disabled={data.refreshing} onClick={()=>refreshRef.current?.()}><RefreshCw size={14} className={data.refreshing?'spin':''}/>{data.refreshing?'采集中':'刷新用量'}</button></div>
    {error && <div className="usage-notice" role="alert">{error} 当前保留上次读取结果。</div>}
    <div className="usage-quotas">{data.providers.map(item=><QuotaCard key={item.id} provider={item}/>)}</div>
    <div className="usage-history-heading"><div><h2>每日消耗</h2></div><div className="usage-controls"><div className="segmented" role="group" aria-label="用量来源">{data.providers.map(item=><button key={item.id} aria-pressed={providerId===item.id} className={providerId===item.id?'active':''} onClick={()=>setProvider(item.id)}>{item.name}</button>)}</div><div className="segmented" role="group" aria-label="统计范围">{[['7','近 7 天'],['30','近 30 天'],['all','全部'],['custom','自选日期']].map(([value,label])=><button key={value} aria-pressed={range===value} className={range===value?'active':''} onClick={()=>chooseRange(value)}>{label}</button>)}</div></div></div>
    {range==='custom' && <div className="usage-date-range"><label>开始日期<input type="date" aria-label="开始日期" min="1970-01-01" max={today} value={customStart} onChange={event=>setStart(event.target.value)}/></label><span>至</span><label>结束日期<input type="date" aria-label="结束日期" min="1970-01-01" max={today} value={customEnd} onChange={event=>setEnd(event.target.value)}/></label></div>}
    {selection.error && <p className="usage-notice" role="alert">{selection.error}</p>}
    <div className="usage-health" aria-label={provider.name + ' 数据来源与状态'}>
      <section><header><strong>账号额度</strong><Status state={provider.quota.state}/></header><small>{provider.quota.source} · {stamp(provider.quota.updated_at)}</small>{provider.quota.reason && <p>{provider.quota.reason}</p>}</section>
      <section><header><strong>历史消耗</strong><Status state={history.state}/></header><small>{history.source} · {stamp(history.updated_at)}</small><p>{recordedDates.length ? `${recordedDates.length} 天 · ${recordedDates[0]} 至 ${recordedDates.at(-1)}` : '尚未读到日记录'}{history.coverage_mode === 'legacy_30' && ' · 旧版近 30 天缓存'}</p></section>
      <section><header><strong>费用估算</strong></header><small>已取得可信 API 定价的日记录</small><p>{summary.priced}/{summary.selected.length} 个有记录日具备定价。订阅应付以官方账单为准。</p></section>
    </div>
    {(history.reason || !summary.selected.length || provider.quota.state !== 'ready') && <div className="usage-notice usage-health-actions"><Info size={16}/><span>{history.reason || (!summary.selected.length ? '所选日期没有日记录。' : '账号额度需要重新核对。')}{history.state === 'missing_dependency' && ' 安装步骤见 Hub README 的「用量中心」。'}</span><button className="button" disabled={data.refreshing} onClick={() => refreshRef.current?.()}>重新读取</button>{onDiagnostics && <button className="button" onClick={onDiagnostics}>查看本机诊断</button>}</div>}
    <div className="usage-metrics">
      <div><span>今日 tokens</span><strong>{count(todayRow?.total_tokens)}</strong><small>{today} · {todayRow ? '已返回记录' : '尚无日记录'}</small></div>
      <div><span>{rangeLabel}记录量</span><strong>{count(summary.total)}</strong><small>{summary.tokenDays}/{dates.length} 天有 token 记录</small></div>
      <div><span>{summary.priced<summary.selected.length?'已定价日估算小计':'API 等价费用估算'}</span><strong>{money(summary.estimate)}</strong><small>{summary.priced}/{summary.selected.length} 个有记录日具备定价</small></div>
      <div><span>输入缓存命中率</span><strong>{known(summary.hit)?`${summary.hit.toFixed(1)}%`:'—'}</strong><small>缓存读取 / 全部输入 tokens</small></div>
    </div>
    <section className="usage-panel"><header><div><h3>{provider.name} · 消耗趋势</h3><span>{dates.length?`${dates[0]} — ${dates.at(-1)}`:'待选择有效日期'} · 一天一根，短空柱是没返回的日子，不记成 0{dates.length>92?' · 更长的历史才把相邻几天并成一根，最后一根标结束日':''}</span></div><div className="segmented" role="group" aria-label="趋势指标">{[['total_tokens','Tokens'],['estimated_usd','估算费用']].map(([key,label])=><button key={key} className={metric===key?'active':''} aria-pressed={metric===key} onClick={()=>setMetric(key)}>{label}</button>)}</div></header><Trend dates={dates} daily={history.daily || []} metric={metric}/><p className="usage-fine-print">仅汇总已返回记录。估算按 API 单价换算，不代表订阅账单；缺少可信定价的日记录不计入金额。</p></section>
    <div className="usage-details-grid"><section className="usage-panel"><header><h3>Token 构成</h3><Database size={16}/></header><dl className="usage-composition"><div><dt>全部输入（含缓存）</dt><dd>{count(summary.input)}</dd></div><div><dt>其中：缓存读取</dt><dd>{count(summary.cached)}</dd></div><div><dt>输出</dt><dd>{count(summary.output)}</dd></div></dl><p className="usage-fine-print">推理 tokens 已含在输出内，不重复累加。</p></section>
    <section className="usage-panel"><header><h3>模型分布</h3><span>按已返回记录</span></header><div className="usage-models">{summary.models.length ? summary.models.map(model=><div key={model.name}><code>{model.name}</code><strong>{count(model.total_tokens)}</strong></div>) : <p className="usage-fine-print">暂无模型明细。</p>}</div></section></div>
    {known(history.metered_period?.usd) && <div className="usage-billing"><Clock3 size={17}/><span>Cursor 数据源返回的{history.metered_period.label || `近 ${history.metered_period.days} 日`}计费口径金额<strong>{money(history.metered_period.usd)}</strong><small>来源区间金额与上方日期筛选独立；订阅实际应付以官方账单为准。</small></span></div>}
    <details className="usage-provenance"><summary><ShieldCheck size={15}/>数据来源与边界<span>{stamp(history.updated_at)} 更新</span></summary><div><p>{history.source} · {history.note}</p><p>只保存规范化统计，不保存账号标识、凭据或对话正文。Codex 本机记录与 Cursor 云端记录分别展示，不跨来源合并费用。</p><p>离开此页或隐藏窗口后暂停页面定时采集；下次打开重新读取。采集失败时保留标注的旧快照，过期额度隐藏。</p><a href="https://github.com/steipete/CodexBar" target="_blank" rel="noreferrer">CodexBar</a><a href="https://github.com/ccusage/ccusage" target="_blank" rel="noreferrer">ccusage</a></div></details>
  </div>;
}
