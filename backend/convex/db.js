// Generic, table-driven data access for the Nexus API server.
//
// The Node service (backend/src/db/index.js) is the only caller. Every function requires
// `secret`, which must equal the NEXUS_SERVER_SECRET environment variable of this Convex
// deployment, so the functions cannot be called from a browser.
//
// Rows keep the original relational shape: a numeric `id`, snake_case columns, foreign keys
// as numeric ids, timestamps as ISO strings and JSON columns stored as JSON strings
// (the Node layer encodes/decodes them). Unique constraints and ON DELETE CASCADE / SET NULL
// from the old Postgres schema are enforced here, inside a single transaction.
import { query, mutation } from './_generated/server';
import { v, ConvexError } from 'convex/values';
import { TABLES, indexedFields, referencesTo } from './tables.js';
import { matches, sortRows, indexableEquality } from './where.js';

const nowIso = () => new Date().toISOString();

function checkSecret(secret) {
  const expected = process.env.NEXUS_SERVER_SECRET;
  if (!expected || secret !== expected) throw new ConvexError({ code: 'UNAUTHORIZED', message: 'Invalid server secret' });
}
function meta(table) {
  const t = TABLES[table];
  if (!t) throw new ConvexError({ code: 'BAD_TABLE', message: `Unknown table "${table}"` });
  return t;
}
const strip = (doc) => {
  if (!doc) return null;
  const { _id, _creationTime, ...row } = doc;
  return row;
};

async function scan(ctx, table, where) {
  meta(table);
  const idx = indexableEquality(where, indexedFields(table));
  let docs;
  if (idx) {
    docs = [];
    const seen = new Set();
    for (const value of idx.values) {
      const found = await ctx.db.query(table).withIndex(`idx_${idx.field}`, (q) => q.eq(idx.field, value)).collect();
      for (const d of found) if (!seen.has(d._id)) { seen.add(d._id); docs.push(d); }
    }
  } else {
    docs = await ctx.db.query(table).collect();
  }
  return docs.filter((d) => matches(d, where));
}

function shape(rows, { order, offset, limit, select } = {}) {
  let out = sortRows(rows.map(strip), order);
  if (offset) out = out.slice(offset);
  if (limit != null) out = out.slice(0, limit);
  if (select) out = out.map((r) => Object.fromEntries(select.map((k) => [k, r[k] ?? null])));
  return out;
}

async function getById(ctx, table, id) {
  meta(table);
  if (typeof id !== 'number' || !Number.isFinite(id)) return null;
  return ctx.db.query(table).withIndex('idx_id', (q) => q.eq('id', id)).unique();
}

// ------------------------------------------------------------------ validation
function validate(table, row) {
  const t = meta(table);
  for (const [col, c] of Object.entries(t.columns)) {
    const val = row[col];
    if (c.notNull && (val === null || val === undefined)) {
      throw new ConvexError({ code: '23502', message: `${table}.${col} is required` });
    }
    if (c.enum && val != null && !c.enum.includes(val)) {
      throw new ConvexError({ code: '23514', message: `Invalid value "${val}" for ${table}.${col}` });
    }
  }
}

async function checkUnique(ctx, table, row, selfId) {
  for (const cols of meta(table).unique) {
    if (cols.some((c) => row[c] === null || row[c] === undefined)) continue;
    const [first, ...rest] = cols;
    const candidates = await ctx.db.query(table).withIndex(`idx_${first}`, (q) => q.eq(first, row[first])).collect();
    if (candidates.some((d) => d._id !== selfId && rest.every((c) => d[c] === row[c]))) {
      throw new ConvexError({ code: '23505', message: `A ${table} record with that ${cols.join(' + ')} already exists` });
    }
  }
}

// Foreign keys must point at an existing row (Postgres error 23503).
async function checkRefs(ctx, table, row, keys) {
  const cols = meta(table).columns;
  for (const k of keys) {
    const ref = cols[k]?.ref;
    if (!ref || row[k] === null || row[k] === undefined) continue;
    if (ref.table === table && row[k] === row.id) continue;
    const target = await ctx.db.query(ref.table).withIndex('idx_id', (q) => q.eq('id', row[k])).first();
    if (!target) throw new ConvexError({ code: '23503', message: `${table}.${k} references a missing ${ref.table} record (${row[k]})` });
  }
}

