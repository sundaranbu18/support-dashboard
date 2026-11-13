import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAdmin } from '../middleware/auth.js';
import { asyncHandler, notFound, badRequest } from './errors.js';
import { requireFields } from './helpers.js';

// "position, id" / "audience DESC, key" -> [['position','asc'], ['id','asc']]
const parseOrder = (orderBy) => orderBy.split(',').map((part) => {
  const [col, dir] = part.trim().split(/\s+/);
  return [col, (dir || 'asc').toLowerCase()];
});

// Small list/create/update/delete router for admin-managed config tables.
// `fields` is the column allow-list. JSON columns are encoded by the data layer (`json` is kept for compatibility).
export function crudRouter({ table, fields, required = [], orderBy = 'id', idColumn = 'id', label = 'Record', beforeSave, afterChange, canDelete }) {
  const router = Router();
  const order = parseOrder(orderBy);
  const encode = async (req) => {
    const b = { ...req.body };
    if (beforeSave) await beforeSave(b, req);
    for (const k of fields) if (b[k] === '') b[k] = null;
    return b;
  };
  const pickFields = (b, cols) => Object.fromEntries(cols.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
  const whereId = (id) => ({ [idColumn]: id });

  router.get('/', asyncHandler(async (_req, res) => {
    res.json({ data: await db.find(table, null, { order }) });
  }));
  router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    requireFields(req.body, required);
    const b = await encode(req);
    const row = await db.insert(table, pickFields(b, [...fields, ...(idColumn !== 'id' ? [idColumn] : [])]));
    if (afterChange) await afterChange(row);
    res.status(201).json({ data: row });
  }));
  router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const b = await encode(req);
    const patch = pickFields(b, fields);
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');
    const [row] = await db.updateWhere(table, whereId(req.params.id), patch);
    if (!row) throw notFound(label);
    if (afterChange) await afterChange(row);
    res.json({ data: row });
  }));
  router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    if (canDelete) await canDelete(req.params.id);
    const removed = await db.removeWhere(table, whereId(req.params.id));
    if (!removed) throw notFound(label);
    if (afterChange) await afterChange(null);
    res.json({ ok: true });
  }));
  return router;
}
