import { db, indexBy, nowIso } from '../db/index.js';
import { logActivity } from './activity.js';
import { notifyUser, notifyGroup } from './notifications.js';
import { sendEmail } from './email.js';

// Blocks webhooks aimed at this machine or the private network.
function isPublicWebhookUrl(raw) {
  try {
    const { protocol, hostname } = new URL(raw);
    if (!['http:', 'https:'].includes(protocol)) return false;
    return !/^(localhost|0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i.test(hostname);
  } catch { return false; }
}

async function fireWebhook(url, ticket) {
  if (!isPublicWebhookUrl(url)) return { url, ok: false, error: 'URL not allowed' };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }), redirect: 'error', signal: AbortSignal.timeout(5000) });
    return { url, ok: res.ok, status: res.status };
  } catch (err) { return { url, ok: false, error: err.message }; }
}

// Requester/company fields for a ticket (contacts LEFT JOIN companies). `lookup` holds prefetched
// { contacts, companies } Maps so time triggers can evaluate many tickets without extra round trips.
async function requesterInfo(ticket, lookup) {
  let contact;
  let company = null;
  if (lookup) {
    contact = lookup.contacts.get(ticket.requester_id);
    if (contact && contact.company_id != null) company = lookup.companies.get(contact.company_id) || null;
  } else {
    contact = ticket.requester_id != null ? await db.get('contacts', ticket.requester_id) : null;
    if (contact && contact.company_id != null) company = await db.get('companies', contact.company_id);
  }
  if (!contact) return {};
  return { requester_email: contact.email, requester_name: contact.name, company_name: company ? company.name : null, company_domains: company ? company.domains : null };
}

// Fields exposed to automation conditions.
async function ticketContext(ticket, lookup) {
  const extra = await requesterInfo(ticket, lookup);
  const now = Date.now();
  const hours = (d) => (d ? (now - new Date(d).getTime()) / 3600000 : null);
  return {
    ...ticket,
    requester_email: extra.requester_email,
    requester_name: extra.requester_name,
    company_name: extra.company_name,
    requester_domain: extra.requester_email ? extra.requester_email.split('@')[1] : null,
    hours_since_created: hours(ticket.created_at),
    hours_since_updated: hours(ticket.updated_at),
    hours_since_due: ticket.due_by ? (now - new Date(ticket.due_by).getTime()) / 3600000 : null,
    hours_until_due: ticket.due_by ? (new Date(ticket.due_by).getTime() - now) / 3600000 : null,
    has_responder: !!ticket.responder_id,
    first_responded: !!ticket.first_responded_at,
  };
}

function norm(v) {
  if (v === null || v === undefined) return '';
  return String(v).toLowerCase();
}

export function evaluateRule(rule, ctx) {
  const actual = ctx[rule.field];
  const expected = rule.value;
  const op = rule.operator || 'is';
  switch (op) {
    case 'is':
      if (typeof actual === 'boolean') return actual === (expected === true || norm(expected) === 'true');
      return norm(actual) === norm(expected);
    case 'is_not':
      if (typeof actual === 'boolean') return actual !== (expected === true || norm(expected) === 'true');
      return norm(actual) !== norm(expected);
    case 'contains':
      if (Array.isArray(actual)) return actual.map(norm).includes(norm(expected));
      return norm(actual).includes(norm(expected));
    case 'not_contains':
      if (Array.isArray(actual)) return !actual.map(norm).includes(norm(expected));
      return !norm(actual).includes(norm(expected));
    case 'starts_with':
      return norm(actual).startsWith(norm(expected));
    case 'ends_with':
      return norm(actual).endsWith(norm(expected));
    case 'in': {
      const list = Array.isArray(expected) ? expected : String(expected).split(',').map((s) => s.trim());
      return list.map(norm).includes(norm(actual));
    }
    case 'not_in': {
      const list = Array.isArray(expected) ? expected : String(expected).split(',').map((s) => s.trim());
      return !list.map(norm).includes(norm(actual));
    }
    case 'greater_than':
      return actual !== null && actual !== undefined && Number(actual) > Number(expected);
    case 'less_than':
      return actual !== null && actual !== undefined && Number(actual) < Number(expected);
    case 'is_empty':
      return actual === null || actual === undefined || actual === '' || (Array.isArray(actual) && actual.length === 0);
    case 'is_not_empty':
      return !(actual === null || actual === undefined || actual === '' || (Array.isArray(actual) && actual.length === 0));
    default:
      return false;
  }
}

