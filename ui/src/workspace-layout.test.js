import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitLayout, sidebarSpan, validLayout } from './workspace-layout.js';

test('旧布局默认展开导航，并让已结束沉底', () => {
  const layout = validLayout({ sidebarWidth: 240 });
  assert.equal(layout.sidebarCollapsed, false);
  assert.equal(layout.sinkDone, true);
  assert.equal(validLayout({ sinkDone: false, sidebarCollapsed: true }).sinkDone, false);
  assert.equal(sidebarSpan(validLayout({ sidebarWidth: 300, sidebarCollapsed: true })), 72);
  assert.equal(sidebarSpan(validLayout({ sidebarWidth: 300 })), 300);
});

test('收起导航后详情栏按图标宽度计算，原导航宽度仍保留', () => {
  const open = fitLayout({ sidebarWidth: 300, inspectorWidth: 500 }, 1100);
  const closed = fitLayout({ sidebarWidth: 300, inspectorWidth: 500, sidebarCollapsed: true }, 1100);
  assert.equal(open.sidebarWidth, 300);
  assert.equal(closed.sidebarWidth, 300);
  assert.ok(closed.inspectorWidth > open.inspectorWidth);
});
