/**
 * `asf hive-backfill [--since <date>] [--dry-run]` — send merged runs, and the
 * gate notes and chat messages people wrote, from before the Hive hook was on (#76, #78). Runs inside the api container
 * (it needs the registry secret and the tracker and SCM credentials), oldest merge first,
 * about 3 a second. Hive dedupes on `ref`, so running it twice is harmless.
 * See docs/HIVE.md.
 */
import './boot-secrets.js';
import { parseArgs } from 'node:util';
import { ticketRegistry } from './providers/tickets/index.js';
import { scmRegistry } from './providers/scm/index.js';
import { qualifyTickets } from './providers/tickets/set.js';
import { qualifyScm } from './providers/scm/set.js';
import { loadOrgSettings } from './settings.js';
import { backfillHive, hiveEnabled } from './hive.js';

const log = {
  info: (o: unknown, m?: string) => console.log(JSON.stringify({ level: 'info', msg: m, ...(o as object) })),
  error: (o: unknown, m?: string) => console.error(JSON.stringify({ level: 'error', msg: m, ...(o as object) })),
};

function fail(reason: string): never {
  console.error(`hive-backfill: ${reason}`);
  process.exit(2);
}

const { values } = parseArgs({ options: { since: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
const since = values.since == null ? undefined : Date.parse(values.since);
if (since != null && Number.isNaN(since)) fail(`--since ${JSON.stringify(values.since)} is not a date (use e.g. 2026-01-31)`);
const dryRun = values['dry-run'] === true;

try { await loadOrgSettings(); }
catch (e) { fail(`${(e as Error).message} — is the registry up?`); }
if (!dryRun && !hiveEnabled()) fail('HIVE_URL is blank — set it in .env first, or pass --dry-run');

const r = await backfillHive({ tickets: qualifyTickets(ticketRegistry.live), scm: qualifyScm(scmRegistry.live) }, { since, dryRun }, log);
if (dryRun) console.log(`dry run: ${r.runs} merged run(s), ${r.dialog} dialog message(s), ${r.bytes} bytes would be sent${since != null ? ` (since ${new Date(since).toISOString()})` : ''}`);
else console.log(`sent ${r.sent} of ${r.runs} merged run(s) and ${r.dialog} dialog message(s), ${r.bytes} bytes; ${r.failed} failed`);
process.exit(r.failed > 0 ? 1 : 0);
