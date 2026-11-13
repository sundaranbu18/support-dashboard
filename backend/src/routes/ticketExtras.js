import { Router } from 'express';
import { db, indexBy, uniq, sortRows } from '../db/index.js';
import { authenticate, requireAgent, requirePrivilege } from '../middleware/auth.js';
import { asyncHandler, notFound, badRequest } from '../utils/errors.js';
import { requireFields, toArray, toInt } from '../utils/helpers.js';
import { applySla } from '../utils/sla.js';
import { logActivity } from '../utils/activity.js';
import { executeActions } from '../utils/automations.js';

const router = Router();
// Mounted ahead of the main tickets router, so every other path must pass straight through.
const EXTRA_PATHS = /^\/(bulk-scenario$|\d+\/(presence|extras|split|links|parent|todos|threads|scenarios|to-forum)(\/|$))/;
router.use((req, _res, next) => (EXTRA_PATHS.test(req.path) ? next() : next('router')));
router.use(authenticate, requireAgent);

// WHERE id = $1 lookup; a missing id matches nothing (as `id = NULL` did) and bad ids raise 22P02.
const byId = (table, id) => (id === undefined || id === null ? null : db.findOne(table, { id }));
const load = async (id) => {
  const row = await byId('tickets', id);
  if (!row) throw notFound('Ticket');
  return row;
};
// SELECT t.id, t.subject, t.status, t.priority, t.created_at, u.name AS responder_name (LEFT JOIN users)
const summary = (t, users) => ({ id: t.id, subject: t.subject, status: t.status, priority: t.priority, created_at: t.created_at, responder_name: users.get(t.responder_id)?.name ?? null });
// Same columns as logActivity() writes, for use inside db.batch.
const activityDoc = (ticketId, actor, action, details = {}) => ({
  ticket_id: ticketId,
  user_id: actor && actor.kind === 'user' ? actor.id : null,
  contact_id: actor && actor.kind === 'contact' ? actor.id : null,
  actor_label: actor ? actor.name : 'System',
  action,
  details,
});

// Who else has this ticket open. Kept in memory: it only matters for the next few seconds.
const presence = new Map();
router.post('/:id/presence', asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  if (!presence.has(id)) presence.set(id, new Map());
  const viewers = presence.get(id);
  const now = Date.now();
  viewers.set(req.user.id, { id: req.user.id, name: req.user.name, replying: !!req.body.replying, at: now });
  for (const [uid, v] of viewers) if (now - v.at > 30000) viewers.delete(uid);
  res.json({ data: [...viewers.values()].filter((v) => v.id !== req.user.id) });
}));

router.get('/:id/extras', asyncHandler(async (req, res) => {
  const t = await load(req.params.id);
  const first = await db.fetch({
    parent: ['tickets', { id: t.parent_ticket_id ?? -1 }],
    children: ['tickets', { parent_ticket_id: t.id, deleted: false }, { order: [['id', 'asc']] }],
    links: ['ticket_links', { or: [{ ticket_a: t.id }, { ticket_b: t.id }] }],
    todos: ['ticket_todos', { ticket_id: t.id }, { order: [['is_done', 'asc'], ['id', 'asc']] }],
    threads: ['ticket_threads', { ticket_id: t.id }, { order: [['id', 'asc']] }],
    timeline: ['tickets', { requester_id: t.requester_id, id: { ne: t.id }, deleted: false }, { order: [['created_at', 'desc']], limit: 10 }],
    users: ['users', null, { select: ['id', 'name'] }],
  });
  const otherIds = uniq(first.links.map((l) => (l.ticket_a === t.id ? l.ticket_b : l.ticket_a)));
  const threadIds = first.threads.map((th) => th.id);
  const second = await db.fetch({
    linked: ['tickets', { id: { in: otherIds }, deleted: false }],
    messages: ['ticket_thread_messages', { thread_id: { in: threadIds } }, { order: [['id', 'asc']] }],
  });
  const users = indexBy(first.users);
  const name = (id) => users.get(id)?.name ?? null;
  const messagesByThread = new Map();
  for (const m of second.messages) {
    if (!messagesByThread.has(m.thread_id)) messagesByThread.set(m.thread_id, []);
    messagesByThread.get(m.thread_id).push({ id: m.id, body: m.body, created_at: m.created_at, user_name: name(m.user_id) });
  }
  const parent = t.parent_ticket_id ? first.parent[0] : null;
  res.json({
    data: {
      parent: parent ? summary(parent, users) : null,
      children: first.children.map((c) => summary(c, users)),
      links: sortRows(second.linked, [['id', 'asc']]).map((l) => summary(l, users)),
      todos: first.todos.map((td) => ({ ...td, user_name: name(td.user_id) })),
      threads: first.threads.map((th) => ({ ...th, created_by_name: name(th.created_by_user_id), messages: messagesByThread.get(th.id) || [] })),
      timeline: first.timeline.map((x) => summary(x, users)),
    },
  });
}));

