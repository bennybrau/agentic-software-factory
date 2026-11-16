import type { RepoChoiceWire } from '@asf/shared';
import type { Db } from '../db/pool.js';

/**
 * ticket_repo_choice (M10 WP5): which repo a ticket's run worked in. A dispatch
 * row is written when a run starts with a repo, a correction row when a person
 * moves the run to another one. The epic's latest choice feeds a later suggestion.
 */
export interface RepoChoiceInput {
  ticketProvider: string; ticketId: string; ticketKey: string; epicId: string | null;
  repoId: string; repoConnection: string | null; runId: string;
  kind: 'dispatch' | 'correction'; fromRepoId?: string | null; by?: string | null;
}

export async function recordRepoChoice(tx: Db, c: RepoChoiceInput): Promise<void> {
  await tx`INSERT INTO ticket_repo_choice (ticket_provider, ticket_id, ticket_key, epic_id, repo_id, repo_connection, run_id, kind, from_repo_id, "by")
    VALUES (${c.ticketProvider}, ${c.ticketId}, ${c.ticketKey}, ${c.epicId}, ${c.repoId}, ${c.repoConnection}, ${c.runId}, ${c.kind},
            ${c.fromRepoId ?? null}, ${c.by ?? null})`;
}

/** The epic's latest choice: any correction outranks a dispatch, then newest first. Null when there is none. */
export async function latestChoiceForEpic(sql: Db, epicId: string): Promise<RepoChoiceWire | null> {
  const rows = await sql`SELECT * FROM ticket_repo_choice WHERE epic_id = ${epicId}
    ORDER BY (kind = 'correction') DESC, at DESC, id DESC LIMIT 1`;
  return rows.length ? rowToChoice(rows[0]) : null;
}

/** The epic a run's earlier choice recorded, so a correction keeps it. */
export async function epicOfRun(tx: Db, runId: string): Promise<string | null> {
  const rows = await tx`SELECT epic_id FROM ticket_repo_choice WHERE run_id = ${runId} ORDER BY id DESC LIMIT 1`;
  return rows.length && rows[0].epicId != null ? String(rows[0].epicId) : null;
}

function rowToChoice(r: Record<string, unknown>): RepoChoiceWire {
  return {
    id: Number(r.id), ticketProvider: String(r.ticketProvider), ticketId: String(r.ticketId), ticketKey: String(r.ticketKey),
    epicId: r.epicId == null ? null : String(r.epicId), repoId: String(r.repoId),
    repoConnection: r.repoConnection == null ? null : String(r.repoConnection), runId: String(r.runId),
    kind: r.kind === 'correction' ? 'correction' : 'dispatch', fromRepoId: r.fromRepoId == null ? null : String(r.fromRepoId),
    by: r.by == null ? null : String(r.by), at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
  };
}
