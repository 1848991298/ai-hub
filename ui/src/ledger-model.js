export const statuses = ['未启动', '开发中', '测试中', '已完成'];
export const priorities = ['P0', 'P1', 'P2'];
export const taskCategories = ['需求', '优化'];
export const categoryOf = row => row.kind === 'issue' ? '问题' : row.category || '未分类';
export const canonicalStatus = status => ({ '进行中': '开发中', '已结束': '已完成' }[status] || status);
export const isDone = row => canonicalStatus(row.status) === '已完成';

export function orderedRows(rows, saved, sinkDone = false) {
  const ids = Array.isArray(saved) ? saved : [];
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => {
    if (sinkDone && isDone(a) !== isDone(b)) return isDone(a) ? 1 : -1;
    const left = rank.has(a.id) ? rank.get(a.id) : ids.length;
    const right = rank.has(b.id) ? rank.get(b.id) : ids.length;
    if (left !== right) return left - right;
    return (a.created_at || '').localeCompare(b.created_at || '') || String(a.id).localeCompare(String(b.id));
  });
}

export function moveItem(ids, from, to, after = false) {
  if (!from || !to || from === to || !ids.includes(from) || !ids.includes(to)) return ids;
  const next = ids.filter(id => id !== from);
  next.splice(next.indexOf(to) + Number(after), 0, from);
  return next;
}

export function emptyFilters() {
  return { status: {}, priority: {}, category: {}, tags: {}, overdue: null };
}

export function cycleMode(mode) {
  if (mode === 'include') return 'exclude';
  if (mode === 'exclude') return null;
  return 'include';
}

export function cycleFacet(map, value) {
  const next = cycleMode(map[value]);
  const copy = { ...map };
  if (next) copy[value] = next;
  else delete copy[value];
  return copy;
}

export function isOverdue(row, today) {
  return !!(!row.archived && row.due && row.due < today && !isDone(row));
}

function tagMatches(tags, map) {
  const selected = (tags || []).map(tagKey);
  const includes = Object.keys(map).filter(key => map[key] === 'include');
  const excludes = Object.keys(map).filter(key => map[key] === 'exclude');
  if (excludes.some(tag => selected.includes(tagKey(tag)))) return false;
  if (includes.length && !includes.every(tag => selected.includes(tagKey(tag)))) return false;
  return true;
}

function facetMatches(value, map) {
  const includes = Object.keys(map).filter(key => map[key] === 'include');
  const excludes = Object.keys(map).filter(key => map[key] === 'exclude');
  if (includes.length && !includes.includes(value || '')) return false;
  if (excludes.includes(value || '')) return false;
  return true;
}

export function filterRecords(rows, filters, today) {
  return rows.filter(row => {
    if (!facetMatches(row.status, filters.status || {})) return false;
    if (!facetMatches(row.priority || '', filters.priority || {})) return false;
    if (!facetMatches(categoryOf(row), filters.category || {})) return false;
    if (!tagMatches(row.tags, filters.tags || {})) return false;
    const overdue = isOverdue(row, today);
    if (filters.overdue === 'include' && !overdue) return false;
    if (filters.overdue === 'exclude' && overdue) return false;
    return true;
  });
}

const priorityRank = { P0: 0, P1: 1, P2: 2 };
const statusRank = { '未启动': 0, '开发中': 1, '测试中': 2, '已完成': 3 };

function compareKnown(rank, left, right, dir) {
  const a = rank[left];
  const b = rank[right];
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return dir === 'desc' ? b - a : a - b;
}

function compareDate(left, right, dir) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return dir === 'desc' ? right.localeCompare(left) : left.localeCompare(right);
}

export function sortRecords(rows, sort, sinkDone = true) {
  const key = sort?.key || 'due';
  const dir = sort?.dir === 'desc' ? 'desc' : 'asc';
  return [...rows].sort((a, b) => {
    if (sinkDone && isDone(a) !== isDone(b)) return isDone(a) ? 1 : -1;
    let difference = 0;
    if (key === 'created') difference = compareDate(a.created_at, b.created_at, dir);
    else if (key === 'priority') difference = compareKnown(priorityRank, a.priority, b.priority, dir);
    else if (key === 'category') difference = compareKnown({ '需求': 0, '优化': 1, '问题': 2 }, categoryOf(a), categoryOf(b), dir);
    else if (key === 'status') difference = compareKnown(statusRank, canonicalStatus(a.status), canonicalStatus(b.status), dir);
    else difference = compareDate(a.due, b.due, dir);
    if (difference) return difference;
    return (a.created_at || '').localeCompare(b.created_at || '') || (a.id || '').localeCompare(b.id || '');
  });
}