// ---------------- split a customer reply into its own ticket
router.post('/:id/split', requirePrivilege('merge_split_ticket'), asyncHandler(async (req, res) => {
  const t = await load(req.params.id);
  const convId = toInt(req.body.conversation_id);
  const conv = convId === null ? null : await db.findOne('conversations', { id: convId, ticket_id: t.id });
  if (!conv) throw notFound('Conversation');
  if (!conv.contact_id) throw badRequest('Only customer replies can be split into a new ticket');
  const sla = await applySla({ priority: t.priority, type: t.type, source: t.source, group_id: t.group_id, company_id: t.company_id, created_at: new Date() });
  const created = await db.insert('tickets', {
    subject: req.body.subject || `Split from #${t.id}: ${t.subject}`,
    description: conv.body,
    status: 'open',
    priority: t.priority,
    type: t.type,
    source: t.source,
    requester_id: conv.contact_id,
    group_id: t.group_id,
    company_id: t.company_id,
    product_id: t.product_id,
    sla_policy_id: sla.sla_policy_id,
    fr_due_by: sla.fr_due_by,
    due_by: sla.due_by,
    created_by_user_id: req.user.id,
  });
  // The rest of the old transaction runs atomically; the new ticket's id is needed first, so undo the insert if it fails.
  try {
    await db.batch([
      { op: 'update', table: 'attachments', where: { conversation_id: conv.id }, patch: { ticket_id: created.id, conversation_id: null } },
      { op: 'remove', table: 'conversations', where: { id: conv.id } },
      { op: 'insert', table: 'ticket_activities', doc: activityDoc(created.id, req.user, 'split_from', { ticket: t.id }) },
      { op: 'insert', table: 'ticket_activities', doc: activityDoc(t.id, req.user, 'split_to', { ticket: created.id }) },
    ]);
  } catch (err) {
    await db.remove('tickets', created.id).catch(() => {});
    throw err;
  }
  res.status(201).json({ data: created });
}));

// ---------------- links and parent/child
router.post('/:id/links', asyncHandler(async (req, res) => {
  const a = Number(req.params.id);
  const b = toInt(req.body.ticket_id);
  if (!b || a === b) throw badRequest('Choose a different ticket to link');
  await load(a); await load(b);
  const pair = { ticket_a: Math.min(a, b), ticket_b: Math.max(a, b) };
  await db.upsert('ticket_links', pair, { ...pair, created_by_user_id: req.user.id });
  await logActivity(a, req.user, 'linked', { ticket: b });
  res.status(201).json({ ok: true });
}));
router.delete('/:id/links/:other', asyncHandler(async (req, res) => {
  const a = Number(req.params.id);
  const b = Number(req.params.other);
  await db.removeWhere('ticket_links', { ticket_a: Math.min(a, b), ticket_b: Math.max(a, b) });
  await logActivity(a, req.user, 'unlinked', { ticket: b });
  res.json({ ok: true });
}));
router.post('/:id/parent', asyncHandler(async (req, res) => {
  const t = await load(req.params.id);
  const parentId = toInt(req.body.parent_id);
  if (parentId) {
    if (parentId === t.id) throw badRequest('A ticket cannot be its own parent');
    const parent = await load(parentId);
    if (parent.parent_ticket_id) throw badRequest('Child tickets cannot have children of their own');
    const kids = await db.count('tickets', { parent_ticket_id: t.id });
    if (kids) throw badRequest('This ticket already has child tickets');
  }
  await db.update('tickets', t.id, { parent_ticket_id: parentId });
  await logActivity(t.id, req.user, parentId ? 'parent_set' : 'parent_removed', { ticket: parentId || t.parent_ticket_id });
  res.json({ ok: true });
}));