export function evaluateConditions(conditions, ctx) {
  const rules = (conditions && conditions.rules) || [];
  if (rules.length === 0) return true;
  const match = (conditions && conditions.match) || 'all';
  const results = rules.map((r) => evaluateRule(r, ctx));
  return match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

async function applyActions(actions, ticket, ruleName) {
  const updates = {};
  let tags = [...(ticket.tags || [])];
  const notes = [];
  const notifications = [];
  const webhooks = [];
  const emails = [];
  for (const a of actions || []) {
    switch (a.type) {
      case 'set_priority': updates.priority = a.value; break;
      case 'set_status': updates.status = a.value; break;
      case 'set_type': updates.type = a.value; break;
      case 'set_source': updates.source = a.value; break;
      case 'assign_group': updates.group_id = a.value ? Number(a.value) : null; break;
      case 'assign_agent': updates.responder_id = a.value ? Number(a.value) : null; break;
      case 'add_tag': if (a.value && !tags.includes(a.value)) tags.push(a.value); break;
      case 'remove_tag': tags = tags.filter((t) => t !== a.value); break;
      case 'mark_spam': updates.spam = true; break;
      case 'escalate': updates.is_escalated = true; break;
      case 'add_note': if (a.value) notes.push(a.value); break;
      case 'notify_agent': if (a.value) notifications.push({ user_id: Number(a.value), message: a.message }); break;
      case 'notify_group': if (a.value) notifications.push({ group_id: Number(a.value), message: a.message }); break;
      case 'notify_assignee': notifications.push({ assignee: true, message: a.message }); break;
      case 'webhook': if (a.value) webhooks.push(a.value); break;
      case 'send_email_requester': emails.push({ requester: true, body: a.value }); break;
      default: break;
    }
  }
  if (JSON.stringify(tags) !== JSON.stringify(ticket.tags || [])) updates.tags = tags;
  return { updates, notes, notifications, webhooks, emails };
}

const activeRules = (event) => db.find('automations', { is_active: true, event }, { order: [['position', 'asc'], ['id', 'asc']] });

// Runs automations for an event against a ticket. Returns the (possibly updated) ticket row.
// `preloaded` ({ rules, lookup }) is used by runTimeTriggers to avoid per-ticket reads.
export async function runAutomations(event, ticket, preloaded = null) {
  const rules = preloaded?.rules || (await activeRules(event));
  if (rules.length === 0) return ticket;

  let current = ticket;
  for (const rule of rules) {
    const ctx = await ticketContext(current, preloaded?.lookup);
    if (!evaluateConditions(rule.conditions, ctx)) continue;

    current = await executeActions(rule.actions, current, { label: 'Automation', name: rule.name, action: 'automation' });
    await db.update('automations', rule.id, { last_run_at: nowIso() }, { inc: { run_count: 1 } });
  }
  return current;
}

// Applies an action list to a ticket and records it. Shared by automations and scenarios.
export async function executeActions(actions, ticket, { label, name, action, actor = null }) {
  let current = ticket;
  {
    const { updates, notes, notifications, webhooks, emails } = await applyActions(actions, current, name);
    const changes = {};
    for (const [k, v] of Object.entries(updates)) {
      if (JSON.stringify(current[k]) !== JSON.stringify(v)) changes[k] = { from: current[k], to: v };
    }

    if (Object.keys(changes).length) {
      const now = nowIso();
      const patch = {};
      for (const k of Object.keys(changes)) patch[k] = updates[k];
      if (updates.status === 'resolved' && !current.resolved_at) patch.resolved_at = now;
      if (updates.status === 'closed' && !current.closed_at) {
        patch.closed_at = now;
        if (!current.resolved_at) patch.resolved_at = now; // COALESCE(resolved_at, NOW())
      }
      if (updates.status && !['resolved', 'closed'].includes(updates.status)) { patch.resolved_at = null; patch.closed_at = null; }
      const [row] = await db.updateWhere('tickets', { id: current.id }, patch);
      current = row;
    }
    if (notes.length) {
      await db.insertMany('conversations', notes.map((n) => ({ ticket_id: current.id, kind: 'note', is_private: true, body: n, source: 'automation' })));
    }
    for (const n of notifications) {
      const payload = {
        type: 'automation',
        title: `${label} "${name}" on ticket #${current.id}`,
        body: n.message || current.subject,
        link: `/tickets/${current.id}`,
      };
      if (n.user_id) await notifyUser(n.user_id, payload);
      if (n.group_id) await notifyGroup(n.group_id, payload);
      if (n.assignee && current.responder_id) await notifyUser(current.responder_id, payload);
    }
    const webhookResults = [];
    for (const url of webhooks) webhookResults.push(await fireWebhook(url, current));
    if (emails.length) {
      const c = current.requester_id != null ? await db.get('contacts', current.requester_id) : null;
      for (const e of emails) {
        await sendEmail({ to: c?.email, subject: `Re: ${current.subject} [#${current.id}]`, body: e.body || '', ticketId: current.id });
      }
    }
    if (Object.keys(changes).length || notes.length || notifications.length || webhooks.length || emails.length) {
      await logActivity(current.id, actor, action, { rule: name, changes, notes: notes.length, webhooks: webhookResults });
    }
  }
  return current;
}

// Time-based rules (Freshdesk "Supervisor"): evaluated periodically on unresolved tickets.
export async function runTimeTriggers() {
  const rules = await activeRules('time_trigger');
  if (rules.length === 0) return 0;
  const { tickets, contacts, companies } = await db.fetch({
    tickets: ['tickets', { status: { nin: ['resolved', 'closed'] }, deleted: false, spam: false }],
    contacts: ['contacts'],
    companies: ['companies'],
  });
  const lookup = { contacts: indexBy(contacts), companies: indexBy(companies) };
  let touched = 0;
  for (const t of tickets) {
    const before = JSON.stringify(t);
    const after = await runAutomations('time_trigger', t, { rules, lookup });
    if (JSON.stringify(after) !== before) touched++;
  }
  return touched;
}
