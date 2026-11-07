import type { Run, RunEvent, RunState, RunTask, TeamTemplate } from '@asf/shared';
import { runSchema, runTaskSchema, runEventSchema, isTerminal } from '@asf/shared';
import type { AppendEventInput, CreateRunInput, RunWithTasks } from '@asf/shared';
import type { Sql, Db } from '../db/pool.js';
import { newId } from './ids.js';
import { recordNotification } from './notification-store.js';

const runLink = (runId: string) => `/run/${runId}`;

/**
 * The only module that writes agent_run / run_task / run_events.
 * Rows come back through the Zod schemas so a column drift fails here, not
 * in a renderer.
 */
export class RunConflictError extends Error {
  constructor(public readonly existingRunId: string, public readonly ticketKey: string) {
    super(`a live run already exists for ${ticketKey}: ${existingRunId}`);
  }
}
export class NotFoundError extends Error {
  constructor(what: string, id: string) { super(`${what} not found: ${id}`); }
}

// --- row mapping -----------------------------------------------------------

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export function rowToRun(r: Row): Run {
  return runSchema.parse({
    id: r.id, ticketId: r.ticketId, ticketKey: r.ticketKey, ticketProvider: r.ticketProvider,
    state: r.state, teamName: r.teamName, team: r.team, gates: r.gates,
    repoId: r.repoId ?? null, worktreePath: r.worktreePath ?? null, branchName: r.branchName ?? null,
    changeRequestUrl: r.changeRequestUrl ?? null,
    changeRequestNumber: r.changeRequestNumber == null ? null : Number(r.changeRequestNumber),
    changeRequestState: r.changeRequestState ?? null,
    deliveryOutcome: r.deliveryOutcome ?? null,
    costUsd: num(r.costUsd), maxCostUsd: num(r.maxCostUsd), reviewIterations: Number(r.reviewIterations ?? 0),
    dispatchedBy: r.dispatchedBy ?? null, reason: r.reason ?? null,
    createdAt: iso(r.createdAt), startedAt: iso(r.startedAt), lastEventAt: iso(r.lastEventAt),
    cancelRequestedAt: iso(r.cancelRequestedAt), finishedAt: iso(r.finishedAt),
  });
}
export function rowToTask(r: Row): RunTask {
  return runTaskSchema.parse({
    id: r.id, runId: r.runId, role: r.role, seq: Number(r.seq), state: r.state, attempt: Number(r.attempt ?? 1),
    inputRef: r.inputRef ?? null, outputRef: r.outputRef ?? null, workerId: r.workerId ?? null,
    runtime: r.runtime ?? null, model: r.model ?? null, effort: r.effort ?? null, costUsd: num(r.costUsd), gateChecked: Boolean(r.gateChecked),
    startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt), reason: r.reason ?? null,
    queuedBy: r.queuedBy ?? 'plan', queuedReason: r.queuedReason ?? null,
  });
}
export function rowToEvent(r: Row): RunEvent {
  return runEventSchema.parse({
    id: Number(r.id), runId: r.runId, taskId: r.taskId ?? null, seq: Number(r.seq), kind: r.kind, source: r.source,
    payload: r.payload ?? {}, at: iso(r.at),
  });
}

// --- reads -----------------------------------------------------------------

export async function getRun(sql: Sql, id: string): Promise<RunWithTasks | null> {
  const rows = await sql`SELECT * FROM agent_run WHERE id = ${id}`;
  if (rows.length === 0) return null;
  return { run: rowToRun(rows[0]), tasks: await getTasks(sql, id) };
}

export async function getTasks(sql: Sql, runId: string): Promise<RunTask[]> {
  const rows = await sql`SELECT * FROM run_task WHERE run_id = ${runId} ORDER BY seq, attempt`;
  return rows.map(rowToTask);
}

