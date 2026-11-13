import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, indexBy, groupBy, countBy } from '../db/index.js';
import { authenticate, requireAgent, requireAdmin } from '../middleware/auth.js';
import { asyncHandler, notFound, badRequest, HttpError } from '../utils/errors.js';
import { requireFields, toBool, toInt } from '../utils/helpers.js';
import { checkPassword } from './auth.js';

// A custom role decides whether the agent has admin access.
async function baseRoleFor(roleId, fallback) {
  if (!roleId) return fallback;
  const r = await db.get('roles', roleId);
  if (!r) throw badRequest('Role not found');
  return r.privileges.includes('manage_admin') ? 'admin' : 'agent';
}

const router = Router();
router.use(authenticate, requireAgent);

const CLOSED = ['resolved', 'closed'];
const NAMES = { select: ['id', 'name'] };

// Same columns as the old USER_COLS select (role_name / agent_status_name come from lookups).
function userCols(u, rolesById, statusesById) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, avatar_url: u.avatar_url, phone: u.phone, job_title: u.job_title,
    time_zone: u.time_zone, signature: u.signature, is_active: u.is_active, last_login_at: u.last_login_at, created_at: u.created_at,
    role_id: u.role_id, agent_status_id: u.agent_status_id,
    role_name: rolesById.get(u.role_id)?.name ?? null,
    agent_status_name: statusesById.get(u.agent_status_id)?.name ?? null,
  };
}

// LEFT JOIN group_members / groups aggregated to [{ id, name }].
function groupsOf(memberships, groupsById) {
  return memberships.map((m) => groupsById.get(m.group_id)).filter(Boolean).map((g) => ({ id: g.id, name: g.name }));
}

// group_members.group_id references groups(id): reject unknown groups like the foreign key did.
async function assertGroupsExist(groupIds) {
  const ids = [...new Set(groupIds.map(Number))];
  if (!ids.length) return;
  const found = await db.find('groups', { id: { in: ids } }, { select: ['id'] });
  if (found.length < ids.length) throw Object.assign(new Error('Group not found'), { code: '23503', detail: 'group_members.group_id references a missing group' });
}

const memberUpserts = (pairs) => pairs.map(([group_id, user_id]) => ({ op: 'upsert', table: 'group_members', where: { group_id, user_id }, doc: { group_id, user_id } }));

router.get('/', asyncHandler(async (req, res) => {
  const { q, active } = req.query;
  const where = {};
  if (q) where.or = [{ name: { icontains: q } }, { email: { icontains: q } }];
  if (active !== undefined) { const a = toBool(active); where.is_active = a === undefined ? null : a; }
  const { users, gm, groups, roles, statuses, tickets } = await db.fetch({
    users: ['users', where, { order: [['name', 'asc']] }],
    gm: ['group_members'],
    groups: ['groups', null, NAMES],
    roles: ['roles', null, NAMES],
    statuses: ['agent_statuses', null, NAMES],
    tickets: ['tickets', { responder_id: { isNull: false }, status: { nin: CLOSED }, deleted: false }, { select: ['responder_id'] }],
  });
  const groupsById = indexBy(groups);
  const rolesById = indexBy(roles);
  const statusesById = indexBy(statuses);
  const membersByUser = groupBy(gm, 'user_id');
  const openByUser = countBy(tickets, 'responder_id');
  const data = users.map((u) => ({
    ...userCols(u, rolesById, statusesById),
    groups: groupsOf(membersByUser.get(u.id) || [], groupsById),
    open_tickets: openByUser[u.id] || 0,
  }));
  res.json({ data });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const { users, gm, groups, roles, statuses, tickets } = await db.fetch({
    users: ['users', { id }],
    gm: ['group_members', { user_id: id }],
    groups: ['groups', null, NAMES],
    roles: ['roles', null, NAMES],
    statuses: ['agent_statuses', null, NAMES],
    tickets: ['tickets', { responder_id: id, deleted: false }, { select: ['status'] }],
  });
  if (!users[0]) throw notFound('Agent');
  const row = { ...userCols(users[0], indexBy(roles), indexBy(statuses)), groups: groupsOf(gm, indexBy(groups)) };
  const resolved = tickets.filter((t) => CLOSED.includes(t.status)).length;
  const stats = { open: tickets.length - resolved, resolved, total: tickets.length };
  res.json({ data: { ...row, stats } });
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { name, email, password, phone, job_title, time_zone, group_ids = [] } = req.body;
  requireFields(req.body, ['name', 'email', 'password']);
  const roleId = toInt(req.body.role_id);
  const role = await baseRoleFor(roleId, req.body.role || 'agent');
  if (!['admin', 'agent'].includes(role)) throw badRequest('Invalid role');
  await checkPassword(password);
  await assertGroupsExist(group_ids);
  const hash = await bcrypt.hash(password, 10);
  const user = await db.insert('users', {
    name, email: String(email).toLowerCase(), password_hash: hash, role, phone: phone || null, job_title: job_title || null,
    time_zone: time_zone || 'UTC', role_id: roleId,
  });
  if (group_ids.length) await db.batch(memberUpserts(group_ids.map((gid) => [gid, user.id])));
  const { password_hash, ...safe } = user;
  res.status(201).json({ data: safe });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const targetId = Number(req.params.id);
  const isSelf = targetId === req.user.id;
  if (!isSelf && req.user.role !== 'admin') throw new HttpError(403, 'Only admins can edit other agents');
  const body = { ...req.body };
  if (req.user.role !== 'admin') { delete body.role; delete body.role_id; delete body.is_active; }
  if (body.role_id !== undefined) { body.role_id = toInt(body.role_id); body.role = await baseRoleFor(body.role_id, body.role || 'agent'); }
  if (body.password) await checkPassword(body.password);
  if (body.email) body.email = String(body.email).toLowerCase();
  const patch = {};
  for (const k of ['name', 'email', 'role', 'role_id', 'phone', 'job_title', 'time_zone', 'signature', 'avatar_url', 'is_active']) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (body.password) patch.password_hash = await bcrypt.hash(body.password, 10);
  if (Object.keys(patch).length) await db.update('users', req.params.id, patch);
  if (Array.isArray(body.group_ids) && req.user.role === 'admin') {
    await assertGroupsExist(body.group_ids);
    if (body.group_ids.length && !(await db.get('users', targetId))) {
      throw Object.assign(new Error('Agent not found'), { code: '23503', detail: 'group_members.user_id references a missing user' });
    }
    await db.batch([
      { op: 'remove', table: 'group_members', where: { user_id: req.params.id } },
      ...memberUpserts(body.group_ids.map((gid) => [gid, req.params.id])),
    ]);
  }
  const { users, roles, statuses } = await db.fetch({
    users: ['users', { id: req.params.id }],
    roles: ['roles', null, NAMES],
    statuses: ['agent_statuses', null, NAMES],
  });
  if (!users[0]) throw notFound('Agent');
  res.json({ data: userCols(users[0], indexBy(roles), indexBy(statuses)) });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  if (Number(req.params.id) === req.user.id) throw badRequest('You cannot deactivate yourself');
  const updated = await db.updateWhere('users', { id: req.params.id }, { is_active: false });
  if (!updated.length) throw notFound('Agent');
  await db.updateWhere('tickets', { responder_id: req.params.id, status: ['open', 'pending'] }, { responder_id: null });
  return res.json({ ok: true });
}));

export default router;
