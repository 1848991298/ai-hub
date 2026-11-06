import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionItems, connectedSpaces, pinnedSkills, recentProjects, storedPins, togglePin } from './overview-model.js';

const today = '2026-11-02';

test('过期台账、失败商店、映射和本地改动会变成待办', () => {
  const items = attentionItems({
    mapped: 20,
    allMappings: 24,
    changes: [{ path: 'ui/src/main.jsx' }],
    today,
    ledger: { issues: [{ due: '2026-10-01', status: '进行中' }], tasks: [{ due: '2026-10-02', status: '已结束' }] },
    market: { collection: { providers: { oppo: { state: 'ready' }, vivo: { state: 'needs_login' }, tencent: { state: 'needs_adapter' }, honor: { state: 'partial' } } } },
  });
  assert.deepEqual(items.map(item => item.id), ['overdue', 'market', 'mappings', 'changes']);
  assert.equal(items[0].title, '1 项已过截止');
  assert.deepEqual(items[0].params, { kind: 'all', overdue: '1' });
  assert.equal(items[1].params.tab, 'channels');
  assert.equal(items[1].title, 'vivo、荣耀 需要处理');
  assert.equal(items[1].detail, '登录或读取没有完成');
});

test('读不到且没有旧数据时单独提示，全部正常时为空', () => {
  const missing = attentionItems({ mapped: 3, allMappings: 3, changes: [], today, ledger: { error: true }, market: { error: true } });
  assert.deepEqual(missing.map(item => item.page), ['ledger', 'market']);
  const clear = attentionItems({
    mapped: 3, allMappings: 3, changes: [], today,
    ledger: { issues: [], tasks: [] },
    market: { collection: { providers: { oppo: { state: 'ready' } } } },
  });
  assert.deepEqual(clear, []);
});

test('最近工程先按打开时间，再用来源顺序补满', () => {
  const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.deepEqual(recentProjects(projects, { c: 2, missing: 9, a: 1 }).map(item => item.id), ['c', 'a', 'b']);
  assert.deepEqual(recentProjects(projects, {}).map(item => item.id), ['a', 'b', 'c']);
});

test('已接上的空间只报有来源的数量', () => {
  const spaces = connectedSpaces({
    projects: [{ id: 'a' }],
    skills: [{ id: 's' }, { id: 't' }],
    ledger: { error: true },
    market: { collection: { providers: { oppo: {}, vivo: {} } } },
  });
  assert.deepEqual(spaces.map(item => item.detail), ['1 个本地目录', '2 个技能，规则读共享正文', '飞书台账这次没读到', '2 个商店会话']);
});

test('钉住只保留仍存在的技能，再点一次取消', () => {
  assert.deepEqual(storedPins(['ok', 1]), ['ok']);
  assert.deepEqual(togglePin(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(togglePin(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(pinnedSkills([{ id: 'a' }, { id: 'b' }], ['b', 'gone', 'a']).map(item => item.id), ['b', 'a']);
});
