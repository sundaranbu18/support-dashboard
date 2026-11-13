import { Router } from 'express';
import { db, indexBy, localDay, sortRows } from '../db/index.js';
import { authenticate, requireAgent } from '../middleware/auth.js';
import { asyncHandler } from '../utils/errors.js';
import { slaStatus } from '../utils/sla.js';
import { toInt } from '../utils/helpers.js';

const router = Router();
router.use(authenticate, requireAgent);

// ------------------------------------------------------------------ aggregation helpers (Postgres semantics)
const ms = (v) => (v === null || v === undefined ? null : new Date(v).getTime());
function round(x, d) {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  const f = 10 ** d;
  return (Math.sign(x) * Math.round(Number((Math.abs(x) * f).toPrecision(12)))) / f;
}
function avg(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}
const countWhere = (rows, f) => rows.reduce((n, r) => n + (f(r) ? 1 : 0), 0);
const isUnresolved = (t) => t.status !== 'resolved' && t.status !== 'closed';
const inWindow = (v, from, to) => v != null && ms(v) >= from && ms(v) < to;
function groupCount(rows, f) {
  const m = new Map();
  for (const r of rows) { const k = f(r); m.set(k, (m.get(k) || 0) + 1); }
  return [...m].map(([label, value]) => ({ label, value }));
}
// Local midnight `offset` days from today (CURRENT_DATE + offset as a timestamp).
const localMidnight = (offset = 0) => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate() + offset); };

// "My Dashboard" header: tiles and today's trend, filterable by group and product.
router.get('/today', asyncHandler(async (req, res) => {
  const scope = { deleted: false, spam: false, archived: false };
  if (toInt(req.query.group_id)) scope.group_id = toInt(req.query.group_id);
  if (toInt(req.query.product_id)) scope.product_id = toInt(req.query.product_id);
  const now = Date.now();
  const d = await db.fetch({
    tickets: ['tickets', scope],
    groups: ['groups', undefined, { select: ['id', 'name'] }],
    failed: ['email_outbox', { status: 'failed', created_at: { gt: new Date(now - 30 * 86400000) } }, { select: ['id'] }],
  });
  const tickets = d.tickets;
  const today = localDay(new Date());
  const tiles = {
    unresolved: countWhere(tickets, isUnresolved),
    overdue: countWhere(tickets, (t) => isUnresolved(t) && t.due_by != null && ms(t.due_by) < now),
    due_today: countWhere(tickets, (t) => isUnresolved(t) && t.due_by != null && localDay(t.due_by) === today),
    open: countWhere(tickets, (t) => t.status === 'open'),
    on_hold: countWhere(tickets, (t) => t.status !== 'open' && isUnresolved(t)),
    unassigned: countWhere(tickets, (t) => isUnresolved(t) && t.responder_id == null),
  };

  const [yStart, tStart, tEnd] = [localMidnight(-1).getTime(), localMidnight(0).getTime(), localMidnight(1).getTime()];
  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, today: 0, yesterday: 0 }));
  for (const t of tickets) {
    const c = ms(t.created_at);
    if (c >= tStart && c < tEnd) hourly[new Date(c).getHours()].today += 1;
    else if (c >= yStart && c < tStart) hourly[new Date(c).getHours()].yesterday += 1;
  }

  const dayStats = (from, to) => {
    const resolvedIn = tickets.filter((t) => inWindow(t.resolved_at, from, to));
    const fr = avg(tickets.filter((t) => inWindow(t.first_responded_at, from, to)).map((t) => (ms(t.first_responded_at) - ms(t.created_at)) / 1000));
    return {
      received: countWhere(tickets, (t) => inWindow(t.created_at, from, to)),
      resolved: resolvedIn.length,
      avg_first_response_minutes: fr === null ? null : round(fr / 60, 1),
      sla_pct: resolvedIn.length ? round((100 * countWhere(resolvedIn, (t) => t.due_by != null && ms(t.resolved_at) <= ms(t.due_by))) / resolvedIn.length, 1) : null,
    };
  };

  const groups = indexBy(d.groups);
  const byGroupMap = new Map();
  for (const t of tickets) {
    if (!isUnresolved(t)) continue;
    const g = t.group_id != null ? groups.get(t.group_id) : null;
    const key = g ? g.id : null;
    if (!byGroupMap.has(key)) byGroupMap.set(key, { name: g ? g.name : 'No group', id: g ? g.id : null, open: 0, unresolved: 0 });
    const row = byGroupMap.get(key);
    if (t.status === 'open') row.open += 1;
    row.unresolved += 1;
  }
  const byGroup = [...byGroupMap.values()].sort((a, b) => b.unresolved - a.unresolved).slice(0, 8);

  res.json({
    data: {
      tiles, hourly, today: dayStats(tStart, tEnd), yesterday: dayStats(yStart, tStart), by_group: byGroup,
      undelivered: d.failed.length,
    },
  });
}));

