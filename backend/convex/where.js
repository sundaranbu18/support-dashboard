// Row filtering and sorting shared by the Convex functions and the Node API.
//
// A `where` is an object of column conditions, all of which must hold:
//   { status: 'open' }                      equality (null matches null)
//   { status: { in: ['open', 'pending'] } } membership (include null to also match NULL)
//   { status: { nin: [...] } }              SQL NOT IN (NULL never matches)
//   { responder_id: { ne: 5 } }             SQL <> (NULL never matches)
//   { due_by: { lt: '2026-01-01T00:00:00.000Z' } }  gt / gte / lt / lte (NULL never matches)
//   { tags: { contains: 'vip' } }           array column contains a value
//   { tags: { overlaps: ['a', 'b'] } }      array column shares a value
//   { subject: { icontains: 'refund' } }    case-insensitive substring (ILIKE '%x%')
//   { email: { ieq: 'A@B.com' } }           case-insensitive equality
//   { closed_at: { isNull: true } }         IS NULL / IS NOT NULL (false)
//   { or: [whereA, whereB] }, { and: [...] }, { not: where }
// An array value is shorthand for { in: [...] }. Several operators on one column are ANDed.

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
const same = (a, b) => (a === null || a === undefined ? b === null || b === undefined : a === b);

function test(val, op, arg) {
  switch (op) {
    case 'eq': return same(val, arg);
    case 'ne': return arg === null ? val != null : val != null && val !== arg;
    case 'in': return arg.some((x) => same(val, x));
    case 'nin': return val != null && !arg.includes(val);
    case 'gt': return val != null && cmp(val, arg) > 0;
    case 'gte': return val != null && cmp(val, arg) >= 0;
    case 'lt': return val != null && cmp(val, arg) < 0;
    case 'lte': return val != null && cmp(val, arg) <= 0;
    case 'contains': return Array.isArray(val) && val.includes(arg);
    case 'overlaps': return Array.isArray(val) && arg.some((x) => val.includes(x));
    case 'icontains': return val != null && String(val).toLowerCase().includes(String(arg).toLowerCase());
    case 'ieq': return val != null && String(val).toLowerCase() === String(arg).toLowerCase();
    case 'isNull': return arg ? val == null : val != null;
    default: throw new Error(`Unknown where operator "${op}"`);
  }
}

export function matches(row, where) {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'or') { if (!cond.some((w) => matches(row, w))) return false; continue; }
    if (key === 'and') { if (!cond.every((w) => matches(row, w))) return false; continue; }
    if (key === 'not') { if (matches(row, cond)) return false; continue; }
    const val = row[key];
    if (Array.isArray(cond)) { if (!test(val, 'in', cond)) return false; continue; }
    if (isPlainObject(cond)) {
      for (const [op, arg] of Object.entries(cond)) if (arg !== undefined && !test(val, op, arg)) return false;
      continue;
    }
    if (!same(val, cond)) return false;
  }
  return true;
}

// order: 'col' | ['col', 'desc'] | [['col', 'desc'], ['id', 'asc']]
// Like Postgres: NULLs sort last ascending and first descending.
export function normalizeOrder(order) {
  if (!order) return [];
  if (typeof order === 'string') return [[order, 'asc']];
  if (order.length && typeof order[0] === 'string') return [[order[0], order[1] || 'asc']];
  return order.map((o) => (typeof o === 'string' ? [o, 'asc'] : [o[0], o[1] || 'asc']));
}

// Ties fall back to `id` in the direction of the first sort key: timestamps only keep
// milliseconds (Postgres kept microseconds), so this preserves insertion order for equal times.
export function sortRows(rows, order) {
  const spec = normalizeOrder(order);
  if (!spec.length) return rows;
  if (!spec.some(([col]) => col === 'id')) spec.push(['id', spec[0][1]]);
  return rows.sort((a, b) => {
    for (const [col, dir] of spec) {
      const x = a[col], y = b[col];
      const desc = String(dir).toLowerCase() === 'desc';
      if (x == null && y == null) continue;
      if (x == null) return desc ? -1 : 1;
      if (y == null) return desc ? 1 : -1;
      const c = cmp(x, y);
      if (c) return desc ? -c : c;
    }
    return 0;
  });
}

// Equality conditions usable for an index lookup: { field: value }.
export function indexableEquality(where, indexedFields) {
  if (!where) return null;
  for (const [key, cond] of Object.entries(where)) {
    if (!indexedFields.includes(key) || cond === undefined) continue;
    if (cond === null || typeof cond !== 'object') return { field: key, values: [cond] };
    if (Array.isArray(cond) && cond.length <= 50) return { field: key, values: cond };
    if (isPlainObject(cond) && Object.keys(cond).length === 1) {
      if ('eq' in cond) return { field: key, values: [cond.eq] };
      if (Array.isArray(cond.in) && cond.in.length <= 50) return { field: key, values: cond.in };
    }
  }
  return null;
}
