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
import './desktop.css';
import UsagePage from './UsagePage.jsx';
import QuickFind from './QuickFind.jsx';
import { readRoute, routeHash } from './navigation.js';
import MarketPage from './MarketPage.jsx';
import LedgerPage from './LedgerPage.jsx';
import RulesPage, { RulesSync } from './RulesPage.jsx';
import { ProjectAdd } from './ProjectTools.jsx';
import { ProjectGit } from './ProjectGit.jsx';
import { PanelResize, useWorkspaceLayout } from './WorkspaceLayout.jsx';
import { StatusLink, WorkspaceProfile, WorkspaceStatus } from './WorkspaceChrome.jsx';
import HubMark from './HubMark.jsx';
import WorkspaceSettings, { workspaceModules } from './WorkspaceSettings.jsx';
import { themes, validTheme, applyTheme } from './themes.js';
import { attentionItems, connectedSpaces, pinnedSkills, recentProjects, storedPins, storedVisits, togglePin } from './overview-model.js';

const icons = { activity: Activity, hub: Blocks, bluetooth: Bluetooth, layers: Layers3, terminal: Terminal, git: GitBranch, package: Package, send: Send, file: FileText, cursor: Code2, palette: Palette };
const pages = [
  { id: 'overview', label: '工作台', icon: LayoutGrid, group: '工作空间' },
  { id: 'projects', label: '工程合集', icon: FolderGit2, group: '工作空间' },
  { id: 'ledger', label: '问题与任务', icon: ListTodo, group: '工作空间' },
  { id: 'skills', label: 'Skills', icon: Blocks, group: 'AI 资源' },
  { id: 'rules', label: 'Rules', icon: FileText, group: 'AI 资源' },
  { id: 'usage', label: '用量中心', icon: Gauge, group: '运行与维护' },
  { id: 'market', label: '应用运营', icon: Store, group: '运行与维护' },
  { id: 'changes', label: '变更与同步', icon: GitCompare, group: '运行与维护' },
];
const titles = { settings: ['工作台设置', ''], ledger: ['问题与任务', '查看、新增和修改飞书多维表格，并读回最新记录。'], market: ['应用运营', 'ISHO 的渠道版本、增长与业务数据。'], usage: ['用量中心', '看清每日消耗，掌握账号余量。'], overview: ['工作台', '今天要处理的事，以及最近打开的工程。'], projects: ['工程合集', '在一个地方，找到你的每一个工作空间。'], skills: ['Skills', 'Cursor 和 Codex 共用一份技能来源。'], rules: ['Rules', '一份清晰的约定，贯穿每一次协作。'], changes: ['变更与同步', '每一次修改，都有迹可循。'] };
const readers = [['Cursor', Code2], ['Codex', Blocks], ['Agents', Bot]];
const readerLabel = name => name === 'Agents' ? 'Codex 通用目录' : name;
const currentRoute = () => {
  const route = readRoute(location.hash);
  return route.page === 'settings' || pages.some(p => p.id === route.page) ? route : { page: 'overview', params: {} };
};
const noInspector = ['usage', 'rules', 'market', 'ledger', 'changes', 'settings'];
const colors = { '设备连接': 'blue', '工程协作': 'sage', '应用发布': 'violet', '工作效率': 'amber', '界面设计': 'violet' };
const ownershipLabels = { personal: '自建', 'third-party': '第三方' };
const fmtTime = value => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
const fmtDate = value => new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
const shortPath = path => path?.replace(/^\/Users\/[^/]+/, '~') || '';
const getDraft = key => { try { return localStorage.getItem('ai-hub-draft:' + key); } catch { return null; } };
function readStored(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function storePreference(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 当前窗口仍可使用设置 */ } }
function readResourceDrafts() {
  try { return ['new-project','new-skill'].flatMap(type => JSON.parse(localStorage.getItem(`ai-hub-new-${type}`) || '[]').map(draft => ({...draft, type}))); }
  catch { return []; }
}

