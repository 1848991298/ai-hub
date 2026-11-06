export function applyOrder(ids, saved) {
  const known = new Set(ids);
  const next = [];
  for (const id of Array.isArray(saved) ? saved : []) {
    if (known.has(id) && !next.includes(id)) next.push(id);
  }
  for (const id of ids) if (!next.includes(id)) next.push(id);
  return next;
}

export function moveItem(order, from, to) {
  if (!from || !to || from === to || !order.includes(from) || !order.includes(to)) return order;
  const next = order.filter(id => id !== from);
  next.splice(next.indexOf(to), 0, from);
  return next;
}
