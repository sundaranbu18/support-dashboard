import { Router } from 'express';
import { db, indexBy, groupBy, uniq, sum, localDay, nowIso, hoursAgo } from '../db/index.js';
import { authenticate, isAgent, isCustomer, requirePrivilege } from '../middleware/auth.js';
import { asyncHandler, notFound, badRequest, forbidden } from '../utils/errors.js';
import { requireFields, pagination, toArray, toInt, toBool, normalizeBody, STATUSES, PRIORITIES, TYPES, SOURCES } from '../utils/helpers.js';
import { applySla, computeDueDates, slaStatus } from '../utils/sla.js';
import { runAutomations } from '../utils/automations.js';
import { logActivity } from '../utils/activity.js';
import { notifyUser, notifyGroup, notifyContact } from '../utils/notifications.js';
import { upload, fileRecord } from '../utils/upload.js';
import { sendTicketEmail, sendEmail } from '../utils/email.js';
import { sendCsv } from '../utils/csv.js';

const router = Router();
router.use(authenticate);

const DONE = ['resolved', 'closed'];
const NOT_DONE = { status: { nin: DONE } };
const LIVE = { deleted: false, spam: false };

// `in` filter on ids; for very large id sets load the whole table instead (rows are joined in JS anyway).
const idsIn = (ids) => {
  const list = uniq(ids);
  return list.length <= 300 ? { in: list } : undefined;
};

// Adds the joined/aggregated list fields (the old LIST_SELECT) to ticket rows.
// Tickets whose requester no longer exists are dropped (it was an INNER JOIN on contacts).
async function withListFields(tickets) {
  if (!tickets.length) return [];
  const ids = tickets.map((t) => t.id);
  const r = await db.fetch({
    contacts: ['contacts', { id: idsIn(tickets.map((t) => t.requester_id)) }, { select: ['id', 'name', 'email', 'avatar_url'] }],
    users: ['users', { id: idsIn(tickets.map((t) => t.responder_id)) }, { select: ['id', 'name', 'avatar_url'] }],
    groups: ['groups', { id: idsIn(tickets.map((t) => t.group_id)) }, { select: ['id', 'name'] }],
    companies: ['companies', { id: idsIn(tickets.map((t) => t.company_id)) }, { select: ['id', 'name'] }],
    products: ['products', { id: idsIn(tickets.map((t) => t.product_id)) }, { select: ['id', 'name'] }],
    convs: ['conversations', { ticket_id: idsIn(ids) }, { select: ['ticket_id', 'is_private', 'created_at'] }],
    atts: ['attachments', { ticket_id: idsIn(ids) }, { select: ['ticket_id'] }],
    times: ['time_entries', { ticket_id: idsIn(ids) }, { select: ['ticket_id', 'minutes'] }],
  });
  const contacts = indexBy(r.contacts);
  const users = indexBy(r.users);
  const groups = indexBy(r.groups);
  const companies = indexBy(r.companies);
  const products = indexBy(r.products);
  const convs = groupBy(r.convs, 'ticket_id');
  const atts = groupBy(r.atts, 'ticket_id');
  const times = groupBy(r.times, 'ticket_id');
  const out = [];
  for (const t of tickets) {
    const c = contacts.get(t.requester_id);
    if (!c) continue;
    const u = users.get(t.responder_id);
    const cv = convs.get(t.id) || [];
    let last = null;
    for (const x of cv) if (x.created_at && (last === null || new Date(x.created_at) > new Date(last))) last = x.created_at;
    out.push({
      ...t,
      requester_name: c.name, requester_email: c.email, requester_avatar: c.avatar_url,
      responder_name: u ? u.name : null, responder_avatar: u ? u.avatar_url : null,
      group_name: groups.get(t.group_id)?.name ?? null,
      company_name: companies.get(t.company_id)?.name ?? null,
      product_name: products.get(t.product_id)?.name ?? null,
      reply_count: cv.filter((x) => x.is_private === false).length,
      attachment_count: (atts.get(t.id) || []).length,
      last_reply_at: last,
      time_spent_minutes: sum(times.get(t.id) || [], 'minutes'),
    });
  }
  return out;
}

function decorate(t) {
  return { ...t, sla_status: slaStatus(t) };
}

// Same shape as utils/activity.js logActivity, for inserting activities inside a db.batch.
function activityDoc(ticketId, actor, action, details = {}) {
  return {
    ticket_id: ticketId,
    user_id: actor && actor.kind === 'user' ? actor.id : null,
    contact_id: actor && actor.kind === 'contact' ? actor.id : null,
    actor_label: actor ? actor.name : 'System',
    action,
    details,
  };
}

async function loadTicket(id, user) {
  const row = await db.findOne('tickets', { id });
  const [t] = row ? await withListFields([row]) : [];
  if (!t) throw notFound('Ticket');
  if (isCustomer(user) && (t.requester_id !== user.id || t.deleted || t.spam)) throw notFound('Ticket');
  return t;
}

async function findOrCreateRequester({ requester_id, requester_email, requester_name, requester_phone }) {
  if (requester_id) {
    const row = await db.findOne('contacts', { id: requester_id });
    if (!row) throw badRequest('Requester not found');
    return row;
  }
  if (!requester_email && !requester_phone) throw badRequest('A requester (id, email or phone) is required');
  if (requester_email) {
    const email = String(requester_email).toLowerCase();
    const { existing, comp } = await db.fetch({
      existing: ['contacts', { email: { ieq: email } }, { limit: 1 }],
      comp: ['companies', { domains: { contains: email.split('@')[1] } }, { limit: 1, select: ['id'] }],
    });
    if (existing[0]) return existing[0];
    return db.insert('contacts', { name: requester_name || email.split('@')[0], email, phone: requester_phone || null, company_id: comp[0]?.id || null });
  }
  return db.insert('contacts', { name: requester_name || requester_phone, phone: requester_phone });
}

