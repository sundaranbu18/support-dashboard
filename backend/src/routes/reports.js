import { Router } from 'express';
import { db, indexBy, groupBy, localDay, sortRows } from '../db/index.js';
import { authenticate, requireAgent, requirePrivilege } from '../middleware/auth.js';
import { asyncHandler } from '../utils/errors.js';

const router = Router();
router.use(authenticate, requireAgent, requirePrivilege('view_reports'));

function range(q) {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 29 * 86400000);
  to.setHours(23, 59, 59, 999);
  from.setHours(0, 0, 0, 0);
  return { from, to };
}

// ------------------------------------------------------------------ aggregation helpers (Postgres semantics)
const ms = (v) => (v === null || v === undefined ? null : new Date(v).getTime());
// ROUND(numeric, d): half away from zero; toPrecision guards against binary float noise (1.005 -> 1.01).
function round(x, d) {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  const f = 10 ** d;
  return (Math.sign(x) * Math.round(Number((Math.abs(x) * f).toPrecision(12)))) / f;
}
// AVG ignores NULLs; NULL when nothing to average.
function avg(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}
function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = 0.5 * (v.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
const hoursBetween = (a, b) => (a && b ? (ms(b) - ms(a)) / 3600000 : null);
const frHours = (t) => hoursBetween(t.created_at, t.first_responded_at);
const resHours = (t) => hoursBetween(t.created_at, t.resolved_at);
const isUnresolved = (t) => t.status !== 'resolved' && t.status !== 'closed';
const resolvedInSla = (t) => t.resolved_at != null && t.due_by != null && ms(t.resolved_at) <= ms(t.due_by);
const between = (v, from, to) => v != null && ms(v) >= from.getTime() && ms(v) <= to.getTime();
const countWhere = (rows, f) => rows.reduce((n, r) => n + (f(r) ? 1 : 0), 0);
// GROUP BY expression -> [{ label, value }] in first-seen order.
function groupCount(rows, f) {
  const m = new Map();
  for (const r of rows) { const k = f(r); m.set(k, (m.get(k) || 0) + 1); }
  return [...m].map(([label, value]) => ({ label, value }));
}
const byValueDesc = (rows) => rows.sort((a, b) => b.value - a.value);
// Postgres DATE values were returned by pg as JS Dates at local midnight (serialized as ISO strings).
const dayValue = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
function daySeries(from, to) {
  const out = [];
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) out.push(d);
  return out;
}

const liveTickets = { deleted: false, spam: false };

router.get('/overview', asyncHandler(async (req, res) => {
  const { from, to } = range(req.query);
  const { tickets: live, replies, ratings } = await db.fetch({
    tickets: ['tickets', liveTickets],
    replies: ['conversations', { kind: 'reply' }, { select: ['id', 'ticket_id'] }],
    ratings: ['satisfaction_ratings', { created_at: { gte: from, lte: to } }],
  });
  const tickets = live.filter((t) => between(t.created_at, from, to));
  const replyCount = new Map();
  for (const c of replies) replyCount.set(c.ticket_id, (replyCount.get(c.ticket_id) || 0) + 1);

  const totals = {
    created: tickets.length,
    resolved: countWhere(tickets, (t) => t.resolved_at != null),
    unresolved: countWhere(tickets, isUnresolved),
    closed: countWhere(tickets, (t) => t.status === 'closed'),
    escalated: countWhere(tickets, (t) => t.is_escalated === true),
    avg_first_response_hours: round(avg(tickets.map(frHours)), 2),
    avg_resolution_hours: round(avg(tickets.map(resHours)), 2),
    median_resolution_hours: round(median(tickets.map(resHours)), 2),
    avg_replies: round(avg(tickets.map((t) => replyCount.get(t.id) || 0)), 2),
  };
  const byStatus = groupCount(tickets, (t) => t.status);
  const byPriority = groupCount(tickets, (t) => t.priority);
  const byType = byValueDesc(groupCount(tickets, (t) => t.type ?? 'unset'));
  const bySource = byValueDesc(groupCount(tickets, (t) => t.source));

  const createdByDay = new Map(), resolvedByDay = new Map();
  for (const t of live) {
    const c = localDay(t.created_at);
    createdByDay.set(c, (createdByDay.get(c) || 0) + 1);
    if (t.resolved_at) { const r = localDay(t.resolved_at); resolvedByDay.set(r, (resolvedByDay.get(r) || 0) + 1); }
  }
  const trend = daySeries(from, to).map((d) => {
    const key = localDay(d);
    return { day: dayValue(d), created: createdByDay.get(key) || 0, resolved: resolvedByDay.get(key) || 0 };
  });

  const now = Date.now();
  const sla = {
    responded: countWhere(tickets, (t) => t.first_responded_at != null),
    responded_in_sla: countWhere(tickets, (t) => t.first_responded_at != null && t.fr_due_by != null && ms(t.first_responded_at) <= ms(t.fr_due_by)),
    resolved: countWhere(tickets, (t) => t.resolved_at != null),
    resolved_in_sla: countWhere(tickets, resolvedInSla),
    currently_overdue: countWhere(tickets, (t) => isUnresolved(t) && t.due_by != null && ms(t.due_by) < now),
  };
  const rs = ratings.filter((r) => between(r.created_at, from, to));
  const csat = {
    responses: rs.length,
    avg_rating: round(avg(rs.map((r) => r.rating)), 2),
    positive: countWhere(rs, (r) => r.rating >= 4),
    neutral: countWhere(rs, (r) => r.rating === 3),
    negative: countWhere(rs, (r) => r.rating <= 2),
  };
  const byHour = groupCount(tickets, (t) => new Date(t.created_at).getHours()).map(({ label, value }) => ({ hour: label, value })).sort((a, b) => a.hour - b.hour);
  const byWeekday = groupCount(tickets, (t) => new Date(t.created_at).getDay() || 7).map(({ label, value }) => ({ weekday: label, value })).sort((a, b) => a.weekday - b.weekday);

  const pct = (a, b) => (Number(b) ? Math.round((Number(a) / Number(b)) * 1000) / 10 : null);
  res.json({
    data: {
      range: { from, to },
      totals,
      by_status: byStatus, by_priority: byPriority, by_type: byType, by_source: bySource,
      trend,
      sla: { ...sla, first_response_pct: pct(sla.responded_in_sla, sla.responded), resolution_pct: pct(sla.resolved_in_sla, sla.resolved) },
      csat: { ...csat, score_pct: pct(csat.positive, csat.responses) },
      by_hour: byHour, by_weekday: byWeekday,
    },
  });
}));

