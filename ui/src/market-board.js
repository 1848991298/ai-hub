export const storeAlerts = {
  needs_login: '需核实登录', auth_restore_failed: '会话已失效', auth_key_unavailable: '钥匙串不可用',
  browser_missing: '采集浏览器缺失', profile_busy: '专用窗口被占用', access_denied: '缺少查询权限',
  developer_unverified: '需核实企业权限', read_failed: '读取失败', app_not_found: '未找到应用',
  partial: '部分同步', interrupted: '上次同步中断',
};

export function changeRatio(current, previous) {
  if (current == null || previous == null || previous <= 0) return null;
  return (current - previous) / previous;
}

export function shiftDate(date, days) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}

export function calendarPoints(points, since, end, onlyActive) {
  const start = since;
  if (onlyActive) return points.filter(point => point.total > 0 && point.date >= start && point.date <= end);
  const byDate = new Map(points.map(point => [point.date, point]));
  const dates = [];
  for (let date = start; date <= end; date = shiftDate(date, 1)) {
    dates.push(byDate.get(date) || { date, total: null, parts: {} });
  }
  return dates;
}

export function selectChannels(points, ids) {
  return points.map(point => {
    const parts = Object.fromEntries(ids.filter(id => point.parts[id] != null).map(id => [id, point.parts[id]]));
    const values = Object.values(parts);
    return { date: point.date, parts, total: values.length ? values.reduce((sum, n) => sum + n, 0) : null };
  });
}

// 周按周一开始；首尾周期按实际选择范围裁切。缺失记录不补零。
export function aggregateTimeline(points, ids, start, end, unit = 'day') {
  const selected = selectChannels(points, ids);
  const groups = new Map();
  for (const day of calendarPoints(selected, start, end, false)) {
    const key = unit === 'month' ? day.date.slice(0, 7) + '-01' : unit === 'week'
      ? shiftDate(day.date, -(new Date(day.date + 'T00:00:00Z').getUTCDay() + 6) % 7) : day.date;
    if (!groups.has(key)) groups.set(key, { key, start: day.date, end: day.date, days: 0, knownDays: 0, total: null, parts: {}, coverage: {} });
    const group = groups.get(key);
    group.end = day.date; group.days++;
    if (day.total != null) { group.knownDays++; group.total = (group.total ?? 0) + day.total; }
    for (const id of ids) if (day.parts[id] != null) {
      group.parts[id] = (group.parts[id] ?? 0) + day.parts[id];
      group.coverage[id] = (group.coverage[id] ?? 0) + 1;
    }
  }
  return [...groups.values()].map(group => ({ ...group, partial: ids.some(id => (group.coverage[id] ?? 0) < group.days) }));
}

export function chartTicks(maximum, logarithmic = false) {
  const max = Math.max(1, maximum || 0);
  if (logarithmic) {
    const ticks = [0, 1];
    for (let n = 10; n < max * 10; n *= 10) { ticks.push(n); if (n >= max) break; }
    return ticks;
  }
  const raw = max / 4, power = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].find(n => n * power >= raw) * power);
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

export function timelineRows(buckets, filter = 'recorded', sort = 'newest') {
  const filtered = buckets.filter(row => {
    if (filter === 'all') return true;
    if (filter === 'positive') return row.total > 0;
    if (filter === 'partial') return row.partial;
    return row.total != null;
  });
  return [...filtered].sort((a, b) => {
    if (sort === 'highest' || sort === 'lowest') {
      if (a.total == null || b.total == null) return a.total == null ? b.total == null ? b.start.localeCompare(a.start) : 1 : -1;
      return (sort === 'highest' ? b.total - a.total : a.total - b.total) || b.start.localeCompare(a.start);
    }
    return sort === 'oldest' ? a.start.localeCompare(b.start) : b.start.localeCompare(a.start);
  });
}

export function buildBoard(points, orderedIds) {
  const active = points.filter(point => point.total > 0);
  const latest = points.at(-1) || null;
  const previous = latest && points.find(point => point.date === shiftDate(latest.date, -1));
  const coverage = point => orderedIds.filter(id => point?.parts[id] != null);
  const covered = coverage(latest);
  const before = coverage(previous);
  const comparable = Boolean(previous && covered.length && covered.length === before.length && covered.every(id => before.includes(id)));
  const stores = orderedIds.map(id => {
    const recorded = points.filter(point => point.parts[id] != null);
    const latestValue = latest?.parts[id] ?? null;
    const previousValue = previous?.parts[id] ?? null;
    return {
      id,
      total: recorded.length ? recorded.reduce((sum, point) => sum + point.parts[id], 0) : null,
      latest: latestValue,
      previous: previousValue,
      change: changeRatio(latestValue, previousValue),
    };
  }).sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
  return {
    total: latest ? points.reduce((sum, point) => sum + point.total, 0) : null,
    active, latest, previous: previous || null, covered,
    change: comparable ? changeRatio(latest.total, previous.total) : null,
    comparison: !previous ? '前一天缺少记录' : !comparable ? '前后两天覆盖渠道不同' : previous.total <= 0 ? '前一天为 0' : '',
    stores,
  };
}