async function saveAttachments(files, { ticketId, conversationId, user }) {
  if (!files || !files.length) return [];
  const docs = [];
  for (const f of files) {
    const r = await fileRecord(f);
    docs.push({
      ticket_id: ticketId, conversation_id: conversationId || null, file_name: r.file_name, content_type: r.content_type, size: r.size, path: r.path,
      uploaded_by_user_id: isAgent(user) ? user.id : null, uploaded_by_contact_id: isCustomer(user) ? user.id : null,
    });
  }
  return db.insertMany('attachments', docs);
}

// Round-robin assignment inside a group with auto_assign enabled.
async function autoAssign(groupId) {
  if (!groupId) return null;
  const { group, members } = await db.fetch({
    group: ['groups', { id: groupId }, { select: ['id', 'auto_assign'] }],
    members: ['group_members', { group_id: groupId }],
  });
  if (!group[0]?.auto_assign) return null;
  const memberIds = members.map((m) => m.user_id);
  if (!memberIds.length) return null;
  const r = await db.fetch({
    users: ['users', { id: idsIn(memberIds), is_active: true }, { select: ['id', 'agent_status_id'] }],
    statuses: ['agent_statuses', undefined, { select: ['id', 'accepts_tickets'] }],
    open: ['tickets', { responder_id: idsIn(memberIds), status: { nin: DONE }, deleted: false }, { select: ['responder_id'] }],
  });
  const statuses = indexBy(r.statuses);
  const load = new Map();
  for (const t of r.open) load.set(t.responder_id, (load.get(t.responder_id) || 0) + 1);
  // One candidate row per membership (JOIN group_members), like the SQL.
  const users = indexBy(r.users);
  const candidates = members
    .map((m) => users.get(m.user_id))
    .filter((u) => u && (statuses.get(u.agent_status_id)?.accepts_tickets ?? true))
    .map((u) => ({ id: u.id, load: load.get(u.id) || 0 }))
    .sort((a, b) => a.load - b.load || a.id - b.id);
  return candidates[0]?.id || null;
}

// ---------------------------------------------------------------- counts
router.get('/counts', asyncHandler(async (req, res) => {
  const me = isAgent(req.user) ? req.user.id : null;
  const customer = isCustomer(req.user);
  const r = await db.fetch({
    tickets: ['tickets', customer ? { requester_id: req.user.id, ...LIVE } : undefined,
      { select: ['id', 'status', 'due_by', 'responder_id', 'created_at', 'created_by_user_id', 'spam', 'deleted', 'archived'] }],
    ...(me !== null ? {
      mentions: ['ticket_mentions', { user_id: me }, { select: ['ticket_id'] }],
      watching: ['ticket_watchers', { user_id: me }, { select: ['ticket_id'] }],
    } : {}),
  });
  const mentioned = new Set((r.mentions || []).map((x) => x.ticket_id));
  const watching = new Set((r.watching || []).map((x) => x.ticket_id));
  const now = new Date();
  const today = localDay(now);
  const dayAgo = new Date(hoursAgo(24));
  const data = {
    unresolved: 0, open: 0, pending: 0, resolved: 0, closed: 0, overdue: 0, due_today: 0, unassigned: 0, my_open: 0,
    new_today: 0, spam: 0, trash: 0, all_tickets: 0, archive: 0, raised: 0, mentioned: 0, watching: 0,
  };
  for (const t of r.tickets) {
    const live = !t.deleted && !t.spam;
    const notDone = !DONE.includes(t.status);
    if (live) {
      if (notDone) data.unresolved++;
      if (t.status === 'open') data.open++;
      if (t.status !== 'open' && notDone) data.pending++;
      if (t.status === 'resolved') data.resolved++;
      if (t.status === 'closed') data.closed++;
      if (notDone && t.due_by && new Date(t.due_by) < now) data.overdue++;
      if (notDone && t.due_by && localDay(t.due_by) === today) data.due_today++;
      if (notDone && t.responder_id === null) data.unassigned++;
      if (notDone && me !== null && t.responder_id === me) data.my_open++;
      if (t.created_at && new Date(t.created_at) > dayAgo) data.new_today++;
      if (!t.archived) data.all_tickets++;
      if (me !== null && t.created_by_user_id === me) data.raised++;
    }
    if (t.spam && !t.deleted) data.spam++;
    if (t.deleted) data.trash++;
    if (t.archived && !t.deleted) data.archive++;
    if (!t.deleted && mentioned.has(t.id)) data.mentioned++;
    if (!t.deleted && watching.has(t.id)) data.watching++;
  }
  res.json({ data });
}));

// ---------------------------------------------------------------- list
// Postgres compared text params against timestamptz in the server's local time zone.
function badTs(v) { const e = new Error(`Invalid timestamp "${v}"`); e.code = '22P02'; return e; }
function parseLocalTs(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  if (Number.isNaN(d.getTime())) throw badTs(v);
  return d.toISOString();
}
// `$x::date + INTERVAL '1 day'` -> local midnight of the following day.
function nextLocalDay(v) {
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw badTs(v);
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(localDay(d));
  }
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
  if (Number.isNaN(d.getTime())) throw badTs(v);
  return d.toISOString();
}

