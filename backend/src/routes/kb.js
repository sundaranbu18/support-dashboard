import { Router } from 'express';
import { db, indexBy, countBy, sortRows, nowIso } from '../db/index.js';
import { authenticate, optionalAuth, requireAgent, requirePrivilegeToWrite, isAgent } from '../middleware/auth.js';
import { asyncHandler, notFound, badRequest } from '../utils/errors.js';
import { requireFields, slugify, toArray, toInt } from '../utils/helpers.js';

const router = Router();

// Folder visibility filter for the current viewer (agents see everything).
function folderVisible(user) {
  if (isAgent(user)) return () => true;
  if (user) return (f) => f.visibility === 'public' || f.visibility === 'logged_in';
  return (f) => f.visibility === 'public';
}

// Postgres LEFT(text, n) counts characters, not UTF-16 code units.
const left = (s, n) => (s == null ? null : Array.from(s).slice(0, n).join(''));
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

// ---------------- public / portal tree
router.get('/portal', optionalAuth, asyncHandler(async (req, res) => {
  const visible = folderVisible(req.user);
  const { categories, allFolders, published } = await db.fetch({
    categories: ['kb_categories', { visible_in_portal: true }, { order: [['position', 'asc'], ['name', 'asc']] }],
    allFolders: ['kb_folders', null, { order: [['position', 'asc'], ['name', 'asc']] }],
    published: ['kb_articles', { status: 'published' }, { order: [['title', 'asc']] }],
  });
  const publishedCount = countBy(published, 'folder_id');
  const folders = allFolders.filter(visible).map((f) => ({ ...f, article_count: publishedCount[f.id] || 0 }));
  const visibleFolderIds = new Set(folders.map((f) => f.id));
  const visibleArticles = published.filter((a) => visibleFolderIds.has(a.folder_id));
  const articles = visibleArticles.map((a) => ({
    id: a.id, folder_id: a.folder_id, title: a.title, slug: a.slug, views: a.views, thumbs_up: a.thumbs_up, published_at: a.published_at, excerpt: left(a.body, 160),
  }));
  const tree = categories.map((c) => ({
    ...c,
    folders: folders.filter((f) => f.category_id === c.id).map((f) => ({ ...f, articles: articles.filter((a) => a.folder_id === f.id) })),
  })).filter((c) => c.folders.length);
  const popular = sortRows([...visibleArticles], [['views', 'desc']]).slice(0, 6)
    .map((a) => ({ id: a.id, title: a.title, slug: a.slug, views: a.views }));
  res.json({ data: { categories: tree, popular } });
}));

router.get('/portal/search', optionalAuth, asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ data: [] });
  const visible = folderVisible(req.user);
  const lower = q.toLowerCase();
  const { articles, folders, categories } = await db.fetch({
    articles: ['kb_articles', {
      status: 'published',
      or: [{ title: { icontains: q } }, { body: { icontains: q } }, { keywords: { contains: lower } }, { tags: { contains: lower } }],
    }, { order: [['views', 'desc']] }],
    folders: ['kb_folders'],
    categories: ['kb_categories'],
  });
  const folderById = indexBy(folders);
  const categoryById = indexBy(categories);
  const rows = [];
  for (const a of articles) {
    const f = folderById.get(a.folder_id);
    if (!f || !visible(f)) continue;
    const c = categoryById.get(f.category_id);
    if (!c) continue;
    rows.push({ id: a.id, title: a.title, slug: a.slug, views: a.views, excerpt: left(a.body, 200), folder_name: f.name, category_name: c.name });
    if (rows.length === 20) break;
  }
  res.json({ data: rows });
}));

router.get('/portal/articles/:slug', optionalAuth, asyncHandler(async (req, res) => {
  const visible = folderVisible(req.user);
  const { found, folders, categories } = await db.fetch({
    found: ['kb_articles', { slug: req.params.slug, status: 'published' }],
    folders: ['kb_folders'],
    categories: ['kb_categories'],
  });
  const folderById = indexBy(folders);
  const categoryById = indexBy(categories);
  const a = found.find((x) => {
    const f = folderById.get(x.folder_id);
    return f && visible(f) && categoryById.has(f.category_id);
  });
  if (!a) throw notFound('Article');
  const f = folderById.get(a.folder_id);
  const c = categoryById.get(f.category_id);
  const [, related, author] = await Promise.all([
    db.increment('kb_articles', a.id, { views: 1 }),
    db.find('kb_articles', { folder_id: a.folder_id, id: { ne: a.id }, status: 'published' }, { order: [['views', 'desc']], limit: 5, select: ['id', 'title', 'slug'] }),
    a.author_id != null ? db.get('users', a.author_id) : null,
  ]);
  res.json({
    data: {
      ...a, folder_name: f.name, folder_id: f.id, category_name: c.name, category_id: c.id, author_name: author ? author.name : null, related,
    },
  });
}));

