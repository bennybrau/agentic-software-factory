import { resolve } from '@asf/shared';
import type { Db, Sql } from '../db/pool.js';
import { getOrgSettings } from '../settings/store.js';
import { appendEventTx, setRunState } from './store.js';
import { recordNotification } from './notification-store.js';

/**
 * RUN_MAX_MINUTES (M11 WP6; docs/M11_OLLAMA.md §Cost and limits): a run whose agents
 * have worked longer than this in total is cancelled, with the reason saying so. It
 * sits beside the cost cap: a $0 Ollama run never reaches a dollar limit, but a slow
 * local model can grind for hours.
 *
 * "Worked" = the sum of its role tasks' running time (started_at to finished_at, or to
 * now while running). Time at a gate or a needs-human question is a person's, and
 * doesn't count, so a plan left unapproved overnight is not cancelled for it.
 *
 * Checked by the sweeper (every RECONCILE_INTERVAL_MS), since a task that runs long
 * never reaches advance(). A running task is stopped through the normal cancel flag
 * (the worker polls it); with nothing running the run settles here and now.
 */
export const TIME_LIMIT_PREFIX = 'time limit reached';

/** Reason stored on timed‑out tasks and events. */
export const TIME_LIMIT_TASK_REASON = 'cancelled: run time limit';

export async function workedMinutes(tx: Db | Sql, runId: string, now: Date): Promise<number> {
  const [row] = await tx`SELECT coalesce(sum(extract(epoch FROM (coalesce(finished_at, ${now}::timestamptz) - started_at))), 0) AS s
    FROM run_task WHERE run_id = ${runId} AND started_at IS NOT NULL AND coalesce(runtime, '') <> 'publish'`;
  return Number(row!.s) / 60;
}

export async function enforceTimeLimit(sql: Sql, now: Date = new Date()): Promise<string[]> {
  const max = Number(resolve('RUN_MAX_MINUTES', process.env, await getOrgSettings(sql)));
  if (!(max > 0)) return [];
  const tripped: string[] = [];
  await sql.begin(async (tx) => {
    const runs = await tx`SELECT r.id, r.ticket_key,
        coalesce((SELECT sum(extract(epoch FROM (coalesce(t.finished_at, ${now}::timestamptz) - t.started_at)))
           FROM run_task t WHERE t.run_id = r.id AND t.started_at IS NOT NULL AND coalesce(t.runtime, '') <> 'publish'), 0) / 60 AS worked,
        EXISTS (SELECT 1 FROM run_task t WHERE t.run_id = r.id AND t.state = 'running') AS running
      FROM agent_run r
     WHERE r.state NOT IN ('succeeded', 'failed', 'cancelled', 'halted') AND r.cancel_requested_at IS NULL
     FOR UPDATE OF r SKIP LOCKED`;
    for (const r of runs) {
      const worked = Number(r.worked);
      if (worked < max) continue;
      const id = String(r.id);
      const reason = `${TIME_LIMIT_PREFIX}: its agents worked ${Math.round(worked)} min, over the ${max} min limit (RUN_MAX_MINUTES)`;
      await tx`UPDATE agent_run SET cancel_requested_at = now(), reason = ${reason} WHERE id = ${id}`;
      await appendEventTx(tx, { runId: id, taskId: null, kind: 'run:time_limit', source: 'orchestrator', payload: { workedMinutes: Math.round(worked), maxMinutes: max } });
      if (!r.running) await settleTimeLimited(tx, id, reason);
      await recordNotification(tx, { runId: id, kind: 'failed', title: `${String(r.ticketKey)}: run stopped at its time limit`,
        body: `Its agents worked ${Math.round(worked)} minutes, over the ${max}-minute limit. A slow model (often a local Ollama one) is the usual cause: pick a faster one for that job, or raise the limit in Settings.`,
        actions: [{ label: 'Open run', url: `/run/${id}` }] });
      tripped.push(id);
    }
  });
  return tripped;
}

/** Settle a time-limited run: what advance()'s cancellation does, keeping the reason. */
export async function settleTimeLimited(tx: Db, runId: string, reason: string): Promise<void> {
  await tx`UPDATE run_task SET state = 'skipped', reason = ${TIME_LIMIT_TASK_REASON} WHERE run_id = ${runId} AND state IN ('pending','awaiting_gate','needs_human')`;
  await tx`UPDATE run_gate SET state = 'abandoned' WHERE run_id = ${runId} AND state = 'open'`;
  await setRunState(tx, runId, 'cancelled', reason);
  await appendEventTx(tx, { runId, taskId: null, kind: 'run:cancelled', source: 'orchestrator', payload: { immediate: true, reason } });
}