// Loads every ticket matching the current view and filters (without the list fields).
async function loadFiltered(req, { needReplies = false } = {}) {
  const q = req.query;
  const and = [];
  const customer = isCustomer(req.user);
  if (customer) and.push({ requester_id: req.user.id, ...LIVE });

  const view = q.view || 'all';
  const me = isAgent(req.user) ? req.user.id : 0;
  const notTrash = { deleted: false, spam: false, archived: false };
  let viewSet = null; // 'mentioned' | 'watching'
  switch (view) {
    case 'unresolved': and.push({ ...NOT_DONE, ...notTrash }); break;
    case 'new_and_my_open': and.push({ ...NOT_DONE, responder_id: { in: [null, me] }, ...notTrash }); break;
    case 'my_open': and.push({ ...NOT_DONE, responder_id: me, ...notTrash }); break;
    case 'unassigned': and.push({ ...NOT_DONE, responder_id: { isNull: true }, ...notTrash }); break;
    case 'overdue': and.push({ ...NOT_DONE, due_by: { lt: nowIso() }, ...notTrash }); break;
    case 'due_today': and.push({ ...NOT_DONE, due_by: { isNull: false }, ...notTrash }); break; // day check in JS
    case 'open': and.push({ status: 'open', ...notTrash }); break;
    case 'on_hold': case 'pending': and.push({ status: { nin: ['open', ...DONE] }, ...notTrash }); break;
    case 'raised': and.push({ created_by_user_id: me, deleted: false, spam: false }); break;
    case 'mentioned': viewSet = 'mentioned'; and.push({ deleted: false }); break;
    case 'archive': and.push({ archived: true, deleted: false }); break;
    case 'resolved': and.push({ status: 'resolved', ...notTrash }); break;
    case 'closed': and.push({ status: 'closed', ...notTrash }); break;
    case 'watching': viewSet = 'watching'; and.push({ deleted: false }); break;
    case 'spam': and.push({ spam: true, deleted: false }); break;
    case 'trash': and.push({ deleted: true }); break;
    default: if (!customer) and.push(notTrash);
  }

  const never = { id: { in: [] } };
  const statuses = toArray(q.status); if (statuses.length) and.push({ status: { in: statuses } });
  const priorities = toArray(q.priority); if (priorities.length) and.push({ priority: { in: priorities } });
  const types = toArray(q.type); if (types.length) and.push({ type: { in: types } });
  const sources = toArray(q.source); if (sources.length) and.push({ source: { in: sources } });
  const responders = toArray(q.responder_id);
  if (responders.length) {
    const nums = responders.filter((r) => r !== 'none' && r !== 'null').map(Number);
    const includeNone = responders.includes('none') || responders.includes('null');
    and.push({ responder_id: { in: [...nums, ...(includeNone ? [null] : [])] } });
  }
  const groups = toArray(q.group_id).map(Number).filter(Boolean); if (groups.length) and.push({ group_id: { in: groups } });
  if (q.requester_id) { const v = toInt(q.requester_id); and.push(v === null ? never : { requester_id: v }); }
  if (q.company_id) { const v = toInt(q.company_id); and.push(v === null ? never : { company_id: v }); }
  const tags = toArray(q.tags || q.tag); if (tags.length) and.push({ tags: { overlaps: tags } });
  const products = toArray(q.product_id).map(Number).filter(Boolean); if (products.length) and.push({ product_id: { in: products } });
  for (const [key, column] of [['due', 'due_by'], ['fr_due', 'fr_due_by'], ['resolved', 'resolved_at'], ['closed', 'closed_at']]) {
    if (q[`${key}_from`]) and.push({ [column]: { gte: parseLocalTs(q[`${key}_from`]) } });
    if (q[`${key}_to`]) and.push({ [column]: { lte: nextLocalDay(q[`${key}_to`]) } });
  }
  if (q.created_from) and.push({ created_at: { gte: parseLocalTs(q.created_from) } });
  if (q.created_to) and.push({ created_at: { lte: nextLocalDay(q.created_to) } });

  const term = q.q ? String(q.q) : '';
  const requests = { tickets: ['tickets', { and }] };
  if (viewSet === 'mentioned') requests.set = ['ticket_mentions', { user_id: me }, { select: ['ticket_id'] }];
  if (viewSet === 'watching') requests.set = ['ticket_watchers', { user_id: me }, { select: ['ticket_id'] }];
  if (term) requests.contacts = ['contacts', { or: [{ name: { icontains: term } }, { email: { icontains: term } }] }, { select: ['id'] }];
  const r = await db.fetch(requests);

  let rows = r.tickets;
  if (view === 'due_today') { const today = localDay(new Date()); rows = rows.filter((t) => localDay(t.due_by) === today); }
  if (r.set) { const ids = new Set(r.set.map((x) => x.ticket_id)); rows = rows.filter((t) => ids.has(t.id)); }
  if (term) {
    const needle = term.toLowerCase();
    const contactIds = new Set(r.contacts.map((c) => c.id));
    const idMatch = /^#?(\d+)$/.exec(term.trim());
    const idNum = idMatch ? Number(idMatch[1]) : null;
    rows = rows.filter((t) => String(t.subject ?? '').toLowerCase().includes(needle)
      || String(t.description ?? '').toLowerCase().includes(needle)
      || contactIds.has(t.requester_id)
      || (idNum !== null && t.id === idNum));
  }

  if (needReplies && rows.length) {
    const convs = await db.find('conversations', { ticket_id: idsIn(rows.map((t) => t.id)) }, { select: ['ticket_id', 'created_at'] });
    const last = new Map();
    for (const c of convs) {
      const prev = last.get(c.ticket_id);
      if (c.created_at && (!prev || new Date(c.created_at) > new Date(prev))) last.set(c.ticket_id, c.created_at);
    }
    rows = rows.map((t) => ({ ...t, last_reply_at: last.get(t.id) ?? null }));
  }
  return rows;
}

const PRIORITY_RANK = { urgent: 4, high: 3, medium: 2 };
const tsKey = (v) => (v == null ? null : new Date(v).getTime());
const SORT_KEYS = {
  created_at: (t) => tsKey(t.created_at),
  updated_at: (t) => tsKey(t.updated_at),
  due_by: (t) => tsKey(t.due_by),
  status: (t) => t.status,
  priority: (t) => PRIORITY_RANK[t.priority] || 1,
  last_reply: (t) => tsKey(t.last_reply_at),
};

// ORDER BY <key> <dir> NULLS LAST, t.id DESC
function sortTickets(rows, keyFn, desc) {
  const keyed = rows.map((t) => ({ t, k: keyFn(t) }));
  keyed.sort((a, b) => {
    const x = a.k, y = b.k;
    if (x == null || y == null) {
      if (x == null && y != null) return 1;
      if (x != null && y == null) return -1;
    } else if (x !== y) {
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : (String(x) < String(y) ? -1 : 1);
      return desc ? -c : c;
    }
    return b.t.id - a.t.id;
  });
  return keyed.map((e) => e.t);
}