router.post('/portal/articles/:slug/feedback', optionalAuth, asyncHandler(async (req, res) => {
  const col = req.body.helpful ? 'thumbs_up' : 'thumbs_down';
  const [row] = await db.updateWhere('kb_articles', { slug: req.params.slug }, {}, { inc: { [col]: 1 } });
  if (!row) throw notFound('Article');
  res.json({ data: { id: row.id, thumbs_up: row.thumbs_up, thumbs_down: row.thumbs_down } });
}));

// ---------------- agent management
router.use(authenticate, requireAgent, requirePrivilegeToWrite('manage_kb'));

router.get('/categories', asyncHandler(async (_req, res) => {
  const { categories, folders, articles } = await db.fetch({
    categories: ['kb_categories', null, { order: [['position', 'asc'], ['name', 'asc']] }],
    folders: ['kb_folders', null, { order: [['position', 'asc'], ['name', 'asc']] }],
    articles: ['kb_articles', null, { select: ['folder_id', 'status'] }],
  });
  const total = countBy(articles, 'folder_id');
  const published = countBy(articles.filter((a) => a.status === 'published'), 'folder_id');
  const withCounts = folders.map((f) => ({ ...f, article_count: total[f.id] || 0, published_count: published[f.id] || 0 }));
  res.json({ data: categories.map((c) => ({ ...c, folders: withCounts.filter((f) => f.category_id === c.id) })) });
}));

// COALESCE(MAX(position), 0) + 1
async function nextPosition(table, where) {
  const [last] = await db.find(table, where, { order: [['position', 'desc']], limit: 1, select: ['position'] });
  return (last?.position ?? 0) + 1;
}

router.post('/categories', asyncHandler(async (req, res) => {
  requireFields(req.body, ['name']);
  const position = toInt(req.body.position) ?? (await nextPosition('kb_categories'));
  const row = await db.insert('kb_categories', {
    name: req.body.name,
    description: req.body.description || null,
    position,
    visible_in_portal: req.body.visible_in_portal ?? true,
  });
  res.status(201).json({ data: row });
}));
router.put('/categories/:id', asyncHandler(async (req, res) => {
  const patch = pick(req.body, ['name', 'description', 'position', 'visible_in_portal']);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const row = await db.update('kb_categories', req.params.id, patch);
  if (!row) throw notFound('Category');
  res.json({ data: row });
}));
router.delete('/categories/:id', asyncHandler(async (req, res) => {
  await db.remove('kb_categories', req.params.id);
  res.json({ ok: true });
}));

router.post('/folders', asyncHandler(async (req, res) => {
  requireFields(req.body, ['name', 'category_id']);
  const categoryId = toInt(req.body.category_id);
  const position = toInt(req.body.position) ?? (await nextPosition('kb_folders', { category_id: categoryId }));
  const row = await db.insert('kb_folders', {
    category_id: categoryId,
    name: req.body.name,
    description: req.body.description || null,
    visibility: req.body.visibility || 'public',
    position,
  });
  res.status(201).json({ data: row });
}));
router.put('/folders/:id', asyncHandler(async (req, res) => {
  const patch = pick(req.body, ['name', 'description', 'visibility', 'position', 'category_id']);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const row = await db.update('kb_folders', req.params.id, patch);
  if (!row) throw notFound('Folder');
  res.json({ data: row });
}));
router.delete('/folders/:id', asyncHandler(async (req, res) => {
  await db.remove('kb_folders', req.params.id);
  res.json({ ok: true });
}));