// ---------------- to-dos
router.post('/:id/todos', asyncHandler(async (req, res) => {
  requireFields(req.body, ['title']);
  const t = await load(req.params.id);
  const row = await db.insert('ticket_todos', { ticket_id: t.id, user_id: req.user.id, title: req.body.title, due_at: req.body.due_at || null });
  res.status(201).json({ data: row });
}));
router.patch('/:id/todos/:tid', asyncHandler(async (req, res) => {
  const where = { id: req.params.tid, ticket_id: req.params.id };
  const patch = {};
  if (req.body.is_done !== undefined && req.body.is_done !== null) patch.is_done = req.body.is_done;
  if (req.body.title) patch.title = req.body.title;
  const row = Object.keys(patch).length ? (await db.updateWhere('ticket_todos', where, patch))[0] : await db.findOne('ticket_todos', where);
  if (!row) throw notFound('To-do');
  res.json({ data: row });
}));
router.delete('/:id/todos/:tid', asyncHandler(async (req, res) => {
  await db.removeWhere('ticket_todos', { id: req.params.tid, ticket_id: req.params.id });
  res.json({ ok: true });
}));

// ---------------- internal threads
router.post('/:id/threads', asyncHandler(async (req, res) => {
  requireFields(req.body, ['title', 'body']);
  const t = await load(req.params.id);
  const thread = await db.insert('ticket_threads', { ticket_id: t.id, title: req.body.title, created_by_user_id: req.user.id });
  await db.insert('ticket_thread_messages', { thread_id: thread.id, user_id: req.user.id, body: req.body.body });
  const notifyIds = toArray(req.body.notify_user_ids).map(Number).filter(Boolean).filter((uid) => uid !== req.user.id);
  await db.insertMany('notifications', notifyIds.map((uid) => ({ user_id: uid, type: 'thread', title: `${req.user.name} started a thread on #${t.id}`, body: req.body.title || null, link: `/tickets/${t.id}` })));
  await logActivity(t.id, req.user, 'thread_started', { title: req.body.title });
  res.status(201).json({ data: thread });
}));
router.post('/:id/threads/:tid/messages', asyncHandler(async (req, res) => {
  requireFields(req.body, ['body']);
  const thread = await db.findOne('ticket_threads', { id: req.params.tid, ticket_id: req.params.id });
  if (!thread) throw notFound('Thread');
  const row = await db.insert('ticket_thread_messages', { thread_id: thread.id, user_id: req.user.id, body: req.body.body });
  res.status(201).json({ data: row });
}));

// ---------------- scenarios
async function visibleScenario(id, user) {
  if (id === undefined || id === null) throw notFound('Scenario');
  const { scenario, memberships } = await db.fetch({
    scenario: ['scenarios', { id }, { limit: 1 }],
    memberships: ['group_members', { user_id: user.id }],
  });
  const s = scenario[0];
  const visible = s && (
    s.visibility === 'all' || s.user_id === user.id || user.role === 'admin'
    || (s.visibility === 'group' && s.group_id !== null && memberships.some((m) => m.group_id === s.group_id))
  );
  if (!visible) throw notFound('Scenario');
  return s;
}
router.post('/bulk-scenario', asyncHandler(async (req, res) => {
  const scenario = await visibleScenario(req.body.scenario_id, req.user);
  const ids = toArray(req.body.ids).map(Number).filter(Boolean);
  if (!ids.length) throw badRequest('ids required');
  // Load every ticket once; keep the latest row per id so repeated ids see earlier changes, as before.
  const tickets = indexBy(await db.find('tickets', { id: { in: ids } }));
  for (const id of ids) {
    const ticket = tickets.get(id);
    if (!ticket) throw notFound('Ticket');
    const updated = await executeActions(scenario.actions, ticket, { label: 'Scenario', name: scenario.name, action: 'scenario', actor: req.user });
    if (updated) tickets.set(id, updated);
  }
  res.json({ ok: true, count: ids.length });
}));
router.post('/:id/scenarios/:sid', asyncHandler(async (req, res) => {
  const scenario = await visibleScenario(req.params.sid, req.user);
  const updated = await executeActions(scenario.actions, await load(req.params.id), { label: 'Scenario', name: scenario.name, action: 'scenario', actor: req.user });
  res.json({ data: updated });
}));

// ---------------- convert a ticket into a forum topic
router.post('/:id/to-forum', requirePrivilege('moderate_forums'), asyncHandler(async (req, res) => {
  requireFields(req.body, ['forum_id']);
  const t = await load(req.params.id);
  const row = await db.insert('forum_topics', { forum_id: toInt(req.body.forum_id), title: req.body.title || t.subject, body: t.description || t.subject, user_id: req.user.id, ticket_id: t.id });
  await logActivity(t.id, req.user, 'converted_to_topic', { topic: row.id });
  res.status(201).json({ data: row });
}));

export default router;
