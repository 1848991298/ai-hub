import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Check, ClipboardList, Columns3, GripVertical, Filter, ChevronDown, SlidersHorizontal, Image as ImageIcon, Info, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { blankForm, categoryOf, taskCategories, canonicalStatus, changedFields, columnSequence, columnWidths, cycleFacet, cycleMode, defaultLedgerSort, emptyFilters, fillColumnWidths, filterRecords, isDone, isOverdue, knownTags, hasTag, mergeTags, tagKey, ledgerColumnDefaults, ledgerColumnLimits, ledgerColumnOrder, moveItem, nextSort, orderedRows, sortRecords, statuses, priorities, stretchLastColumn } from './ledger-model.js';
import TaskContext from './TaskContext.jsx';
import { RecordDrawer, RecordImages, RecordText, RecordTextarea, imageTypes, maxImageCount, maxImageSize, stageImage, useRecordPreview } from './LedgerRecord.jsx';
import './ledger.css';

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const shortClock = value => value ? value.replace(/^\d{4}-/, '') : '—';
const requestId = () => crypto.randomUUID();
const recordTitle = row => (row.content || '').split(/\r?\n/).find(line => line.trim())?.trim() || '无标题';

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
  return { content: row.content || '', status: canonicalStatus(row.status) || '未启动', due: row.due || '', priority: row.priority || '', note: row.note || '', tags: row.tags || [], archived: Boolean(row.archived), category: row.category || '' };
}

const statusTone = { '未启动': 'is-idle', '开发中': 'is-run', '测试中': 'is-test', '已完成': 'is-done' };
const priorityTone = { P0: 'is-p0', P1: 'is-p1', P2: 'is-p2' };
const pressedMode = mode => mode === 'include' ? 'true' : mode === 'exclude' ? 'mixed' : 'false';

function LedgerMenu({ label, triggerLabel, icon: Icon, count, align = 'start', width = 300, chevron, children }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const root = useRef(null), trigger = useRef(null), panel = useRef(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = trigger.current.getBoundingClientRect();
      const size = Math.min(width, innerWidth - 24);
      const top = rect.bottom + 8;
      setPosition({ width: size, left: Math.max(12, Math.min(align === 'end' ? rect.right - size : rect.left, innerWidth - size - 12)), top, maxHeight: Math.max(80, innerHeight - top - 12) });
    }
    function outside(event) { if (!root.current?.contains(event.target)) setOpen(false); }
    function escape(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current.focus(); }
    }
    function scroll(event) { if (!root.current?.contains(event.target)) setOpen(false); }
    place();
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    document.addEventListener('scroll', scroll, true);
    addEventListener('resize', place);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
      document.removeEventListener('scroll', scroll, true);
      removeEventListener('resize', place);
    };
  }, [open, align, width]);
  return <div className="ledger-menu" ref={root}>
    <button type="button" ref={trigger} className="ledger-menu-trigger" aria-label={triggerLabel} title={count ? `${count} 项筛选条件` : undefined} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)} onKeyDown={event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); requestAnimationFrame(() => panel.current?.querySelector('button, input, select, summary')?.focus()); }
    }}><Icon size={14}/>{triggerLabel}{count > 0 && <b>{count}</b>}{chevron && <ChevronDown size={12}/>}</button>
    {open && <div id={id} ref={panel} className="ledger-menu-panel" role="dialog" aria-label={label} style={position || { visibility: 'hidden' }}>
      {typeof children === 'function' ? children(() => { setOpen(false); trigger.current.focus(); }) : children}
    </div>}
  </div>;
}

function FilterOptions({ values, modes, counts, onChange }) {
  return <div className="ledger-facet-options">{values.map(value => <button key={value} type="button" aria-pressed={pressedMode(modes?.[value])} onClick={() => onChange(value)}>
    <span className={'ledger-option-mark ' + (modes?.[value] || '')} aria-hidden="true">{modes?.[value] === 'include' ? <Check size={12}/> : modes?.[value] === 'exclude' ? '−' : ''}</span>
    <span>{value}</span><em>{counts[value] || 0}</em>
  </button>)}</div>;
}

function Pill({ tone, mode, onClick, children }) {
  if (!children) return '—';
  const className = `ledger-pill ${tone || ''} ${mode ? `is-${mode}` : ''}`;
  if (!onClick) return <span className={className}>{children}</span>;
  return <button type="button" className={className} aria-pressed={mode === 'include' ? 'true' : mode === 'exclude' ? 'mixed' : 'false'} onClick={event => { event.stopPropagation(); onClick(); }}>{children}</button>;
}

