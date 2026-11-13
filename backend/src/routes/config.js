import { Router } from 'express';
import crypto from 'node:crypto';
import { db, indexBy, nowIso } from '../db/index.js';
import { authenticate, requireAgent, requireAdmin, optionalAuth, ALL_PRIVILEGES } from '../middleware/auth.js';
import { asyncHandler, badRequest, notFound } from '../utils/errors.js';
import { crudRouter } from '../utils/crud.js';
import { slugify, toArray } from '../utils/helpers.js';
import { refreshStatuses } from '../utils/statuses.js';

const router = Router();
// Projects a row to the columns the old SELECT listed (null kept, unlike helpers.pick).
const pick = (row, cols) => Object.fromEntries(cols.map((k) => [k, row[k] ?? null]));

// Portal pages need these without an agent login.
router.get('/ticket-statuses/public', asyncHandler(async (_req, res) => {
  const rows = await db.find('ticket_statuses', null, { order: [['position', 'asc'], ['key', 'asc']] });
  res.json({ data: rows.map((r) => pick(r, ['key', 'label', 'customer_label', 'stops_sla', 'is_default'])) });
}));
router.get('/ticket-forms/public', optionalAuth, asyncHandler(async (_req, res) => {
  const rows = await db.find('ticket_forms', { is_active: true }, { order: [['position', 'asc'], ['id', 'asc']] });
  res.json({ data: rows.map((r) => pick(r, ['id', 'name', 'description', 'type', 'product_id', 'group_id', 'field_names'])) });
}));
router.get('/surveys/active', asyncHandler(async (_req, res) => {
  const row = await db.findOne('surveys', { is_active: true }, { order: [['id', 'asc']] });
  res.json({ data: row ? pick(row, ['id', 'name', 'question', 'labels']) : null });
}));

router.use(authenticate, requireAgent);

router.use('/ticket-statuses', crudRouter({
  table: 'ticket_statuses', idColumn: 'key', label: 'Status', orderBy: 'position, key',
  fields: ['label', 'customer_label', 'stops_sla', 'position'], required: ['label'],
  beforeSave: (b) => {
    if (b.label && !b.key) b.key = slugify(b.label).replace(/-/g, '_');
    if (b.label && !b.customer_label) b.customer_label = b.label;
  },
  canDelete: async (key) => {
    const [s, used] = await Promise.all([db.findOne('ticket_statuses', { key }), db.count('tickets', { status: key })]);
    if (s?.is_default) throw badRequest('Built-in statuses cannot be deleted');
    if (Number(used)) throw badRequest(`${used} ticket(s) still use this status`);
  },
  afterChange: refreshStatuses,
}));
router.use('/products', crudRouter({ table: 'products', fields: ['name', 'description', 'support_email', 'portal_name'], required: ['name'], orderBy: 'name', label: 'Product' }));
router.use('/agent-statuses', crudRouter({ table: 'agent_statuses', fields: ['name', 'emoji', 'accepts_tickets', 'position'], required: ['name'], orderBy: 'position, id', label: 'Agent status' }));
router.use('/ticket-templates', crudRouter({
  table: 'ticket_templates', orderBy: 'name', label: 'Template', required: ['name'],
  fields: ['name', 'description', 'parent_template_id', 'subject', 'body', 'priority', 'status', 'type', 'group_id', 'responder_id', 'product_id', 'tags'],
  beforeSave: (b) => { if (b.tags !== undefined) b.tags = toArray(b.tags); },
}));
router.use('/ticket-forms', crudRouter({
  table: 'ticket_forms', orderBy: 'position, id', label: 'Form', required: ['name'],
  fields: ['name', 'description', 'type', 'product_id', 'group_id', 'field_names', 'is_active', 'position'],
  beforeSave: (b) => { if (b.field_names !== undefined) b.field_names = toArray(b.field_names); },
}));
router.use('/entity-fields', crudRouter({
  table: 'entity_fields', orderBy: 'entity, position, id', label: 'Field', required: ['entity', 'label'],
  fields: ['entity', 'name', 'label', 'field_type', 'options', 'position'],
  beforeSave: (b) => { if (b.label && !b.name) b.name = slugify(b.label).replace(/-/g, '_'); },
}));
router.use('/surveys', crudRouter({
  table: 'surveys', orderBy: 'id', label: 'Survey', required: ['name'], fields: ['name', 'question', 'labels', 'is_active'],
  beforeSave: (b) => { if (b.labels !== undefined && (!Array.isArray(b.labels) || b.labels.length < 2 || b.labels.length > 7)) throw badRequest('A survey needs 2 to 7 answer labels'); },
  // Only one survey can be sent at a time.
  afterChange: async (row) => { if (row?.is_active) await db.updateWhere('surveys', { id: { ne: row.id }, is_active: true }, { is_active: false }); },
}));
router.use('/mailboxes', crudRouter({ table: 'mailboxes', fields: ['name', 'email', 'group_id', 'product_id', 'is_default'], required: ['name', 'email'], orderBy: 'name', label: 'Mailbox' }));
router.use('/email-notifications', crudRouter({ table: 'email_notifications', idColumn: 'key', fields: ['is_enabled', 'subject', 'body'], orderBy: 'audience DESC, key', label: 'Notification' }));