export async function listRuns(sql: Sql, q: {
  ticketId?: string; state?: RunState; teamName?: string;
  deliveryOutcome?: 'merged' | 'awaiting_external_merge' | 'no_repo' | 'split';
  search?: string; since?: string; limit: number; offset?: number;
}): Promise<{ runs: Run[]; total: number }> {
  const offset = q.offset ?? 0;
  const search = q.search?.trim() ? `%${q.search.trim()}%` : null;
  // One shared WHERE for both the page and its total, so "X of N" stays consistent.
  const where = sql`
    (${q.ticketId ?? null}::text IS NULL OR ticket_id = ${q.ticketId ?? null})
    AND (${q.state ?? null}::text IS NULL OR state = ${q.state ?? null})
    AND (${q.teamName ?? null}::text IS NULL OR team_name = ${q.teamName ?? null})
    AND (${q.deliveryOutcome ?? null}::text IS NULL OR delivery_outcome = ${q.deliveryOutcome ?? null})
    AND (${search}::text IS NULL OR ticket_key ILIKE ${search})
    AND (${q.since ?? null}::timestamptz IS NULL OR created_at >= ${q.since ?? null})`;
  const rows = await sql`SELECT * FROM agent_run WHERE ${where}
    ORDER BY created_at DESC LIMIT ${q.limit} OFFSET ${offset}`;
  const [{ total }] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM agent_run WHERE ${where}`;
  return { runs: rows.map(rowToRun), total: Number(total) };
}

/**
 * Runs that finished awaiting an external merge and still have a live change
 * request the operator hasn't landed. The merge-watcher (in the api) polls the
 * SCM for each and, once the human merges or closes it, stamps the run via a
 * change_request:merged/closed event. A run drops out once its PR is merged.
 *
 * A run marked closed stays in the set for a day after it was marked: SCMs can
 * report a just-merged PR as closed for a moment, and a PR can be reopened and
 * merged. The watcher re-reads it and corrects it to merged if that's the truth
 * (a split part waiting on it would otherwise never start).
 */
export async function runsAwaitingExternalMerge(sql: Sql, limit: number): Promise<Run[]> {
  const rows = await sql`SELECT * FROM agent_run
    WHERE delivery_outcome = 'awaiting_external_merge'
      AND (change_request_state IN ('open', 'ready')
           OR (change_request_state = 'closed' AND last_event_at > now() - interval '1 day'))
      AND repo_id IS NOT NULL
      AND change_request_number IS NOT NULL
    ORDER BY finished_at ASC NULLS LAST LIMIT ${limit}`;
  return rows.map(rowToRun);
}

/**
 * Merged runs for the Hive hook (#78): a run with a repo whose change request
 * is merged, stamped with when it merged — the first change_request:merged
 * event, or finished_at for a run merged before that event existed. Oldest
 * merge first; `since` filters on that merge time.
 */
export async function hiveMergedRuns(sql: Sql, q: { since?: string; limit: number; offset?: number }): Promise<(Run & { mergedAt: string })[]> {
  const rows = await sql`SELECT * FROM (
      SELECT r.*, COALESCE(
        (SELECT min(e.at) FROM run_events e WHERE e.run_id = r.id AND e.kind = 'change_request:merged'),
        r.finished_at) AS merged_at
      FROM agent_run r
      WHERE r.change_request_state = 'merged' AND r.repo_id IS NOT NULL) m
    WHERE merged_at IS NOT NULL
      AND (${q.since ?? null}::timestamptz IS NULL OR merged_at >= ${q.since ?? null}::timestamptz)
    ORDER BY merged_at, id LIMIT ${q.limit} OFFSET ${q.offset ?? 0}`;
  return rows.map((r) => ({ ...rowToRun(r), mergedAt: iso(r.mergedAt)! }));
}

export async function getEvents(sql: Sql, runId: string, afterSeq: number, limit: number): Promise<RunEvent[]> {
  const rows = await sql`SELECT * FROM run_events WHERE run_id = ${runId} AND seq > ${afterSeq} ORDER BY seq LIMIT ${limit}`;
  return rows.map(rowToEvent);
}

export async function getEventBySeq(sql: Sql, runId: string, seq: number): Promise<RunEvent | null> {
  const rows = await sql`SELECT * FROM run_events WHERE run_id = ${runId} AND seq = ${seq}`;
  return rows.length ? rowToEvent(rows[0]) : null;
}

export interface TaskProgress {
  taskId: string;
  toolCalls: number;             // tool:pre events since this task's latest segment:started
  lastTool: string | null;       // summary of the most recent tool call
  lastToolAt: string | null;     // when it happened (ISO)
  startedAt: string | null;      // the latest segment:started for this task
  maxTurns: number | null;       // ceiling from segment:started (M11 WP2/#87)
  timeoutMs: number | null;
}

/**
 * Live progress for running tasks (M11 WP5): how many tool calls since the task
 * started, the last tool summary, and the ceiling — so the UI can answer "why is
 * this taking so long" WHILE it runs, not only after. Cheap: one grouped query
 * over run_events for the given task ids. tool:pre count is a proxy for turns
 * (Claude Code only reports num_turns at the end).
 */
export async function taskProgress(sql: Sql, taskIds: string[]): Promise<Record<string, TaskProgress>> {
  if (taskIds.length === 0) return {};
  // The latest segment:started per task marks the current attempt's clock.
  const starts = await sql`
    SELECT DISTINCT ON (task_id) task_id, at, payload
      FROM run_events WHERE task_id = ANY(${taskIds}::text[]) AND kind = 'segment:started'
     ORDER BY task_id, seq DESC`;
  const startByTask = new Map(starts.map((r) => [String(r.taskId), r]));
  const out: Record<string, TaskProgress> = {};
  for (const taskId of taskIds) {
    const start = startByTask.get(taskId);
    const startedAt = start ? iso(start.at) : null;
    const payload = (start?.payload ?? {}) as Record<string, unknown>;
    // tool:pre events for this task since it started (by seq of the start event).
    const startSeq = start ? Number((await sql`SELECT seq FROM run_events WHERE task_id = ${taskId} AND kind = 'segment:started' ORDER BY seq DESC LIMIT 1`)[0]?.seq ?? 0) : 0;
    const tools = await sql`SELECT count(*)::int AS n, max(seq) AS last_seq FROM run_events
      WHERE task_id = ${taskId} AND kind = 'tool:pre' AND seq > ${startSeq}`;
    const n = Number(tools[0]?.n ?? 0);
    let lastTool: string | null = null; let lastToolAt: string | null = null;
    if (tools[0]?.lastSeq) {
      const last = await sql`SELECT payload, at FROM run_events WHERE task_id = ${taskId} AND seq = ${Number(tools[0].lastSeq)}`;
      if (last.length) { lastTool = String((last[0].payload as Record<string, unknown>)?.summary ?? (last[0].payload as Record<string, unknown>)?.tool ?? ''); lastToolAt = iso(last[0].at); }
    }
    out[taskId] = {
      taskId, toolCalls: n, lastTool, lastToolAt, startedAt,
      maxTurns: typeof payload.maxTurns === 'number' ? payload.maxTurns : null,
      timeoutMs: typeof payload.timeoutMs === 'number' ? payload.timeoutMs : null,
    };
  }
  return out;
}

// --- writes ----------------------------------------------------------------

export async function createRun(sql: Sql, input: CreateRunInput): Promise<RunWithTasks> {
  const id = newId('run');
  const team: TeamTemplate = input.team;
  try {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO agent_run (id, ticket_id, ticket_key, ticket_provider, state, team_name, team, gates, repo_id, max_cost_usd, dispatched_by)
        VALUES (${id}, ${input.ticketId}, ${input.ticketKey}, ${input.ticketProvider}, 'queued', ${team.name},
                ${tx.json(team as never)}, ${tx.json(input.gates as never)}, ${input.repoId}, ${input.maxCostUsd}, ${input.dispatchedBy})`;
      for (const [seq, role] of team.roles.entries()) {
        await tx`INSERT INTO run_task (id, run_id, role, seq, state, input_ref, output_ref, runtime, model, effort)
          VALUES (${newId('task')}, ${id}, ${role.role}, ${seq}, 'pending', ${role.input}, ${role.output}, ${role.runtime}, ${role.model}, ${role.effort})`;
      }
      await appendEventTx(tx, { runId: id, taskId: null, kind: 'run:queued', source: 'orchestrator', payload: { team: team.name, gates: input.gates, dispatchedBy: input.dispatchedBy } });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const live = await sql`SELECT id FROM agent_run WHERE ticket_provider = ${input.ticketProvider} AND ticket_id = ${input.ticketId}
        AND state NOT IN ('succeeded','failed','cancelled','halted') LIMIT 1`;
      throw new RunConflictError(String(live[0]?.id ?? 'unknown'), input.ticketKey);
    }
    throw err;
  }
  return (await getRun(sql, id))!;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * Appends with a per-run monotonic seq. The run row is locked for the
 * duration so two concurrent appends cannot pick the same seq; the NOTIFY
 * fires on commit.
 */
