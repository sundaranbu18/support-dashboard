import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { TABLES, indexedFields } from './tables.js';

const base = {
  int: v.number(),
  text: v.string(),
  ts: v.string(),
  date: v.string(),
  json: v.string(),
  bool: v.boolean(),
  'text[]': v.array(v.string()),
};

const tables = {};
for (const [name, meta] of Object.entries(TABLES)) {
  const fields = {};
  for (const [col, c] of Object.entries(meta.columns)) {
    fields[col] = c.notNull ? base[c.type] : v.optional(v.union(v.null(), base[c.type]));
  }
  let table = defineTable(fields);
  for (const f of indexedFields(name)) table = table.index(`idx_${f}`, [f]);
  tables[name] = table;
}

// Next numeric id per table (replaces Postgres SERIAL sequences).
tables.counters = defineTable({ table: v.string(), value: v.number() }).index('by_table', ['table']);

// Uploaded files live in Convex file storage; `name` is the public /uploads/<name> path segment.
tables.files = defineTable({
  name: v.string(),
  storage_id: v.id('_storage'),
  content_type: v.optional(v.union(v.null(), v.string())),
  size: v.number(),
  created_at: v.string(),
}).index('by_name', ['name']);

export default defineSchema(tables);
