import type { ClaimResponse, FinishTaskInput, FleetWorkerWire, RuntimeStatus, WorkerRegister } from '@asf/shared';
import type { Sql, Db } from '../db/pool.js';
import { appendEventTx, rowToRun, rowToTask, setRunState } from './store.js';
import { advance } from './orchestrate.js';
import { ollamaModelIds } from '@asf/shared';
import { getOrgSettings } from '../settings/store.js';

/**
 * The fleet. A registration is a truthful statement of what this process
 * holds right now: every task assigned to this worker id that is NOT in
 * `inFlightTaskIds` belonged to a process that no longer exists, so its run
 * goes stale immediately rather than after the sweeper notices.
 */
export async function registerWorker(sql: Sql, w: WorkerRegister): Promise<{ staled: string[] }> {
  const staled: string[] = [];
  await sql.begin(async (tx) => {
    await tx`INSERT INTO worker (id, host, runtimes, max_concurrent, auth_mode, preflight, registered_at, last_heartbeat)
      VALUES (${w.id}, ${w.host}, ${tx.json(w.runtimes)}, ${w.maxConcurrent}, ${w.authMode ?? null}, ${tx.json((w.preflight ?? []) as never)}, now(), now())
      ON CONFLICT (id) DO UPDATE SET host = EXCLUDED.host, runtimes = EXCLUDED.runtimes,
        max_concurrent = EXCLUDED.max_concurrent, auth_mode = EXCLUDED.auth_mode, preflight = EXCLUDED.preflight,
        registered_at = now(), last_heartbeat = now()`;
    const orphans = await tx`SELECT id, run_id FROM run_task WHERE worker_id = ${w.id} AND state = 'running'
      AND NOT (id = ANY(${w.inFlightTaskIds}::text[]))`;
    for (const o of orphans) {
      await orphanTask(tx, String(o.id), String(o.runId), `worker ${w.id} restarted without this task`);
      staled.push(String(o.runId));
    }
  });
  return { staled };
}

