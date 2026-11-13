// Wipes ALL application data in the Convex deployment (every table plus uploaded files),
// then restores the built-in defaults. Run the seeds afterwards for demo data (`npm run db:reset` does both).
import { db, callFiles, TABLES } from './index.js';
import { ensureDefaults } from './defaults.js';

async function main() {
  const tables = Object.keys(TABLES);
  if (!process.argv.includes('--yes')) {
    console.log('This will permanently delete ALL data in the Convex deployment:');
    console.log(`  - every row in ${tables.length} tables: ${tables.join(', ')}`);
    console.log('  - every uploaded file in Convex storage');
    console.log('and then recreate the built-in defaults (roles, agent statuses, ticket statuses, email notifications, default survey).');
    console.log('Re-run with --yes to proceed: node src/db/reset.js --yes');
    process.exitCode = 1;
    return;
  }
  for (const table of tables) {
    await db.truncate(table);
    console.log(`Cleared ${table}`);
  }
  let removed;
  let files = 0;
  do {
    removed = await callFiles('mutation', 'removeAll');
    files += removed;
  } while (removed > 0);
  console.log(`Removed ${files} uploaded file(s)`);
  await ensureDefaults();
  console.log('Defaults restored.');
}

main().catch((err) => { console.error(err); process.exit(1); });
