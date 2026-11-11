/**
 * Reverse the latest applied migration before rolling the image back:
 *   node apps/registry/dist/db/migrate-down.js 023_repo_connection
 * Run it with the NEW image (it ships the down file). See docs/UPGRADING.md.
 */
import '../boot-secrets.js';
import { sql, closePool } from './pool.js';
import { migrateDown, MigrationDownError, MIGRATIONS_DIR } from './migrate.js';

const name = process.argv[2];
if (!name) {
  console.error('usage: migrate-down <migration name>, e.g. 023_repo_connection');
  process.exit(2);
}
try {
  const r = await migrateDown(sql(), MIGRATIONS_DIR, name);
  console.log(`reverted ${r.reverted}`);
} catch (err) {
  console.error(err instanceof MigrationDownError ? `refused: ${err.message}` : err);
  process.exitCode = 1;
} finally {
  await closePool();
}
