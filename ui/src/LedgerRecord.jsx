import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Image as ImageIcon, Plus, X } from 'lucide-react';

export const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const maxImageSize = 20 * 1024 * 1024;
export const maxImageCount = 20;

export async function stageImage(image) {
  const response = await fetch('/api/tracker/stage-image', {
    method: 'POST',
    headers: { 'X-Image-Id': image.id, 'X-Image-Name': encodeURIComponent(image.file.name) },
    body: image.file,
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || '截图未能保存到本机，请重试。');
  }
}

export function useRecordPreview() {
  const [preview, setPreview] = useState(null);
  const timer = useRef(null);
  const card = useRef(null);
  const dismiss = useCallback(() => {
    clearTimeout(timer.current);
    setPreview(null);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!preview) return;
    function outside(event) {
      if (!card.current?.contains(event.target)) dismiss();
    }
    function escape(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [preview, dismiss]);

  useLayoutEffect(() => {
    if (!preview) return;
    const element = card.current;
    const rect = preview.anchor.getBoundingClientRect();
    const margin = 16;
    const gap = 4;
    const below = window.innerHeight - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;
    const placeAbove = element.offsetHeight > below && above > below;
    const width = element.offsetWidth;
    const preferredLeft = Math.max(margin, rect.left, preview.x - width + margin);
    element.style.left = `${Math.min(preferredLeft, window.innerWidth - width - margin)}px`;
    element.style.top = placeAbove ? 'auto' : `${rect.bottom + gap}px`;
    element.style.bottom = placeAbove ? `${window.innerHeight - rect.top + gap}px` : 'auto';
    element.style.setProperty('--ledger-preview-height', `${Math.max(0, placeAbove ? above : below)}px`);
    element.classList.toggle('is-above', placeAbove);
  }, [preview]);

  function leave() {
    clearTimeout(timer.current);
    if (preview) timer.current = setTimeout(dismiss, 100);
  }

  function bind(text, label, onlyClipped = false) {
    return {
      onPointerEnter(event) {
        if (event.pointerType !== 'mouse' || event.buttons || !text?.trim()) return;
        const anchor = event.currentTarget;
        if (onlyClipped && anchor.scrollWidth <= anchor.clientWidth) return;
        clearTimeout(timer.current);
        if (preview?.anchor === anchor) return;
        setPreview(null);
        const x = event.clientX;
        timer.current = setTimeout(() => {
          if (!anchor.isConnected || !anchor.matches(':hover')) return;
          setPreview({ anchor, text, label, x });
        }, 180);
      },
      onPointerLeave: leave,
    };
  }

  const popup = preview && createPortal(
    <div ref={card} className="ledger-text-preview" aria-hidden="true"
      onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={leave}>
      <div className="ledger-text-preview-content">
        <strong>{preview.label}</strong>
        <p>{preview.text}</p>
      </div>
    </div>, document.body,
  );
  return { bind, dismiss, popup };
}

function onBackdrop(event) {
  if (event.target !== event.currentTarget) return false;
  const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
  return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
}

function useBackdropDismiss(enabled, dismiss) {
  const startedOutside = useRef(false);
  return {
    onPointerDown(event) {
      startedOutside.current = enabled && event.isPrimary && event.button === 0 && onBackdrop(event);
    },
    onPointerCancel() { startedOutside.current = false; },
    onClick(event) {
      const shouldDismiss = enabled && startedOutside.current && onBackdrop(event);
      startedOutside.current = false;
      if (shouldDismiss) {
        event.stopPropagation();
        dismiss();
      }
    },
  };
}

export function RecordInspector({ recordKey, title, subtitle, onClose, onPaste, noteFocus, tabs, children }) {
  const dialog = useRef(null);
  const heading = useRef(null);
  const titleId = useId();
  const backdrop = useBackdropDismiss(true, onClose);
  useLayoutEffect(() => {
    const element = dialog.current;
    const workspace = element.parentElement;
    function fit() {
      const floating = workspace.clientWidth < 920;
      if (element.open && floating === (element.dataset.floating === 'true')) return;
      if (document.querySelector('dialog:modal:not(#ledger-inspector)')) return;
      if (element.open) element.close();
      element.dataset.floating = String(floating);
      if (floating) element.showModal();
      else element.show();
      heading.current.focus({ preventScroll: true });
    }
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(workspace);
    document.addEventListener('close', fit, true);
    return () => {
      document.removeEventListener('close', fit, true);
      resize.disconnect();
      element.close();
    };
  }, []);
  useLayoutEffect(() => {
    const target = noteFocus?.current || heading.current;
    target.focus({ preventScroll: true });
    if (noteFocus?.current) target.scrollIntoView({ block: 'nearest' });
  }, [recordKey, noteFocus]);
  return <dialog ref={dialog} id="ledger-inspector" className="ledger-inspector" aria-labelledby={titleId}
    onPaste={onPaste} {...backdrop}
    onCancel={event => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      onClose();
    }}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented ||
        event.target.closest('dialog') !== event.currentTarget || event.currentTarget.dataset.floating === 'true') return;
      event.preventDefault();
      onClose();
    }}>
    <header className="ledger-inspector-head">
      <div><div className="ledger-inspector-meta">{subtitle}</div><h2 id={titleId} tabIndex={-1} ref={heading}>{title}</h2></div>
      <button type="button" className="ledger-close" aria-label="关闭记录侧栏" onClick={onClose}><X size={18}/></button>
    </header>
    {tabs}
    {children}
  </dialog>;
}