// Full export of the current view and filters, not just the visible page.
router.get('/export', requirePrivilege('export_data'), asyncHandler(async (req, res) => {
  const rows = sortTickets(await loadFiltered(req), SORT_KEYS.created_at, true).slice(0, 50000);
  const full = await withListFields(rows);
  sendCsv(res, 'tickets.csv', full, ['id', 'subject', 'status', 'priority', 'type', 'source', 'requester_name', 'requester_email', 'responder_name', 'group_name', 'company_name', 'product_name', 'tags', 'created_at', 'due_by', 'fr_due_by', 'first_responded_at', 'resolved_at', 'closed_at', 'time_spent_minutes']);
}));

router.get('/', asyncHandler(async (req, res) => {
  const q = req.query;
  const { page, perPage, offset } = pagination(q, { per_page: 30 });
  const keyFn = SORT_KEYS[q.sort] || SORT_KEYS.created_at;
  const desc = (q.order || 'desc').toLowerCase() !== 'asc';
  const rows = await loadFiltered(req, { needReplies: q.sort === 'last_reply' });
  const pageRows = sortTickets(rows, keyFn, desc).slice(offset, offset + perPage).map(({ last_reply_at, ...t }) => t);
  const data = await withListFields(pageRows);
  res.json({ data: data.map(decorate), meta: { total: rows.length, page, per_page: perPage } });
}));

// ---------------------------------------------------------------- create
router.post('/', upload.array('attachments', 10), asyncHandler(async (req, res) => {
  const b = normalizeBody(req.body);
  requireFields(b, ['subject']);
  const customer = isCustomer(req.user);

  const requester = customer
    ? await db.get('contacts', req.user.id)
    : await findOrCreateRequester(b);

  // Customers route through a published form; they never choose a group directly.
  const form = customer && toInt(b.form_id) ? await db.findOne('ticket_forms', { id: toInt(b.form_id), is_active: true }) : undefined;
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'low';
  const status = !customer && STATUSES.includes(b.status) ? b.status : 'open';
  const type = TYPES.includes(b.type) ? b.type : (form?.type || null);
  const source = customer ? 'portal' : (SOURCES.includes(b.source) ? b.source : 'agent');
  const groupId = customer ? form?.group_id ?? null : toInt(b.group_id);
  const productId = customer ? form?.product_id ?? null : toInt(b.product_id);
  let responderId = customer ? null : toInt(b.responder_id);
  if (!responderId) responderId = await autoAssign(groupId);

  const draft = { priority, type, source, group_id: groupId, company_id: requester.company_id, created_at: new Date() };
  const sla = await applySla(draft);

  // The activity needs the new ticket id, so these run sequentially.
  let ticket = await db.insert('tickets', {
    subject: b.subject, description: b.description || '', status, priority, type, source, requester_id: requester.id,
    responder_id: responderId, group_id: groupId, company_id: requester.company_id,
    tags: toArray(b.tags), cc_emails: toArray(b.cc_emails), custom_fields: b.custom_fields || {},
    sla_policy_id: sla.sla_policy_id, fr_due_by: sla.fr_due_by, due_by: sla.due_by,
    created_by_user_id: isAgent(req.user) ? req.user.id : null, product_id: productId, parent_ticket_id: customer ? null : toInt(b.parent_ticket_id),
  });
  await logActivity(ticket.id, req.user, 'created', { status, priority, source });

  await saveAttachments(req.files, { ticketId: ticket.id, user: req.user });
  ticket = await runAutomations('ticket_created', ticket);
  await sendTicketEmail('new_ticket_requester', ticket);
  if (ticket.responder_id && ticket.responder_id !== req.user.id) await sendTicketEmail('ticket_assigned_agent', ticket);

  // A parent template creates its child tickets along with the parent.
  if (!customer && toInt(b.template_id)) {
    const children = await db.find('ticket_templates', { parent_template_id: toInt(b.template_id) }, { order: 'id' });
    if (children.length) {
      const slas = await Promise.all(children.map((tpl) => applySla({ priority: tpl.priority || ticket.priority, type: tpl.type, source: ticket.source, group_id: tpl.group_id, company_id: ticket.company_id, created_at: new Date() })));
      const created = await db.insertMany('tickets', children.map((tpl, i) => ({
        subject: tpl.subject || tpl.name, description: tpl.body || '', status: 'open', priority: tpl.priority || ticket.priority, type: tpl.type,
        source: ticket.source, requester_id: ticket.requester_id, responder_id: tpl.responder_id, group_id: tpl.group_id, company_id: ticket.company_id,
        tags: tpl.tags, sla_policy_id: slas[i].sla_policy_id, fr_due_by: slas[i].fr_due_by, due_by: slas[i].due_by, created_by_user_id: req.user.id,
        product_id: tpl.product_id || ticket.product_id, parent_ticket_id: ticket.id,
      })));
      await db.insertMany('ticket_activities', created.map((child, i) => activityDoc(child.id, req.user, 'created', { priority: children[i].priority || ticket.priority, parent: ticket.id })));
    }
  }

  if (ticket.responder_id && ticket.responder_id !== req.user.id) {
    await notifyUser(ticket.responder_id, { type: 'ticket_assigned', title: `Ticket #${ticket.id} assigned to you`, body: ticket.subject, link: `/tickets/${ticket.id}` });
  } else if (!ticket.responder_id && ticket.group_id) {
    await notifyGroup(ticket.group_id, { type: 'ticket_created', title: `New ticket #${ticket.id} in your group`, body: ticket.subject, link: `/tickets/${ticket.id}` });
  }
  if (customer) {
    await notifyContact(requester.id, { type: 'ticket_created', title: `We received your request #${ticket.id}`, body: ticket.subject, link: `/portal/tickets/${ticket.id}` });
  }

  res.status(201).json({ data: decorate(await loadTicket(ticket.id, req.user)) });
}));

