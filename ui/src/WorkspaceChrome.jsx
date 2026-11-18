import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Info, Keyboard, Palette, RefreshCw, Settings2 } from 'lucide-react';

function WorkspacePopover({ className, buttonClass, label, buttonContent, children }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    function dismiss(event) {
      if (!root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [open]);

  return <div className={className} ref={root} onKeyDown={event => {
    if (!open || event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    trigger.current?.focus();
  }}>
    <button ref={trigger} type="button" className={buttonClass} aria-label={label} title={label}
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
      {buttonContent}
    </button>
    {open && <div className="hub-popover" id={id} role="region" aria-label={label}>
      {children(() => setOpen(false))}
    </div>}
  </div>;
}

const settingsLinks = [
  ['general', '工作台设置', Settings2], ['appearance', '外观与密度', Palette],
  ['shortcuts', '快捷键', Keyboard], ['about', '关于 AI Hub', Info],
];

export function WorkspaceProfile({ profile, onSettings }) {
  const name = profile?.name || '个人工作区';
  return <WorkspacePopover className="hub-profile-popover" buttonClass="profile hub-profile"
    label={'个人菜单 · ' + name} buttonContent={<>
      <span className="avatar">{(profile?.mark || name).slice(0, profile?.mark ? 2 : 1)}</span>
    </>}>
    {close => <>
      <div className="hub-popover-heading"><strong>{name}</strong><small>{profile?.subtitle || '本机用户'}</small></div>
      <div className="hub-popover-actions">
        {settingsLinks.map(([section, label, Icon]) =>
          <button type="button" key={section} onClick={() => { close(); onSettings(section); }}>
            <Icon size={16}/><span>{label}</span>{section === 'general' && <kbd>⌘ ,</kbd>}
          </button>)}
      </div>
    </>}
  </WorkspacePopover>;
}

export function WorkspaceStatus({ title, status, tone, detail, timestamp, refreshLabel, onRefresh, busy, children }) {
  return <WorkspacePopover className="hub-status-popover" buttonClass="hub-status" label={'数据状态 · ' + status}
    buttonContent={<><span className={'hub-status-dot ' + tone}/><span className="hub-status-text">{status}</span><ChevronDown size={13}/></>}>
    {close => <>
      <div className="hub-popover-heading"><strong>{title}</strong></div>
      <div className="hub-status-detail" aria-live="polite">
        <p><span className={'hub-status-dot ' + tone}/><strong>{detail || status}</strong></p>
        <small>{timestamp ? '最近成功 ' + timestamp : '尚无成功记录'}</small>
      </div>
      <div className="hub-popover-actions">
        <button type="button" onClick={onRefresh} disabled={busy}><RefreshCw size={16} className={busy ? 'spin' : ''}/><span>{refreshLabel}</span></button>
        {children?.(close)}
      </div>
    </>}
  </WorkspacePopover>;
}

export function StatusLink({ onClick, icon: Icon, children }) {
  return <button type="button" onClick={onClick}><Icon size={16}/><span>{children}</span><ChevronRight size={14}/></button>;
}
