import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOrder, moveItem } from './market-order.js';

test('记住的顺序只保留仍存在的商店，新商店补在后面', () => {
  assert.deepEqual(applyOrder(['oppo', 'vivo', 'xiaomi'], ['xiaomi', 'gone', 'oppo']), ['xiaomi', 'oppo', 'vivo']);
  assert.deepEqual(applyOrder(['oppo', 'vivo'], null), ['oppo', 'vivo']);
});

test('拖到另一张卡片上时，插入到那张卡片的位置', () => {
  assert.deepEqual(moveItem(['oppo', 'vivo', 'xiaomi', 'tencent', 'honor'], 'honor', 'vivo'), ['oppo', 'honor', 'vivo', 'xiaomi', 'tencent']);
  assert.deepEqual(moveItem(['oppo', 'vivo'], 'oppo', 'oppo'), ['oppo', 'vivo']);
  assert.deepEqual(moveItem(['oppo', 'vivo'], 'missing', 'vivo'), ['oppo', 'vivo']);
});
