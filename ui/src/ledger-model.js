export const statuses = ['未启动', '进行中', '已结束'];
export const priorities = ['P0', 'P1', 'P2'];

export function orderedRows(rows, saved) {
  const ids = Array.isArray(saved) ? saved : [];
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => {
    const left = rank.has(a.id) ? rank.get(a.id) : ids.length;
    const right = rank.has(b.id) ? rank.get(b.id) : ids.length;
    if (left !== right) return left - right;
    return (a.created_at || '').localeCompare(b.created_at || '') || String(a.id).localeCompare(String(b.id));
  });
}

export function moveRow(ids, from, to) {
  if (!from || !to || from === to || !ids.includes(from) || !ids.includes(to)) return ids;
  const next = ids.filter(id => id !== from);
  next.splice(next.indexOf(to), 0, from);
  return next;
}

export function emptyFilters() {
  return { status: {}, priority: {}, tags: {}, overdue: null };
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
  return !!(row.due && row.due < today && row.status !== '已结束');
}

function tagMatches(tags, map) {
  const selected = tags || [];
  const includes = Object.keys(map).filter(key => map[key] === 'include');
  const excludes = Object.keys(map).filter(key => map[key] === 'exclude');
  if (excludes.some(tag => selected.includes(tag))) return false;
  if (includes.length && !includes.every(tag => selected.includes(tag))) return false;
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
    if (!tagMatches(row.tags, filters.tags || {})) return false;
    const overdue = isOverdue(row, today);
    if (filters.overdue === 'include' && !overdue) return false;
    if (filters.overdue === 'exclude' && overdue) return false;
    return true;
  });
}

const priorityRank = { P0: 0, P1: 1, P2: 2 };
const statusRank = { '未启动': 0, '进行中': 1, '已结束': 2 };

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
    if (sinkDone && (a.status === '已结束') !== (b.status === '已结束')) return a.status === '已结束' ? 1 : -1;
    let difference = 0;
    if (key === 'created') difference = compareDate(a.created_at, b.created_at, dir);
    else if (key === 'priority') difference = compareKnown(priorityRank, a.priority, b.priority, dir);
    else if (key === 'status') difference = compareKnown(statusRank, a.status, b.status, dir);
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
  for (const key of ['content', 'status', 'due', 'priority', 'note']) {
    if ((base[key] || '') !== (values[key] || '')) patch[key] = values[key] || null;
  }
  if ((base.tags || []).join('\n') !== (values.tags || []).join('\n')) patch.tags = values.tags || [];
  return patch;
}

export function blankForm() {
  return { content: '', status: '未启动', due: '', priority: '', note: '', tags: [] };
}

export function knownTags(data) {
  const found = [];
  const sources = [data?.tag_options, ...(data?.issues || []).map(row => row?.tags), ...(data?.tasks || []).map(row => row?.tags)];
  for (const list of sources) {
    for (const name of list || []) {
      if (typeof name !== 'string' || !name.trim() || found.includes(name)) continue;
      found.push(name);
    }
  }
  return found;
}

export const ledgerColumnDefaults = { content: 280, tags: 168, status: 108, created: 168, due: 176, priority: 96, note: 220 };
const ledgerColumnLimits = { content: [160, 720], tags: [120, 360], status: [88, 200], created: [128, 260], due: [128, 280], priority: [84, 180], note: [120, 560] };

export function columnWidths(saved) {
  return Object.fromEntries(Object.keys(ledgerColumnDefaults).map(key => {
    const [minimum, maximum] = ledgerColumnLimits[key];
    const value = saved?.[key];
    const width = typeof value === 'number' && Number.isFinite(value) ? value : ledgerColumnDefaults[key];
    return [key, Math.min(maximum, Math.max(minimum, width))];
  }));
}