function Icon({ name, ...props }) { const C = icons[name] || FileText; return <C {...props} />; }
function Badge({ children, tone = '', dot = false }) { return <span className={`badge ${tone}`}>{dot && <i />}{children}</span>; }
function SkillOwnership({ ownership }) {
  return <span className="badge skill-ownership">{ownershipLabels[ownership] || '归属待标记'}</span>;
}
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
  const [compact, setCompact] = useState(() => readStored('ai-hub-compact') === true);
  const [rowHeight, setRowHeight] = useState(() => readStored('ai-hub-ledger-row-height') === 'auto' ? 'auto' : 'single');
  const [motion, setMotion] = useState(() => readStored('ai-hub-motion') !== false);
  const [hiddenModules, setHiddenModules] = useState(() => {
    const stored = readStored('ai-hub-hidden-modules');
    return Array.isArray(stored) ? workspaceModules.map(item => item.id).filter(id => stored.includes(id)) : [];
  });
  const [theme, setTheme] = useState(() => { try { return validTheme(localStorage.getItem('ai-hub-theme')); } catch { return 'graphite'; } });
  const preferenceWrite = useRef(false);
  const appearanceRevision = useRef(0);
  const [mobileNav, setMobileNav] = useState(false);
  const [syncAnchor, setSyncAnchor] = useState(null);
  const [pins, setPins] = useState(() => storedPins(readStored('ai-hub-pinned-skills')));
  const [visits, setVisits] = useState(() => storedVisits(readStored('ai-hub-recent-projects')));
  const [attention, setAttention] = useState({ ready: false, ledger: null, market: null, rules: null });
  const [deleteFailures, setDeleteFailures] = useState([]);
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
  useEffect(() => { storePreference('ai-hub-compact', compact); }, [compact]);
  useEffect(() => { storePreference('ai-hub-ledger-row-height', rowHeight); }, [rowHeight]);
  useEffect(() => { storePreference('ai-hub-motion', motion); }, [motion]);
  useEffect(() => { storePreference('ai-hub-hidden-modules', hiddenModules); }, [hiddenModules]);
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
      setModal(null);
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
      if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); setModal(null); navigate('settings'); }
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
  useEffect(() => {
    if (page === 'ledger') return;
    let active = true;
    let timer;
    async function checkDeletes() {
      let retry = true;
      try {
        const response = await fetch('/api/tracker/snapshot');
        if (response.ok && active) {
          const value = await response.json();
          if (!active) return;
          const jobs = (value.sync?.jobs || []).filter(job => job.operation === 'delete');
          setDeleteFailures(jobs.filter(job => job.state === 'failed'));
          retry = jobs.some(job => job.state === 'pending' || job.state === 'writing');
        }
      } catch { /* Local service may be restarting. */ }
      if (active && retry) timer = setTimeout(checkDeletes, 2500);
    }
    checkDeletes();
    return () => { active = false; clearTimeout(timer); };
  }, [page]);
  function navigate(next, destination = {}) {
    const hash = routeHash(next, destination);
    if (location.hash !== hash) history.pushState(null, '', hash);
    setRoute({ page: next, params: destination });
    setQuery('');
    setMobileNav(false);
    if (destination.resource) setInspector(true);
  }
  function toggleModule(id) {
    setHiddenModules(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
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
  const filteredSkills = data?.skills.filter(s => (category === '全部技能' || s.category === category) && match(s.id, s.title, s.description, s.guide, s.author, ownershipLabels[s.ownership]));
  const filteredProjects = data?.projects.filter(p => (projectFilter === '全部工程' || p.platform === projectFilter) && match(p.name, p.subtitle, p.path, p.repository));
  const selectedProject = focus?.type === 'project' && data?.projects.find(p => p.id === focus.id);
  const selectedSkill = focus?.type === 'skill' && data?.skills.find(s => s.id === focus.id);
  const skillCommand = selectedSkill ? '$' + selectedSkill.id : '';
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
    const selected = selectedSkill?.id === skill.id && inspector;
    const mappingLabel = skill.mappings.map(m => readerLabel(m.client) + '：' + (m.mapped ? '已映射' : '待检查')).join('；');
    return <div key={skill.id} className="skill-row-wrap">
      <button className={`skill-row ${selected ? 'selected' : ''}`} aria-current={selected || undefined} onClick={() => select('skill', skill.id)}>
        <span className={`resource-icon small ${colors[skill.category]}`}><Icon name={skill.icon} size={19} /></span>
        <span className="skill-name">
          <strong>{skill.title}</strong>
          <span className="skill-meta"><SkillOwnership ownership={skill.ownership} /><code>{skill.id}</code></span>
        </span>
        <span className="row-category">{skill.category}</span>
        <span className="client-dots" role="img" aria-label={mappingLabel} title={mappingLabel}>{readers.map(([name, ReaderIcon]) => <span key={name} className={skill.mappings.find(m => m.client === name)?.mapped ? 'on' : ''}><ReaderIcon size={13} /></span>)}</span>
        <ChevronRight size={15} className="row-chevron" />
      </button>
      <button type="button" className={`pin-skill ${pinned ? 'is-on' : ''}`} aria-pressed={pinned} aria-label={pinned ? `取消钉住 ${skill.title}` : `钉住 ${skill.title}`} onClick={() => pinSkill(skill.id)}><Pin size={15} /></button>
    </div>;
  }

  const collapsed = layout.sidebarCollapsed;
  const drawerNavigation = layout.viewportWidth <= 760;
  const navToggleLabel = (drawerNavigation ? mobileNav : !collapsed) ? '收起侧栏' : '展开侧栏';
  const navGroups = [...new Set(pages.map(item => item.group))].map(group => [
    group, pages.filter(item => item.group === group && !hiddenModules.includes(item.id)),
  ]);
  return <div className={`app ${compact ? 'compact' : ''} ${motion ? '' : 'hub-reduced-motion'}`} style={{'--sidebar-width':layout.sidebarSpan+'px','--inspector-width':layout.inspectorWidth+'px','--ui-font-size':layout.fontSize+'px'}}><RulesSync page={page}/>
    <aside id="workspace-sidebar" className={`sidebar ${mobileNav ? 'mobile-open' : ''} ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="hub-brand-row">
        <button type="button" className="brand" aria-label="AI Hub 工作台" title="返回工作台" onClick={() => navigate('overview')}>
          <span className="brand-mark"><HubMark/></span><span className="brand-copy">AI Hub</span>
        </button>
        <IconButton className="icon-button hub-nav-toggle" title={navToggleLabel} aria-controls="workspace-sidebar"
          aria-expanded={drawerNavigation ? mobileNav : !collapsed}
          onClick={() => drawerNavigation ? setMobileNav(!mobileNav) : layout.toggleSidebar()}>
          {(drawerNavigation ? mobileNav : !collapsed) ? <PanelLeftClose size={17}/> : <PanelLeftOpen size={17}/>}
        </IconButton>
      </div>
      <nav aria-label="主导航">{navGroups.map(([group, items]) => items.length > 0 && <React.Fragment key={group}>
        <div className="nav-group">{group}</div>
        {items.map(item => <button key={item.id} type="button" className={page === item.id ? 'nav-item active' : 'nav-item'} aria-current={page === item.id ? 'page' : undefined} aria-label={item.label} title={collapsed ? item.label : undefined} onClick={() => navigate(item.id)}>
          <item.icon size={17} strokeWidth={1.5}/><span className="nav-label">{item.label}</span>
          {item.id === 'skills' && data && <span className="nav-count">{data.skills.length}</span>}
          {item.id === 'changes' && !!data?.changes.length && <span className="nav-indicator"/>}
        </button>)}
      </React.Fragment>)}</nav>
      <div className="sidebar-bottom">
        {drafts.length > 0 && <button className="nav-item" aria-label="资源草稿箱" title={collapsed ? '资源草稿箱' : undefined} onClick={() => setModal({ type: 'drafts' })}><PencilLine size={17} /><span className="nav-label">资源草稿箱</span><span className="nav-count">{drafts.length}</span></button>}
        <div className="hub-sidebar-controls">
          <button type="button" className={'nav-item hub-settings-link' + (page === 'settings' ? ' active' : '')}
            aria-current={page === 'settings' ? 'page' : undefined} aria-label="工作台设置" title="工作台设置"
            onClick={() => navigate('settings', { section: 'general' })}>
            <Settings2 size={17} strokeWidth={1.5}/><span className="nav-label">设置</span>
          </button>
          <WorkspaceProfile profile={data?.profile} onSettings={section => navigate('settings', { section })}/>
        </div>
      </div>
      {!collapsed && <PanelResize className="sidebar-resize" label="调整导航栏宽度" controls="workspace-sidebar" value={layout.sidebarWidth} minimum={184} maximum={320} defaultValue={224} onChange={value => layout.update('sidebarWidth', value)} />}
    </aside>
    <div className="workspace">
      <header className="topbar hub-topbar">
        <div className="breadcrumb hub-breadcrumb">
          {drawerNavigation && <IconButton className="icon-button hub-nav-toggle" title={mobileNav ? '收起导航' : '展开导航'}
            aria-controls="workspace-sidebar" aria-expanded={mobileNav} onClick={() => setMobileNav(!mobileNav)}><Menu size={18}/></IconButton>}
          <strong className="hub-breadcrumb-label">{title}</strong>
        </div>
        <QuickFind data={data} error={error} ledger={attention.ledger} onPick={navigate}
          pages={[...pages, { id: 'settings', label: '工作台设置' }]} disabled={Boolean(modal)}/>
        <div className="hub-topbar-status" ref={setSyncAnchor}>
          {(page !== 'ledger' || !data) && <WorkspaceStatus key={page} title="工作台数据"
            status={loading || (!data && !error) ? '正在读取' : error ? '读取异常' : '本地已就绪'}
            tone={loading || (!data && !error) ? 'is-busy' : error ? 'is-warning' : 'is-ready'}
            detail={error && data ? '读取异常 · 保留上次快照' : undefined}
            timestamp={data?.generated_at && fmtDate(data.generated_at) + ' ' + fmtTime(data.generated_at)}
            busy={loading} refreshLabel={loading ? '正在读取…' : error ? '重新连接' : '重新读取工作台'} onRefresh={() => refresh(false)}>
            {close => <>
              {data && page === 'usage' && <StatusLink icon={RefreshCw} onClick={() => { close(); dispatchEvent(new Event('ai-hub-refresh-usage')); }}>刷新用量</StatusLink>}
              {data && page === 'market' && <StatusLink icon={RefreshCw} onClick={() => { close(); dispatchEvent(new Event('ai-hub-refresh-market')); }}>刷新运营记录</StatusLink>}
              <StatusLink icon={History} onClick={() => { close(); navigate('changes'); }}>查看变更与同步</StatusLink>
            </>}
          </WorkspaceStatus>}
        </div>
      </header>
      {!data ? <div className="loading-page">{error ? <><HardDrive size={30} /><h2>本地服务尚未连接</h2><p>{error}</p><button className="button primary" onClick={() => refresh(false)}>重新连接</button></> : <><LoaderCircle className="spin" size={25} /><p>正在整理你的工作空间…</p></>}</div> : <>
        <div className={`workspace-body ${showInspector ? 'with-inspector' : ''}`}>
          <main className={'main-content' + (page === 'skills' ? ' skills-page' : page === 'settings' ? ' hub-settings-page' : '')}>
            {!['market','ledger','settings'].includes(page) && <div className="page-heading"><div><h1>{title}{page !== 'skills' && <span className="heading-dot">.</span>}</h1><p>{subtitle}</p></div><div className="heading-actions">{page === 'overview' ? <div className="overview-date"><span className="today">{fmtDate(clock)}<span>{clock.toLocaleDateString('zh-CN', {weekday:'long',timeZone:'Asia/Shanghai'})}</span></span><small>工作台快照 {fmtDate(data.generated_at)} {fmtTime(data.generated_at)}</small></div> : page === 'projects' ? <button className="button primary" onClick={() => setModal({ type: 'new-project' })}><Plus size={16} />添加工程</button> : page === 'skills' ? <button className="button primary" onClick={() => setModal({ type: 'new-skill' })}><Plus size={16} />新建技能草稿</button> : page === 'rules' ? null : page === 'usage' ? null : <button className="button" onClick={() => page === 'usage' ? dispatchEvent(new Event('ai-hub-refresh-usage')) : refresh()}><RefreshCw size={15} />重新检查</button>}</div></div>}
            {error && <div className="inline-error">{error}，当前展示上次读取的数据。</div>}
            {page !== 'ledger' && deleteFailures.length > 0 && <div className="ledger-sync-errors" role="alert">
              <header><strong>{deleteFailures.length} 条记录删除待处理</strong>
                <button type="button" className="text-button" onClick={() => navigate('ledger')}>查看失败原因<ArrowRight size={14}/></button>
              </header>
            </div>}
            {page === 'settings' && <WorkspaceSettings section={params.section} onNavigate={section => navigate('settings', { section })} hidden={hiddenModules} toggleModule={toggleModule}
              data={data} refresh={refresh} theme={theme} chooseTheme={chooseTheme} layout={layout} compact={compact} setCompact={setCompact}
              rowHeight={rowHeight} setRowHeight={setRowHeight} motion={motion} setMotion={setMotion}/>}
            {page === 'ledger' && <LedgerPage sinkDone={layout.sinkDone} rowHeight={rowHeight} setRowHeight={setRowHeight} suggestionsAvailable={data.features?.task_suggestions}
              route={params} projects={data.projects} syncAnchor={syncAnchor} navigate={next => navigate('ledger', next)}
              onSyncHistory={() => { loadAttention(); navigate('changes', { section: 'tracker' }); }}/>}
            {page === 'market' && <MarketPage route={params} navigate={next => navigate('market', next)} />}
            {page === 'usage' && <UsagePage onDiagnostics={() => navigate('settings', { section: 'diagnostics' })}/>}
            {page === 'changes' && params.section === 'tracker' && <section className="change-summary tracker-summary" aria-label="任务台账同步状态">
              <div>
                <h2>任务台账同步</h2>
                <p>{attention.ledger?.synced_at ? '最近成功 ' + fmtDate(attention.ledger.synced_at) + ' ' + fmtTime(attention.ledger.synced_at) : '尚无成功记录'}</p>
                {attention.ledger?.error && <p>{attention.ledger.error === true ? '暂时无法读取台账状态' : attention.ledger.error}</p>}
                {attention.ledger?.sync?.pending > 0 && <p>{attention.ledger.sync.pending} 项正在后台同步</p>}
              </div>
              <button type="button" className="button" onClick={() => navigate('ledger')}>返回任务台账<ArrowRight size={15}/></button>
            </section>}
            {page === 'overview' && <>
              <section className="attention" aria-label="待处理"><div className="section-heading"><h2>待处理</h2></div>{!attention.ready ? <p className="caption overview-empty">正在核对台账和商店。</p> : homeItems.length ? <div className="attention-list">{homeItems.map(item => <button key={item.id} onClick={() => navigate(item.page, item.params)}><span><strong>{item.title}</strong><small>{item.detail}</small></span><ArrowRight size={16} /></button>)}</div> : <p className="caption overview-empty">今天没有要处理的事。</p>}</section>
              <div className="section-heading"><h2>继续工作<span>{homeProjects.length}</span></h2><button className="text-button" onClick={() => navigate('projects')}>查看全部<ArrowRight size={14} /></button></div>
              {homeProjects.length ? <div className="project-grid">{homeProjects.map(projectCard)}</div> : <p className="caption overview-empty">还没有登记工程。<button className="text-button" onClick={() => setModal({ type: 'new-project' })}>添加工程</button></p>}
              <div className="section-heading skills-section"><h2>钉住的技能<span>{homeSkills.length}</span></h2><button className="text-button" onClick={() => navigate('skills')}>浏览技能库<ArrowRight size={14} /></button></div>
              {homeSkills.length ? <div className="skills-list">{homeSkills.map(skillRow)}</div> : <p className="caption overview-empty">在技能页钉住后，会出现在这里。</p>}
              {!!homeSpaces.length && <details className="overview-sources"><summary>已接入的数据来源</summary><div className="attention-list">{homeSpaces.map(item => <button key={item.id} onClick={() => navigate(item.page)}><span><strong>{item.title}</strong><small>{item.detail}</small></span><ArrowRight size={16}/></button>)}</div></details>}
            </>}
            {page === 'projects' && <><div className="filter-toolbar"><div className="segmented">{['全部工程',...new Set(data.projects.map(p=>p.platform))].map(value => <button key={value} className={projectFilter === value ? 'active' : ''} onClick={() => setProjectFilter(value)}>{value}</button>)}</div><span className="search-box"><Search size={15} /><input ref={searchInput} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索工程…" /></span></div><div className="project-grid large">{filteredProjects.map(projectCard)}</div>{!filteredProjects.length && <Empty query={query} />}<div className="section-heading"><h2>工程路径</h2><span className="subtle">保留独立仓库与 worktree</span></div><div className="path-list">{filteredProjects.map(p => <button key={p.id} onClick={() => select('project', p.id)}><Folder size={17} /><span><strong>{p.name}</strong><code>{shortPath(p.path)}</code></span><Badge tone={p.exists ? 'sage' : 'amber'} dot>{p.exists ? '路径可用' : '未找到路径'}</Badge></button>)}</div></>}
            {page === 'skills' && <>
              <div className="reader-strip">
                <ul className="reader-statuses" aria-label="技能读取目录和映射数量">
                  {readerStats.map(({ name, ReaderIcon, mapped: count, total, folder }) => (
                    <li key={name}>
                      <ReaderIcon size={16} aria-hidden="true" />
                      <span className="reader-name"><strong>{readerLabel(name)}</strong><code title={shortPath(folder)}>{shortPath(folder)}</code></span>
                      <Badge tone={count === total ? 'sage' : 'amber'} dot>{count} / {total}</Badge>
                    </li>
                  ))}
                </ul>
                <button className="button" onClick={() => setModal({ type: 'sync' })}>查看全部映射<ArrowRight size={15} /></button>
              </div>
              <div className="skill-categories">
                {['全部技能', ...new Set(data.skills.map(s => s.category))].map(value => (
                  <button className={category === value ? 'active' : ''} onClick={() => setCategory(value)} key={value}>{value}</button>
                ))}
              </div>
              <div className="filter-toolbar">
                <span className="search-box wide"><Search size={16} /><input ref={searchInput} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索技能、用法、作者或归属…" /><kbd>/</kbd></span>
                <span className="subtle">{filteredSkills.length} 个技能</span>
              </div>
              <div className="list-labels"><span>技能</span><span>分类</span><span>读取端</span></div>
              <div className="skills-list full">{filteredSkills.map(skillRow)}</div>
              {!filteredSkills.length && <Empty query={query} />}
              <div className="source-note"><Folder size={16} /><span>统一来源 <code>~/.ai-hub/skills</code></span><button className="text-button" onClick={() => copy(data.hub_root + '/skills')}>复制路径<Copy size={13} /></button></div>
            </>}
            {page === 'rules' && <RulesPage route={params} notify={notify} onSaved={() => refresh(false)} />}
            {page === 'changes' && <><div className="change-summary"><div><h2>{data.changes.length ? `${data.changes.length} 个文件待整理` : '工作区保持整洁'}</h2><p><GitBranch size={14} />{data.projects.find(p => p.id === 'hub')?.branch || '未检测到分支'}<span>·</span>仅本地，不自动提交</p></div><button className="button primary" onClick={() => setModal({ type: 'sync' })}><Link2 size={15} />检查同步计划</button></div><div className="section-heading"><h2>当前变更<span>{data.changes.length}</span></h2><Badge>只读检查</Badge></div><div className="change-list">{data.changes.map(change => <div key={change.path}><span className={`change-letter ${change.status.includes('?') ? 'new' : ''}`}>{change.status.includes('?') ? '+' : change.status}</span><FileCode2 size={16} /><code>{change.path}</code><Badge>{change.status.includes('?') ? '未跟踪' : '已修改'}</Badge></div>)}</div>{!data.changes.length && <div className="clean-state"><CheckCheck size={24} /><p>所有来源文件已提交，没有待整理变更。</p></div>}<div className="section-heading"><h2>提交记录</h2><History size={16} className="muted" /></div><div className="history-list">{data.history.map(item => <div key={item.hash}><span className="timeline-dot"><GitCommitHorizontal size={16} /></span><div><h3>{item.message}</h3><p>{fmtDate(item.date)} · {fmtTime(item.date)}</p></div><button className="commit-hash" onClick={() => copy(item.hash)}>{item.hash}<Copy size={12} /></button></div>)}</div><div className="maintenance-actions"><button onClick={() => setModal({ type: 'migration' })}><ArrowDownToLine size={20} /><span><strong>迁移与恢复</strong><small>查看导出、校验及恢复方式</small></span><ArrowUpRight size={16} /></button><a href="https://github.com/1848991298/ai-hub#readme" target="_blank" rel="noreferrer"><BookOpen size={20} /><span><strong>项目维护档案</strong><small>前往飞书查看已确认的记录</small></span><ArrowUpRight size={16} /></a></div></>}
            {!['usage','market','ledger','settings'].includes(page) && <footer className="page-footer"><span><span className="live-dot" />本地数据 · {fmtTime(data.generated_at)} 读取</span></footer>}
          </main>
          {showInspector && <><PanelResize label="调整详情栏宽度" controls="workspace-inspector" direction={-1} value={layout.inspectorWidth} minimum={280} maximum={Math.max(280, Math.min(560, layout.viewportWidth - layout.sidebarSpan - 367))} defaultValue={340} onChange={value => layout.update('inspectorWidth', value)} /><aside id="workspace-inspector" className="inspector"><div className="inspector-heading"><span>资源详情</span><IconButton title="收起详情" onClick={() => setInspector(false)}><PanelRightClose size={16} /></IconButton></div>
            {selectedProject && <><div className="detail-intro"><span className={`resource-icon hero ${selectedProject.color}`}><Icon name={selectedProject.icon} size={29} /></span><h2>{selectedProject.name}</h2><p>{selectedProject.subtitle}</p><Badge tone={selectedProject.exists ? 'sage' : 'amber'} dot>{selectedProject.exists ? '本地工程可读取' : '路径待检查'}</Badge></div><div className="detail-section"><h3>工程信息</h3><dl><div><dt>登记仓库</dt><dd>{selectedProject.repository}</dd></div><div><dt>当前分支</dt><dd className="branch-value"><button className="project-branch-trigger" disabled={!selectedProject.is_git} onClick={() => setModal({type:'branches',id:selectedProject.id})}><GitBranch size={12}/><span>{selectedProject.branch || '无 Git 分支'}</span><ChevronDown size={12}/></button></dd></div><div><dt>Worktrees</dt><dd>{selectedProject.worktrees}</dd></div><div><dt>工作区变更</dt><dd>{selectedProject.changes == null ? '待核实' : selectedProject.changes ? `${selectedProject.changes} 项` : '整洁'}</dd></div></dl><p className="project-source-caption">{selectedProject.platform_source}</p>{selectedProject.is_git && <button className="button" onClick={() => setModal({type:'branches',id:selectedProject.id})}><GitBranch size={14}/>查看 Git 详情</button>}<button className="path-copy" onClick={() => copy(selectedProject.path)}><Folder size={14} /><code>{shortPath(selectedProject.path)}</code><Copy size={13} /></button></div><div className="detail-section"><h3>建议关联的能力<Badge>预览配置</Badge></h3><div className="related-skills">{selectedProject.skills.map(id => data.skills.find(s => s.id === id)).filter(Boolean).map(s => <button key={s.id} onClick={() => { navigate('skills'); select('skill', s.id); }}><span className={`resource-icon mini ${colors[s.category]}`}><Icon name={s.icon} size={14} /></span><span>{s.title}</span><ChevronRight size={13} /></button>)}</div></div><div className="detail-section"><h3>规则来源</h3><button className="linked-rule" onClick={() => { navigate('rules'); }}><FileText size={16} /><div><strong>共享全局规则</strong><small>~/.ai-hub/rules/global.md</small></div><ArrowUpRight size={13} /></button><p className="caption">此处展示 Hub 共享规则；工程独有规则尚未扫描。</p></div>{selectedProject.document && <a className="detail-link" href={selectedProject.document} target="_blank" rel="noreferrer"><BookOpen size={15} />打开飞书项目档案<ArrowUpRight size={14} /></a>}</>}
            {selectedSkill && <><div className="detail-intro"><span className={`resource-icon hero ${colors[selectedSkill.category]}`}><Icon name={selectedSkill.icon} size={27} /></span><Badge>{selectedSkill.category}</Badge><h2>{selectedSkill.title}</h2>
            <div className="skill-invocation"><code>{skillCommand}</code><button className="button" aria-label={'复制 ' + skillCommand} onClick={() => copy(skillCommand)}><Copy size={14} />复制</button></div>
            <p>{selectedSkill.guide || selectedSkill.description}</p></div><div className="detail-section"><h3>读取位置<span className="subtle">文件映射</span></h3><div className="mapping-list">{selectedSkill.mappings.map(m => <div key={m.client}><span>{React.createElement(readers.find(([name]) => name === m.client)?.[1] || FileText, { size: 15 })}{readerLabel(m.client)}</span><Badge tone={m.mapped ? 'sage' : 'amber'} dot>{m.mapped ? '已映射' : '待检查'}</Badge></div>)}</div></div><div className="detail-section"><h3>技能来源<SkillOwnership ownership={selectedSkill.ownership} /></h3>
            {(selectedSkill.author || selectedSkill.license) && <dl>
              {selectedSkill.author && <div><dt>作者</dt><dd>{selectedSkill.author}</dd></div>}
              {selectedSkill.license && <div><dt>许可</dt><dd>{selectedSkill.license}</dd></div>}
            </dl>}
            {selectedSkill.upstream && <a className="detail-link skill-upstream" href={selectedSkill.upstream} target="_blank" rel="noreferrer"><Link2 size={14} />查看上游固定版本<ArrowUpRight size={14} /></a>}
            <button className="path-copy" onClick={() => copy(selectedSkill.path)}><Folder size={14} /><code>{shortPath(selectedSkill.path)}</code><Copy size={13} /></button><p className="caption">Hub 本地文件 · 最后修改于 {fmtDate(selectedSkill.modified)}</p></div><div className="detail-buttons"><button className="button" onClick={() => setModal({ type: 'editor', id: selectedSkill.id, title: selectedSkill.title, source: selectedSkill.source, path: selectedSkill.path })}><BookOpen size={15} />阅读技能正文</button></div></>}
            {!selectedProject && !selectedSkill && <div className="detail-intro"><Folder size={28} /><h2>选择一项资源</h2><p>在这里查看来源、状态与关联信息。</p></div>}
            <div className="inspector-bottom"><Link2 size={13} /><span>真实本地数据 · 规则可保存并同步</span></div>
          </aside></>}
          {!inspector && hasInspector && <button className="inspector-reopen" onClick={() => setInspector(true)} title="展开资源详情"><PanelRightClose size={17} /></button>}
        </div>
      </>}
    </div>
    {toast && <div role="status" className="toast"><Check size={16} />{toast}</div>}
    {modal && <Modal key={modal.type + (modal.id || '')} onProjectAdded={async project => { await refresh(false); navigate('projects'); select('project',project.id,'projects'); setModal(null); notify('工程已添加，网页版与 App 共用本机清单'); }} modal={modal} data={data} drafts={drafts} notify={notify} copy={copy} close={() => setModal(null)} navigate={navigate} />}
    {mobileNav && <div className="nav-scrim" onClick={() => setMobileNav(false)} />}
  </div>;
}

function Modal({ onProjectAdded, modal, data, drafts, close, notify, copy, navigate }) {
  const [value, setValue] = useState(() => getDraft(modal.id) ?? modal.source ?? '');
  const [tab, setTab] = useState('preview');
  const [form, setForm] = useState({ name: '', path: '', description: '' });
  const dialogRef = useRef();
  useEffect(() => {
    const previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector('button,input,textarea')?.focus({ preventScroll: true });
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
  function saveDraft() { try { localStorage.setItem('ai-hub-draft:' + modal.id, value); notify('草稿已保存在此浏览器，来源文件未修改'); } catch { notify('浏览器无法保存草稿，请复制后保留'); } }
  const title = modal.type === 'editor' ? modal.title : ({ sync: '文件映射状态', migration: '迁移与恢复', branches:'Git 详情', 'new-project': '添加工程', 'new-skill': '新建技能草稿', drafts: '资源草稿箱' }[modal.type] || 'AI Hub');
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><section ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} className={`modal ${modal.type === 'editor' ? 'editor-modal' : ''} ${modal.type === 'branches' ? 'project-git-modal' : ''}`}><div className="modal-header"><div><h2>{title}</h2></div><IconButton title="关闭弹窗" onClick={close}><X size={19} /></IconButton></div>
      {modal.type === 'editor' && <><div className="editor-toolbar"><div className="segmented">{[['preview','阅读预览'],['edit','编辑草稿'],['diff','草稿差异']].map(([id,label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</div><Badge tone="amber">仅浏览器草稿</Badge></div><div className="editor-path"><FileText size={13} /><code>{shortPath(modal.path)}</code></div><div className="editor-content">{tab === 'preview' ? <Markdown>{value.replace(/^---\n[\s\S]*?\n---\n/, '')}</Markdown> : tab === 'edit' ? <textarea aria-label="Markdown 草稿编辑器" spellCheck={false} value={value} onChange={event => setValue(event.target.value)} /> : <div className="draft-diff"><div><h3>来源文件</h3><pre>{modal.source}</pre></div><div><h3>当前草稿<Badge>{value === modal.source ? '无差异' : '内容有变化'}</Badge></h3><pre>{value}</pre></div></div>}</div><div className="editor-footer"><span><HardDrive size={14} />草稿不会改动共享正文</span><div><button className="button" onClick={() => { setValue(modal.source); notify('编辑区已恢复来源内容，保存后更新浏览器草稿'); }}>恢复来源内容</button><button className="button primary" onClick={saveDraft}><Check size={15} />保存草稿<kbd>⌘ S</kbd></button></div></div></>}
      {modal.type === 'sync' && <div className="modal-body"><div className="modal-info"><ShieldCheck size={20} /><p>只读 · 显示各技能的文件映射结果</p></div><div className="sync-table"><div><strong>技能</strong><strong>Cursor</strong><strong>Codex</strong><strong>Codex 通用目录</strong></div>{data.skills.map(skill => <div key={skill.id}><code>{skill.id}</code>{skill.mappings.map(m => <span key={m.client} className={m.mapped ? 'green-text' : 'amber-text'}>{m.mapped ? <Check size={16} /> : <CircleHelp size={16} />}{m.mapped ? '已映射' : '待检查'}</span>)}</div>)}</div><button className="button" onClick={() => copy('bash "$HOME/.ai-hub/scripts/pull.sh" --check')}><Copy size={15} />复制命令行预检命令</button></div>}
      {modal.type === 'drafts' && <div className="modal-body"><p className="caption draft-note">以下信息仅存于此浏览器，尚未加入工程登记或技能来源。</p>{drafts.map((draft, index) => <div className="resource-draft" key={draft.created_at + index}><div><Badge tone="sage">{draft.type === 'new-project' ? '工程草稿' : '技能草稿'}</Badge><h3>{draft.name}</h3><p>{draft.path}</p>{draft.description && <p>{draft.description}</p>}<small>{fmtDate(draft.created_at)} · {fmtTime(draft.created_at)}</small></div><IconButton title="复制资源草稿" onClick={() => copy(JSON.stringify(draft, null, 2))}><Copy size={16} /></IconButton></div>)}</div>}
      {modal.type === 'migration' && <div className="modal-body"><p>现有 Hub 已有导出与恢复脚本。这版界面提供命令入口，实际操作继续由命令行执行。</p><div className="command-block"><code>python3 scripts/hub.py export --output /目标目录/ai-hub.tar.gz</code><IconButton title="复制导出命令" onClick={() => copy('python3 scripts/hub.py export --output /目标目录/ai-hub.tar.gz')}><Copy size={15} /></IconButton></div><div className="command-block"><code>python3 scripts/hub.py restore --backup .backups/实际批次</code><IconButton title="复制恢复预检命令" onClick={() => copy('python3 scripts/hub.py restore --backup .backups/实际批次')}><Copy size={15} /></IconButton></div><p className="caption">恢复命令默认只核对。移动 Hub 后使用 --relocate 重建固定入口；完整说明见 docs/portability.md。</p></div>}
      {modal.type === 'new-project' && <ProjectAdd onAdded={onProjectAdded} onExisting={id=>{navigate('projects', { resource: id });close();}}/>}
      {modal.type === 'branches' && <ProjectGit key={modal.id} projectId={modal.id}/>}
      {modal.type === 'new-skill' && <form className="modal-body resource-form" onSubmit={event => { event.preventDefault(); try { const key = `ai-hub-new-${modal.type}`; const drafts = JSON.parse(localStorage.getItem(key) || '[]'); localStorage.setItem(key, JSON.stringify([...drafts, { ...form, created_at: new Date().toISOString() }])); dispatchEvent(new Event('ai-hub-drafts-changed')); notify('新资源草稿已保存在此浏览器，尚未加入来源清单'); close(); } catch { notify('无法保存，请检查浏览器本地存储'); } }}><div className="modal-info"><PencilLine size={18} /><p>先整理资源信息；原型仅保存本地草稿。</p></div><label>{modal.type === 'new-project' ? '工程名称' : '技能名称'}<input required autoFocus value={form.name} placeholder={modal.type === 'new-project' ? '例如：我的新工程' : '例如：review-release'} onChange={event => setForm({ ...form, name: event.target.value })} /></label><label>{modal.type === 'new-project' ? '本地路径' : '用途说明'}<input required value={form.path} placeholder={modal.type === 'new-project' ? '~/Projects/my-project' : '这个技能帮助完成什么工作'} onChange={event => setForm({ ...form, path: event.target.value })} /></label><label>备注<textarea rows={3} value={form.description} placeholder="补充适用场景或需要关联的资源…" onChange={event => setForm({ ...form, description: event.target.value })} /></label><button type="submit" className="button primary"><Check size={15} />保存资源草稿</button></form>}
    </section></div>;
}

createRoot(document.getElementById('root')).render(<App />);