export function RecordDrawer({ title, onClose, onPaste, busy, animate, children }) {
  const dialog = useRef(null);
  const heading = useRef(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  useLayoutEffect(() => {
    heading.current.focus({ preventScroll: true });
  }, [title]);
  return <dialog ref={dialog} className="ledger-drawer" data-animated={animate || undefined}
    aria-labelledby={titleId} onPaste={onPaste}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="ledger-drawer-head">
      <h2 id={titleId} ref={heading} tabIndex={-1}>{title}</h2>
      <button type="button" className="ledger-close" aria-label="关闭记录详情" disabled={busy} onClick={onClose}><X size={19} aria-hidden="true"/></button>
    </header>
    {children}
  </dialog>;
}

export function RecordText({ text }) {
  const parts = String(text || '').split(/(https?:\/\/[^\s<>"，。；！？）]+)/g);
  return <div className="ledger-record-text">{parts.map((part, index) => index % 2
    ? <a key={index} href={part} target="_blank" rel="noopener noreferrer">{part}</a> : part)}</div>;
}

export function RecordTextarea({ label, value, onChange, required }) {
  const field = useRef(null);
  useLayoutEffect(() => {
    const element = field.current;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight + 2}px`;
  }, [value]);
  return <label>{label}<textarea ref={field} aria-label={label} required={required} maxLength={2000} rows={3} value={value}
    onChange={event => onChange(event.target.value)} /></label>;
}

function ImagePreview({ image, onClose }) {
  const dialog = useRef(null);
  const [failed, setFailed] = useState(false);
  const backdrop = useBackdropDismiss(true, onClose);
  useLayoutEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className="ledger-image-preview" aria-label={image.name} {...backdrop}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
    <header><strong>{image.name}</strong><button type="button" className="ledger-close" aria-label="关闭图片预览" onClick={onClose}><X size={19} aria-hidden="true"/></button></header>
    {failed ? <p role="status">暂时无法预览这张截图，可在飞书中打开。</p> :
      <img src={image.src} alt={image.name} onError={() => setFailed(true)}/>}
  </dialog>;
}

export function RecordImages({ row, drafts = [], onFiles, onRemove, disabled, error }) {
  const picker = useRef(null);
  const [preview, setPreview] = useState(null);
  const stored = (row?.attachments || []).map(image => ({
    id: image.file_token,
    name: image.name.replace(/-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?=\.[a-z]+$)/, ''),
    src: '/api/tracker/image?' + new URLSearchParams({kind:row.kind, record:row.id, file:image.file_token}),
  }));
  const images = [...stored, ...drafts.map(image => ({ id:image.id, name:image.file.name || '截图', src:image.src, draft:true }))];
  function acceptFiles(files) {
    if (!disabled && files?.length) onFiles?.(Array.from(files));
  }
  return <section className="ledger-images" aria-label="截图">
    <div className="ledger-images-head"><h3>截图 {images.length ? <span>{images.length}</span> : null}</h3>
      {row?.pending_images > 0 && <small>{row.pending_images} 张待同步</small>}
    </div>
    {!!images.length && <ul className="ledger-image-grid">
      {images.map(image => <li key={image.id}>
        <button type="button" className="ledger-image-tile" aria-label={`预览 ${image.name}`} onClick={() => setPreview(image)}>
          <span className="ledger-image-frame">
            <ImageIcon size={19} aria-hidden="true"/>
            <img src={image.src} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true; }}/>
          </span>
          <span className="ledger-image-name" title={image.name}>{image.name}</span>
        </button>
        {image.draft && <button type="button" className="ledger-image-remove" aria-label={`移除 ${image.name}`}
          disabled={disabled} onClick={() => onRemove(image.id)}><X size={14} aria-hidden="true"/></button>}
      </li>)}
    </ul>}
    {onFiles ? <div className="ledger-image-drop" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
      onDrop={event => { event.preventDefault(); acceptFiles(event.dataTransfer.files); }}>
      <input ref={picker} type="file" multiple accept={imageTypes.join(',')} hidden
        onChange={event => { acceptFiles(event.target.files); event.target.value = ''; }}/>
      <button type="button" disabled={disabled} onClick={() => picker.current.click()}><Plus size={15} aria-hidden="true"/>添加图片</button>
      <small>可直接粘贴或拖入 · 每张最大 20 MB</small>
    </div> : !images.length && <p className="ledger-caption">暂无截图</p>}
    {error && <p className="ledger-image-error" role="alert">{error}</p>}
    {preview && <ImagePreview image={preview} onClose={() => setPreview(null)}/>}
  </section>;
}
