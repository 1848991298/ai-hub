import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronRight, FolderOpen, GitBranch, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import './projects.css';

async function request(path, body) {
  const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('本地工程服务版本不兼容，请更新并重新打开 App。');
  const value=await response.json();
  if(!response.ok) throw new Error(value.error || '本地工程服务暂不可用，请更新并重新打开 App。');
  return value;
}

export function ProjectAdd({ onAdded, onExisting }) {
  const [capabilities,setCapabilities]=useState(null), [selection,setSelection]=useState(null), [name,setName]=useState(''), [description,setDescription]=useState('');
  const [busy,setBusy]=useState(''), [error,setError]=useState(''), [cancelled,setCancelled]=useState(false);
  useEffect(()=>{let active=true;request('/api/projects/capabilities').then(value=>{if(active)setCapabilities(value);}).catch(()=>{if(active)setError('本机工程服务暂不可用，请更新并重新打开 App。');});return()=>{active=false;};},[]);
  async function pick() {
    setBusy('pick');setError('');setCancelled(false);
    try {
      const value=await request('/api/projects/pick',{});
      if(value.status==='cancelled')setCancelled(true);
      else {setSelection(value);setName(value.candidate.name);}
    } catch(failure){setError(failure.message);} finally{setBusy('');}
  }
  async function add(event) {
    event.preventDefault();if(!selection)return;
    setBusy('add');setError('');
    try {const value=await request('/api/projects/add',{selection_token:selection.selection_token,name,description});await onAdded(value);}
    catch(failure){setError(failure.message);} finally{setBusy('');}
  }
  const candidate=selection?.candidate;
  return <form className="modal-body project-add-form" onSubmit={add}>
    <button type="button" className="project-folder-picker" disabled={!!busy || !capabilities?.directory_picker} onClick={pick}>
      {busy==='pick'?<LoaderCircle size={26} className="spin"/>:<FolderOpen size={28}/>}
      <strong>{busy==='pick'?'请在系统窗口中选择文件夹…':candidate?'重新选择文件夹':'选择本地工程文件夹'}</strong>
      <span>自动识别工程根目录、Git 来源和当前分支</span>
    </button>
    {capabilities && !capabilities.directory_picker && <p className="project-message">本机目录选择器暂不可用，请更新并重新打开 macOS App。</p>}
    {cancelled && <p className="caption" role="status">已取消选择，工程列表未改变。</p>}
    {error && <p className="project-message" role="alert">{error}</p>}
    {candidate && <>
      <div className="project-identification"><div className="project-recognized"><Check size={15}/>{candidate.is_git?'已识别 Git 工作区':'已识别本地目录'}<span>{candidate.platform}</span></div>
        <code>{candidate.path}</code>
        <dl><div><dt>当前分支</dt><dd>{candidate.branch || '无 Git 分支'}</dd></div><div><dt>仓库</dt><dd>{candidate.repository}</dd></div><div><dt>来源依据</dt><dd>{candidate.platform_source}</dd></div></dl>
        <div className="project-tags">{candidate.tags.map(tag=><span key={tag}>{tag}</span>)}</div>
      </div>
      {candidate.existing_id?<div className="project-existing"><p>这个目录已经在工程合集中。</p><button type="button" className="button primary" onClick={()=>onExisting(candidate.existing_id)}>查看已有工程<ArrowUpRight size={14}/></button></div>:<>
        <label>工程名称<input aria-label="工程名称" required maxLength={80} value={name} onChange={event=>setName(event.target.value)}/></label>
        <label>备注<textarea aria-label="工程备注" rows={2} maxLength={240} value={description} placeholder="这个工程主要做什么…" onChange={event=>setDescription(event.target.value)}/></label>
        <div className="project-add-footer"><span>添加后，网页版和 App 共用此工程登记。</span><button className="button primary" disabled={!!busy || !name.trim()} type="submit">{busy==='add'?<LoaderCircle size={15} className="spin"/>:<Check size={15}/>}确认添加</button></div>
      </>}
    </>}
    {!candidate && <p className="caption">支持 Git 仓库、工作树和普通工程目录。所选目录保持原位置。</p>}
  </form>;
}