export async function appendEvent(sql: Sql, input: AppendEventInput): Promise<RunEvent> {
  return sql.begin((tx) => appendEventTx(tx, input));
}

export async function appendEventTx(tx: Db, input: AppendEventInput): Promise<RunEvent> {
  const locked = await tx`SELECT id FROM agent_run WHERE id = ${input.runId} FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundError('run', input.runId);
  const [{ next }] = await tx<{ next: number }[]>`SELECT coalesce(max(seq), 0) + 1 AS next FROM run_events WHERE run_id = ${input.runId}`;
  const rows = await tx`INSERT INTO run_events (run_id, task_id, seq, kind, source, payload)
    VALUES (${input.runId}, ${input.taskId}, ${Number(next)}, ${input.kind}, ${input.source}, ${tx.json(input.payload as never)}) RETURNING *`;
  await tx`UPDATE agent_run SET last_event_at = now() WHERE id = ${input.runId}`;
  // Stamp the change-request (MR/PR) onto the run row so it is the single source
  // of truth for the created MR/PR — previously the url/number lived only in the
  // change_request:opened event. Idempotent (last write wins); safe across a
  // worker resume that re-emits the event.
  await stampChangeRequest(tx, input);
  // Not tx.notify(): that helper runs on the pool, outside this transaction,
  // and under load it waits for a connection the transactions are holding.
  await tx`SELECT pg_notify('run_events', ${`${input.runId}:${next}`})`;
  return rowToEvent(rows[0]);
}

/**
 * Mirror a change_request:* event onto the run row so the run is the single
 * source of truth for the created MR/PR. Idempotent: opened/ready set the url +
 * number + state, ready/merged advance state; a re-emitted event (worker resume)
 * is last-write-wins. Only these three kinds touch the columns.
 */
async function stampChangeRequest(tx: Db, input: AppendEventInput): Promise<void> {
  const p = (input.payload ?? {}) as { url?: unknown; number?: unknown };
  const url = typeof p.url === 'string' ? p.url : null;
  const number = p.number == null ? null : Number(p.number);
  if (input.kind === 'change_request:opened') {
    await tx`UPDATE agent_run SET
      change_request_url = coalesce(${url}, change_request_url),
      change_request_number = coalesce(${number}, change_request_number),
      change_request_state = 'open' WHERE id = ${input.runId}`;
  } else if (input.kind === 'change_request:ready') {
    await tx`UPDATE agent_run SET change_request_state = 'ready' WHERE id = ${input.runId}`;
  } else if (input.kind === 'change_request:merged') {
    await tx`UPDATE agent_run SET change_request_state = 'merged' WHERE id = ${input.runId}`;
    await notifyExternalDelivery(tx, input.runId, 'merged');
  } else if (input.kind === 'change_request:closed') {
    await tx`UPDATE agent_run SET change_request_state = 'closed' WHERE id = ${input.runId}`;
    await notifyExternalDelivery(tx, input.runId, 'closed');
  }
}

/**
 * When a run that finished awaiting an EXTERNAL merge has its change request
 * merged or closed by a human (detected by the api's merge-watcher, which emits
 * the change_request:merged/closed event), tell the operator. Gated on
 * delivery_outcome='awaiting_external_merge' so this never fires for the
 * internal-merge path — that run finishes with delivery_outcome='merged' and
 * the orchestrator already recorded its "run finished" notification. The gate
 * also makes a re-emitted event idempotent-enough: a merged run's outcome is
 * unchanged, but its state is no longer open/ready so the watcher won't re-emit.
 */
async function notifyExternalDelivery(tx: Db, runId: string, resolution: 'merged' | 'closed'): Promise<void> {
  const [r] = await tx<{ ticketKey: string; deliveryOutcome: string | null; url: string | null; number: number | null }[]>`
    SELECT ticket_key AS "ticketKey", delivery_outcome AS "deliveryOutcome",
           change_request_url AS url, change_request_number AS number
      FROM agent_run WHERE id = ${runId}`;
  if (!r || r.deliveryOutcome !== 'awaiting_external_merge') return;
  const actions = [{ label: 'Open run', url: runLink(runId) }];
  if (r.url) actions.push({ label: 'Open merge request', url: String(r.url) });
  const crRef = r.number == null ? 'The merge request' : `Merge request #${r.number}`;
  const body = resolution === 'merged'
    ? `${crRef} was merged externally — the change has landed. The ticket has been moved to Done.`
    : `${crRef} was closed without merging. The run is marked closed; the ticket was left where it is.`;
  await recordNotification(tx, {
    runId, kind: 'finished',
    title: `${r.ticketKey}: ${resolution === 'merged' ? 'merged externally' : 'closed without merging'}`,
    body, actions,
  });
}

