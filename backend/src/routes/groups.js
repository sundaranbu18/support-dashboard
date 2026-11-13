import { Router } from 'express';
import { db, indexBy, groupBy, countBy, sortRows } from '../db/index.js';
import { authenticate, requireAgent, requireAdmin } from '../middleware/auth.js';
import { asyncHandler, notFound } from '../utils/errors.js';
import { requireFields } from '../utils/helpers.js';

const router = Router();
router.use(authenticate, requireAgent);

// g.* plus members (ordered by name) and the count of open tickets, like the old aggregate SELECT.
async function loadGroups(groupId) {
  const one = groupId !== undefined;
  const { groups, gm, users, tickets } = await db.fetch({
    groups: ['groups', one ? { id: groupId } : null, { order: [['name', 'asc']] }],
    gm: ['group_members', one ? { group_id: groupId } : null],
    users: ['users', null, { select: ['id', 'name', 'email', 'avatar_url'] }],
    tickets: ['tickets', { group_id: one ? groupId : { isNull: false }, status: { nin: ['resolved', 'closed'] }, deleted: false }, { select: ['group_id'] }],
  });
  const usersById = indexBy(users);
  const membersByGroup = groupBy(gm, 'group_id');
  const openByGroup = countBy(tickets, 'group_id');
  return groups.map((g) => ({
    ...g,
    members: sortRows(
      (membersByGroup.get(g.id) || []).map((m) => usersById.get(m.user_id)).filter(Boolean)
        .map((u) => ({ id: u.id, name: u.name, email: u.email, avatar_url: u.avatar_url })),
      [['name', 'asc']]
    ),
    open_tickets: openByGroup[g.id] || 0,
  }));
}

// group_members.user_id references users(id): reject unknown users like the foreign key did.
async function assertUsersExist(userIds) {
  const ids = [...new Set(userIds.map(Number))];
  if (!ids.length) return;
  const found = await db.find('users', { id: { in: ids } }, { select: ['id'] });
  if (found.length < ids.length) throw Object.assign(new Error('User not found'), { code: '23503', detail: 'group_members.user_id references a missing user' });
}

const memberUpserts = (groupId, userIds) => userIds.map((user_id) => ({ op: 'upsert', table: 'group_members', where: { group_id: groupId, user_id }, doc: { group_id: groupId, user_id } }));

router.get('/', asyncHandler(async (_req, res) => {
  res.json({ data: await loadGroups() });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const [group] = await loadGroups(req.params.id);
  if (!group) throw notFound('Group');
  res.json({ data: group });
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { name, description, escalate_to_user_id, auto_assign = false, member_ids = [] } = req.body;
  requireFields(req.body, ['name']);
  await assertUsersExist(member_ids);
  const group = await db.insert('groups', { name, description: description || null, escalate_to_user_id: escalate_to_user_id || null, auto_assign: !!auto_assign });
  if (member_ids.length) await db.batch(memberUpserts(group.id, member_ids));
  const [out] = await loadGroups(group.id);
  res.status(201).json({ data: out });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const patch = {};
  for (const k of ['name', 'description', 'escalate_to_user_id', 'auto_assign']) if (req.body[k] !== undefined) patch[k] = req.body[k];
  if (Object.keys(patch).length) await db.updateWhere('groups', { id: req.params.id }, patch);
  if (Array.isArray(req.body.member_ids)) {
    await assertUsersExist(req.body.member_ids);
    if (req.body.member_ids.length && !(await db.get('groups', req.params.id))) {
      throw Object.assign(new Error('Group not found'), { code: '23503', detail: 'group_members.group_id references a missing group' });
    }
    await db.batch([
      { op: 'remove', table: 'group_members', where: { group_id: req.params.id } },
      ...memberUpserts(req.params.id, req.body.member_ids),
    ]);
  }
  const [group] = await loadGroups(req.params.id);
  if (!group) throw notFound('Group');
  res.json({ data: group });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const removed = await db.removeWhere('groups', { id: req.params.id });
  if (!removed) throw notFound('Group');
  res.json({ ok: true });
}));

export default router;
