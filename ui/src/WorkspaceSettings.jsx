import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Folder, FolderGit2, Gauge, Info, Keyboard, LayoutGrid, ListTodo, Palette, RefreshCw, SlidersHorizontal, Store, X } from 'lucide-react';
import { themes } from './themes.js';

export const workspaceModules = [
  { id: 'ledger', label: '问题与任务', icon: ListTodo, description: '查看飞书台账和 AI 建议' },
  { id: 'projects', label: '工程合集', icon: FolderGit2, description: '浏览工程、分支和工作树' },
  { id: 'usage', label: '用量中心', icon: Gauge, description: '查看客户端用量和剩余额度' },
  { id: 'market', label: '应用运营', icon: Store, description: '查看版本、审核和渠道数据' },
];

const sections = [
  ['工作区', [
    ['general', '通用', SlidersHorizontal],
    ['modules', '功能模块', LayoutGrid],
    ['appearance', '外观与密度', Palette],
  ]],
  ['接入与数据', [['diagnostics', '同步与诊断', RefreshCw]]],
  ['应用', [['shortcuts', '快捷键', Keyboard], ['about', '关于 AI Hub', Info]]],
];

function SettingRow({ title, description, children }) {
  return <div className="hub-setting-row">
    <div><h3>{title}</h3>{description && <p>{description}</p>}</div>
    <div className="hub-setting-control">{children}</div>
  </div>;
}

function SettingGroup({ title, children }) {
  return <section className="hub-setting-group">
    <h3 className="hub-group-heading">{title}</h3>
    <div className="hub-setting-list">{children}</div>
  </section>;
}

function Switch({ label, enabled, toggle }) {
  return <button type="button" className={`switch ${enabled ? 'enabled' : ''}`} role="switch" aria-checked={enabled} aria-label={label} onClick={toggle}><span/></button>;
}

function Choices({ label, choices, value, onChange }) {
  return <div className="segmented" role="group" aria-label={label}>
    {choices.map(([id, name]) => <button type="button" key={id} aria-pressed={value === id} className={value === id ? 'active' : ''} onClick={() => onChange(id)}>{name}</button>)}
  </div>;
}

function General({ profile, root, refresh }) {
  const [person, setPerson] = useState(() => ({ name: '', mark: '', subtitle: '', ...profile }));
  const [result, setResult] = useState(null);
  const [saving, setSaving] = useState(false);
  async function save(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const response = await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(person) });
      if (!response.ok) throw new Error('显示名未保存，请检查本机服务后重试。');
      setResult({ ok: true, message: '显示名已保存' });
      refresh(false);
    } catch (error) { setResult({ ok: false, message: error.message }); }
    finally { setSaving(false); }
  }
  return <>
    <section className="hub-setting-group">
      <h3 className="hub-group-heading">个人资料</h3>
      <form className="hub-profile-form" onSubmit={save}>
        <div className="hub-profile-preview">
          <span className="avatar">{(person.mark || person.name || '·').slice(0, 2)}</span>
          <div><strong>{person.name || '显示名称'}</strong><small>{person.subtitle || '本机显示名'}</small></div>
        </div>
        <div className="hub-profile-fields">
          {[['name', '显示名称', 40], ['mark', '头像文字', 2], ['subtitle', '一句话', 40]].map(([key, label, length]) =>
            <label className="hub-profile-field" key={key}>
              <span>{label}</span>
              <span className="hub-profile-input">
                <input value={person[key]} maxLength={length} required={key === 'name'} className={key === 'mark' ? 'hub-initial-input' : undefined}
                  placeholder={key === 'subtitle' ? '添加简短描述' : undefined}
                  onChange={event => { setPerson({ ...person, [key]: event.target.value }); setResult(null); }}/>
                {key === 'mark' && <small>最多 2 个字</small>}
              </span>
            </label>
          )}
        </div>
        <footer className="hub-profile-footer">
          {result && <p role={result.ok ? 'status' : 'alert'}>{result.message}</p>}
          <button type="submit" className="button primary" disabled={saving}>{saving ? '保存中…' : '保存修改'}</button>
        </footer>
      </form>
    </section>
    <SettingGroup title="数据位置">
      <SettingRow title="Hub 维护源" description="规则与个人技能的统一来源">
        <span className="hub-source-location" title={root}><code>~/.ai-hub</code><Folder size={17} strokeWidth={1.5}/></span>
      </SettingRow>
    </SettingGroup>
  </>;
}

