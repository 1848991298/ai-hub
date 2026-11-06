import React, { useEffect, useRef, useState } from 'react';
import { Copy, GitBranch, Save, X } from 'lucide-react';

const initial = {
  project_id: '', tree_id: '', path: '', branch: '', source_ref: '', source_sha: '',
  scope: '', acceptance: '', delivery: 'pending', evidence: '',
  codex_tokens: '', codex_usage_url: '', cursor_tokens: '', cursor_usage_url: '',
};
const stages = { pending: '待实施', review: '待验收', verified: '已验收' };
const projectUrl = id => '/api/projects/' + encodeURIComponent(id);

async function read(url, options) {
  const response = await fetch(url, options);
  const value = await response.json().catch(() => null);
  if (!response.ok || !value) throw new Error(value?.error || '本机服务暂不可用，请重新打开新版 AI Hub。');
  return value;
}

function useRead(url) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!url) return;
    const request = new AbortController();
    read(url, { signal: request.signal }).then(data => {
      if (!request.signal.aborted) setResult({ url, data });
    }).catch(error => {
      if (!request.signal.aborted) setResult({ url, error: error.message });
    });
    return () => request.abort();
  }, [url]);
  return result?.url === url ? result : {};
}

export default function TaskContext({ row, projects, onClose }) {
  const dialog = useRef(null);
  const url = '/api/task-context/' + row.kind + '/' + encodeURIComponent(row.id);
  const saved = useRead(url);
  useEffect(() => {
    const node = dialog.current;
    node.showModal();
    node.querySelector('h2').focus({ preventScroll: true });
    return () => node.close();
  }, []);
  return <dialog className="ledger-dialog task-context-dialog" ref={dialog} aria-labelledby="task-context-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="ledger-dialog-head">
      <div><h2 id="task-context-title" tabIndex={-1}>执行资料</h2><p>{row.content}</p></div>
      <button className="ledger-close" aria-label="关闭执行资料" onClick={onClose}><X size={18}/></button>
    </header>
    {saved.data ? <ContextForm row={row} projects={projects} url={url} saved={saved.data}/> : <p className="task-context-loading" role={saved.error ? 'alert' : 'status'}>{saved.error || '正在读取本机执行资料…'}</p>}
  </dialog>;
}

