-- Reverse of 024_hive_sent.sql.
--
-- NOTE keep comments in this file free of the semicolon character.
ALTER TABLE run_gate    DROP COLUMN IF EXISTS hive_sent_at;
ALTER TABLE run_message DROP COLUMN IF EXISTS hive_sent_at;
