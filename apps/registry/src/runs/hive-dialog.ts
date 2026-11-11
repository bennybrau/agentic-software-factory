import type { HiveDialogItem } from '@asf/shared';
import type { Sql } from '../db/pool.js';

/** How much of what the agent said a dialog item carries. */
export const HIVE_ANSWER_MAX = 1500;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

/**
 * Human dialog for the Hive hook (#78): every gate decided with a note, and
 * every message a person wrote in a run's chat, on a run with a repo, in any
 * run state. Each is paired with what the agent had put in front of them — the
 * gate's artifact, or the latest agent message before theirs. Oldest first;
 * `since` filters on when it was written.
 */
export async function hiveDialog(sql: Sql, q: { since?: string; limit: number; offset?: number }): Promise<HiveDialogItem[]> {
  const since = q.since ?? null;
  const rows = await sql`SELECT * FROM (
      SELECT 'gate' AS kind, g.run_id, r.repo_id, g.id, g.note AS text,
        left(coalesce(g.artifact, ''), ${HIVE_ANSWER_MAX}) AS answer, g.decided_by AS author, g.decided_at AS at
      FROM run_gate g JOIN agent_run r ON r.id = g.run_id
      WHERE r.repo_id IS NOT NULL AND btrim(coalesce(g.note, '')) <> '' AND g.decided_at IS NOT NULL
        AND (${since}::timestamptz IS NULL OR g.decided_at >= ${since}::timestamptz)
      UNION ALL
      SELECT 'msg' AS kind, m.run_id, r.repo_id, m.id, m.body AS text,
        left(coalesce(a.body, ''), ${HIVE_ANSWER_MAX}) AS answer, m.by_user AS author, m.created_at AS at
      FROM run_message m JOIN agent_run r ON r.id = m.run_id
      LEFT JOIN LATERAL (
        SELECT p.body FROM run_message p
        WHERE p.run_id = m.run_id AND p.author = 'agent' AND p.created_at < m.created_at
        ORDER BY p.created_at DESC, p.id DESC LIMIT 1) a ON true
      WHERE r.repo_id IS NOT NULL AND m.by_user IS NOT NULL
        AND (${since}::timestamptz IS NULL OR m.created_at >= ${since}::timestamptz)) d
    ORDER BY at, id LIMIT ${q.limit} OFFSET ${q.offset ?? 0}`;
  return rows.map((r) => ({
    kind: r.kind === 'gate' ? 'gate' : 'msg', runId: String(r.runId), repoId: String(r.repoId), id: String(r.id),
    text: String(r.text), answer: String(r.answer), author: r.author == null ? null : String(r.author), at: iso(r.at),
  }));
}

/** The Hive hook sent this gate note or chat message (#108). Stamps it once; a second call keeps the first time. */
export async function markHiveSent(sql: Sql, kind: 'gate' | 'msg', id: string): Promise<void> {
  if (kind === 'gate') await sql`UPDATE run_gate SET hive_sent_at = now() WHERE id = ${id} AND hive_sent_at IS NULL`;
  else await sql`UPDATE run_message SET hive_sent_at = now() WHERE id = ${id} AND hive_sent_at IS NULL`;
}
