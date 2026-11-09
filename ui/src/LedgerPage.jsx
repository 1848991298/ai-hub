import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ClipboardList, Columns3, GripVertical, Plus, RefreshCw, Save, X } from 'lucide-react';
import { blankForm, changedFields, columnSequence, columnWidths, cycleFacet, cycleMode, emptyFilters, fillColumnWidths, filterRecords, isOverdue, knownTags, ledgerColumnDefaults, ledgerColumnLimits, ledgerColumnOrder, moveItem, nextSort, orderedRows, sortRecords, statuses, priorities, stretchLastColumn } from './ledger-model.js';
import TaskContext from './TaskContext.jsx';
import './ledger.css';

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const shortClock = value => value ? value.replace(/^\d{4}-/, '') : '—';
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
  return { content: row.content || '', status: row.status || '未启动', due: row.due || '', priority: row.priority || '', note: row.note || '', tags: row.tags || [] };
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
  const active = sort?.key === column;
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

const columnLabels = { content: '内容', status: '状态', due: '截止时间', priority: '优先级', tags: '标签', created: '创建时间', note: '备注' };
const sortableColumns = ['status', 'created', 'due', 'priority'];
const rowIndexWidth = 56;

function savedValue(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function ColumnLayout({ columns, widths, onWidth, onFit, onMove, onReset }) {
  return <details className="ledger-column-layout">
    <summary><Columns3 size={15}/>列布局</summary>
    <div className="ledger-column-panel">
      <header><strong>列顺序</strong><button type="button" onClick={onReset}>恢复默认</button></header>
      <ol>{columns.map((key, index) => <li key={key}>
        <span>{columnLabels[key]}</span>
        <input type="number" aria-label={`${columnLabels[key]}列宽像素`} min={ledgerColumnLimits[key][0]} max={ledgerColumnLimits[key][1]} value={widths[key]} disabled={index === columns.length - 1} title={index === columns.length - 1 ? '末列自动填充剩余空间' : undefined} onChange={e => onWidth(key, Number(e.target.value))}/><small>{index === columns.length - 1 ? '自动' : 'px'}</small>
        <button type="button" aria-label={`将${columnLabels[key]}左移`} disabled={index === 0} onClick={() => onMove(key, columns[index - 1], false)}><ArrowUp size={15}/></button>
        <button type="button" aria-label={`将${columnLabels[key]}右移`} disabled={index === columns.length - 1} onClick={() => onMove(key, columns[index + 1], true)}><ArrowDown size={15}/></button>
      </li>)}</ol>
      <button type="button" className="button" onClick={onFit}>适应当前窗口</button><p>拖动或输入像素后保留前面各列宽度，末列自动补齐余量；放不下时表内横向滚动。调整列序后，由新的末列接管补齐。</p>
    </div>
  </details>;
}

export default function LedgerPage({ sinkDone = true, route = {}, projects = [], navigate }) {
  const kind = ['issue', 'task', 'all'].includes(route.kind) ? route.kind : 'issue';
  const recordId = route.record || '';
  const overdueMode = route.overdue === '1' ? 'include' : route.overdue === 'exclude' ? 'exclude' : null;
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState(() => localStorage.getItem('ai-hub-ledger-view') === 'board' ? 'board' : 'list');
  const [tagDraft, setTagDraft] = useState('');
  const [order, setOrder] = useState(() => savedValue('ai-hub-ledger-order') || {});
  const [floatBox, setFloatBox] = useState(null);
  const [taggingId, setTaggingId] = useState(null);
  const [rowTag, setRowTag] = useState('');
  const tagCommit = useRef(false);
  const [filters, setFilters] = useState(() => ({ ...emptyFilters(), overdue: overdueMode }));
  const [contextRow, setContextRow] = useState(null);
  useEffect(() => {
    setFilters({ ...emptyFilters(), overdue: overdueMode });
  }, [recordId]);
  useEffect(() => { setFilters(current => ({ ...current, overdue: overdueMode })); }, [overdueMode]);
  const [sort, setSort] = useState({ key: 'due', dir: 'asc' });
  const [widths, setWidths] = useState(() => columnWidths(savedValue('ai-hub-ledger-columns')));
  const [columnOrder, setColumns] = useState(() => columnSequence(savedValue('ai-hub-ledger-column-order')));
  const [widthMode, setWidthMode] = useState(() => savedValue('ai-hub-ledger-width-mode') === 'manual' ? 'manual' : 'fill');
  const [tableViewport, setTableViewport] = useState(0);
  const [columnTarget, setColumnTarget] = useState(null);
  const [rowTarget, setRowTarget] = useState(null);
  const tableScroll = useRef(null);
  const columnDrag = useRef(null);
  const rowDrag = useRef(null);
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
  useEffect(() => { try { localStorage.setItem('ai-hub-ledger-width-mode', JSON.stringify(widthMode)); } catch {} }, [widthMode]);
  useEffect(() => { try { localStorage.setItem('ai-hub-ledger-column-order', JSON.stringify(columnOrder)); } catch { /* 本窗口仍可使用当前列序。 */ } }, [columnOrder]);
  useEffect(() => {
    const scroll = tableScroll.current;
    if (!scroll) return;
    const measure = () => setTableViewport(scroll.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [view]);

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

  function chooseKind(next) {
    navigate?.({ kind: next, overdue: route.overdue });
  }
  function changeOverdue(next) {
    setFilters(current => ({ ...current, overdue: next }));
    navigate?.({ kind, record: recordId, overdue: next === 'include' ? '1' : next });
  }
  function clearFilters() {
    setFilters(emptyFilters());
    if (recordId || route.overdue) navigate?.({ kind });
  }
  function openCreate(target = kind) {
    setEditor({ mode: 'create', kind: target, requestId: requestId(), base: blankForm(), form: blankForm() });
    setMessage('');
    setError('');
  }
  function openEdit(row) {
    const form = valuesOf(row);
    setEditor({ mode: 'edit', kind: row.kind || kind, recordId: row.id, base: form, form });
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
        ? await api('create', { kind: editor.kind, client_request_id: editor.requestId, content: form.content, status: form.status, due: form.due || null, priority: form.priority || null, note: form.note, tags: form.tags })
        : await api('update', { kind: editor.kind, record_id: editor.recordId, base: editor.base, patch });
      setData(result.snapshot);
      setEditor(null);
      setMessage(result.duplicate ? '这次提交已经写入飞书，没有重复创建。' : result.changed === false ? '内容没有变化。' : '已写入飞书，并读回最新记录。');
    } catch (reason) {
      setError(reason.missing ? `${reason.message} 表单内容仍在。` : reason.message);
    } finally {
      setSaving(false);
    }
  }

  function chooseView(next) {
    setView(next);
    try { localStorage.setItem('ai-hub-ledger-view', next); } catch { /* 这次窗口仍用当前视图。 */ }
  }
  async function moveStatus(row, status) {
    if (saving || row.status === status) return;
    setSaving(true);
    setError('');
    try {
      const result = await api('update', { kind: row.kind || kind, record_id: row.id, base: valuesOf(row), patch: { status } });
      setData(result.snapshot);
      setMessage(`已改为${status}，并读回飞书。`);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setSaving(false);
    }
  }
  function toggleTag(name) {
    setEditor(current => {
      const tags = current.form.tags.includes(name) ? current.form.tags.filter(item => item !== name) : [...current.form.tags, name];
      return { ...current, form: { ...current.form, tags } };
    });
  }
  function saveOrder(ids, manual = true) {
    const saved = { ...order, [kind]: { ids, manual } };
    setOrder(saved);
    try { localStorage.setItem('ai-hub-ledger-order', JSON.stringify(saved)); } catch { /* 顺序只留在这台电脑。 */ }
  }
  function sortByColumn(key) {
    if (manualOrder) saveOrder(manualIds, false);
    setSort(current => nextSort(manualOrder ? {} : current, key));
  }
  function moveColumn(from, to, after) {
    if (widthMode === 'manual') setWidths(columnWidths({ ...widths, ...fittedWidths }));
    setColumns(current => moveItem(current, from, to, after));
  }
  function resetColumns() {
    setColumns(ledgerColumnOrder);
    setWidths(columnWidths());
    setWidthMode('fill');
  }
  function resizeColumn(key, value) {
    if (key === columns.at(-1)) return;
    setWidths(columnWidths({ ...widths, ...fittedWidths, [key]: value }));
    setWidthMode('manual');
  }
  function columnDrop(event, key) {
    if (!columnDrag.current || columnDrag.current === key) return null;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const box = event.currentTarget.getBoundingClientRect();
    return { key, after: event.clientX >= box.left + box.width / 2 };
  }
  function rowDrop(event, row) {
    const from = rowDrag.current;
    if (!allowReorder || !from || from.id === row.id || (sinkDone && from.done !== (row.status === '已结束'))) return null;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const box = event.currentTarget.getBoundingClientRect();
    return { key: row.id, after: event.clientY >= box.top + box.height / 2 };
  }
  function openFloat(event, next) {
    event.stopPropagation();
    const box = event.currentTarget.getBoundingClientRect();
    const above = box.top - 8;
    const below = window.innerHeight - box.bottom - 8;
    const openAbove = below < 240 && above > below;
    const position = openAbove ? { bottom: window.innerHeight - above, maxHeight: above - 8 } : { top: box.bottom + 8, maxHeight: below - 8 };
    setFloatBox({ ...next, position: { ...position, left: Math.max(12, Math.min(box.left, window.innerWidth - 352)) } });
  }
  function beginRowTag(event, row) {
    event.stopPropagation();
    tagCommit.current = false;
    setTaggingId(row.id);
    setRowTag('');
  }
  function rowTagText(row) {
    const owned = (row.tags || []).filter(tag => typeof tag === 'string' && tag.trim());
    if (owned.length) return owned.join('、');
    return knownTags(data).length ? '这一行还没有标签。点下面已有标签即可复用，或输入新名称后回车。' : '还没有标签。在下面输入名称，回车写入飞书。';
  }
  async function commitRowTag(row, explicitName) {
    if (tagCommit.current) return;
    tagCommit.current = true;
    const name = (explicitName == null ? rowTag : explicitName).trim();
    setTaggingId(null);
    setRowTag('');
    if (!name || (row.tags || []).includes(name)) return;
    setSaving(true);
    setError('');
    try {
      const result = await api('update', { kind: row.kind || kind, record_id: row.id, base: valuesOf(row), patch: { tags: [...(row.tags || []), name] } });
      setData(result.snapshot);
      setMessage(`已加上标签「${name}」，并写回飞书。`);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setSaving(false);
    }
  }
  function addTag(event) {
    event.preventDefault();
    const name = tagDraft.trim();
    if (!name) return;
    setTagDraft('');
    setEditor(current => current.form.tags.includes(name) ? current : { ...current, form: { ...current.form, tags: [...current.form.tags, name] } });
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
  const issues = data?.issues || [];
  const tasks = data?.tasks || [];
  const rows = kind === 'all' ? [...issues, ...tasks] : kind === 'issue' ? issues : tasks;
  const supportsTags = rowKind => data?.tag_fields?.[rowKind] !== false;
  const showTagColumn = kind === 'all' ? supportsTags('issue') || supportsTags('task') : supportsTags(kind);
  const columns = showTagColumn ? columnOrder : columnOrder.filter(key => key !== 'tags');
  const allowReorder = kind !== 'all' && !recordId;
  const savedOrder = order[kind];
  const manualIds = Array.isArray(savedOrder) ? savedOrder : Array.isArray(savedOrder?.ids) ? savedOrder.ids : [];
  const manualOrder = allowReorder && manualIds.length > 0 && savedOrder?.manual !== false;
  const sorted = manualOrder ? orderedRows(rows, manualIds, sinkDone) : sortRecords(rows, sort, sinkDone);
  const scopedRows = recordId ? sorted.filter(row => row.id === recordId) : sorted;
  const visible = filterRecords(scopedRows, filters, day);
  const availableWidth = Math.max(0, tableViewport - rowIndexWidth);
  const fittedWidths = widthMode === 'fill' ? fillColumnWidths(availableWidth, columns) : stretchLastColumn(widths, availableWidth, columns);
  const tableWidth = columns.reduce((sum, key) => sum + fittedWidths[key], rowIndexWidth);
  const counts = {
    status: Object.fromEntries(statuses.map(item => [item, rows.filter(row => row.status === item).length])),
    priority: Object.fromEntries(priorities.map(item => [item, rows.filter(row => row.priority === item).length])),
    overdue: rows.filter(row => isOverdue(row, day)).length,
  };
  const chips = [
    ...Object.entries(filters.status).map(([value, mode]) => ({ key: `status-${value}`, label: `${mode === 'exclude' ? '排除' : '只看'} ${value}`, clear: () => clearFacet('status', value) })),
    ...Object.entries(filters.priority).map(([value, mode]) => ({ key: `priority-${value}`, label: `${mode === 'exclude' ? '排除' : '只看'} ${value}`, clear: () => clearFacet('priority', value) })),
    ...Object.entries(filters.tags || {}).map(([value, mode]) => ({ key: `tag-${value}`, label: `${mode === 'exclude' ? '排除' : '含'} ${value}`, clear: () => clearFacet('tags', value) })),
    ...(filters.overdue ? [{ key: 'overdue', label: filters.overdue === 'exclude' ? '排除已过截止' : '只看已过截止', clear: () => changeOverdue(null) }] : []),
  ];
  const synced = data?.synced_at ? new Date(data.synced_at).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '尚未成功';
  const label = { issue: '问题', task: '任务', all: '全部记录' }[kind];
  const editorLabel = editor?.kind === 'task' ? '任务' : '问题';
  function contextButton(row) {
    return <button type="button" className="ledger-context-trigger" title="查看执行资料" aria-label={'执行资料 · ' + row.content} onClick={event => { event.stopPropagation(); setContextRow(row); }}><ClipboardList size={15}/></button>;
  }
  const tagOptions = showTagColumn ? [...new Set([...(data?.tag_options || []), ...rows.flatMap(row => row.tags || []), ...(editor?.form.tags || [])])] : [];
  const reusableTags = knownTags(data);
  const floatRow = floatBox?.rowId ? rows.find(item => item.id === floatBox.rowId) : null;
  const floatTags = floatRow?.tags || [];
  function reuseRowTag(name) {
    if (!floatRow || floatTags.includes(name)) return;
    commitRowTag(floatRow, name);
    setFloatBox(null);
  }
  const tagCounts = Object.fromEntries(tagOptions.map(tag => [tag, rows.filter(row => (row.tags || []).includes(tag)).length]));
  function renderCell(key, row) {
    const overdue = isOverdue(row, day);
    const tags = row.tags || [];
    switch (key) {
      case 'content': return <td key={key}>
        <div className="ledger-content">
          {kind === 'all' && <small className="ledger-row-kind">{row.kind === 'task' ? '任务' : '问题'}</small>}
          <button type="button" className="ledger-row-title" title={row.content} onClick={event => { event.stopPropagation(); openEdit(row); }}>{row.content}</button>
          {contextButton(row)}
        </div>
      </td>;
      case 'tags': if (!supportsTags(row.kind)) return <td key={key}>—</td>; return <td key={key}>
        <div className="ledger-tag-cell">
          {tags.length > 0 && <Pill tone="is-tag" mode={(filters.tags || {})[tags[0]]} onClick={() => setFacet('tags', tags[0])}><span title={tags[0]}>{tags[0]}</span></Pill>}
          <button type="button" className="ledger-tag-more" aria-label={tags.length > 1 ? '查看全部标签' : '添加标签'} title={tags.length > 1 ? tags.join('、') : '添加标签'} onClick={event => {
            setRowTag('');
            tagCommit.current = false;
            openFloat(event, { title: '标签', rowId: row.id, text: rowTagText(row) });
          }}>{tags.length > 1 ? `+${tags.length - 1}` : <Plus size={14}/>}</button>
        </div>
      </td>;
      case 'status': return <td key={key}><Pill tone={statusTone[row.status]} mode={filters.status[row.status]} onClick={() => setFacet('status', row.status)}>{row.status}</Pill></td>;
      case 'created': return <td key={key} className="ledger-time" title={row.created_at || undefined}>{shortClock(row.created_at)}</td>;
      case 'due': return <td key={key} className={overdue ? 'ledger-time ledger-past' : 'ledger-time'} title={overdue ? `${row.due} · 逾期` : undefined}>{row.due || '—'}{overdue && <span className="ledger-overdue-dot" aria-label="逾期" />}</td>;
      case 'priority': return <td key={key}><Pill tone={priorityTone[row.priority]} mode={filters.priority[row.priority]} onClick={row.priority ? () => setFacet('priority', row.priority) : undefined}>{row.priority}</Pill></td>;
      case 'note': return <td key={key} className="ledger-note">{row.note ? <button type="button" className="ledger-note-text" title={row.note} onClick={event => openFloat(event, { title: '备注', text: row.note })}>{row.note}</button> : '—'}</td>;
      default: return null;
    }
  }
  return <section className="ledger">
    <header className="ledger-head">
      <div>
        <h1>问题与任务<span>.</span></h1>
        <p>飞书是主数据。打开页面和手动刷新会立即读，服务运行时大约每 30 秒再读一次。</p>
      </div>
      <div className="ledger-actions">
        {data?.base_url && <a href={data.base_url} target="_blank" rel="noreferrer">打开飞书表格</a>}
        <button type="button" onClick={() => load('refresh')} disabled={loading}><RefreshCw size={15}/>{loading ? '读取中…' : '立即刷新'}</button>
        {(kind === 'all' ? ['issue', 'task'] : [kind]).map(target => <button type="button" className="ledger-primary" key={target} onClick={() => openCreate(target)}><Plus size={15}/>新增{target === 'issue' ? '问题' : '任务'}</button>)}
      </div>
    </header>
    {!editor && error && <div className="ledger-alert" role="alert">{error}{data?.missing_scopes?.length ? ` 缺少 ${data.missing_scopes.join('、')}。` : ''}</div>}
    {message && <div className="ledger-ok" role="status">{message}</div>}
    <div className="ledger-meta"><span>最近成功读取：{synced}</span><span>退出 Hub 后停止读取。到期只用于筛选，不会改成已结束。</span></div>
    <section className="ledger-overview" aria-label={`${label}总览`}>
      <div className="ledger-stat-row">
        {statuses.map(item => <button key={item} type="button" className={`ledger-stat ${filters.status[item] ? `is-${filters.status[item]}` : ''}`} aria-pressed={filters.status[item] ? 'true' : 'false'} onClick={() => setFacet('status', item)}><strong>{counts.status[item]}</strong><small>{item}</small></button>)}
        {priorities.map(item => <button key={item} type="button" className={`ledger-stat ${filters.priority[item] ? `is-${filters.priority[item]}` : ''}`} aria-pressed={filters.priority[item] ? 'true' : 'false'} onClick={() => setFacet('priority', item)}><strong>{counts.priority[item]}</strong><small>{item}</small></button>)}
        <button type="button" className={`ledger-stat ${filters.overdue ? `is-${filters.overdue}` : ''}`} aria-pressed={filters.overdue ? 'true' : 'false'} onClick={() => changeOverdue(cycleMode(filters.overdue))}><strong>{counts.overdue}</strong><small>已过截止</small></button>
      </div>
      {!!tagOptions.length && <div className="ledger-chips" aria-label="标签">{tagOptions.map(tag => <button key={tag} type="button" className={`ledger-chip ${(filters.tags || {})[tag] ? `is-${(filters.tags || {})[tag]}` : ''}`} aria-pressed={(filters.tags || {})[tag] ? 'true' : 'false'} onClick={() => setFacet('tags', tag)}>{tag}<em>{tagCounts[tag] || 0}</em></button>)}</div>}
      {(!!chips.length || recordId) && <div className="ledger-chips">{recordId && <button type="button" className="ledger-chip" onClick={() => navigate?.({ kind, overdue: route.overdue })}>搜索定位到的记录<X size={13}/></button>}{chips.map(chip => <button key={chip.key} type="button" className="ledger-chip" onClick={chip.clear}>{chip.label}<X size={13} /></button>)}<button type="button" className="ledger-chip is-clear" onClick={clearFilters}>清除筛选</button></div>}
    </section>
    <div className="ledger-toolbar">
      <div className="ledger-toolbar-group">
        <div className="ledger-tabs" role="group" aria-label="记录类型">
          {[['all', '全部', issues.length + tasks.length], ['issue', '问题', issues.length], ['task', '任务', tasks.length]].map(([id, name, size]) => <button type="button" key={id} aria-pressed={kind === id} className={kind === id ? 'selected' : ''} onClick={() => chooseKind(id)}>{name} <em>{data ? size : ''}</em></button>)}
        </div>
        <div className="ledger-tabs" role="group" aria-label="视图">
          <button type="button" aria-pressed={view === 'list'} className={view === 'list' ? 'selected' : ''} onClick={() => chooseView('list')}>列表</button>
          <button type="button" aria-pressed={view === 'board'} className={view === 'board' ? 'selected' : ''} onClick={() => chooseView('board')}>看板</button>
        </div>
      </div>
      <div className="ledger-toolbar-group ledger-toolbar-actions">
        <span className="ledger-result-count" aria-live="polite">{data ? <>显示 <strong>{visible.length}</strong> / {rows.length} 条</> : '读取中…'}</span>
        {view === 'board' ? <span className="ledger-caption">拖到另一列可改状态</span> : <>
          {allowReorder && manualIds.length > 0 && <button type="button" className="ledger-layout-button" aria-pressed={manualOrder} onClick={() => saveOrder(manualIds, !manualOrder)}>手动行序</button>}
          <div className="ledger-tabs ledger-width-mode" role="group" aria-label="表格宽度模式"><button type="button" aria-pressed={widthMode === 'fill'} className={widthMode === 'fill' ? 'selected' : ''} onClick={() => setWidthMode('fill')}>适应窗口</button><button type="button" aria-pressed={widthMode === 'manual'} className={widthMode === 'manual' ? 'selected' : ''} onClick={() => setWidthMode('manual')}>手动列宽</button></div>
          <ColumnLayout widths={fittedWidths} onWidth={resizeColumn} onFit={() => setWidthMode('fill')} columns={columns} onMove={moveColumn} onReset={resetColumns}/>
        </>}
      </div>
    </div>
    {view === 'board' ? <div className="ledger-board">{statuses.map(status => <section key={status} className="ledger-column" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const id = event.dataTransfer.getData('text/plain'); const row = visible.find(item => item.id === id); if (row) moveStatus(row, status); }}>
      <header><strong>{status}</strong><em>{visible.filter(row => row.status === status).length}</em></header>
      {visible.filter(row => row.status === status).map(row => <article key={row.id} draggable={!saving} onDragStart={event => { event.dataTransfer.setData('text/plain', row.id); event.dataTransfer.effectAllowed = 'move'; }} onClick={() => openEdit(row)}>
        <h3>{row.content}</h3>{kind === 'all' && <small className="ledger-row-kind">{row.kind === 'task' ? '任务' : '问题'}</small>}
        {supportsTags(row.kind) && <div className="ledger-card-tags" onClick={event => event.stopPropagation()}>{(row.tags || []).map(tag => <button key={tag} type="button" className={`ledger-pill is-tag ${(filters.tags || {})[tag] ? `is-${(filters.tags || {})[tag]}` : ''}`} onClick={() => setFacet('tags', tag)}>{tag}</button>)}{taggingId === row.id ? <input className="ledger-tag-input" aria-label="新标签" autoFocus value={rowTag} maxLength={16} placeholder="输入标签" onChange={event => setRowTag(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitRowTag(row); } if (event.key === 'Escape') { tagCommit.current = true; setTaggingId(null); } }} onBlur={() => commitRowTag(row)} /> : <button type="button" className="ledger-add-tag" onClick={event => beginRowTag(event, row)}>+ 标签</button>}</div>}
        <footer><Pill tone={priorityTone[row.priority]}>{row.priority}</Pill><span className={isOverdue(row, day) ? 'ledger-past' : ''}>{row.due || '无截止'}</span>{contextButton(row)}</footer>
      </article>)}
    </section>)}</div> : <div className="ledger-table-wrap" ref={tableScroll} role="region" aria-label="台账列表" tabIndex={0}>
      <table style={{ width: tableWidth }}>
        <colgroup><col style={{ width: rowIndexWidth }}/>{columns.map(key => <col key={key} style={{ width: fittedWidths[key] }}/>)}</colgroup>
        <thead><tr>
          <th scope="col" className="ledger-index" aria-label="行号">#</th>
          {columns.map(key => <th key={key} scope="col" data-column={key}
            aria-sort={!manualOrder && sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
            className={columnTarget?.key === key ? (columnTarget.after ? 'drop-after' : 'drop-before') : undefined}
            onDragOver={event => {
              const target = columnDrop(event, key);
              if (target && (columnTarget?.key !== key || columnTarget.after !== target.after)) setColumnTarget(target);
            }}
            onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget) && columnTarget?.key === key) setColumnTarget(null); }}
            onDrop={event => {
              const target = columnDrop(event, key);
              if (target) moveColumn(columnDrag.current, key, target.after);
              columnDrag.current = null;
              setColumnTarget(null);
            }}>
            <div className="ledger-th-inner">
              <span className="ledger-column-grip" draggable aria-hidden="true" title="拖动调整列顺序"
                onDragStart={event => { columnDrag.current = key; event.dataTransfer.setData('text/plain', key); event.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => { columnDrag.current = null; setColumnTarget(null); }}><GripVertical size={13}/></span>
              {sortableColumns.includes(key) ? <SortHeader column={key} label={columnLabels[key]} sort={manualOrder ? null : sort} onSort={sortByColumn} /> : <span>{columnLabels[key]}</span>}
            </div>
            {key === columns.at(-1) ? <span className="ledger-auto-width" title="末列自动填充剩余空间">自动</span> : <ColumnResize label={columnLabels[key]} value={fittedWidths[key]} minimum={ledgerColumnLimits[key][0]} maximum={ledgerColumnLimits[key][1]} fallback={ledgerColumnDefaults[key]} onChange={value => resizeColumn(key, value)} />}
          </th>)}
        </tr></thead>
        <tbody>{visible.map((row, index) => <tr key={`${row.kind}-${row.id}`} onClick={() => openEdit(row)}
          className={rowTarget?.key === row.id ? (rowTarget.after ? 'drop-after' : 'drop-before') : undefined}
          onDragOver={event => {
            const target = rowDrop(event, row);
            if (target && (rowTarget?.key !== row.id || rowTarget.after !== target.after)) setRowTarget(target);
          }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget) && rowTarget?.key === row.id) setRowTarget(null); }}
          onDrop={event => {
            const target = rowDrop(event, row);
            if (target) {
              const ids = sorted.map(item => item.id);
              const next = moveItem(ids, rowDrag.current.id, row.id, target.after);
              if (next.some((id, position) => id !== ids[position])) saveOrder(next);
            }
            rowDrag.current = null;
            setRowTarget(null);
          }}>
          <td className="ledger-index"><div className="ledger-index-inner">
            {allowReorder && <span className="ledger-grip" draggable aria-hidden="true" title="拖动调整行顺序" onClick={event => event.stopPropagation()}
              onDragStart={event => { rowDrag.current = { id: row.id, done: row.status === '已结束' }; event.dataTransfer.setData('text/plain', row.id); event.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={() => { rowDrag.current = null; setRowTarget(null); }}><GripVertical size={14}/></span>}
            <span>{index + 1}</span>
          </div></td>
          {columns.map(key => renderCell(key, row))}
        </tr>)}</tbody>
      </table>
      {!visible.length && <div className="ledger-empty">{data ? '当前筛选下没有记录。' : '正在读取飞书表格…'}</div>}
    </div>}
    {floatBox && <div className="ledger-float" style={floatBox.position} role="dialog" aria-label={floatBox.title}><header><strong>{floatBox.title}</strong><button type="button" aria-label="关闭浮层" onClick={() => setFloatBox(null)}><X size={14}/></button></header><p>{floatBox.text}</p>{floatBox.rowId && <>{!!reusableTags.length && <div className="ledger-float-tags" role="group" aria-label="已有标签">{reusableTags.map(tag => { const selected = floatTags.includes(tag); return <button key={tag} type="button" className={`ledger-chip${selected ? ' is-selected' : ''}`} aria-pressed={selected ? 'true' : 'false'} onClick={() => reuseRowTag(tag)}>{tag}</button>; })}</div>}<input className="ledger-tag-input" aria-label="新标签" autoFocus value={rowTag} maxLength={16} placeholder="输入新标签后回车" onChange={event => setRowTag(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (floatRow) commitRowTag(floatRow); setFloatBox(null); } if (event.key === 'Escape') setFloatBox(null); }} /></>}</div>}
    {contextRow && <TaskContext key={contextRow.kind + contextRow.id} row={contextRow} projects={projects} onClose={() => setContextRow(null)}/>}
    {editor && <div className="ledger-backdrop"><form className="ledger-dialog" role="dialog" aria-modal="true" aria-label={`${editor.mode === 'create' ? '新增' : '编辑'}${editorLabel}`} onSubmit={save}>
      <header className="ledger-dialog-head">
        <div><h2>{editor.mode === 'create' ? '新增' : '编辑'}{editorLabel}</h2><p>{editor.mode === 'create' ? '创建时间由飞书生成。未选的截止时间和优先级会留空。' : '只提交改过的字段。飞书若已改同一字段，本次不会覆盖。'}</p></div>
        <button type="button" className="ledger-close" aria-label="关闭" disabled={saving} onClick={() => setEditor(null)}><X size={18}/></button>
      </header>
      {error && <div className="ledger-alert" role="alert">{error}</div>}
      <div className="ledger-form">
        <label>内容<textarea required autoFocus maxLength={2000} rows={4} value={editor.form.content} onChange={event => change('content', event.target.value)} /></label>
        <div className="ledger-split">
          <label>状态<span className="ledger-choice" role="radiogroup" aria-label="状态">{statuses.map(item => <button type="button" role="radio" aria-checked={editor.form.status === item} className={editor.form.status === item ? 'selected' : ''} key={item} onClick={() => change('status', item)}>{item}</button>)}</span></label>
          <label>优先级<span className="ledger-choice" role="radiogroup" aria-label="优先级"><button type="button" role="radio" aria-checked={!editor.form.priority} className={editor.form.priority ? '' : 'selected'} onClick={() => change('priority', '')}>不设置</button>{priorities.map(item => <button type="button" role="radio" aria-checked={editor.form.priority === item} className={editor.form.priority === item ? 'selected' : ''} key={item} onClick={() => change('priority', item)}>{item}</button>)}</span></label>
          <label>截止时间<input type="date" value={editor.form.due} onChange={event => change('due', event.target.value)} /></label>
          {supportsTags(editor.kind) && <label className="ledger-tag-editor">标签<span className="ledger-choice" role="group" aria-label="标签">{tagOptions.map(tag => <button type="button" key={tag} aria-pressed={editor.form.tags.includes(tag)} className={editor.form.tags.includes(tag) ? 'selected' : ''} onClick={() => toggleTag(tag)}>{tag}</button>)}</span><span className="ledger-new-tag"><input aria-label="新标签" maxLength={16} value={tagDraft} placeholder="新标签，回车添加" onChange={event => setTagDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') addTag(event); }} /><button type="button" onClick={addTag}>添加</button></span></label>}
          <label>创建时间<div className="ledger-readonly">{editor.mode === 'edit' ? (rows.find(row => row.id === editor.recordId)?.created_at || '由飞书生成') : '保存后由飞书生成，不能手填'}</div></label>
        </div>
        <label>备注<textarea maxLength={2000} rows={3} value={editor.form.note} onChange={event => change('note', event.target.value)} /></label>
      </div>
      <footer className="ledger-form-actions"><span className="ledger-caption">{editor.mode === 'create' ? '新增默认是未启动。只有手动选已结束才算结束。' : '创建时间不能修改。未选的截止日期会留空。'}</span><button className="ledger-primary" disabled={saving}><Save size={15}/>{saving ? '写入中…' : '保存到飞书'}</button></footer>
    </form></div>}
  </section>;
}
