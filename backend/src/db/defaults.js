// Built-in reference rows every Nexus deployment needs (formerly seeded by schema.sql).
// Idempotent: existing rows are left untouched (ON CONFLICT DO NOTHING semantics).
import { db } from './index.js';

const ALL_PRIVILEGES = ['reply_ticket', 'delete_ticket', 'merge_split_ticket', 'export_data', 'manage_contacts', 'manage_kb', 'moderate_forums', 'view_reports', 'manage_admin'];

const ROLES = [
  { name: 'Account Administrator', description: 'Complete control over the help desk and organisation settings.', is_default: true, privileges: ALL_PRIVILEGES },
  { name: 'Administrator', description: 'Can configure all features through the Admin area.', is_default: true, privileges: ALL_PRIVILEGES },
  { name: 'Supervisor', description: 'Can perform all agent activities and access reports.', is_default: true, privileges: ['reply_ticket', 'delete_ticket', 'merge_split_ticket', 'export_data', 'manage_contacts', 'manage_kb', 'moderate_forums', 'view_reports'] },
  { name: 'Agent', description: 'Can log, view, reply to, update and resolve tickets and manage contacts.', is_default: true, privileges: ['reply_ticket', 'merge_split_ticket', 'manage_contacts', 'manage_kb', 'view_reports'] },
  { name: 'Ticket Collaborator', description: 'Can work on assigned tickets and add private notes, but cannot reply to customers.', is_default: true, privileges: [] },
  { name: 'Analytics Collaborator', description: 'Can view reports in the Analytics module.', is_default: true, privileges: ['view_reports', 'export_data'] },
];

const AGENT_STATUSES = [
  { name: 'Available', emoji: '🟢', accepts_tickets: true, is_default: true, position: 1 },
  { name: 'Busy', emoji: '🔴', accepts_tickets: true, is_default: false, position: 2 },
  { name: 'On a break', emoji: '☕', accepts_tickets: false, is_default: false, position: 3 },
  { name: 'Offline', emoji: '⚪', accepts_tickets: false, is_default: false, position: 4 },
];

const TICKET_STATUSES = [
  { key: 'open', label: 'Open', customer_label: 'Being processed', stops_sla: false, is_default: true, position: 1 },
  { key: 'pending', label: 'Pending', customer_label: 'Awaiting your reply', stops_sla: true, is_default: true, position: 2 },
  { key: 'resolved', label: 'Resolved', customer_label: 'Resolved', stops_sla: false, is_default: true, position: 3 },
  { key: 'closed', label: 'Closed', customer_label: 'Closed', stops_sla: false, is_default: true, position: 4 },
  { key: 'on_hold', label: 'On hold', customer_label: 'Being processed', stops_sla: true, is_default: false, position: 5 },
  { key: 'user_response_awaited', label: 'User Response Awaited', customer_label: 'Awaiting your reply', stops_sla: true, is_default: false, position: 6 },
];

const EMAIL_NOTIFICATIONS = [
  { key: 'new_ticket_requester', label: 'New ticket created', audience: 'requester', subject: 'We received your request [#{{ticket.id}}]', body: 'Hi {{requester.name}},\n\nWe have received your request "{{ticket.subject}}" and will get back to you soon.' },
  { key: 'agent_reply_requester', label: 'Agent adds a reply', audience: 'requester', subject: 'Re: {{ticket.subject}} [#{{ticket.id}}]', body: '{{reply.body}}' },
  { key: 'ticket_resolved_requester', label: 'Agent resolves the ticket', audience: 'requester', subject: 'Your request has been resolved [#{{ticket.id}}]', body: 'Hi {{requester.name}},\n\nYour request "{{ticket.subject}}" has been resolved. Reply to this email to reopen it, or rate your experience in the portal.' },
  { key: 'ticket_assigned_agent', label: 'Ticket assigned to agent', audience: 'agent', subject: 'Ticket #{{ticket.id}} assigned to you', body: '"{{ticket.subject}}" has been assigned to you.' },
  { key: 'requester_reply_agent', label: 'Requester replies to a ticket', audience: 'agent', subject: 'New reply on #{{ticket.id}}', body: '{{requester.name}} replied on "{{ticket.subject}}":\n\n{{reply.body}}' },
];

export async function ensureDefaults() {
  const ops = [
    ...ROLES.map((doc) => ({ op: 'upsert', table: 'roles', where: { name: doc.name }, doc })),
    ...AGENT_STATUSES.map((doc) => ({ op: 'upsert', table: 'agent_statuses', where: { name: doc.name }, doc })),
    ...TICKET_STATUSES.map((doc) => ({ op: 'upsert', table: 'ticket_statuses', where: { key: doc.key }, doc })),
    ...EMAIL_NOTIFICATIONS.map((doc) => ({ op: 'upsert', table: 'email_notifications', where: { key: doc.key }, doc })),
  ];
  await db.batch(ops);
  if ((await db.count('surveys')) === 0) {
    await db.insert('surveys', { name: 'Default Survey', is_active: true });
  }
}
