import { describeSchedule } from '@asf/shared';
import type { Run, RunningRunWire, TodayWire, WorkQueueEntry } from '@asf/shared';
import type { Sql } from '../db/pool.js';
import { rowToRun } from './store.js';
import { upcomingRecurring } from './recurring-store.js';

/**
 * The Today view's data, assembled in the registry in one place so the api makes
 * one call and the browser makes none of the per-run gate/task lookups the view
 * would otherwise need.
 *
 * Four buckets, matching the landing page:
 *  - waitingOnYou: runs with an OPEN gate or a task parked at needs_human, the
 *    things that will not move until a human acts. Newest activity first.
 *  - running: runs actively executing a task, with who is on it (activeRole,
 *    activeSince) and each role's latest task state (roleStates), for the
 *    mini-Hive strip (M12 WP5).
 *  - queued: work_queue entries not yet dispatched (position order) — the "these
 *    will start on their own" list.
 *  - refused: entries the scheduler refused to start in the last 7 days, newest
 *    first, unless the ticket has started since (a later run or a newer entry).
 *  - doneToday: runs that finished (any terminal state) since local midnight.
 *
 * Plus comingUp: unpaused recurring tasks due in the next 24h, soonest first.
 */
export interface WaitingRun { run: Run; reason: 'gate' | 'needs_human'; gateId: string | null; gateName: string | null; artifact: string | null; }
export interface TodayView {
  waitingOnYou: WaitingRun[];
  running: RunningRunWire[];
  queued: WorkQueueEntry[];
  refused: WorkQueueEntry[];
  doneToday: Run[];
  comingUp: TodayWire['comingUp'];
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const numOrNull = (v: unknown) => (v == null ? null : Number(v));

function rowToEntry(r: Record<string, unknown>): WorkQueueEntry {
  return {
    id: String(r.id), ticketId: String(r.ticketId), ticketProvider: String(r.ticketProvider), ticketKey: String(r.ticketKey),
    repoId: r.repoId ? String(r.repoId) : null, teamName: r.teamName ? String(r.teamName) : null, maxCostUsd: numOrNull(r.maxCostUsd),
    mode: r.mode as WorkQueueEntry['mode'], position: Number(r.position), batchId: String(r.batchId),
    state: r.state as WorkQueueEntry['state'], runId: r.runId ? String(r.runId) : null, reason: r.reason ? String(r.reason) : null,
    addedBy: r.addedBy ? String(r.addedBy) : null, addedAt: iso(r.addedAt)!, dispatchedAt: iso(r.dispatchedAt),
    dependsOn: Array.isArray(r.dependsOn) ? (r.dependsOn as unknown[]).map(String) : [],
    refusedAt: iso(r.refusedAt), reasonCode: r.reasonCode ? String(r.reasonCode) : null,
  };
}

/** `since` is the local-midnight cutoff for doneToday, computed by the api in the operator's zone. */
export async function today(sql: Sql, since: Date, now: Date = new Date()): Promise<TodayView> {
  // Waiting on you: one row per run, with WHY it waits. A run in awaiting_checkpoint
  // has an open gate; a run whose latest task is needs_human is parked on a question.
  const waitingRows = await sql`
    SELECT r.*,
           g.id AS gate_id, g.gate_name AS gate_name, g.artifact AS gate_artifact,
           CASE WHEN g.id IS NOT NULL THEN 'gate' ELSE 'needs_human' END AS wait_reason
      FROM agent_run r
      LEFT JOIN LATERAL (
        SELECT id, gate_name, artifact FROM run_gate
         WHERE run_id = r.id AND state = 'open' ORDER BY created_at DESC LIMIT 1) g ON true
     WHERE r.state NOT IN ('succeeded','failed','cancelled','halted')
       AND (g.id IS NOT NULL
            OR EXISTS (SELECT 1 FROM run_task t WHERE t.run_id = r.id AND t.state = 'needs_human'))
     ORDER BY r.last_event_at DESC NULLS LAST, r.created_at DESC`;
  const waitingOnYou: WaitingRun[] = waitingRows.map((r) => ({
    run: rowToRun(r),
    reason: (r.waitReason === 'gate' ? 'gate' : 'needs_human'),
    gateId: r.gateId ? String(r.gateId) : null,
    gateName: r.gateName ? String(r.gateName) : null,
    artifact: r.gateArtifact ? String(r.gateArtifact) : null,
  }));

  // Running: actively executing, and NOT already counted as waiting.
  const waitingIds = new Set(waitingOnYou.map((w) => w.run.id));
  const runningRows = await sql`SELECT * FROM agent_run WHERE state = 'running' ORDER BY started_at DESC NULLS LAST`;
  const runningRuns = runningRows.map(rowToRun).filter((r) => !waitingIds.has(r.id));
  const crew = await crewStates(sql, runningRuns.map((r) => r.id));
  const running: RunningRunWire[] = runningRuns.map((r) => ({ ...r, ...(crew.get(r.id) ?? { activeRole: null, activeSince: null, roleStates: {} }) }));

  const queuedRows = await sql`SELECT * FROM work_queue WHERE state = 'queued' ORDER BY position, added_at`;
  const queued = queuedRows.map(rowToEntry);

  // Refused: dismissed entries are cancelled, and a refusal from before #138 has no refused_at.
  const refusedRows = await sql`SELECT * FROM work_queue q
    WHERE q.state = 'failed' AND q.refused_at > ${now}::timestamptz - interval '7 days'
      AND NOT EXISTS (SELECT 1 FROM agent_run r
        WHERE r.ticket_provider = q.ticket_provider AND r.ticket_id = q.ticket_id AND r.created_at > q.refused_at)
      AND NOT EXISTS (SELECT 1 FROM work_queue e
        WHERE e.ticket_provider = q.ticket_provider AND e.ticket_id = q.ticket_id
          AND e.id > q.id AND e.state IN ('queued', 'dispatched'))
    ORDER BY q.refused_at DESC`;
  const refused = refusedRows.map(rowToEntry);

  const doneRows = await sql`SELECT * FROM agent_run
    WHERE state IN ('succeeded','failed','cancelled','halted') AND finished_at >= ${since}
    ORDER BY finished_at DESC`;
  const doneToday = doneRows.map(rowToRun);

  const comingUp = (await upcomingRecurring(sql, 24, now)).map((t) => ({
    id: t.id, title: t.title, nextRunAt: t.nextRunAt!, scheduleText: describeSchedule(t.schedule),
  }));

  return { waitingOnYou, running, queued, refused, doneToday, comingUp };
}

/**
 * For each run: every role's latest task state (by seq, so a loop-back's newer
 * try wins), plus the running task's role and start. One query for all rows.
 */
async function crewStates(sql: Sql, runIds: string[]): Promise<Map<string, Pick<RunningRunWire, 'activeRole' | 'activeSince' | 'roleStates'>>> {
  const out = new Map<string, Pick<RunningRunWire, 'activeRole' | 'activeSince' | 'roleStates'>>();
  if (runIds.length === 0) return out;
  const rows = await sql`
    SELECT DISTINCT ON (run_id, role) run_id, role, state, started_at
      FROM run_task WHERE run_id = ANY(${runIds})
     ORDER BY run_id, role, seq DESC`;
  for (const r of rows) {
    const id = String(r.runId);
    const entry = out.get(id) ?? { activeRole: null, activeSince: null, roleStates: {} };
    const role = String(r.role);
    entry.roleStates[role] = String(r.state);
    // A role task outranks a publish step if both somehow run; a publish step still counts as active.
    if (r.state === 'running' && (!entry.activeRole || entry.activeRole.startsWith('publish:'))) {
      entry.activeRole = role;
      entry.activeSince = iso(r.startedAt);
    }
    out.set(id, entry);
  }
  return out;
}
