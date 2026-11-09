import React, {useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,ArrowUpRight,Check,Download,Expand,FileUp,GripVertical,RefreshCw,Save,Star,X,Database} from 'lucide-react';
import {applyOrder,moveItem} from './market-order.js';
import {buildBoard, calendarPoints, shiftDate, storeAlerts} from './market-board.js';
import './market.css';
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
const counts={downloads:'商店下载量',new_users:'新增用户',active_users:'日活跃用户',uploaded_records:'业务上传记录数',uploaded_bytes:'业务上传字节数',upload_failures:'业务上传失败次数',cohort_users:'留存批次新增人数',retained_d1:'该批次次日留存人数',retained_d7:'该批次 7 日留存人数'};
const names={channel:'商店',live_version:'线上版本名',live_code:'线上构建号',pending_version:'最新提审版本名',pending_code:'最新提审构建号',status:'当前流程状态',submitted_at:'提交日期',released_at:'上架日期',reason:'驳回原因',url:'商店 HTTPS 链接',rating:'评分（0–5）',rating_count:'评分数量',as_of:'数据核对日期',notes:'备注',date:'统计日期',source:'数据来源',external_id:'评论唯一 ID',version:'评论对应版本',body:'评论正文',...counts};
const initial={channels:{status:'unknown',as_of:today()},metrics:{channel:'all',date:today(),source:'手动核对'},reviews:{date:today(),source:'手动核对'}};
const time=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'尚未核对';
const number=v=>v==null?'—':new Intl.NumberFormat('zh-CN').format(v);
async function api(action='snapshot',body){
 const r=await fetch('/api/market/'+action,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 let v;try{v=await r.json();}catch{throw new Error('运营服务未就绪，请重新打开新版 Hub 或检查服务器。');}
 if(!r.ok)throw new Error(v.error||'运营请求失败');return v;
}
function csvValue(v){const t=String(v??'');const safe=/^[=+@\-\t\r]/.test(t)?"'"+t:t;return '"'+safe.replaceAll('"','""')+'"';}
function download(text,filename){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+text],{type:'text/csv;charset=utf-8'}));a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
const marketTabs = [['board','监控大盘'],['channels','上架进度'],['metrics','数据明细'],['reviews','用户评价'],['history','更新记录']];

