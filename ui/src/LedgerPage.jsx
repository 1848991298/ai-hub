import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, RefreshCw, Save, X } from 'lucide-react';
import { blankForm, changedFields, columnWidths, cycleFacet, cycleMode, emptyFilters, filterRecords, isOverdue, ledgerColumnDefaults, nextSort, sortRecords, statuses, priorities } from './ledger-model.js';
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

function Pill({ tone, mode, onClick, children }) {
  if (!children) return '—';
  const className = `ledger-pill ${tone || ''} ${mode ? `is-${mode}` : ''}`;
  if (!onClick) return <span className={className}>{children}</span>;
  return <button type="button" className={className} aria-pressed={mode === 'include' ? 'true' : mode === 'exclude' ? 'mixed' : 'false'} onClick={event => { event.stopPropagation(); onClick(); }}>{children}</button>;
}

function SortHeader({ column, label, sort, onSort }) {
  const active = sort.key === column;
  return <button type="button" className={active ? 'is-sorted' : ''} onClick={() => onSort(column)}>{label}{active && (sort.dir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}</button>;
}

function ColumnResize({ label, value, minimum, maximum, fallback, onChange }) {
  const drag = useRef(null);
  function finish() { drag.current = null; document.body.classList.remove('is-resizing'); }
  function keyDown(event) {
    const change = { ArrowLeft: -16, ArrowRight: 16 }[event.key];
    if (change !== undefined || ['Home', 'End', 'Enter'].includes(event.key)) {
      event.preventDefault();
      onChange(event.key === 'Home' ? minimum : event.key === 'End' ? maximum : event.key === 'Enter' ? fallback : Math.min(maximum, Math.max(minimum, value + change)));
    }
  }
  return <div role="separator" aria-orientation="vertical" aria-label={`调整${label}列宽`} aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={value} tabIndex={0} title="拖动调整列宽 · 双击恢复" className="ledger-col-resize"
    onKeyDown={keyDown} onDoubleClick={() => onChange(fallback)} onClick={event => event.stopPropagation()}
    onPointerDown={event => { if (!event.isPrimary || event.button !== 0) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { pointer: event.pointerId, x: event.clientX, width: value }; document.body.classList.add('is-resizing'); }}
    onPointerMove={event => { const start = drag.current; if (start?.pointer === event.pointerId) onChange(Math.min(maximum, Math.max(minimum, Math.round(start.width + event.clientX - start.x)))); }}
    onPointerUp={event => { if (drag.current?.pointer === event.pointerId) { event.currentTarget.releasePointerCapture(event.pointerId); finish(); } }}
    onPointerCancel={finish} onLostPointerCapture={finish} />;
}

const columnOrder = ['content', 'status', 'created', 'due', 'priority', 'note'];
const columnLabels = { content: '内容', status: '状态', created: '创建时间', due: '截止时间', priority: '优先级', note: '备注' };
const columnLimits = { content: [160, 720], status: [88, 200], created: [128, 260], due: [128, 280], priority: [84, 180], note: [120, 560] };

export default function LedgerPage({ sinkDone = true }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [kind, setKind] = useState('issue');
  const [filters, setFilters] = useState(emptyFilters);
  const [sort, setSort] = useState({ key: 'due', dir: 'asc' });
  const [widths, setWidths] = useState(() => { try { return columnWidths(JSON.parse(localStorage.getItem('ai-hub-ledger-columns'))); } catch { return columnWidths(); } });
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

  useEffect(() => { try { localStorage.setItem('ai-hub-ledger-columns', JSON.stringify(widths)); } catch { /* 本窗口仍可使用当前列宽。 */ } }, [widths]);

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

  function setFacet(group, value) {
    setFilters(current => ({ ...current, [group]: cycleFacet(current[group], value) }));
  }
  function clearFacet(group, value) {
    setFilters(current => {
      const next = { ...current[group] };
      delete next[value];
      return { ...current, [group]: next };
    });
  }
  const day = today();
  const rows = data ? (kind === 'issue' ? data.issues : data.tasks) : [];
  const visible = sortRecords(filterRecords(rows, filters, day), sort, sinkDone);
  const tableWidth = columnOrder.reduce((sum, key) => sum + widths[key], 0);
  const counts = {
    status: Object.fromEntries(statuses.map(item => [item, rows.filter(row => row.status === item).length])),
    priority: Object.fromEntries(priorities.map(item => [item, rows.filter(row => row.priority === item).length])),
    overdue: rows.filter(row => isOverdue(row, day)).length,
  };
  const chips = [
    ...Object.entries(filters.status).map(([value, mode]) => ({ key: `status-${value}`, label: `${mode === 'exclude' ? '排除' : '只看'} ${value}`, clear: () => clearFacet('status', value) })),
    ...Object.entries(filters.priority).map(([value, mode]) => ({ key: `priority-${value}`, label: `${mode === 'exclude' ? '排除' : '只看'} ${value}`, clear: () => clearFacet('priority', value) })),
    ...(filters.overdue ? [{ key: 'overdue', label: filters.overdue === 'exclude' ? '排除已过截止' : '只看已过截止', clear: () => setFilters(current => ({ ...current, overdue: null })) }] : []),
  ];
  const synced = data?.synced_at ? new Date(data.synced_at).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '尚未成功';
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
    <section className="ledger-overview" aria-label={`${label}总览`}>
      <div className="ledger-stat-row">
        {statuses.map(item => <button key={item} type="button" className={`ledger-stat ${filters.status[item] ? `is-${filters.status[item]}` : ''}`} aria-pressed={filters.status[item] ? 'true' : 'false'} onClick={() => setFacet('status', item)}><strong>{counts.status[item]}</strong><small>{item}</small></button>)}
        {priorities.map(item => <button key={item} type="button" className={`ledger-stat ${filters.priority[item] ? `is-${filters.priority[item]}` : ''}`} aria-pressed={filters.priority[item] ? 'true' : 'false'} onClick={() => setFacet('priority', item)}><strong>{counts.priority[item]}</strong><small>{item}</small></button>)}
        <button type="button" className={`ledger-stat ${filters.overdue ? `is-${filters.overdue}` : ''}`} aria-pressed={filters.overdue ? 'true' : 'false'} onClick={() => setFilters(current => ({ ...current, overdue: cycleMode(current.overdue) }))}><strong>{counts.overdue}</strong><small>已过截止</small></button>
      </div>
      {!!chips.length && <div className="ledger-chips">{chips.map(chip => <button key={chip.key} type="button" className="ledger-chip" onClick={chip.clear}>{chip.label}<X size={13} /></button>)}<button type="button" className="ledger-chip is-clear" onClick={() => setFilters(emptyFilters())}>清除筛选</button></div>}
    </section>
    <div className="ledger-toolbar">
      <div className="ledger-tabs" role="tablist">
        <button type="button" className={kind === 'issue' ? 'selected' : ''} onClick={() => setKind('issue')}>问题 <em>{data?.issues.length ?? ''}</em></button>
        <button type="button" className={kind === 'task' ? 'selected' : ''} onClick={() => setKind('task')}>任务 <em>{data?.tasks.length ?? ''}</em></button>
      </div>
      <span className="ledger-caption">数字和标签点一下只看，再点排除，第三次取消。点表头切换排序。{sinkDone ? '已结束排在底部。' : '已结束按表头排序。'}拖动列边调整宽度。</span>
    </div>
    <div className="ledger-table-wrap">
      <table style={{ width: tableWidth, minWidth: '100%' }}>
        <colgroup>{columnOrder.map(key => <col key={key} style={{ width: widths[key] }} />)}</colgroup>
        <thead><tr>
          {columnOrder.map(key => <th key={key} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} style={{ width: widths[key] }}>
            {key === 'content' || key === 'note' ? columnLabels[key] : <SortHeader column={key} label={columnLabels[key]} sort={sort} onSort={column => setSort(current => nextSort(current, column))} />}
            <ColumnResize label={columnLabels[key]} value={widths[key]} minimum={columnLimits[key][0]} maximum={columnLimits[key][1]} fallback={ledgerColumnDefaults[key]} onChange={value => setWidths(current => columnWidths({ ...current, [key]: value }))} />
          </th>)}
        </tr></thead>
        <tbody>{visible.map(row => {
          const overdue = isOverdue(row, day);
          return <tr key={row.id} onClick={() => openEdit(row)}>
            <td className="ledger-content">{row.content}</td>
            <td><Pill tone={statusTone[row.status]} mode={filters.status[row.status]} onClick={() => setFacet('status', row.status)}>{row.status}</Pill></td>
            <td className="ledger-time">{row.created_at || '—'}</td>
            <td className={overdue ? 'ledger-time ledger-past' : 'ledger-time'}>{row.due || '—'}{overdue && <small>已过截止，状态未改</small>}</td>
            <td><Pill tone={priorityTone[row.priority]} mode={filters.priority[row.priority]} onClick={row.priority ? () => setFacet('priority', row.priority) : undefined}>{row.priority}</Pill></td>
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
