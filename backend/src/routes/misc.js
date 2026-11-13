import { Router } from 'express';
import { db, indexBy, sortRows } from '../db/index.js';
import { authenticate, requireAgent, isAgent } from '../middleware/auth.js';
import { asyncHandler, notFound } from '../utils/errors.js';
import { requireFields } from '../utils/helpers.js';

// SQL `value ILIKE pattern` (% and _ wildcards, backslash escape), NULL never matches.
function ilikeMatcher(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const rx = new RegExp(`^${re}$`, 'i');
  return (v) => v !== null && v !== undefined && rx.test(String(v));
}

export const searchRouter = Router();
searchRouter.use(authenticate, requireAgent);
searchRouter.get('/', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ data: { tickets: [], contacts: [], companies: [], articles: [] } });
  const like = ilikeMatcher(`%${q}%`);
  const idMatch = /^#?(\d+)$/.exec(q);
  const ticketId = idMatch ? Number(idMatch[1]) : null;
  const d = await db.fetch({
    tickets: ['tickets', { deleted: false }, { select: ['id', 'subject', 'description', 'status', 'priority', 'created_at', 'requester_id'] }],
    contacts: ['contacts', undefined, { select: ['id', 'name', 'email', 'phone'] }],
    companies: ['companies', undefined, { select: ['id', 'name', 'domains'] }],
    articles: ['kb_articles', undefined, { select: ['id', 'title', 'slug', 'status', 'body', 'views'] }],
  });
  const contactsById = indexBy(d.contacts);
  const tickets = sortRows(d.tickets.filter((t) => {
    const c = contactsById.get(t.requester_id);
    if (!c) return false;
    return like(t.subject) || like(t.description) || like(c.name) || like(c.email) || (ticketId !== null && t.id === ticketId);
  }), [['created_at', 'desc']]).slice(0, 10).map((t) => ({
    id: t.id, subject: t.subject, status: t.status, priority: t.priority, created_at: t.created_at, requester_name: contactsById.get(t.requester_id).name,
  }));
  const contacts = sortRows(d.contacts.filter((c) => like(c.name) || like(c.email) || like(c.phone)), [['name', 'asc']]).slice(0, 8)
    .map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone }));
  const companies = sortRows(d.companies.filter((c) => like(c.name) || like((c.domains || []).filter((x) => x != null).join(','))), [['name', 'asc']]).slice(0, 8)
    .map((c) => ({ id: c.id, name: c.name, domains: c.domains }));
  const articles = sortRows(d.articles.filter((a) => like(a.title) || like(a.body)), [['views', 'desc']]).slice(0, 8)
    .map((a) => ({ id: a.id, title: a.title, slug: a.slug, status: a.status }));
  res.json({ data: { tickets, contacts, companies, articles } });
}));

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);
const ownerWhere = (user) => (isAgent(user) ? { user_id: user.id } : { contact_id: user.id });
notificationsRouter.get('/', asyncHandler(async (req, res) => {
  const owner = ownerWhere(req.user);
  const { rows, unread } = await db.fetch({
    rows: ['notifications', owner, { order: [['created_at', 'desc']], limit: 50 }],
    unread: ['notifications', { ...owner, is_read: false }, { select: ['id'] }],
  });
  res.json({ data: rows, unread: unread.length });
}));
notificationsRouter.post('/read-all', asyncHandler(async (req, res) => {
  await db.updateWhere('notifications', ownerWhere(req.user), { is_read: true });
  res.json({ ok: true });
}));
notificationsRouter.patch('/:id', asyncHandler(async (req, res) => {
  await db.updateWhere('notifications', { id: req.params.id, ...ownerWhere(req.user) }, { is_read: req.body.is_read !== false });
  res.json({ ok: true });
}));
notificationsRouter.delete('/:id', asyncHandler(async (req, res) => {
  await db.removeWhere('notifications', { id: req.params.id, ...ownerWhere(req.user) });
  res.json({ ok: true });
}));

export const savedViewsRouter = Router();
savedViewsRouter.use(authenticate, requireAgent);
const viewOwnerWhere = (req) => (req.user.role === 'admin' ? { id: req.params.id } : { id: req.params.id, user_id: req.user.id });
savedViewsRouter.get('/', asyncHandler(async (req, res) => {
  const d = await db.fetch({
    views: ['saved_views', { or: [{ user_id: req.user.id }, { visibility: 'all_agents' }] }],
    users: ['users', undefined, { select: ['id', 'name'] }],
  });
  const users = indexBy(d.users);
  const rows = sortRows(d.views, [['position', 'asc'], ['name', 'asc']]).map((v) => ({ ...v, owner_name: users.get(v.user_id)?.name ?? null }));
  res.json({ data: rows });
}));
savedViewsRouter.post('/', asyncHandler(async (req, res) => {
  requireFields(req.body, ['name']);
  const row = await db.insert('saved_views', {
    user_id: req.user.id, name: req.body.name, filters: req.body.filters || {}, visibility: req.body.visibility || 'private',
  });
  res.status(201).json({ data: row });
}));
savedViewsRouter.put('/:id', asyncHandler(async (req, res) => {
  // COALESCE($n, col): only truthy values overwrite.
  const patch = {};
  if (req.body.name) patch.name = req.body.name;
  if (req.body.filters) patch.filters = req.body.filters;
  if (req.body.visibility) patch.visibility = req.body.visibility;
  const where = viewOwnerWhere(req);
  const row = Object.keys(patch).length
    ? (await db.updateWhere('saved_views', where, patch))[0]
    : await db.findOne('saved_views', where);
  if (!row) throw notFound('View');
  res.json({ data: row });
}));
savedViewsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const removed = await db.removeWhere('saved_views', viewOwnerWhere(req));
  if (!removed) throw notFound('View');
  res.json({ ok: true });
}));