function ContextForm({ row, projects, url, saved }) {
  const [draft, setDraft] = useState(() => ({ ...initial, ...saved.context }));
  const [revision, setRevision] = useState(saved.revision);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const project = projects.find(item => item.id === draft.project_id);
  const base = project ? projectUrl(project.id) : '';
  const details = useRead(base ? base + '/branches' : null);
  const worktree = useRead(base && draft.tree_id ? base + '/worktree/' + draft.tree_id : null);
  const tree = worktree.data;
  const sources = [
    ...(tree?.oid ? [{ ref: 'HEAD', name: '目标工作树 HEAD', oid: tree.oid }] : []),
    ...(details.data?.branches || []),
  ];
  const recommended = project?.development_base || tree?.upstream || 'HEAD';
  const selectedSource = sources.find(item => item.ref === draft.source_ref) || (!draft.source_ref && sources.find(item => item.name === recommended || item.ref === recommended));
  const sourceRef = draft.source_ref || selectedSource?.ref || '';
  const sha = draft.source_sha || selectedSource?.oid || '';
  const ready = Boolean(project && tree && sha && sourceRef);
  const value = { ...draft, path: tree?.path || draft.path, branch: tree?.branch || draft.branch, source_ref: sourceRef, source_sha: sha };
  const savedTargetChanged = draft.path && tree && (draft.path !== tree.path || draft.branch !== tree.branch);
  function change(patch) { setDraft(current => ({ ...current, ...patch })); setNotice(''); }
  async function save(event) {
    event.preventDefault();
    if (!ready || savedTargetChanged || saving) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await read(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, context: value }) });
      setDraft(result.context);
      setRevision(result.revision);
      setNotice('执行资料已保存到本机，网页版与 App 共用。');
    } catch (reason) { setError(reason.message); }
    finally { setSaving(false); }
  }
  async function copy() {
    const lines = [
      row.content, '工程 ' + project.name + ' · ' + project.repository,
      '目标工作树 ' + tree.path, '实际分支 ' + tree.branch,
      '来源 ' + (selectedSource?.name || sourceRef) + ' @ ' + sha,
      '工作区 ' + (tree.changes == null ? '尚未读到' : tree.changes ? tree.changes + ' 项未提交变更' : '干净'),
      '范围 ' + (draft.scope || '待补'), '验收 ' + (draft.acceptance || '待补'),
      '交付阶段 ' + stages[draft.delivery], draft.evidence && '证据 ' + draft.evidence,
      ...['codex', 'cursor'].map(id => draft[id + '_tokens'] && draft[id + '_usage_url'] ? id + ' 用量 ' + draft[id + '_tokens'] + ' tokens · ' + draft[id + '_usage_url'] : ''),
    ];
    try { await navigator.clipboard.writeText(lines.filter(Boolean).join('\n')); setNotice('工作包已复制。'); }
    catch { setError('当前窗口无法复制，请选择字段内容后复制。'); }
  }
  const trees = details.data?.worktrees.filter(item => item.exists && !item.prunable) || [];
  const hasSavedTree = trees.some(item => item.id === draft.tree_id);
  return <form className="task-context-form" onSubmit={save}>
    <div className="task-context-body">
      <p className="task-context-note">执行资料保存在本机 Hub。任务标题、状态和截止时间以飞书为准。</p>
      <div className="ledger-form">
      <div className="ledger-split">
        <label>工程<select required value={draft.project_id} onChange={event => change({ project_id: event.target.value, tree_id: '', path: '', branch: '', source_ref: '', source_sha: '' })}><option value="">选择已登记的 Git 工程</option>{draft.project_id && !project && <option value={draft.project_id}>原工程不可用</option>}{projects.filter(item => item.is_git || item.id === draft.project_id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>目标工作树<select required value={draft.tree_id} disabled={!details.data} onChange={event => change({ tree_id: event.target.value, path: '', branch: '', source_ref: '', source_sha: '' })}><option value="">选择实际写入的工作树</option>{draft.tree_id && !hasSavedTree && <option value={draft.tree_id}>{draft.branch || '原工作树'} · 待读取</option>}{trees.map(item => <option key={item.id} value={item.id}>{item.branch} · {item.path}</option>)}</select></label>
      </div>
      {(details.error || worktree.error) && <p className="ledger-alert" role="alert">{details.error || worktree.error}</p>}
      {savedTargetChanged && <p className="ledger-alert" role="alert">原工作树的分支已变化。请重新选择目标后核对。 <button type="button" className="button" onClick={() => change({ tree_id: '', path: '', branch: '', source_ref: '', source_sha: '' })}>重选目标</button></p>}
      {tree && <div className="task-context-tree"><GitBranch size={15}/><div><strong>{tree.branch}</strong><code>{tree.path}</code><small>上游 {tree.upstream || '未配置'} · {tree.changes == null ? '工作区待读取' : tree.changes ? tree.changes + ' 项未提交变更' : '工作区干净'}</small></div></div>}
      <label>来源基准<select aria-label="来源基准" value={sourceRef} disabled={!tree} required onChange={event => change({ source_ref: event.target.value, source_sha: '' })}><option value="">选择本机可读的基准引用</option>{sourceRef && !selectedSource && <option value={sourceRef}>{sourceRef} · 原来选定的引用</option>}{sources.map(item => <option key={item.ref} value={item.ref}>{item.name} · {item.oid.slice(0, 12)}</option>)}</select></label>
      {tree && <p className="task-context-note">建议基准 {recommended}{sha ? ' · 本次依据 ' + sha.slice(0, 12) : ' · 本机引用待核对'}{draft.source_sha && selectedSource && draft.source_sha !== selectedSource.oid && <> · 引用已前进 <button type="button" className="text-button" onClick={() => change({ source_sha: '' })}>使用当前引用</button></>}</p>}
      <label>变更范围<textarea rows={2} maxLength={2000} value={draft.scope} onChange={event => change({ scope: event.target.value })} placeholder="明确要修改的模块及边界"/></label>
      <label>验收要求或结果<textarea rows={2} maxLength={2000} value={draft.acceptance} onChange={event => change({ acceptance: event.target.value })} placeholder="记录关键路径、验证结果及待验项"/></label>
      <div className="ledger-split">
        <label>交付阶段<select value={draft.delivery} onChange={event => change({ delivery: event.target.value })}>{Object.entries(stages).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>验收证据链接<input type="url" maxLength={1000} value={draft.evidence} required={draft.delivery === 'verified'} onChange={event => change({ evidence: event.target.value })} placeholder="测试、文档或提交链接"/></label>
      </div>
      {/^(https?):\/\//i.test(draft.evidence) && <a className="text-button" href={draft.evidence} target="_blank" rel="noreferrer">查看验收证据</a>}
      <details className="task-context-usage" open={Boolean(draft.codex_tokens || draft.cursor_tokens) || undefined}><summary>按任务记录用量（可选）</summary><p className="task-context-note">手动登记本次任务的实际证据。日用量保留在用量中心。</p>{[['codex', 'Codex'], ['cursor', 'Cursor']].map(([id, name]) => <div className="ledger-split" key={id}>
        <label>{name} Tokens<input inputMode="numeric" pattern="[0-9]*" maxLength={15} value={draft[id + '_tokens']} onChange={event => change({ [id + '_tokens']: event.target.value })}/></label>
        <label>{name} 用量证据<input type="url" maxLength={1000} value={draft[id + '_usage_url']} required={Boolean(draft[id + '_tokens'])} onChange={event => change({ [id + '_usage_url']: event.target.value })}/></label>
      </div>)}</details>
      </div>
    </div>
    <footer className="task-context-footer">
      {error && <p className="ledger-alert" role="alert">{error}</p>}
      {notice && <p className="ledger-ok" role="status">{notice}</p>}
      <div className="task-context-actions">
        {!ready && <small>选定工程、工作树和来源后可保存</small>}
        <button className="button" type="button" disabled={!ready || savedTargetChanged} onClick={copy}><Copy size={15}/>复制工作包</button>
        <button className="button primary" type="submit" disabled={!ready || savedTargetChanged || saving}><Save size={15}/>{saving ? '保存中…' : '保存执行资料'}</button>
      </div>
    </footer>
  </form>;
}
