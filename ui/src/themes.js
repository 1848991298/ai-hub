export const themes = [
  { id: 'graphite', name: '雾蓝', description: '浅色', dark: false, canvas: '#fafbfc', sidebar: '#f3f4f6', text: '#212631', accent: '#315ac2' },
  { id: 'forest', name: '松石', description: '浅色', dark: false, canvas: '#f6f8f6', sidebar: '#e7efe9', text: '#20392b', accent: '#226b4f' },
  { id: 'midnight', name: '夜航', description: '深色', dark: true, canvas: '#1b202b', sidebar: '#202632', text: '#eef1f7', accent: '#9bb6fd' },
  { id: 'plum', name: '曜石紫', description: '深色', dark: true, canvas: '#18151f', sidebar: '#110f17', text: '#efeaf7', accent: '#b8a0ef' },
];

export const validTheme = value => themes.some(theme => theme.id === value) ? value : 'graphite';

export function applyTheme(value) {
  const id = validTheme(value);
  document.documentElement.dataset.theme = id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themes.find(theme => theme.id === id).canvas);
  try { localStorage.setItem('ai-hub-theme', id); } catch { /* 偏好接口仍可保存 */ }
  window.webkit?.messageHandlers?.appearance?.postMessage(id);
}
