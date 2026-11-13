import { db, groupBy, uniq, nowIso, daysAgo } from '../db/index.js';
import { runTimeTriggers } from './automations.js';
import { sendScheduledReports } from '../routes/analytics.js';

const activityDoc = (ticketId, action, details) => ({ ticket_id: ticketId, user_id: null, contact_id: null, actor_label: 'System', action, details });

// Builds the notification rows for breached tickets: the assignee, or every member of the ticket's group.
async function breachNotifications(items) {
  const groupIds = uniq(items.filter(({ t }) => !t.responder_id).map(({ t }) => t.group_id));
  const members = groupIds.length ? groupBy(await db.find('group_members', { group_id: { in: groupIds } }), 'group_id') : new Map();
  const docs = [];
  for (const { t, payload } of items) {
    const base = { type: payload.type, title: payload.title, body: payload.body || null, link: payload.link || null };
    if (t.responder_id) docs.push({ user_id: t.responder_id, ...base });
    else if (t.group_id) for (const m of members.get(t.group_id) || []) docs.push({ user_id: m.user_id, ...base });
  }
  return docs;
}

// Flags SLA breaches and notifies the assignee / group once per breach.
export async function checkSlaBreaches() {
  const now = nowIso();
  // Each updateWhere is one atomic mutation that returns the rows it flagged (like UPDATE ... RETURNING).
  const frBreaches = await db.updateWhere('tickets', {
    fr_escalated: false, first_responded_at: { isNull: true }, fr_due_by: { lt: now },
    status: 'open', deleted: false, spam: false,
  }, { fr_escalated: true });
  const breaches = await db.updateWhere('tickets', {
    is_escalated: false, due_by: { lt: now },
    status: { nin: ['resolved', 'closed'] }, deleted: false, spam: false,
  }, { is_escalated: true });

  const items = [
    ...frBreaches.map((t) => ({ t, payload: { type: 'sla_breach', title: `First response overdue on #${t.id}`, body: t.subject, link: `/tickets/${t.id}` } })),
    ...breaches.map((t) => ({ t, payload: { type: 'sla_breach', title: `Resolution overdue on #${t.id}`, body: t.subject, link: `/tickets/${t.id}` } })),
  ];
  if (items.length) {
    const notifications = await breachNotifications(items);
    const activities = [
      ...frBreaches.map((t) => activityDoc(t.id, 'sla_response_breached', {})),
      ...breaches.map((t) => activityDoc(t.id, 'sla_resolution_breached', {})),
    ];
    await Promise.all([db.insertMany('notifications', notifications), db.insertMany('ticket_activities', activities)]);
  }
  return frBreaches.length + breaches.length;
}

async function ticketSettings() {
  const row = await db.findOne('settings', { key: 'tickets' });
  return row?.value;
}

// Automatically closes tickets resolved for longer than the configured number of days.
export async function autoCloseResolved() {
  const days = Number((await ticketSettings())?.auto_close_after_days || 0);
  if (!days) return 0;
  const closed = await db.updateWhere('tickets',
    { status: 'resolved', resolved_at: { lt: daysAgo(days) }, deleted: false },
    { status: 'closed', closed_at: nowIso() });
  await db.insertMany('ticket_activities', closed.map((t) => activityDoc(t.id, 'auto_closed', { after_days: days })));
  return closed.length;
}

// Moves long-closed tickets out of the working views.
export async function archiveClosed() {
  const days = Number((await ticketSettings())?.archive_after_days || 0);
  if (!days) return 0;
  const archived = await db.updateWhere('tickets',
    { status: 'closed', archived: false, closed_at: { lt: daysAgo(days) }, deleted: false },
    { archived: true });
  return archived.length;
}

export function startJobs() {
  const safe = (name, fn) => async () => {
    try { await fn(); } catch (err) { console.error(`[job:${name}]`, err.message); }
  };
  setInterval(safe('sla', checkSlaBreaches), 60 * 1000);
  setInterval(safe('time_triggers', runTimeTriggers), 10 * 60 * 1000);
  setInterval(safe('auto_close', autoCloseResolved), 60 * 60 * 1000);
  setInterval(safe('archive', archiveClosed), 60 * 60 * 1000);
  setInterval(safe('scheduled_reports', sendScheduledReports), 60 * 60 * 1000);
  setTimeout(safe('sla', checkSlaBreaches), 5000);
}
