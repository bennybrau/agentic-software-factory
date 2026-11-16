import postgres from 'postgres';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STANDARD_TEAM } from '@asf/shared';
import type { CreateRunInput } from '@asf/shared';
import { migrate, MIGRATIONS_DIR } from '../db/migrate.js';
import { listenQueueChanges } from '../db/notify.js';

/**
 * Each test file gets its own schema so files can run in parallel against one
 * database. DATABASE_TEST_URL (default asf_test) is required; tests skip
 * cleanly when it is unreachable so `pnpm test` still passes on a laptop with
 * no Postgres — CI always has one.
 */
export const TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgres://asf:asf@localhost:5432/asf_test';

export async function testDb(name: string) {
  const schema = `t_${name}_${Date.now().toString(36)}`;
  const admin = postgres(TEST_URL, { onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const sql = postgres(TEST_URL, { onnotice: () => {}, transform: { column: { from: postgres.toCamel, to: postgres.fromCamel } }, connection: { search_path: schema } });
  await migrate(sql, MIGRATIONS_DIR);
  return {
    sql,
    async close() {
      await sql.end({ timeout: 2 });
      const a = postgres(TEST_URL, { onnotice: () => {} });
      await a.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await a.end();
    },
  };
}

/**
 * A database of its own, for a test that counts what a LISTENing server hears. NOTIFY reaches every
 * listener in the database whatever schema the row was written in, and the other test files write
 * notifications and queue moves to the shared one in parallel, so in a schema of the shared database
 * such a test also hears theirs. Needs a role that may CREATE DATABASE (the CI and worker test roles can).
 */
export async function testDatabase(name: string) {
  const db = `t_${name}_${Date.now().toString(36)}_${process.pid}`;
  const admin = postgres(TEST_URL, { onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${db}`);
  await admin.end();
  const url = new URL(TEST_URL);
  url.pathname = `/${db}`;
  return {
    url: url.toString(),
    /** Call after the server's pool is closed. FORCE drops any connection a failed test left behind. */
    async drop() {
      const a = postgres(TEST_URL, { onnotice: () => {} });
      await a.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** A migrated pool on a `testDatabase` of its own, for a store test that listens for NOTIFYs. */
export async function ownTestDb(name: string) {
  const own = await testDatabase(name);
  const sql = postgres(own.url, { onnotice: () => {}, transform: { column: { from: postgres.toCamel, to: postgres.fromCamel } } });
  await migrate(sql, MIGRATIONS_DIR);
  return {
    sql,
    async close() {
      await sql.end({ timeout: 2 });
      await own.drop();
    },
  };
}

/** Every `work_queue` NOTIFY on `sql`'s database, as "<id>:<state>", in the order they arrived. */
export async function heardQueueChanges(sql: postgres.Sql) {
  const heard: string[] = [];
  const { unlisten } = await listenQueueChanges(sql, (id, state) => { heard.push(`${id}:${state}`); });
  return {
    heard,
    /** Resolves once `payload` has arrived at or after index `from`; NOTIFYs come in commit order, so everything before it has too. */
    async waitFor(payload: string, from = 0, ms = 5000) {
      const until = Date.now() + ms;
      while (!heard.slice(from).includes(payload)) {
        if (Date.now() > until) throw new Error(`no ${payload} NOTIFY; heard ${JSON.stringify(heard)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    unlisten,
  };
}

export async function dbAvailable(): Promise<boolean> {
  try { const s = postgres(TEST_URL, { connect_timeout: 2 }); await s`select 1`; await s.end(); return true; } catch { return false; }
}

/** All gates auto, so a mechanical claim/finish test isn't parked waiting for a human. */
export const AUTO_GATES = { after_plan: { mode: 'auto' as const }, before_change_request: { mode: 'auto' as const }, before_merge: { mode: 'auto' as const } };

export function runInput(over: Partial<CreateRunInput> = {}): CreateRunInput {
  return { ticketId: 'asf-1', ticketKey: 'ASF-1', ticketProvider: 'mock', team: STANDARD_TEAM, gates: AUTO_GATES,
    repoId: null, maxCostUsd: 15, dispatchedBy: 'test', epicId: null, ...over };
}

/** Cancel every non-terminal run so a claim test sees only its own. */
export async function drain(sql: postgres.Sql): Promise<void> {
  await sql`UPDATE run_task SET state = 'skipped' WHERE state IN ('pending','running','awaiting_gate','needs_human')`;
  await sql`UPDATE agent_run SET state = 'cancelled', finished_at = now() WHERE state NOT IN ('succeeded','failed','cancelled','halted')`;
}

export async function tmpMigrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asf-mig-'));
  for (const [n, body] of Object.entries(files)) await writeFile(join(dir, n), body);
  return dir;
}
