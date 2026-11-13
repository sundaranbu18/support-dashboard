// Data access for the Nexus API. All data lives in Convex (see backend/convex/db.js).
//
//   import { db } from '../db/index.js';
//
//   await db.get('tickets', id)                        -> row | null
//   await db.find('tickets', where, { order, limit, offset, select })  -> rows
//   await db.findOne('users', { email: { ieq: email } })               -> row | null
//   await db.count('tickets', where)                   -> number
//   await db.fetch({ t: ['tickets', where, opts], u: ['users'] })      -> { t: rows, u: rows }  (one round trip)
//   await db.insert('tickets', doc)                    -> inserted row (with id + defaults)
//   await db.insertMany('tags', docs)                  -> rows
//   await db.update('tickets', id, patch, { inc })     -> updated row | null
//   await db.updateWhere('tickets', where, patch, { inc }) -> updated rows
//   await db.increment('kb_articles', id, { views: 1 })    -> updated row | null
//   await db.remove('tickets', id)                     -> number of rows deleted (cascades like Postgres)
//   await db.removeWhere('group_members', where)       -> number deleted
//   await db.upsert('settings', { key }, doc, patch?)  -> { row, inserted }  (patch omitted = ON CONFLICT DO NOTHING)
//   await db.batch([{ op: 'insert', table, doc }, { op: 'update', table, where, patch }, ...]) -> results (atomic)
//
// Row shape matches the old Postgres rows: numeric `id`, snake_case columns, ISO-string
// timestamps, 'YYYY-MM-DD' dates, arrays for TEXT[] columns, parsed objects for JSON columns.
// Values are coerced to the column type on the way in (numeric strings -> numbers, Dates -> ISO).
// Where-clause syntax is documented in backend/convex/where.js.
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { env } from '../config/env.js';
import { TABLES } from '../../convex/tables.js';
import { matches, sortRows } from '../../convex/where.js';

export { matches, sortRows, TABLES };

let client;
function convex() {
  if (!client) {
    if (!env.convexUrl) throw new Error('CONVEX_URL is not set');
    if (!env.convexSecret) throw new Error('NEXUS_SERVER_SECRET is not set');
    client = new ConvexHttpClient(env.convexUrl);
  }
  return client;
}

// Convex errors carry the old Postgres SQLSTATE codes so errorHandler keeps mapping them to 409/400.
function mapError(err) {
  const data = err?.data;
  if (data && typeof data === 'object' && data.code) {
    const e = new Error(data.message || 'Database error');
    e.code = data.code;
    e.detail = data.message;
    return e;
  }
  return err;
}
// DB_TRACE=1 logs every Convex call with its duration (useful for spotting round trips).
const trace = (fn, args, started) => {
  if (process.env.DB_TRACE) console.log(`[db] ${fn} ${args.table || (args.requests || args.ops || []).map((r) => r.key || `${r.op}:${r.table}`).join(',')} ${Date.now() - started}ms`);
};
async function q(fn, args) {
  const started = Date.now();
  try { return await convex().query(anyApi.db[fn], { secret: env.convexSecret, ...args }); } catch (err) { throw mapError(err); } finally { trace(fn, args, started); }
}
async function m(fn, args) {
  const started = Date.now();
  try { return await convex().mutation(anyApi.db[fn], { secret: env.convexSecret, ...args }, { skipQueue: true }); } catch (err) { throw mapError(err); } finally { trace(fn, args, started); }
}
export async function callFiles(kind, fn, args = {}) {
  const c = convex();
  const call = kind === 'query' ? c.query.bind(c) : (ref, a) => c.mutation(ref, a, { skipQueue: true });
  try { return await call(anyApi.files[fn], { secret: env.convexSecret, ...args }); } catch (err) { throw mapError(err); }
}

// ------------------------------------------------------------------ encoding
function meta(table) {
  const t = TABLES[table];
  if (!t) throw new Error(`Unknown table "${table}"`);
  return t;
}

function toIso(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) { const e = new Error(`Invalid timestamp "${v}"`); e.code = '22P02'; throw e; }
  return d.toISOString();
}
function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return toIso(v).slice(0, 10);
}

