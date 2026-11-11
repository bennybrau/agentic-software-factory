-- Reverse of 023_repo_connection.sql. Strips a known connection prefix from
-- repo_id so an older image sees the bare ids it stored, then drops the column.
-- The prefix list is KNOWN_CONNECTIONS (packages/shared/src/refs.ts) minus
-- adhoc, which is what nativeId() strips.
--
-- NOTE keep comments in this file free of the semicolon character.
UPDATE agent_run      SET repo_id = regexp_replace(repo_id, '^(mock|jira|github|gitlab|trello|monday|linear|todoist):', '') WHERE repo_id IS NOT NULL;
UPDATE work_queue     SET repo_id = regexp_replace(repo_id, '^(mock|jira|github|gitlab|trello|monday|linear|todoist):', '') WHERE repo_id IS NOT NULL;
UPDATE recurring_task SET repo_id = regexp_replace(repo_id, '^(mock|jira|github|gitlab|trello|monday|linear|todoist):', '');
ALTER TABLE agent_run      DROP COLUMN IF EXISTS repo_connection;
ALTER TABLE work_queue     DROP COLUMN IF EXISTS repo_connection;
ALTER TABLE recurring_task DROP COLUMN IF EXISTS repo_connection;
