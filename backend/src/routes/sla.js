import { Router } from 'express';
import { db, countBy } from '../db/index.js';
import { authenticate, requireAgent, requireAdmin } from '../middleware/auth.js';
import { asyncHandler, notFound, badRequest } from '../utils/errors.js';
import { requireFields, pick } from '../utils/helpers.js';
import { DEFAULT_TARGETS } from '../utils/sla.js';

const router = Router();
router.use(authenticate, requireAgent);

router.get('/', asyncHandler(async (_req, res) => {
  const { policies, tickets } = await db.fetch({
    policies: ['sla_policies', null, { order: [['is_default', 'asc'], ['position', 'asc'], ['id', 'asc']] }],
    tickets: ['tickets', { deleted: false, sla_policy_id: { isNull: false } }, { select: ['sla_policy_id'] }],
  });
  const counts = countBy(tickets, 'sla_policy_id');
  res.json({ data: policies.map((p) => ({ ...p, ticket_count: counts[p.id] || 0 })), defaults: DEFAULT_TARGETS });
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body;
  requireFields(b, ['name']);
  let position = b.position || null;
  if (position === null) {
    const all = await db.all('sla_policies');
    position = all.reduce((max, r) => Math.max(max, r.position ?? 0), 0) + 1;
  }
  const row = await db.insert('sla_policies', {
    name: b.name,
    description: b.description || null,
    is_active: b.is_active ?? true,
    position,
    conditions: b.conditions || {},
    targets: b.targets || DEFAULT_TARGETS,
  });
  res.status(201).json({ data: row });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body;
  const existing = await db.findOne('sla_policies', { id: req.params.id });
  if (!existing) throw notFound('SLA policy');
  if (existing.is_default && b.is_active === false) throw badRequest('The default policy cannot be deactivated');
  const patch = pick(b, ['name', 'description', 'is_active', 'position', 'conditions', 'targets']);
  if (!Object.keys(patch).length) return res.json({ data: existing });
  const [row] = await db.updateWhere('sla_policies', { id: req.params.id }, patch);
  res.json({ data: row });
}));

router.post('/reorder', requireAdmin, asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length) await db.batch(ids.map((id, i) => ({ op: 'update', table: 'sla_policies', where: { id }, patch: { position: i + 1 } })));
  res.json({ ok: true });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const policy = await db.findOne('sla_policies', { id: req.params.id });
  if (!policy) throw notFound('SLA policy');
  if (policy.is_default) throw badRequest('The default policy cannot be deleted');
  await db.removeWhere('sla_policies', { id: req.params.id });
  res.json({ ok: true });
}));

export default router;
