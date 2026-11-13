import { Router } from 'express';
import { db, nowIso } from '../db/index.js';
import { authenticate, requireAgent, requireAdmin, optionalAuth } from '../middleware/auth.js';
import { asyncHandler, notFound, badRequest } from '../utils/errors.js';
import { requireFields, slugify } from '../utils/helpers.js';

const router = Router();

const DEFAULT_SETTINGS = {
  helpdesk: { name: 'Nexus', portal_name: 'Nexus Help Center', support_email: 'support@supportdesk.local', primary_color: '#BF2026', language: 'en', time_zone: 'UTC', portal_signup_enabled: true },
  tickets: { default_priority: 'low', default_status: 'open', auto_close_after_days: 7, archive_after_days: 0, allow_customer_close: true, csat_enabled: true, agent_collision: true },
  notifications: { notify_assignee: true, notify_group_on_new: true, notify_requester_on_reply: true },
  security: { min_password_length: 8, signup_domains: [] },
  forums: { moderate_customer_posts: true },
  arcade: { enabled: true, resolve_points: 10, sla_bonus: 5, fast_reply_bonus: 5, csat_bonus: 15 },
};

const pickDefined = (b, cols) => Object.fromEntries(cols.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));

// Public branding for the login/portal pages.
router.get('/public', optionalAuth, asyncHandler(async (_req, res) => {
  const row = await db.findOne('settings', { key: 'helpdesk' });
  res.json({ data: { ...DEFAULT_SETTINGS.helpdesk, ...(row?.value || {}) } });
}));

router.use(authenticate, requireAgent);

router.get('/', asyncHandler(async (_req, res) => {
  const rows = await db.find('settings', null, { select: ['key', 'value'] });
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = { ...(DEFAULT_SETTINGS[r.key] || {}), ...r.value };
  res.json({ data: out });
}));

router.put('/:key', requireAdmin, asyncHandler(async (req, res) => {
  const key = req.params.key;
  if (!DEFAULT_SETTINGS[key]) throw badRequest('Unknown settings group');
  const existing = await db.findOne('settings', { key });
  const merged = { ...DEFAULT_SETTINGS[key], ...(existing?.value || {}), ...req.body };
  const updatedAt = nowIso();
  await db.upsert('settings', { key }, { key, value: merged, updated_at: updatedAt }, { value: merged, updated_at: updatedAt });
  res.json({ data: merged });
}));

// ---------------- business hours
router.get('/business-hours', asyncHandler(async (_req, res) => {
  res.json({ data: await db.find('business_hours', null, { order: [['is_default', 'desc'], ['name', 'asc']] }) });
}));
router.post('/business-hours', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body;
  requireFields(b, ['name']);
  const row = await db.insert('business_hours', {
    name: b.name, description: b.description || null, time_zone: b.time_zone ?? 'UTC', is_default: b.is_default ?? false,
    always_open: b.always_open ?? false, schedule: b.schedule || {}, holidays: b.holidays || [],
  });
  if (row.is_default) await db.updateWhere('business_hours', { id: { ne: row.id } }, { is_default: false });
  res.status(201).json({ data: row });
}));
router.put('/business-hours/:id', requireAdmin, asyncHandler(async (req, res) => {
  const patch = pickDefined(req.body, ['name', 'description', 'time_zone', 'is_default', 'always_open', 'schedule', 'holidays']);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const [row] = await db.updateWhere('business_hours', { id: req.params.id }, patch);
  if (!row) throw notFound('Business hours');
  if (row.is_default) await db.updateWhere('business_hours', { id: { ne: row.id } }, { is_default: false });
  res.json({ data: row });
}));
router.delete('/business-hours/:id', requireAdmin, asyncHandler(async (req, res) => {
  await db.removeWhere('business_hours', { id: req.params.id, is_default: false });
  res.json({ ok: true });
}));

// ---------------- ticket fields (custom fields)
router.get('/ticket-fields', asyncHandler(async (_req, res) => {
  res.json({ data: await db.find('ticket_fields', null, { order: [['position', 'asc'], ['id', 'asc']] }) });
}));
router.post('/ticket-fields', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body;
  requireFields(b, ['label', 'field_type']);
  const name = slugify(b.name || b.label).replace(/-/g, '_');
  let position = b.position || null;
  if (position === null) {
    const [last] = await db.find('ticket_fields', null, { order: [['position', 'desc']], limit: 1, select: ['position'] });
    position = (last?.position || 0) + 1;
  }
  const row = await db.insert('ticket_fields', {
    name, label: b.label, field_type: b.field_type, options: b.options || [],
    required_for_agents: b.required_for_agents ?? false, required_for_customers: b.required_for_customers ?? false,
    visible_to_customers: b.visible_to_customers ?? true, position, parent_field: b.parent_field || null,
  });
  res.status(201).json({ data: row });
}));
router.put('/ticket-fields/:id', requireAdmin, asyncHandler(async (req, res) => {
  const patch = pickDefined(req.body, ['label', 'field_type', 'options', 'required_for_agents', 'required_for_customers', 'visible_to_customers', 'position', 'parent_field']);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const [row] = await db.updateWhere('ticket_fields', { id: req.params.id }, patch);
  if (!row) throw notFound('Ticket field');
  res.json({ data: row });
}));
router.delete('/ticket-fields/:id', requireAdmin, asyncHandler(async (req, res) => {
  await db.removeWhere('ticket_fields', { id: req.params.id, is_default: false });
  res.json({ ok: true });
}));

export default router;
