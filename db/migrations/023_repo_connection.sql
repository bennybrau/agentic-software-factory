-- M12 WP1. repo_connection names the code host (SCM connection) that owns a
-- row's repo_id. It is null until the api's boot backfill
-- (apps/registry/src/runs/refs-backfill.ts) qualifies the stored repo ids as
-- <connection>:<native id> and fills it from the prefix.
--
-- The reverse migration is db/migrations/down/023_repo_connection.sql
-- (run with apps/registry/src/db/migrate-down.ts, see docs/UPGRADING.md).
--
-- NOTE keep comments in this file free of the semicolon character (the migration
-- runner splits one simple-protocol string on semicolons and does not skip
-- comments).
ALTER TABLE agent_run      ADD COLUMN IF NOT EXISTS repo_connection text;
ALTER TABLE work_queue     ADD COLUMN IF NOT EXISTS repo_connection text;
ALTER TABLE recurring_task ADD COLUMN IF NOT EXISTS repo_connection text;
