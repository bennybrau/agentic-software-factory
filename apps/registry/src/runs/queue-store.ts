import type { WorkQueueEntry, QueueMode, EnqueueItem } from '@asf/shared';
import { workQueueEntrySchema } from '@asf/shared';
import type { Sql } from '../db/pool.js';
import { newId } from './ids.js';
import { recordNotification } from './notification-store.js';

/**
 * The only module that writes work_queue. Enqueue/list/reorder/remove serve the
 * UI; readyEntries/markEntry serve the scheduler that lives in the api (the api
 * holds the ticket/SCM providers a dispatch needs; the registry only stores the
 * queue and answers "which entries may dispatch now").
 */

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const numOrNull = (v: unknown) => (v == null ? null : Number(v));

function rowToEntry(r: Row): WorkQueueEntry {
  return workQueueEntrySchema.parse({
    id: String(r.id), ticketId: r.ticketId, ticketProvider: r.ticketProvider, ticketKey: r.ticketKey,
    repoId: r.repoId ?? null, teamName: r.teamName ?? null, maxCostUsd: numOrNull(r.maxCostUsd),
    mode: r.mode, position: Number(r.position), batchId: r.batchId, state: r.state,
    runId: r.runId ?? null, reason: r.reason ?? null, addedBy: r.addedBy ?? null,
    addedAt: iso(r.addedAt), dispatchedAt: iso(r.dispatchedAt),
    dependsOn: Array.isArray(r.dependsOn) ? (r.dependsOn as unknown[]).map(String) : [],
    refusedAt: iso(r.refusedAt), reasonCode: r.reasonCode ?? null,
  });
}

// --- reads -----------------------------------------------------------------

export async function listQueue(sql: Sql, q: { state?: string; limit: number }): Promise<WorkQueueEntry[]> {
  const rows = await sql`SELECT * FROM work_queue
    WHERE (${q.state ?? null}::text IS NULL OR state = ${q.state ?? null})
    ORDER BY position, added_at LIMIT ${q.limit}`;
  return rows.map(rowToEntry);
}

// --- writes ----------------------------------------------------------------

/**
 * Append a batch to the tail of the queue. Position is a float so a later
 * reorder can slot an entry between two others without renumbering. A ticket
 * already queued is skipped (unique partial index), not an error for the batch.
 */
export async function enqueue(sql: Sql, items: EnqueueItem[], mode: QueueMode, by: string | null): Promise<WorkQueueEntry[]> {
  const batchId = newId('batch');
  return sql.begin(async (tx) => {
    const [{ tail }] = await tx<{ tail: number }[]>`SELECT coalesce(max(position), 0) AS tail FROM work_queue WHERE state = 'queued'`;
    const created: WorkQueueEntry[] = [];
    let pos = Number(tail);
    for (const it of items) {
      pos += 1;
      // id is a bigserial from the M1 stub; let the DB assign it.
      const rows = await tx`INSERT INTO work_queue
        (ticket_id, ticket_provider, ticket_key, repo_id, team_name, max_cost_usd, mode, position, batch_id, added_by)
        VALUES (${it.ticketId}, ${it.ticketProvider}, ${it.ticketKey}, ${it.repoId}, ${it.teamName},
                ${it.maxCostUsd}, ${mode}, ${pos}, ${batchId}, ${by})
        ON CONFLICT DO NOTHING RETURNING *`;
      if (rows.length) created.push(rowToEntry(rows[0]));
    }
    return created;
  });
}

/** Move `id` to just before `beforeId` (null = to the tail). Only queued entries reorder. */
export async function reorderQueue(sql: Sql, id: string, beforeId: string | null): Promise<void> {
  await sql.begin(async (tx) => {
    if (beforeId == null) {
      const [{ tail }] = await tx<{ tail: number }[]>`SELECT coalesce(max(position), 0) AS tail FROM work_queue WHERE state = 'queued'`;
      await tx`UPDATE work_queue SET position = ${Number(tail) + 1} WHERE id = ${id} AND state = 'queued'`;
      return;
    }
    const before = await tx`SELECT position FROM work_queue WHERE id = ${beforeId} AND state = 'queued'`;
    if (before.length === 0) return;
    const beforePos = Number(before[0].position);
    // The entry immediately preceding beforeId in queued order; the new position is the midpoint.
    const prev = await tx`SELECT position FROM work_queue WHERE state = 'queued' AND position < ${beforePos} AND id <> ${id}
      ORDER BY position DESC LIMIT 1`;
    const prevPos = prev.length ? Number(prev[0].position) : beforePos - 1;
    await tx`UPDATE work_queue SET position = ${(prevPos + beforePos) / 2} WHERE id = ${id} AND state = 'queued'`;
  });
}

/** Remove a queued entry, or dismiss a refused (failed) one along with its bell notification. */
export async function removeQueueEntry(sql: Sql, id: string, by: string | null): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`UPDATE work_queue SET state = 'cancelled', reason = ${`removed by ${by ?? 'operator'}`}
      WHERE id = ${id} AND state IN ('queued', 'failed')`;
    await tx`DELETE FROM notification WHERE queue_entry_id = ${id}`;
  });
}