function Modules({ hidden, toggle }) {
  return <SettingGroup title="导航入口">
    {workspaceModules.map(({ id, label, icon: Icon, description }) =>
      <div className="hub-setting-row hub-module-row" key={id}>
        <span className="hub-setting-icon"><Icon size={17} strokeWidth={1.5}/></span>
        <div className="hub-module-copy"><h3>{label}</h3><p>{description}</p></div>
        <Switch label={`显示${label}`} enabled={!hidden.includes(id)} toggle={() => toggle(id)}/>
      </div>
    )}
  </SettingGroup>;
}

function Appearance({ theme, chooseTheme, layout, compact, setCompact, rowHeight, setRowHeight, motion, setMotion }) {
  return <>
    <section className="hub-setting-group">
      <h3 className="hub-group-heading">主题</h3>
      <div className="theme-grid hub-theme-grid" role="group" aria-label="外观主题">
      {themes.map(item => <button type="button" key={item.id} className="theme-option" aria-pressed={theme === item.id} aria-label={item.name} onClick={() => chooseTheme(item.id)}>
        <span className="theme-sample" aria-hidden="true" style={{ '--sample-canvas': item.canvas, '--sample-sidebar': item.sidebar, '--sample-text': item.text, '--sample-accent': item.accent }}>
          <span className="sample-nav"><i/><i/><i/></span><span className="sample-main"><i/><i/><i/></span>
        </span>
        <span className="theme-label"><span><strong>{item.name}</strong><small>{item.description}</small></span>{theme === item.id && <Check size={17}/>}</span>
      </button>)}
      </div>
    </section>
    <SettingGroup title="阅读与列表">
      <SettingRow title="界面字号" description="跟随所选字号调整控件比例"><Choices label="界面字号" value={layout.fontSize} choices={[[13, '13'], [14, '14'], [15, '15']]} onChange={value => layout.update('fontSize', value)}/></SettingRow>
      <SettingRow title="任务表行高" description="随内容时可展开较长的标题和备注"><Choices label="任务表行高" value={rowHeight} choices={[[ 'single', '紧凑'], ['auto', '随内容']]} onChange={setRowHeight}/></SettingRow>
      <SettingRow title="任务排序" description="已完成的记录排在当前排序底部"><Switch label="已完成沉底" enabled={layout.sinkDone} toggle={() => layout.update('sinkDone', !layout.sinkDone)}/></SettingRow>
      <SettingRow title="资源列表紧凑显示"><Switch label="资源列表紧凑显示" enabled={compact} toggle={() => setCompact(!compact)}/></SettingRow>
    </SettingGroup>
    <SettingGroup title="交互">
      <SettingRow title="界面动效" description="使用轻量反馈和面板过渡"><Switch label="界面动效" enabled={motion} toggle={() => setMotion(!motion)}/></SettingRow>
      <SettingRow title="面板布局" description="导航支持折叠与拖动调宽"><button type="button" className="button" onClick={layout.reset}>恢复默认布局</button></SettingRow>
    </SettingGroup>
  </>;
}

function Diagnostics() {
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/diagnostics', { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error('读取失败');
        return response.json();
      })
      .then(data => setResult({ data }))
      .catch(() => { if (!controller.signal.aborted) setResult({ error: true }); });
    return () => controller.abort();
  }, [attempt]);
  if (!result) return <p className="caption" role="status">正在读取本机诊断…</p>;
  if (result.error) return <p className="inline-error" role="alert">诊断暂不可读。 <button type="button" className="text-button" onClick={() => { setResult(null); setAttempt(attempt + 1); }}>重试</button></p>;
  const { caches, sources, log_path: path, log } = result.data;
  return <>
    <div className="hub-setting-list">
      {caches.map(item => <SettingRow key={item.id} title={item.label} description={item.detail}><small>{item.updated || '等待首次缓存'}</small></SettingRow>)}
      {sources.map(item => <SettingRow key={item.id} title={item.label} description={item.detail}><span className={`badge ${item.used ? 'sage' : ''}`}>{item.used ? '在用' : '未接入'}</span></SettingRow>)}
    </div>
    <details className="hub-setting-log"><summary>服务日志</summary><p>{path}</p><pre className="settings-log">{log.join('\n') || '暂无日志记录。'}</pre></details>
  </>;
}