async function nextId(ctx, table, explicit) {
  const counter = await ctx.db.query('counters').withIndex('by_table', (q) => q.eq('table', table)).unique();
  const current = counter ? counter.value : 0;
  const id = explicit ?? current + 1;
  if (!counter) await ctx.db.insert('counters', { table, value: Math.max(current, id) });
  else if (id > current) await ctx.db.patch(counter._id, { value: id });
  return id;
}

function withDefaults(table, doc) {
  const row = {};
  for (const [col, c] of Object.entries(meta(table).columns)) {
    let val = doc[col];
    if (val === undefined || (val === null && c.notNull && c.default !== undefined)) {
      if (c.default === '$now') val = nowIso();
      else if (c.default !== undefined) val = c.type === 'json' ? JSON.stringify(c.default) : Array.isArray(c.default) ? [...c.default] : c.default;
      else val = null;
    }
    row[col] = val;
  }
  for (const k of Object.keys(doc)) {
    if (!(k in row)) throw new ConvexError({ code: '42703', message: `Unknown column ${table}.${k}` });
  }
  return row;
}

async function insertRow(ctx, table, doc, skipRefs = false) {
  const row = withDefaults(table, doc);
  row.id = await nextId(ctx, table, doc.id ?? undefined);
  validate(table, row);
  if (!skipRefs) await checkRefs(ctx, table, row, Object.keys(row));
  await checkUnique(ctx, table, row, null);
  await ctx.db.insert(table, row);
  return row;
}

async function updateRows(ctx, table, where, patch = {}, inc = {}) {
  const t = meta(table);
  for (const k of [...Object.keys(patch), ...Object.keys(inc)]) {
    if (!t.columns[k]) throw new ConvexError({ code: '42703', message: `Unknown column ${table}.${k}` });
  }
  const docs = await scan(ctx, table, where);
  const out = [];
  for (const doc of docs) {
    const changes = { ...patch };
    for (const [k, n] of Object.entries(inc)) changes[k] = (doc[k] || 0) + n;
    if (t.touchUpdatedAt && changes.updated_at === undefined) changes.updated_at = nowIso();
    const next = { ...doc, ...changes };
    validate(table, next);
    await checkRefs(ctx, table, next, Object.keys(changes));
    if (t.unique.some((cols) => cols.some((c) => c in changes))) await checkUnique(ctx, table, next, doc._id);
    await ctx.db.patch(doc._id, changes);
    out.push(strip(next));
  }
  return out;
}

async function deleteDocs(ctx, table, docs) {
  if (!docs.length) return 0;
  const ids = docs.map((d) => d.id);
  const idSet = new Set(ids);
  for (const [child, col, onDelete] of referencesTo(table)) {
    if (onDelete !== 'CASCADE' && onDelete !== 'SET NULL') continue;
    const children = (await scan(ctx, child, { [col]: { in: ids.length <= 50 ? ids : undefined } })).filter((d) => idSet.has(d[col]));
    if (!children.length) continue;
    if (onDelete === 'CASCADE') await deleteDocs(ctx, child, children);
    else for (const d of children) {
      const fresh = await ctx.db.get(d._id);
      if (fresh) await ctx.db.patch(d._id, { [col]: null });
    }
  }
  let n = 0;
  for (const d of docs) {
    if (await ctx.db.get(d._id)) { await ctx.db.delete(d._id); n++; }
  }
  return n;
}

async function upsertRow(ctx, table, where, doc, patch) {
  const [existing] = await scan(ctx, table, where);
  if (existing) {
    if (patch && Object.keys(patch).length) {
      const [row] = await updateRows(ctx, table, { id: existing.id }, patch);
      return { row, inserted: false };
    }
    return { row: strip(existing), inserted: false };
  }
  return { row: await insertRow(ctx, table, doc), inserted: true };
}

