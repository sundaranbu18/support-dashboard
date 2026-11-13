import { Router } from 'express';
import { db, indexBy, groupBy, localDay, sortRows } from '../db/index.js';
import { authenticate, requireAgent, requirePrivilege } from '../middleware/auth.js';
import { asyncHandler, badRequest, notFound } from '../utils/errors.js';
import { requireFields, toArray } from '../utils/helpers.js';
import { toCsv, sendCsv } from '../utils/csv.js';
import { sendEmail } from '../utils/email.js';

const router = Router();

// ------------------------------------------------------------------ aggregation helpers (Postgres semantics)
const ms = (v) => (v === null || v === undefined ? null : new Date(v).getTime());
// ROUND(numeric, d): half away from zero; toPrecision guards against binary float noise.
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
const secondsBetween = (a, b) => (a && b ? (ms(b) - ms(a)) / 1000 : null);
const pad2 = (n) => String(n).padStart(2, '0');
function invalidInput(msg) {
  const e = new Error(msg);
  e.code = '22P02';
  return e;
}
// Text -> timestamptz the way Postgres reads it in the server time zone (date-only = local midnight).
function parseTs(v) {
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid input syntax for type timestamp with time zone: "${s}"`);
  return d;
}
// $x::date + INTERVAL '1 day' -> local midnight of the following day.
function dayAfter(v) {
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
  const d = parseTs(s);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

// Allow-lists: report configs are user input, so only these metrics/dimensions are ever computed.
// Each metric aggregates one group of tickets; ctx holds per-ticket lookups loaded for the report.
const METRICS = {
  tickets_created: { label: 'Tickets created', calc: (ts) => ts.length },
  tickets_resolved: { label: 'Tickets resolved', calc: (ts) => countWhere(ts, (t) => t.resolved_at != null) },
  tickets_unresolved: { label: 'Unresolved tickets', calc: (ts) => countWhere(ts, (t) => t.status !== 'resolved' && t.status !== 'closed') },
  avg_first_response_hours: { label: 'Avg first response (hours)', calc: (ts) => { const a = avg(ts.map((t) => secondsBetween(t.created_at, t.first_responded_at))); return a === null ? null : round(a / 3600, 2); } },
  avg_resolution_hours: { label: 'Avg resolution (hours)', calc: (ts) => { const a = avg(ts.map((t) => secondsBetween(t.created_at, t.resolved_at))); return a === null ? null : round(a / 3600, 2); } },
  sla_compliance_pct: {
    label: 'Resolved within SLA (%)',
    calc: (ts) => {
      const resolved = countWhere(ts, (t) => t.resolved_at != null);
      if (!resolved) return null;
      const inSla = countWhere(ts, (t) => t.resolved_at != null && t.due_by != null && ms(t.resolved_at) <= ms(t.due_by));
      return round((100 * inSla) / resolved, 1);
    },
  },
  avg_csat: { label: 'Average CSAT (1-5)', needs: 'ratings', calc: (ts, ctx) => round(avg(ts.map((t) => ctx.ratingByTicket.get(t.id) ?? null)), 2) },
  time_spent_hours: { label: 'Time logged (hours)', needs: 'entries', calc: (ts, ctx) => round(ts.reduce((s, t) => s + (ctx.minutesByTicket.get(t.id) || 0), 0) / 60, 1) },
};
const nameOr = (map, id, fallback) => map.get(id)?.name ?? fallback;
const DIMENSIONS = {
  status: { label: 'Status', key: (t) => t.status },
  priority: { label: 'Priority', key: (t) => t.priority },
  type: { label: 'Type', key: (t) => t.type ?? 'none' },
  source: { label: 'Source', key: (t) => t.source },
  group: { label: 'Group', needs: 'groups', key: (t, ctx) => nameOr(ctx.groups, t.group_id, 'No group') },
  agent: { label: 'Agent', needs: 'users', key: (t, ctx) => nameOr(ctx.users, t.responder_id, 'Unassigned') },
  company: { label: 'Company', needs: 'companies', key: (t, ctx) => nameOr(ctx.companies, t.company_id, 'No company') },
  product: { label: 'Product', needs: 'products', key: (t, ctx) => nameOr(ctx.products, t.product_id, 'No product') },
  day: { label: 'Day', key: (t) => localDay(t.created_at) },
  week: {
    label: 'Week',
    key: (t) => {
      const d = new Date(t.created_at);
      const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() || 7) - 1));
      return localDay(monday);
    },
  },
  month: { label: 'Month', key: (t) => localDay(t.created_at).slice(0, 7) },
  hour: { label: 'Hour of day', key: (t) => pad2(new Date(t.created_at).getHours()) },
};
const TIME_DIMENSIONS = ['day', 'week', 'month', 'hour'];

export async function runReport(config = {}) {
  config = config || {};
  const metrics = toArray(config.metrics).filter((m) => METRICS[m]);
  const dimension = DIMENSIONS[config.dimension];
  if (!metrics.length || !dimension) throw badRequest('Choose at least one metric and one dimension');

  // Ticket filters (same predicates as the old WHERE clause).
  const filters = [];
  if (config.from) { const from = parseTs(config.from).getTime(); filters.push((t) => ms(t.created_at) >= from); }
  if (config.to) { const end = dayAfter(config.to).getTime(); filters.push((t) => ms(t.created_at) < end); }
  if (config.days && !config.from) {
    const days = Number(config.days);
    if (!Number.isFinite(days)) throw new Error(`invalid input syntax for type interval: "${String(days)} days"`);
    const since = Date.now() - days * 86400000;
    filters.push((t) => ms(t.created_at) >= since);
  }
  for (const [key, col, cast] of [['status', 'status', 'text'], ['priority', 'priority', 'text'], ['group_id', 'group_id', 'int'], ['responder_id', 'responder_id', 'int'], ['product_id', 'product_id', 'int']]) {
    const v = toArray(config[key]);
    if (!v.length) continue;
    if (cast === 'int') {
      const ids = v.map(Number);
      if (ids.some((n) => !Number.isInteger(n))) throw invalidInput('invalid input syntax for type integer');
      const set = new Set(ids);
      filters.push((t) => t[col] != null && set.has(t[col]));
    } else {
      const set = new Set(v.map(String));
      filters.push((t) => t[col] != null && set.has(t[col]));
    }
  }

  const needs = new Set([dimension.needs, ...metrics.map((m) => METRICS[m].needs)].filter(Boolean));
  const req = { tickets: ['tickets', { deleted: false, spam: false }] };
  if (needs.has('users')) req.users = ['users', undefined, { select: ['id', 'name'] }];
  if (needs.has('groups')) req.groups = ['groups', undefined, { select: ['id', 'name'] }];
  if (needs.has('companies')) req.companies = ['companies', undefined, { select: ['id', 'name'] }];
  if (needs.has('products')) req.products = ['products', undefined, { select: ['id', 'name'] }];
  if (needs.has('ratings')) req.ratings = ['satisfaction_ratings', undefined, { select: ['id', 'ticket_id', 'rating'] }];
  if (needs.has('entries')) req.entries = ['time_entries', undefined, { select: ['id', 'ticket_id', 'minutes'] }];
  const d = await db.fetch(req);

  const ctx = {
    users: indexBy(d.users || []),
    groups: indexBy(d.groups || []),
    companies: indexBy(d.companies || []),
    products: indexBy(d.products || []),
    ratingByTicket: new Map((d.ratings || []).map((r) => [r.ticket_id, r.rating])),
    minutesByTicket: new Map(),
  };
  for (const e of d.entries || []) ctx.minutesByTicket.set(e.ticket_id, (ctx.minutesByTicket.get(e.ticket_id) || 0) + Number(e.minutes || 0));

  const tickets = d.tickets.filter((t) => filters.every((f) => f(t)));
  const groups = groupBy(tickets, (t) => dimension.key(t, ctx));
  let rows = [...groups].map(([label, ts]) => {
    const row = { label };
    for (const m of metrics) row[m] = METRICS[m].calc(ts, ctx);
    return row;
  });
  if (TIME_DIMENSIONS.includes(config.dimension)) {
    rows = sortRows(rows, [['label', 'asc']]);
  } else {
    const k = metrics[0];
    rows.sort((a, b) => {
      const x = a[k], y = b[k];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return y - x;
    });
  }
  return { rows: rows.slice(0, 200), metrics, columns: ['label', ...metrics] };
}

// Emails each due report as CSV. Called hourly by the job runner.
export async function sendScheduledReports() {
  const all = await db.find('saved_reports', { schedule: { isNull: false } });
  const now = Date.now();
  const due = all.filter((r) => Array.isArray(r.recipients) && r.recipients.length > 0 && (
    r.last_sent_at == null
    || (r.schedule === 'daily' && ms(r.last_sent_at) < now - 86400000)
    || (r.schedule === 'weekly' && ms(r.last_sent_at) < now - 7 * 86400000)
  ));
  for (const r of due) {
    const { rows, columns } = await runReport(r.config);
    for (const to of r.recipients) await sendEmail({ to, subject: `Scheduled report: ${r.name}`, body: toCsv(rows, columns) });
    await db.update('saved_reports', r.id, { last_sent_at: new Date() });
  }
  return due.length;
}

router.use(authenticate, requireAgent);

// ---------------- gamification, derived from ticket history so it cannot drift
router.get('/arcade', asyncHandler(async (req, res) => {
  const days = { week: 7, month: 30, quarter: 90 }[req.query.period] || 30;
  const since = new Date(Date.now() - days * 86400000);
  const d = await db.fetch({
    settings: ['settings', { key: 'arcade' }],
    users: ['users', { is_active: true }, { select: ['id', 'name', 'avatar_url'] }],
    tickets: ['tickets', { deleted: false, spam: false, resolved_at: { gte: since }, responder_id: { isNull: false } }],
    ratings: ['satisfaction_ratings', undefined, { select: ['id', 'ticket_id', 'rating'] }],
  });
  const cfg = { enabled: true, resolve_points: 10, sla_bonus: 5, fast_reply_bonus: 5, csat_bonus: 15, ...(d.settings[0]?.value || {}) };
  const ratingsBy = groupBy(d.ratings, 'ticket_id');
  const ticketsBy = groupBy(d.tickets.filter((t) => ms(t.resolved_at) >= since.getTime()), 'responder_id');
  const rows = d.users.map((u) => {
    // LEFT JOIN tickets, LEFT JOIN ratings: one joined row per (ticket, rating) pair, or per ticket when unrated.
    const joined = [];
    for (const t of ticketsBy.get(u.id) || []) {
      const rs = ratingsBy.get(t.id);
      if (rs && rs.length) for (const r of rs) joined.push({ t, r }); else joined.push({ t, r: null });
    }
    return {
      id: u.id, name: u.name, avatar_url: u.avatar_url,
      resolved: joined.length,
      within_sla: countWhere(joined, ({ t }) => t.resolved_at != null && t.due_by != null && ms(t.resolved_at) <= ms(t.due_by)),
      fast_replies: countWhere(joined, ({ t }) => t.first_responded_at != null && t.fr_due_by != null && ms(t.first_responded_at) <= ms(t.fr_due_by)),
      happy_customers: countWhere(joined, ({ r }) => r && r.rating >= 4),
    };
  });
  const LEVELS = [[0, 'Beginner'], [100, 'Intermediate'], [500, 'Professional'], [1500, 'Expert'], [5000, 'Master'], [15000, 'Guru']];
  const board = rows.map((a) => {
    const points = a.resolved * cfg.resolve_points + a.within_sla * cfg.sla_bonus + a.fast_replies * cfg.fast_reply_bonus + a.happy_customers * cfg.csat_bonus;
    return { ...a, points, level: LEVELS.filter(([min]) => points >= min).pop()[1] };
  }).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  res.json({ data: board, settings: cfg });
}));

router.use(requirePrivilege('view_reports'));

router.get('/report-meta', (_req, res) => {
  const list = (o) => Object.entries(o).map(([key, v]) => ({ key, label: v.label }));
  res.json({ data: { metrics: list(METRICS), dimensions: list(DIMENSIONS) } });
});
router.post('/run', asyncHandler(async (req, res) => {
  const { rows, metrics } = await runReport(req.body);
  res.json({ data: rows, metrics });
}));
router.post('/run.csv', requirePrivilege('export_data'), asyncHandler(async (req, res) => {
  const { rows, columns } = await runReport(req.body);
  sendCsv(res, 'report.csv', rows, columns);
}));

// ---------------- saved reports
const ownerWhere = (req) => (req.user.role === 'admin' ? { id: req.params.id } : { id: req.params.id, user_id: req.user.id });
router.get('/reports', asyncHandler(async (req, res) => {
  const d = await db.fetch({
    reports: ['saved_reports', { or: [{ user_id: req.user.id }, { is_shared: true }] }],
    users: ['users', undefined, { select: ['id', 'name'] }],
  });
  const users = indexBy(d.users);
  const rows = sortRows(d.reports, [['is_favorite', 'desc'], ['name', 'asc']])
    .map((r) => ({ ...r, owner_name: users.get(r.user_id)?.name ?? null }));
  res.json({ data: rows });
}));
router.post('/reports', asyncHandler(async (req, res) => {
  const b = req.body;
  requireFields(b, ['name']);
  await runReport(b.config);
  const row = await db.insert('saved_reports', {
    user_id: req.user.id, name: b.name, folder: b.folder || null, config: b.config,
    is_shared: b.is_shared ?? false, schedule: b.schedule || null, recipients: toArray(b.recipients),
  });
  res.status(201).json({ data: row });
}));
router.put('/reports/:id', asyncHandler(async (req, res) => {
  const b = { ...req.body };
  if (b.config !== undefined) await runReport(b.config);
  if (b.recipients !== undefined) b.recipients = toArray(b.recipients);
  if (b.schedule === '') b.schedule = null;
  const patch = {};
  for (const k of ['name', 'folder', 'config', 'is_shared', 'is_favorite', 'schedule', 'recipients']) if (b[k] !== undefined) patch[k] = b[k];
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const [row] = await db.updateWhere('saved_reports', ownerWhere(req), patch);
  if (!row) throw notFound('Report');
  res.json({ data: row });
}));
router.delete('/reports/:id', asyncHandler(async (req, res) => {
  const removed = await db.removeWhere('saved_reports', ownerWhere(req));
  if (!removed) throw notFound('Report');
  res.json({ ok: true });
}));

export default router;