const landingRoles = [['main', '主线'], ['dev', '开发分支'], ['release', '发布分支']];
const targetStates = {
  unselected: '待指定', unavailable: '未查到目标', uncommitted: '尚无任务提交', candidate_pending: '待核对提交',
  merged: '已合入', not_contained: '未包含提交', on_source: '分支本身', unverified: '待核验',
};
const checkSource = {remote: '已核对实际远端', local: '本机跟踪引用', remote_unavailable: '远端核对失败 · 本机跟踪引用'};
const cleanupLabels = {
  review: '待确认处理工作树', kept: '已选择保留', waiting: '等待合入',
  blocked: '已合入 · 工作树有待保留项', integration: '集成工作树', none: '无独立工作树',
};
const checkedFormat = new Intl.DateTimeFormat('zh-CN', {dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai'});
const branchScopes = [['all', '全部'], ['task', '任务分支'], ['integration', '集成分支']];
const isIntegration = row => row.cleanup === 'integration' || Object.values(row.targets || {}).some(target => target?.state === 'on_source');

function CommitRef({ sha, empty = '—' }) {
  return sha ? <code title={sha}>{sha.slice(0, 9)}</code> : <span>{empty}</span>;
}

function BranchStatus({ target }) {
  const state = target?.state || 'unverified';
  return <span className={`branch-status is-${state}`}>
    {state === 'merged' ? <Check size={13} aria-hidden="true"/> : <i aria-hidden="true"/>}
    {targetStates[state] || targetStates.unverified}
  </span>;
}

function worktreeStatus(tree) {
  if (!tree.active) return tree.available ? '已解除工作树关联' : '工作树目录已移除';
  if (!tree.available) return '工作树暂不可读';
  if (tree.dirty === null) return '改动待核实';
  return tree.dirty ? '有未提交改动' : '无未提交改动';
}

function BranchDetails({ row, onClose }) {
  const dialog = useRef(null);
  const titleId = useId();
  const targets = [
    ...landingRoles.map(([role, label]) => [role, label, row.targets?.[role]]),
    ...Object.entries(row.comparisons || {}).map(([name, target]) => [`ref:${name}`, '对照分支', target]),
  ];
  const directories = [...(row.primary_directory ? [{...row.primary_directory, primary:true}] : []), ...(row.directories || [])];
  const checked = new Date(row.checked_at);
  const checkedAt = Number.isNaN(checked.getTime()) ? '' : checkedFormat.format(checked);

  useLayoutEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);

  return <dialog ref={dialog} className="branch-details" aria-labelledby={titleId} onCancel={event => {
    event.preventDefault();
    onClose();
  }}>
    <header className="branch-details-heading">
      <div>
        <p>{[row.project, row.remote?.platform].filter(Boolean).join(' · ')}</p>
        <h2 id={titleId}><code>{row.branch}</code></h2>
      </div>
      <button type="button" className="icon-button" aria-label="关闭分支详情" onClick={onClose}><X size={18} aria-hidden="true"/></button>
    </header>
    <div className="branch-details-body">
      <section>
        <h3>分支用途</h3>
        <p className="branch-details-purpose">{row.purpose}</p>
      </section>
      <section>
        <h3>合入目标</h3>
        <dl className="branch-details-targets">
          {targets.map(([role, label, target]) => <div key={role}>
            <dt>{label}{row.landing?.includes(role) && <small>计划合入</small>}</dt>
            <dd><BranchStatus target={target}/></dd>
            {target?.name && <dd className="branch-target-evidence">
              <code>{[row.remote?.name, target.name].filter(Boolean).join('/')}</code>
              {target.head && <CommitRef sha={target.head}/>}
              {target.evidence && <a href={target.evidence.url} target="_blank" rel="noreferrer">合并凭据 <ArrowUpRight size={14} aria-hidden="true"/></a>}
            </dd>}
          </div>)}
        </dl>
      </section>
      <section>
        <h3>提交与来源</h3>
        <dl className="branch-details-meta">
          {row.remote?.repository && <div><dt>仓库</dt><dd>{row.remote.repository}</dd></div>}
          <div><dt>创建基准</dt><dd>{row.base?.ref && row.base.ref !== row.base.oid && <code>{row.base.ref}</code>}<CommitRef sha={row.base?.oid}/></dd></div>
          <div><dt>本地分支头</dt><dd><CommitRef sha={row.head} empty="未查到本地分支"/></dd></div>
          <div><dt>核验候选</dt><dd><CommitRef sha={row.candidate} empty="待确认"/></dd></div>
          <div><dt>同名远端分支</dt><dd><CommitRef sha={row.publication} empty="未查到同名远端分支"/></dd></div>
        </dl>
      </section>
      <section>
        <h3>工作树</h3>
        {cleanupLabels[row.cleanup] && <p className="branch-details-note">{cleanupLabels[row.cleanup]}</p>}
        {directories.map(tree => <div className="branch-details-path" key={tree.path}>
          <code>{tree.path}</code>
          <small>{[tree.primary && '主检出目录', worktreeStatus(tree), tree.active && tree.locked && '已锁定'].filter(Boolean).join(' · ')}</small>
        </div>)}
      </section>
    </div>
    <footer className="branch-details-footer">
      <span>{[checkedAt, checkSource[row.verification]].filter(Boolean).join(' · ') || '待核验'}</span>
      {row.archive && <a href={row.archive} target="_blank" rel="noreferrer">飞书档案 <ArrowUpRight size={14} aria-hidden="true"/></a>}
    </footer>
  </dialog>;
}

export function BranchLedgerPage({ searchInput }) {
  const [records, setRecords] = useState(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('all');
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    let active = true;
    setError('');
    request('/api/projects/branch-ledger').then(value => {
      if (active) setRecords(value.records);
    }).catch(failure => {
      if (active) setError(failure.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [reload]);

  const rows = records || [];
  const integrationCount = rows.filter(isIntegration).length;
  const counts = { all: rows.length, task: rows.length - integrationCount, integration: integrationCount };
  const search = query.trim().toLowerCase();
  const visible = rows.filter(row => {
    if (scope !== 'all' && isIntegration(row) !== (scope === 'integration')) return false;
    return !search || [row.branch, row.purpose, row.project, row.remote?.platform, row.remote?.repository]
      .some(value => value?.toLowerCase().includes(search));
  });
  const selected = rows.find(row => row.id === selectedId);

  return <section className="branch-ledger-page" aria-labelledby="branch-ledger-title">
    <header className="branch-ledger-heading">
      <div>
        <h1 id="branch-ledger-title">分支清单</h1>
        <p>查看任务分支的合入进度和工作树状态</p>
      </div>
      <button type="button" className="button branch-reload" disabled={loading} onClick={() => {
        setLoading(true);
        setReload(value => value + 1);
      }}><RefreshCw size={16} aria-hidden="true"/>{loading ? '正在读取' : '重新读取'}</button>
    </header>
    {error && <p className="project-message" role="alert">{error}</p>}
    <div className="branch-ledger-sheet" aria-busy={loading}>
      <div className="branch-ledger-toolbar">
        <div className="branch-ledger-scopes" role="group" aria-label="分支类型">
          {branchScopes.map(([id, label]) => <button type="button" key={id}
            aria-pressed={scope === id} onClick={() => setScope(id)}>
            {label}{records && <span>{counts[id]}</span>}
          </button>)}
        </div>
        <label className="branch-ledger-search">
          <Search size={16} aria-hidden="true"/>
          <input type="search" ref={searchInput} aria-label="搜索分支、仓库或用途"
            placeholder="搜索分支、仓库或用途" value={query} onChange={event => setQuery(event.target.value)}/>
        </label>
      </div>
      <div className="branch-ledger-grid branch-ledger-columns" aria-hidden="true">
        <span>分支与用途</span>
        {landingRoles.map(([role, label]) => <span key={role}>{label}</span>)}
      </div>
      {visible.length > 0 && <ul className="branch-ledger-list" aria-label="已登记分支">
        {visible.map(row => <li key={row.id}>
          <button type="button" className="branch-ledger-grid branch-ledger-row" aria-haspopup="dialog" onClick={() => setSelectedId(row.id)}>
            <span className="branch-row-identity">
              <span className="branch-row-icon"><GitBranch size={18} aria-hidden="true"/></span>
              <span className="branch-row-text">
                <code title={row.branch}>{row.branch}</code>
                <span className="branch-row-meta">
                  <span className="branch-row-repo">{[row.project, row.remote?.platform].filter(Boolean).join(' · ')}</span>
                  <span className="branch-row-purpose" title={row.purpose}>{row.purpose}</span>
                </span>
              </span>
            </span>
            {landingRoles.map(([role, label]) => {
              const target = row.targets?.[role];
              return <span className="branch-row-target" key={role}>
                <span className="branch-row-role">{label}</span>
                <BranchStatus target={target}/>
                {target?.name && <code title={target.name}>{target.name}</code>}
              </span>;
            })}
            <ChevronRight className="branch-row-chevron" size={16} aria-hidden="true"/>
          </button>
        </li>)}
      </ul>}
      {!visible.length && !error && <p className="branch-ledger-empty" role="status">
        {loading ? '正在读取分支清单…' : rows.length ? '没有匹配的分支' : '暂无登记的分支'}
      </p>}
    </div>
    {selected && <BranchDetails key={selected.id} row={selected} onClose={() => setSelectedId(null)}/>}
  </section>;
}
