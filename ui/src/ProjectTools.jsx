import React, { useEffect, useState } from 'react';
import { FolderOpen, FolderGit2, GitBranch, Check, RefreshCw, ArrowUpRight, LoaderCircle, HardDrive } from 'lucide-react';
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

export function ProjectBranches({ projectId, notify }) {
  const [data,setData]=useState(null), [error,setError]=useState(''), [tab,setTab]=useState('worktrees'), [query,setQuery]=useState(''), [opening,setOpening]=useState(false);
  async function load(){try{setData(await request(`/api/projects/${encodeURIComponent(projectId)}/branches`));setError('');}catch(failure){setError(failure.message);}}
  useEffect(()=>{load();},[projectId]);
  async function open(worktreeId) {
    setOpening(true);setError('');
    try{await request('/api/projects/open-sourcetree',{project_id:projectId,...(worktreeId?{worktree_id:worktreeId}:{})});notify('已请求 SourceTree 打开对应工作区');}
    catch(failure){setError(failure.message);}finally{setOpening(false);}
  }
  if(!data)return <div className="modal-body"><p role="status">{error || '正在读取分支与工作树…'}</p><button className="button" onClick={load}><RefreshCw size={14}/>重新读取</button></div>;
  const project=data.project, match=value=>value.toLowerCase().includes(query.trim().toLowerCase());
  const trees=data.worktrees.filter(tree=>match(tree.branch+' '+tree.path));
  const branches=data.branches.filter(branch=>branch.remote===(tab==='remote') && match(branch.name));
  return <div className="modal-body project-branches">
    <div className="project-repository-header"><span className="resource-icon blue"><FolderGit2 size={23}/></span><div><h3>{project.name}</h3><code>{project.path}</code></div><button className="button" disabled={opening || !data.capabilities.sourcetree} onClick={()=>open()}>在 SourceTree 打开<ArrowUpRight size={14}/></button></div>
    <div className="project-repository-meta"><span><GitBranch size={14}/>{project.branch || '分支待核实'}</span><span>{project.changes===null?'工作区状态待核实':project.changes?`${project.changes} 项未提交改动`:'当前工作区整洁'}</span><span>{project.platform}</span></div>
    <p className="caption project-source-explanation">{project.platform_source}{project.registered_platform && project.registered_platform!==project.platform?` · 原登记：${project.registered_platform}`:''}</p>
    {!!project.remotes.length && <details className="project-remotes"><summary>远端来源 · {project.remotes.length} 项</summary>{project.remotes.map((remote,index)=><div key={remote.name+index}><strong>{remote.name}</strong><span>{remote.platform}</span><code>{remote.host || '地址类型待识别'}{remote.repository?` / ${remote.repository}`:''}</code></div>)}</details>}
    {error && <p className="project-message" role="alert">{error}</p>}
    {!data.capabilities.sourcetree && <p className="project-message">未检测到 SourceTree；安装后可从这里打开仓库。</p>}
    <div className="project-branch-toolbar"><div className="segmented" role="group" aria-label="分支视图">{[['worktrees',`工作树 ${data.worktrees.length}`],['local','本地分支'],['remote','远端跟踪']].map(([id,label])=><button key={id} aria-pressed={tab===id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{label}</button>)}</div><input aria-label="搜索分支或工作树" placeholder="搜索分支或路径…" value={query} onChange={event=>setQuery(event.target.value)}/></div>
    <div className="project-branch-list">
      {tab==='worktrees'?trees.map(tree=><div className="project-tree-row" key={tree.id}><HardDrive size={17}/><div><strong>{tree.branch}{tree.current && <span className="badge sage">当前目录</span>}{tree.locked && <span className="badge">已锁定</span>}</strong><code>{tree.path}</code>{(!tree.exists || tree.prunable) && <small>目录不可用</small>}</div><button className="button" disabled={opening || !data.capabilities.sourcetree || !tree.exists || tree.prunable} onClick={()=>open(tree.id)}>SourceTree<ArrowUpRight size={13}/></button></div>):branches.map(branch=><div className="project-tree-row" key={branch.ref}><GitBranch size={16}/><div><strong>{branch.name}{branch.current && <Check size={14}/>}</strong><small>{branch.head}{branch.worktree_ids.length?` · ${branch.worktree_ids.length} 个工作树使用中`:''}</small></div><button className="text-button" disabled={opening || !data.capabilities.sourcetree} onClick={()=>open(branch.worktree_ids[0])}>查看仓库<ArrowUpRight size={13}/></button></div>)}
      {!(tab==='worktrees'?trees.length:branches.length) && <p className="project-list-empty">{query?'没有匹配结果。':'暂无对应记录。'}</p>}
    </div>
    <div className="project-branches-footer"><span>在 SourceTree 中切换分支。远端跟踪来自本机记录，可能尚未更新。</span><button className="text-button" onClick={load}><RefreshCw size={13}/>重新读取</button></div>
    {data.truncated && <p className="caption">当前展示前 500 个分支，完整列表可在 SourceTree 查看。</p>}
  </div>;
}