// ---------------------------------------------------------------- bulk
router.post('/bulk', asyncHandler(async (req, res) => {
  if (!isAgent(req.user)) throw forbidden();
  const ids = toArray(req.body.ids).map(Number).filter(Boolean);
  const action = req.body.action || {};
  if (!ids.length) throw badRequest('ids required');
  const updates = {};
  if (STATUSES.includes(action.status)) updates.status = action.status;
  if (PRIORITIES.includes(action.priority)) updates.priority = action.priority;
  if (TYPES.includes(action.type)) updates.type = action.type;
  if (action.responder_id !== undefined) updates.responder_id = toInt(action.responder_id);
  if (action.group_id !== undefined) updates.group_id = toInt(action.group_id);
  if (action.delete && !req.user.privileges.includes('delete_ticket')) throw forbidden('Your role does not allow deleting tickets');
  if (action.delete) updates.deleted = true;
  if (action.restore) updates.deleted = false;
  if (action.spam !== undefined) updates.spam = !!action.spam;

  const keys = Object.keys(updates);
  if (!keys.length && !action.add_tags) throw badRequest('No bulk action supplied');
  const addTags = action.add_tags ? toArray(action.add_tags).map(String) : null;
  const now = nowIso();
  // COALESCE(resolved_at, NOW()) and the tag union depend on each row, so each ticket gets its own patch.
  const current = await db.find('tickets', { id: { in: ids } }, { select: ['id', 'resolved_at', 'closed_at', 'tags'] });
  const ops = current.map((t) => {
    const patch = { ...updates };
    if (updates.status === 'resolved') patch.resolved_at = t.resolved_at || now;
    if (updates.status === 'closed') patch.closed_at = t.closed_at || now;
    if (updates.status && !DONE.includes(updates.status)) { patch.resolved_at = null; patch.closed_at = null; }
    if (addTags) patch.tags = uniq([...(t.tags || []), ...addTags]);
    return { op: 'update', table: 'tickets', where: { id: t.id }, patch };
  });
  for (const id of ids) ops.push({ op: 'insert', table: 'ticket_activities', doc: activityDoc(id, req.user, 'bulk_update', { ...updates, add_tags: action.add_tags }) });
  await db.batch(ops);
  res.json({ ok: true, count: ids.length });
}));

// ---------------------------------------------------------------- detail
router.get('/:id', asyncHandler(async (req, res) => {
  const t = await loadTicket(req.params.id, req.user);
  const customer = isCustomer(req.user);
  const r = await db.fetch({
    conversations: ['conversations', { ticket_id: t.id, ...(customer ? { is_private: false } : {}) }, { order: [['created_at', 'asc'], ['id', 'asc']] }],
    attachments: ['attachments', { ticket_id: t.id, conversation_id: { isNull: true } }, { order: [['created_at', 'asc'], ['id', 'asc']] }],
    ...(customer ? {} : {
      activities: ['ticket_activities', { ticket_id: t.id }, { order: [['created_at', 'desc'], ['id', 'desc']], limit: 100 }],
      timeEntries: ['time_entries', { ticket_id: t.id }, { order: [['started_at', 'desc'], ['id', 'desc']] }],
    }),
    watchers: ['ticket_watchers', { ticket_id: t.id }],
    rating: ['satisfaction_ratings', { ticket_id: t.id }],
    requester: ['contacts', { id: t.requester_id }],
    requesterTickets: ['tickets', { requester_id: t.requester_id, deleted: false }, { select: ['id'] }],
    merged: ['tickets', { merged_into_ticket_id: t.id }, { select: ['id', 'subject'] }],
    ...(t.sla_policy_id ? { sla: ['sla_policies', { id: t.sla_policy_id }, { select: ['id', 'name'] }] } : {}),
  });
  const activities = r.activities || [];
  const timeEntryRows = r.timeEntries || [];
  const requesterRow = r.requester[0] || null;
  const userIds = [...r.conversations.map((c) => c.user_id), ...timeEntryRows.map((e) => e.user_id), ...r.watchers.map((w) => w.user_id)];
  const r2 = await db.fetch({
    convAttachments: ['attachments', { conversation_id: { in: r.conversations.map((c) => c.id) } }, { order: 'id' }],
    users: ['users', { id: { in: uniq(userIds) } }, { select: ['id', 'name', 'avatar_url'] }],
    contacts: ['contacts', { id: { in: uniq(r.conversations.map((c) => c.contact_id)) } }, { select: ['id', 'name', 'email', 'avatar_url'] }],
    company: ['companies', { id: { in: uniq([requesterRow?.company_id]) } }, { select: ['id', 'name'] }],
  });
  const users = indexBy(r2.users);
  const contacts = indexBy(r2.contacts);
  const convAtts = groupBy(r2.convAttachments, 'conversation_id');

  const conversations = r.conversations.map((cv) => {
    const u = users.get(cv.user_id);
    const c = contacts.get(cv.contact_id);
    return {
      ...cv, user_name: u ? u.name : null, user_avatar: u ? u.avatar_url : null,
      contact_name: c ? c.name : null, contact_email: c ? c.email : null, contact_avatar: c ? c.avatar_url : null,
      attachments: convAtts.get(cv.id) || [],
    };
  });
  const timeEntries = timeEntryRows.map((e) => ({ ...e, user_name: users.get(e.user_id)?.name ?? null }));
  const watchers = r.watchers.filter((w) => users.has(w.user_id)).map((w) => {
    const u = users.get(w.user_id);
    return { id: u.id, name: u.name, avatar_url: u.avatar_url };
  });
  let requesterSafe = {};
  if (requesterRow) {
    const { password_hash, ...rest } = requesterRow;
    requesterSafe = {
      ...rest, company_name: r2.company[0]?.name ?? null, has_portal_access: password_hash != null,
      ticket_count: r.requesterTickets.length,
    };
  }
  const merged = r.merged.map((m) => ({ id: m.id, subject: m.subject }));
  const sla = (r.sla || []).map((s) => ({ id: s.id, name: s.name }));

  res.json({
    data: {
      ...decorate(t), conversations, attachments: r.attachments, activities, time_entries: timeEntries, watchers,
      satisfaction: r.rating[0] || null, requester: requesterSafe, merged_tickets: merged, sla_policy: sla[0] || null,
      is_watching: watchers.some((w) => w.id === req.user.id && isAgent(req.user)),
    },
  });
}));

