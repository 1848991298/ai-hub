import { isOverdue } from './ledger-model.js';
import { storeAlerts } from './market-board.js';

const storeNames = { oppo: 'OPPO', vivo: 'vivo', xiaomi: '小米', tencent: '应用宝', honor: '荣耀' };

export function storedPins(value) {
  return Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
}

export function storedVisits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, at]) => Number.isFinite(at)));
}

export function togglePin(pins, id) {
  return pins.includes(id) ? pins.filter(item => item !== id) : [...pins, id];
}

export function pinnedSkills(skills, pins) {
  const known = new Map(skills.map(skill => [skill.id, skill]));
  return pins.map(id => known.get(id)).filter(Boolean);
}

export function recentProjects(projects, visits, limit = 3) {
  const known = new Map(projects.map(project => [project.id, project]));
  const visited = Object.entries(visits)
    .filter(([id]) => known.has(id))
    .sort((left, right) => right[1] - left[1])
    .map(([id]) => known.get(id));
  const rest = projects.filter(project => !visited.some(item => item.id === project.id));
  return [...visited, ...rest].slice(0, limit);
}

export function attentionItems({ mapped, allMappings, changes, ledger, market, rules, today }) {
  const items = [];
  const rows = [...(ledger?.issues || []), ...(ledger?.tasks || [])];
  if (ledger?.error && !rows.length) items.push({ id: 'ledger', page: 'ledger', title: '台账没有读到', detail: '打开问题与任务再核对一次' });
  else {
    const overdue = rows.filter(row => isOverdue(row, today)).length;
    if (overdue) items.push({ id: 'overdue', page: 'ledger', title: `${overdue} 项已过截止`, detail: ledger?.error ? '按最近一次成功读取的台账' : '查看问题和任务里的逾期记录', params: { kind: 'all', overdue: '1' } });
  }
  const collection = market?.collection;
  if (market?.error && !collection) items.push({ id: 'market', page: 'market', title: '商店状态没有读到', detail: '打开应用运营再核对一次' });
  else if (collection) {
    const providers = collection.providers || { oppo: collection };
    const bad = Object.entries(providers).filter(([, item]) => Object.hasOwn(storeAlerts, item?.state));
    if (bad.length) {
      const partial = bad.every(([, item]) => item.state === 'partial');
      items.push({
        id: 'market',
        page: 'market',
        title: `${bad.map(([id]) => storeNames[id] || id).join('、')} 需要处理`,
        detail: partial ? '有数据只同步了一部分' : '登录或读取没有完成',
        params: { tab: 'channels', channel: bad.length === 1 ? bad[0][0] : 'all', alert: '1' },
      });
    }
  }
  const cursor = rules?.clients?.find(client => client.id === 'cursor');
  const codex = rules?.clients?.find(client => client.id === 'codex');
  const affected = rules?.documents?.find(doc => doc.client === 'cursor' && ['conflict', 'pending'].includes(doc.status));
  if (cursor?.status === 'error' || affected) items.push({
    id: 'cursor-rules', page: 'rules', title: 'Cursor 规则待核对',
    detail: cursor?.status === 'error' ? '本次原生读取失败，查看上次核验与原因' : '查看等待同步或存在差异的正文',
    params: { client: 'cursor', document: affected?.id || 'cursor-bootstrap' },
  });
  if (codex && codex.status !== 'synced') items.push({
    id: 'codex-rules', page: 'rules', title: 'Codex 全局入口待核对',
    detail: '查看共享正文的映射状态', params: { client: 'codex', document: codex.status === 'conflict' ? 'codex-entry' : 'global' },
  });
  if (allMappings && mapped < allMappings) items.push({ id: 'mappings', page: 'skills', title: `技能映射 ${mapped} / ${allMappings}`, detail: '有技能目录待检查' });
  if (changes?.length) items.push({ id: 'changes', page: 'changes', title: `Hub 有 ${changes.length} 个文件待整理`, detail: '只在本地，不会自动提交' });
  return items;
}

export function connectedSpaces({ projects = [], skills = [], ledger, market }) {
  const ledgerCount = (ledger?.issues?.length || 0) + (ledger?.tasks?.length || 0);
  const providers = market?.collection?.providers;
  const storeCount = providers ? Object.keys(providers).length : 0;
  return [
    { id: 'projects', page: 'projects', title: '工程', detail: `${projects.length} 个本地目录` },
    { id: 'skills', page: 'skills', title: '技能与规则', detail: `${skills.length} 个技能，规则读共享正文` },
    { id: 'ledger', page: 'ledger', title: '台账', detail: ledger?.error && !ledgerCount ? '飞书台账这次没读到' : `${ledgerCount} 条问题和任务` },
    { id: 'market', page: 'market', title: '应用商店', detail: market?.error && !market?.collection ? '商店状态没读到' : storeCount ? `${storeCount} 个商店会话` : '还没有商店会话' },
  ];
}
