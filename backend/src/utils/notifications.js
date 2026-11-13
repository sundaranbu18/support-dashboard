import { db } from '../db/index.js';

export async function notifyUser(userId, { type, title, body, link }) {
  if (!userId) return;
  await db.insert('notifications', { user_id: userId, type, title, body: body || null, link: link || null });
}

export async function notifyContact(contactId, { type, title, body, link }) {
  if (!contactId) return;
  await db.insert('notifications', { contact_id: contactId, type, title, body: body || null, link: link || null });
}

export async function notifyGroup(groupId, payload, exceptUserId) {
  if (!groupId) return;
  const members = await db.find('group_members', { group_id: groupId });
  const docs = members
    .filter((r) => r.user_id !== exceptUserId)
    .map((r) => ({ user_id: r.user_id, type: payload.type, title: payload.title, body: payload.body || null, link: payload.link || null }));
  await db.insertMany('notifications', docs);
}
