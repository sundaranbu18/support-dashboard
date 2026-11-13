import { Router } from 'express';
import { db, indexBy, countBy, uniq, sortRows, nowIso } from '../db/index.js';
import { authenticate, optionalAuth, requirePrivilege, isAgent } from '../middleware/auth.js';
import { asyncHandler, notFound, forbidden, badRequest } from '../utils/errors.js';
import { requireFields, pagination } from '../utils/helpers.js';

const router = Router();
const canModerate = (user) => isAgent(user) && user.privileges.includes('moderate_forums');
const moderate = [authenticate, requirePrivilege('moderate_forums')];

const visibilityFor = (user) => (isAgent(user) ? ['public', 'logged_in', 'agents'] : user ? ['public', 'logged_in'] : ['public']);
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
// Postgres LEFT(text, n) counts characters, not UTF-16 code units.
const left = (s, n) => (s == null ? null : Array.from(s).slice(0, n).join(''));

async function moderationStatus(user) {
  if (isAgent(user)) return 'published';
  const row = await db.findOne('settings', { key: 'forums' });
  return row?.value?.moderate_customer_posts === false ? 'published' : 'waiting';
}
const author = (user) => (isAgent(user) ? { user_id: user.id, contact_id: null } : { user_id: null, contact_id: user.id });
const voterKey = (user) => `${user.kind}:${user.id}`;

// Loads users/contacts for rows with user_id/contact_id; returns (row) => { author_name, by_agent }.
async function authorLookup(rows) {
  const userIds = uniq(rows.map((r) => r.user_id));
  const contactIds = uniq(rows.map((r) => r.contact_id));
  if (!userIds.length && !contactIds.length) return () => ({ author_name: null, by_agent: false });
  const { users, contacts } = await db.fetch({
    users: ['users', { id: { in: userIds } }, { select: ['id', 'name'] }],
    contacts: ['contacts', { id: { in: contactIds } }, { select: ['id', 'name'] }],
  });
  const userById = indexBy(users);
  const contactById = indexBy(contacts);
  return (r) => {
    const u = r.user_id != null ? userById.get(r.user_id) : null;
    const c = r.contact_id != null ? contactById.get(r.contact_id) : null;
    return { author_name: u?.name ?? c?.name ?? null, by_agent: !!u };
  };
}

async function loadForum(id, user) {
  const forum = await db.get('forums', id);
  if (!forum || !visibilityFor(user).includes(forum.visibility)) throw notFound('Forum');
  return forum;
}
async function loadTopic(id, user) {
  const { topics, votes } = await db.fetch({
    topics: ['forum_topics', { id }],
    votes: ['forum_votes', { topic_id: id }, { select: ['id'] }],
  });
  const tp = topics[0];
  const [forum, authorOf] = tp ? await Promise.all([db.get('forums', tp.forum_id), authorLookup([tp])]) : [null, null];
  if (!tp || !forum) throw notFound('Topic');
  const topic = { ...tp, forum_name: forum.name, forum_type: forum.forum_type, visibility: forum.visibility, ...authorOf(tp), votes: votes.length };
  if (!visibilityFor(user).includes(topic.visibility)) throw notFound('Topic');
  const ownPending = user && !isAgent(user) && topic.contact_id === user.id && topic.status === 'waiting';
  if (topic.status !== 'published' && !canModerate(user) && !ownPending) throw notFound('Topic');
  return topic;
}

// ---------------- reading (public forums need no login)
router.get('/', optionalAuth, asyncHandler(async (req, res) => {
  const { categories, forums, topics } = await db.fetch({
    categories: ['forum_categories', null, { order: [['position', 'asc'], ['id', 'asc']] }],
    forums: ['forums', { visibility: { in: visibilityFor(req.user) } }, { order: [['position', 'asc'], ['id', 'asc']] }],
    topics: ['forum_topics', { status: 'published' }, { select: ['forum_id'] }],
  });
  const topicCount = countBy(topics, 'forum_id');
  const withCounts = forums.map((f) => ({ ...f, topic_count: topicCount[f.id] || 0 }));
  res.json({ data: categories.map((c) => ({ ...c, forums: withCounts.filter((f) => f.category_id === c.id) })) });
}));

