import React, { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Save, X } from 'lucide-react';
import { blankForm, changedFields, filterRecords, sortRecords, statuses, priorities } from './ledger-model.js';
import './ledger.css';

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const requestId = () => crypto.randomUUID();

async function api(action, body) {
  const response = await fetch('/api/tracker/' + action, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let value;
  try { value = await response.json(); } catch { throw new Error('台账服务未就绪，请重新打开 Hub。'); }
  if (!response.ok) {
    const error = new Error(value.error || '台账请求失败');
    error.missing = value.missing_scopes;
    throw error;
  }
  return value;
}

function valuesOf(row) {
  return { content: row.content || '', status: row.status || '未启动', due: row.due || '', priority: row.priority || '', note: row.note || '' };
}

const statusTone = { '未启动': 'is-idle', '进行中': 'is-run', '已结束': 'is-done' };
const priorityTone = { P0: 'is-p0', P1: 'is-p1', P2: 'is-p2' };

function Pill({ tone, children }) {
  if (!children) return '—';
  return <span className={`ledger-pill ${tone || ''}`}>{children}</span>;
}

export default function LedgerPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [kind, setKind] = useState('issue');
  const [filters, setFilters] = useState({ status: 'all', priority: 'all', due: 'all' });
  const [sort, setSort] = useState('due');
  const [editor, setEditor] = useState(null);
  const mounted = useRef(true);

  async function load(action = 'snapshot') {
    setLoading(true);
    try {
      const value = await api(action, action === 'snapshot' ? undefined : {});
      if (mounted.current) { setData(value); setError(value.error || ''); }
    } catch (reason) {
      if (mounted.current) setError(reason.message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    load();
    const tick = () => { if (!document.hidden) load(); };
    const timer = setInterval(tick, 30000);
    const onFocus = () => load();
    addEventListener('focus', onFocus);
    addEventListener('ai-hub-refresh-ledger', onFocus);
    document.addEventListener('visibilitychange', tick);
    return () => { mounted.current = false; clearInterval(timer); removeEventListener('focus', onFocus); removeEventListener('ai-hub-refresh-ledger', onFocus); document.removeEventListener('visibilitychange', tick); };
  }, []);

  function openCreate() {
    setEditor({ mode: 'create', requestId: requestId(), base: blankForm(), form: blankForm() });
    setMessage('');
    setError('');
  }
  function openEdit(row) {
    const form = valuesOf(row);
    setEditor({ mode: 'edit', recordId: row.id, base: form, form });
    setMessage('');
    setError('');
  }
  function change(key, value) {
    setEditor(current => ({ ...current, form: { ...current.form, [key]: value } }));
  }
  async function save(event) {
    event.preventDefault();
    if (!editor || saving) return;
    const form = editor.form;
    const patch = editor.mode === 'edit' ? changedFields(editor.base, form) : null;
    if (patch && !Object.keys(patch).length) { setMessage('内容没有变化。'); setEditor(null); return; }
    setSaving(true);
    setError('');
    try {
      const result = editor.mode === 'create'
        ? await api('create', { kind, client_request_id: editor.requestId, content: form.content, status: form.status, due: form.due || null, priority: form.priority || null, note: form.note })
        : await api('update', { kind, record_id: editor.recordId, base: editor.base, patch });
      setData(result.snapshot);
      setEditor(null);
      setMessage(result.duplicate ? '这次提交已经写入飞书，没有重复创建。' : result.changed === false ? '内容没有变化。' : '已写入飞书，并读回最新记录。');
    } catch (reason) {
      setError(reason.missing ? `${reason.message} 表单内容仍在。` : reason.message);
    } finally {
      setSaving(false);
    }
  }

  const rows = data ? (kind === 'issue' ? data.issues : data.tasks) : [];
  const visible = sortRecords(filterRecords(rows, filters, today()), sort);
  const synced = data?.synced_at ? new Date(data.synced_at).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '尚未成功';
  const day = today();
  const label = kind === 'issue' ? '问题' : '任务';
  return <section className="ledger">
    <header className="ledger-head">
      <div>
        <div className="ledger-kicker">FEISHU BASE</div>
        <h1>问题与任务<span>.</span></h1>
        <p>飞书是主数据。打开页面和手动刷新会立即读，服务运行时大约每 30 秒再读一次。</p>
      </div>
      <div className="ledger-actions">
        {data?.base_url && <a href={data.base_url} target="_blank" rel="noreferrer">打开飞书表格</a>}
        <button type="button" onClick={() => load('refresh')} disabled={loading}><RefreshCw size={15}/>{loading ? '读取中…' : '立即刷新'}</button>
        <button type="button" className="ledger-primary" onClick={openCreate}><Plus size={15}/>新增{label}</button>
      </div>
    </header>
    {!editor && error && <div className="ledger-alert" role="alert">{error}{data?.missing_scopes?.length ? ` 缺少 ${data.missing_scopes.join('、')}。` : ''}</div>}
    {message && <div className="ledger-ok" role="status">{message}</div>}
    <div className="ledger-meta"><span>最近成功读取：{synced}</span><span>退出 Hub 后停止读取。到期只用于筛选，不会改成已结束。</span></div>
    <div className="ledger-toolbar">
      <div className="ledger-tabs" role="tablist">
        <button type="button" className={kind === 'issue' ? 'selected' : ''} onClick={() => setKind('issue')}>问题 <em>{data?.issues.length ?? ''}</em></button>
        <button type="button" className={kind === 'task' ? 'selected' : ''} onClick={() => setKind('task')}>任务 <em>{data?.tasks.length ?? ''}</em></button>
      </div>
      <div className="ledger-filters">
        <select aria-label="状态" value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value })}><option value="all">全部状态</option>{statuses.map(item => <option key={item}>{item}</option>)}</select>
        <select aria-label="优先级" value={filters.priority} onChange={event => setFilters({ ...filters, priority: event.target.value })}><option value="all">全部优先级</option><option value="none">未设优先级</option>{priorities.map(item => <option key={item}>{item}</option>)}</select>
        <select aria-label="截止" value={filters.due} onChange={event => setFilters({ ...filters, due: event.target.value })}><option value="all">全部日期</option><option value="empty">未设截止</option><option value="set">已设截止</option><option value="past">已过截止</option></select>
        <select aria-label="排序" value={sort} onChange={event => setSort(event.target.value)}><option value="due">按截止日期</option><option value="priority">按优先级</option><option value="created">按创建时间</option></select>
      </div>
    </div>
    <div className="ledger-table-wrap">
      <table>
        <thead><tr><th>内容</th><th>状态</th><th>创建时间</th><th>截止时间</th><th>优先级</th><th>备注</th></tr></thead>
        <tbody>{visible.map(row => {
          const overdue = row.due && row.due < day && row.status !== '已结束';
          return <tr key={row.id} onClick={() => openEdit(row)}>
            <td className="ledger-content">{row.content}</td>
            <td><Pill tone={statusTone[row.status]}>{row.status}</Pill></td>
            <td className="ledger-time">{row.created_at || '—'}</td>
            <td className={overdue ? 'ledger-time ledger-past' : 'ledger-time'}>{row.due || '—'}{overdue && <small>已过截止，状态未改</small>}</td>
            <td><Pill tone={priorityTone[row.priority]}>{row.priority}</Pill></td>
            <td className="ledger-note">{row.note || '—'}</td>
          </tr>;
        })}</tbody>
      </table>
      {!visible.length && <div className="ledger-empty">{data ? '当前筛选下没有记录。' : '正在读取飞书表格…'}</div>}
    </div>
    {editor && <div className="ledger-backdrop"><form className="ledger-dialog" role="dialog" aria-modal="true" aria-label={`${editor.mode === 'create' ? '新增' : '编辑'}${label}`} onSubmit={save}>
      <header className="ledger-dialog-head">
        <div><h2>{editor.mode === 'create' ? '新增' : '编辑'}{label}</h2><p>{editor.mode === 'create' ? '创建时间由飞书生成。未选的截止时间和优先级会留空。' : '只提交改过的字段。飞书若已改同一字段，本次不会覆盖。'}</p></div>
        <button type="button" className="ledger-close" aria-label="关闭" disabled={saving} onClick={() => setEditor(null)}><X size={18}/></button>
      </header>
      {error && <div className="ledger-alert" role="alert">{error}</div>}
      <div className="ledger-form">
        <label>内容<textarea required autoFocus maxLength={2000} rows={4} value={editor.form.content} onChange={event => change('content', event.target.value)} /></label>
        <div className="ledger-split">
          <label>状态<span className="ledger-choice" role="radiogroup" aria-label="状态">{statuses.map(item => <button type="button" role="radio" aria-checked={editor.form.status === item} className={editor.form.status === item ? 'selected' : ''} key={item} onClick={() => change('status', item)}>{item}</button>)}</span></label>
          <label>优先级<span className="ledger-choice" role="radiogroup" aria-label="优先级"><button type="button" role="radio" aria-checked={!editor.form.priority} className={editor.form.priority ? '' : 'selected'} onClick={() => change('priority', '')}>不设置</button>{priorities.map(item => <button type="button" role="radio" aria-checked={editor.form.priority === item} className={editor.form.priority === item ? 'selected' : ''} key={item} onClick={() => change('priority', item)}>{item}</button>)}</span></label>
          <label>截止时间<input type="date" value={editor.form.due} onChange={event => change('due', event.target.value)} /></label>
          <label>创建时间<div className="ledger-readonly">{editor.mode === 'edit' ? (rows.find(row => row.id === editor.recordId)?.created_at || '由飞书生成') : '保存后由飞书生成，不能手填'}</div></label>
        </div>
        <label>备注<textarea maxLength={2000} rows={3} value={editor.form.note} onChange={event => change('note', event.target.value)} /></label>
      </div>
      <footer className="ledger-form-actions"><span className="ledger-caption">{editor.mode === 'create' ? '新增默认是未启动。只有手动选已结束才算结束。' : '创建时间不能修改。未选的截止日期会留空。'}</span><button className="ledger-primary" disabled={saving}><Save size={15}/>{saving ? '写入中…' : '保存到飞书'}</button></footer>
    </form></div>}
  </section>;
}