// ---------------- roles
const syncRoleUsers = async (role) => {
  if (role) await db.updateWhere('users', { role_id: role.id }, { role: role.privileges.includes('manage_admin') ? 'admin' : 'agent' });
};
router.use('/roles', crudRouter({
  table: 'roles', orderBy: 'id', label: 'Role', required: ['name'], fields: ['name', 'description', 'privileges'],
  beforeSave: async (b, req) => {
    if (b.privileges !== undefined) {
      b.privileges = toArray(b.privileges).filter((p) => ALL_PRIVILEGES.includes(p));
    }
    if (req.params.id) {
      const [role] = await db.find('roles', { id: req.params.id }, { select: ['is_default'] });
      if (role?.is_default) throw badRequest('Built-in roles cannot be changed. Create a new role instead.');
    }
  },
  canDelete: async (id) => {
    const { roles: [role], users } = await db.fetch({ roles: ['roles', { id }], users: ['users', { role_id: id }, { select: ['id'] }] });
    if (role?.is_default) throw badRequest('Built-in roles cannot be deleted');
    if (role && users.length) throw badRequest('Move the agents off this role first');
  },
  afterChange: syncRoleUsers,
}));

// ---------------- scenarios: visible by scope, written by admins
router.get('/scenarios', asyncHandler(async (req, res) => {
  const { scenarios, users, groups, gm } = await db.fetch({
    scenarios: ['scenarios', null, { order: [['name', 'asc']] }],
    users: ['users', null, { select: ['id', 'name'] }],
    groups: ['groups', null, { select: ['id', 'name'] }],
    gm: ['group_members', { user_id: req.user.id }, { select: ['group_id'] }],
  });
  const usersById = indexBy(users);
  const groupsById = indexBy(groups);
  const myGroups = new Set(gm.map((m) => m.group_id));
  const data = scenarios
    .filter((s) => s.visibility === 'all' || s.user_id === req.user.id || req.user.role === 'admin'
      || (s.visibility === 'group' && myGroups.has(s.group_id)))
    .map((s) => ({ ...s, owner_name: usersById.get(s.user_id)?.name ?? null, group_name: groupsById.get(s.group_id)?.name ?? null }));
  res.json({ data });
}));
router.post('/scenarios', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body;
  if (!b.name) throw badRequest('name is required');
  const row = await db.insert('scenarios', {
    name: b.name, description: b.description || null, visibility: b.visibility || 'all', group_id: b.group_id || null,
    user_id: req.user.id, actions: b.actions || [],
  });
  res.status(201).json({ data: row });
}));
router.put('/scenarios/:id', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body;
  const patch = { description: b.description || null, group_id: b.group_id || null };
  if (b.name) patch.name = b.name;
  if (b.visibility) patch.visibility = b.visibility;
  if (b.actions) patch.actions = b.actions;
  const [row] = await db.updateWhere('scenarios', { id: req.params.id }, patch);
  if (!row) throw notFound('Scenario');
  res.json({ data: row });
}));
router.delete('/scenarios/:id', requireAdmin, asyncHandler(async (req, res) => {
  const removed = await db.removeWhere('scenarios', { id: req.params.id });
  if (!removed) throw notFound('Scenario');
  res.json({ ok: true });
}));

// ---------------- channels: token for the inbound webhook, shown to admins only
router.get('/channels/token', requireAdmin, asyncHandler(async (_req, res) => {
  const row = await db.findOne('settings', { key: 'inbound' });
  res.json({ data: { token: row?.value?.token || null } });
}));
router.post('/channels/token', requireAdmin, asyncHandler(async (_req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  const updatedAt = nowIso();
  await db.upsert('settings', { key: 'inbound' }, { key: 'inbound', value: { token }, updated_at: updatedAt }, { value: { token }, updated_at: updatedAt });
  res.json({ data: { token } });
}));

// ---------------- operations
router.get('/audit-log', requireAdmin, asyncHandler(async (_req, res) => {
  res.json({ data: await db.find('audit_log', null, { order: [['created_at', 'desc']], limit: 200 }) });
}));
router.get('/outbox', asyncHandler(async (req, res) => {
  const where = req.query.status ? { status: req.query.status } : null;
  res.json({ data: await db.find('email_outbox', where, { order: [['created_at', 'desc']], limit: 200 }) });
}));

export default router;
