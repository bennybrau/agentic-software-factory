-- M10 WP5. ticket_repo_choice records which repository a ticket's run worked
-- in: a dispatch row when a run starts with a repo, and a correction row when a
-- person moves the run to another repo (from_repo_id is the one it left).
-- epic_id groups tickets so a later suggestion can learn from the last choice
-- made for the same epic, where a correction outranks a dispatch.
--
-- The reverse migration is db/migrations/down/026_ticket_repo_choice.sql.
--
-- NOTE keep comments in this file free of the semicolon character (the migration
-- runner splits one simple-protocol string on semicolons and does not skip
-- comments).
CREATE TABLE IF NOT EXISTS ticket_repo_choice (
  id              bigserial PRIMARY KEY,
  ticket_provider text NOT NULL,
  ticket_id       text NOT NULL,
  ticket_key      text NOT NULL,
  epic_id         text,
  repo_id         text NOT NULL,
  repo_connection text,
  run_id          text NOT NULL REFERENCES agent_run(id),
  kind            text NOT NULL CHECK (kind IN ('dispatch', 'correction')),
  from_repo_id    text,
  "by"            text,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_repo_choice_epic_idx ON ticket_repo_choice (epic_id, at DESC);
