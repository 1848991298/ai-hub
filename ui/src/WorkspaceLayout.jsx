import React, { useEffect, useRef, useState } from 'react';
import { clamp, defaultLayout, fitLayout, layoutKey, sidebarSpan, validLayout } from './workspace-layout.js';

export function useWorkspaceLayout() {
  const [layout, setLayout] = useState(() => { try { return validLayout(JSON.parse(localStorage.getItem(layoutKey))); } catch { return defaultLayout; } });
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  useEffect(() => { const resize = () => setViewportWidth(window.innerWidth); addEventListener('resize', resize); return () => removeEventListener('resize', resize); }, []);
  useEffect(() => { try { localStorage.setItem(layoutKey, JSON.stringify(layout)); } catch { /* 本窗口仍可使用布局。 */ } }, [layout]);
  const fitted = fitLayout(layout, viewportWidth);
  function update(key, value) { setLayout(current => validLayout({ ...current, [key]: value })); }
  return { ...fitted, sidebarSpan: sidebarSpan(fitted), viewportWidth, update, reset: () => setLayout(current => validLayout({ ...defaultLayout, fontSize: current.fontSize, sinkDone: current.sinkDone })) };
}

export function PanelResize({ label, controls, value, minimum, maximum, defaultValue, direction = 1, onChange, className = '' }) {
  const drag = useRef(null);
  useEffect(() => () => document.body.classList.remove('is-resizing'), []);
  function finish() { drag.current = null; document.body.classList.remove('is-resizing'); }
  function keyDown(event) {
    const change = { ArrowLeft: -10 * direction, ArrowRight: 10 * direction }[event.key];
    if (change !== undefined || ['Home', 'End', 'Enter'].includes(event.key)) {
      event.preventDefault();
      onChange(event.key === 'Home' ? minimum : event.key === 'End' ? maximum : event.key === 'Enter' ? defaultValue : clamp(value + change, minimum, maximum));
    }
  }
  return <div role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-controls={controls} aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)} 像素`} title="拖动调整宽度 · 双击恢复 · 方向键微调" className={`panel-resize ${className}`}
    onKeyDown={keyDown} onDoubleClick={() => onChange(defaultValue)}
    onPointerDown={event => { if (!event.isPrimary || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { pointer: event.pointerId, x: event.clientX, width: value }; document.body.classList.add('is-resizing'); }}
    onPointerMove={event => { const start = drag.current; if (start?.pointer === event.pointerId) onChange(clamp(start.width + (event.clientX - start.x) * direction, minimum, maximum)); }}
    onPointerUp={event => { if (drag.current?.pointer === event.pointerId) { event.currentTarget.releasePointerCapture(event.pointerId); finish(); } }}
    onPointerCancel={finish} onLostPointerCapture={finish}><span /></div>;
}