router.get('/', asyncHandler(async (req, res) => {
  const me = req.user.id;
  const now = Date.now();
  const d = await db.fetch({
    tickets: ['tickets', { deleted: false }, {
      select: ['id', 'subject', 'status', 'priority', 'due_by', 'first_responded_at', 'fr_due_by', 'resolved_at', 'updated_at', 'created_at',
        'requester_id', 'responder_id', 'group_id', 'spam'],
    }],
    activities: ['ticket_activities', undefined, { order: [['created_at', 'desc']], limit: 200 }],
    contacts: ['contacts', undefined, { select: ['id', 'name'] }],
    users: ['users', undefined, { select: ['id', 'name', 'avatar_url', 'is_active'] }],
    groups: ['groups', undefined, { select: ['id', 'name'] }],
    ratings: ['satisfaction_ratings', { created_at: { gt: new Date(now - 30 * 86400000) } }, { select: ['id', 'rating', 'created_at'] }],
  });
  const notDeleted = d.tickets;
  const live = notDeleted.filter((t) => !t.spam);
  const contacts = indexBy(d.contacts), users = indexBy(d.users), groups = indexBy(d.groups);
  const today = localDay(new Date());

  const counts = {
    unresolved: countWhere(live, isUnresolved),
    open: countWhere(live, (t) => t.status === 'open'),
    on_hold: countWhere(live, (t) => t.status !== 'open' && isUnresolved(t)),
    overdue: countWhere(live, (t) => isUnresolved(t) && t.due_by != null && ms(t.due_by) < now),
    due_today: countWhere(live, (t) => isUnresolved(t) && t.due_by != null && localDay(t.due_by) === today),
    unassigned: countWhere(live, (t) => isUnresolved(t) && t.responder_id == null),
    my_open: countWhere(live, (t) => isUnresolved(t) && t.responder_id === me),
    created_today: countWhere(live, (t) => localDay(t.created_at) === today),
    resolved_today: countWhere(live, (t) => t.resolved_at != null && localDay(t.resolved_at) === today),
    awaiting_first_response_overdue: countWhere(live, (t) => t.status === 'open' && t.first_responded_at == null && t.fr_due_by != null && ms(t.fr_due_by) < now),
    urgent_open: countWhere(live, (t) => t.priority === 'urgent' && isUnresolved(t)),
  };

  const createdBy = new Map(), resolvedBy = new Map();
  for (const t of live) {
    const c = localDay(t.created_at);
    createdBy.set(c, (createdBy.get(c) || 0) + 1);
    if (t.resolved_at) { const r = localDay(t.resolved_at); resolvedBy.set(r, (resolvedBy.get(r) || 0) + 1); }
  }
  // generate_series(CURRENT_DATE - 13, CURRENT_DATE); pg returned DATE values as local-midnight Dates.
  const trend = Array.from({ length: 14 }, (_, i) => {
    const day = localMidnight(i - 13);
    const key = localDay(day);
    return { day: day.toISOString(), created: createdBy.get(key) || 0, resolved: resolvedBy.get(key) || 0 };
  });

  // Recent activity on non-deleted tickets; fall back to the full table if the first page was mostly deleted tickets.
  const subjectById = new Map(notDeleted.map((t) => [t.id, t.subject]));
  const pickRecent = (rows) => rows.filter((a) => subjectById.has(a.ticket_id)).slice(0, 15).map((a) => ({ ...a, subject: subjectById.get(a.ticket_id) }));
  let recentActivity = pickRecent(d.activities);
  if (recentActivity.length < 15 && d.activities.length >= 200) {
    recentActivity = pickRecent(await db.find('ticket_activities', undefined, { order: [['created_at', 'desc']] }));
  }

  const openLive = live.filter((t) => isUnresolved(t) && contacts.has(t.requester_id));
  const base = (t) => ({
    id: t.id, subject: t.subject, status: t.status, priority: t.priority, due_by: t.due_by,
    first_responded_at: t.first_responded_at, fr_due_by: t.fr_due_by, resolved_at: t.resolved_at,
  });
  const requester = (t) => contacts.get(t.requester_id)?.name ?? null;
  const myTickets = sortRows(openLive.filter((t) => t.responder_id === me), [['due_by', 'asc']]).slice(0, 8)
    .map((t) => ({ ...base(t), updated_at: t.updated_at, requester_name: requester(t) }));
  const overdue = sortRows(openLive.filter((t) => t.due_by != null && ms(t.due_by) < now), [['due_by', 'asc']]).slice(0, 8)
    .map((t) => ({ ...base(t), requester_name: requester(t), responder_name: users.get(t.responder_id)?.name ?? null }));
  const unassigned = sortRows(openLive.filter((t) => t.responder_id == null), [['created_at', 'desc']]).slice(0, 8)
    .map((t) => ({ ...base(t), created_at: t.created_at, requester_name: requester(t), group_name: groups.get(t.group_id)?.name ?? null }));

  const rs = d.ratings.filter((r) => ms(r.created_at) > now - 30 * 86400000);
  const csat = {
    responses: rs.length,
    avg_rating: round(avg(rs.map((r) => r.rating)), 2),
    positive: countWhere(rs, (r) => r.rating >= 4),
  };
  const byStatus = groupCount(live, (t) => t.status);
  const byPriority = groupCount(live.filter(isUnresolved), (t) => t.priority);

  // Agent load counts open tickets that are not deleted (spam included, as before).
  const loadBy = new Map();
  for (const t of notDeleted) if (isUnresolved(t) && t.responder_id != null) loadBy.set(t.responder_id, (loadBy.get(t.responder_id) || 0) + 1);
  const agentLoad = sortRows(
    d.users.filter((u) => u.is_active).map((u) => ({ id: u.id, name: u.name, avatar_url: u.avatar_url, open: loadBy.get(u.id) || 0 })),
    [['open', 'desc'], ['name', 'asc']],
  ).slice(0, 8);

  const dec = (rows) => rows.map((t) => ({ ...t, sla_status: slaStatus(t) }));
  res.json({
    data: {
      counts, trend, recent_activity: recentActivity, my_tickets: dec(myTickets), overdue: dec(overdue), unassigned: dec(unassigned),
      csat: { ...csat, score_pct: Number(csat.responses) ? Math.round((Number(csat.positive) / Number(csat.responses)) * 100) : null },
      by_status: byStatus, by_priority: byPriority, agent_load: agentLoad,
    },
  });
}));

export default router;