router.get('/agents', asyncHandler(async (req, res) => {
  const { from, to } = range(req.query);
  const span = { gte: from, lte: to };
  const d = await db.fetch({
    users: ['users', { is_active: true }, { select: ['id', 'name', 'avatar_url', 'role'] }],
    tickets: ['tickets', { ...liveTickets, created_at: span, responder_id: { isNull: false } }],
    replies: ['conversations', { kind: 'reply', created_at: span, user_id: { isNull: false } }, { select: ['id', 'user_id', 'created_at'] }],
    ratings: ['satisfaction_ratings', { created_at: span, agent_id: { isNull: false } }],
    entries: ['time_entries', { started_at: span, user_id: { isNull: false } }],
  });
  const ticketsBy = groupBy(d.tickets.filter((t) => between(t.created_at, from, to)), 'responder_id');
  const repliesBy = groupBy(d.replies.filter((c) => between(c.created_at, from, to)), 'user_id');
  const ratingsBy = groupBy(d.ratings.filter((r) => between(r.created_at, from, to)), 'agent_id');
  const entriesBy = groupBy(d.entries.filter((e) => between(e.started_at, from, to)), 'user_id');
  const rows = d.users.map((u) => {
    const ts = ticketsBy.get(u.id) || [];
    const rs = ratingsBy.get(u.id) || [];
    return {
      id: u.id, name: u.name, avatar_url: u.avatar_url, role: u.role,
      assigned: ts.length,
      resolved: countWhere(ts, (t) => t.resolved_at != null),
      open: countWhere(ts, isUnresolved),
      resolved_in_sla: countWhere(ts, resolvedInSla),
      avg_first_response_hours: round(avg(ts.map(frHours)), 2),
      avg_resolution_hours: round(avg(ts.map(resHours)), 2),
      replies: (repliesBy.get(u.id) || []).length,
      csat: round(avg(rs.map((r) => r.rating)), 2),
      csat_responses: rs.length,
      minutes_logged: (entriesBy.get(u.id) || []).reduce((s, e) => s + Number(e.minutes || 0), 0),
    };
  });
  res.json({ data: sortRows(rows, [['resolved', 'desc'], ['name', 'asc']]) });
}));

router.get('/groups', asyncHandler(async (req, res) => {
  const { from, to } = range(req.query);
  const d = await db.fetch({
    groups: ['groups', undefined, { select: ['id', 'name'] }],
    tickets: ['tickets', { ...liveTickets, created_at: { gte: from, lte: to }, group_id: { isNull: false } }],
  });
  const ticketsBy = groupBy(d.tickets.filter((t) => between(t.created_at, from, to)), 'group_id');
  const now = Date.now();
  const rows = d.groups.map((g) => {
    const ts = ticketsBy.get(g.id) || [];
    return {
      id: g.id, name: g.name,
      assigned: ts.length,
      resolved: countWhere(ts, (t) => t.resolved_at != null),
      open: countWhere(ts, isUnresolved),
      overdue: countWhere(ts, (t) => isUnresolved(t) && t.due_by != null && ms(t.due_by) < now),
      avg_first_response_hours: round(avg(ts.map(frHours)), 2),
      avg_resolution_hours: round(avg(ts.map(resHours)), 2),
    };
  });
  res.json({ data: sortRows(rows, [['name', 'asc']]) });
}));