// ------------------------------------------------------------------ public functions
const anyObj = v.optional(v.any());
const findArgs = { table: v.string(), where: anyObj, order: anyObj, limit: v.optional(v.number()), offset: v.optional(v.number()), select: v.optional(v.array(v.string())) };

export const get = query({
  args: { secret: v.string(), table: v.string(), id: v.any() },
  handler: async (ctx, { secret, table, id }) => {
    checkSecret(secret);
    return strip(await getById(ctx, table, id));
  },
});

export const find = query({
  args: { secret: v.string(), ...findArgs },
  handler: async (ctx, { secret, table, where, ...opts }) => {
    checkSecret(secret);
    return shape(await scan(ctx, table, where), opts);
  },
});

export const count = query({
  args: { secret: v.string(), table: v.string(), where: anyObj },
  handler: async (ctx, { secret, table, where }) => {
    checkSecret(secret);
    return (await scan(ctx, table, where)).length;
  },
});

// Several reads in one round trip and one consistent snapshot.
export const fetchMany = query({
  args: { secret: v.string(), requests: v.array(v.object({ key: v.string(), ...findArgs })) },
  handler: async (ctx, { secret, requests }) => {
    checkSecret(secret);
    const out = {};
    for (const { key, table, where, ...opts } of requests) out[key] = shape(await scan(ctx, table, where), opts);
    return out;
  },
});

export const insert = mutation({
  // skipRefs: bulk loads (data import) where referenced rows arrive later.
  args: { secret: v.string(), table: v.string(), docs: v.array(v.any()), skipRefs: v.optional(v.boolean()) },
  handler: async (ctx, { secret, table, docs, skipRefs }) => {
    checkSecret(secret);
    const out = [];
    for (const doc of docs) out.push(await insertRow(ctx, table, doc, skipRefs));
    return out;
  },
});

export const update = mutation({
  args: { secret: v.string(), table: v.string(), where: v.any(), patch: anyObj, inc: anyObj },
  handler: async (ctx, { secret, table, where, patch, inc }) => {
    checkSecret(secret);
    return updateRows(ctx, table, where, patch || {}, inc || {});
  },
});

export const remove = mutation({
  args: { secret: v.string(), table: v.string(), where: v.any() },
  handler: async (ctx, { secret, table, where }) => {
    checkSecret(secret);
    return deleteDocs(ctx, table, await scan(ctx, table, where));
  },
});

export const upsert = mutation({
  args: { secret: v.string(), table: v.string(), where: v.any(), doc: v.any(), patch: anyObj },
  handler: async (ctx, { secret, table, where, doc, patch }) => {
    checkSecret(secret);
    return upsertRow(ctx, table, where, doc, patch);
  },
});

// Runs several writes atomically, in order. ops: [{ op: 'insert'|'update'|'remove'|'upsert', table, ... }]
export const batch = mutation({
  args: { secret: v.string(), ops: v.array(v.any()) },
  handler: async (ctx, { secret, ops }) => {
    checkSecret(secret);
    const results = [];
    for (const o of ops) {
      if (o.op === 'insert') results.push(await insertRow(ctx, o.table, o.doc));
      else if (o.op === 'update') results.push(await updateRows(ctx, o.table, o.where, o.patch || {}, o.inc || {}));
      else if (o.op === 'remove') results.push(await deleteDocs(ctx, o.table, await scan(ctx, o.table, o.where)));
      else if (o.op === 'upsert') results.push(await upsertRow(ctx, o.table, o.where, o.doc, o.patch));
      else throw new ConvexError({ code: 'BAD_OP', message: `Unknown op ${o.op}` });
    }
    return results;
  },
});

// Wipes every application table (used by `npm run db:reset`).
export const truncateAll = mutation({
  args: { secret: v.string(), table: v.string() },
  handler: async (ctx, { secret, table }) => {
    checkSecret(secret);
    const docs = await ctx.db.query(table).take(4000);
    for (const d of docs) await ctx.db.delete(d._id);
    if (docs.length < 4000) {
      const counter = await ctx.db.query('counters').withIndex('by_table', (q) => q.eq('table', table)).unique();
      if (counter) await ctx.db.delete(counter._id);
    }
    return docs.length;
  },
});