// Coerces one value to a column type (used for documents and where-clauses).
function coerce(type, v, col) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  switch (type) {
    case 'int': {
      if (v === '') return null;
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) { const e = new Error(`Invalid integer for ${col}: "${v}"`); e.code = '22P02'; throw e; }
      return Math.trunc(n);
    }
    case 'bool': return typeof v === 'boolean' ? v : ['true', '1', 'yes', 'on', 't'].includes(String(v).toLowerCase());
    case 'ts': return toIso(v);
    case 'date': return toDate(v);
    case 'json': return typeof v === 'string' ? v : JSON.stringify(v);
    case 'text[]': return (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined).map(String);
    default: return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

function encodeDoc(table, doc) {
  const t = meta(table);
  const out = {};
  for (const [k, v] of Object.entries(doc || {})) {
    const c = t.columns[k];
    if (!c) throw Object.assign(new Error(`Unknown column ${table}.${k}`), { code: '42703' });
    const val = coerce(c.type, v, `${table}.${k}`);
    if (val !== undefined) out[k] = val;
  }
  return out;
}

const OPS_SCALAR = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
function encodeWhere(table, where) {
  if (where === null || where === undefined) return undefined;
  const t = meta(table);
  const out = {};
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === 'or' || k === 'and') { out[k] = cond.map((w) => encodeWhere(table, w) || {}); continue; }
    if (k === 'not') { out[k] = encodeWhere(table, cond) || {}; continue; }
    const c = t.columns[k];
    if (!c) throw Object.assign(new Error(`Unknown column ${table}.${k}`), { code: '42703' });
    // Array columns compare against their element type (text). A date-only value for a timestamp
    // column means local midnight, like Postgres casting 'YYYY-MM-DD' in the server time zone.
    const elemType = c.type === 'text[]' || c.type === 'json' ? 'text' : c.type;
    const one = (v) => (v === null ? null : c.type === 'ts' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`).toISOString() : coerce(elemType, v, `${table}.${k}`));
    if (Array.isArray(cond)) { out[k] = { in: cond.map(one) }; continue; }
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const ops = {};
      for (const [op, arg] of Object.entries(cond)) {
        if (arg === undefined) continue;
        if (op === 'in' || op === 'nin' || op === 'overlaps') ops[op] = (arg || []).map(one);
        else if (OPS_SCALAR.includes(op) || op === 'contains') ops[op] = one(arg);
        else if (op === 'icontains' || op === 'ieq') ops[op] = String(arg);
        else if (op === 'isNull') ops[op] = Boolean(arg);
        else throw new Error(`Unknown where operator "${op}"`);
      }
      out[k] = ops;
      continue;
    }
    out[k] = one(cond);
  }
  return out;
}

// `partial` (rows from a `select`) only decodes the keys present instead of filling every column.
function decodeRow(table, row, partial = false) {
  if (!row) return row;
  const t = meta(table);
  const out = { ...row };
  for (const [k, c] of Object.entries(t.columns)) {
    if (partial && !(k in out)) continue;
    if (c.type === 'json' && typeof out[k] === 'string') {
      try { out[k] = JSON.parse(out[k]); } catch { /* leave as text */ }
    }
    if (out[k] === undefined) out[k] = null;
  }
  return out;
}
const decodeRows = (table, rows, partial = false) => rows.map((r) => decodeRow(table, r, partial));

function encodeOpts(opts = {}) {
  const o = {};
  if (opts.order) o.order = opts.order;
  if (opts.limit != null) o.limit = Number(opts.limit);
  if (opts.offset) o.offset = Number(opts.offset);
  if (opts.select) o.select = opts.select;
  return o;
}

const idWhere = (table, id) => {
  const n = Number(id);
  return Number.isInteger(n) ? { id: n } : null;
};

// ------------------------------------------------------------------ API
export const db = {
  async get(table, id) {
    const where = idWhere(table, id);
    if (!where) return null;
    return decodeRow(table, await q('get', { table, id: where.id }));
  },
  async find(table, where, opts) {
    const rows = await q('find', { table, where: encodeWhere(table, where), ...encodeOpts(opts) });
    return decodeRows(table, rows, Boolean(opts?.select));
  },
  async findOne(table, where, opts = {}) {
    const [row] = await db.find(table, where, { ...opts, limit: 1 });
    return row || null;
  },
  async all(table, opts) {
    return db.find(table, undefined, opts);
  },
  async count(table, where) {
    return q('count', { table, where: encodeWhere(table, where) });
  },
  // requests: { key: [table, where?, opts?] } or { key: { table, where, ...opts } }
  async fetch(requests) {
    const list = Object.entries(requests).map(([key, r]) => {
      const [table, where, opts] = Array.isArray(r) ? r : [r.table, r.where, r];
      return { key, table, where: encodeWhere(table, where), ...encodeOpts(opts) };
    });
    const res = await q('fetchMany', { requests: list });
    const out = {};
    for (const { key, table, select } of list) out[key] = decodeRows(table, res[key], Boolean(select));
    return out;
  },
  async insert(table, doc) {
    const [row] = await m('insert', { table, docs: [encodeDoc(table, doc)] });
    return decodeRow(table, row);
  },
  // { skipRefs: true } skips foreign-key checks (bulk imports only).
  async insertMany(table, docs, { skipRefs } = {}) {
    if (!docs.length) return [];
    const out = [];
    for (let i = 0; i < docs.length; i += 200) {
      out.push(...(await m('insert', { table, docs: docs.slice(i, i + 200).map((d) => encodeDoc(table, d)), ...(skipRefs ? { skipRefs: true } : {}) })));
    }
    return decodeRows(table, out);
  },
  async update(table, id, patch = {}, { inc } = {}) {
    const where = idWhere(table, id);
    if (!where) return null;
    const [row] = await db.updateWhere(table, where, patch, { inc });
    return row || null;
  },
  async updateWhere(table, where, patch = {}, { inc } = {}) {
    const rows = await m('update', { table, where: encodeWhere(table, where) || {}, patch: encodeDoc(table, patch), inc: inc ? encodeDoc(table, inc) : undefined });
    return decodeRows(table, rows);
  },
  async increment(table, id, inc) {
    return db.update(table, id, {}, { inc });
  },
  async remove(table, id) {
    const where = idWhere(table, id);
    if (!where) return 0;
    return m('remove', { table, where });
  },
  async removeWhere(table, where) {
    return m('remove', { table, where: encodeWhere(table, where) || {} });
  },
  async upsert(table, where, doc, patch) {
    const res = await m('upsert', { table, where: encodeWhere(table, where), doc: encodeDoc(table, doc), patch: patch ? encodeDoc(table, patch) : undefined });
    return { row: decodeRow(table, res.row), inserted: res.inserted };
  },
  async batch(ops) {
    const encoded = ops.map((o) => ({
      op: o.op,
      table: o.table,
      ...(o.doc ? { doc: encodeDoc(o.table, o.doc) } : {}),
      ...(o.where ? { where: encodeWhere(o.table, o.where) } : {}),
      ...(o.patch ? { patch: encodeDoc(o.table, o.patch) } : {}),
      ...(o.inc ? { inc: encodeDoc(o.table, o.inc) } : {}),
    }));
    const res = await m('batch', { ops: encoded });
    return res.map((r, i) => {
      const t = ops[i].table;
      if (Array.isArray(r)) return decodeRows(t, r);
      if (r && typeof r === 'object' && 'inserted' in r) return { row: decodeRow(t, r.row), inserted: r.inserted };
      if (r && typeof r === 'object') return decodeRow(t, r);
      return r;
    });
  },
  async truncate(table) {
    let n;
    do { n = await m('truncateAll', { table }); } while (n >= 4000);
  },
  async ping() {
    await q('count', { table: 'settings' });
  },
};

// ------------------------------------------------------------------ helpers for route code
export const nowIso = () => new Date().toISOString();
export const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
export const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
export const indexBy = (rows, key = 'id') => new Map(rows.map((r) => [r[key], r]));
export function groupBy(rows, key) {
  const map = new Map();
  for (const r of rows) {
    const k = typeof key === 'function' ? key(r) : r[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}
export const countBy = (rows, key) => {
  const out = {};
  for (const r of rows) { const k = typeof key === 'function' ? key(r) : r[key]; out[k] = (out[k] || 0) + 1; }
  return out;
};
export const uniq = (arr) => [...new Set(arr.filter((x) => x !== null && x !== undefined))];
export const sum = (rows, f) => rows.reduce((s, r) => s + (Number(typeof f === 'function' ? f(r) : r[f]) || 0), 0);
// Local calendar day (server time zone), like Postgres CURRENT_DATE / ::date.
export const localDay = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const paginate = (rows, offset, limit) => rows.slice(offset, offset + limit);
