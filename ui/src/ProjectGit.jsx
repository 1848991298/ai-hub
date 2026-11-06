import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText, GitBranch, GitCommitHorizontal, HardDrive, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { Diff, Hunk, parseDiff } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import './project-git.css';

const emptyFiles = [];
const groups = [['unstaged', '未暂存'], ['staged', '已暂存'], ['untracked', '未跟踪']];
const refKinds = [['worktree', '工作树'], ['local', '本地'], ['remote', '远端跟踪']];
const statusNames = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', T: '类型变更', U: '冲突', '?': '未跟踪' };
const gitUrl = (base, action, params) => `${base}/git/${action}?${new URLSearchParams(params)}`;
const commitDate = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function useGitData(url, refresh = 0) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!url) return;
    const request = new AbortController();
    async function load() {
      try {
        const response = await fetch(url, { signal: request.signal });
        const isJson = response.headers.get('Content-Type')?.includes('application/json');
        const value = isJson ? await response.json() : null;
        if (!response.ok || !value) throw new Error(value?.error || '本机 Git 服务暂不可用，请刷新或重新打开 AI Hub。');
        if (!request.signal.aborted) setResult({ url, refresh, data: value });
      } catch (error) {
        if (!request.signal.aborted) setResult({ url, refresh, error: error.message });
      }
    }
    load();
    return () => request.abort();
  }, [url, refresh]);
  return result?.url === url && result.refresh === refresh ? result : {};
}

function GitNotice({ error, loading, children }) {
  return <p className={`git-notice ${error ? 'git-error' : ''}`} role={error ? 'alert' : 'status'}>
    {loading && <LoaderCircle size={14} className="spin"/>}
    {error || children}
  </p>;
}

function GitTabs({ label, items, selected, onSelect }) {
  return <div className="git-tabs" role="group" aria-label={label}>
    {items.map(([id, name]) => <button type="button" key={id} aria-pressed={selected === id} onClick={() => onSelect(id)}>{name}</button>)}
  </div>;
}

function RefRow({ source, selected, onSelect }) {
  const worktree = source.kind === 'worktree';
  const unavailable = worktree && (!source.exists || source.prunable);
  const Icon = worktree ? HardDrive : GitBranch;
  return <button type="button" className="git-list-row git-ref-row" aria-pressed={selected}
    disabled={unavailable} onClick={onSelect} title={source.path || source.ref}>
    <Icon size={15}/>
    <span>
      <strong>{source.branch || source.name}</strong>
      <small>{source.path || source.head}</small>
      {(source.current || source.locked || unavailable) && <small className="git-ref-mark">
        {[source.current && '当前', source.locked && '已锁定', unavailable && '目录不可用'].filter(Boolean).join(' · ')}
      </small>}
    </span>
  </button>;
}

export function ProjectGit({ projectId }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const [kind, setKind] = useState('worktree');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [diffView, setDiffView] = useState('unified');
  const { data, error } = useGitData(`${base}/branches`, refresh);
  if (!data) return <div className="git-opening">
    <GitNotice error={error} loading={!error}>正在读取工程分支和工作树…</GitNotice>
    {error && <button className="button" onClick={() => setRefresh(refresh + 1)}>重试</button>}
  </div>;

  const sources = [
    ...data.worktrees.map(tree => ({ ...tree, kind: 'worktree', key: tree.id })),
    ...data.branches.map(branch => ({ ...branch, kind: branch.remote ? 'remote' : 'local', key: branch.ref })),
  ];
  const available = sources.filter(source => source.kind !== 'worktree' || (source.exists && !source.prunable));
  const selected = available.find(source => source.key === picked) || available.find(source => source.current) || available[0];
  const search = query.trim().toLowerCase();
  const refs = sources.filter(source => source.kind === kind &&
    [source.branch, source.name, source.path].some(value => value?.toLowerCase().includes(search)));
  const tabs = refKinds.map(([key, name]) => [key, `${name} ${sources.filter(source => source.kind === key).length}`]);
  return <div className="git-browser">
    <header className="git-overview">
      <span className="git-repo-icon"><GitBranch size={19}/></span>
      <div className="git-overview-name">
        <strong>{data.project.name}</strong>
        <small title={data.project.path}>{data.project.repository === '无远端仓库' ? data.project.path : data.project.repository}</small>
      </div>
      <span className="git-local-label">本机只读</span>
      <button type="button" className="button git-reload" onClick={() => setRefresh(refresh + 1)}><RefreshCw size={14}/>刷新</button>
    </header>
    <div className="git-columns">
      <aside className="git-sidebar">
        <GitTabs label="引用类型" items={tabs} selected={kind} onSelect={id => { setKind(id); setQuery(''); }}/>
        <label className="git-search"><Search size={15}/><input aria-label="搜索分支或工作树" placeholder="搜索分支或路径" value={query} onChange={event => setQuery(event.target.value)}/></label>
        <div className="git-ref-list">
          {refs.map(source => <RefRow key={source.key} source={source} selected={selected?.key === source.key} onSelect={() => setPicked(source.key)}/>)}
          {!refs.length && <GitNotice>{query ? '没有匹配的分支或工作树。' : '此处暂无记录。'}</GitNotice>}
        </div>
        <p className="git-sidebar-note">{data.truncated ? '最多显示 500 条分支引用。' : '远端跟踪使用本机上次获取的引用。'}</p>
      </aside>
      {selected ? <GitSelection key={`${selected.key}:${selected.oid}`} source={selected} base={base}
        defaultToChanges={selected.kind === 'worktree' && (!selected.current || data.project.changes > 0 || !selected.oid)}
        diffView={diffView} onDiffView={setDiffView}/>
        : <GitNotice>没有可用的分支或工作树。</GitNotice>}
    </div>
  </div>;
}