/**
 * Try a refused entry again. It goes back to the tail of the queue as `by`'s,
 * with its repo, team, cost cap, batch and depends_on kept and the refusal
 * cleared. If the ticket is already queued again (one live entry per ticket),
 * the refused entry is only cancelled. Either way its notification goes.
 */
export async function retryQueueEntry(sql: Sql, id: string, by: string | null): Promise<{ requeued: boolean }> {
  return sql.begin(async (tx) => {
    const rows = await tx`SELECT ticket_provider, ticket_id FROM work_queue WHERE id = ${id} AND state = 'failed' FOR UPDATE`;
    if (rows.length === 0) return { requeued: false };
    await tx`DELETE FROM notification WHERE queue_entry_id = ${id}`;
    const live = await tx`SELECT 1 FROM work_queue
      WHERE ticket_provider = ${rows[0].ticketProvider} AND ticket_id = ${rows[0].ticketId} AND state = 'queued'`;
    if (live.length) {
      await tx`UPDATE work_queue SET state = 'cancelled', reason = 'already queued' WHERE id = ${id}`;
      return { requeued: false };
    }
    const [{ tail }] = await tx<{ tail: number }[]>`SELECT coalesce(max(position), 0) AS tail FROM work_queue WHERE state = 'queued'`;
    await tx`UPDATE work_queue SET state = 'queued', position = ${Number(tail) + 1}, added_by = ${by},
      reason = NULL, reason_code = NULL, refused_at = NULL WHERE id = ${id}`;
    return { requeued: true };
  });
}

/**
 * The scheduler's read. Returns queued entries that may be dispatched right now,
 * oldest-position-first. A parallel entry is always ready. A serial entry is
 * ready only when every earlier queued entry in its OWN batch is gone from the
 * queue AND the batch's most-recent dispatched entry's run has reached its first
 * gate (awaiting_checkpoint) or a terminal state — i.e. it is no longer actively
 * occupying the fleet in a way that would make "serial" meaningless.
 *
 * Either mode also waits on `depends_on` (a planner split): every listed ticket
 * must have a run whose pull request is merged — by ASF (delivery_outcome
 * merged) or by a person (the merge watcher stamps change_request_state merged).
 * A dependency is on real code on main, never on an open PR.
 */
export async function readyQueueEntries(sql: Sql, limit: number): Promise<WorkQueueEntry[]> {
  const rows = await sql`
    SELECT q.* FROM work_queue q
     WHERE q.state = 'queued'
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(q.depends_on) AS dep(ticket_id)
          WHERE NOT EXISTS (
            SELECT 1 FROM agent_run r
             WHERE r.ticket_id = dep.ticket_id
               AND (r.delivery_outcome = 'merged' OR r.change_request_state = 'merged')))
       AND (
         q.mode = 'parallel'
         OR (
           -- serial: no earlier queued sibling in the same batch
           NOT EXISTS (
             SELECT 1 FROM work_queue e
              WHERE e.batch_id = q.batch_id AND e.state = 'queued' AND e.position < q.position)
           -- and the batch's latest dispatched run (if any) has settled at a gate or terminally
           AND NOT EXISTS (
             SELECT 1 FROM work_queue d
               JOIN agent_run r ON r.id = d.run_id
              WHERE d.batch_id = q.batch_id AND d.state = 'dispatched'
                AND r.state IN ('queued', 'running'))
         )
       )
     ORDER BY q.position, q.added_at
     LIMIT ${limit}`;
  return rows.map(rowToEntry);
}

/**
 * The scheduler's outcome for one entry. Only a queued entry moves. A refusal
 * (failed) is stamped with when and why, and puts exactly one notification in
 * the bell, in the same transaction.
 */
export async function markQueueEntry(sql: Sql, id: string, state: 'dispatched' | 'failed', runId: string | null, reason: string | null, code: string | null = null): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx`UPDATE work_queue SET state = ${state}, run_id = coalesce(${runId}, run_id),
      reason = coalesce(${reason}, reason),
      dispatched_at = CASE WHEN ${state} = 'dispatched' THEN now() ELSE dispatched_at END,
      refused_at = CASE WHEN ${state} = 'failed' THEN now() ELSE refused_at END,
      reason_code = CASE WHEN ${state} = 'failed' THEN ${code} ELSE reason_code END
      WHERE id = ${id} AND state = 'queued'
      RETURNING ticket_key, reason`;
    if (rows.length === 0 || state !== 'failed') return;
    await recordNotification(tx, {
      runId: null, queueEntryId: id, kind: 'refused',
      title: `${String(rows[0].ticketKey)}: couldn\u2019t start`, body: rows[0].reason == null ? '' : String(rows[0].reason),
      actions: [{ label: 'Open Activity', url: '/runs' }],
    });
  });
}
