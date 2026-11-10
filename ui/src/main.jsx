import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Blocks, Bluetooth, BookOpen,
  Bot, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Code2,
  Copy, FileCode2, FileText, Folder, FolderGit2, Gauge, GitBranch, GitCommitHorizontal, GitCompare,
  HardDrive, History, Layers3, LayoutGrid, Link2, ListTodo, LoaderCircle,
  Menu, Palette, Package, PanelLeftClose, PanelLeftOpen, PanelRightClose, PencilLine, Pin, Plus, RefreshCw,
  Search, Send, Settings2, ShieldCheck, Sparkles, Store, Terminal, X,
} from 'lucide-react';
import './styles.css';
import './themes.css';
import './workspace.css';
import UsagePage from './UsagePage.jsx';
import QuickFind from './QuickFind.jsx';
import { readRoute, routeHash } from './navigation.js';
import MarketPage from './MarketPage.jsx';
import LedgerPage from './LedgerPage.jsx';
import RulesPage, { RulesSync } from './RulesPage.jsx';
import { ProjectAdd } from './ProjectTools.jsx';
import { ProjectGit } from './ProjectGit.jsx';
import { PanelResize, useWorkspaceLayout } from './WorkspaceLayout.jsx';
import { themes, validTheme, applyTheme } from './themes.js';
import { attentionItems, connectedSpaces, pinnedSkills, recentProjects, storedPins, storedVisits, togglePin } from './overview-model.js';

const icons = { activity: Activity, hub: Blocks, bluetooth: Bluetooth, layers: Layers3, terminal: Terminal, git: GitBranch, package: Package, send: Send, file: FileText, cursor: Code2 };
const pages = [
  { id: 'overview', label: '工作台', icon: LayoutGrid, group: '工作空间' },
  { id: 'projects', label: '工程合集', icon: FolderGit2 },
  { id: 'skills', label: 'Skills', icon: Sparkles, group: 'AI 资源' },
  { id: 'rules', label: 'Rules', icon: FileText },
  { id: 'ledger', label: '问题与任务', icon: ListTodo, group: '产品运营' },
  { id: 'market', label: '应用运营', icon: Store },
  { id: 'usage', label: '用量中心', icon: Gauge, group: '运行洞察' },
  { id: 'changes', label: '变更与同步', icon: GitCompare, group: '维护' },
];
const titles = { ledger: ['问题与任务', '查看、新增和修改飞书多维表格，并读回最新记录。'], market: ['应用运营', 'ISHO 的渠道版本、增长与业务数据。'], usage: ['用量中心', '看清每日消耗，掌握账号余量。'], overview: ['工作台', '今天要处理的事，以及最近打开的工程。'], projects: ['工程合集', '在一个地方，找到你的每一个工作空间。'], skills: ['Skills', '技能只放一份，Cursor、Codex 和 Agents 各自读取。'], rules: ['Rules', '一份清晰的约定，贯穿每一次协作。'], changes: ['变更与同步', '每一次修改，都有迹可循。'] };
const readers = [['Cursor', Code2], ['Codex', Blocks], ['Agents', Bot]];
const currentRoute = () => {
  const route = readRoute(location.hash);
  return pages.some(p => p.id === route.page) ? route : { page: 'overview', params: {} };
};
const noInspector = ['usage', 'rules', 'market', 'ledger', 'changes'];
const colors = { '设备连接': 'blue', '工程协作': 'sage', '应用发布': 'violet', '工作效率': 'amber' };
const fmtTime = value => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
const fmtDate = value => new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
const shortPath = path => path?.replace(/^\/Users\/[^/]+/, '~') || '';
const getDraft = key => { try { return localStorage.getItem('ai-hub-draft:' + key); } catch { return null; } };
function readStored(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function readResourceDrafts() {
  try { return ['new-project','new-skill'].flatMap(type => JSON.parse(localStorage.getItem(`ai-hub-new-${type}`) || '[]').map(draft => ({...draft, type}))); }
  catch { return []; }
}

function Icon({ name, ...props }) { const C = icons[name] || FileText; return <C {...props} />; }
function Badge({ children, tone = '', dot = false }) { return <span className={`badge ${tone}`}>{dot && <i />}{children}</span>; }
function Markdown({ children }) { return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: props => <a {...props} target="_blank" rel="noreferrer" /> }}>{children || ''}</ReactMarkdown></div>; }
function IconButton({ title, children, ...rest }) { return <button className="icon-button" title={title} aria-label={title} {...rest}>{children}</button>; }
function Empty({ query = '' }) { return <div className="empty"><Search size={25} /><h3>没有找到匹配的资源</h3><p>{query ? `试试其他关键词，或清除「${query}」` : '切换筛选条件，看看其他资源。'}</p></div>; }

