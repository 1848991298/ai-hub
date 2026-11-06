import React, { useEffect, useState } from 'react';
import { FolderOpen, Check, ArrowUpRight, LoaderCircle } from 'lucide-react';
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
