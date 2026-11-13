import { Router } from 'express';
import { db, indexBy, sortRows } from '../db/index.js';
import { authenticate, requireAgent } from '../middleware/auth.js';
import { asyncHandler, notFound } from '../utils/errors.js';
import { requireFields, toInt } from '../utils/helpers.js';

const router = Router();
router.use(authenticate, requireAgent);

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

router.get('/', asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.q) where.or = [{ title: { icontains: req.query.q } }, { content: { icontains: req.query.q } }];
  if (req.query.folder) where.folder = { eq: req.query.folder };
  const { responses, memberships, users, groups } = await db.fetch({
    responses: ['canned_responses', where],
    memberships: ['group_members', { user_id: req.user.id }, { select: ['group_id'] }],
    users: ['users', null, { select: ['id', 'name'] }],
    groups: ['groups', null, { select: ['id', 'name'] }],
  });
  const myGroups = new Set(memberships.map((m) => m.group_id));
  const userById = indexBy(users);
  const groupById = indexBy(groups);
  // visibility = 'all' OR (personal AND mine) OR (group AND one of my groups)
  const visible = responses.filter((cr) => cr.visibility === 'all'
    || (cr.visibility === 'personal' && cr.user_id === req.user.id)
    || (cr.visibility === 'group' && cr.group_id != null && myGroups.has(cr.group_id)));
  const rows = sortRows(visible, [['folder', 'asc'], ['title', 'asc']]).map((cr) => ({
    ...cr,
    owner_name: userById.get(cr.user_id)?.name ?? null,
    group_name: groupById.get(cr.group_id)?.name ?? null,
  }));
  res.json({ data: rows });
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body;
  requireFields(b, ['title', 'content']);
  const row = await db.insert('canned_responses', {
    title: b.title,
    content: b.content,
    folder: b.folder || 'General',
    visibility: b.visibility || 'all',
    group_id: toInt(b.group_id),
    user_id: req.user.id,
  });
  res.status(201).json({ data: row });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const b = { ...req.body };
  if (b.group_id !== undefined) b.group_id = toInt(b.group_id);
  const patch = pick(b, ['title', 'content', 'folder', 'visibility', 'group_id']);
  if (!Object.keys(patch).length) throw notFound('Nothing to update');
  const row = await db.update('canned_responses', req.params.id, patch);
  if (!row) throw notFound('Canned response');
  res.json({ data: row });
}));

router.post('/:id/use', asyncHandler(async (req, res) => {
  const row = await db.increment('canned_responses', req.params.id, { usage_count: 1 });
  if (!row) throw notFound('Canned response');
  // Placeholder substitution for the ticket context, if provided.
  let content = row.content;
  const ctx = req.body || {};
  for (const [k, v] of Object.entries(ctx)) content = content.replaceAll(`{{${k}}}`, v ?? '');
  res.json({ data: { ...row, content } });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const removed = await db.remove('canned_responses', req.params.id);
  if (!removed) throw notFound('Canned response');
  res.json({ ok: true });
}));

export default router;