/** A heartbeat carrying runtime status replaces the stored one; without it the status is kept. */
export async function heartbeat(sql: Sql, id: string, preflight?: RuntimeStatus[]): Promise<boolean> {
  const rows = preflight
    ? await sql`UPDATE worker SET last_heartbeat = now(), preflight = ${sql.json(preflight as never)} WHERE id = ${id} RETURNING id`
    : await sql`UPDATE worker SET last_heartbeat = now() WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function deregisterWorker(sql: Sql, id: string): Promise<{ staled: string[] }> {
  const staled: string[] = [];
  await sql.begin(async (tx) => {
    const held = await tx`SELECT id, run_id FROM run_task WHERE worker_id = ${id} AND state = 'running'`;
    for (const h of held) {
      await orphanTask(tx, String(h.id), String(h.runId), `worker ${id} deregistered`);
      staled.push(String(h.runId));
    }
    await tx`DELETE FROM worker WHERE id = ${id}`;
  });
  return { staled };
}

/** A task whose process is gone: task failed (resumable), run stale. */
export async function orphanTask(tx: Db, taskId: string, runId: string, reason: string): Promise<void> {
  await tx`UPDATE run_task SET state = 'failed', reason = ${reason}, finished_at = now() WHERE id = ${taskId}`;
  await setRunState(tx, runId, 'stale', reason);
  await appendEventTx(tx, { runId, taskId, kind: 'run:stale', source: 'orchestrator', payload: { reason } });
}

export async function listLiveWorkers(sql: Sql, ttlSeconds: number) {
  return sql`SELECT id, host, runtimes, max_concurrent, last_heartbeat FROM worker
    WHERE last_heartbeat > now() - make_interval(secs => ${ttlSeconds})`;
}

/**
 * The fleet panel (WP 7.4): every live worker with its runtimes, declared agent
 * auth mode, capacity, and how many tasks it is running right now — the "why is
 * my run queued?" answer. A worker is live if it heartbeat within the TTL.
 */
export async function listFleet(sql: Sql, ttlSeconds: number): Promise<{
  workers: FleetWorkerWire[];
  capacity: number; running: number;
}> {
  const rows = await sql`
    SELECT w.id, w.host, w.runtimes, w.auth_mode, w.max_concurrent, w.last_heartbeat, w.preflight,
           coalesce(r.running, 0) AS running
      FROM worker w
      LEFT JOIN (SELECT worker_id, count(*) AS running FROM run_task WHERE state = 'running' GROUP BY worker_id) r
        ON r.worker_id = w.id
     WHERE w.last_heartbeat > now() - make_interval(secs => ${ttlSeconds})
     ORDER BY w.id`;
  const workers = rows.map((w) => ({
    id: String(w.id), host: String(w.host),
    runtimes: (w.runtimes as string[]) ?? [],
    authMode: w.authMode == null ? null : String(w.authMode),
    maxConcurrent: Number(w.maxConcurrent),
    running: Number(w.running),
    lastHeartbeat: new Date(w.lastHeartbeat as string).toISOString(),
    preflight: (w.preflight as RuntimeStatus[] | null) ?? [],
  }));
  return {
    workers,
    capacity: workers.reduce((n, w) => n + w.maxConcurrent, 0),
    running: workers.reduce((n, w) => n + w.running, 0),
  };
}

/** Summed run cost for the current calendar month (UTC) — for ORG_MONTHLY_BUDGET_USD. */
export async function monthCostUsd(sql: Sql): Promise<number> {
  const [row] = await sql`SELECT coalesce(sum(cost_usd), 0) AS total FROM agent_run
    WHERE created_at >= date_trunc('month', now())`;
  return Number(row.total);
}

/**
 * Runs this calendar month (UTC) with at least one agent task that finished without a
 * cost figure: a plan-billed runtime (Copilot, a Claude subscription) or a model with
 * no rate. The worker reports such a task as $0, so ORG_MONTHLY_BUDGET_USD undercounts
 * by exactly these runs — Admin shows the number beside the spend (M8 WP H). Publish
 * tasks cost nothing by design; failed/skipped tasks may never have reached the agent.
 */
export async function monthUnpricedRuns(sql: Sql): Promise<number> {
  const [row] = await sql`SELECT count(DISTINCT r.id) AS n FROM agent_run r
    JOIN run_task t ON t.run_id = r.id
   WHERE r.created_at >= date_trunc('month', now())
     AND t.finished_at IS NOT NULL AND t.cost_usd = 0
     AND t.state NOT IN ('failed', 'skipped')
     AND coalesce(t.runtime, '') <> 'publish'`;
  return Number(row.n);
}

/**
 * Hands one task to one worker, or null. FOR UPDATE SKIP LOCKED is the whole
 * reason the registry is Postgres: two workers polling in the same
 * millisecond get two different tasks or one gets null — never the same row.
 * A task is claimable only when every earlier task in its run is done or
 * skipped, so the orchestrator's ordering is enforced by the claim query.
 */
export async function claimTask(sql: Sql, workerId: string, runtimes: string[], capabilities?: string[]): Promise<ClaimResponse> {
  // M11 WP4: with capabilities, a task on an Ollama model needs `<runtime>@ollama`; any
  // other task needs the runtime under some non-Ollama provider. Ollama-ness is by the
  // task's model: the catalogue's ollama-kind providers, plus the ollama:/ollama-cloud: prefix.
  const caps = capabilities ?? null;
  const ollamaIds = caps ? ollamaModelIds((await getOrgSettings(sql)).MODEL_CATALOG_EXTRA) : [];
  return sql.begin(async (tx) => {
    const cand = await tx`
      SELECT t.id AS task_id, t.run_id
        FROM run_task t
        JOIN agent_run r ON r.id = t.run_id
       WHERE t.state = 'pending'
         AND r.state IN ('queued', 'running')
         AND r.cancel_requested_at IS NULL
         AND (t.runtime IS NULL OR t.runtime = 'publish' OR t.runtime = ANY(${runtimes}::text[]))
         AND (${caps}::text[] IS NULL OR t.runtime IS NULL OR t.runtime = 'publish' OR (
               CASE WHEN t.model = ANY(${ollamaIds}::text[]) OR t.model LIKE 'ollama:%' OR t.model LIKE 'ollama-cloud:%'
                 THEN (t.runtime || '@ollama') = ANY(${caps}::text[])
                 ELSE EXISTS (SELECT 1 FROM unnest(${caps}::text[]) c WHERE c LIKE t.runtime || '@%' AND c <> t.runtime || '@ollama')
               END))
         AND NOT EXISTS (
           SELECT 1 FROM run_task p
            WHERE p.run_id = t.run_id AND p.seq < t.seq AND p.state NOT IN ('done', 'skipped'))
       ORDER BY r.created_at, t.seq
       FOR UPDATE OF t SKIP LOCKED
       LIMIT 1`;
    if (cand.length === 0) return null;
    const taskId = String(cand[0].taskId);
    const runId = String(cand[0].runId);
    const [taskRow] = await tx`UPDATE run_task SET state = 'running', worker_id = ${workerId}, started_at = now() WHERE id = ${taskId} RETURNING *`;
    const [runRow] = await tx`UPDATE agent_run SET state = 'running', started_at = coalesce(started_at, now()) WHERE id = ${runId} RETURNING *`;
    const task = rowToTask(taskRow);
    const run = rowToRun(runRow);
    await appendEventTx(tx, { runId, taskId, kind: 'task:started', source: 'orchestrator', payload: { role: task.role, attempt: task.attempt, workerId } });
    return { run, task, team: run.team };
  });
}

export async function finishTask(sql: Sql, taskId: string, input: FinishTaskInput): Promise<{ runId: string }> {
  const runId = await sql.begin(async (tx) => {
    const rows = await tx`SELECT * FROM run_task WHERE id = ${taskId} FOR UPDATE`;
    if (rows.length === 0) throw new Error(`task not found: ${taskId}`);
    const task = rowToTask(rows[0]);
    if (task.state !== 'running') throw new Error(`task ${taskId} is ${task.state}, not running`);
    await tx`UPDATE run_task SET state = ${input.outcome}, output_ref = coalesce(${input.outputRef}, output_ref),
      cost_usd = ${input.costUsd}, reason = ${input.reason}, finished_at = now() WHERE id = ${taskId}`;
    await tx`UPDATE agent_run SET cost_usd = (SELECT coalesce(sum(cost_usd), 0) FROM run_task WHERE run_id = ${task.runId}) WHERE id = ${task.runId}`;
    await appendEventTx(tx, { runId: task.runId, taskId, kind: 'task:finished', source: 'worker',
      payload: { role: task.role, outcome: input.outcome, costUsd: input.costUsd, reason: input.reason } });
    return task.runId;
  });
  await advance(sql, runId);
  return { runId };
}
