import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { migrate, migrateDown, MigrationDownError, MigrationTamperedError } from './migrate.js';
import { dbAvailable, testDb, tmpMigrationsDir } from '../test/harness.js';

// testDb() applies the REAL db/migrations/*.sql into a fresh schema, so a table
// that a shipped migration creates must exist right after setup.

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('migrate'); });
after(async () => { if (db) await db.close(); });

test('applies once, is idempotent, and refuses a tampered file', { skip }, async () => {
  const dir = await tmpMigrationsDir({ '900_a.sql': 'CREATE TABLE t_a (id int);', '901_b.sql': 'CREATE TABLE t_b (id int);' });
  const first = await migrate(db.sql, dir);
  assert.deepEqual(first.applied, ['900_a.sql', '901_b.sql']);
  const second = await migrate(db.sql, dir);
  assert.deepEqual(second.applied, []);
  await writeFile(join(dir, '900_a.sql'), 'CREATE TABLE t_a (id int, extra text);');
  await assert.rejects(() => migrate(db.sql, dir), (e: unknown) => e instanceof MigrationTamperedError && e.file === '900_a.sql');
});

test('006 creates the org_secret table', { skip }, async () => {
  const [row] = await db.sql<{ exists: boolean }[]>`SELECT to_regclass('org_secret') IS NOT NULL AS exists`;
  assert.equal(row.exists, true);
});

test('migrate ignores down/, and migrateDown reverses only the latest applied migration with a down file', { skip }, async () => {
  const dir = await tmpMigrationsDir({ '950_c.sql': 'CREATE TABLE t_c (id int);', '951_d.sql': 'CREATE TABLE t_d (id int);' });
  await mkdir(join(dir, 'down'));
  await writeFile(join(dir, 'down', '951_d.sql'), 'DROP TABLE t_d;');
  assert.deepEqual((await migrate(db.sql, dir)).applied, ['950_c.sql', '951_d.sql']);
  const exists = async (t: string) => (await db.sql<{ e: boolean }[]>`SELECT to_regclass(${t}) IS NOT NULL AS e`)[0].e;
  const applied = async (n: string) => (await db.sql`SELECT 1 FROM schema_migration WHERE name = ${n}`).length === 1;

  const refused = (re: RegExp) => (e: unknown) => e instanceof MigrationDownError && re.test(e.message);
  await assert.rejects(() => migrateDown(db.sql, dir, '960_z'), refused(/not applied/));
  await assert.rejects(() => migrateDown(db.sql, dir, '950_c'), refused(/not the latest/));
  assert.equal(await exists('t_c'), true);

  assert.deepEqual(await migrateDown(db.sql, dir, '951_d'), { reverted: '951_d.sql' });
  assert.equal(await exists('t_d'), false);
  assert.equal(await applied('951_d.sql'), false);

  await assert.rejects(() => migrateDown(db.sql, dir, '950_c.sql'), refused(/no down file/));
  assert.equal(await applied('950_c.sql'), true);
  // Re-applying after a reversal works: the row is gone, so the file runs again.
  assert.deepEqual((await migrate(db.sql, dir)).applied, ['951_d.sql']);
});
