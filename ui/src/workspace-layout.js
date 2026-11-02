export const defaultLayout = { sidebarWidth: 224, inspectorWidth: 340, fontSize: 14 };
export const layoutKey = 'ai-hub-workspace-layout';
export const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function validLayout(value) {
  const number = (key, low, high) => typeof value?.[key] === 'number' && Number.isFinite(value[key]) ? clamp(value[key], low, high) : defaultLayout[key];
  return { sidebarWidth: number('sidebarWidth', 184, 320), inspectorWidth: number('inspectorWidth', 280, 560), fontSize: [13, 14, 15].includes(value?.fontSize) ? value.fontSize : 14 };
}

export function fitLayout(value, viewportWidth) {
  const layout = validLayout(value);
  // 窄窗口使用详情抽屉；桌面三栏为内容区至少留 360px。
  return { ...layout, inspectorWidth: viewportWidth >= 1024 ? Math.min(layout.inspectorWidth, viewportWidth - layout.sidebarWidth - 367) : layout.inspectorWidth };
}
