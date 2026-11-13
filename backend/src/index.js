import app from './app.js';
import { env } from './config/env.js';
import { db } from './db/index.js';
import { startJobs } from './utils/jobs.js';
import { refreshStatuses } from './utils/statuses.js';

async function main() {
  try {
    await db.ping();
    await refreshStatuses();
    console.log(`Connected to Convex ${env.convexUrl}`);
  } catch (err) {
    console.error('Could not reach Convex:', err.message);
    console.error('Check CONVEX_URL / NEXUS_SERVER_SECRET in backend/.env, then run `npm run db:seed` for demo data.');
    process.exit(1);
  }
  app.listen(env.port, () => {
    console.log(`Nexus listening on http://localhost:${env.port}`);
    startJobs();
  });
}

main();
