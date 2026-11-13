-- Reverse of 025_queue_refusal.sql.
--
-- NOTE keep comments in this file free of the semicolon character.
DROP INDEX IF EXISTS notification_queue_entry_idx;
ALTER TABLE notification DROP COLUMN IF EXISTS queue_entry_id;
ALTER TABLE work_queue   DROP COLUMN IF EXISTS reason_code;
ALTER TABLE work_queue   DROP COLUMN IF EXISTS refused_at;