export function nextSort(current, key) {
  const initial = { created: 'desc', priority: 'asc', status: 'asc', due: 'asc' };
  if (current.key !== key) return { key, dir: initial[key] || 'asc' };
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

export function changedFields(base, values) {
  const patch = {};
  for (const key of ['content', 'status', 'due', 'priority', 'note', 'category']) {
    if ((base[key] || '') !== (values[key] || '')) patch[key] = values[key] || null;
  }
  if ((base.tags || []).join('\n') !== (values.tags || []).join('\n')) patch.tags = values.tags || [];
  if (Boolean(base.archived) !== Boolean(values.archived)) patch.archived = Boolean(values.archived);
  return patch;
}

export function blankForm() {
  return { content: '', status: '未启动', due: '', priority: '', note: '', tags: [], archived: false, category: '' };
}

export const tagKey = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
export const hasTag = (tags, name) => (tags || []).some(tag => tagKey(tag) === tagKey(name));

export function mergeTags(values, known = []) {
  const canonical = new Map();
  for (const name of [...known, ...values]) {
    const key = tagKey(name);
    if (key && !canonical.has(key)) canonical.set(key, name.trim());
  }
  return [...new Set(values.map(tagKey).filter(Boolean))].map(key => canonical.get(key));
}

export function knownTags(data) {
  const found = [];
  const sources = [data?.tag_options, ...(data?.issues || []).map(row => row?.tags), ...(data?.tasks || []).map(row => row?.tags)];
  for (const list of sources) {
    for (const name of list || []) {
      if (typeof name !== 'string' || !name.trim()) continue;
      found.push(name);
    }
  }
  return mergeTags(found);
}

export const ledgerColumnDefaults = { content: 300, category: 100, status: 100, due: 148, priority: 94, tags: 148, created: 134, note: 192 };
export const ledgerColumnLimits = { content: [64, 1600], category: [48, 400], tags: [44, 800], status: [44, 400], created: [48, 600], due: [48, 600], priority: [44, 400], note: [48, 1600] };
export const ledgerColumnOrder = Object.keys(ledgerColumnDefaults);

export function columnSequence(saved) {
  const valid = Array.isArray(saved) ? saved.filter(key => ledgerColumnOrder.includes(key)) : [];
  if (valid.includes('content') && !valid.includes('category')) valid.splice(valid.indexOf('content') + 1, 0, 'category');
  return [...new Set([...valid, ...ledgerColumnOrder])];
}

export function columnWidths(saved) {
  return Object.fromEntries(ledgerColumnOrder.map(key => {
    const [minimum, maximum] = ledgerColumnLimits[key];
    const value = saved?.[key];
    const width = typeof value === 'number' && Number.isFinite(value) ? value : ledgerColumnDefaults[key];
    return [key, Math.min(maximum, Math.max(minimum, width))];
  }));
}

// 按当前宽度比例主动适配；末列自动补齐由 stretchLastColumn 单独处理。
export function fitColumnWidths(widths, available, keys = ledgerColumnOrder) {
  const minimum = keys.reduce((sum, key) => sum + ledgerColumnLimits[key][0], 0);
  const preferred = keys.reduce((sum, key) => sum + widths[key], 0);
  if (available < minimum) return widths;
  const scale = (available - minimum) / (preferred - minimum || 1);
  return Object.fromEntries(keys.map(key => {
    const [min, max] = ledgerColumnLimits[key];
    return [key, Math.round(Math.min(max, min + (widths[key] - min) * scale))];
  }));
}

// 自适应布局保留可读基宽，余量优先给内容和备注；不改写手动偏好。
export function fillColumnWidths(available, keys = ledgerColumnOrder) {
  const result = Object.fromEntries(keys.map(key => [key, ledgerColumnDefaults[key]]));
  let extra = Math.max(0, Math.floor(available) - Object.values(result).reduce((a,b) => a+b,0));
  const flexible = ['content','note'].filter(key => keys.includes(key));
  const initial = extra;
  for (const key of flexible) {
    const target = flexible.length === 1 ? initial : Math.floor(initial * (key === 'content' ? .7 : .3));
    const add = Math.min(extra, target, ledgerColumnLimits[key][1] - result[key]);
    result[key] += add; extra -= add;
  }
  for (const key of [...flexible, ...keys.filter(key => !flexible.includes(key))]) {
    const add = Math.min(extra, ledgerColumnLimits[key][1] - result[key]);
    result[key] += add; extra -= add;
  }
  return result;
}

// 保留前面各列的手动宽度，末列吸收余量；放不下时仅保留末列最小宽度。
export function stretchLastColumn(widths, available, keys = ledgerColumnOrder) {
  const result = Object.fromEntries(keys.map(key => [key, widths[key]]));
  const last = keys.at(-1);
  if (!last) return result;
  const fixed = keys.slice(0, -1).reduce((sum, key) => sum + result[key], 0);
  result[last] = Math.max(ledgerColumnLimits[last][0], Math.floor(available) - fixed);
  return result;
}