function SortHeader({ column, label, sort, onSort }) {
  const index = sort.findIndex(rule => rule.key === column);
  const rule = sort[index];
  const name = rule ? `${label}，第 ${index + 1} 排序，${rule.dir === 'asc' ? '升序' : '降序'}` : label;
  return <button type="button" className={rule ? 'is-sorted' : ''} aria-label={name} title={name} onClick={() => onSort(column)}>
    <span className="ledger-sort-label">{label}</span>
    {rule && <span className="ledger-sort-mark" aria-hidden="true">
      {sort.length > 1 && <span>{index + 1}</span>}
      {rule.dir === 'asc' ? <ArrowUp size={11}/> : <ArrowDown size={11}/>}
    </span>}
  </button>;
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

const columnLabels = { content: '内容', category: '类型', status: '状态', due: '截止时间', priority: '优先级', tags: '标签', created: '创建时间', note: '备注' };
const sortableColumns = ['status', 'created', 'due', 'priority', 'category'];
const rowIndexWidth = 40;

function savedValue(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function SortSettings({ rules, onChange }) {
  return <section className="ledger-sort-settings" aria-label="排序设置">
    <div className="ledger-sort-settings-head">
      <h3>排序</h3>
      {rules.length > 0 && <button type="button" onClick={() => onChange([])}>恢复默认排序</button>}
    </div>
    {rules.length ? <ol>{rules.map((rule, index) => {
      const label = columnLabels[rule.key];
      const ascending = rule.dir === 'asc';
      return <li key={rule.key}>
        <span className="ledger-sort-position">{index + 1}</span>
        <span className="ledger-sort-field">{label}</span>
        <button type="button" aria-label={`将${label}切换为${ascending ? '降序' : '升序'}`}
          onClick={() => onChange(nextSort(rules, rule.key))}>{ascending ? '升序' : '降序'}</button>
        <button type="button" aria-label={`上移${label}排序`} disabled={index === 0}
          onClick={() => onChange(moveItem(rules, rule, rules[index - 1]))}><ArrowUp size={13}/></button>
        <button type="button" aria-label={`下移${label}排序`} disabled={index === rules.length - 1}
          onClick={() => onChange(moveItem(rules, rule, rules[index + 1], true))}><ArrowDown size={13}/></button>
        <button type="button" aria-label={`移除${label}排序`}
          onClick={() => onChange(rules.filter(item => item.key !== rule.key))}><X size={13}/></button>
      </li>;
    })}</ol> : <p>截止时间升序</p>}
  </section>;
}

function ColumnLayout({ columns, visibleColumns, hidden, widths, onWidth, onFit, onMove, onReset, onToggle }) {
  return <details className="ledger-column-layout">
    <summary><Columns3 size={15}/>列布局</summary>
    <div className="ledger-column-panel">
      <header><strong>列顺序</strong><button type="button" onClick={onReset}>恢复默认</button></header>
      <ol>{columns.map((key, index) => <li key={key}>
        <label className="ledger-column-toggle"><input type="checkbox" aria-label={`显示${columnLabels[key]}列`} checked={!hidden.includes(key)} disabled={key === 'content'} onChange={() => onToggle(key)}/><span>{columnLabels[key]}</span></label>
        <input type="number" aria-label={`${columnLabels[key]}列宽像素`} min={ledgerColumnLimits[key][0]} max={ledgerColumnLimits[key][1]} value={widths[key]} disabled={hidden.includes(key) || key === visibleColumns.at(-1)} title={key === visibleColumns.at(-1) ? '末列自动填充剩余空间' : undefined} onChange={e => onWidth(key, Number(e.target.value))}/><small>{hidden.includes(key) ? '隐藏' : key === visibleColumns.at(-1) ? '自动' : 'px'}</small>
        <button type="button" aria-label={`将${columnLabels[key]}左移`} disabled={index === 0} onClick={() => onMove(key, columns[index - 1], false)}><ArrowUp size={15}/></button>
        <button type="button" aria-label={`将${columnLabels[key]}右移`} disabled={index === columns.length - 1} onClick={() => onMove(key, columns[index + 1], true)}><ArrowDown size={15}/></button>
      </li>)}</ol>
      <button type="button" className="button" onClick={onFit}>适应当前窗口</button><p>拖动或输入像素后保留前面各列宽度，末列自动补齐余量；放不下时表内横向滚动。新末列自动补齐；取消勾选可隐藏字段，飞书数据保留。</p>
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
  const [rowHeight, setRowHeight] = useState(() => savedValue('ai-hub-ledger-row-height') === 'auto' ? 'auto' : 'single');
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
  const [sort, setSort] = useState([]);
  const [widths, setWidths] = useState(() => columnWidths(savedValue('ai-hub-ledger-columns')));
  const [widthMode, setWidthMode] = useState(() => savedValue('ai-hub-ledger-width-mode') === 'manual' ? 'manual' : 'fill');
  const [columnOrder, setColumnOrder] = useState(() => columnSequence(savedValue('ai-hub-ledger-column-order')));
  const [hiddenColumns, setHiddenColumns] = useState(() => { const saved = savedValue('ai-hub-ledger-hidden-columns'); return (Array.isArray(saved) ? saved : []).filter(key => ledgerColumnOrder.includes(key) && key !== 'content'); });
  const [archiveMode, setArchiveMode] = useState(() => { const saved = route.archive || savedValue('ai-hub-ledger-archive-mode'); return ['active', 'archived', 'all'].includes(saved) ? saved : 'active'; });
  const [selected, setSelected] = useState([]);
  const [bulkTag, setBulkTag] = useState('');
  const [archiveDismissed, setArchiveDismissed] = useState(() => savedValue('ai-hub-ledger-archive-hint') || {});
  const mutationClock = useRef(0);
  const readSequence = useRef(0);
  const [tableViewport, setTableViewport] = useState(0);
  const [columnTarget, setColumnTarget] = useState(null);
  const [rowTarget, setRowTarget] = useState(null);
  const tableScroll = useRef(null);
  const columnDrag = useRef(null);
  const rowDrag = useRef(null);
  const [editor, setEditor] = useState(null);
  const noteHeading = useRef(null);
  const recordPreview = useRecordPreview();
  const [draftImages, setDraftImages] = useState([]);
  const [imageError, setImageError] = useState('');
  const imageUrls = useRef(new Set());
  const mounted = useRef(true);
  useEffect(() => {
    const urls = imageUrls.current;
    return () => { urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); };
  }, []);

  function normalizeSnapshot(value) {
    const normalize = row => ({ ...row, status: canonicalStatus(row.status), archived: Boolean(row.archived) });
    return { ...value, issues: (value.issues || []).map(normalize), tasks: (value.tasks || []).map(normalize) };
  }
  function acceptSnapshot(value) {
    mutationClock.current++;
    readSequence.current++;
    setData(normalizeSnapshot(value));
    setError(value.error && !value.sync?.failed ? value.error : '');
  }
  async function load(action = 'snapshot') {
    const version = mutationClock.current, sequence = ++readSequence.current;
    setLoading(true);
    try {
      const value = await api(action, action === 'snapshot' ? undefined : {});
      if (mounted.current && version === mutationClock.current && sequence === readSequence.current) {
        setData(normalizeSnapshot(value)); setError(value.error && !value.sync?.failed ? value.error : '');
      }
    } catch (reason) {
      if (mounted.current && sequence === readSequence.current) setError(reason.message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }
  useEffect(() => { if (!data?.sync?.pending) return; const timer = setInterval(() => load(), 1200); return () => clearInterval(timer); }, [data?.sync?.pending]);
  useEffect(() => { try { localStorage.setItem('ai-hub-ledger-hidden-columns', JSON.stringify(hiddenColumns)); } catch {} }, [hiddenColumns]);
  useEffect(() => { try { localStorage.setItem('ai-hub-ledger-archive-mode', JSON.stringify(archiveMode)); } catch {} }, [archiveMode]);
  useEffect(() => { try { localStorage.setItem('ai-hub-ledger-row-height', JSON.stringify(rowHeight)); } catch {} }, [rowHeight]);
  useEffect(() => { if (['active', 'archived', 'all'].includes(route.archive)) setArchiveMode(route.archive); }, [route.archive]);
  useEffect(() => { try { localStorage.setItem('ai-hub-ledger-columns', JSON.stringify(widths)); } catch { /* 本窗口仍可使用当前列宽。 */ } }, [widths]);
  useEffect(() => { try { localStorage.setItem('ai-hub-ledger-width-mode', JSON.stringify(widthMode)); } catch {} }, [widthMode]);
  useEffect(() => { try { localStorage.setItem('ai-hub-ledger-column-order', JSON.stringify(columnOrder)); } catch { /* 本窗口仍可使用当前列序。 */ } }, [columnOrder]);
  useEffect(() => {
    const scroll = tableScroll.current;
    if (!scroll) return;
    const viewport = scroll.closest('.main-content');
    const measure = () => {
      setTableViewport(scroll.clientWidth);
      const bottom = Math.min(window.innerHeight, viewport?.getBoundingClientRect().bottom ?? window.innerHeight);
      // 加回外层滚动偏移，避免页面滚动时不断放大表格。
      const top = scroll.getBoundingClientRect().top + (viewport?.scrollTop || 0);
      scroll.style.setProperty('--ledger-available-height', `${Math.max(160, Math.floor(bottom - top - 24))}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    observer.observe(scroll.parentElement);
    if (viewport) observer.observe(viewport);
    addEventListener('resize', measure);
    return () => { observer.disconnect(); removeEventListener('resize', measure); };
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
  function openCreate(target, event) {
    recordPreview.dismiss();
    clearDraftImages();
    setTagDraft('');
    setEditor({ mode: 'create', kind: target, animate: event.detail > 0, requestId: requestId(), base: blankForm(), form: { ...blankForm(), category: target === 'task' && data?.category_fields?.task ? '需求' : '' } });
    setMessage('');
    setError('');
  }
  function openDetail(row, event, focusNote = false) {
    recordPreview.dismiss();
    clearDraftImages();
    setFloatBox(null);
    const trigger = event.currentTarget.matches('button') ? event.currentTarget : event.currentTarget.querySelector('.ledger-row-title');
    trigger?.focus({ preventScroll: true });
    setEditor({ mode: 'read', kind: row.kind, recordId: row.id, row, focusNote, animate: event.detail > 0 });
  }
  function openEdit(row) {
    clearDraftImages();
    setTagDraft('');
    if (!row.id.startsWith('rec')) { setMessage('这条新记录正在同步，完成后可继续编辑。'); return; }
    const form = valuesOf(row);
    setEditor({ mode: 'edit', kind: row.kind || kind, recordId: row.id, row, requestId: requestId(), base: form, form });
    setMessage('');
    setError('');
  }
  function clearDraftImages() {
    imageUrls.current.forEach(url => URL.revokeObjectURL(url));
    imageUrls.current.clear();
    setDraftImages([]);
    setImageError('');
  }
  function closeEditor() {
    clearDraftImages();
    setEditor(null);
    setTagDraft('');
  }
  function confirmDelete(row) {
    setEditor(current => ({ ...current, mode: 'delete', requestId: requestId(), deleteBase: {
      ...valuesOf(row), status: canonicalStatus(row.status),
      attachment_tokens: (row.attachments || []).map(image => image.file_token),
    } }));
    setError('');
  }
  async function deleteRecord() {
    if (saving || editor?.mode !== 'delete') return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const result = await api('enqueue', {
        operation: 'delete', client_operation_id: editor.requestId,
        kind: editor.kind, record_id: editor.recordId, base: editor.deleteBase, confirmed: true,
      });
      acceptSnapshot(result.snapshot);
      closeEditor();
      if (recordId === editor.recordId) navigate?.({ kind, overdue: route.overdue });
    } catch (reason) {
      setError(reason.message);
    } finally {
      setSaving(false);
    }
  }
  function addImages(files) {
    if (saving || !data?.attachment_fields?.[editor?.kind]) return;
    if (files.some(file => !imageTypes.includes(file.type) || file.size < 1 || file.size > maxImageSize)) {
      setImageError('请选择 PNG、JPG、WebP 或 GIF 图片，每张最大 20 MB。');
      return;
    }
    if (files.length + draftImages.length > maxImageCount) {
      setImageError(`一次最多添加 ${maxImageCount} 张图片。`);
      return;
    }
    if (editor.mode === 'read') openEdit(recordForEditor);
    setImageError('');
    const additions = files.map(file => {
      const src = URL.createObjectURL(file);
      imageUrls.current.add(src);
      return {id: requestId(), file, src};
    });
    setDraftImages(current => [...current, ...additions]);
  }
  function pasteImages(event) {
    if (!canAttach) return;
    const items = Array.from(event.clipboardData?.items || []);
    const files = Array.from(event.clipboardData?.files || []);
    const pasted = files.length ? files : items
      .filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
    const images = pasted.filter(file => file.type.startsWith('image/'));
    if (!images.length) return;
    event.preventDefault();
    addImages(images);
  }
  function removeDraftImage(id) {
    const image = draftImages.find(item => item.id === id);
    if (!image) return;
    URL.revokeObjectURL(image.src);
    imageUrls.current.delete(image.src);
    setDraftImages(current => current.filter(item => item.id !== id));
    setImageError('');
  }
  function change(key, value) {
    setEditor(current => ({ ...current, form: { ...current.form, [key]: value } }));
  }
  function editorValues() {
    return tagDraft.trim() ? { ...editor.form, tags: mergeTags([...editor.form.tags, tagDraft], knownTags(data)) } : editor.form;
  }
  async function save(event, archive) {
    event.preventDefault();
    if (!editor || saving) return;
    const form = editorValues();
    const patch = editor.mode === 'edit' ? changedFields(editor.base, form) : null;
    if (patch && archive !== undefined) patch.archived = archive;
    if (patch && !Object.keys(patch).length && !draftImages.length) { closeEditor(); return; }
    setSaving(true); setError('');
    try {
      for (const image of draftImages) await stageImage(image);
      const operation = editor.mode === 'create'
        ? { operation: 'create', kind: editor.kind, client_operation_id: editor.requestId, content: form.content, status: form.status, due: form.due || null, priority: form.priority || null, note: form.note, tags: form.tags, ...(editor.kind === 'task' && data?.category_fields?.task ? { category: form.category } : {}) }
        : { operation: 'update', kind: editor.kind, client_operation_id: editor.requestId, record_id: editor.recordId, base: editor.base, patch };
      const result = await api('enqueue', { ...operation, ...(draftImages.length ? { image_ids: draftImages.map(image => image.id) } : {}),
        ...(editor.supersedes ? { supersedes: editor.supersedes, confirmed_not_created: editor.confirmed } : {}) });
      acceptSnapshot(result.snapshot); closeEditor(); setMessage('');
    } catch (reason) { setError(reason.message + ' 修改仍保留在表单中。'); }
    finally { setSaving(false); }
  }
  async function submitPatches(rows, change) {
    if (saving || !rows.length) return;
    setSaving(true); setError('');
    try {
      const operations = rows.map(row => ({ operation: 'update', kind: row.kind || kind, record_id: row.id,
        client_operation_id: requestId(), base: valuesOf(row), patch: typeof change === 'function' ? change(row) : change }));
      const result = await api('enqueue', { operations });
      acceptSnapshot(result.snapshot); setSelected([]); setMessage('');
      return true;
    } catch (reason) { setError(reason.message); return false; }
    finally { setSaving(false); }
  }
  async function syncAction(job, operation) {
    try { const result = await api('queue-control', { operation, job_id: job.id }); acceptSnapshot(result.snapshot); }
    catch (reason) { setError(reason.message); }
  }
  function editFailed(job) {
    clearDraftImages();
    setTagDraft('');
    const base = valuesOf(job.cloud_record || {});
    setEditor({ mode: job.operation === 'create' ? 'create' : 'edit', kind: job.kind, recordId: job.record_id, carriedImages: job.pending_images,
      requestId: requestId(), base, form: valuesOf({ ...base, ...(job.operation === 'update' ? job.patch : job.draft) }), supersedes: job.id,
      conflict: job.status === 409 && job.cloud_record ? job.cloud_record : null,
      uncertain: job.state === 'uncertain', confirmed: false });
    setError('');
  }
  function chooseView(next) {
    setView(next);
    try { localStorage.setItem('ai-hub-ledger-view', next); } catch { /* 这次窗口仍用当前视图。 */ }
  }
  async function moveStatus(row, status) {
    if (saving || row.status === status) return;
    await submitPatches([row], { status });
  }
  function toggleTag(name) {
    setEditor(current => {
      const tags = hasTag(current.form.tags, name) ? current.form.tags.filter(item => tagKey(item) !== tagKey(name)) : mergeTags([...current.form.tags, name], knownTags(data));
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
    setSort(current => {
      if (manualOrder) return nextSort([], key);
      const rules = !current.length && key === defaultLedgerSort[0].key ? defaultLedgerSort : current;
      return nextSort(rules, key);
    });
  }
  function moveColumn(from, to, after) {
    if (widthMode === 'manual') setWidths(columnWidths({ ...widths, ...fittedWidths }));
    setColumnOrder(current => moveItem(current, from, to, after));
  }
  function resetColumns() {
    setColumnOrder(ledgerColumnOrder);
    setHiddenColumns([]);
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
    if (!allowReorder || !from || from.id === row.id || (sinkDone && from.done !== (isDone(row)))) return null;
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
    setTaggingId(null); setRowTag('');
    if (!name || hasTag(row.tags, name)) return;
    await submitPatches([row], { tags: mergeTags([...(row.tags || []), name], knownTags(data)) });
  }
  function addTag(event) {
    event.preventDefault();
    const name = tagDraft.trim();
    if (!name) return;
    setTagDraft('');
    setEditor(current => ({ ...current, form: { ...current.form, tags: mergeTags([...current.form.tags, name], knownTags(data)) } }));
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
  const allIssues = data?.issues || [], allTasks = data?.tasks || [];
  const inArchive = row => archiveMode === 'all' || (archiveMode === 'archived' ? row.archived : !row.archived) || row.id === recordId;
  const issues = allIssues.filter(inArchive), tasks = allTasks.filter(inArchive);
  const rows = kind === 'all' ? [...issues, ...tasks] : kind === 'issue' ? issues : tasks;
  const supportsTags = rowKind => data?.tag_fields?.[rowKind] !== false;
  const showTagColumn = kind === 'all' ? supportsTags('issue') || supportsTags('task') : supportsTags(kind);
  const supportsCategory = Boolean(data?.category_fields?.task);
  const showCategoryColumn = supportsCategory && kind !== 'issue';
  const columns = columnOrder.filter(key => !hiddenColumns.includes(key) && (key !== 'category' || showCategoryColumn) && (key !== 'tags' || showTagColumn));
  const allowReorder = kind !== 'all' && !recordId;
  const savedOrder = order[kind];
  const manualIds = Array.isArray(savedOrder) ? savedOrder : Array.isArray(savedOrder?.ids) ? savedOrder.ids : [];
  const manualOrder = allowReorder && manualIds.length > 0 && savedOrder?.manual !== false;
  const activeSort = manualOrder ? [] : sort.length ? sort : defaultLedgerSort;
  const primarySort = activeSort[0];
  const sorted = manualOrder ? orderedRows(rows, manualIds, sinkDone) : sortRecords(rows, activeSort, sinkDone);
  const scopedRows = recordId ? sorted.filter(row => row.id === recordId) : sorted;
  const visible = filterRecords(scopedRows, filters, day);
  const selectionKey = row => (row.kind || kind) + ':' + row.id;
  const selectable = visible.filter(row => row.id.startsWith('rec'));
  const selectedRows = selectable.filter(row => selected.includes(selectionKey(row)));
  const selectionScope = selectable.map(selectionKey).join('|');
  useEffect(() => { const allowed = new Set(selectionScope.split('|')); setSelected(current => current.filter(key => allowed.has(key))); }, [selectionScope]);
  const everySelected = selectable.length > 0 && selectedRows.length === selectable.length;
  const archivedCount = (kind === 'all' ? [...allIssues, ...allTasks] : kind === 'issue' ? allIssues : allTasks).filter(row => row.archived).length;
  const completed = rows.filter(row => !row.archived && isDone(row) && row.id.startsWith('rec'));
  const hint = archiveMode === 'active' && completed.length >= Math.max(20, (archiveDismissed[kind] || 0) + 10);
  const failedJobs = (data?.sync?.jobs || []).filter(job => ['failed', 'uncertain'].includes(job.state));
  function selectAll() { setSelected(everySelected ? [] : selectable.slice(0, 100).map(selectionKey)); }
  function toggleRow(row) { const key = selectionKey(row); setSelected(current => current.includes(key) ? current.filter(item => item !== key) : [...current, key].slice(-100)); }
  function dismissArchiveHint() {
    const next = { ...archiveDismissed, [kind]: completed.length }; setArchiveDismissed(next);
    try { localStorage.setItem('ai-hub-ledger-archive-hint', JSON.stringify(next)); } catch {}
  }
  function archiveRow(row) { return submitPatches([row], { archived: !row.archived }); }

  const availableWidth = Math.max(0, tableViewport - rowIndexWidth);
  const fittedWidths = widthMode === 'fill' ? fillColumnWidths(availableWidth, columns) : stretchLastColumn(widths, availableWidth, columns);
  // 窄窗口保留末列备注的阅读宽度，表格沿用横向滚动。
  if (view === 'list' && rowHeight === 'auto' && columns.at(-1) === 'note') {
    fittedWidths.note = Math.max(ledgerColumnDefaults.note, fittedWidths.note);
  }
  const tableWidth = columns.reduce((sum, key) => sum + fittedWidths[key], rowIndexWidth);
  const counts = {
    status: Object.fromEntries(statuses.map(item => [item, rows.filter(row => row.status === item).length])),
    priority: Object.fromEntries(priorities.map(item => [item, rows.filter(row => row.priority === item).length])),
    overdue: rows.filter(row => isOverdue(row, day)).length,
  };
  const chips = [
    ...Object.entries(filters.status).map(([value, mode]) => ({ key: `status-${value}`, label: `${mode === 'exclude' ? '排除' : '只看'} ${value}`, clear: () => clearFacet('status', value) })),
    ...Object.entries(filters.category || {}).map(([value, mode]) => ({ key: `category-${value}`, label: `${mode === 'exclude' ? '排除' : '只看'} ${value}`, clear: () => clearFacet('category', value) })),
    ...Object.entries(filters.priority).map(([value, mode]) => ({ key: `priority-${value}`, label: `${mode === 'exclude' ? '排除' : '只看'} ${value}`, clear: () => clearFacet('priority', value) })),
    ...Object.entries(filters.tags || {}).map(([value, mode]) => ({ key: `tag-${value}`, label: `${mode === 'exclude' ? '排除' : '含'} ${value}`, clear: () => clearFacet('tags', value) })),
    ...(filters.overdue ? [{ key: 'overdue', label: filters.overdue === 'exclude' ? '排除已过截止' : '只看已过截止', clear: () => changeOverdue(null) }] : []),
  ];
  const synced = data?.synced_at ? new Date(data.synced_at).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '尚未成功';
  const readError = Boolean(data?.error || (!data && error));
  const syncTone = failedJobs.length || readError ? 'is-error' : data?.sync?.pending ? 'is-pending' : data?.synced_at ? '' : 'is-idle';
  const syncLabel = failedJobs.length ? `${failedJobs.length} 项同步待处理` : data?.sync?.pending ? `后台同步 ${data.sync.pending} 项` : readError ? '读取异常 · 保留上次记录' : data?.synced_at ? `已同步 · ${synced}` : loading ? '正在读取…' : '尚未成功读取';
  const syncHelp = '飞书是主数据。打开页面、手动刷新及服务运行期间定期读取。退出 Hub 后停止；截止时间只用于筛选，不会自动完成。';
  const editorLabel = editor?.kind === 'task' ? '任务' : '问题';
  const reading = editor?.mode === 'read';
  const recordForEditor = (editor?.kind === 'task' ? tasks : issues).find(row => row.id === editor?.recordId) || editor?.row;
  const canEditRecord = !!recordForEditor?.id.startsWith('rec');
  const hasAttachmentField = !!data?.attachment_fields?.[editor?.kind];
  const canAttach = hasAttachmentField && (!reading || canEditRecord);
  const drawerTitle = reading ? editorLabel + '详情' : (editor?.mode === 'create' ? '新增' : '编辑') + editorLabel;
  const imageSection = (hasAttachmentField || recordForEditor?.attachments?.length) ? <RecordImages
    row={recordForEditor} drafts={draftImages} disabled={saving} onFiles={canAttach ? addImages : undefined}
    onRemove={removeDraftImage} error={imageError} /> : null;
  function contextButton(row) {
    return <button type="button" className="ledger-context-trigger" title="查看执行资料" aria-label={'执行资料 · ' + row.content} onClick={event => { event.stopPropagation(); setContextRow(row); }}><ClipboardList size={15}/></button>;
  }
  const tagOptions = showTagColumn ? mergeTags([...knownTags(data), ...(editor?.form?.tags || [])]) : [];
  const reusableTags = knownTags(data);
  const floatRow = floatBox?.rowId ? rows.find(item => item.id === floatBox.rowId) : null;
  const floatTags = floatRow?.tags || [];
  function reuseRowTag(name) {
    if (!floatRow || hasTag(floatTags, name)) return;
    commitRowTag(floatRow, name);
    setFloatBox(null);
  }
  const tagCounts = Object.fromEntries(tagOptions.map(tag => [tag, rows.filter(row => hasTag(row.tags, tag)).length]));
  function recordButton(row, field = 'content', wrap = false) {
    const note = field === 'note';
    const fullText = row[field] || '';
    const text = note ? fullText : (wrap && fullText.trim()) || recordTitle(row);
    const preview = wrap ? {} : recordPreview.bind(fullText, note ? '备注' : '内容', !note && text === fullText.trim());
    return <button type="button" className={note ? 'ledger-note-text' : 'ledger-row-title'} aria-haspopup="dialog"
      {...preview}
      onClick={event => {
        event.stopPropagation();
        openDetail(row, event, note);
      }}>{text}</button>;
  }
  function renderCell(key, row) {
    const overdue = isOverdue(row, day);
    const tags = row.tags || [];
    switch (key) {
      case 'content': return <td key={key}>
        <div className="ledger-content">
          {allowReorder && manualOrder && <span className="ledger-grip" draggable aria-hidden="true" title="拖动调整行顺序" onClick={event => event.stopPropagation()}
              onDragStart={event => { rowDrag.current = { id: row.id, done: isDone(row) }; event.dataTransfer.setData('text/plain', row.id); event.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={() => { rowDrag.current = null; setRowTarget(null); }}><GripVertical size={14}/></span>}

          {kind === 'all' && <small className="ledger-row-kind">{row.kind === 'task' ? '任务' : '问题'}</small>}
          {recordButton(row, 'content', rowHeight === 'auto')}
          {(row.attachments?.length || row.pending_images) ? <span className="ledger-row-image" role="img" aria-label="含截图"><ImageIcon size={14}/></span> : null}
          {contextButton(row)}
          {data?.archive_supported?.[row.kind || kind] && row.id.startsWith('rec') && <button type="button" className="ledger-row-archive" title={row.archived ? '恢复记录' : '归档记录'} aria-label={(row.archived ? '恢复记录 · ' : '归档记录 · ') + row.content} onClick={event => { event.stopPropagation(); archiveRow(row); }}>{row.archived ? <ArchiveRestore size={15}/> : <Archive size={15}/>}</button>}
          {row.sync_state && <span className={'ledger-sync-dot ' + (['failed','uncertain'].includes(row.sync_state) ? 'is-error' : '')} title={['failed','uncertain'].includes(row.sync_state) ? '同步未完成，请处理上方提示' : '已保存在本机，正在同步'} aria-label={['failed','uncertain'].includes(row.sync_state) ? '同步待处理' : '等待同步'}/>}
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
      case 'category': return <td key={key}>{row.kind !== 'issue' && !row.category
        ? <button type="button" className="ledger-empty-value" title="未分类 · 点击筛选" aria-label="筛选未分类" aria-pressed={pressedMode(filters.category?.['未分类'])} onClick={event => { event.stopPropagation(); setFacet('category', '未分类'); }}>—</button>
        : <Pill tone={row.kind === 'issue' ? '' : row.category === '优化' ? 'is-category-opt' : 'is-category-need'} mode={filters.category?.[categoryOf(row)]} onClick={() => setFacet('category', categoryOf(row))}>{categoryOf(row)}</Pill>}</td>;
      case 'status': return <td key={key}><Pill tone={statusTone[row.status]} mode={filters.status[row.status]} onClick={() => setFacet('status', row.status)}>{row.status}</Pill></td>;
      case 'created': return <td key={key} className="ledger-time" title={row.created_at || undefined}>{shortClock(row.created_at)}</td>;
      case 'due': return <td key={key} className={overdue ? 'ledger-time ledger-past' : 'ledger-time'} title={overdue ? `${row.due} · 逾期` : undefined}>{row.due || '—'}{overdue && <span className="ledger-overdue-dot" aria-label="逾期" />}</td>;
      case 'priority': return <td key={key}><Pill tone={priorityTone[row.priority]} mode={filters.priority[row.priority]} onClick={row.priority ? () => setFacet('priority', row.priority) : undefined}>{row.priority}</Pill></td>;
      case 'note': return <td key={key} className="ledger-note">{row.note ? recordButton(row, 'note', rowHeight === 'auto') : '—'}</td>;
      default: return null;
    }
  }
  return <section className="ledger">
    <header className="ledger-head">
      <div>
        <h1>问题与任务<span>.</span></h1>
        <p className="ledger-sync-caption"><span className={'ledger-connected-dot ' + syncTone} aria-hidden="true"/><span title={synced}>{syncLabel}</span><span className="ledger-info" role="img" tabIndex={0} aria-label={syncHelp} title={syncHelp}><Info size={13}/></span></p>
      </div>
      <div className="ledger-actions">
        {data?.base_url && <a href={data.base_url} target="_blank" rel="noreferrer">打开飞书表格</a>}
        <button type="button" onClick={() => load('refresh')} disabled={loading}><RefreshCw size={15}/>{loading ? '读取中…' : '立即刷新'}</button>
        {(kind === 'all' ? ['issue', 'task'] : [kind]).map(target => <button type="button" className="ledger-primary" key={target} onClick={event => openCreate(target, event)}><Plus size={15}/>新增{target === 'issue' ? '问题' : '任务'}</button>)}
      </div>
    </header>
    {!editor && error && <div className="ledger-alert" role="alert">{error}{data?.missing_scopes?.length ? ` 缺少 ${data.missing_scopes.join('、')}。` : ''}</div>}
    {failedJobs.length > 0 && <section className="ledger-sync-errors" role="alert">
      <header><strong>{failedJobs.length} 项同步待处理</strong><span>可按下方提示处理。</span></header>
      {failedJobs.map(job => {
        const deleting = job.operation === 'delete';
        return <div className="ledger-sync-error" key={job.id}><div><strong>{deleting ? '删除待处理 · ' : ''}{job.title}</strong><p>{job.error}</p></div><div className="ledger-sync-error-actions">
          {job.state === 'failed' && job.status !== 409 && <button type="button" onClick={() => syncAction(job, 'retry')}>{deleting ? '重试删除' : job.text_synced ? '重试截图' : '重试'}</button>}
          {!deleting && !job.text_synced && <button type="button" onClick={() => editFailed(job)}>{job.status === 409 ? '处理并继续编辑' : '继续编辑'}</button>}
          <button type="button" onClick={() => syncAction(job, 'discard')}>{deleting ? '取消删除请求' : job.text_synced ? '放弃待传截图' : '撤销本机修改'}</button>
        </div></div>;
      })}
    </section>}
    {message && <div className="ledger-ok" role="status">{message}</div>}
    {hint && <div className="ledger-archive-hint"><Archive size={15}/><span>已有 {completed.length} 条已完成记录，可归档后收起，随时恢复。</span><button type="button" onClick={() => setSelected(completed.slice(0,100).map(selectionKey))}>选择已完成记录</button><button type="button" aria-label="暂不提示归档" onClick={dismissArchiveHint}><X size={14}/></button></div>}
    {!selectedRows.length && <div className="ledger-toolbar">
      <div className="ledger-toolbar-group ledger-main-filters">
        <div className="ledger-tabs" role="group" aria-label="记录类型">
          {[['all', '全部', issues.length + tasks.length], ['issue', '问题', issues.length], ['task', '任务', tasks.length]].map(([id, name, size]) => <button type="button" key={id} aria-pressed={kind === id} className={kind === id ? 'selected' : ''} onClick={() => chooseKind(id)}>{name} <em>{data ? size : ''}</em></button>)}
        </div>
        <span className="ledger-toolbar-divider"/>
        <LedgerMenu label="筛选记录" triggerLabel="筛选" icon={Filter} count={chips.length}>
          <div className="ledger-filter-panel">
            <header><strong>筛选记录</strong><button type="button" onClick={clearFilters}>重置</button></header>
            <p>点击选入，再次点击排除。</p>
            <section><h3>状态</h3><FilterOptions values={statuses} modes={filters.status} counts={counts.status} onChange={value => setFacet('status', value)}/></section>
            {showCategoryColumn && <section><h3>类型</h3><FilterOptions values={[...taskCategories, '未分类', ...(kind === 'all' ? ['问题'] : [])]} modes={filters.category} counts={Object.fromEntries([...taskCategories, '未分类', '问题'].map(value => [value, rows.filter(row => categoryOf(row) === value).length]))} onChange={value => setFacet('category', value)}/></section>}
            <section><h3>优先级</h3><FilterOptions values={priorities} modes={filters.priority} counts={counts.priority} onChange={value => setFacet('priority', value)}/></section>
            {!!tagOptions.length && <section><h3>标签</h3><FilterOptions values={tagOptions} modes={filters.tags} counts={tagCounts} onChange={value => setFacet('tags', value)}/></section>}
            <footer><button type="button" aria-pressed={pressedMode(filters.overdue)} onClick={() => changeOverdue(cycleMode(filters.overdue))}>{filters.overdue === 'exclude' ? '排除逾期' : '只看逾期'} <em>{counts.overdue}</em></button></footer>
          </div>
        </LedgerMenu>
        {chips.slice(0,2).map(chip => <button key={chip.key} type="button" className="ledger-active-filter" title={chip.label} onClick={chip.clear}><span>{chip.label}</span><X size={12}/></button>)}
        {recordId && <button type="button" className="ledger-active-filter" onClick={() => navigate?.({ kind, overdue: route.overdue })}>定位记录<X size={12}/></button>}
      </div>
      <div className="ledger-toolbar-group ledger-toolbar-actions">
        <span className="ledger-result-count" aria-live="polite">{data ? <><strong>{visible.length}</strong>{visible.length !== rows.length ? ` / ${rows.length}` : ""} 条记录</> : '读取中…'}</span>
        <select className="ledger-archive-scope" aria-label="记录范围" value={archiveMode} onChange={event => { setArchiveMode(event.target.value); setSelected([]); }}><option value="active">当前记录</option><option value="archived">已归档 {archivedCount}</option><option value="all">全部（含归档）</option></select>
        <LedgerMenu label="视图设置" triggerLabel="视图" icon={SlidersHorizontal} align="end" width={340} chevron>{close => <div className="ledger-view-panel">
          <h3>显示方式</h3><div className="ledger-tabs" role="group" aria-label="视图"><button type="button" aria-pressed={view === 'list'} className={view === 'list' ? 'selected' : ''} onClick={() => { chooseView('list'); close(); }}>列表</button><button type="button" aria-pressed={view === 'board'} className={view === 'board' ? 'selected' : ''} onClick={() => { chooseView('board'); close(); }}>看板</button></div>
          {view === 'list' && <>
            <h3>行高</h3>
            <div className="ledger-tabs" role="group" aria-label="行高">
              {[['single', '单行'], ['auto', '自适应']].map(([mode, label]) => (
                <button key={mode} type="button" aria-pressed={rowHeight === mode}
                  className={rowHeight === mode ? 'selected' : ''} onClick={() => setRowHeight(mode)}>
                  {label}
                </button>
              ))}
            </div>
          </>}
          <h3>列宽</h3><div className="ledger-tabs" role="group" aria-label="表格宽度模式"><button type="button" aria-pressed={widthMode === 'fill'} className={widthMode === 'fill' ? 'selected' : ''} onClick={() => setWidthMode('fill')}>适应窗口</button><button type="button" aria-pressed={widthMode === 'manual'} className={widthMode === 'manual' ? 'selected' : ''} onClick={() => setWidthMode('manual')}>手动列宽</button></div>
          {allowReorder && <label className="ledger-manual-toggle"><input type="checkbox" checked={manualOrder} onChange={() => saveOrder(manualIds.length ? manualIds : sorted.map(row => row.id), !manualOrder)}/>手动调整行序</label>}
          {!manualOrder && view === 'list' && <SortSettings rules={sort} onChange={setSort}/>}
          <ColumnLayout widths={{ ...widths, ...fittedWidths }} hidden={hiddenColumns} visibleColumns={columns} onToggle={key => setHiddenColumns(current => current.includes(key) ? current.filter(item => item !== key) : [...current, key])} onWidth={resizeColumn} onFit={() => setWidthMode('fill')} columns={columnOrder.filter(key => (key !== 'category' || showCategoryColumn) && (key !== 'tags' || showTagColumn))} onMove={moveColumn} onReset={resetColumns}/>
        </div>}</LedgerMenu>
      </div>
    </div>}
    {selectedRows.length > 0 && <div className="ledger-batch-bar" role="group" aria-label="批量操作"><strong>已选 {selectedRows.length} 条</strong>
      <select aria-label="批量修改状态" value="" disabled={saving} onChange={event => submitPatches(selectedRows, { status: event.target.value })}><option value="" disabled>修改状态</option>{statuses.map(status => <option key={status}>{status}</option>)}</select>
      {supportsCategory && <select aria-label="批量修改类型" title="需求与优化适用于任务记录" value="" disabled={saving || selectedRows.some(row => row.kind !== 'task')} onChange={event => submitPatches(selectedRows, { category: event.target.value })}><option value="" disabled>类型</option>{taskCategories.map(value => <option key={value}>{value}</option>)}</select>}
      <select aria-label="批量修改优先级" value="" disabled={saving} onChange={event => submitPatches(selectedRows, { priority: event.target.value === 'clear' ? null : event.target.value })}><option value="" disabled>优先级</option>{priorities.map(priority => <option key={priority}>{priority}</option>)}<option value="clear">清空优先级</option></select>
      <input disabled={selectedRows.some(row => !supportsTags(row.kind || kind))} aria-label="批量添加标签" placeholder="添加标签" value={bulkTag} maxLength={16} onChange={event => setBulkTag(event.target.value)}/><button type="button" disabled={!bulkTag.trim() || saving || selectedRows.some(row => !supportsTags(row.kind || kind))} onClick={async () => { const name = bulkTag.trim(); if (await submitPatches(selectedRows, row => ({ tags: mergeTags([...(row.tags || []), name], knownTags(data)) }))) setBulkTag(''); }}>添加</button>
      {selectedRows.every(row => data?.archive_supported?.[row.kind || kind]) && <button type="button" disabled={saving} onClick={() => submitPatches(selectedRows, { archived: archiveMode !== 'archived' })}>{archiveMode === 'archived' ? <ArchiveRestore size={15}/> : <Archive size={15}/>}{archiveMode === 'archived' ? '恢复' : '归档'}</button>}
      <button type="button" onClick={() => setSelected([])} aria-label="取消批量选择"><X size={15}/></button>
    </div>}
    {view === 'board' ? <div className="ledger-board">{statuses.map(status => <section key={status} className="ledger-column" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const id = event.dataTransfer.getData('text/plain'); const row = visible.find(item => item.id === id); if (row) moveStatus(row, status); }}>
      <header><strong>{status}</strong><em>{visible.filter(row => row.status === status).length}</em></header>
      {visible.filter(row => row.status === status).map(row => <article key={row.id} draggable={!saving} onDragStart={event => { event.dataTransfer.setData('text/plain', row.id); event.dataTransfer.effectAllowed = 'move'; }} onClick={event => openDetail(row, event)}>
        <h3>{recordButton(row)}</h3>{kind === 'all' && <small className="ledger-row-kind">{row.kind === 'task' ? '任务' : '问题'}</small>}
        {supportsTags(row.kind) && <div className="ledger-card-tags" onClick={event => event.stopPropagation()}>{(row.tags || []).map(tag => <button key={tag} type="button" className={`ledger-pill is-tag ${(filters.tags || {})[tag] ? `is-${(filters.tags || {})[tag]}` : ''}`} onClick={() => setFacet('tags', tag)}>{tag}</button>)}{taggingId === row.id ? <input className="ledger-tag-input" aria-label="新标签" autoFocus value={rowTag} maxLength={16} placeholder="输入标签" onChange={event => setRowTag(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitRowTag(row); } if (event.key === 'Escape') { tagCommit.current = true; setTaggingId(null); } }} onBlur={() => commitRowTag(row)} /> : <button type="button" className="ledger-add-tag" onClick={event => beginRowTag(event, row)}>+ 标签</button>}</div>}
        <footer>{showCategoryColumn && <Pill tone={row.category === '优化' ? 'is-category-opt' : 'is-category-need'}>{categoryOf(row)}</Pill>}<Pill tone={priorityTone[row.priority]}>{row.priority}</Pill><span className={isOverdue(row, day) ? 'ledger-past' : ''}>{row.due || '无截止'}</span>{contextButton(row)}</footer>
      </article>)}
    </section>)}</div> : <div className="ledger-table-wrap" ref={tableScroll} role="region" aria-label="台账列表" tabIndex={0}>
      <table className={rowHeight === 'auto' ? 'ledger-auto-rows' : undefined} style={{ width: tableWidth }}>
        <colgroup><col style={{ width: rowIndexWidth }}/>{columns.map(key => <col key={key} style={{ width: fittedWidths[key] }}/>)}</colgroup>
        <thead><tr>
          <th scope="col" className="ledger-index" aria-label="批量选择"><div className="ledger-index-content"><input type="checkbox" aria-label="选择当前显示的记录" checked={everySelected} ref={element => { if (element) element.indeterminate = selectedRows.length > 0 && !everySelected; }} onChange={selectAll}/></div></th>
          {columns.map(key => <th key={key} scope="col" data-column={key}
            aria-sort={primarySort?.key === key ? (primarySort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
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
              {sortableColumns.includes(key) ? <SortHeader column={key} label={columnLabels[key]} sort={activeSort} onSort={sortByColumn} /> : <span>{columnLabels[key]}</span>}
            </div>
            {key === columns.at(-1) ? <span className="ledger-auto-width" title="末列自动填充剩余空间">自动</span> : <ColumnResize label={columnLabels[key]} value={fittedWidths[key]} minimum={ledgerColumnLimits[key][0]} maximum={ledgerColumnLimits[key][1]} fallback={ledgerColumnDefaults[key]} onChange={value => resizeColumn(key, value)} />}
          </th>)}
        </tr></thead>
        <tbody>{visible.map((row, index) => <tr key={`${row.kind}-${row.id}`} onClick={event => openDetail(row, event)}
          className={[row.archived ? 'is-archived' : '', selected.includes(selectionKey(row)) ? 'is-selected' : '', rowTarget?.key === row.id ? (rowTarget.after ? 'drop-after' : 'drop-before') : ''].filter(Boolean).join(' ')}
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
          <td className="ledger-index" title={`第 ${index + 1} 条`}><div className="ledger-index-inner">
            <input type="checkbox" aria-label={'选择记录 · ' + row.content} checked={selected.includes(selectionKey(row))} disabled={!row.id.startsWith('rec')} onClick={event => event.stopPropagation()} onChange={() => toggleRow(row)}/>
          </div></td>
          {columns.map(key => renderCell(key, row))}
        </tr>)}</tbody>
      </table>
      {!visible.length && <div className="ledger-empty">{data ? '当前筛选下没有记录。' : '正在读取飞书表格…'}</div>}
    </div>}
    {floatBox && <div className="ledger-float" style={floatBox.position} role="dialog" aria-label={floatBox.title}><header><strong>{floatBox.title}</strong><button type="button" aria-label="关闭浮层" onClick={() => setFloatBox(null)}><X size={14}/></button></header><p>{floatBox.text}</p>{floatBox.rowId && <>{!!reusableTags.length && <div className="ledger-float-tags" role="group" aria-label="已有标签">{reusableTags.map(tag => { const selected = hasTag(floatTags, tag); return <button key={tag} type="button" className={`ledger-chip${selected ? ' is-selected' : ''}`} aria-pressed={selected ? 'true' : 'false'} onClick={() => reuseRowTag(tag)}>{tag}</button>; })}</div>}<input className="ledger-tag-input" aria-label="新标签" autoFocus value={rowTag} maxLength={16} placeholder="输入新标签后回车" onChange={event => setRowTag(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (floatRow) commitRowTag(floatRow); setFloatBox(null); } if (event.key === 'Escape') setFloatBox(null); }} /></>}</div>}
    {contextRow && <TaskContext key={contextRow.kind + contextRow.id} row={contextRow} projects={projects} onClose={() => setContextRow(null)}/>}
    {recordPreview.popup}
    {editor?.mode === 'delete' && <RecordDrawer key="delete" title="删除记录" onClose={closeEditor} busy={saving}>
      <div className="ledger-drawer-body ledger-record-detail">
        <section><h3>将删除</h3><RecordText text={editor.deleteBase.content}/></section>
        <p>确认后将从飞书多维表格删除这条记录。归档可在「已归档」中恢复。</p>
        {error && <div className="ledger-alert" role="alert">{error}</div>}
      </div>
      <footer className="ledger-drawer-footer">
        <button type="button" className="ledger-dialog-archive" disabled={saving} onClick={() => {
          setError('');
          setEditor(current => ({ ...current, mode: 'read', focusNote: false }));
        }}>取消</button>
        <button type="button" className="ledger-delete-button" disabled={saving} onClick={deleteRecord}>
          {saving ? '正在提交…' : '确认删除'}
        </button>
      </footer>
    </RecordDrawer>}
    {editor && editor.mode !== 'delete' && <RecordDrawer key="record" title={drawerTitle} onClose={closeEditor} busy={saving} onPaste={pasteImages}
      reading={reading} initialFocus={reading && editor.focusNote ? noteHeading : undefined} animate={editor.animate}
      subtitle={reading && recordForEditor ? [
        canonicalStatus(recordForEditor.status), recordForEditor.priority, recordForEditor.category,
        recordForEditor.due ? `截止 ${recordForEditor.due}` : '',
      ].filter(Boolean).join(' · ') : undefined}>
      {reading ? <>
        <div className="ledger-drawer-body ledger-record-detail">
          <section><h3>内容</h3><RecordText text={recordForEditor?.content}/></section>
          {recordForEditor?.note && <section><h3 ref={noteHeading} tabIndex={-1}>备注</h3><RecordText text={recordForEditor.note}/></section>}
          {imageSection}
        </div>
        <footer className="ledger-drawer-footer">
          {canEditRecord && <button type="button" className="ledger-delete-button" disabled={saving || !!recordForEditor.sync_state}
            title={recordForEditor.sync_state ? '记录有待同步的修改' : undefined} onClick={() => confirmDelete(recordForEditor)}>
            <Trash2 size={15} aria-hidden="true"/>删除记录
          </button>}
          {canEditRecord ? <button type="button" className="ledger-primary" onClick={() => openEdit(recordForEditor)}>编辑</button>
            : <span className="ledger-caption">正在同步，完成后可编辑。</span>}
        </footer>
      </> : <form className="ledger-drawer-form" onSubmit={save}>
      <div className="ledger-drawer-body">
      {error && <div className="ledger-alert" role="alert">{error}</div>}
      {editor.conflict && <div className="ledger-conflict" role="status"><strong>飞书已更新</strong><p>当前状态：{canonicalStatus(editor.conflict.status)}；当前备注：{editor.conflict.note || '空'}。</p><p>下方保留你本次修改的字段，其他字段采用飞书最新值。请核对后保存。</p></div>}
      {editor.uncertain && <label className="ledger-uncertain-check"><input type="checkbox" checked={editor.confirmed} onChange={event => setEditor(current => ({ ...current, confirmed: event.target.checked }))}/>我已核对飞书，这条记录尚未创建</label>}
      <div className="ledger-form">
        <RecordTextarea label="内容" required value={editor.form.content} onChange={value => change('content', value)} />
        <RecordTextarea label="备注" value={editor.form.note} onChange={value => change('note', value)} />
        {imageSection}
        {editor.carriedImages > 0 && <p className="ledger-caption">上一次保存的 {editor.carriedImages} 张截图会随本次修改继续同步。</p>}
        <div className="ledger-split">
          <label>状态<span className="ledger-choice" role="radiogroup" aria-label="状态">{statuses.map(item => <button type="button" role="radio" aria-checked={editor.form.status === item} className={editor.form.status === item ? 'selected' : ''} key={item} onClick={() => change('status', item)}>{item}</button>)}</span></label>
          <label>优先级<span className="ledger-choice" role="radiogroup" aria-label="优先级"><button type="button" role="radio" aria-checked={!editor.form.priority} className={editor.form.priority ? '' : 'selected'} onClick={() => change('priority', '')}>不设置</button>{priorities.map(item => <button type="button" role="radio" aria-checked={editor.form.priority === item} className={editor.form.priority === item ? 'selected' : ''} key={item} onClick={() => change('priority', item)}>{item}</button>)}</span></label>
          {editor.kind === 'task' && supportsCategory && <div className="ledger-category-editor"><span>类型</span><div className="ledger-choice" role="radiogroup" aria-label="任务类型">{taskCategories.map(value => <button type="button" role="radio" key={value} aria-label={value} aria-checked={editor.form.category === value} className={editor.form.category === value ? 'selected' : ''} onClick={() => change('category', value)}>{value}</button>)}</div>{!editor.form.category && <small>这条历史记录尚未分类，可选择后保存。</small>}</div>}
          <label>截止时间<input type="date" value={editor.form.due} onChange={event => change('due', event.target.value)} /></label>
          {supportsTags(editor.kind) && <div className="ledger-tag-editor"><span className="ledger-tag-label">模块标签<small>可多选</small></span><div className="ledger-tag-options" role="group" aria-label="模块标签">{tagOptions.length ? tagOptions.map(tag => { const selected = hasTag(editor.form.tags, tag); return <button type="button" key={tag} aria-label={tag} aria-pressed={selected} onClick={() => toggleTag(tag)}>{selected && <Check size={14} aria-hidden="true"/>}{tag}</button>; }) : <p>暂无模块标签，可在下方添加。</p>}</div><div className="ledger-new-tag"><input aria-label="新标签" maxLength={16} value={tagDraft} placeholder="添加模块标签，例如 app" onChange={event => setTagDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') addTag(event); }} /><button type="button" disabled={!tagDraft.trim()} onClick={addTag}>添加</button></div><p className="ledger-tag-help">输入新标签后直接保存也会加入；同名标签自动复用。</p></div>}
          <label>创建时间<div className="ledger-readonly">{recordForEditor?.created_at || '由飞书生成'}</div></label>
        </div>
      </div>
      </div>
      <footer className="ledger-drawer-footer"><span className="ledger-caption">保存后后台同步</span>
        {editor.mode === 'edit' && data?.archive_supported?.[editor.kind] && <button type="button" className="ledger-dialog-archive" disabled={saving} onClick={event => save(event, !editor.base.archived)}>{editor.base.archived ? '恢复此记录' : '归档此记录'}</button>}
        <button type="submit" className="ledger-primary" disabled={saving || (editor.uncertain && !editor.confirmed)}><Save size={15}/>{saving ? '正在保存…' : '保存'}</button>
      </footer>
    </form>}
    </RecordDrawer>}
  </section>;
}