export default function MarketPage({standalone=false, route, navigate}){
 const [localRoute, setLocalRoute] = useState({});
 const view = route || localRoute;
 const tab = marketTabs.some(([id]) => id === view.tab) ? view.tab : 'board';
 const days = ['7','30','90','all'].includes(view.days) ? view.days : '30';
 const detailDate = tab === 'metrics' && /^\d{4}-\d{2}-\d{2}$/.test(view.date || '') ? view.date : '';
 const connections = useRef(null);
 function go(patch) {
   const next = { ...view, ...patch };
   if (navigate) navigate(next); else setLocalRoute(next);
 }
 const [data,setData]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[kind,setKind]=useState('metrics'),[modal,setModal]=useState(null),[form,setForm]=useState({}),[base,setBase]=useState(null),[saving,setSaving]=useState(false),[csv,setCsv]=useState(''),[preview,setPreview]=useState(null),[message,setMessage]=useState('');
 const [screen,setScreen]=useState(()=>new URLSearchParams(location.search).get('display')==='1');
 const [storeOrder,setStoreOrder]=useState(()=>{try{return JSON.parse(localStorage.getItem('ai-hub-market-order'))||[];}catch{return [];}});
 const [dropStore,setDropStore]=useState(null);
 const mounted=useRef(true),fileInput=useRef();
 async function refresh(){setLoading(true);try{const v=await api();if(mounted.current){setData(v);setError('');}}catch(e){if(mounted.current)setError(e.message);}finally{if(mounted.current)setLoading(false);}}
 useEffect(()=>{mounted.current=true;refresh();const tick=()=>{if(!document.hidden)refresh();};const timer=setInterval(tick,60000);addEventListener('focus',tick);addEventListener('ai-hub-refresh-market',refresh);document.addEventListener('visibilitychange',tick);return()=>{mounted.current=false;clearInterval(timer);removeEventListener('focus',tick);removeEventListener('ai-hub-refresh-market',refresh);document.removeEventListener('visibilitychange',tick);};},[]);
 useEffect(()=>{function key(e){if(e.key==='Escape'){if(!saving)setModal(null);if(!document.fullscreenElement)setScreen(false);}}addEventListener('keydown',key);return()=>removeEventListener('keydown',key);},[saving]);
 const stores=data?.channels_map||{},statuses=data?.statuses||{};
 const orderedIds=applyOrder(Object.keys(stores),storeOrder);
 const channel = orderedIds.includes(view.channel) ? view.channel : 'all';
 const shownIds = channel === 'all' ? orderedIds : [channel];
 function moveStore(from,to){const next=moveItem(orderedIds,from,to);setStoreOrder(next);try{localStorage.setItem('ai-hub-market-order',JSON.stringify(next));}catch{/* 顺序只留在这台机器 */}}
 function dragStart(event,id){event.dataTransfer.setData('text/plain',id);event.dataTransfer.effectAllowed='move';}
 function dragOver(event,id){event.preventDefault();setDropStore(id);}
 function dragLeave(event,id){if(!event.currentTarget.contains(event.relatedTarget))setDropStore(current=>current===id?null:current);}
 function dropOn(event,id){event.preventDefault();setDropStore(null);moveStore(event.dataTransfer.getData('text/plain'),id);}
 function edit(type,row={}){setKind(type);const clean={...initial[type],...row};delete clean.updated_at;setForm(clean);setBase(data.revision);setModal('edit');setMessage('');setError('');}
 async function save(e){e.preventDefault();setSaving(true);setError('');try{const r=await api('save',{kind,row:form,revision:base});setData(r.snapshot);setModal(null);setMessage(r.changed?'已保存，并记录变更历史':'内容相同，无需更新');}catch(e){setError(e.message);}finally{setSaving(false);}}
 function beginImport(){setModal('import');setKind('metrics');setCsv('');setPreview(null);setMessage('');setError('');}
 async function importCsv(apply=false){setSaving(true);setError('');try{const r=await api('import',{kind,csv,revision:apply?preview.revision:data.revision,apply});if(apply){setData(r.snapshot);setModal(null);setMessage(`导入完成，实际更新 ${r.changed} 条记录`);}else setPreview(r);}catch(e){setError(e.message);}finally{setSaving(false);}}
 async function toggleScreen(){if(screen){setScreen(false);if(document.fullscreenElement)await document.exitFullscreen?.();}else{setScreen(true);try{await document.documentElement.requestFullscreen?.();}catch{/* WKWebView 保留宽屏布局。 */}}}
 const end = today();
 const since = days === 'all' ? '0000-00-00' : shiftDate(end, 1 - Number(days));
 const metrics = data?.metrics || [];
 const rows = metrics.filter(row => row.date >= since && row.date <= end);
 const storeRows = rows.filter(row => shownIds.includes(row.channel));
 const detailRows = (detailDate ? metrics.filter(row => row.date === detailDate) : rows)
   .filter(row => shownIds.includes(row.channel) || (!detailDate && row.channel === 'all'))
   .sort((a, b) => b.date.localeCompare(a.date));
 const reviews = (data?.reviews || []).filter(row => row.date >= since && row.date <= end && shownIds.includes(row.channel)).sort((a, b) => b.date.localeCompare(a.date));
 const trends = {};
 for (const row of storeRows) {
   if (row.downloads == null) continue;
   const day = trends[row.date] ||= { date: row.date, total: 0, parts: {} };
   day.total += row.downloads;
   day.parts[row.channel] = (day.parts[row.channel] || 0) + row.downloads;
 }
 const points = Object.values(trends).sort((a, b) => a.date.localeCompare(b.date));
 const readonly = !!data?.read_only;
 const providers = data?.collection?.providers || { oppo: data?.collection || {} };
 const collecting = Object.values(providers).some(item => item.state === 'running');
 const problems = orderedIds.filter(id => Object.hasOwn(storeAlerts, providers[id]?.state));
 const alertFocus = tab === 'channels' && view.alert === '1';
 const ready = !!data;
 useEffect(() => {
   if (!ready || !alertFocus) return;
   const card = connections.current?.querySelector('.market-provider');
   (card || connections.current)?.scrollIntoView({ block: 'nearest' });
   card?.focus({ preventScroll: true });
 }, [ready, alertFocus, channel]);
 async function collect(operation='sync',provider='oppo'){setError('');const name=stores[provider]||provider;try{const r=await api('collect',{operation,provider});setMessage(operation==='login'?`请在 ${name} 官方专用窗口完成登录；登录和数据接通状态分别核对。`:operation==='pause'?`已暂停 ${name} 定时同步`:operation==='resume'?`已启用 ${name} 每 30 分钟自动同步`:r.started?`已开始查询 ${name} 后台，完成后自动更新页面`:'该平台已有任务在运行');await refresh();}catch(e){setError(e.message);}}
 useEffect(()=>{if(!collecting)return;const timer=setInterval(refresh,3000);return()=>clearInterval(timer);},[collecting]);
 return <section className={`market ${screen?'market-screen':''} ${standalone?'market-standalone':''}`}>
  <header className="market-head"><div><h1>应用运营<span>.</span></h1><p>com.jryx.isho <span>·</span> 版本、增长与业务数据，在同一个视野里。</p></div><div className="market-actions"><button onClick={()=>{setModal('guide');setError('');}}>数据接入说明</button><button onClick={refresh} disabled={loading}><RefreshCw size={15}/>{loading?'读取中…':'刷新记录'}</button><button onClick={toggleScreen}><Expand size={15}/>{screen?'退出大屏':'大屏模式'}</button>{!screen&&!readonly&&<button className="market-primary" onClick={beginImport}><FileUp size={15}/>导入报表</button>}</div></header>
  {error&&<div className="market-alert" role="alert">{error}</div>}{message&&<div className="market-success" role="status"><Check size={15}/>{message}</div>}
  {!!problems.length && <div className="market-alert market-alert-links" role="status"><span>渠道需要处理</span>{problems.map(id => <button className="button" type="button" key={id} onClick={() => go({ tab: 'channels', channel: id, alert: '1', date: '' })}>{stores[id]} · {storeAlerts[providers[id].state]}<ArrowUpRight size={13}/></button>)}</div>}
  {data?<><div className="market-source"><span><Database size={14}/>{data.connection.label}{readonly?' · 只读':''}</span><span>读取于 {time(data.generated_at)} · 页面可见时每分钟重读</span></div>
  <div className="market-filters"><div className="market-tabs">{marketTabs.map(([id,label])=><button key={id} className={tab===id?'selected':''} onClick={()=>go({ tab: id, date: '', alert: '' })}>{label}</button>)}</div><div><select aria-label="渠道筛选" value={channel} onChange={e=>go({ channel: e.target.value, alert: '' })}><option value="all">全部商店</option>{orderedIds.map(id=><option key={id} value={id}>{stores[id]}</option>)}</select><select aria-label="日期范围" value={days} onChange={e=>go({ days: e.target.value, date: '' })}>{[['7','近 7 天'],['30','近 30 天'],['90','近 90 天'],['all','全部历史']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div></div>
  {tab==='board'&&<><MonitorBoard points={points} stores={stores} orderedIds={shownIds} channel={channel} start={days === 'all' ? points[0]?.date || end : since} end={end}
    onStore={id => go({ channel: id, alert: '' })} onDay={(date, id = channel) => go({ tab: 'metrics', date, channel: id, alert: '' })}/><ReviewStrip reviews={reviews} orderedIds={shownIds} stores={stores}/></>}
  {tab==='channels'&&<><div className="market-panel"><div className="market-section-title"><h2>渠道上架进度</h2><span>线上版本与当前提审流程分开核对</span></div><div className="market-channel-grid">{[...data.channels].filter(c=>channel==='all'||c.channel===channel).sort((a,b)=>orderedIds.indexOf(a.channel)-orderedIds.indexOf(b.channel)).map(c=><article key={c.channel} className={'market-channel'+(dropStore===c.channel?' is-drop':'')} onDragOver={e=>dragOver(e,c.channel)} onDragLeave={e=>dragLeave(e,c.channel)} onDrop={e=>dropOn(e,c.channel)}><header><button type="button" className="market-drag" draggable aria-label={'拖动调整'+stores[c.channel]+'的顺序'} onDragStart={e=>dragStart(e,c.channel)}><GripVertical size={16}/></button><div className={'market-brand '+c.channel}>{stores[c.channel].slice(0,1)}</div><h3>{stores[c.channel]}</h3><span className={'market-status '+c.status}>{statuses[c.status]}</span></header><dl><div><dt>线上版本</dt><dd>{c.live_version||'待核实'}{c.live_code!=null&&<small> ({c.live_code})</small>}</dd></div><div><dt>更新版本</dt><dd>{c.pending_version||'未记录'}{c.pending_code!=null&&<small> ({c.pending_code})</small>}</dd></div><div><dt>提交 / 上架</dt><dd>{c.submitted_at||'—'} / {c.released_at||'—'}</dd></div><div><dt>商店评分</dt><dd>{c.rating==null?'待核实':`${c.rating} / 5`}{c.rating_count!=null&&<small> · {number(c.rating_count)} 次评分</small>}</dd></div></dl>{c.reason&&<p className="market-reason">{c.reason}</p>}<p className="market-caption">核对日期：{c.as_of||'尚未提供'}<br/>保存时间：{time(c.updated_at)}</p><footer>{!readonly&&!screen&&<button onClick={()=>edit('channels',c)}>更新进度</button>}{c.url&&<a target="_blank" rel="noreferrer" href={c.url}>商店页面<ArrowUpRight size={13}/></a>}</footer></article>)}</div></div>
  <section className="market-platform-connections" aria-label="商店连接" ref={connections}><div className="market-section-title"><h2>商店连接</h2><span>拖动左侧手柄调整顺序 · 登录会话各自隔离</span></div><div className="market-provider-grid">{(alertFocus && channel === 'all' && problems.length ? problems : shownIds).map(id=>{const name=stores[id];const c=providers[id]||{state:'needs_login'};const busy=c.state==='running';const connected=!!(c.last_success||c.last_partial_success);const statusText=(({ready:'同步成功',partial:'部分同步',running:'处理中',needs_login:connected?'需要重新登录':'待登录核实',needs_adapter:'待接通数据',profile_busy:'专用窗口使用中',browser_missing:'采集浏览器缺失',read_failed:'读取失败',app_not_found:'未找到 ISHO',access_denied:'权限不足',developer_unverified:'需企业／团队权限',auth_restore_failed:'会话需重新登录',auth_key_unavailable:'钥匙串不可用',interrupted:'上次任务中断',manual:'尚未启用'})[c.state]||'待核实');const reasonText=c.reason||'请先在官方页面完成登录，再核对 ISHO 的数据权限。';return <article key={id} tabIndex={-1} className={'market-provider '+(alertFocus?'is-target ':'')+(c.state==='ready'?'is-ready':'')+(dropStore===id?' is-drop':'')} onDragOver={e=>dragOver(e,id)} onDragLeave={e=>dragLeave(e,id)} onDrop={e=>dropOn(e,id)}><header><button type="button" className="market-drag" draggable aria-label={'拖动调整'+name+'的顺序'} onDragStart={e=>dragStart(e,id)}><GripVertical size={16}/></button><strong>{name}</strong><span>{statusText}</span></header><p>{reasonText}</p>{c.last_attempt && <small>最近检查 {time(c.last_attempt)}{c.last_finished ? ` · 完成 ${time(c.last_finished)}` : ''}</small>}<small>最近完整同步 {c.last_success ? time(c.last_success) : '尚未完成'}</small>{c.last_partial_success && <small>最近部分同步 {time(c.last_partial_success)}</small>}<div className="market-actions">{!readonly&&data.connection.mode==='local'&&<><button disabled={busy} className={connected?'':'market-primary'} onClick={()=>collect('login',id)}>{busy?'处理中…':c.state==='developer_unverified'?'切换企业／团队':connected?'重新登录':'登录后台'}</button><button disabled={busy} onClick={()=>collect('sync',id)}>同步 {name}</button>{connected&&<button disabled={busy} onClick={()=>collect(c.automatic?'pause':'resume',id)}>{c.automatic?'暂停自动':'启用自动'}</button>}</>}</div>{Object.keys(c.parts||{}).length>0&&<small>{Object.entries(c.parts).map(([key,p])=>`${({channels:'版本审核',downloads:'下载',reviews:'评论'})[key]||key}：${p.state==='ok'?`已读${p.count!=null?' '+p.count+' 条':''}`:p.state==='unsupported'?'待核实':p.state==='needs_login'?'需登录':'读取失败'}`).join(' · ')}</small>}</article>;})}</div><p className="market-caption">版本、审核、下载和评论按实际权限分别核实；登录窗口打开不代表数据已接通。业务新增、日活与上传数据仍待业务接口接入。</p></section></>}
  {tab==='metrics'&&<div className="market-panel"><div className="market-section-title"><h2>数据明细</h2><div><button onClick={()=>download([data.fields.metrics.join(','),...detailRows.map(r=>data.fields.metrics.map(f=>csvValue(r[f])).join(','))].join('\r\n'),'isho-metrics.csv')}><ArrowDownToLine size={14}/>导出范围内明细</button>{!readonly&&<button className="market-primary" onClick={()=>edit('metrics')}>录入数据</button>}</div></div>{detailDate && <div className="market-date-chip"><strong>{detailDate} · {stores[channel] || '全部商店'}</strong><button className="button" onClick={() => go({ date: '' })}><X size={14}/>清除日期</button></div>}<p className="market-caption">下载量按商店记录；新增、日活和上传量使用全应用 all 口径。活跃人数不跨日期累加。空值表示未知。</p><div className="market-table-scroll"><table><thead><tr><th>日期 / 来源</th><th>范围</th>{Object.entries(counts).map(([id,n])=><th key={id}>{n}</th>)}{!readonly&&<th>操作</th>}</tr></thead><tbody>{detailRows.map(r=><tr key={r.date+r.channel}><td>{r.date}<small>{r.source}</small></td><td>{stores[r.channel]||'全应用'}</td>{Object.keys(counts).map(k=><td key={k}>{number(r[k])}</td>)}{!readonly&&<td><button onClick={()=>edit('metrics',r)}>编辑</button></td>}</tr>)}</tbody></table></div>{!detailRows.length && <Empty text={detailDate ? "该日期与渠道没有明细记录。" : "所选渠道和日期范围暂无运营记录。"}/>}</div>}
  {tab==='reviews'&&<div className="market-panel"><div className="market-section-title"><h2>用户评价</h2><span>当前已采集 {reviews.length} 条 · 样本好评为 4–5 星</span>{!readonly&&<button className="market-primary" onClick={()=>edit('reviews',{channel:channel==='all'?'oppo':channel})}>录入评论</button>}</div>{reviews.map(r=><article key={r.channel+r.external_id} className="market-review"><header><strong>{stores[r.channel]}</strong><span className="market-stars">{'★'.repeat(r.rating)}{'☆'.repeat(5-r.rating)}</span><small>{r.date} · {r.version||'版本未知'}</small>{!readonly&&<button onClick={()=>edit('reviews',r)}>编辑</button>}</header><p>{r.body||'无文字内容'}</p><small>来源：{r.source} · ID：{r.external_id}</small></article>)}{!reviews.length&&<Empty text="还没有采集到评论；这里不会用示例评论代替。"/>}</div>}
  {tab==='history'&&<div className="market-panel"><div className="market-section-title"><h2>最近 20 次数据变更</h2><span>保存与导入均保留原值，供服务端追溯</span></div>{data.history.map(r=><div className="market-history" key={r.id}><Check size={15}/><strong>{({channels:'上架进度',metrics:'数据明细',reviews:'用户评价',sync:'商店自动同步'})[r.action]}</strong><span>{time(r.at)}</span><small>{r.actor.endsWith('-collector')?(stores[r.actor.slice(0,-10)]||'商店')+' 只读采集器':r.actor==='admin'?'服务器管理员':'本机维护'}</small></div>)}{!data.history.length&&<Empty text="尚未修改运营数据。"/>}</div>}
  </>:!error&&<Empty text="正在连接运营数据…"/>}
  {modal&&<div className="market-backdrop"><section role="dialog" aria-modal="true" aria-label={modal==='guide'?'数据接入说明':modal==='edit'?'编辑运营记录':'导入运营报表'} className="market-modal"><header><h2>{modal==='guide'?'数据接入说明':modal==='edit'?'更新运营记录':'导入报表'}</h2><button aria-label="关闭运营弹窗" disabled={saving} onClick={()=>setModal(null)}><X size={18}/></button></header>{error&&<div className="market-alert" role="alert">{error}</div>}
   {modal==='guide'?<MarketGuide onImport={beginImport} readonly={readonly}/>:modal==='edit'?<form onSubmit={save}><p className="market-caption">只填写已核实的数据，未知项留空。若另一窗口已更新，保存会停止以保护已有记录。</p><div className="market-form">{data.fields[kind].map(f=><label key={f} className={['body','notes','reason'].includes(f)?'market-wide':''}>{kind==='reviews'&&f==='rating'?'评分（1–5）':names[f]}{f==='channel'?<select required value={form[f]??''} onChange={e=>setForm({...form,[f]:e.target.value})}><option value="">请选择</option>{kind==='metrics'&&<option value="all">全应用（all）</option>}{orderedIds.map(id=><option key={id} value={id}>{stores[id]}</option>)}</select>:f==='status'?<select value={form[f]??'unknown'} onChange={e=>setForm({...form,[f]:e.target.value})}>{Object.entries(statuses).map(([id,n])=><option key={id} value={id}>{n}</option>)}</select>:['body','notes','reason'].includes(f)?<textarea rows={3} value={form[f]??''} onChange={e=>setForm({...form,[f]:e.target.value})}/>:<input type={['date','as_of','submitted_at','released_at'].includes(f)?'date':f==='url'?'url':'text'} inputMode={f in counts||['rating','rating_count','live_code','pending_code'].includes(f)?'decimal':undefined} value={form[f]??''} maxLength={5000} onChange={e=>setForm({...form,[f]:e.target.value})}/>}</label>)}</div><footer><span>保存到 {data.connection.mode==='remote'?'统一运营服务器':'本机运营数据库'}</span><button disabled={saving} type="submit" className="market-primary"><Save size={15}/>{saving?'保存中…':'保存记录'}</button></footer></form>:<div className="market-import"><p>先下载模板并填入真实数据，再选择 CSV。日期采用 YYYY-MM-DD；downloads 等指标留空表示未知，不能用 0 替代。</p><label>报表类型<select value={kind} disabled={saving} onChange={e=>{setKind(e.target.value);setCsv('');setPreview(null);if(fileInput.current)fileInput.current.value='';}}>{[['channels','渠道版本与进度'],['metrics','下载、增长与业务数据'],['reviews','评分与用户评价']].map(([id,n])=><option key={id} value={id}>{n}</option>)}</select></label><div className="market-actions"><button onClick={()=>download([data.fields[kind].join(','),...data[kind].filter(r=>r.updated_at).map(r=>data.fields[kind].map(f=>csvValue(r[f])).join(','))].join('\r\n'),`isho-${kind}-records.csv`)}>导出该类现有记录</button><button onClick={()=>download(data.fields[kind].join(',')+'\r\n',`isho-${kind}-template.csv`)}><Download size={15}/>下载空白模板</button><input ref={fileInput} aria-label="选择运营 CSV 文件" type="file" accept=".csv,text/csv" disabled={saving} onChange={async e=>{const file=e.target.files[0];setPreview(null);setError('');if(!file)return;if(file.size>512*1024){setCsv('');setError('文件不能超过 512 KB');return;}setCsv(await file.text());}}/></div><p className="market-caption">使用 UTF-8 CSV；同一日期与渠道的指标作为一条完整记录更新，留空字段会保存为未知。评论按渠道与唯一 ID 去重。一次最多 2000 行，任何行校验失败则整批不写入。</p>{csv&&<button disabled={saving} onClick={()=>importCsv(false)}>预览并校验</button>}{preview&&<><p className="market-preview-note">共 {preview.count} 条，其中 {preview.replace} 条将更新已有记录。下方展示前 8 条；点击确认才会写入。</p><pre>{JSON.stringify(preview.preview,null,2)}</pre><button className="market-primary" disabled={saving} onClick={()=>importCsv(true)}>{saving?'导入中…':'确认导入这些记录'}</button></>}</div>}
  </section></div>}
 </section>;
}
function Empty({text}){return <div className="market-empty"><Database size={25}/><p>{text}</p></div>;}

function percentText(ratio) {
  const percent = Math.round(Math.abs(ratio) * 100);
  return percent === 0 ? '较前一日持平' : `较前一日${ratio < 0 ? '少' : '多'} ${percent}%`;
}

function MonitorBoard({points, stores, orderedIds, channel, start, end, onStore, onDay}) {
  const [onlyActive, setOnlyActive] = useState(false);
  const board = buildBoard(points, orderedIds);
  const days = calendarPoints(points, start, end, onlyActive);
  const latest = board.latest;
  const cover = `已记录 ${board.covered.length}/${orderedIds.length} 个渠道`;
  const note = board.change == null ? board.comparison + '，暂不计算涨跌' : percentText(board.change);
  const label = stores[channel] || '所选渠道';
  return <div className="market-board">
    <p className={'market-callout' + (board.change != null && board.change < 0 ? ' is-down' : '')} role="status">
      {latest ? <>{latest.date} · {label}下载 {number(latest.total)} 次 · {cover} · {note}。区间已记录 {number(board.total)} 次。{latest.date < end && ` 最近数据截至 ${latest.date}。`}</> : '所选范围内暂无下载记录。'}
    </p>
    <div className="market-board-stats" role="group" aria-label="按渠道查看下载">
      <button type="button" className="selected" onClick={() => latest && onDay(latest.date)} disabled={!latest}><span>{stores[channel] || '渠道合计'} · 最近记录</span><strong>{number(latest?.total)}</strong><small>{cover} · 查看明细</small></button>
      {channel !== 'all' && <button type="button" onClick={() => onStore('all')}><span>全部商店</span><small>返回渠道合计</small></button>}
      {channel === 'all' && board.stores.map(store => <button type="button" key={store.id} onClick={() => onStore(store.id)}><span><i className={'market-seg ' + store.id}/>{stores[store.id] || store.id}</span><strong>{number(store.latest)}</strong><small>{store.latest == null ? '最近日期缺少记录' : store.change == null ? '前日缺记录或为 0' : percentText(store.change)} · 区间 {number(store.total)}</small></button>)}
    </div>
    <div className="market-panel">
      <div className="market-section-title"><h2>每日下载</h2><button type="button" className="button" aria-pressed={onlyActive} onClick={() => setOnlyActive(value => !value)}>{onlyActive ? '显示完整日历' : '只看有下载的日期'}</button></div>
      {days.length ? <BoardChart days={days} orderedIds={orderedIds} onDay={onDay}/> : <p className="market-caption">所选范围暂无有下载的日期。</p>}
      <p className="market-caption">点击日期看明细。0 表示已记录零次，— 表示缺少记录。最近日期与前一天的渠道覆盖相同才计算变化。图中最多展示最近 366 天。</p>
    </div>
    {!!points.length && <div className="market-panel"><div className="market-section-title"><h2>渠道下载记录</h2><span>选日期或具体渠道查看明细</span></div><div className="market-table-scroll"><table className="market-board-table"><thead><tr><th>日期</th><th>已记录合计</th>{orderedIds.map(id => <th key={id}>{stores[id] || id}</th>)}</tr></thead><tbody>
      {[...(onlyActive ? board.active : points)].reverse().map(day => <tr key={day.date}><td><button type="button" className="market-drill" onClick={() => onDay(day.date)}>{day.date}</button></td><td>{number(day.total)}</td>{orderedIds.map(id => <td key={id}>{day.parts[id] == null ? '—' : <button type="button" className="market-drill" aria-label={day.date + ' ' + stores[id] + ' 下载明细'} onClick={() => onDay(day.date, id)}>{number(day.parts[id])}</button>}</td>)}</tr>)}
    </tbody></table></div></div>}
  </div>;
}

function BoardChart({days, orderedIds, onDay}) {
  const max = days.reduce((highest, day) => Math.max(highest, day.total || 0), 1);
  return <div className="market-board-chart">{days.map(day => {
    const covered = orderedIds.filter(id => day.parts[id] != null);
    const label = day.total == null ? '缺少记录' : `${number(day.total)} 次 · ${covered.length}/${orderedIds.length} 个渠道`;
    return <button type="button" key={day.date} className={'market-board-col ' + (day.total == null ? 'is-missing' : day.total === 0 ? 'is-zero' : '')}
      aria-label={day.date + ' ' + label} title={day.date + ' · ' + label} onClick={() => onDay(day.date)}>
      <b>{number(day.total)}</b><span className="market-trend-stack" style={{ height: day.total > 0 ? Math.max(5, day.total / max * 158) + 'px' : '4px' }}>
        {covered.filter(id => day.parts[id] > 0).map(id => <i key={id} className={'market-seg ' + id} style={{ flexGrow: day.parts[id] }}/>)}
      </span><small>{day.date.slice(5)}</small>
    </button>;
  })}</div>;
}
function ReviewStrip({reviews,orderedIds,stores}){
 const groups={};for(const review of reviews){const group=groups[review.channel]||(groups[review.channel]={n:0,pos:0,sum:0});group.n+=1;group.sum+=review.rating;if(review.rating>=4)group.pos+=1;}
 const ids=orderedIds.filter(id=>groups[id]);
 return <div className="market-panel"><div className="market-section-title"><h2>评论样本</h2><span>只统计已采集的评分，不是全店口碑</span></div>{ids.length?<ul className="market-mix">{ids.map(id=>{const group=groups[id];return <li key={id}><span className="market-mix-name"><i className={'market-seg '+id}/>{stores[id]||id}</span><b>{number(group.n)} 条</b><small>均分 {(group.sum/group.n).toFixed(1)} · 好评 {Math.round(group.pos/group.n*100)}%</small></li>;})}</ul>:<p className="market-caption">所选范围还没有评论。应用宝和荣耀目前读不到评论。</p>}</div>;
}

function MarketGuide({onImport,readonly}){
 return <div className="market-guide">
  <p><strong>OPPO、vivo、小米、应用宝支持登录后自动同步。</strong>点击对应商店的“同步”读取版本、审核和近 30 天下载量；OPPO、vivo、小米还会读分页评论。启用后本机 Hub 服务运行期间每 30 分钟同步。登录过期时重新登录该商店即可，无需反复上传报表。应用宝评论、荣耀评论，以及新增、日活、上传仍待接入。</p>
  <h3>先准备什么</h3>
  <ul><li>OPPO：首次在隔离浏览器中登录；登录态只留本机，采集器只保存运营字段，不保存账号、密钥和测试账号。</li><li>其他渠道：后续逐个平台验证登录授权与只读页面接口，再接入自动同步；CSV 保留为可选备用。</li><li>新增、活跃、留存与上传量：你们业务后台的聚合报表或只读统计接口，商店后台不能代替业务云端数据。</li></ul>
  <p>当前导入器接收 Hub 模板格式的 UTF-8 CSV，不会自动识别各平台的原始 Excel / CSV。优先使用上方各平台的独立登录入口，CSV 只作为备用导入方式。</p>
  <h3>五个平台的接入准备</h3>
  <div className="market-table-scroll"><table><thead><tr><th>平台</th><th>API 接入准备</th><th>当前可行路径与边界</th></tr></thead><tbody>
   <tr><td><a href="https://open.oppomobile.com/" target="_blank" rel="noreferrer">OPPO 后台</a></td><td>软件商店对应的 API 服务权限及客户端凭据；集成指南使用 client_id / client_secret，需在你账号中核实具体能力。</td><td>已接入本机隔离浏览器登录会话；只读查询版本、审核、每日净下载量和评论，不上传、不提审、不发布。</td></tr>
   <tr><td><a href="https://dev.vivo.com.cn/" target="_blank" rel="noreferrer">vivo 后台</a></td><td>国内商店账号的 API 管理 / 传包授权；集成指南使用 access_key / access_secret，需核对国内账号及接口范围。</td><td>使用该平台的独立登录窗口，登录后分别核对版本、审核、下载和评价查询。</td></tr>
   <tr><td><a href="https://dev.mi.com/" target="_blank" rel="noreferrer">小米后台</a></td><td>开发者账号、专用 API 私钥及平台公钥；不要重置现有密钥影响其他工具。</td><td>官方传包文档 FAQ 说明尚未开放查询审核中 / 在架应用信息和状态；包查询不等于审核状态接口，通过用户登录后台核对只读页面查询能力。</td></tr>
   <tr><td><a href="https://app.open.qq.com/" target="_blank" rel="noreferrer">应用宝后台</a></td><td>先核实该应用所属账号、应用 ID 及实际可开通的查询权限。</td><td>登录后读取线上版本，以及数据总览里的每日下载量。评论页还没有读取器。</td></tr>
   <tr><td><a href="https://developer.honor.com/cn/" target="_blank" rel="noreferrer">荣耀后台</a></td><td>荣耀开发者账号及 ISHO 所属团队的应用查询权限。</td><td>独立登录后，在管理中心的应用分发核对包名与版本，下载和评论以实际查询权限为准。</td></tr>
  </tbody></table></div>
  <h3>登录、抓包和后续维护</h3>
  <p>不需要把账号密码、短信验证码、Cookie、Token 或私钥发到聊天。若后续需浏览器辅助核对，由你在本机登录并授权只读查看；可在该范围内分析页面请求，但不能绕过验证码或保证私有接口长期稳定。手机端抓包通常也不能提供开发者后台的审核和运营报表。</p>
  <p>Hub 可继续由维护者修改来源、适配报表并构建新版 App。OPPO 定时采集器随本机 Hub 服务运行，关机或退出服务期间不采集，重新打开后到期补采。当前没有云端常驻采集服务或 App 自动升级器。Git 提交、推送、服务器部署与商店发布按各自授权执行。</p>
  <p className="market-caption">核对日期：2026-10-30。参考：<a href="https://uniapp.dcloud.io/uni-publish/config.html" target="_blank" rel="noreferrer">DCloud 发布接入指南</a> · <a href="https://dev.mi.com/distribute/doc/details?pId=1134" target="_blank" rel="noreferrer">小米官方接口与 FAQ</a> · <a href="https://open.tencent.com/" target="_blank" rel="noreferrer">腾讯官方入口</a>。文档声明不等于你账号已取得权限。</p>
  {!readonly&&<div className="market-actions"><button className="market-primary" onClick={onImport}>下载模板 / 导入 CSV</button></div>}
 </div>;
}
