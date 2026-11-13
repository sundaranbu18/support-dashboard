import { db } from '../db/index.js';
import { STATUSES } from './helpers.js';
import { setPausedStatuses } from './sla.js';

// STATUSES is shared by reference, so route validation always sees the configured list.
export async function refreshStatuses() {
  const rows = await db.find('ticket_statuses', null, { order: [['position', 'asc'], ['key', 'asc']] });
  STATUSES.length = 0;
  STATUSES.push(...rows.map((r) => r.key));
  setPausedStatuses(rows.filter((r) => r.stops_sla).map((r) => r.key));
}
