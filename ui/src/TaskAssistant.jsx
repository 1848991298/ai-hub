import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronRight, FileText, Sparkles } from 'lucide-react';
import { priorities, statuses } from './ledger-model.js';
import './task-assistant.css';

const labels = { status: '状态', priority: '优先级' };
const allowed = { status: statuses, priority: priorities };
const sourceOf = row => ({ status: row.status, priority: row.priority || null, content: row.content });

export default function TaskAssistant({ row, available, busy, onQueue, onReadback }) {
  const [evidence, setEvidence] = useState('');
  const [draft, setDraft] = useState(null);
  const [checked, setChecked] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState('');
  const dialog = useRef(null);
  const request = useRef(null);
  const attempt = useRef(null);
  const title = row.content?.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 500) || '无标题';
  const current = sourceOf(row);
  const stale = draft && Object.keys(current).some(key => draft.base[key] !== current[key]);
  const editable = row.id.startsWith('rec') && !row.archived && !row.sync_state;
  const submitted = receipt?.state === 'done';
  const ongoing = receipt?.state === 'pending' || receipt?.state === 'writing';
  const changes = Object.keys(draft?.changes || {});
  const stage = receipt ? 2 : draft && !stale ? 1 : 0;
  const receiptId = receipt?.id;
  const refresh = useRef(onReadback);
  refresh.current = onReadback;

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!receiptId) return;
    const controller = new AbortController();
    let timer;
    let failures = 0;
    async function read() {
      try {
        const response = await fetch('/api/tracker/receipt?' + new URLSearchParams({ id: receiptId }), { signal: controller.signal });
        const value = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) {
          if (response.status === 404) {
            setReceipt({ id: receiptId, state: 'unavailable', error: value.error });
            return;
          }
          throw new Error();
        }
        failures = 0;
        setReceipt({ id: receiptId, ...value });
        if (value.state === 'pending' || value.state === 'writing') timer = setTimeout(read, 1200);
        else refresh.current();
      } catch {
        if (controller.signal.aborted) return;
        failures++;
        if (failures < 4) timer = setTimeout(read, 1500);
        else setReceipt({ id: receiptId, state: 'unavailable', error: '暂未读到同步回执，请查看台账同步状态。' });
      }
    }
    read();
    return () => { clearTimeout(timer); controller.abort(); };
  }, [receiptId]);

  async function generate(event) {
    event.preventDefault();
    if (!editable || !available || !evidence.trim() || request.current || ongoing) return;
    const controller = new AbortController();
    request.current = controller;
    setGenerating(true);
    setDraft(null);
    setReceipt(null);
    setError('');
    attempt.current = null;
    try {
      const response = await fetch('/api/task-suggestions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ title, status: current.status, priority: current.priority, evidence: evidence.trim() }),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok || !value?.changes) throw new Error(value?.error || '暂时无法生成建议，请检查本机服务后重试。');
      if (controller.signal.aborted) return;
      const suggestions = Object.fromEntries(Object.entries(value.changes).filter(([field, change]) =>
        allowed[field]?.includes(change?.value) && change.value !== current[field] && typeof change.reason === 'string'));
      setDraft({ base: current, changes: suggestions, evidence: evidence.trim() });
      setChecked(Object.keys(suggestions));
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason.message);
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setGenerating(false);
    }
  }

  function review() {
    if (stale || !editable || !checked.length || busy || queueing) return;
    setError('');
    dialog.current.showModal();
  }

  async function apply() {
    if (stale || !editable || !checked.length || busy || queueing) return;
    const patch = Object.fromEntries(checked.map(key => [key, draft.changes[key].value]));
    const signature = JSON.stringify(patch);
    if (attempt.current?.signature !== signature) attempt.current = { signature, id: crypto.randomUUID() };
    setQueueing(true);
    setError('');
    try {
      const id = await onQueue(row, patch, attempt.current.id);
      dialog.current?.close();
      setReceipt({ id, state: 'pending' });
    } catch (reason) {
      setError(reason.message);
    } finally {
      setQueueing(false);
    }
  }

  return <>
    <div className="task-assistant-body">
      <ol className="task-assistant-steps" aria-label="建议进度">
        {['拟定', '复核', '应用并读回'].map((label, index) =>
          <li key={label} aria-current={index === stage ? 'step' : undefined} className={index < stage || submitted ? 'is-done' : ''}>
            {index > 0 && <ChevronRight size={13} aria-hidden="true"/>}
            <span>{(index < stage || submitted) && <Check size={13} aria-hidden="true"/>}{label}</span>
          </li>)}
      </ol>
      {receipt ? <div className={`task-assistant-receipt ${submitted ? 'is-done' : ''}`} role={receipt.error ? 'alert' : 'status'}>
        <strong>{submitted ? '飞书读回完成' : ongoing ? '已交给后台同步' : receipt.state === 'discarded' ? '已取消同步' : '同步待核对'}</strong>
        <p>{submitted ? '已核对并确认所选字段。' : ongoing ? '飞书读回一致后会显示完成。' : receipt.error || '请返回台账核对这条记录。'}</p>
      </div> : draft && !stale ? <>
        <div className="task-assistant-heading"><h3>{changes.length ? '建议修改字段' : '暂无建议修改'}</h3>{changes.length > 0 && <span className="badge amber">待确认</span>}</div>
        {changes.length ? <div className="task-assistant-changes">{changes.map(key =>
          <label key={key} className="task-assistant-change">
            <input type="checkbox" checked={checked.includes(key)} aria-label={`采纳${labels[key]}变更`} onChange={() => setChecked(list => list.includes(key) ? list.filter(field => field !== key) : [...list, key])}/>
            <div><strong>{labels[key]}</strong><ChangeValue from={draft.base[key]} to={draft.changes[key].value}/><p>{draft.changes[key].reason}</p></div>
          </label>
        )}</div> : <p className="task-assistant-note">根据你提供的依据，当前字段可保留。</p>}
        <div className="task-assistant-evidence"><h3>生成依据</h3><p>{draft.evidence}</p></div>
      </> : <form id="task-assistant-form" className="task-assistant-form" onSubmit={generate}>
        {stale && <p className="task-assistant-note" role="status">记录已更新，请用最新内容重新生成。</p>}
        {!available && <p className="task-assistant-note" role="status">未检测到本机 Codex 或建议服务，请检查安装并重启 AI Hub。</p>}
        {row.archived && <p className="task-assistant-note">恢复记录后可以生成建议。</p>}
        {row.sync_state && <p className="task-assistant-note">这条记录有待处理的同步，完成后可以生成建议。</p>}
        <label htmlFor="task-assistant-evidence">实际进展或验收依据</label>
        <textarea id="task-assistant-evidence" rows={4} maxLength={1500} required value={evidence} disabled={generating}
          placeholder="例如，开发已完成，接下来进行桌面回归。" onChange={event => setEvidence(event.target.value)}/>
        {row.note?.trim() && <button type="button" className="text-button" disabled={generating} onClick={() => setEvidence(row.note.trim().slice(0, 1500))}><FileText size={14}/>使用当前备注</button>}
        <p className="task-assistant-note">标题、状态、优先级和填写的依据会发送给当前登录的 Codex。</p>
      </form>}
      {error && !dialog.current?.open && <p className="ledger-alert" role="alert">{error}</p>}
    </div>
    <footer className="task-assistant-foot">
      {receipt && !ongoing ? <button type="button" className="button" disabled={!editable} onClick={() => { setReceipt(null); setDraft(null); setError(''); }}>重新拟定</button>
        : !receipt && draft && !stale ? <>
          {changes.length > 0 && <button type="button" className="button primary" disabled={!editable || !checked.length || busy} onClick={review}>复核 {checked.length} 项<ArrowRight size={16}/></button>}
          <button type="button" className="text-button" onClick={() => { setDraft(null); setError(''); }}>修改依据</button>
        </>
        : !receipt && <button type="submit" form="task-assistant-form" className="button primary" disabled={!available || !editable || generating || !evidence.trim()}>
          <Sparkles size={16}/>{generating ? 'Codex 正在拟定…' : '生成建议'}
        </button>}
    </footer>
    <dialog ref={dialog} className="task-assistant-dialog" aria-labelledby="task-assistant-review" onCancel={event => { event.stopPropagation(); if (queueing) event.preventDefault(); else setError(''); }}>
      <form onSubmit={event => { event.preventDefault(); apply(); }}>
        <header><h2 id="task-assistant-review">复核 AI 建议</h2><p>{title}</p></header>
        <div className="task-assistant-review-fields">
          {checked.filter(key => draft?.changes[key]).map(key => <div key={key}><strong>{labels[key]}</strong><ChangeValue from={draft.base[key]} to={draft.changes[key].value}/></div>)}
          {stale && <p className="ledger-alert" role="alert">记录已更新，请返回重新生成建议。</p>}
          {error && <p className="ledger-alert" role="alert">{error}</p>}
          <p>确认后，所选字段会同步到飞书。</p>
        </div>
        <footer>
          <button type="button" className="button" autoFocus disabled={queueing} onClick={() => { dialog.current.close(); setError(''); }}>返回</button>
          <button type="submit" className="button primary" disabled={queueing || stale || !editable || busy}>{queueing ? '正在交给后台…' : '确认应用'}</button>
        </footer>
      </form>
    </dialog>
  </>;
}

function ChangeValue({ from, to }) {
  return <span className="task-assistant-values"><span>{from || '未设置'}</span><ArrowRight size={13} aria-label="改为"/><span className="badge blue">{to}</span></span>;
}
