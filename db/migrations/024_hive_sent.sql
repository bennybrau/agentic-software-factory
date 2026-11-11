-- #108. When the Hive hook sent a gate note or a chat message to team memory
-- (null = not sent, or Hive is off). The web shows "Sent to team memory for
-- review" once it is set.
--
-- The reverse migration is db/migrations/down/024_hive_sent.sql.
--
-- NOTE keep comments in this file free of the semicolon character (the migration
-- runner splits one simple-protocol string on semicolons and does not skip
-- comments).
ALTER TABLE run_gate    ADD COLUMN IF NOT EXISTS hive_sent_at timestamptz;
ALTER TABLE run_message ADD COLUMN IF NOT EXISTS hive_sent_at timestamptz;
