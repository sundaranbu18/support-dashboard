import { Router } from 'express';
import { db, indexBy, groupBy, countBy, uniq, sortRows } from '../db/index.js';
import { authenticate, requireAgent, requirePrivilege, requirePrivilegeToWrite } from '../middleware/auth.js';
import { asyncHandler, notFound, badRequest } from '../utils/errors.js';
import { parseCsv, sendCsv } from '../utils/csv.js';
import { requireFields, pagination, toArray } from '../utils/helpers.js';

const router = Router();
router.use(authenticate, requireAgent, requirePrivilegeToWrite('manage_contacts'));

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const isOpen = (t) => t.status != null && t.status !== 'resolved' && t.status !== 'closed';

// The old BASE select: co.* + contact_count, ticket_count, open_ticket_count.
function withCounts(companies, contacts, tickets) {
  const contactCount = countBy(contacts, 'company_id');
  const ticketsBy = groupBy(tickets, 'company_id');
  return companies.map((co) => {
    const ts = ticketsBy.get(co.id) || [];
    return { ...co, contact_count: contactCount[co.id] || 0, ticket_count: ts.length, open_ticket_count: ts.filter(isOpen).length };
  });
}
async function decorate(companies) {
  if (!companies.length) return [];
  const ids = companies.map((co) => co.id);
  const { contacts, tickets } = await db.fetch({
    contacts: ['contacts', { company_id: { in: ids } }, { select: ['company_id'] }],
    tickets: ['tickets', { company_id: { in: ids }, deleted: false }, { select: ['company_id', 'status'] }],
  });
  return withCounts(companies, contacts, tickets);
}
async function loadCompany(id) {
  const co = await db.get('companies', id);
  if (!co) return null;
  return (await decorate([co]))[0];
}

router.get('/', asyncHandler(async (req, res) => {
  const { q, health_score, sort = 'name', order = 'asc' } = req.query;
  const { page, perPage, offset } = pagination(req.query);
  const where = {};
  if (health_score) where.health_score = { eq: health_score };
  let rows = await db.find('companies', where);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((co) => String(co.name).toLowerCase().includes(needle) || (co.domains || []).join(',').toLowerCase().includes(needle));
  }
  const sortCol = { name: 'name', created_at: 'created_at' }[sort] || 'name';
  sortRows(rows, [[sortCol, order === 'desc' ? 'desc' : 'asc']]);
  const data = await decorate(rows.slice(offset, offset + perPage));
  res.json({ data, meta: { total: rows.length, page, per_page: perPage } });
}));

router.get('/export', requirePrivilege('export_data'), asyncHandler(async (_req, res) => {
  const { companies, contacts, tickets } = await db.fetch({
    companies: ['companies', null, { order: [['name', 'asc']] }],
    contacts: ['contacts', { company_id: { isNull: false } }, { select: ['company_id'] }],
    tickets: ['tickets', { company_id: { isNull: false }, deleted: false }, { select: ['company_id', 'status'] }],
  });
  const rows = withCounts(companies, contacts, tickets);
  sendCsv(res, 'companies.csv', rows, ['name', 'domains', 'industry', 'account_tier', 'health_score', 'renewal_date', 'description', 'contact_count', 'ticket_count', 'created_at']);
}));

router.post('/import', asyncHandler(async (req, res) => {
  const records = parseCsv(req.body.csv || '');
  if (!records.length) throw badRequest('The CSV file has no data rows');
  const result = { created: 0, updated: 0, errors: [] };
  // INSERT ... ON CONFLICT (name) DO UPDATE SET domains = new, industry/description = COALESCE(new, old); applied in file order.
  const ops = [];
  for (const [i, r] of records.entries()) {
    if (!r.name) { result.errors.push(`Row ${i + 2}: name is required`); continue; }
    const domains = r.domains ? r.domains.split(/[;|]/).map((d) => d.trim().toLowerCase()).filter(Boolean) : [];
    const doc = { name: r.name, domains, industry: r.industry || null, description: r.description || null };
    const patch = { domains };
    if (doc.industry !== null) patch.industry = doc.industry;
    if (doc.description !== null) patch.description = doc.description;
    ops.push({ op: 'upsert', table: 'companies', where: { name: r.name }, doc, patch });
  }
  for (let i = 0; i < ops.length; i += 200) {
    for (const r of await db.batch(ops.slice(i, i + 200))) {
      if (r.inserted) result.created++; else result.updated++;
    }
  }
  res.json({ data: result });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { found, contacts, tickets, users } = await db.fetch({
    found: ['companies', { id: req.params.id }],
    contacts: ['contacts', { company_id: req.params.id }, { order: [['name', 'asc']], select: ['id', 'name', 'email', 'phone', 'job_title'] }],
    tickets: ['tickets', { company_id: req.params.id, deleted: false }, { order: [['created_at', 'desc']] }],
    users: ['users', null, { select: ['id', 'name'] }],
  });
  if (!found[0]) throw notFound('Company');
  const [company] = withCounts(found, contacts.map(() => ({ company_id: found[0].id })), tickets);
  // Requesters can belong to other companies, so look them up by id.
  const requesterIds = uniq(tickets.map((t) => t.requester_id));
  const requesters = requesterIds.length ? await db.find('contacts', { id: { in: requesterIds } }, { select: ['id', 'name'] }) : [];
  const requesterById = indexBy(requesters);
  const userById = indexBy(users);
  const ticketRows = tickets.filter((t) => requesterById.has(t.requester_id)).slice(0, 50).map((t) => ({
    id: t.id, subject: t.subject, status: t.status, priority: t.priority, created_at: t.created_at,
    requester_name: requesterById.get(t.requester_id).name, responder_name: userById.get(t.responder_id)?.name ?? null,
  }));
  res.json({ data: { ...company, contacts, tickets: ticketRows } });
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body;
  requireFields(b, ['name']);
  const row = await db.insert('companies', {
    name: b.name,
    domains: toArray(b.domains).map((d) => d.toLowerCase()),
    description: b.description || null,
    notes: b.notes || null,
    industry: b.industry || null,
    account_tier: b.account_tier || 'standard',
    health_score: b.health_score || 'neutral',
    renewal_date: b.renewal_date || null,
  });
  const [out] = await decorate([row]);
  res.status(201).json({ data: out });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const b = { ...req.body };
  if (b.domains !== undefined) b.domains = toArray(b.domains).map((d) => d.toLowerCase());
  if (b.renewal_date === '') b.renewal_date = null;
  // Stored exactly as the old ::jsonb cast of JSON.stringify(value).
  if (b.custom_fields !== undefined) b.custom_fields = JSON.stringify(b.custom_fields);
  const patch = pick(b, ['name', 'domains', 'description', 'notes', 'industry', 'account_tier', 'health_score', 'renewal_date', 'custom_fields']);
  let row;
  if (Object.keys(patch).length) {
    const updated = await db.update('companies', req.params.id, patch);
    if (!updated) throw notFound('Company');
    [row] = await decorate([updated]);
  } else {
    row = await loadCompany(req.params.id);
  }
  if (!row) throw notFound('Company');
  res.json({ data: row });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const removed = await db.remove('companies', req.params.id);
  if (!removed) throw notFound('Company');
  res.json({ ok: true });
}));

export default router;