function GitSelection({ source, base, defaultToChanges, diffView, onDiffView }) {
  const worktree = source.kind === 'worktree';
  const [mode, setMode] = useState(defaultToChanges ? 'changes' : 'history');
  return <div className="git-selection">
    <header className="git-selection-bar">
      <div className="git-selection-name">
        <strong title={source.path || source.ref}>{source.branch || source.name}</strong>
        {source.head && <code>{source.head}</code>}
      </div>
      {worktree && <GitTabs label="工作树视图" items={ [['changes', '工作区'], ['history', '提交历史']] } selected={mode} onSelect={setMode}/>}
      {!worktree && <span className="git-context-label">{source.remote ? '远端跟踪引用' : '本地分支'} · 提交历史</span>}
    </header>
    {mode === 'changes' ? <WorktreeChanges base={base} worktree={source.id} diffView={diffView} onDiffView={onDiffView}/>
      : <CommitHistory base={base} head={source.oid} diffView={diffView} onDiffView={onDiffView}/>}
  </div>;
}

function CommitHistory({ base, head, diffView, onDiffView }) {
  const [offset, setOffset] = useState(0);
  const [picked, setPicked] = useState(null);
  const { data, error } = useGitData(head ? gitUrl(base, 'history', { head, offset }) : null);
  const commits = data?.commits || [];
  const commit = commits.find(item => item.oid === picked) || commits[0];
  const detail = useGitData(commit ? gitUrl(base, 'files', { commit: commit.oid }) : null);
  const files = detail.data?.files || emptyFiles;
  return <GitReview key="history" base={base} diffView={diffView} onDiffView={onDiffView}
    files={files} context={commit ? { commit: commit.oid } : null}
    fileHeading={commit ? `变更文件 ${detail.data ? files.length : ''}` : '变更文件'}
    filesStatus={detail.error || (commit && !detail.data ? '正在读取变更文件…' : '')}
    message={detail.data?.message} commitTitle={commit?.title}>
    <div className="git-pane-label"><GitCommitHorizontal size={16}/>提交历史</div>
    <div className="git-commit-list">
      {commits.map(item => <button className="git-list-row git-commit-row" type="button" key={item.oid} aria-pressed={item.oid === commit?.oid} onClick={() => setPicked(item.oid)}>
        <strong title={item.title}>{item.title || '无提交说明'}</strong>
        <small><code>{item.head}</code><span>{item.author}</span>{item.date && <time dateTime={item.date} title={item.date}>{commitDate.format(new Date(item.date))}</time>}</small>
      </button>)}
      {!commits.length && <GitNotice error={error} loading={Boolean(head && !data && !error)}>{head && !data ? '正在读取提交…' : '暂无提交。'}</GitNotice>}
    </div>
    {(offset > 0 || data?.next_offset != null) && <div className="git-pages">
      <button type="button" className="text-button" disabled={data?.previous_offset == null} onClick={() => setOffset(data.previous_offset)}><ChevronLeft size={14}/>上一页</button>
      <button type="button" className="text-button" disabled={data?.next_offset == null} onClick={() => setOffset(data.next_offset)}>下一页<ChevronRight size={14}/></button>
    </div>}
  </GitReview>;
}

