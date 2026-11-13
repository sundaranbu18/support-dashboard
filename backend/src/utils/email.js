import { db } from '../db/index.js';

let transportPromise;
async function transport() {
  if (!process.env.SMTP_HOST) return null;
  if (!transportPromise) {
    transportPromise = import('nodemailer').then(({ default: nodemailer }) => nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    }));
  }
  return transportPromise;
}

// Every message is recorded in the outbox. Without SMTP_HOST it stays there as "logged".
export async function sendEmail({ to, subject, body, ticketId = null }) {
  if (!to) return null;
  let status = 'logged';
  let error = null;
  const mailer = await transport();
  if (mailer) {
    try {
      await mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text: body });
      status = 'sent';
    } catch (err) {
      status = 'failed';
      error = err.message;
    }
  }
  return db.insert('email_outbox', { ticket_id: ticketId, to_email: to, subject, body, status, error });
}

export function renderTemplate(text, vars) {
  return String(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => vars[key] ?? '');
}

// Sends one configured notification. Mail problems must never fail the ticket action.
export async function sendTicketEmail(key, ticket, extra = {}) {
  try {
    const tpl = await db.findOne('email_notifications', { key, is_enabled: true });
    if (!tpl) return;
    const [contact, agent] = await Promise.all([db.get('contacts', ticket.requester_id), ticket.responder_id ? db.get('users', ticket.responder_id) : null]);
    if (!contact) return;
    const people = { requester_name: contact.name, requester_email: contact.email, agent_name: agent?.name ?? null, agent_email: agent?.email ?? null };
    const to = tpl.audience === 'requester' ? people.requester_email : people.agent_email;
    const vars = {
      'ticket.id': ticket.id, 'ticket.subject': ticket.subject, 'ticket.status': ticket.status, 'ticket.priority': ticket.priority,
      'requester.name': people.requester_name, 'agent.name': people.agent_name, 'reply.body': extra.body,
    };
    await sendEmail({ to, subject: renderTemplate(tpl.subject, vars), body: renderTemplate(tpl.body, vars), ticketId: ticket.id });
  } catch (err) {
    console.error('[email]', err.message);
  }
}
