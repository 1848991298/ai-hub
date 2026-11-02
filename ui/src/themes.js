export const themes = [
  { id: 'graphite', name: '石墨白', description: '亮色 · 清晰克制', dark: false, canvas: '#f5f6f9', sidebar: '#e9edf4', text: '#202b3b', accent: '#3159db' },
  { id: 'midnight', name: '深海蓝', description: '深色 · 专注工作', dark: true, canvas: '#101722', sidebar: '#0b121c', text: '#e6edf9', accent: '#83b4ff' },
  { id: 'forest', name: '森林绿', description: '亮色 · 沉稳自然', dark: false, canvas: '#f2f6f3', sidebar: '#e7efe9', text: '#20392b', accent: '#226b4f' },
  { id: 'plum', name: '曜石紫', description: '深色 · 柔和夜间', dark: true, canvas: '#18151f', sidebar: '#110f17', text: '#efeaf7', accent: '#b8a0ef' },
];

export const validTheme = value => themes.some(theme => theme.id === value) ? value : 'graphite';

export function applyTheme(value) {
  const id = validTheme(value);
  document.documentElement.dataset.theme = id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themes.find(theme => theme.id === id).canvas);
  try { localStorage.setItem('ai-hub-theme', id); } catch { /* 偏好接口仍可保存 */ }
  window.webkit?.messageHandlers?.appearance?.postMessage(id);
}
