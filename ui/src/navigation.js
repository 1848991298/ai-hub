export function readRoute(hash) {
  const value = hash.replace(/^#/, '');
  const split = value.indexOf('?');
  const name = split < 0 ? value : value.slice(0, split);
  const query = split < 0 ? '' : value.slice(split + 1);
  return { page: name === 'clients' ? 'skills' : name, params: Object.fromEntries(new URLSearchParams(query)) };
}

export function routeHash(page, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value)).toString();
  return '#' + page + (query ? '?' + query : '');
}
