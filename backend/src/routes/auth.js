import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, nowIso } from '../db/index.js';
import { signToken, authenticate, privilegesFor } from '../middleware/auth.js';
import { asyncHandler, HttpError, badRequest } from '../utils/errors.js';
import { requireFields } from '../utils/helpers.js';

const router = Router();

function securityFrom(rows) {
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { min_password_length: 8, signup_domains: [], ...byKey.security, portal_signup_enabled: byKey.helpdesk?.portal_signup_enabled !== false };
}

async function loadSecurity() {
  return securityFrom(await db.find('settings', { key: ['security', 'helpdesk'] }));
}

function assertPasswordLength(password, min) {
  if (String(password).length < Number(min)) throw badRequest(`Password must be at least ${min} characters`);
}

export async function checkPassword(password) {
  const { min_password_length: min } = await loadSecurity();
  assertPasswordLength(password, min);
}

async function privilegesOf(u) {
  if (!u.role_id) return privilegesFor(u.role);
  const role = await db.get('roles', u.role_id);
  return privilegesFor(u.role, role?.privileges);
}

function publicUser(u) {
  return { role_id: u.role_id, agent_status_id: u.agent_status_id, id: u.id, kind: 'user', name: u.name, email: u.email, role: u.role, avatar_url: u.avatar_url, job_title: u.job_title, phone: u.phone, time_zone: u.time_zone, signature: u.signature };
}
function publicContact(c) {
  return { id: c.id, kind: 'contact', name: c.name, email: c.email, role: 'customer', company_id: c.company_id, phone: c.phone, avatar_url: c.avatar_url };
}

// Agents and customers share one login endpoint. Agents are checked first.
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  requireFields(req.body, ['email', 'password']);
  const byEmail = { email: { ieq: String(email) } };

  const { users, contacts } = await db.fetch({ users: ['users', byEmail, { limit: 1 }], contacts: ['contacts', byEmail, { limit: 1 }] });
  if (users[0]) {
    const u = users[0];
    if (!u.is_active) throw new HttpError(403, 'This agent account has been deactivated');
    if (!(await bcrypt.compare(password, u.password_hash))) throw new HttpError(401, 'Invalid email or password');
    const [, privileges] = await Promise.all([db.update('users', u.id, { last_login_at: nowIso() }), privilegesOf(u)]);
    return res.json({ token: signToken({ sub: u.id, kind: 'user', role: u.role }), user: { ...publicUser(u), privileges } });
  }

  const c = contacts[0];
  if (!c || !c.password_hash) throw new HttpError(401, 'Invalid email or password');
  if (c.is_blocked) throw new HttpError(403, 'This account is blocked');
  if (!(await bcrypt.compare(password, c.password_hash))) throw new HttpError(401, 'Invalid email or password');
  res.json({ token: signToken({ sub: c.id, kind: 'contact', role: 'customer' }), user: publicContact(c) });
}));

// Customer self-signup for the portal.
router.post('/register', asyncHandler(async (req, res) => {
  const { name, email, password, phone } = req.body;
  requireFields(req.body, ['name', 'email', 'password']);
  const security = await loadSecurity();
  if (!security.portal_signup_enabled) throw new HttpError(403, 'Portal sign-up is disabled');
  assertPasswordLength(password, security.min_password_length);
  const lower = String(email).toLowerCase();
  if (security.signup_domains?.length && !security.signup_domains.includes(lower.split('@')[1])) throw new HttpError(403, 'Sign-up is restricted to approved email domains');

  // Auto-link to a company by email domain.
  const domain = lower.split('@')[1];
  const byEmail = { email: { ieq: lower } };
  const found = await db.fetch({
    users: ['users', byEmail, { limit: 1 }],
    contacts: ['contacts', byEmail, { limit: 1 }],
    ...(domain ? { companies: ['companies', { domains: { contains: domain } }, { order: 'id', limit: 1 }] } : {}),
  });
  if (found.users.length) throw new HttpError(409, 'Email already in use');
  const hash = await bcrypt.hash(password, 10);
  const companyId = found.companies?.[0]?.id || null;

  const existing = found.contacts[0];
  let contact;
  if (existing) {
    if (existing.password_hash) throw new HttpError(409, 'An account with this email already exists. Please log in.');
    const patch = { password_hash: hash, is_verified: true };
    if (name != null) patch.name = name;
    if (phone) patch.phone = phone;
    contact = await db.update('contacts', existing.id, patch);
  } else {
    contact = await db.insert('contacts', { name, email: lower, phone: phone || null, password_hash: hash, company_id: companyId, is_verified: true });
  }
  res.status(201).json({ token: signToken({ sub: contact.id, kind: 'contact', role: 'customer' }), user: publicContact(contact) });
}));

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  if (req.user.kind === 'user') {
    const { u, gm, g, r } = await db.fetch({
      u: ['users', { id: req.user.id }],
      gm: ['group_members', { user_id: req.user.id }],
      g: ['groups', null, { select: ['id', 'name'] }],
      r: ['roles', null, { select: ['id', 'privileges'] }],
    });
    const user = u[0];
    const groupsById = new Map(g.map((x) => [x.id, x]));
    const groups = gm.map((m) => groupsById.get(m.group_id)).filter(Boolean).map((x) => ({ id: x.id, name: x.name }));
    const role = user?.role_id ? r.find((x) => x.id === user.role_id) : null;
    const privileges = user?.role_id ? privilegesFor(user.role, role?.privileges) : privilegesFor(user?.role);
    return res.json({ user: { ...publicUser(user), groups, privileges } });
  }
  const c = await db.get('contacts', req.user.id);
  res.json({ user: publicContact(c) });
}));

// COALESCE(new, old): only non-null values change the column.
const coalescePatch = (fields) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null));

router.put('/me', authenticate, asyncHandler(async (req, res) => {
  const { name, phone, job_title, time_zone, signature, avatar_url } = req.body;
  if (req.user.kind === 'user') {
    const patch = coalescePatch({ name, phone, job_title, time_zone, signature, avatar_url });
    if (req.body.agent_status_id !== undefined) patch.agent_status_id = req.body.agent_status_id || null;
    const user = await db.update('users', req.user.id, patch);
    return res.json({ user: publicUser(user) });
  }
  const contact = await db.update('contacts', req.user.id, coalescePatch({ name, phone, avatar_url }));
  res.json({ user: publicContact(contact) });
}));

router.post('/change-password', authenticate, asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;
  requireFields(req.body, ['current_password', 'new_password']);
  await checkPassword(new_password);
  const table = req.user.kind === 'user' ? 'users' : 'contacts';
  const row = await db.get(table, req.user.id);
  if (!(await bcrypt.compare(current_password, row.password_hash))) throw new HttpError(400, 'Current password is incorrect');
  const hash = await bcrypt.hash(new_password, 10);
  await db.update(table, req.user.id, { password_hash: hash });
  res.json({ ok: true });
}));

export default router;
