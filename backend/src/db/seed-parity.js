// Adds sample data for the newer features to an existing database. Safe to re-run.
import { db } from './index.js';
import { ensureDefaults } from './defaults.js';

const isEmpty = async (table) => (await db.count(table)) === 0;

async function main() {
  await ensureDefaults();
  if (await isEmpty('products')) {
    await db.insertMany('products', [
      { name: 'Learning Platform', description: 'Courses, certificates and learner accounts', portal_name: 'Learner Help' },
      { name: 'Career Advisor', description: 'Career guidance tools', portal_name: 'Career Help' },
    ]);
  }
  await db.batch([
    { op: 'upsert', table: 'ticket_fields', where: { name: 'category' }, doc: { name: 'category', label: 'Category', field_type: 'dropdown', options: ['Account & Login', 'Course Access', 'Certificates', 'Name Change Request', 'Other'], position: 20 } },
    { op: 'upsert', table: 'ticket_fields', where: { name: 'severity' }, doc: { name: 'severity', label: 'Severity', field_type: 'dropdown', options: ['P1', 'P2', 'P3', 'P4'], position: 21 } },
  ]);
  const [firstGroupRow] = await db.find('groups', undefined, { order: [['id', 'asc']], limit: 1, select: ['id'] });
  const firstGroup = firstGroupRow?.id || null;
  if (await isEmpty('scenarios')) {
    await db.insertMany('scenarios', [
      {
        name: 'Escalate to second line', description: 'Raises priority, escalates and leaves a note',
        actions: [{ type: 'set_priority', value: 'high' }, ...(firstGroup ? [{ type: 'assign_group', value: String(firstGroup) }] : []), { type: 'escalate' }, { type: 'add_note', value: 'Escalated by scenario.' }],
      },
      { name: 'Close as duplicate', description: 'Tags the ticket and closes it', actions: [{ type: 'add_tag', value: 'duplicate' }, { type: 'set_status', value: 'closed' }] },
    ]);
  }
  if (await isEmpty('ticket_templates')) {
    const parent = await db.insert('ticket_templates', {
      name: 'Course migration', description: 'Parent ticket with one child per team', subject: 'Course migration request', body: 'Please describe the course to migrate.', priority: 'medium', type: 'other', tags: ['migration'],
    });
    await db.insertMany('ticket_templates', [
      { name: 'Migrate content', parent_template_id: parent.id, subject: 'Migrate course content', body: 'Move the course content to the new platform.', priority: 'medium' },
      { name: 'Verify enrolments', parent_template_id: parent.id, subject: 'Verify learner enrolments', body: 'Confirm enrolments after the migration.', priority: 'medium' },
    ]);
    await db.insert('ticket_templates', { name: 'Initiate a refund', description: 'For cancellation requests', subject: 'Refund request', body: 'Order reference:\nReason:', priority: 'medium', type: 'refund' });
  }
  if (await isEmpty('ticket_forms')) {
    await db.insertMany('ticket_forms', [
      { name: 'Report a problem', description: 'Something is not working as expected', type: 'problem', field_names: ['category', 'severity'] },
      { name: 'Ask a question', description: 'Get help using the platform', type: 'question', field_names: ['category'] },
    ]);
  }
  if (await isEmpty('mailboxes')) {
    await db.insert('mailboxes', { name: 'Support', email: 'support@supportdesk.local', is_default: true });
  }
  if (await isEmpty('forum_categories')) {
    const cat = await db.insert('forum_categories', { name: 'Community', description: 'Ask questions and share ideas' });
    const forums = await db.insertMany('forums', [
      { category_id: cat.id, name: 'Announcements', description: 'News from the team', forum_type: 'announcements' },
      { category_id: cat.id, name: 'Feature Requests', description: 'Tell us what to build next', forum_type: 'ideas' },
      { category_id: cat.id, name: 'Tips and Tricks', description: 'Help each other out', forum_type: 'questions' },
      { category_id: cat.id, name: 'Report a problem', description: 'Tell us what went wrong', forum_type: 'problems' },
    ]);
    const agent = await db.findOne('users', { role: 'admin' }, { order: [['id', 'asc']] });
    const topic = await db.insert('forum_topics', {
      forum_id: forums[0].id, title: 'Welcome to the community', body: 'Introduce yourself and ask anything.', user_id: agent?.id || null, is_pinned: true,
    });
    await db.insert('forum_posts', { topic_id: topic.id, body: 'Glad to have you here.', user_id: agent?.id || null });
  }
  console.log('Sample data for parity features is in place.');
}

main().catch((err) => { console.error(err); process.exit(1); });
