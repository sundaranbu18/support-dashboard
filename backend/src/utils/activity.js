import { db } from '../db/index.js';

export async function logActivity(ticketId, actor, action, details = {}) {
  await db.insert('ticket_activities', {
    ticket_id: ticketId,
    user_id: actor && actor.kind === 'user' ? actor.id : null,
    contact_id: actor && actor.kind === 'contact' ? actor.id : null,
    actor_label: actor ? actor.name : 'System',
    action,
    details,
  });
}
