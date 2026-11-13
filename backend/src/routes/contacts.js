import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, indexBy, groupBy, uniq, sortRows } from '../db/index.js';
import { authenticate, requireAgent, requirePrivilege, requirePrivilegeToWrite } from '../middleware/auth.js';
import { asyncHandler, notFound, badRequest } from '../utils/errors.js';
import { requireFields, pagination, toArray, toInt } from '../utils/helpers.js';
import { parseCsv, sendCsv } from '../utils/csv.js';

const router = Router();
router.use(authenticate, requireAgent, requirePrivilegeToWrite('manage_contacts'));

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const isOpen = (t) => t.status != null && t.status !== 'resolved' && t.status !== 'closed';

// The old BASE select: public contact columns + has_portal_access, company_name, ticket counts.
function contactRow(c, company, tickets = []) {
  return {
    id: c.id, name: c.name, email: c.email, phone: c.phone, mobile: c.mobile, company_id: c.company_id, job_title: c.job_title,
    address: c.address, time_zone: c.time_zone, language: c.language, tags: c.tags, description: c.description,
    is_verified: c.is_verified, is_blocked: c.is_blocked, avatar_url: c.avatar_url, custom_fields: c.custom_fields,
    created_at: c.created_at, updated_at: c.updated_at,
    has_portal_access: c.password_hash != null,
    company_name: company ? company.name : null,
    ticket_count: tickets.length,
    open_ticket_count: tickets.filter(isOpen).length,
  };
}

// Joins company names and ticket counts onto contact rows (one round trip).
async function decorate(contacts) {
  if (!contacts.length) return [];
  const companyIds = uniq(contacts.map((c) => c.company_id));
  const { companies, tickets } = await db.fetch({
    companies: ['companies', { id: { in: companyIds } }, { select: ['id', 'name'] }],
    tickets: ['tickets', { requester_id: { in: contacts.map((c) => c.id) }, deleted: false }, { select: ['requester_id', 'status'] }],
  });
  const companyById = indexBy(companies);
  const ticketsBy = groupBy(tickets, 'requester_id');
  return contacts.map((c) => contactRow(c, companyById.get(c.company_id), ticketsBy.get(c.id)));
}
async function loadContact(id) {
  const c = await db.get('contacts', id);
  if (!c) return null;
  return (await decorate([c]))[0];
}

router.get('/', asyncHandler(async (req, res) => {
  const { q, company_id, tag, blocked, sort = 'name', order = 'asc' } = req.query;
  const { page, perPage, offset } = pagination(req.query);
  const where = {};
  if (company_id) { const cid = toInt(company_id); where.company_id = { in: cid === null ? [] : [cid] }; }
  if (tag) where.tags = { contains: tag };
  if (blocked !== undefined) where.is_blocked = { eq: blocked === 'true' };
  const { contacts, companies } = await db.fetch({
    contacts: ['contacts', where],
    companies: ['companies', null, { select: ['id', 'name'] }],
  });
  const companyById = indexBy(companies);
  let rows = contacts.map((c) => ({ c, company_name: companyById.get(c.company_id)?.name ?? null }));
  if (q) {
    const needle = String(q).toLowerCase();
    const hit = (v) => v != null && String(v).toLowerCase().includes(needle);
    rows = rows.filter(({ c, company_name }) => hit(c.name) || hit(c.email) || hit(c.phone) || hit(company_name));
  }
  const sortKey = { name: 'name', created_at: 'created_at', email: 'email', company: 'company_name' }[sort] || 'name';
  const sortable = rows.map((r) => ({ ...r, name: r.c.name, created_at: r.c.created_at, email: r.c.email }));
  sortRows(sortable, [[sortKey, order === 'desc' ? 'desc' : 'asc']]);
  const pageRows = sortable.slice(offset, offset + perPage).map((r) => r.c);
  const ids = pageRows.map((c) => c.id);
  const tickets = ids.length
    ? await db.find('tickets', { requester_id: { in: ids }, deleted: false }, { select: ['requester_id', 'status'] })
    : [];
  const ticketsBy = groupBy(tickets, 'requester_id');
  res.json({
    data: pageRows.map((c) => contactRow(c, companyById.get(c.company_id), ticketsBy.get(c.id))),
    meta: { total: sortable.length, page, per_page: perPage },
  });
}));

router.get('/export', requirePrivilege('export_data'), asyncHandler(async (_req, res) => {
  const { contacts, companies, tickets } = await db.fetch({
    contacts: ['contacts', null, { order: [['name', 'asc']] }],
    companies: ['companies', null, { select: ['id', 'name'] }],
    tickets: ['tickets', { deleted: false }, { select: ['requester_id', 'status'] }],
  });
  const companyById = indexBy(companies);
  const ticketsBy = groupBy(tickets, 'requester_id');
  const rows = contacts.map((c) => contactRow(c, companyById.get(c.company_id), ticketsBy.get(c.id)));
  sendCsv(res, 'contacts.csv', rows, ['name', 'email', 'phone', 'mobile', 'company_name', 'job_title', 'address', 'time_zone', 'language', 'tags', 'description', 'created_at']);
}));

