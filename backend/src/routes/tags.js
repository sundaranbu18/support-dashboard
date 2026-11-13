import { Router } from 'express';
import { db } from '../db/index.js';
import { authenticate, requireAgent } from '../middleware/auth.js';
import { asyncHandler, notFound } from '../utils/errors.js';
import { requireFields } from '../utils/helpers.js';

const router = Router();
router.use(authenticate, requireAgent);

// Rewrites the tags array of every ticket carrying `name` (array_replace / array_remove), plus any leading ops, in atomic chunks.
async function rewriteTicketTags(name, mapTags, leadingOps = []) {
  const tickets = await db.find('tickets', { tags: { contains: name } }, { select: ['id', 'tags'] });
  const ops = [
    ...leadingOps,
    ...tickets.map((t) => ({ op: 'update', table: 'tickets', where: { id: t.id }, patch: { tags: mapTags(t.tags || []) } })),
  ];
  const results = [];
  for (let i = 0; i < ops.length; i += 200) results.push(...(await db.batch(ops.slice(i, i + 200))));
  return results;
}

router.get('/', asyncHandler(async (_req, res) => {
  const { tags, tickets } = await db.fetch({
    tags: ['tags', null, { order: [['name', 'asc']] }],
    tickets: ['tickets', { deleted: false }, { select: ['tags'] }],
  });
  const counts = new Map();
  for (const t of tickets) for (const name of new Set(t.tags || [])) counts.set(name, (counts.get(name) || 0) + 1);
  res.json({ data: tags.map((tg) => ({ ...tg, ticket_count: counts.get(tg.name) || 0 })) });
}));

router.post('/', asyncHandler(async (req, res) => {
  requireFields(req.body, ['name']);
  const name = String(req.body.name).trim().toLowerCase();
  const color = req.body.color || null;
  // ON CONFLICT (name) DO UPDATE SET color = COALESCE(new, old)
  const { row } = await db.upsert('tags', { name }, { name, color: color || '#6366f1' }, color ? { color } : undefined);
  res.status(201).json({ data: row });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const old = await db.get('tags', req.params.id);
  if (!old) throw notFound('Tag');
  const name = req.body.name ? String(req.body.name).toLowerCase().trim() : old.name;
  const patch = { name };
  if (req.body.color) patch.color = req.body.color;
  const updateTag = { op: 'update', table: 'tags', where: { id: old.id }, patch };
  let row;
  if (name !== old.name) {
    [[row]] = await rewriteTicketTags(old.name, (tags) => tags.map((t) => (t === old.name ? name : t)), [updateTag]);
  } else {
    row = await db.update('tags', old.id, patch);
  }
  res.json({ data: row });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const tag = await db.get('tags', req.params.id);
  if (!tag) throw notFound('Tag');
  const [removed] = await rewriteTicketTags(tag.name, (tags) => tags.filter((t) => t !== tag.name), [
    { op: 'remove', table: 'tags', where: { id: tag.id } },
  ]);
  if (!removed) throw notFound('Tag');
  res.json({ ok: true });
}));

export default router;
