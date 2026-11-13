import { Router } from 'express';
import { db } from '../db/index.js';
import { authenticate, requireAgent, requireAdmin } from '../middleware/auth.js';
import { asyncHandler, notFound, badRequest } from '../utils/errors.js';
import { requireFields, pick } from '../utils/helpers.js';
import { runTimeTriggers, runAutomations } from '../utils/automations.js';

const router = Router();
router.use(authenticate, requireAgent);

export const AUTOMATION_META = {
  events: ['ticket_created', 'ticket_updated', 'time_trigger'],
  fields: [
    { key: 'subject', label: 'Subject', type: 'text' },
    { key: 'description', label: 'Description', type: 'text' },
    { key: 'status', label: 'Status', type: 'select', options: ['open', 'pending', 'resolved', 'closed'] },
    { key: 'priority', label: 'Priority', type: 'select', options: ['low', 'medium', 'high', 'urgent'] },
    { key: 'type', label: 'Type', type: 'select', options: ['question', 'incident', 'problem', 'feature_request', 'refund', 'other'] },
    { key: 'source', label: 'Source', type: 'select', options: ['email', 'portal', 'phone', 'chat', 'social', 'agent'] },
    { key: 'group_id', label: 'Group', type: 'group' },
    { key: 'responder_id', label: 'Agent', type: 'agent' },
    { key: 'tags', label: 'Tags', type: 'text' },
    { key: 'requester_email', label: 'Requester email', type: 'text' },
    { key: 'requester_domain', label: 'Requester domain', type: 'text' },
    { key: 'company_name', label: 'Company name', type: 'text' },
    { key: 'has_responder', label: 'Is assigned', type: 'boolean' },
    { key: 'first_responded', label: 'Has first response', type: 'boolean' },
    { key: 'hours_since_created', label: 'Hours since created', type: 'number' },
    { key: 'hours_since_updated', label: 'Hours since updated', type: 'number' },
    { key: 'hours_until_due', label: 'Hours until due', type: 'number' },
    { key: 'hours_since_due', label: 'Hours since due', type: 'number' },
  ],
  operators: ['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in', 'not_in', 'greater_than', 'less_than', 'is_empty', 'is_not_empty'],
  actions: [
    { key: 'webhook', label: 'Trigger webhook (POST URL)', value: 'text' },
    { key: 'send_email_requester', label: 'Email the requester', value: 'textarea' },
    { key: 'set_priority', label: 'Set priority', value: 'select', options: ['low', 'medium', 'high', 'urgent'] },
    { key: 'set_status', label: 'Set status', value: 'select', options: ['open', 'pending', 'resolved', 'closed'] },
    { key: 'set_type', label: 'Set type', value: 'select', options: ['question', 'incident', 'problem', 'feature_request', 'refund', 'other'] },
    { key: 'assign_group', label: 'Assign to group', value: 'group' },
    { key: 'assign_agent', label: 'Assign to agent', value: 'agent' },
    { key: 'add_tag', label: 'Add tag', value: 'text' },
    { key: 'remove_tag', label: 'Remove tag', value: 'text' },
    { key: 'add_note', label: 'Add private note', value: 'textarea' },
    { key: 'notify_agent', label: 'Notify agent', value: 'agent' },
    { key: 'notify_group', label: 'Notify group', value: 'group' },
    { key: 'notify_assignee', label: 'Notify assignee', value: 'none' },
    { key: 'escalate', label: 'Mark as escalated', value: 'none' },
    { key: 'mark_spam', label: 'Mark as spam', value: 'none' },
  ],
};

router.get('/meta', (_req, res) => res.json({ data: AUTOMATION_META }));

// WHERE id = $1 lookup; a missing id matches nothing (as `id = NULL` did).
const byId = (table, id) => (id === undefined || id === null ? null : db.findOne(table, { id }));

router.get('/', asyncHandler(async (req, res) => {
  const where = req.query.event ? { event: req.query.event } : null;
  const rows = await db.find('automations', where, { order: [['event', 'asc'], ['position', 'asc'], ['id', 'asc']] });
  res.json({ data: rows });
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body;
  requireFields(b, ['name', 'event']);
  if (!AUTOMATION_META.events.includes(b.event)) throw badRequest('Invalid event');
  let position = b.position || null;
  if (position === null) {
    const siblings = await db.find('automations', { event: b.event });
    position = siblings.reduce((max, r) => Math.max(max, r.position ?? 0), 0) + 1;
  }
  const row = await db.insert('automations', {
    name: b.name,
    description: b.description || null,
    event: b.event,
    conditions: b.conditions || { match: 'all', rules: [] },
    actions: b.actions || [],
    is_active: b.is_active ?? true,
    position,
  });
  res.status(201).json({ data: row });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const patch = pick(req.body, ['name', 'description', 'event', 'conditions', 'actions', 'is_active', 'position']);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const [row] = await db.updateWhere('automations', { id: req.params.id }, patch);
  if (!row) throw notFound('Automation');
  res.json({ data: row });
}));

router.post('/reorder', requireAdmin, asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length) await db.batch(ids.map((id, i) => ({ op: 'update', table: 'automations', where: { id }, patch: { position: i + 1 } })));
  res.json({ ok: true });
}));

// Manually run all time-trigger rules now.
router.post('/run-time-triggers', requireAdmin, asyncHandler(async (_req, res) => {
  const touched = await runTimeTriggers();
  res.json({ ok: true, tickets_updated: touched });
}));

// Dry-run a single rule's conditions against a ticket.
router.post('/:id/test', asyncHandler(async (req, res) => {
  const rule = await byId('automations', req.params.id);
  if (!rule) throw notFound('Automation');
  const ticket = await byId('tickets', req.body.ticket_id);
  if (!ticket) throw badRequest('ticket_id required');
  const { evaluateConditions } = await import('../utils/automations.js');
  // Light context without side effects.
  const matched = evaluateConditions(rule.conditions, ticket);
  res.json({ data: { matched } });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const removed = await db.removeWhere('automations', { id: req.params.id });
  if (!removed) throw notFound('Automation');
  res.json({ ok: true });
}));

export default router;
