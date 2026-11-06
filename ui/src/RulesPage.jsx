import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, FileText, RefreshCw, Save, AlertCircle } from 'lucide-react';
import './rules.css';

const labels = { synced: '已同步', pending: '待同步', unchecked: '待检查', conflict: '有冲突', checking: '检查中', error: '连接异常', checked: '已检查' };
async function api(path, body) {
  const r = await fetch('/api/rules' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let result;
  try { result = await r.json(); } catch { throw new Error('规则服务不可用，请重新打开新版 Hub。'); }
  if (!r.ok) throw new Error(result.error || '规则操作失败');
  return result;
}

// App 全局挂载，打开工作台、重新聚焦、切换规则/客户端均触发；服务端合并并限频。
export function RulesSync({ page }) {
  useEffect(() => {
    let alive = true;
    async function sync() {
      if (document.hidden) return;
      try { await api('/sync', {}); if (alive) dispatchEvent(new Event('ai-hub-rules-updated')); } catch { /* Rules 页面展示实际连接错误。 */ }
    }
    sync();
    addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    const timer = setInterval(sync, 60000);
    return () => { alive = false; clearInterval(timer); removeEventListener('focus', sync); document.removeEventListener('visibilitychange', sync); };
  }, [page]);
  return null;
}

export default function RulesPage({ route = {}, notify, onSaved }) {
  const routeClient = ['shared', 'cursor', 'codex'].includes(route.client) ? route.client : 'all';
  const routeDoc = route.section ? 'global' : route.document || 'global';
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(routeDoc);
  const [client, setClient] = useState(routeClient);
  const [tab, setTab] = useState('read');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [drafts, setDrafts] = useState(() => { try { return JSON.parse(localStorage.getItem('ai-hub-rule-drafts') || '{}'); } catch { return {}; } });
  useEffect(() => { try { localStorage.setItem('ai-hub-rule-drafts', JSON.stringify(drafts)); } catch { setError('浏览器草稿暂存不可用，请保存后再关闭页面。'); } }, [drafts]);
  const busy = useRef(false);
  const bodyRef = useRef(null);
  useEffect(() => {
    setSelected(routeDoc);
    setClient(routeClient);
    setTab('read');
    setQuery('');
  }, [routeDoc, routeClient, route.section]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (busy.current) return;
      busy.current = true;
      try { const value = await api(''); if (alive) setData(value); }
      catch (e) { if (alive) setError(e.message); }
      finally { busy.current = false; }
    };
    load();
    const timer = setInterval(load, 2500);
    addEventListener('ai-hub-rules-updated', load);
    return () => { alive = false; clearInterval(timer); removeEventListener('ai-hub-rules-updated', load); };
  }, []);
  const doc = data?.documents.find(d => d.id === selected);
  const cursor = data?.clients.find(client => client.id === 'cursor');
  const verified = data?.last_verified_at || data?.checked_at;
  const verifiedAt = verified ? new Date(verified).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '暂无时间记录';
  function stateTone(item) {
    return item.client === 'cursor' && item.status === 'synced' && cursor?.status !== 'checked' ? 'unchecked' : item.status;
  }
  function stateText(item) {
    if (item.status !== 'synced') return labels[item.status];
    if (item.client === 'shared') return 'Codex 已映射';
    return cursor?.status === 'checked' ? '本轮已读回' : '上次对齐';
  }
  useEffect(() => {
    if (!route.section || selected !== 'global' || tab !== 'read') return;
    const heading = [...(bodyRef.current?.querySelectorAll('h2') || [])].find(item => item.textContent.trim() === route.section);
    if (!heading) return;
    heading.tabIndex = -1;
    heading.classList.add('rules-target');
    heading.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
    return () => heading.classList.remove('rules-target');
  }, [route.section, selected, tab, doc?.source]);
  const draft = doc && drafts[doc.id];
  const value = draft?.source ?? doc?.source ?? '';
  const dirty = doc && value !== doc.source;
  const stale = draft && draft.revision !== doc?.revision;
  function edit(text) {
    setDrafts(previous => ({ ...previous, [doc.id]: { source: text, revision: draft?.revision ?? doc.revision, base: draft?.base ?? doc.source } }));
  }
  async function sync() {
    setError('');
    try { const r = await api('/sync', { force: true }); setData(r.snapshot); }
    catch(e) { setError(e.message); }
  }
  async function save() {
    if (!dirty || saving) return;
    setSaving(true); setError('');
    try {
      const result = await api('/save', { id: doc.id, source: value, revision: draft.revision });
      setData(result.snapshot);
      setDrafts(previous => { const next = { ...previous }; delete next[doc.id]; return next; });
      notify('已保存到 Hub；正在同步客户端'); onSaved?.();
    } catch(e) { setError(e.message); }
    finally { setSaving(false); }
  }
  async function resolve(choice) {
    setSaving(true); setError('');
    try {
      const result = await api('/resolve', { id: doc.id, choice, revision: doc.revision, remote_revision: doc.remote_revision });
      setData(result.snapshot); notify(choice === 'hub' ? '已选择 Hub 版本，正在重新核对并同步' : '已采用客户端版本并备份原文');
    } catch(e) { setError(e.message); }
    finally { setSaving(false); }
  }
  const docs = data?.documents.filter(d => (client === 'all' || d.client === client || d.client === 'shared') && (d.title + d.source).toLowerCase().includes(query.toLowerCase())) || [];
  return <div className="rules-workspace">
    <div className="rules-heading"><div><h2>全局规则</h2><p>保存到 Hub，Cursor 与 Codex 持续同步。</p></div><button className="button" onClick={sync} disabled={data?.running}><RefreshCw size={15} className={data?.running ? 'rules-spin' : ''}/>{data?.running ? '同步中…' : '立即检查同步'}</button></div>
    <div className="rules-clients">{data?.clients.map(c => <div key={c.id}><strong>{c.id === 'cursor' ? 'Cursor' : 'Codex'}</strong><span className={`rule-state ${c.status}`}>{labels[c.status]}</span><small>{c.message}</small>{c.id === 'cursor' && <small>最近成功核验 {verifiedAt}</small>}</div>)}</div>
    {(error || data?.error) && <div role="alert" className="rules-error"><AlertCircle size={16}/><span>{error || data.error}</span>{/辅助|自动化|权限/.test(error || data.error) && <button className="button" onClick={async () => {try {await api('/permissions', {});} catch(e) {setError(e.message);}}}>打开系统权限设置</button>}</div>}
    <div className="rules-filter"><div className="segmented">{[['all','全部'],['shared','共享'],['cursor','Cursor'],['codex','Codex']].map(([id,label]) => <button key={id} aria-pressed={client === id} className={client === id ? 'active' : ''} onClick={() => setClient(id)}>{label}</button>)}</div><input aria-label="搜索全局规则" placeholder="搜索规则内容…" value={query} onChange={e => setQuery(e.target.value)}/></div>
    <div className="rules-columns"><nav aria-label="规则来源列表">{docs.map(d => <button key={d.id} className={selected === d.id ? 'active' : ''} onClick={() => setSelected(d.id)}><FileText size={17}/><span><strong>{d.title}</strong><small>{d.client === 'shared' ? 'Cursor / Codex 共享' : d.client === 'codex' ? 'Codex 独立入口' : 'Cursor 用户规则'}{drafts[d.id] && drafts[d.id].source !== d.source ? ' · 有未保存编辑' : ''}</small></span><span className={`rule-state ${stateTone(d)}`}>{stateText(d)}</span></button>)}{!data && <p>正在读取规则…</p>}{data && !docs.length && <p>没有匹配的规则。</p>}</nav>
    <section className="rules-document">{doc && <><header><h3>{doc.title}</h3><span className={`rule-state ${stateTone(doc)}`}>{stateText(doc)}</span></header><code className="rules-path">{doc.path}</code><div className="rules-editor-tools"><div className="segmented">{[['read','阅读'],['edit','编辑'],['diff','对比']].map(([id,label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</div><button className="button primary" disabled={!dirty || saving || stale || doc.id === 'codex-entry'} onClick={save}><Save size={15}/>{saving ? '保存中…' : '保存并同步'}</button></div>
    {stale && <p className="rules-error">来源已被其他窗口修改，当前编辑已保留。请在对比页查看最新来源，再选择重新编辑。</p>}
    {doc.id !== 'codex-entry' && doc.status === 'conflict' && doc.remote !== null && doc.remote !== undefined && <div className="rules-conflict"><strong>客户端与 Hub 存在差异，自动同步已暂停。</strong><p>对比两个版本后选择；未保存编辑请先保留。</p><div><button className="button" disabled={saving || dirty} onClick={() => resolve('hub')}>使用 Hub 版本</button><button className="button" disabled={saving || dirty || doc.remote === ''} onClick={() => resolve('client')}>采用客户端版本</button><button className="button" onClick={() => setTab('diff')}>查看差异</button></div></div>}
    {doc.id === 'codex-entry' && <p className="rules-error">Codex 存在独立入口，当前仅展示以保留原文；请先对比共享正文并整合，再修复全局映射。</p>}
    <div className="rules-body" ref={bodyRef}>{tab === 'read' ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown></div> : tab === 'edit' ? <textarea spellCheck={false} aria-label="全局规则编辑器" readOnly={doc.id === 'codex-entry'} value={value} onChange={e => edit(e.target.value)}/> : <div className="rules-comparison"><div><h4>Hub 最新来源</h4><pre>{doc.source}</pre></div><div><h4>{doc.status === 'conflict' ? '客户端版本' : '当前编辑'}</h4><pre>{doc.status === 'conflict' ? doc.remote : value}</pre></div></div>}</div>
    <footer><span>{dirty ? '有未保存编辑；切换规则不会丢失。' : 'Hub 正文已保存 · 客户端状态见上方核验结果。'}</span>{draft && <button className="button" onClick={() => setDrafts(previous => {const next = {...previous};delete next[doc.id];return next;})}>丢弃当前编辑，读取最新来源</button>}</footer></>}</section></div>
    <p className="caption">打开工作台、返回窗口或切换页面会自动检查。Cursor 使用原生界面同步，需要运行中的 Cursor 及辅助功能、自动化权限，同步期间会打开 Cursor Rules；编辑中的客户端窗口会暂停同步。</p>
  </div>;
}
