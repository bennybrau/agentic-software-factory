import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { nativeId } from '@asf/shared';
import { migrate, migrateDown, MIGRATIONS_DIR } from '../db/migrate.js';
import { qualifyStoredRefs, RefsBackfillError } from './refs-backfill.js';
import { dbAvailable, testDb } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('refs_backfill'); });
after(async () => { if (db) await db.close(); });

async function seed(): Promise<void> {
  const run = (id: string, provider: string, ticket: string, repo: string | null) => db.sql`
    INSERT INTO agent_run (id, ticket_id, ticket_key, ticket_provider, state, team_name, team, gates, repo_id, max_cost_usd)
    VALUES (${id}, ${ticket}, ${ticket}, ${provider}, 'succeeded', 'standard', '{}'::jsonb, '{}'::jsonb, ${repo}, 5)`;
  await run('r1', 'jira', 'PROJ-1', 'acme/web');
  await run('r2', 'github', 'acme/web#42', 'github:acme/api');
  await run('r3', 'adhoc', 'adhoc:ce17', 'acme/platform/web/shared-ui');
  await run('r4', 'jira', 'PROJ-2', null);
  const q = (id: number, provider: string, ticket: string, repo: string | null) => db.sql`
    INSERT INTO work_queue (id, ticket_provider, ticket_id, position, repo_id) VALUES (${id}, ${provider}, ${ticket}, ${id}, ${repo})`;
  await q(1, 'jira', 'PROJ-3', 'acme/web');
  await q(2, 'jira', 'PROJ-4', null);
  await q(3, 'github', 'acme/web#7', 'github:acme/web');
  const rec = (id: string, repo: string) => db.sql`
    INSERT INTO recurring_task (id, title, repo_id, schedule, timezone) VALUES (${id}, 'nightly', ${repo}, '{}'::jsonb, 'UTC')`;
  await rec('c1', 'acme/web');
  await rec('c2', 'github:acme/ops');
}

async function dump() {
  return {
    agentRun: await db.sql`SELECT * FROM agent_run ORDER BY id`,
    workQueue: await db.sql`SELECT * FROM work_queue ORDER BY id`,
    recurringTask: await db.sql`SELECT * FROM recurring_task ORDER BY id`,
  };
}
/** What an older image stored: the down migration strips any prefix, including ids the WP1b api already wrote qualified. */
const bare = (d: Awaited<ReturnType<typeof dump>>) => Object.fromEntries(Object.entries(d).map(([k, rows]) =>
  [k, rows.map((r) => ({ ...r, repoId: r.repoId == null ? r.repoId : nativeId(String(r.repoId)) }))]));
const refs = async (table: string) => (await db.sql`SELECT id, repo_id, repo_connection FROM ${db.sql(table)} ORDER BY id`)
  .map((r) => [String(r.id), r.repoId, r.repoConnection]);

test('qualifies stored repo ids, is idempotent, and the down migration restores the seed', { skip }, async () => {
  await migrateDown(db.sql, MIGRATIONS_DIR, '025_queue_refusal'); // 023 can only go down as the latest
  await migrateDown(db.sql, MIGRATIONS_DIR, '024_hive_sent');
  await migrateDown(db.sql, MIGRATIONS_DIR, '023_repo_connection');
  await seed();
  const seeded = await dump();

  await migrate(db.sql, MIGRATIONS_DIR);
  const counts = await qualifyStoredRefs(db.sql, { scm: 'github', tickets: 'jira' });
  assert.deepEqual(counts, { agentRun: 3, workQueue: 2, recurringTask: 2 });
  assert.deepEqual(await refs('agent_run'), [
    ['r1', 'github:acme/web', 'github'],
    ['r2', 'github:acme/api', 'github'],
    ['r3', 'github:acme/platform/web/shared-ui', 'github'],
    ['r4', null, null],
  ]);
  assert.deepEqual(await refs('work_queue'), [['1', 'github:acme/web', 'github'], ['2', null, null], ['3', 'github:acme/web', 'github']]);
  assert.deepEqual(await refs('recurring_task'), [['c1', 'github:acme/web', 'github'], ['c2', 'github:acme/ops', 'github']]);
  // Ticket ids and providers are untouched.
  const tickets = (await db.sql`SELECT ticket_provider, ticket_id FROM agent_run ORDER BY id`).map((r) => `${r.ticketProvider}|${r.ticketId}`);
  assert.deepEqual(tickets, ['jira|PROJ-1', 'github|acme/web#42', 'adhoc|adhoc:ce17', 'jira|PROJ-2']);
  const qualified = await dump();

  assert.deepEqual(await qualifyStoredRefs(db.sql, { scm: 'github', tickets: 'jira' }), { agentRun: 0, workQueue: 0, recurringTask: 0 });
  assert.deepEqual(await dump(), qualified);

  await migrateDown(db.sql, MIGRATIONS_DIR, '025_queue_refusal'); // 023 can only go down as the latest
  await migrateDown(db.sql, MIGRATIONS_DIR, '024_hive_sent');
  await migrateDown(db.sql, MIGRATIONS_DIR, '023_repo_connection');
  assert.deepEqual(bare(await dump()), bare(seeded));
  assert.deepEqual((await db.sql`SELECT repo_id FROM agent_run WHERE id = 'r2'`)[0].repoId, 'acme/api');

  // Up again: every id was on the install's one code host, so it comes back exactly.
  await migrate(db.sql, MIGRATIONS_DIR);
  await qualifyStoredRefs(db.sql, { scm: 'github', tickets: 'jira' });
  assert.deepEqual(await dump(), qualified);
});

test('refuses a bad scm or ticket kind, or an unknown stored ticket_provider, and changes nothing', { skip }, async () => {
  await db.sql`UPDATE agent_run SET repo_id = 'acme/bare', repo_connection = NULL WHERE id = 'r1'`;
  await db.sql`INSERT INTO work_queue (id, ticket_provider, ticket_id, position, repo_id) VALUES (9, 'bogus', 'X-1', 9, 'acme/web')`;
  const before = await dump();
  const refused = (re: RegExp) => (e: unknown) => e instanceof RefsBackfillError && re.test(e.message);
  await assert.rejects(() => qualifyStoredRefs(db.sql, { scm: 'jira', tickets: 'jira' }), refused(/not an SCM provider kind/));
  await assert.rejects(() => qualifyStoredRefs(db.sql, { scm: 'github', tickets: 'nope' }), refused(/not a ticket provider kind/));
  await assert.rejects(() => qualifyStoredRefs(db.sql, { scm: 'github', tickets: 'jira' }), refused(/bogus/));
  assert.deepEqual(await dump(), before);
});
