export const statuses = ['未启动', '进行中', '已结束'];
export const priorities = ['P0', 'P1', 'P2'];

export function filterRecords(rows, filters, today) {
  return rows.filter(row => {
    if (filters.status !== 'all' && row.status !== filters.status) return false;
    if (filters.priority === 'none' && row.priority) return false;
    if (!['all', 'none'].includes(filters.priority) && row.priority !== filters.priority) return false;
    if (filters.due === 'empty' && row.due) return false;
    if (filters.due === 'set' && !row.due) return false;
    if (filters.due === 'past' && !(row.due && row.due < today)) return false;
    return true;
  });
}

export function sortRecords(rows, mode) {
  const rank = { P0: 0, P1: 1, P2: 2 };
  return [...rows].sort((a, b) => {
    if (mode === 'created') return (b.created_at || '').localeCompare(a.created_at || '');
    if (mode === 'priority') {
      const difference = (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9);
      if (difference) return difference;
    }
    if (!a.due && !b.due) return (a.created_at || '').localeCompare(b.created_at || '');
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due.localeCompare(b.due) || (a.created_at || '').localeCompare(b.created_at || '');
  });
}

export function changedFields(base, values) {
  const patch = {};
  for (const key of ['content', 'status', 'due', 'priority', 'note']) {
    if ((base[key] || '') !== (values[key] || '')) patch[key] = values[key] || null;
  }
  return patch;
}

export function blankForm() {
  return { content: '', status: '未启动', due: '', priority: '', note: '' };
}