router.get('/companies', asyncHandler(async (req, res) => {
  const { from, to } = range(req.query);
  const d = await db.fetch({
    companies: ['companies', undefined, { select: ['id', 'name', 'health_score', 'account_tier'] }],
    tickets: ['tickets', { company_id: { isNull: false } }, { select: ['id', 'company_id', 'deleted', 'spam', 'created_at', 'status', 'priority', 'resolved_at'] }],
    ratings: ['satisfaction_ratings', undefined, { select: ['id', 'ticket_id', 'rating'] }],
  });
  const ticketById = indexBy(d.tickets);
  const ticketsBy = groupBy(d.tickets.filter((t) => !t.deleted && !t.spam && between(t.created_at, from, to)), 'company_id');
  const ratingsBy = new Map();
  for (const r of d.ratings) {
    const t = ticketById.get(r.ticket_id);
    if (!t) continue;
    if (!ratingsBy.has(t.company_id)) ratingsBy.set(t.company_id, []);
    ratingsBy.get(t.company_id).push(r.rating);
  }
  const rows = d.companies.map((co) => {
    const ts = ticketsBy.get(co.id) || [];
    return {
      id: co.id, name: co.name, health_score: co.health_score, account_tier: co.account_tier,
      tickets: ts.length,
      open: countWhere(ts, isUnresolved),
      high_priority: countWhere(ts, (t) => t.priority === 'high' || t.priority === 'urgent'),
      avg_resolution_hours: round(avg(ts.map(resHours)), 2),
      csat: round(avg(ratingsBy.get(co.id) || []), 2),
    };
  });
  res.json({ data: sortRows(rows, [['tickets', 'desc'], ['name', 'asc']]).slice(0, 50) });
}));

router.get('/tags', asyncHandler(async (req, res) => {
  const { from, to } = range(req.query);
  const tickets = await db.find('tickets', { ...liveTickets, created_at: { gte: from, lte: to } }, { select: ['id', 'created_at', 'tags'] });
  const counts = new Map();
  for (const t of tickets) {
    if (!between(t.created_at, from, to)) continue;
    for (const tag of t.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  const rows = byValueDesc([...counts].map(([label, value]) => ({ label, value }))).slice(0, 20);
  res.json({ data: rows });
}));

router.get('/satisfaction', asyncHandler(async (req, res) => {
  const { from, to } = range(req.query);
  const d = await db.fetch({
    ratings: ['satisfaction_ratings', { created_at: { gte: from, lte: to } }],
    tickets: ['tickets', undefined, { select: ['id', 'subject'] }],
    contacts: ['contacts', undefined, { select: ['id', 'name'] }],
    users: ['users', undefined, { select: ['id', 'name'] }],
  });
  const ratings = d.ratings.filter((r) => between(r.created_at, from, to));
  const distribution = groupCount(ratings, (r) => r.rating).sort((a, b) => a.label - b.label);
  const tickets = indexBy(d.tickets), contacts = indexBy(d.contacts), users = indexBy(d.users);
  const recent = sortRows(ratings.filter((r) => tickets.has(r.ticket_id)), [['created_at', 'desc']])
    .slice(0, 30)
    .map((r) => ({
      ...r,
      subject: tickets.get(r.ticket_id).subject,
      contact_name: contacts.get(r.contact_id)?.name ?? null,
      agent_name: users.get(r.agent_id)?.name ?? null,
    }));
  res.json({ data: { distribution, recent } });
}));

router.get('/time-tracking', asyncHandler(async (req, res) => {
  const { from, to } = range(req.query);
  const d = await db.fetch({
    users: ['users', { is_active: true }, { select: ['id', 'name'] }],
    entries: ['time_entries', { started_at: { gte: from, lte: to }, user_id: { isNull: false } }],
  });
  const entriesBy = groupBy(d.entries.filter((e) => between(e.started_at, from, to)), 'user_id');
  const rows = d.users.map((u) => {
    const es = entriesBy.get(u.id) || [];
    return {
      id: u.id, name: u.name,
      minutes: es.reduce((s, e) => s + Number(e.minutes || 0), 0),
      billable_minutes: es.filter((e) => e.billable).reduce((s, e) => s + Number(e.minutes || 0), 0),
      tickets: new Set(es.map((e) => e.ticket_id).filter((x) => x != null)).size,
    };
  });
  res.json({ data: sortRows(rows, [['minutes', 'desc']]) });
}));

export default router;
