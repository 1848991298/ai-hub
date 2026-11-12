import React, { useId, useLayoutEffect, useRef, useState } from 'react';
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

export function RecordDrawer({ title, subtitle, onClose, onPaste, busy, children }) {
  const dialog = useRef(null);
  const heading = useRef(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const element = dialog.current;
    element.showModal();
    heading.current.focus();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className="ledger-drawer" aria-labelledby={titleId} onPaste={onPaste}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="ledger-drawer-head">
      <div><h2 id={titleId} ref={heading} tabIndex={-1}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
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
  useLayoutEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className="ledger-image-preview" aria-label={image.name}
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