router.get('/topics', optionalAuth, asyncHandler(async (req, res) => {
  const q = req.query;
  const { page, perPage, offset } = pagination(q, { per_page: 25 });
  const where = {};
  if (q.status && q.status !== 'published') {
    if (!canModerate(req.user)) throw forbidden();
    where.status = { eq: q.status };
  } else where.status = 'published';
  if (q.forum_id) where.forum_id = { eq: Number(q.forum_id) };
  if (q.q) where.or = [{ title: { icontains: q.q } }, { body: { icontains: q.q } }];
  if (q.mine && req.user) {
    if (isAgent(req.user)) where.user_id = { eq: req.user.id };
    else where.contact_id = { eq: req.user.id };
  }
  const { topics, forums } = await db.fetch({
    topics: ['forum_topics', where],
    forums: ['forums', { visibility: { in: visibilityFor(req.user) } }],
  });
  const forumById = indexBy(forums);
  const matching = sortRows(topics.filter((t) => forumById.has(t.forum_id)), [['is_pinned', 'desc'], ['updated_at', 'desc']]);
  const pageRows = matching.slice(offset, offset + perPage);
  const ids = pageRows.map((t) => t.id);
  const [authorOf, related] = await Promise.all([
    authorLookup(pageRows),
    ids.length ? db.fetch({
      posts: ['forum_posts', { topic_id: { in: ids }, status: 'published' }, { select: ['topic_id'] }],
      votes: ['forum_votes', { topic_id: { in: ids } }, { select: ['topic_id'] }],
    }) : { posts: [], votes: [] },
  ]);
  const replies = countBy(related.posts, 'topic_id');
  const votes = countBy(related.votes, 'topic_id');
  const rows = pageRows.map((tp) => {
    const f = forumById.get(tp.forum_id);
    return {
      id: tp.id, forum_id: tp.forum_id, title: tp.title, status: tp.status, is_locked: tp.is_locked, is_pinned: tp.is_pinned, stamp: tp.stamp,
      views: tp.views, created_at: tp.created_at, updated_at: tp.updated_at,
      excerpt: left(tp.body, 200), forum_name: f.name, forum_type: f.forum_type, author_name: authorOf(tp).author_name,
      reply_count: replies[tp.id] || 0,
      votes: votes[tp.id] || 0,
    };
  });
  res.json({ data: rows, meta: { total: matching.length, page, per_page: perPage } });
}));

router.get('/topics/:id', optionalAuth, asyncHandler(async (req, res) => {
  const topic = await loadTopic(req.params.id, req.user);
  let postWhere = { topic_id: topic.id, status: 'published' };
  if (canModerate(req.user)) postWhere = { topic_id: topic.id };
  else if (req.user && !isAgent(req.user)) postWhere = { topic_id: topic.id, or: [{ status: 'published' }, { contact_id: req.user.id }] };
  const [, { posts, voted }] = await Promise.all([
    db.increment('forum_topics', topic.id, { views: 1 }),
    db.fetch({
      posts: ['forum_posts', postWhere, { order: [['created_at', 'asc']] }],
      voted: req.user ? ['forum_votes', { topic_id: topic.id, voter: voterKey(req.user) }, { select: ['id'] }] : ['forum_votes', { id: { in: [] } }],
    }),
  ]);
  const authorOf = await authorLookup(posts);
  res.json({
    data: {
      ...topic,
      posts: posts.map((p) => ({ ...p, ...authorOf(p) })),
      has_voted: voted.length > 0,
      can_moderate: canModerate(req.user),
    },
  });
}));

// ---------------- posting
router.post('/topics', authenticate, asyncHandler(async (req, res) => {
  requireFields(req.body, ['forum_id', 'title', 'body']);
  const forum = await loadForum(req.body.forum_id, req.user);
  if (forum.forum_type === 'announcements' && !isAgent(req.user)) throw forbidden('Only agents can post announcements');
  const status = await moderationStatus(req.user);
  const row = await db.insert('forum_topics', { forum_id: forum.id, title: req.body.title, body: req.body.body, ...author(req.user), status });
  res.status(201).json({ data: row });
}));