// a.*, folder_name, category_id, category_name, author_name (folder + category INNER JOIN, author LEFT JOIN).
async function joinArticles(articles) {
  if (!articles.length) return [];
  const folderIds = [...new Set(articles.map((a) => a.folder_id))];
  const authorIds = [...new Set(articles.map((a) => a.author_id).filter((x) => x != null))];
  const { folders, categories, users } = await db.fetch({
    folders: ['kb_folders', { id: { in: folderIds } }],
    categories: ['kb_categories'],
    users: ['users', { id: { in: authorIds } }, { select: ['id', 'name'] }],
  });
  return attachArticles(articles, folders, categories, users);
}
function attachArticles(articles, folders, categories, users) {
  const folderById = indexBy(folders);
  const categoryById = indexBy(categories);
  const userById = indexBy(users);
  const out = [];
  for (const a of articles) {
    const f = folderById.get(a.folder_id);
    const c = f && categoryById.get(f.category_id);
    if (!f || !c) continue;
    out.push({ ...a, folder_name: f.name, category_id: f.category_id, category_name: c.name, author_name: userById.get(a.author_id)?.name ?? null });
  }
  return out;
}
async function loadArticle(id) {
  const { articles, folders, categories, users } = await db.fetch({
    articles: ['kb_articles', { id }],
    folders: ['kb_folders'],
    categories: ['kb_categories'],
    users: ['users', null, { select: ['id', 'name'] }],
  });
  return attachArticles(articles, folders, categories, users)[0] || null;
}

router.get('/articles', asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.folder_id) where.folder_id = { in: [toInt(req.query.folder_id)].filter((x) => x !== null) };
  if (req.query.status) where.status = { eq: req.query.status };
  if (req.query.q) where.or = [{ title: { icontains: req.query.q } }, { body: { icontains: req.query.q } }];
  const categoryId = req.query.category_id ? toInt(req.query.category_id) : undefined;
  const { articles, folders, categories, users } = await db.fetch({
    articles: ['kb_articles', where, { order: [['updated_at', 'desc']] }],
    folders: ['kb_folders'],
    categories: ['kb_categories'],
    users: ['users', null, { select: ['id', 'name'] }],
  });
  let rows = attachArticles(articles, folders, categories, users);
  if (categoryId !== undefined) rows = rows.filter((a) => categoryId !== null && a.category_id === categoryId);
  res.json({ data: rows.slice(0, 200) });
}));

router.get('/articles/:id', asyncHandler(async (req, res) => {
  const row = await loadArticle(req.params.id);
  if (!row) throw notFound('Article');
  res.json({ data: row });
}));

async function uniqueSlug(base, excludeId) {
  const taken = new Set(
    (await db.find('kb_articles', null, { select: ['id', 'slug'] }))
      .filter((a) => !excludeId || a.id !== excludeId)
      .map((a) => a.slug)
  );
  let slug = slugify(base) || 'article';
  let i = 1;
  while (taken.has(slug)) slug = `${slugify(base)}-${++i}`;
  return slug;
}

router.post('/articles', asyncHandler(async (req, res) => {
  const b = req.body;
  requireFields(b, ['title', 'folder_id']);
  const slug = await uniqueSlug(b.slug || b.title);
  const status = b.status === 'published' ? 'published' : 'draft';
  const row = await db.insert('kb_articles', {
    folder_id: toInt(b.folder_id),
    title: b.title,
    slug,
    body: b.body || '',
    status,
    author_id: req.user.id,
    tags: toArray(b.tags),
    keywords: toArray(b.keywords),
    published_at: status === 'published' ? nowIso() : null,
  });
  const [out] = await joinArticles([row]);
  res.status(201).json({ data: out });
}));

router.put('/articles/:id', asyncHandler(async (req, res) => {
  const b = { ...req.body };
  if (b.tags !== undefined) b.tags = toArray(b.tags);
  if (b.keywords !== undefined) b.keywords = toArray(b.keywords);
  if (b.folder_id !== undefined) b.folder_id = toInt(b.folder_id);
  if (b.slug) b.slug = await uniqueSlug(b.slug, Number(req.params.id));
  if (b.status && !['draft', 'published'].includes(b.status)) throw badRequest('Invalid status');
  const patch = pick(b, ['folder_id', 'title', 'slug', 'body', 'status', 'tags', 'keywords']);
  if (b.status === 'published') {
    // published_at = COALESCE(published_at, NOW())
    const current = await db.get('kb_articles', req.params.id);
    if (!current) throw notFound('Article');
    patch.published_at = current.published_at ?? nowIso();
  }
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const updated = await db.update('kb_articles', req.params.id, patch);
  if (!updated) throw notFound('Article');
  const [row] = await joinArticles([updated]);
  res.json({ data: row });
}));

router.delete('/articles/:id', asyncHandler(async (req, res) => {
  const removed = await db.remove('kb_articles', req.params.id);
  if (!removed) throw notFound('Article');
  res.json({ ok: true });
}));

export default router;
