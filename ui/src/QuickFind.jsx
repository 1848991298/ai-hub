import React, { useEffect, useRef, useState } from 'react';
import { Archive, FileText, FolderGit2, LayoutGrid, ListTodo, Search, Sparkles, X } from 'lucide-react';

const scopes = [
  ['all', '全部'], ['ledger', '任务与问题'], ['projects', '工程'],
  ['skills', 'Skills'], ['rules', '规则'], ['pages', '页面'],
];
const recentKey = 'ai-hub-recent-search';
const normalized = text => String(text ?? '').normalize('NFKC').toLowerCase();

function recordsForSearch(data, ledger, pages) {
  const records = [...(ledger?.issues || []), ...(ledger?.tasks || [])];
  return [
    ...records.map(item => ({
      key: 'record:' + item.kind + ':' + item.id, scope: 'ledger', page: 'ledger',
      title: item.content, detail: item.status, note: item.note,
      label: item.archived ? '已归档' : item.kind === 'task' ? '任务' : '问题',
      keywords: [item.id, item.priority, ...(item.tags || [])],
      Icon: item.archived ? Archive : ListTodo,
      params: { kind: item.kind, record: item.id, archive: item.archived ? 'archived' : 'active' },
    })),
    ...(data?.projects || []).map(item => ({
      key: 'project:' + item.id, scope: 'projects', page: 'projects', title: item.name,
      detail: item.repository || item.subtitle, Icon: FolderGit2, label: '工程',
      keywords: [item.subtitle, item.platform], params: { resource: item.id },
    })),
    ...(data?.skills || []).map(item => ({
      key: 'skill:' + item.id, scope: 'skills', page: 'skills', title: item.title,
      detail: item.id, Icon: Sparkles, label: 'Skill',
      keywords: [item.description, item.category], params: { resource: item.id },
    })),
    ...(data?.rules?.sections || []).map(item => ({
      key: 'rule:' + item.id, scope: 'rules', page: 'rules', title: item.title,
      detail: '共享全局规则', Icon: FileText, label: '规则',
      params: { section: item.title },
    })),
    ...pages.map(item => ({
      key: 'page:' + item.id, scope: 'pages', page: item.id, title: item.label,
      Icon: LayoutGrid, label: '页面', params: {},
    })),
  ];
}

function readRecent() {
  try {
    const value = JSON.parse(localStorage.getItem(recentKey));
    return Array.isArray(value) ? value.filter(key => typeof key === 'string').slice(0, 5) : [];
  } catch { return []; }
}

function rank(item, term, words) {
  const title = normalized(item.title);
  if (title === term) return 0;
  if (title.startsWith(term)) return 1;
  if (words.every(word => title.includes(word))) return 2;
  const text = normalized([item.title, item.detail, item.note, item.label, ...(item.keywords || [])].join(' '));
  return words.every(word => text.includes(word)) ? 3 : 4;
}

