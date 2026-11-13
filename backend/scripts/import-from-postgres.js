// One-time migration: copies every table (keeping ids) and every file in backend/uploads/
// from the old Postgres database into Convex.
//
//   PG_URL=postgres://postgres:1234@127.0.0.1:5432/supportdesk node scripts/import-from-postgres.js --wipe
//
// --wipe first empties the Convex tables and file storage (required unless Convex is empty).
// Needs the `pg` dev dependency (`npm install` in backend/ installs it).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, callFiles, TABLES } from '../src/db/index.js';
import { storeFileAs } from './lib/store-file.js';

const { default: pg } = await import('pg');
const url = process.env.PG_URL || 'postgres://postgres:1234@127.0.0.1:5432/supportdesk';
const pool = new pg.Pool({ connectionString: url });
// DATE columns come back as local-midnight Dates; keep them as calendar days.
pg.types.setTypeParser(1082, (v) => v);

const local = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function wipe() {
  for (const table of Object.keys(TABLES)) await db.truncate(table);
  while ((await callFiles('mutation', 'removeAll')) > 0);
  console.log('Convex tables and files wiped');
}

async function importTable(table) {
  const meta = TABLES[table];
  const { rows: exists } = await pool.query('SELECT to_regclass($1) AS t', [`public.${table}`]);
  if (!exists[0].t) { console.log(`- ${table}: not in Postgres, skipped`); return; }
  const synthetic = meta.columns.id.synthetic;
  const { rows } = await pool.query(`SELECT * FROM ${table}${synthetic ? '' : ' ORDER BY id'}`);
  const docs = rows.map((r, i) => {
    const doc = {};
    for (const [col, c] of Object.entries(meta.columns)) {
      if (col === 'id' && synthetic) { doc.id = i + 1; continue; }
      let v = r[col];
      if (v === undefined) continue;
      if (c.type === 'date' && v instanceof Date) v = local(v);
      doc[col] = v;
    }
    return doc;
  });
  await db.insertMany(table, docs, { skipRefs: true });
  console.log(`- ${table}: ${docs.length} rows`);
}

async function importUploads() {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../uploads');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  for (const name of files) await storeFileAs(name, fs.readFileSync(path.join(dir, name)));
  console.log(`- uploads: ${files.length} files`);
}

try {
  const existing = await db.count('users');
  if (existing && !process.argv.includes('--wipe')) {
    console.error('Convex already has data. Re-run with --wipe to replace it.');
    process.exit(1);
  }
  if (process.argv.includes('--wipe')) await wipe();
  for (const table of Object.keys(TABLES)) await importTable(table);
  await importUploads();
  console.log('Import complete.');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
