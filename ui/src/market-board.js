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
  const start = [since, shiftDate(end, -365)].sort().at(-1);
  if (onlyActive) return points.filter(point => point.total > 0 && point.date >= start && point.date <= end);
  const byDate = new Map(points.map(point => [point.date, point]));
  const dates = [];
  for (let date = start; date <= end; date = shiftDate(date, 1)) {
    dates.push(byDate.get(date) || { date, total: null, parts: {} });
  }
  return dates;
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
