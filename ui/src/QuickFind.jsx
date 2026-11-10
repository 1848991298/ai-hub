import React, { useEffect, useState } from 'react';
import { ArrowUpRight, FileText, FolderGit2, ListTodo, Search, Sparkles } from 'lucide-react';

const groups = [
  ['工程', FolderGit2, 'projects'],
  ['技能', Sparkles, 'skills'],
  ['规则章节', FileText, 'rules'],
  ['问题与任务', ListTodo, 'ledger'],
];

function matches(data, ledger, query) {
  const term = query.trim().toLowerCase();
  const records = [...(ledger?.issues || []), ...(ledger?.tasks || [])];
  const lists = [
    data.projects.map(item => ({ id: item.id, title: item.name, detail: item.repository, params: { resource: item.id } })),
    data.skills.map(item => ({ id: item.id, title: item.title, detail: item.id, params: { resource: item.id } })),
    data.rules.sections.map(item => ({ id: item.id, title: item.title, detail: '共享全局规则', params: { section: item.title } })),
    term ? records.map(item => ({ id: item.kind + item.id, title: item.content, detail: (item.kind === 'task' ? '任务' : '问题') + ' · ' + item.status, params: { kind: item.kind, record: item.id, archive: item.archived ? 'archived' : 'active' }, keywords: (item.tags || []).join(' ') + ' ' + item.id })) : [],
  ];
  return groups.map(([label, Icon, page], index) => {
    const found = lists[index].filter(item => [item.title, item.detail, item.keywords].join(' ').toLowerCase().includes(term));
    const rank = item => item.title.toLowerCase() === term ? 0 : item.title.toLowerCase().startsWith(term) ? 1 : 2;
    found.sort((a, b) => rank(a) - rank(b));
    return { label, Icon, page, items: found.slice(0, term ? 5 : 3) };
  });
}

export default function QuickFind({ data, ledger, inputRef, onPick }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const items = matches(data, ledger, query);
  const options = items.flatMap(group => group.items.map(item => ({ ...item, page: group.page })));
  useEffect(() => {
    document.getElementById('quick-result-' + active)?.scrollIntoView({ block: 'nearest' });
  }, [active, query]);
  function keydown(event) {
    if (event.nativeEvent.isComposing || !options.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = options[active] || options[0];
      onPick(target.page, target.params);
    }
  }
  return <>
    <div className="command-input"><Search size={19}/><input ref={inputRef} autoFocus role="combobox" aria-label="搜索工程、技能、规则或任务" aria-expanded="true" aria-controls="quick-results" aria-activedescendant={options.length ? 'quick-result-' + Math.min(active, options.length - 1) : undefined} placeholder="搜索工程、技能、规则或任务…" value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={keydown}/><kbd>ESC</kbd></div>
    <div className="search-results quick-results" id="quick-results" role="listbox" aria-label="搜索结果">
      {items.filter(group => group.items.length).map(({label, Icon, page, items: rows}) => <div role="group" aria-label={label} key={page}>
        <div className="quick-group-label" aria-hidden="true">{label}</div>
        {rows.map(item => {
          const index = options.findIndex(option => option.page === page && option.id === item.id);
          return <button type="button" role="option" tabIndex={-1} key={item.id} id={'quick-result-' + index} aria-selected={index === Math.min(active, options.length - 1)} onClick={() => onPick(page, item.params)}><Icon size={17}/><span><strong>{item.title}</strong><small>{item.detail}</small></span><ArrowUpRight size={14}/></button>;
        })}
      </div>)}
      {!options.length && <p className="quick-empty">没有找到匹配项，试试模块名或记录关键词。</p>}
    </div>
    <div className="modal-footnote"><kbd>↑</kbd> <kbd>↓</kbd> 选择 · <kbd>↵</kbd> 打开对应位置{ledger?.error ? ' · 台账搜索使用上次成功读取的数据' : ''}</div>
  </>;
}
