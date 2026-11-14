-- #138. When the queue scheduler refuses to start a ticket, the entry records
-- when (refused_at) and the refusal's code (reason_code), and the bell gets one
-- notification pointing back at the entry (notification.queue_entry_id), so a
-- Try again or Dismiss can delete it. Rows refused before this migration keep
-- refused_at null and are never listed as refused.
--
-- The reverse migration is db/migrations/down/025_queue_refusal.sql.
--
-- NOTE keep comments in this file free of the semicolon character (the migration
-- runner splits one simple-protocol string on semicolons and does not skip
-- comments).
ALTER TABLE work_queue   ADD COLUMN IF NOT EXISTS refused_at timestamptz;
ALTER TABLE work_queue   ADD COLUMN IF NOT EXISTS reason_code text;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS queue_entry_id bigint;
CREATE INDEX IF NOT EXISTS notification_queue_entry_idx ON notification (queue_entry_id) WHERE queue_entry_id IS NOT NULL;