export async function setRunState(tx: Db, runId: string, state: RunState, reason: string | null = null): Promise<void> {
  const finished = isTerminal(state);
  await tx`UPDATE agent_run SET state = ${state}, reason = coalesce(${reason}, reason),
    finished_at = CASE WHEN ${finished} THEN now() ELSE finished_at END WHERE id = ${runId}`;
}

export async function requestCancel(sql: Sql, id: string, by: string | null): Promise<RunWithTasks> {
  const cur = await getRun(sql, id);
  if (!cur) throw new NotFoundError('run', id);
  if (isTerminal(cur.run.state)) return cur;
  await sql.begin(async (tx) => {
    await tx`UPDATE agent_run SET cancel_requested_at = coalesce(cancel_requested_at, now()) WHERE id = ${id}`;
    // Nothing is running: settle now. Otherwise the running task's worker sees the flag and finishes.
    const running = cur.tasks.some((t) => t.state === 'running');
    if (!running) {
      await tx`UPDATE run_task SET state = 'skipped', reason = 'cancelled' WHERE run_id = ${id} AND state IN ('pending','awaiting_gate','needs_human')`;
      await setRunState(tx, id, 'cancelled', 'cancelled by operator');
    }
    await appendEventTx(tx, { runId: id, taskId: null, kind: 'run:cancelled', source: 'human', payload: { by, immediate: !running } });
  });
  return (await getRun(sql, id))!;
}

/** A stale run's running task goes back to pending (attempt+1); the run becomes queued. */
export async function resumeRun(sql: Sql, id: string, by: string | null): Promise<RunWithTasks> {
  const cur = await getRun(sql, id);
  if (!cur) throw new NotFoundError('run', id);
  if (cur.run.state !== 'stale') throw new Error(`run ${id} is ${cur.run.state}, only stale runs resume`);
  await sql.begin(async (tx) => {
    await tx`UPDATE run_task SET state = 'pending', worker_id = NULL, started_at = NULL, attempt = attempt + 1, reason = NULL
      WHERE run_id = ${id} AND state IN ('running','failed') AND seq = (SELECT min(seq) FROM run_task WHERE run_id = ${id} AND state IN ('running','failed'))`;
    await tx`UPDATE agent_run SET state = 'queued', reason = NULL WHERE id = ${id}`;
    await appendEventTx(tx, { runId: id, taskId: null, kind: 'run:resumed', source: 'human', payload: { by } });
  });
  return (await getRun(sql, id))!;
}