function WorktreeChanges({ base, worktree, diffView, onDiffView }) {
  const [picked, setPicked] = useState(null);
  const { data, error } = useGitData(gitUrl(base, 'changes', { worktree }));
  const group = picked || groups.find(([id]) => data?.[id]?.length)?.[0] || 'unstaged';
  const files = data?.[group] || emptyFiles;
  return <GitReview base={base} diffView={diffView} onDiffView={onDiffView}
    files={files} context={{ worktree, group }} fileHeading={`工作区文件 ${data ? files.length : ''}`}
    filesStatus={error || (!data ? '正在读取工作区…' : '')}>
    <div className="git-change-tabs">
      <GitTabs label="工作区变更类型" selected={group} onSelect={setPicked}
        items={groups.map(([id, label]) => [id, `${label} ${data?.[id]?.length ?? '–'}`])}/>
    </div>
  </GitReview>;
}

function GitReview({ base, children, files, context, fileHeading, filesStatus, message, commitTitle, diffView, onDiffView }) {
  const [picked, setPicked] = useState(null);
  const [wrap, setWrap] = useState(true);
  const file = files.find(item => item.id === picked) || files[0];
  const url = file && context ? gitUrl(base, 'diff', { ...context, file: file.id }) : null;
  return <div className="git-review">
    <section className="git-review-list">
      {children}
      <div className="git-pane-label"><FileText size={15}/>{fileHeading}</div>
      <div className="git-file-list">
        {files.map(item => <button key={item.id} type="button" className="git-list-row git-file-row" aria-pressed={item.id === file?.id}
          onClick={() => setPicked(item.id)} title={item.previous_path ? `${item.previous_path} → ${item.path}` : item.path}>
          <span className="git-file-status" data-status={item.status[0]} title={statusNames[item.status[0]]}>{item.status[0]}</span>
          <span className="git-file-name">
            <code>{item.path.split('/').at(-1)}</code>
            {item.path.includes('/') && <small>{item.path.slice(0, item.path.lastIndexOf('/'))}</small>}
          </span>
        </button>)}
        {!files.length && <GitNotice>{filesStatus || '此处暂无文件变化。'}</GitNotice>}
      </div>
    </section>
    <section className="git-diff-pane">
      <div className="git-diff-header">
        <div>
          <strong title={file?.path}>{file?.path || '逐行差异'}</strong>
          {file && <small>{file.previous_path ? `原路径 ${file.previous_path}` : statusNames[file.status[0]]}</small>}
        </div>
        <GitTabs label="差异排版" items={ [['unified', '单栏'], ['split', '左右对照']] } selected={diffView} onSelect={onDiffView}/>
        <button type="button" className="git-wrap" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>折行</button>
      </div>
      {message && message.trim() !== commitTitle && <details className="git-message" key={message}><summary>完整提交说明</summary><pre>{message}</pre></details>}
      <FileDiff key={url} url={url} viewType={diffView} wrap={wrap}/>
    </section>
  </div>;
}

function FileDiff({ url, viewType, wrap }) {
  const { data, error } = useGitData(url);
  const parsed = useMemo(() => {
    if (!data?.patch) return [];
    try { return parseDiff(data.patch); }
    catch { return []; }
  }, [data?.patch]);

  let content;
  if (!url) content = <GitNotice>选择文件查看行级变化。</GitNotice>;
  else if (!data) content = <GitNotice error={error} loading={!error}>正在读取文件差异…</GitNotice>;
  else if (data.limited) content = <GitNotice>该文件差异超过预览上限（384 KiB 或 5000 行）。</GitNotice>;
  else if (parsed.some(file => file.hunks.length)) content = parsed.map((file, index) => <Diff
    key={index} viewType={viewType} diffType={file.type} hunks={file.hunks}>
    {hunks => hunks.map(hunk => <Hunk key={hunk.content} hunk={hunk}/>)}
  </Diff>);
  else if (data.patch) content = <pre className="git-patch-meta">{data.patch}</pre>;
  else content = <GitNotice>此项没有可预览的文本差异。</GitNotice>;
  return <div className={`git-diff-scroll ${wrap ? '' : 'git-nowrap'}`} tabIndex={0} aria-label="文件差异内容">{content}</div>;
}