router.post('/topics/:id/posts', authenticate, asyncHandler(async (req, res) => {
  requireFields(req.body, ['body']);
  const topic = await loadTopic(req.params.id, req.user);
  if (topic.is_locked && !canModerate(req.user)) throw badRequest('This topic is locked');
  const status = await moderationStatus(req.user);
  const doc = { topic_id: topic.id, body: req.body.body, ...author(req.user), status };
  let row;
  if (status === 'published') {
    [row] = await db.batch([
      { op: 'insert', table: 'forum_posts', doc },
      { op: 'update', table: 'forum_topics', where: { id: topic.id }, patch: { updated_at: nowIso() } },
    ]);
  } else {
    row = await db.insert('forum_posts', doc);
  }
  res.status(201).json({ data: row });
}));

router.post('/topics/:id/vote', authenticate, asyncHandler(async (req, res) => {
  const topic = await loadTopic(req.params.id, req.user);
  const key = voterKey(req.user);
  const removed = await db.removeWhere('forum_votes', { topic_id: topic.id, voter: key });
  if (!removed) await db.insert('forum_votes', { topic_id: topic.id, voter: key });
  res.json({ voted: !removed });
}));

// ---------------- moderation
router.get('/moderation/counts', ...moderate, asyncHandler(async (_req, res) => {
  const { topics, posts } = await db.fetch({
    topics: ['forum_topics', { status: { in: ['waiting', 'spam'] } }, { select: ['status'] }],
    posts: ['forum_posts', { status: { in: ['waiting', 'spam'] } }, { select: ['status'] }],
  });
  const t = countBy(topics, 'status');
  const p = countBy(posts, 'status');
  res.json({ data: { waiting: (t.waiting || 0) + (p.waiting || 0), spam: (t.spam || 0) + (p.spam || 0) } });
}));
router.get('/moderation/posts', ...moderate, asyncHandler(async (req, res) => {
  const posts = await db.find('forum_posts', { status: req.query.status || 'waiting' }, { order: [['created_at', 'desc']] });
  const topicIds = uniq(posts.map((p) => p.topic_id));
  const [topics, authorOf] = await Promise.all([
    topicIds.length ? db.find('forum_topics', { id: { in: topicIds } }, { select: ['id', 'title'] }) : [],
    authorLookup(posts),
  ]);
  const topicById = indexBy(topics);
  const rows = posts.filter((p) => topicById.has(p.topic_id))
    .map((p) => ({ ...p, topic_title: topicById.get(p.topic_id).title, author_name: authorOf(p).author_name }));
  res.json({ data: rows });
}));
router.patch('/topics/:id', ...moderate, asyncHandler(async (req, res) => {
  const patch = pick(req.body, ['title', 'body', 'status', 'is_locked', 'is_pinned', 'stamp', 'forum_id']);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const row = await db.update('forum_topics', req.params.id, { ...patch, updated_at: nowIso() });
  if (!row) throw notFound('Topic');
  res.json({ data: row });
}));
router.delete('/topics/:id', ...moderate, asyncHandler(async (req, res) => {
  await db.remove('forum_topics', req.params.id);
  res.json({ ok: true });
}));
router.patch('/posts/:id', ...moderate, asyncHandler(async (req, res) => {
  const patch = pick(req.body, ['body', 'status', 'is_answer']);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const row = await db.update('forum_posts', req.params.id, patch);
  if (!row) throw notFound('Post');
  res.json({ data: row });
}));
router.delete('/posts/:id', ...moderate, asyncHandler(async (req, res) => {
  await db.remove('forum_posts', req.params.id);
  res.json({ ok: true });
}));

// ---------------- structure
const structure = (table, fields, required) => {
  router.post(`/${table}`, ...moderate, asyncHandler(async (req, res) => {
    requireFields(req.body, required);
    const row = await db.insert(table, pick(req.body, fields));
    res.status(201).json({ data: row });
  }));
  router.put(`/${table}/:id`, ...moderate, asyncHandler(async (req, res) => {
    const patch = pick(req.body, fields);
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');
    const row = await db.update(table, req.params.id, patch);
    if (!row) throw notFound('Forum');
    res.json({ data: row });
  }));
  router.delete(`/${table}/:id`, ...moderate, asyncHandler(async (req, res) => {
    await db.remove(table, req.params.id);
    res.json({ ok: true });
  }));
};
structure('forum_categories', ['name', 'description', 'position'], ['name']);
structure('forums', ['category_id', 'name', 'description', 'forum_type', 'visibility', 'position'], ['category_id', 'name']);

export default router;