// ---------------------------------------------------------------- update
router.patch('/:id', asyncHandler(async (req, res) => {
  const t = await loadTicket(req.params.id, req.user);
  const b = req.body;
  const updates = {};
  if (isCustomer(req.user)) {
    // Customers may only close/reopen their own tickets.
    if (b.status === 'closed' || b.status === 'open') updates.status = b.status;
    else throw forbidden('Customers can only close or reopen tickets');
  } else {
    if (b.subject !== undefined) updates.subject = b.subject;
    if (b.description !== undefined) updates.description = b.description;
    if (b.status !== undefined) { if (!STATUSES.includes(b.status)) throw badRequest('Invalid status'); updates.status = b.status; }
    if (b.priority !== undefined) { if (!PRIORITIES.includes(b.priority)) throw badRequest('Invalid priority'); updates.priority = b.priority; }
    if (b.type !== undefined) updates.type = b.type || null;
    if (b.source !== undefined) updates.source = b.source;
    if (b.responder_id !== undefined) updates.responder_id = toInt(b.responder_id);
    if (b.group_id !== undefined) updates.group_id = toInt(b.group_id);
    if (b.product_id !== undefined) updates.product_id = toInt(b.product_id);
    if (b.archived !== undefined) updates.archived = toBool(b.archived);
    if (b.requester_id !== undefined) updates.requester_id = toInt(b.requester_id);
    if (b.company_id !== undefined) updates.company_id = toInt(b.company_id);
    if (b.tags !== undefined) updates.tags = toArray(b.tags);
    if (b.cc_emails !== undefined) updates.cc_emails = toArray(b.cc_emails);
    if (b.custom_fields !== undefined) updates.custom_fields = { ...(t.custom_fields || {}), ...b.custom_fields };
    if (b.due_by !== undefined) updates.due_by = b.due_by || null;
    if (b.fr_due_by !== undefined) updates.fr_due_by = b.fr_due_by || null;
    if (b.spam !== undefined) updates.spam = toBool(b.spam);
    if (b.deleted !== undefined) updates.deleted = toBool(b.deleted);
    if (b.is_escalated !== undefined) updates.is_escalated = toBool(b.is_escalated);
  }

  // A parent cannot be finished while its child tickets are still open.
  if (DONE.includes(updates.status) && !DONE.includes(t.status)) {
    const open = await db.count('tickets', { parent_ticket_id: t.id, status: { nin: DONE }, deleted: false });
    if (Number(open)) throw badRequest(`Resolve the ${open} open child ticket(s) first`);
  }

  const changes = {};
  for (const [k, v] of Object.entries(updates)) {
    if (JSON.stringify(t[k]) !== JSON.stringify(v)) changes[k] = { from: t[k], to: v };
  }
  if (!Object.keys(changes).length) return res.json({ data: decorate(t) });

  const patch = {};
  for (const k of Object.keys(changes)) patch[k] = updates[k];
  if (changes.priority && !b.due_by) {
    const policy = t.sla_policy_id ? await db.get('sla_policies', t.sla_policy_id) : null;
    const due = computeDueDates(policy, updates.priority, t.created_at);
    patch.due_by = due.due_by;
    if (!t.first_responded_at) patch.fr_due_by = due.fr_due_by;
    patch.is_escalated = false;
  }
  if (changes.status) {
    const now = nowIso();
    if (updates.status === 'resolved') patch.resolved_at = now;
    if (updates.status === 'closed') { patch.closed_at = now; patch.resolved_at = t.resolved_at || now; }
    if (!DONE.includes(updates.status)) { patch.resolved_at = null; patch.closed_at = null; }
  }
  if (changes.requester_id) {
    const contact = updates.requester_id === null ? null : await db.get('contacts', updates.requester_id);
    patch.company_id = contact?.company_id || null;
  }
  if (changes.group_id && !changes.responder_id && !t.responder_id) {
    const auto = await autoAssign(updates.group_id);
    if (auto) { patch.responder_id = auto; changes.responder_id = { from: null, to: auto }; }
  }

  let updated = await db.update('tickets', t.id, patch);
  await logActivity(t.id, req.user, 'updated', { changes });

  if (changes.responder_id && updated.responder_id && updated.responder_id !== req.user.id) {
    await notifyUser(updated.responder_id, { type: 'ticket_assigned', title: `Ticket #${t.id} assigned to you`, body: updated.subject, link: `/tickets/${t.id}` });
    await sendTicketEmail('ticket_assigned_agent', updated);
  }
  if (changes.status && updated.status === 'resolved' && !isCustomer(req.user)) await sendTicketEmail('ticket_resolved_requester', updated);
  if (changes.status && (updated.status === 'resolved' || updated.status === 'closed') && !isCustomer(req.user)) {
    await notifyContact(t.requester_id, { type: 'ticket_resolved', title: `Your ticket #${t.id} has been ${updated.status}`, body: 'Let us know how we did by rating your experience.', link: `/portal/tickets/${t.id}` });
  }
  if (!isCustomer(req.user)) updated = await runAutomations('ticket_updated', updated);
  res.json({ data: decorate(await loadTicket(t.id, req.user)) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  if (!isAgent(req.user)) throw forbidden();
  if (!req.user.privileges.includes('delete_ticket')) throw forbidden('Your role does not allow deleting tickets');
  const t = await loadTicket(req.params.id, req.user);
  if (req.query.permanent === 'true' && req.user.role === 'admin') {
    await db.remove('tickets', t.id);
    return res.json({ ok: true, permanent: true });
  }
  await db.update('tickets', t.id, { deleted: true });
  await logActivity(t.id, req.user, 'deleted', {});
  res.json({ ok: true });
}));

router.post('/:id/restore', asyncHandler(async (req, res) => {
  if (!isAgent(req.user)) throw forbidden();
  await db.updateWhere('tickets', { id: req.params.id }, { deleted: false, spam: false });
  await logActivity(req.params.id, req.user, 'restored', {});
  res.json({ data: decorate(await loadTicket(req.params.id, req.user)) });
}));

// ---------------------------------------------------------------- conversations
async function addConversation(req, res, kind) {
  const t = await loadTicket(req.params.id, req.user);
  const b = normalizeBody(req.body);
  requireFields(b, ['body']);
  const agent = isAgent(req.user);
  if (!agent && kind !== 'reply') throw forbidden('Customers can only post replies');
  if (agent && kind !== 'note' && !req.user.privileges.includes('reply_ticket')) throw forbidden('Your role allows private notes only');
  const isPrivate = kind === 'note' ? (b.is_private === undefined ? true : toBool(b.is_private)) : false;

  const now = nowIso();
  const patch = {};
  if (agent && kind === 'reply') {
    if (!t.first_responded_at) patch.first_responded_at = now;
    const newStatus = STATUSES.includes(b.status) ? b.status : (t.status === 'open' ? 'pending' : t.status);
    if (newStatus !== t.status) {
      patch.status = newStatus;
      if (newStatus === 'resolved') patch.resolved_at = now;
      if (newStatus === 'closed') { patch.closed_at = now; patch.resolved_at = t.resolved_at || now; }
      if (!DONE.includes(newStatus)) { patch.resolved_at = null; patch.closed_at = null; }
    }
    if (!t.responder_id) patch.responder_id = req.user.id;
  } else if (!agent) {
    // Customer reply reopens the ticket and puts the SLA clock back on.
    if (t.status !== 'open') Object.assign(patch, { status: 'open', resolved_at: null, closed_at: null });
  } else if (kind === 'note' && STATUSES.includes(b.status) && b.status !== t.status) {
    patch.status = b.status;
    if (b.status === 'resolved') patch.resolved_at = now;
    if (b.status === 'closed') patch.closed_at = now;
  }
  patch.updated_at = now;

  // The ticket update does not depend on the new conversation id, so both go in one atomic batch.
  const [conv] = await db.batch([
    { op: 'insert', table: 'conversations', doc: { ticket_id: t.id, user_id: agent ? req.user.id : null, contact_id: agent ? null : req.user.id, kind, is_private: isPrivate, body: b.body, source: agent ? 'agent' : 'portal', to_emails: toArray(b.to_emails), cc_emails: toArray(b.cc_emails) } },
    { op: 'update', table: 'tickets', where: { id: t.id }, patch },
  ]);
  const attachments = await saveAttachments(req.files, { ticketId: t.id, conversationId: conv.id, user: req.user });
  await logActivity(t.id, req.user, kind === 'reply' ? (agent ? 'agent_replied' : 'customer_replied') : kind === 'note' ? 'note_added' : 'forwarded', { conversation_id: conv.id, status: b.status });

  if (agent && kind === 'reply') {
    await notifyContact(t.requester_id, { type: 'agent_reply', title: `New reply on your ticket #${t.id}`, body: t.subject, link: `/portal/tickets/${t.id}` });
    await sendTicketEmail('agent_reply_requester', t, { body: b.body });
  }
  if (kind === 'forward') {
    for (const to of toArray(b.to_emails)) await sendEmail({ to, subject: `Fwd: ${t.subject} [#${t.id}]`, body: `${b.body}\n\n---\n${t.description}`, ticketId: t.id });
  }
  if (!agent) {
    const payload = { type: 'customer_reply', title: `${req.user.name} replied on #${t.id}`, body: t.subject, link: `/tickets/${t.id}` };
    if (t.responder_id) await notifyUser(t.responder_id, payload); else await notifyGroup(t.group_id, payload);
    await sendTicketEmail('requester_reply_agent', t, { body: b.body });
  }
  if (kind === 'note') {
    const mentioned = toArray(b.notify_user_ids).map(Number).filter(Boolean);
    if (mentioned.length) await db.batch(mentioned.map((uid) => ({ op: 'upsert', table: 'ticket_mentions', where: { ticket_id: t.id, user_id: uid }, doc: { ticket_id: t.id, user_id: uid } })));
    await Promise.all(mentioned.filter((uid) => uid !== req.user.id).map((uid) => notifyUser(uid, { type: 'note_mention', title: `${req.user.name} left you a note on #${t.id}`, body: b.body.slice(0, 140), link: `/tickets/${t.id}` })));
  }
  const watchers = await db.find('ticket_watchers', { ticket_id: t.id });
  await Promise.all(watchers.filter((w) => w.user_id !== req.user.id).map((w) => notifyUser(w.user_id, { type: 'watched_ticket', title: `Activity on watched ticket #${t.id}`, body: `${req.user.name} added a ${kind}`, link: `/tickets/${t.id}` })));

  res.status(201).json({ data: { ...conv, attachments, user_name: agent ? req.user.name : null, contact_name: agent ? null : req.user.name }, ticket: decorate(await loadTicket(t.id, req.user)) });
}

router.post('/:id/reply', upload.array('attachments', 10), asyncHandler((req, res) => addConversation(req, res, 'reply')));
router.post('/:id/note', upload.array('attachments', 10), asyncHandler((req, res) => addConversation(req, res, 'note')));
router.post('/:id/forward', upload.array('attachments', 10), asyncHandler((req, res) => addConversation(req, res, 'forward')));

router.delete('/:id/conversations/:cid', asyncHandler(async (req, res) => {
  if (!isAgent(req.user)) throw forbidden();
  const removed = await db.removeWhere('conversations', { id: req.params.cid, ticket_id: req.params.id, kind: { ne: 'reply' } });
  if (!removed) throw badRequest('Only notes and forwards can be deleted');
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- attachments
router.post('/:id/attachments', upload.array('attachments', 10), asyncHandler(async (req, res) => {
  const t = await loadTicket(req.params.id, req.user);
  const saved = await saveAttachments(req.files, { ticketId: t.id, user: req.user });
  res.status(201).json({ data: saved });
}));

router.delete('/:id/attachments/:aid', asyncHandler(async (req, res) => {
  if (!isAgent(req.user)) throw forbidden();
  await db.removeWhere('attachments', { id: req.params.aid, ticket_id: req.params.id });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- activities
router.get('/:id/activities', asyncHandler(async (req, res) => {
  if (!isAgent(req.user)) throw forbidden();
  const rows = await db.find('ticket_activities', { ticket_id: req.params.id }, { order: [['created_at', 'desc'], ['id', 'desc']] });
  res.json({ data: rows });
}));

// ---------------------------------------------------------------- time tracking
router.post('/:id/time_entries', asyncHandler(async (req, res) => {
  if (!isAgent(req.user)) throw forbidden();
  const t = await loadTicket(req.params.id, req.user);
  const minutes = toInt(req.body.minutes);
  if (!minutes || minutes <= 0) throw badRequest('minutes must be a positive number');
  const row = await db.insert('time_entries', {
    ticket_id: t.id, user_id: req.user.id, minutes, note: req.body.note || null,
    billable: req.body.billable === undefined ? true : toBool(req.body.billable),
    started_at: req.body.started_at || nowIso(),
  });
  await logActivity(t.id, req.user, 'time_logged', { minutes });
  res.status(201).json({ data: { ...row, user_name: req.user.name } });
}));

router.delete('/:id/time_entries/:tid', asyncHandler(async (req, res) => {
  if (!isAgent(req.user)) throw forbidden();
  await db.removeWhere('time_entries', { id: req.params.tid, ticket_id: req.params.id });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- watchers
router.post('/:id/watch', asyncHandler(async (req, res) => {
  if (!isAgent(req.user)) throw forbidden();
  await db.upsert('ticket_watchers', { ticket_id: req.params.id, user_id: req.user.id }, { ticket_id: req.params.id, user_id: req.user.id });
  res.json({ ok: true, watching: true });
}));
router.delete('/:id/watch', asyncHandler(async (req, res) => {
  if (!isAgent(req.user)) throw forbidden();
  await db.removeWhere('ticket_watchers', { ticket_id: req.params.id, user_id: req.user.id });
  res.json({ ok: true, watching: false });
}));

// ---------------------------------------------------------------- merge
router.post('/:id/merge', asyncHandler(async (req, res) => {
  if (!isAgent(req.user)) throw forbidden();
  if (!req.user.privileges.includes('merge_split_ticket')) throw forbidden('Your role does not allow merging tickets');
  const primary = await loadTicket(req.params.id, req.user);
  const ids = toArray(req.body.ticket_ids).map(Number).filter((n) => n && n !== primary.id);
  if (!ids.length) throw badRequest('ticket_ids required');
  const r = await db.fetch({
    secs: ['tickets', { id: { in: uniq(ids) } }],
    convs: ['conversations', { ticket_id: { in: uniq(ids) } }, { order: [['created_at', 'asc'], ['id', 'asc']] }],
  });
  const secs = indexBy(r.secs);
  const convsBy = groupBy(r.convs, 'ticket_id');
  const now = nowIso();
  // Nothing here depends on generated ids, so the whole merge is one atomic batch.
  const ops = [];
  for (const id of ids) {
    const sec = secs.get(id);
    if (!sec) continue;
    ops.push({ op: 'insert', table: 'conversations', doc: { ticket_id: primary.id, user_id: req.user.id, kind: 'note', is_private: true, body: `Merged from ticket #${sec.id} "${sec.subject}":\n\n${sec.description}`, source: 'merge' } });
    for (const cv of convsBy.get(sec.id) || []) {
      ops.push({ op: 'insert', table: 'conversations', doc: { ticket_id: primary.id, user_id: cv.user_id, contact_id: cv.contact_id, kind: cv.kind, is_private: true, body: `[From #${sec.id}] ${cv.body}`, source: cv.source, created_at: cv.created_at } });
    }
    ops.push({ op: 'update', table: 'attachments', where: { ticket_id: sec.id }, patch: { ticket_id: primary.id } });
    ops.push({ op: 'update', table: 'tickets', where: { id: sec.id }, patch: { status: 'closed', closed_at: now, resolved_at: sec.resolved_at || now, merged_into_ticket_id: primary.id } });
    ops.push({ op: 'insert', table: 'ticket_activities', doc: activityDoc(sec.id, req.user, 'merged', { into: primary.id }) });
  }
  ops.push({ op: 'insert', table: 'ticket_activities', doc: activityDoc(primary.id, req.user, 'merge_target', { from: ids }) });
  await db.batch(ops);
  res.json({ data: decorate(await loadTicket(primary.id, req.user)) });
}));

// ---------------------------------------------------------------- satisfaction
router.post('/:id/satisfaction', asyncHandler(async (req, res) => {
  const t = await loadTicket(req.params.id, req.user);
  const survey = await db.findOne('surveys', { is_active: true }, { order: 'id' });
  const labels = survey?.labels?.length >= 2 ? survey.labels : ['1', '2', '3', '4', '5'];
  const answer = toInt(req.body.rating);
  if (!answer || answer < 1 || answer > labels.length) throw badRequest(`rating must be 1-${labels.length}`);
  // Stored on a common 1-5 scale so reports stay comparable across surveys.
  const rating = Math.round(1 + ((answer - 1) * 4) / (labels.length - 1));
  if (isAgent(req.user)) throw forbidden('Only the requester can rate a ticket');
  if (!DONE.includes(t.status)) throw badRequest('You can rate a ticket once it is resolved');
  const fields = { rating, feedback: req.body.feedback || null, survey_id: survey?.id || null, answer: labels[answer - 1] };
  const { row } = await db.upsert(
    'satisfaction_ratings',
    { ticket_id: t.id },
    { ticket_id: t.id, contact_id: req.user.id, agent_id: t.responder_id, ...fields },
    { ...fields, created_at: nowIso() },
  );
  await logActivity(t.id, req.user, 'rated', { rating });
  if (t.responder_id) await notifyUser(t.responder_id, { type: 'csat', title: `${req.user.name} rated ticket #${t.id}: ${rating}/5`, body: req.body.feedback || '', link: `/tickets/${t.id}` });
  res.status(201).json({ data: row });
}));

export default router;