// CSV import: updates contacts matched by email, creates the rest, reports bad rows.
router.post('/import', asyncHandler(async (req, res) => {
  const records = parseCsv(req.body.csv || '');
  if (!records.length) throw badRequest('The CSV file has no data rows');
  const result = { created: 0, updated: 0, errors: [] };
  const { companies, existing } = await db.fetch({
    companies: ['companies', null, { select: ['id', 'name'], order: [['id', 'asc']] }],
    existing: ['contacts', { email: { isNull: false } }, { select: ['id', 'email'], order: [['id', 'asc']] }],
  });
  const companyByName = new Map();
  for (const co of companies) {
    const k = String(co.name).toLowerCase();
    if (!companyByName.has(k)) companyByName.set(k, co.id);
  }
  // LOWER(email) -> existing contact id, or the pending insert doc for an email created earlier in this file.
  const byEmail = new Map();
  for (const c of existing) {
    const k = c.email.toLowerCase();
    if (!byEmail.has(k)) byEmail.set(k, { id: c.id });
  }
  // Rows apply in file order, so an email seen again (in the DB or earlier in the file) is updated.
  const ops = [];
  for (const [i, r] of records.entries()) {
    const email = r.email ? r.email.toLowerCase() : null;
    if (!r.name || (!email && !r.phone)) { result.errors.push(`Row ${i + 2}: name and an email or phone are required`); continue; }
    let companyId = null;
    if (r.company || r.company_name) companyId = companyByName.get(String(r.company || r.company_name).toLowerCase()) || null;
    const tags = r.tags ? r.tags.split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [];
    const doc = { name: r.name, phone: r.phone || null, mobile: r.mobile || null, company_id: companyId, job_title: r.job_title || null, address: r.address || null, tags };
    const found = email ? byEmail.get(email) : null;
    if (found) {
      // UPDATE ... SET name, tags, and COALESCE(new, old) for the optional columns.
      const patch = { name: doc.name, tags };
      for (const k of ['phone', 'mobile', 'company_id', 'job_title', 'address']) if (doc[k] !== null) patch[k] = doc[k];
      if (found.pending) Object.assign(found.pending, patch);
      else ops.push({ op: 'update', table: 'contacts', where: { id: found.id }, patch });
      result.updated++;
    } else {
      const insertDoc = { ...doc, email };
      ops.push({ op: 'insert', table: 'contacts', doc: insertDoc });
      if (email) byEmail.set(email, { pending: insertDoc });
      result.created++;
    }
  }
  for (let i = 0; i < ops.length; i += 200) await db.batch(ops.slice(i, i + 200));
  res.json({ data: result });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { found, tickets, users } = await db.fetch({
    found: ['contacts', { id: req.params.id }],
    tickets: ['tickets', { requester_id: req.params.id, deleted: false }, { order: [['created_at', 'desc']] }],
    users: ['users', null, { select: ['id', 'name'] }],
  });
  const c = found[0];
  if (!c) throw notFound('Contact');
  const company = c.company_id != null ? await db.get('companies', c.company_id) : null;
  const userById = indexBy(users);
  res.json({
    data: {
      ...contactRow(c, company, tickets),
      tickets: tickets.slice(0, 50).map((t) => ({
        id: t.id, subject: t.subject, status: t.status, priority: t.priority, created_at: t.created_at, updated_at: t.updated_at,
        responder_name: userById.get(t.responder_id)?.name ?? null,
      })),
    },
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body;
  requireFields(b, ['name']);
  if (!b.email && !b.phone) throw badRequest('Provide at least an email or phone number');
  const email = b.email ? String(b.email).toLowerCase() : null;
  let companyId = toInt(b.company_id);
  const domain = email ? email.split('@')[1] : undefined;
  if (!companyId && domain !== undefined) {
    const co = await db.findOne('companies', { domains: { contains: domain } }, { select: ['id'] });
    companyId = co?.id || null;
  }
  const hash = b.password ? await bcrypt.hash(b.password, 10) : null;
  const row = await db.insert('contacts', {
    name: b.name, email, phone: b.phone || null, mobile: b.mobile || null, company_id: companyId, job_title: b.job_title || null,
    address: b.address || null, time_zone: b.time_zone || 'UTC', language: b.language || 'en', tags: toArray(b.tags),
    description: b.description || null, password_hash: hash, is_verified: !!hash,
  });
  const [out] = await decorate([row]);
  res.status(201).json({ data: out });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const b = { ...req.body };
  if (b.email) b.email = String(b.email).toLowerCase();
  if (b.tags !== undefined) b.tags = toArray(b.tags);
  if (b.company_id !== undefined) b.company_id = toInt(b.company_id);
  // Stored exactly as the old ::jsonb cast of JSON.stringify(value).
  if (b.custom_fields !== undefined) b.custom_fields = JSON.stringify(b.custom_fields);
  const patch = pick(b, ['name', 'email', 'phone', 'mobile', 'company_id', 'job_title', 'address', 'time_zone', 'language', 'tags', 'description', 'is_blocked', 'avatar_url', 'custom_fields']);
  if (b.password) {
    patch.password_hash = await bcrypt.hash(b.password, 10);
    patch.is_verified = true;
  }
  let row;
  if (Object.keys(patch).length) {
    const updated = await db.update('contacts', req.params.id, patch);
    if (!updated) throw notFound('Contact');
    [row] = await decorate([updated]);
  } else {
    row = await loadContact(req.params.id);
  }
  if (!row) throw notFound('Contact');
  res.json({ data: row });
}));

// Merge secondary contacts into a primary one (moves tickets, deletes duplicates).
router.post('/:id/merge', asyncHandler(async (req, res) => {
  const ids = toArray(req.body.contact_ids).map(Number).filter((n) => n && n !== Number(req.params.id));
  if (!ids.length) throw badRequest('contact_ids required');
  await db.batch([
    { op: 'update', table: 'tickets', where: { requester_id: { in: ids } }, patch: { requester_id: req.params.id } },
    { op: 'update', table: 'conversations', where: { contact_id: { in: ids } }, patch: { contact_id: req.params.id } },
    { op: 'remove', table: 'contacts', where: { id: { in: ids } } },
  ]);
  res.json({ data: (await loadContact(req.params.id)) || undefined });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const removed = await db.remove('contacts', req.params.id);
  if (!removed) throw notFound('Contact');
  res.json({ ok: true });
}));

export default router;