export default function QuickFind({ data, error, ledger, onPick, pages, disabled }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('all');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState(readRecent);
  const [records, setRecords] = useState(null);
  const [readingRecords, setReadingRecords] = useState(false);
  const [recordsError, setRecordsError] = useState(false);
  const root = useRef(null);
  const field = useRef(null);
  const list = useRef(null);
  const tracker = records || ledger;
  const term = normalized(query.trim());
  const words = term.split(/\s+/);
  const available = open ? recordsForSearch(data, tracker, pages).filter(item => scope === 'all' || item.scope === scope) : [];
  const visited = recent.map(key => available.find(item => item.key === key)).filter(Boolean);
  const options = term
    ? available.map(item => ({ item, position: rank(item, term, words) })).filter(row => row.position < 4)
      .sort((a, b) => a.position - b.position).slice(0, 8).map(row => row.item)
    : (visited.length ? visited : scope === 'all' ? available.filter(item => item.scope === 'pages') : available).slice(0, 5);
  const selected = Math.min(active, options.length - 1);

  function openSearch() {
    if (!open) setActive(0);
    setOpen(true);
    field.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    function shortcut(event) {
      if (event.defaultPrevented || event.isComposing || disabled || event.target.closest?.('dialog[open],[aria-modal="true"]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return;
    function dismissOutside(event) {
      if (!root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setReadingRecords(true);
    setRecordsError(false);
    async function readRecords() {
      try {
        const response = await fetch('/api/tracker/snapshot', { signal: controller.signal });
        if (!response.ok) throw new Error();
        const value = await response.json();
        if (!controller.signal.aborted) setRecords(value);
      } catch {
        if (!controller.signal.aborted) setRecordsError(true);
      } finally {
        if (!controller.signal.aborted) setReadingRecords(false);
      }
    }
    readRecords();
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  function pick(item) {
    const next = [item.key, ...recent.filter(key => key !== item.key)].slice(0, 5);
    setRecent(next);
    try { localStorage.setItem(recentKey, JSON.stringify(next)); } catch {}
    setQuery('');
    setScope('all');
    setOpen(false);
    field.current?.blur();
    onPick(item.page, item.params);
  }

  function inputKeys(event) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.target !== field.current) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openSearch();
      else if (options.length) {
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setActive((selected + direction + options.length) % options.length);
      }
    } else if (event.key === 'Enter' && open && options[selected]) {
      event.preventDefault();
      pick(options[selected]);
    }
  }

  const waiting = !data && !error || (scope === 'all' || scope === 'ledger') && readingRecords && !tracker;
  const trackerUnavailable = (scope === 'all' || scope === 'ledger') && (recordsError || tracker?.error);
  return <div ref={root} className="hub-global-search" onKeyDown={inputKeys}>
    <div className="hub-search-field">
      <label className="hub-search-input">
        <Search size={16} aria-hidden="true"/>
        <input ref={field} role="combobox" aria-label="全局搜索" aria-autocomplete="list" aria-expanded={open}
          aria-controls={open ? 'quick-results' : undefined} aria-activedescendant={open && selected >= 0 ? 'quick-result-' + selected : undefined}
          placeholder="搜索任务、工程或页面" value={query} onFocus={openSearch} onClick={openSearch}
          onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); }}/>
      </label>
      {query && <button type="button" className="hub-search-clear" aria-label="清除搜索" onClick={() => { setQuery(''); setActive(0); openSearch(); }}><X size={13}/></button>}
      <button type="button" className="hub-search-key" aria-label="打开全局搜索" onClick={openSearch}><kbd>⌘ K</kbd></button>
    </div>
    {open && <div className="hub-search-panel" aria-label="快速查找">
      <div className="hub-search-scopes" role="group" aria-label="搜索范围">{scopes.map(([id, label]) =>
        <button type="button" key={id} aria-pressed={scope === id} onClick={() => { setScope(id); setActive(0); field.current?.focus(); }}>{label}</button>
      )}</div>
      {waiting && <div className="hub-search-message" role="status">{data ? '正在读取任务台账…' : '正在读取工作区。可以先输入关键词。'}</div>}
      {trackerUnavailable && <div className="hub-search-message is-notice" role="status">{tracker?.synced_at ? '任务与问题显示上次成功读取的结果' : '任务台账暂不可用'}</div>}
      {error && !data && <div className="hub-search-message is-notice" role="status">工作区未连接，可先查找页面。</div>}
      <div ref={list} className="search-results quick-results" id="quick-results" role="listbox" aria-label="搜索结果">
        {options.length > 0 && <div className="quick-group-label" aria-hidden="true">{term ? '匹配结果' : visited.length ? '最近打开' : '快速打开'}</div>}
        {options.map(({ Icon, ...item }, index) => {
          const inNote = term && !normalized(item.title).includes(term) && normalized(item.note).includes(term);
          return <button type="button" role="option" tabIndex={-1} key={item.key} id={'quick-result-' + index} aria-selected={index === selected}
            onPointerDown={event => event.preventDefault()} onClick={() => pick(item)}>
            <span className="hub-result-icon"><Icon size={16}/></span>
            <span><strong>{item.title}</strong>{(inNote || item.detail) && <small>{inNote ? '备注 · ' + item.note : item.detail}</small>}</span>
            <span className="hub-result-label">{item.label}</span>
          </button>;
        })}
      </div>
      {!waiting && !options.length && <p className="quick-empty" role="status">{term ? '没有匹配的结果。试试更短的词，或切换搜索范围。' : '输入关键词查找。'}</p>}
      <div className="hub-search-footnote"><span><kbd>↑</kbd> <kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span><kbd>Esc</kbd> 收起</span></div>
    </div>}
  </div>;
}