function App() {
  const layout = useWorkspaceLayout();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [route, setRoute] = useState(currentRoute);
  const { page, params } = route;
  const [clock, setClock] = useState(() => new Date());
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部技能');
  const [projectFilter, setProjectFilter] = useState('全部工程');
  const [selections, setSelections] = useState({});
  const type = page === 'skills' ? 'skill' : 'project';
  const focus = params.resource && ['projects', 'skills'].includes(page)
    ? { type, id: params.resource }
    : selections[page] || (page === 'overview' ? null : { type, id: data?.[page]?.[0]?.id });
  const [inspector, setInspector] = useState(() => window.innerWidth >= 1024);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState('');
  const [drafts, setDrafts] = useState(readResourceDrafts);
  const [compact, setCompact] = useState(() => localStorage.getItem('ai-hub-compact') === 'true');
  const [theme, setTheme] = useState(() => { try { return validTheme(localStorage.getItem('ai-hub-theme')); } catch { return 'graphite'; } });
  const preferenceWrite = useRef(false);
  const appearanceRevision = useRef(0);
  const [mobileNav, setMobileNav] = useState(false);
  const [pins, setPins] = useState(() => storedPins(readStored('ai-hub-pinned-skills')));
  const [visits, setVisits] = useState(() => storedVisits(readStored('ai-hub-recent-projects')));
  const [attention, setAttention] = useState({ ready: false, ledger: null, market: null, rules: null });
  const attentionRequest = useRef(0);
  const toastTimer = useRef();
  const searchInput = useRef();
  useEffect(() => { const onFocus=()=>refresh(false); window.addEventListener('focus',onFocus); return ()=>window.removeEventListener('focus',onFocus); },[]);

  function notify(message) { clearTimeout(toastTimer.current); setToast(message); toastTimer.current = setTimeout(() => setToast(''), 3200); }
  async function refresh(showToast = true) {
    setLoading(true);
    const revision = appearanceRevision.current;
    try {
      const response = await fetch('/api/snapshot');
      if (!response.ok) throw new Error('本地服务暂时无法读取 Hub');
      const snapshot = await response.json();
      setData(snapshot); setError('');
      if (!preferenceWrite.current && revision === appearanceRevision.current) setTheme(validTheme(snapshot.preferences?.theme));
      if (showToast) notify('已重新读取本地 Hub，文件保持原样');
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
    loadAttention();
  }
  async function loadAttention() {
    const request = ++attentionRequest.current;
    const read = path => fetch(path).then(response => response.ok ? response.json() : { error: true }).catch(() => ({ error: true }));
    const [ledger, market, rules] = await Promise.all([
      read('/api/tracker/snapshot'), read('/api/market/snapshot'), read('/api/rules'),
    ]);
    if (request === attentionRequest.current) setAttention({ ready: true, ledger, market, rules });
  }
  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => {
    let active = true;
    async function syncAppearance() {
      if (document.hidden || preferenceWrite.current) return;
      const revision = appearanceRevision.current;
      try {
        const response = await fetch('/api/preferences');
        if (response.ok) { const value = await response.json(); if (active && !preferenceWrite.current && revision === appearanceRevision.current) setTheme(validTheme(value.theme)); }
      } catch { /* 保留当前外观，连接状态由工作台数据请求显示。 */ }
    }
    const timer = setInterval(syncAppearance, 4000);
    addEventListener('focus', syncAppearance);
    document.addEventListener('visibilitychange', syncAppearance);
    return () => { active = false; clearInterval(timer); removeEventListener('focus', syncAppearance); document.removeEventListener('visibilitychange', syncAppearance); };
  }, []);
  async function chooseTheme(id) {
    if (preferenceWrite.current) return;
    const next = validTheme(id); appearanceRevision.current += 1; preferenceWrite.current = true; setTheme(next);
    try {
      const response = await fetch('/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: next }) });
      if (!response.ok) throw new Error();
      notify(`已切换为${themes.find(item => item.id === next).name}，两端外观已保存`);
    } catch { notify('当前窗口已切换；共享外观未保存，请检查本地服务后重试'); }
    finally { preferenceWrite.current = false; }
  }
  useEffect(() => { refresh(false); return () => clearTimeout(toastTimer.current); }, []);
  useEffect(() => { const update = () => setDrafts(readResourceDrafts()); addEventListener('ai-hub-drafts-changed', update); return () => removeEventListener('ai-hub-drafts-changed', update); }, []);
  useEffect(() => {
    function readLocation() {
      setRoute(currentRoute());
      setQuery('');
      setMobileNav(false);
    }
    addEventListener('hashchange', readLocation);
    addEventListener('popstate', readLocation);
    return () => { removeEventListener('hashchange', readLocation); removeEventListener('popstate', readLocation); };
  }, []);
  useEffect(() => {
    function keydown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setModal({ type: 'search' }); }
      if (event.key === 'Escape') { setModal(null); setMobileNav(false); }
      if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(event.target.tagName) && !modal) { event.preventDefault(); searchInput.current?.focus(); }
    }
    addEventListener('keydown', keydown);
    return () => removeEventListener('keydown', keydown);
  }, [modal]);
  useEffect(() => {
    if (page !== 'overview') return;
    function update() {
      if (document.hidden) return;
      setClock(new Date());
      loadAttention();
    }
    update();
    const timer = setInterval(update, 30000);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [page]);
  function navigate(next, destination = {}) {
    const hash = routeHash(next, destination);
    if (location.hash !== hash) history.pushState(null, '', hash);
    setRoute({ page: next, params: destination });
    setQuery('');
    setMobileNav(false);
    if (destination.resource) setInspector(true);
  }
  function select(type, id, targetPage = page) {
    setSelections(previous => ({ ...previous, [targetPage]: { type, id } }));
    if (targetPage === page && params.resource) navigate(page, { ...params, resource: id });
    setInspector(true);
    if (type !== 'project') return;
    setVisits(current => {
      const next = { ...current, [id]: Date.now() };
      try { localStorage.setItem('ai-hub-recent-projects', JSON.stringify(next)); } catch { /* 最近工程只留在这台机器 */ }
      return next;
    });
  }
  function pinSkill(id) {
    setPins(current => {
      const next = togglePin(current, id);
      try { localStorage.setItem('ai-hub-pinned-skills', JSON.stringify(next)); } catch { notify('这台机器无法记住钉住的技能'); }
      return next;
    });
  }
  async function copy(value) { try { await navigator.clipboard.writeText(value); notify('已复制到剪贴板'); } catch { notify('当前浏览器不允许复制，请直接选择文本'); } }
  const match = (...values) => values.filter(Boolean).join(' ').toLowerCase().includes(query.trim().toLowerCase());
  const filteredSkills = data?.skills.filter(s => (category === '全部技能' || s.category === category) && match(s.id, s.title, s.description));
  const filteredProjects = data?.projects.filter(p => (projectFilter === '全部工程' || p.platform === projectFilter) && match(p.name, p.subtitle, p.path, p.repository));
  const selectedProject = focus?.type === 'project' && data?.projects.find(p => p.id === focus.id);
  const selectedSkill = focus?.type === 'skill' && data?.skills.find(s => s.id === focus.id);
  const mapped = data?.skills.flatMap(s => s.mappings).filter(m => m.mapped).length || 0;
  const allMappings = data?.skills.flatMap(s => s.mappings).length || 0;
  const readerStats = readers.map(([name, ReaderIcon]) => {
    const found = data?.skills.map(s => s.mappings.find(m => m.client === name)).filter(Boolean) || [];
    return { name, ReaderIcon, mapped: found.filter(m => m.mapped).length, total: found.length, folder: found[0]?.path.replace(/\/[^/]+$/, '') };
  });
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(clock);
  const homeItems = data && attention.ready ? attentionItems({ mapped, allMappings, changes: data.changes, ledger: attention.ledger, market: attention.market, rules: attention.rules, today }) : [];
  const homeSpaces = data && attention.ready ? connectedSpaces({ projects: data.projects, skills: data.skills, ledger: attention.ledger, market: attention.market }) : [];
  const homeProjects = data ? recentProjects(data.projects, visits) : [];
  const homeSkills = data ? pinnedSkills(data.skills, pins) : [];
  const themeName = themes.find(item => item.id === theme)?.name || '石墨白';
  const [title, subtitle] = titles[page];
  const hasInspector = !noInspector.includes(page) && (page !== 'overview' || !!focus);
  const showInspector = inspector && hasInspector;

  function projectCard(project) {
    return <article key={project.id} className={`project-card ${selectedProject?.id === project.id && inspector ? 'selected' : ''}`}>
      <button className="project-card-select" onClick={() => select('project', project.id)}><div className="project-card-top"><div className={`resource-icon ${project.color}`}><Icon name={project.icon} size={23} /></div><span className="project-platform" title={project.platform_source}>{project.platform}<ArrowUpRight size={13} /></span></div>
      <h3>{project.name}<ChevronRight size={16} /></h3><p>{project.subtitle}</p>
      <div className="project-tags">{project.tags.map(tag => <span key={tag}>{tag}</span>)}</div>{project.development_base && <small className="project-base">开发基准 <code>{project.development_base}</code></small>}
      </button><div className="project-card-footer"><button className="project-branch-trigger" disabled={!project.is_git} title="查看当前检出、开发基准与工作树" onClick={() => setModal({type:'branches',id:project.id})}><GitBranch size={13}/><span>{project.branch ? '当前 ' + project.branch : project.exists ? '普通目录' : '路径不可用'}</span><ChevronDown size={12}/></button><i className={project.exists ? 'live-dot' : 'muted-dot'} title={project.exists ? '本地路径存在' : '路径未找到'} /></div>
    </article>;
  }
  function skillRow(skill) {
    const pinned = pins.includes(skill.id);
    return <div key={skill.id} className="skill-row-wrap">
      <button className={`skill-row ${selectedSkill?.id === skill.id && inspector ? 'selected' : ''}`} onClick={() => select('skill', skill.id)}>
        <span className={`resource-icon small ${colors[skill.category]}`}><Icon name={skill.icon} size={19} /></span>
        <span className="skill-name"><strong>{skill.title}</strong><code>{skill.id}</code></span>
        <span className="row-category">{skill.category}</span>
        <span className="client-dots" title={skill.mappings.map(m => `${m.client}：${m.mapped ? '已映射' : '待检查'}`).join('；')}>{readers.map(([name, ReaderIcon]) => <span key={name} className={skill.mappings.find(m => m.client === name)?.mapped ? 'on' : ''}><ReaderIcon size={13} /></span>)}</span>
        <ChevronRight size={15} className="row-chevron" />
      </button>
      <button type="button" className={`pin-skill ${pinned ? 'is-on' : ''}`} aria-pressed={pinned} aria-label={pinned ? `取消钉住 ${skill.title}` : `钉住 ${skill.title}`} onClick={() => pinSkill(skill.id)}><Pin size={15} /></button>
    </div>;
  }

  const collapsed = layout.sidebarCollapsed;
  return <div className={`app ${compact ? 'compact' : ''}`} style={{'--sidebar-width':layout.sidebarSpan+'px','--inspector-width':layout.inspectorWidth+'px','--ui-font-size':layout.fontSize+'px'}}><RulesSync page={page}/>
    <aside id="workspace-sidebar" className={`sidebar ${mobileNav ? 'mobile-open' : ''} ${collapsed ? 'is-collapsed' : ''}`}>
      <button className="brand" aria-label="AI Hub" onClick={() => navigate('overview')}><span className="brand-mark"><Blocks size={24} strokeWidth={1.7} /></span><span className="brand-copy">AI Hub</span></button>
      <nav>{pages.map(item => <React.Fragment key={item.id}>{item.group && <div className="nav-group">{item.group}</div>}<button className={`nav-item ${page === item.id ? 'active' : ''}`} aria-label={item.label} title={collapsed ? item.label : undefined} onClick={() => navigate(item.id)}><item.icon size={18} /><span className="nav-label">{item.label}</span>{item.id === 'skills' && data && <span className="nav-count">{data.skills.length}</span>}{item.id === 'changes' && !!data?.changes.length && <span className="nav-indicator" />}</button></React.Fragment>)}</nav>
      <div className="sidebar-bottom">{drafts.length > 0 && <button className="nav-item" aria-label="资源草稿箱" title={collapsed ? '资源草稿箱' : undefined} onClick={() => setModal({ type: 'drafts' })}><PencilLine size={17} /><span className="nav-label">资源草稿箱</span><span className="nav-count">{drafts.length}</span></button>}<button className="nav-item" aria-label="工作台设置" title={collapsed ? '工作台设置' : undefined} onClick={() => setModal({ type: 'settings' })}><Settings2 size={17} /><span className="nav-label">工作台设置</span></button><button type="button" className="nav-item sidebar-toggle" aria-expanded={!collapsed} title={collapsed ? '展开导航' : '收起导航'} onClick={() => layout.update('sidebarCollapsed', !collapsed)}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}<span className="nav-label">{collapsed ? '展开导航' : '收起导航'}</span></button><button className="profile" aria-label="关于 AI Hub" onClick={() => setModal({ type: 'about' })}><span className="avatar">{(data?.profile?.mark || '·').slice(0, 2)}</span><span className="nav-label"><strong>本机用户</strong><small>{data?.profile?.subtitle || '本机显示名'}</small></span><CircleHelp className="nav-extra" size={16} /></button></div>
      {!collapsed && <PanelResize className="sidebar-resize" label="调整导航栏宽度" controls="workspace-sidebar" value={layout.sidebarWidth} minimum={184} maximum={320} defaultValue={224} onChange={value => layout.update('sidebarWidth', value)} />}
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb"><IconButton title="展开导航" onClick={() => setMobileNav(!mobileNav)}><Menu size={18} /></IconButton></div><div className="topbar-actions"><button className="command-trigger" onClick={() => setModal({ type: 'search' })}><Search size={15} /><span>搜索任何资源…</span><kbd>⌘ K</kbd></button><IconButton title={`切换外观，当前${themeName}`} className="icon-button appearance-trigger" onClick={() => chooseTheme(themes[(themes.findIndex(item => item.id === theme) + 1) % themes.length].id)}><Palette size={16} /></IconButton><IconButton title="重新读取本地数据" onClick={() => page === 'usage' ? dispatchEvent(new Event('ai-hub-refresh-usage')) : page === 'ledger' ? dispatchEvent(new Event('ai-hub-refresh-ledger')) : page === 'market' ? dispatchEvent(new Event('ai-hub-refresh-market')) : refresh()}><RefreshCw size={16} className={loading ? 'spin' : ''} /></IconButton></div></header>
      {!data ? <div className="loading-page">{error ? <><HardDrive size={30} /><h2>本地服务尚未连接</h2><p>{error}</p><button className="button primary" onClick={() => refresh(false)}>重新连接</button></> : <><LoaderCircle className="spin" size={25} /><p>正在整理你的工作空间…</p></>}</div> : <>
        <div className={`workspace-body ${showInspector ? 'with-inspector' : ''}`}>
          <main className="main-content">
            {!['market','ledger'].includes(page) && <div className="page-heading"><div><h1>{title}<span className="heading-dot">.</span></h1><p>{subtitle}</p></div><div className="heading-actions">{page === 'overview' ? <div className="overview-date"><span className="today">{fmtDate(clock)}<span>{clock.toLocaleDateString('zh-CN', {weekday:'long',timeZone:'Asia/Shanghai'})}</span></span><small>工作台快照 {fmtDate(data.generated_at)} {fmtTime(data.generated_at)}</small></div> : page === 'projects' ? <button className="button primary" onClick={() => setModal({ type: 'new-project' })}><Plus size={16} />添加工程</button> : page === 'skills' ? <button className="button primary" onClick={() => setModal({ type: 'new-skill' })}><Plus size={16} />新建技能草稿</button> : page === 'rules' ? null : page === 'usage' ? null : <button className="button" onClick={() => page === 'usage' ? dispatchEvent(new Event('ai-hub-refresh-usage')) : refresh()}><RefreshCw size={15} />重新检查</button>}</div></div>}
            {error && <div className="inline-error">{error}，当前展示上次读取的数据。</div>}
            {page === 'ledger' && <LedgerPage sinkDone={layout.sinkDone} route={params} projects={data.projects} navigate={next => navigate('ledger', next)} />}
            {page === 'market' && <MarketPage route={params} navigate={next => navigate('market', next)} />}
            {page === 'usage' && <UsagePage onDiagnostics={() => setModal({ type: 'settings', diagnostics: true })} />}
            {page === 'overview' && <>
              <section className="attention" aria-label="待处理"><div className="section-heading"><h2>待处理</h2></div>{!attention.ready ? <p className="caption overview-empty">正在核对台账和商店。</p> : homeItems.length ? <div className="attention-list">{homeItems.map(item => <button key={item.id} onClick={() => navigate(item.page, item.params)}><span><strong>{item.title}</strong><small>{item.detail}</small></span><ArrowRight size={16} /></button>)}</div> : <p className="caption overview-empty">今天没有要处理的事。</p>}</section>
              <div className="section-heading"><h2>继续工作<span>{homeProjects.length}</span></h2><button className="text-button" onClick={() => navigate('projects')}>查看全部<ArrowRight size={14} /></button></div>
              {homeProjects.length ? <div className="project-grid">{homeProjects.map(projectCard)}</div> : <p className="caption overview-empty">还没有登记工程。<button className="text-button" onClick={() => setModal({ type: 'new-project' })}>添加工程</button></p>}
              <div className="section-heading skills-section"><h2>钉住的技能<span>{homeSkills.length}</span></h2><button className="text-button" onClick={() => navigate('skills')}>浏览技能库<ArrowRight size={14} /></button></div>
              {homeSkills.length ? <div className="skills-list">{homeSkills.map(skillRow)}</div> : <p className="caption overview-empty">在技能页钉住后，会出现在这里。</p>}
              {!!homeSpaces.length && <details className="overview-sources"><summary>已接入的数据来源</summary><div className="attention-list">{homeSpaces.map(item => <button key={item.id} onClick={() => navigate(item.page)}><span><strong>{item.title}</strong><small>{item.detail}</small></span><ArrowRight size={16}/></button>)}</div></details>}
            </>}
            {page === 'projects' && <><div className="filter-toolbar"><div className="segmented">{['全部工程',...new Set(data.projects.map(p=>p.platform))].map(value => <button key={value} className={projectFilter === value ? 'active' : ''} onClick={() => setProjectFilter(value)}>{value}</button>)}</div><span className="search-box"><Search size={15} /><input ref={searchInput} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索工程…" /></span></div><div className="project-grid large">{filteredProjects.map(projectCard)}</div>{!filteredProjects.length && <Empty query={query} />}<div className="section-heading"><h2>工程路径</h2><span className="subtle">保留独立仓库与 worktree</span></div><div className="path-list">{filteredProjects.map(p => <button key={p.id} onClick={() => select('project', p.id)}><Folder size={17} /><span><strong>{p.name}</strong><code>{shortPath(p.path)}</code></span><Badge tone={p.exists ? 'sage' : 'amber'} dot>{p.exists ? '路径可用' : '未找到路径'}</Badge></button>)}</div></>}
            {page === 'skills' && <><div className="reader-strip" aria-label="读取这些技能的客户端">{readerStats.map(({ name, ReaderIcon, mapped: count, total, folder }) => <button key={name} title="查看每个技能的映射" onClick={() => setModal({ type: 'sync' })}><ReaderIcon size={18} /><span><strong>{name}</strong><code>{shortPath(folder)}</code></span><Badge tone={count === total ? 'sage' : 'amber'} dot>{count} / {total}</Badge></button>)}</div><div className="skill-categories">{['全部技能',...new Set(data.skills.map(s => s.category))].map(value => <button className={category === value ? 'active' : ''} onClick={() => setCategory(value)} key={value}>{value}{value === '全部技能' && <span>{data.skills.length}</span>}</button>)}</div><div className="filter-toolbar"><span className="search-box wide"><Search size={16} /><input ref={searchInput} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索名称、用途或触发方式…" /><kbd>/</kbd></span><span className="subtle">{filteredSkills.length} 项能力</span></div><div className="list-labels"><span>技能</span><span>分类</span><span>读取端</span></div><div className="skills-list full">{filteredSkills.map(skillRow)}</div>{!filteredSkills.length && <Empty query={query} />}<div className="source-note"><Folder size={16} /><span>统一来源 <code>~/.ai-hub/skills</code></span><button className="text-button" onClick={() => copy(data.hub_root + '/skills')}>复制路径<Copy size={13} /></button></div></>}
            {page === 'rules' && <RulesPage route={params} notify={notify} onSaved={() => refresh(false)} />}
            {page === 'changes' && <><div className="change-summary"><div><h2>{data.changes.length ? `${data.changes.length} 个文件待整理` : '工作区保持整洁'}</h2><p><GitBranch size={14} />{data.projects.find(p => p.id === 'hub')?.branch || '未检测到分支'}<span>·</span>仅本地，不自动提交</p></div><button className="button primary" onClick={() => setModal({ type: 'sync' })}><Link2 size={15} />检查同步计划</button></div><div className="section-heading"><h2>当前变更<span>{data.changes.length}</span></h2><Badge>只读检查</Badge></div><div className="change-list">{data.changes.map(change => <div key={change.path}><span className={`change-letter ${change.status.includes('?') ? 'new' : ''}`}>{change.status.includes('?') ? '+' : change.status}</span><FileCode2 size={16} /><code>{change.path}</code><Badge>{change.status.includes('?') ? '未跟踪' : '已修改'}</Badge></div>)}</div>{!data.changes.length && <div className="clean-state"><CheckCheck size={24} /><p>所有来源文件已提交，没有待整理变更。</p></div>}<div className="section-heading"><h2>提交记录</h2><History size={16} className="muted" /></div><div className="history-list">{data.history.map(item => <div key={item.hash}><span className="timeline-dot"><GitCommitHorizontal size={16} /></span><div><h3>{item.message}</h3><p>{fmtDate(item.date)} · {fmtTime(item.date)}</p></div><button className="commit-hash" onClick={() => copy(item.hash)}>{item.hash}<Copy size={12} /></button></div>)}</div><div className="maintenance-actions"><button onClick={() => setModal({ type: 'migration' })}><ArrowDownToLine size={20} /><span><strong>迁移与恢复</strong><small>查看导出、校验及恢复方式</small></span><ArrowUpRight size={16} /></button><a href="https://github.com/1848991298/ai-hub#readme" target="_blank" rel="noreferrer"><BookOpen size={20} /><span><strong>项目维护档案</strong><small>前往飞书查看已确认的记录</small></span><ArrowUpRight size={16} /></a></div></>}
            {!['usage','market','ledger'].includes(page) && <footer className="page-footer"><span><span className="live-dot" />本地数据 · {fmtTime(data.generated_at)} 读取</span></footer>}
          </main>
          {showInspector && <><PanelResize label="调整详情栏宽度" controls="workspace-inspector" direction={-1} value={layout.inspectorWidth} minimum={280} maximum={Math.max(280, Math.min(560, layout.viewportWidth - layout.sidebarSpan - 367))} defaultValue={340} onChange={value => layout.update('inspectorWidth', value)} /><aside id="workspace-inspector" className="inspector"><div className="inspector-heading"><span>资源详情</span><IconButton title="收起详情" onClick={() => setInspector(false)}><PanelRightClose size={16} /></IconButton></div>
            {selectedProject && <><div className="detail-intro"><span className={`resource-icon hero ${selectedProject.color}`}><Icon name={selectedProject.icon} size={29} /></span><h2>{selectedProject.name}</h2><p>{selectedProject.subtitle}</p><Badge tone={selectedProject.exists ? 'sage' : 'amber'} dot>{selectedProject.exists ? '本地工程可读取' : '路径待检查'}</Badge></div><div className="detail-section"><h3>工程信息</h3><dl><div><dt>登记仓库</dt><dd>{selectedProject.repository}</dd></div><div><dt>当前分支</dt><dd className="branch-value"><button className="project-branch-trigger" disabled={!selectedProject.is_git} onClick={() => setModal({type:'branches',id:selectedProject.id})}><GitBranch size={12}/><span>{selectedProject.branch || '无 Git 分支'}</span><ChevronDown size={12}/></button></dd></div><div><dt>Worktrees</dt><dd>{selectedProject.worktrees}</dd></div><div><dt>工作区变更</dt><dd>{selectedProject.changes == null ? '待核实' : selectedProject.changes ? `${selectedProject.changes} 项` : '整洁'}</dd></div></dl><p className="project-source-caption">{selectedProject.platform_source}</p>{selectedProject.is_git && <button className="button" onClick={() => setModal({type:'branches',id:selectedProject.id})}><GitBranch size={14}/>查看 Git 详情</button>}<button className="path-copy" onClick={() => copy(selectedProject.path)}><Folder size={14} /><code>{shortPath(selectedProject.path)}</code><Copy size={13} /></button></div><div className="detail-section"><h3>建议关联的能力<Badge>预览配置</Badge></h3><div className="related-skills">{selectedProject.skills.map(id => data.skills.find(s => s.id === id)).filter(Boolean).map(s => <button key={s.id} onClick={() => { navigate('skills'); select('skill', s.id); }}><span className={`resource-icon mini ${colors[s.category]}`}><Icon name={s.icon} size={14} /></span><span>{s.title}</span><ChevronRight size={13} /></button>)}</div></div><div className="detail-section"><h3>规则来源</h3><button className="linked-rule" onClick={() => { navigate('rules'); }}><FileText size={16} /><div><strong>共享全局规则</strong><small>~/.ai-hub/rules/global.md</small></div><ArrowUpRight size={13} /></button><p className="caption">此处展示 Hub 共享规则；工程独有规则尚未扫描。</p></div>{selectedProject.document && <a className="detail-link" href={selectedProject.document} target="_blank" rel="noreferrer"><BookOpen size={15} />打开飞书项目档案<ArrowUpRight size={14} /></a>}</>}
            {selectedSkill && <><div className="detail-intro"><span className={`resource-icon hero ${colors[selectedSkill.category]}`}><Icon name={selectedSkill.icon} size={27} /></span><Badge>{selectedSkill.category}</Badge><h2>{selectedSkill.title}</h2><code>{selectedSkill.id}</code><p>{selectedSkill.description}</p></div><div className="detail-section"><h3>读取位置<span className="subtle">文件映射</span></h3><div className="mapping-list">{selectedSkill.mappings.map(m => <div key={m.client}><span>{React.createElement(readers.find(([name]) => name === m.client)?.[1] || FileText, { size: 15 })}{m.client}</span><Badge tone={m.mapped ? 'sage' : 'amber'} dot>{m.mapped ? '已映射' : '待检查'}</Badge></div>)}</div></div><div className="detail-section"><h3>技能来源</h3><button className="path-copy" onClick={() => copy(selectedSkill.path)}><Folder size={14} /><code>{shortPath(selectedSkill.path)}</code><Copy size={13} /></button><p className="caption">个人维护 · 最后修改于 {fmtDate(selectedSkill.modified)}</p></div><div className="detail-buttons"><button className="button primary" onClick={() => setModal({ type: 'editor', id: selectedSkill.id, title: selectedSkill.title, source: selectedSkill.source, path: selectedSkill.path })}><BookOpen size={15} />阅读与编辑草稿</button><button className="button" onClick={() => copy('$' + selectedSkill.id)}><Copy size={15} />复制调用方式</button></div></>}
            {!selectedProject && !selectedSkill && <div className="detail-intro"><Folder size={28} /><h2>选择一项资源</h2><p>在这里查看来源、状态与关联信息。</p></div>}
            <div className="inspector-bottom"><Link2 size={13} /><span>真实本地数据 · 规则可保存并同步</span></div>
          </aside></>}
          {!inspector && hasInspector && <button className="inspector-reopen" onClick={() => setInspector(true)} title="展开资源详情"><PanelRightClose size={17} /></button>}
        </div>
      </>}
    </div>
    {toast && <div role="status" className="toast"><Check size={16} />{toast}</div>}
    {modal && <Modal key={modal.type + (modal.id || '')} ledger={attention.ledger} onProjectAdded={async project => { await refresh(false); navigate('projects'); select('project',project.id,'projects'); setModal(null); notify('工程已添加，网页版与 App 共用本机清单'); }} layout={layout} modal={modal} data={data} drafts={drafts} notify={notify} copy={copy} close={() => setModal(null)} navigate={navigate} theme={theme} chooseTheme={chooseTheme} compact={compact} setCompact={value => { setCompact(value); localStorage.setItem('ai-hub-compact', String(value)); }} refresh={refresh} />}
    {mobileNav && <div className="nav-scrim" onClick={() => setMobileNav(false)} />}
  </div>;
}

function Modal({ onProjectAdded, layout, modal, data, ledger, drafts, close, notify, copy, navigate, compact, setCompact, theme, chooseTheme, refresh }) {
  const [value, setValue] = useState(() => getDraft(modal.id) ?? modal.source ?? '');
  const [tab, setTab] = useState('preview');
  const [form, setForm] = useState({ name: '', path: '', description: '' });
  const [person, setPerson] = useState(() => data?.profile || { name: '', mark: '', subtitle: '' });
  const [diag, setDiag] = useState(null);
  const dialogRef = useRef();
  const searchRef = useRef();
  useEffect(() => {
    const previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    (searchRef.current || dialogRef.current?.querySelector('button,input,textarea'))?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = overflow; previousFocus?.focus?.({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    function keys(event) {
      if (event.key === 'Tab') {
        const elements = [...dialogRef.current.querySelectorAll('button,input,textarea,a[href],select')].filter(el => !el.disabled);
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && modal.type === 'editor') { event.preventDefault(); saveDraft(); }
    }
    addEventListener('keydown', keys);
    return () => removeEventListener('keydown', keys);
  }, [value]);
  useEffect(() => {
    if (modal.type !== 'settings') return undefined;
    let active = true;
    fetch('/api/diagnostics').then(response => response.ok ? response.json() : null).then(value => { if (active && value) setDiag(value); }).catch(() => {});
    return () => { active = false; };
  }, [modal.type]);
  useEffect(() => {
    if (modal.diagnostics && diag) dialogRef.current?.querySelector('.settings-status')?.scrollIntoView({ block: 'start' });
  }, [diag, modal.diagnostics]);
  async function savePerson(event) {
    event.preventDefault();
    try {
      const response = await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(person) });
      if (!response.ok) throw new Error();
      notify('显示名已保存在这台电脑');
      refresh?.(false);
    } catch { notify('显示名没保存'); }
  }
  function saveDraft() { try { localStorage.setItem('ai-hub-draft:' + modal.id, value); notify('草稿已保存在此浏览器，来源文件未修改'); } catch { notify('浏览器无法保存草稿，请复制后保留'); } }
  const title = modal.type === 'editor' ? modal.title : ({ search: '快速查找', sync: '文件映射计划', settings: '工作台设置', about: '关于 AI Hub', migration: '迁移与恢复', branches:'Git 详情', 'new-project': '添加工程', 'new-skill': '新建技能草稿', drafts: '资源草稿箱' }[modal.type] || 'AI Hub');
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><section ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} className={`modal ${modal.type === 'editor' ? 'editor-modal' : ''} ${modal.type === 'search' ? 'search-modal' : ''} ${modal.type === 'branches' ? 'project-git-modal' : ''}`}><div className="modal-header"><div><h2>{title}</h2></div><IconButton title="关闭弹窗" onClick={close}><X size={19} /></IconButton></div>
      {modal.type === 'search' && data && <QuickFind data={data} ledger={ledger} inputRef={searchRef} onPick={(page, params) => { navigate(page, params); close(); }}/>}
      {modal.type === 'editor' && <><div className="editor-toolbar"><div className="segmented">{[['preview','阅读预览'],['edit','编辑草稿'],['diff','草稿差异']].map(([id,label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</div><Badge tone="amber">仅浏览器草稿</Badge></div><div className="editor-path"><FileText size={13} /><code>{shortPath(modal.path)}</code></div><div className="editor-content">{tab === 'preview' ? <Markdown>{value.replace(/^---\n[\s\S]*?\n---\n/, '')}</Markdown> : tab === 'edit' ? <textarea aria-label="Markdown 草稿编辑器" spellCheck={false} value={value} onChange={event => setValue(event.target.value)} /> : <div className="draft-diff"><div><h3>来源文件</h3><pre>{modal.source}</pre></div><div><h3>当前草稿<Badge>{value === modal.source ? '无差异' : '内容有变化'}</Badge></h3><pre>{value}</pre></div></div>}</div><div className="editor-footer"><span><HardDrive size={14} />草稿不会改动共享正文</span><div><button className="button" onClick={() => { setValue(modal.source); notify('编辑区已恢复来源内容，保存后更新浏览器草稿'); }}>恢复来源内容</button><button className="button primary" onClick={saveDraft}><Check size={15} />保存草稿<kbd>⌘ S</kbd></button></div></div></>}
      {modal.type === 'sync' && <div className="modal-body"><div className="modal-info"><ShieldCheck size={20} /><p>这是当前文件状态的只读预检，原型不会执行同步或替换。</p></div><div className="sync-table"><div><strong>技能</strong><strong>Cursor</strong><strong>Codex</strong><strong>Agents</strong></div>{data.skills.map(skill => <div key={skill.id}><code>{skill.id}</code>{skill.mappings.map(m => <span key={m.client} className={m.mapped ? 'green-text' : 'amber-text'}>{m.mapped ? <Check size={16} /> : <CircleHelp size={16} />}{m.mapped ? '已映射' : '待检查'}</span>)}</div>)}</div><button className="button" onClick={() => copy('bash "$HOME/.ai-hub/scripts/pull.sh" --check')}><Copy size={15} />复制命令行预检命令</button></div>}
      {modal.type === 'settings' && <div className="modal-body"><section className="theme-section"><h3>外观主题</h3><p>选择适合你的工作氛围，网页版与 App 共用外观设置。</p><div className="theme-grid" role="radiogroup" aria-label="外观主题">{themes.map(item => <button key={item.id} className="theme-option" role="radio" aria-checked={theme === item.id} aria-label={item.name} onClick={() => chooseTheme(item.id)}><span className="theme-sample" aria-hidden="true" style={{'--sample-canvas':item.canvas,'--sample-sidebar':item.sidebar,'--sample-text':item.text,'--sample-accent':item.accent}}><span className="sample-nav"><i/><i/><i/><i/></span><span className="sample-main"><i/><i/><i/><i/></span></span><span className="theme-label"><span><strong>{item.name}</strong><small>{item.description}</small></span>{theme === item.id && <Check size={17}/>}</span></button>)}</div></section><form className="settings-profile" onSubmit={savePerson}><h3>显示名</h3><p>只改这台电脑上的侧栏。规则里的称呼不跟着变。</p><label>名字<input value={person.name} maxLength={40} onChange={event => setPerson({ ...person, name: event.target.value })} /></label><label>头像字<input value={person.mark} maxLength={2} onChange={event => setPerson({ ...person, mark: event.target.value })} /></label><label>一句话<input value={person.subtitle} maxLength={40} onChange={event => setPerson({ ...person, subtitle: event.target.value })} /></label><button className="button primary" type="submit">保存显示名</button></form><section className="settings-status"><h3>缓存和日志</h3>{(diag?.caches || []).map(item => <div className="settings-line" key={item.id}><div><strong>{item.label}</strong><p>{item.detail}</p><p>{item.updated ? `上次写入 ${item.updated}` : '还没有缓存'}</p></div></div>)}{(diag?.sources || []).map(item => <div className="settings-line" key={item.id}><div><strong>{item.label}</strong><p>{item.detail}</p></div><Badge tone={item.used ? 'sage' : ''}>{item.used ? '在用' : '不接入'}</Badge></div>)}<p className="caption">服务日志 {diag?.log_path || '~/Library/Logs/AI Hub/service.log'}</p><pre className="settings-log">{diag?.log?.length ? diag.log.join('\n') : '还没有服务日志。'}</pre></section><div className="settings-line"><div><strong>界面字号</strong><p>系统字体 · 中文采用系统中文字体</p></div><div className="layout-setting-controls"><div className="segmented" role="group" aria-label="界面字号">{[[13,'紧凑'],[14,'标准'],[15,'清晰']].map(([size,label]) => <button key={size} aria-pressed={layout.fontSize === size} className={layout.fontSize === size ? 'active' : ''} onClick={() => layout.update('fontSize',size)}>{label} {size}</button>)}</div></div></div><div className="settings-line"><div><strong>面板布局</strong><p>拖动分隔线调整左右栏，双击恢复默认。</p></div><button className="button" onClick={() => { layout.reset(); notify('已恢复默认面板宽度'); }}>恢复默认布局</button></div><div className="settings-line"><div><strong>紧凑显示</strong><p>减少列表间距，查看更多资源。</p></div><button className={`switch ${compact ? 'enabled' : ''}`} role="switch" aria-checked={compact} aria-label="紧凑显示" onClick={() => setCompact(!compact)}><span /></button></div><div className="settings-line"><div><strong>已完成沉底</strong><p>问题和任务中，已完成的记录排在当前排序底部。关掉后按表头排序。</p></div><button className={`switch ${layout.sinkDone ? 'enabled' : ''}`} role="switch" aria-checked={layout.sinkDone} aria-label="已完成沉底" onClick={() => layout.update('sinkDone', !layout.sinkDone)}><span /></button></div><div className="settings-line"><div><strong>Hub 维护源</strong><p>{data?.hub_root || '~/.ai-hub'}</p></div><HardDrive size={19} /></div><div className="settings-line"><div><strong>当前模式</strong><p>规则保存到 Hub 并同步；技能编辑仍为浏览器草稿</p></div><Badge tone="sage">本机</Badge></div><p className="caption">规则在打开、重新聚焦与切换页面时检查同步；工程列表读取本机登记。</p></div>}
      {modal.type === 'drafts' && <div className="modal-body"><p className="caption draft-note">以下信息仅存于此浏览器，尚未加入工程登记或技能来源。</p>{drafts.map((draft, index) => <div className="resource-draft" key={draft.created_at + index}><div><Badge tone="sage">{draft.type === 'new-project' ? '工程草稿' : '技能草稿'}</Badge><h3>{draft.name}</h3><p>{draft.path}</p>{draft.description && <p>{draft.description}</p>}<small>{fmtDate(draft.created_at)} · {fmtTime(draft.created_at)}</small></div><IconButton title="复制资源草稿" onClick={() => copy(JSON.stringify(draft, null, 2))}><Copy size={16} /></IconButton></div>)}</div>}
      {modal.type === 'about' && <div className="modal-body about"><span className="brand-mark"><Blocks size={29} /></span><h2>围绕你的工作方式。</h2><p>AI Hub 把工程、Skills、Rules 和各客户端的读取位置连接起来。文件保留开放格式，界面提供清晰的管理入口。</p><Badge tone="sage">0.7.0 · Web 与 macOS 工作台</Badge></div>}
      {modal.type === 'migration' && <div className="modal-body"><p>现有 Hub 已有导出与恢复脚本。这版界面提供命令入口，实际操作继续由命令行执行。</p><div className="command-block"><code>python3 scripts/hub.py export --output /目标目录/ai-hub.tar.gz</code><IconButton title="复制导出命令" onClick={() => copy('python3 scripts/hub.py export --output /目标目录/ai-hub.tar.gz')}><Copy size={15} /></IconButton></div><div className="command-block"><code>python3 scripts/hub.py restore --backup .backups/实际批次</code><IconButton title="复制恢复预检命令" onClick={() => copy('python3 scripts/hub.py restore --backup .backups/实际批次')}><Copy size={15} /></IconButton></div><p className="caption">恢复命令默认只核对。移动 Hub 后使用 --relocate 重建固定入口；完整说明见 docs/portability.md。</p></div>}
      {modal.type === 'new-project' && <ProjectAdd onAdded={onProjectAdded} onExisting={id=>{navigate('projects', { resource: id });close();}}/>}
      {modal.type === 'branches' && <ProjectGit key={modal.id} projectId={modal.id}/>}
      {modal.type === 'new-skill' && <form className="modal-body resource-form" onSubmit={event => { event.preventDefault(); try { const key = `ai-hub-new-${modal.type}`; const drafts = JSON.parse(localStorage.getItem(key) || '[]'); localStorage.setItem(key, JSON.stringify([...drafts, { ...form, created_at: new Date().toISOString() }])); dispatchEvent(new Event('ai-hub-drafts-changed')); notify('新资源草稿已保存在此浏览器，尚未加入来源清单'); close(); } catch { notify('无法保存，请检查浏览器本地存储'); } }}><div className="modal-info"><PencilLine size={18} /><p>先整理资源信息；原型仅保存本地草稿。</p></div><label>{modal.type === 'new-project' ? '工程名称' : '技能名称'}<input required autoFocus value={form.name} placeholder={modal.type === 'new-project' ? '例如：我的新工程' : '例如：review-release'} onChange={event => setForm({ ...form, name: event.target.value })} /></label><label>{modal.type === 'new-project' ? '本地路径' : '用途说明'}<input required value={form.path} placeholder={modal.type === 'new-project' ? '~/Projects/my-project' : '这个技能帮助完成什么工作'} onChange={event => setForm({ ...form, path: event.target.value })} /></label><label>备注<textarea rows={3} value={form.description} placeholder="补充适用场景或需要关联的资源…" onChange={event => setForm({ ...form, description: event.target.value })} /></label><button type="submit" className="button primary"><Check size={15} />保存资源草稿</button></form>}
    </section></div>;
}

createRoot(document.getElementById('root')).render(<App />);