export default function WorkspaceSettings({ section, onNavigate, onClose, hidden, toggleModule, data, refresh, ...appearance }) {
  const dialog = useRef(null);
  useEffect(() => {
    const panel = dialog.current;
    const previous = document.activeElement;
    panel.showModal();
    panel.querySelector('[aria-current="page"]')?.focus({ preventScroll: true });
    return () => {
      panel.close();
      const target = previous?.isConnected && previous !== document.body ? previous : document.querySelector('.hub-settings-link');
      target?.focus({ preventScroll: true });
    };
  }, []);
  const allSections = sections.flatMap(([, items]) => items);
  const current = allSections.find(([id]) => id === section) || allSections.find(([id]) => id === 'general');
  const [id, title] = current;
  const descriptions = {
    general: '设置侧栏中显示的名称和头像',
    modules: '选择在主导航中显示的工作模块',
    appearance: '让阅读、列表和面板适合你的工作习惯',
    diagnostics: '查看规则映射、客户端接入与本机数据状态',
    shortcuts: '常用入口可以直接用键盘打开',
    about: '个人工程、规则与 AI 能力工作台',
  };
  return <dialog className="hub-settings-dialog" ref={dialog} aria-labelledby="hub-settings-title"
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll('button,a[href],input,select,textarea,[tabindex="0"]')]
        .filter(element => !element.matches(':disabled') && element.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <div className="hub-settings">
      <aside className="hub-settings-sidebar">
      <header className="hub-settings-title"><h1 id="hub-settings-title">设置</h1><span>AI Hub</span></header>
      <nav aria-label="设置分类" className="hub-settings-nav">
        {sections.map(([group, items]) => <div key={group}>
          <p>{group}</p>
          {items.map(([key, label, Icon]) => <button type="button" className="nav-item" key={key} aria-current={id === key ? 'page' : undefined} onClick={() => onNavigate(key)}><Icon size={17} strokeWidth={1.5}/>{label}</button>)}
        </div>)}
      </nav>
      <div className="hub-settings-footnote">本机工作区</div>
      </aside>
      <section className="hub-setting-content" key={id} aria-labelledby="hub-setting-section">
        <header className="hub-setting-heading">
          <h2 id="hub-setting-section">{title}</h2>
          <p>{descriptions[id]}</p>
        </header>
        {id === 'general' && <General profile={data.profile} root={data.hub_root} refresh={refresh}/>}
        {id === 'modules' && <><Modules hidden={hidden} toggle={toggleModule}/><p className="hub-setting-hint">关闭导航入口后，仍可通过 ⌘ K 搜索打开。</p></>}
        {id === 'appearance' && <Appearance {...appearance}/>}
        {id === 'diagnostics' && <Diagnostics/>}
        {id === 'shortcuts' && <div className="hub-setting-list">{[['搜索资源或打开页面', '⌘ K'], ['打开设置', '⌘ ,'], ['关闭对话框', 'Esc']].map(([name, key]) => <SettingRow key={name} title={name}><kbd>{key}</kbd></SettingRow>)}</div>}
        {id === 'about' && <div className="hub-setting-list">
          <SettingRow title="AI Hub" description="本机 Web 与 macOS 工作台"><span className="badge">0.7.0</span></SettingRow>
          <SettingRow title="项目主页"><a className="text-button" href="https://github.com/1848991298/ai-hub" target="_blank" rel="noreferrer">GitHub <ChevronRight size={14}/></a></SettingRow>
        </div>}
      </section>
      <button type="button" className="hub-settings-close" aria-label="关闭设置" title="关闭设置 · Esc" onClick={onClose}><X size={18} strokeWidth={1.5}/></button>
    </div>
  </dialog>;
}
