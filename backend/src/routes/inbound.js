import { Router } from 'express';
import crypto from 'node:crypto';
import { db, nowIso } from '../db/index.js';
import { asyncHandler, HttpError, badRequest } from '../utils/errors.js';
import { requireFields } from '../utils/helpers.js';
import { applySla } from '../utils/sla.js';
import { logActivity } from '../utils/activity.js';
import { runAutomations } from '../utils/automations.js';
import { sendTicketEmail } from '../utils/email.js';
import { notifyUser, notifyGroup } from '../utils/notifications.js';

const router = Router();
const SOURCE_BY_CHANNEL = { email: 'email', whatsapp: 'social', facebook: 'social', social: 'social', phone: 'phone', chat: 'chat' };

async function findOrCreateContact({ email, name, phone }) {
  const lower = email ? String(email).toLowerCase() : null;
  const domain = lower ? lower.split('@')[1] : null;
  const contactWhere = lower
    ? { email: { ieq: lower } }
    : phone != null ? { or: [{ phone }, { mobile: phone }] } : null;
  const found = await db.fetch({
    ...(contactWhere ? { contacts: ['contacts', contactWhere, { order: [['id', 'asc']], limit: 1 }] } : {}),
    ...(domain ? { companies: ['companies', { domains: { contains: domain } }, { order: [['id', 'asc']], limit: 1, select: ['id'] }] } : {}),
  });
  if (found.contacts?.[0]) return found.contacts[0];
  return db.insert('contacts', {
    name: name || (lower ? lower.split('@')[0] : phone), email: lower, phone: phone || null, company_id: found.companies?.[0]?.id || null,
  });
}

async function createTicket({ contact, subject, description, source, group_id = null, product_id = null }) {
  const sla = await applySla({ priority: 'low', type: null, source, group_id, company_id: contact.company_id, created_at: new Date() });
  const created = await db.insert('tickets', {
    subject, description: description || '', source, requester_id: contact.id, company_id: contact.company_id, group_id, product_id,
    sla_policy_id: sla.sla_policy_id, fr_due_by: sla.fr_due_by, due_by: sla.due_by,
  });
  await logActivity(created.id, { kind: 'contact', id: contact.id, name: contact.name }, 'created', { priority: 'low', source });
  const ticket = await runAutomations('ticket_created', created);
  await sendTicketEmail('new_ticket_requester', ticket);
  return ticket;
}

function tokensMatch(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
}

// Bridge for mail gateways and messaging providers. Refuses everything until an admin creates a token.
router.post('/inbound/:channel', asyncHandler(async (req, res) => {
  const source = SOURCE_BY_CHANNEL[req.params.channel];
  if (!source) throw badRequest('Unknown channel');
  const inbound = await db.findOne('settings', { key: 'inbound' });
  if (!tokensMatch(req.headers['x-inbound-token'], inbound?.value?.token)) throw new HttpError(401, 'Invalid inbound token');
  const { from_email: email, from_name: name, from_phone: phone, subject, body, to } = req.body;
  requireFields(req.body, ['body']);
  if (!email && !phone) throw badRequest('from_email or from_phone is required');
  const contact = await findOrCreateContact({ email, name, phone });
  if (contact.is_blocked) return res.status(202).json({ ignored: 'blocked contact' });

  // "[#123]" in the subject continues an existing ticket from the same requester.
  const ref = /\[#(\d+)\]/.exec(subject || '');
  if (ref) {
    const existing = await db.findOne('tickets', { id: ref[1], requester_id: contact.id, deleted: false });
    if (existing) {
      await db.batch([
        { op: 'insert', table: 'conversations', doc: { ticket_id: existing.id, contact_id: contact.id, kind: 'reply', body, source } },
        {
          op: 'update', table: 'tickets', where: { id: existing.id },
          patch: existing.status !== 'open' ? { status: 'open', resolved_at: null, closed_at: null } : { updated_at: nowIso() },
        },
      ]);
      await logActivity(existing.id, { kind: 'contact', id: contact.id, name: contact.name }, 'customer_replied', { source });
      const payload = { type: 'customer_reply', title: `${contact.name} replied on #${existing.id}`, body: existing.subject, link: `/tickets/${existing.id}` };
      if (existing.responder_id) await notifyUser(existing.responder_id, payload); else await notifyGroup(existing.group_id, payload);
      await sendTicketEmail('requester_reply_agent', existing, { body });
      return res.status(201).json({ data: { ticket_id: existing.id, appended: true } });
    }
  }
  const mailbox = to ? await db.findOne('mailboxes', { email: { ieq: String(to) } }, { select: ['group_id', 'product_id'] }) : null;
  const ticket = await createTicket({ contact, subject: subject || String(body).slice(0, 80), description: body, source, group_id: mailbox?.group_id, product_id: mailbox?.product_id });
  res.status(201).json({ data: { ticket_id: ticket.id, appended: false } });
}));

// Public feedback form, embeddable on any site. Limited per IP because it needs no login.
const hits = new Map();
router.post('/public/feedback', asyncHandler(async (req, res) => {
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter((at) => now - at < 3600000);
  if (recent.length >= 10) throw new HttpError(429, 'Too many submissions. Please try again later.');
  hits.set(req.ip, [...recent, now]);
  const { name, email, subject, description, website } = req.body;
  // "website" is a hidden field only bots fill in.
  if (website) return res.status(201).json({ ok: true });
  requireFields(req.body, ['email', 'subject', 'description']);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) throw badRequest('Enter a valid email address');
  const contact = await findOrCreateContact({ email, name });
  if (!contact.is_blocked) await createTicket({ contact, subject: String(subject).slice(0, 200), description, source: 'portal' });
  res.status(201).json({ ok: true });
}));

export default router;
