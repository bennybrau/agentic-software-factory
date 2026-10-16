import type { Sql } from '../db/pool.js';
import { config } from '../config.js';
import { appendEventTx, setRunState } from './store.js';
import { orphanTask } from './workers.js';
import { abandonExpiredGates } from './gates.js';
import { enforceTimeLimit } from './time-limit.js';

/**
 * The fallback for a kill -9. Registration/deregistration are the primary
 * path; this notices what they could not report. It is a set of decisions,
 * not queries, which is why exactly one process (the registry) runs it.
 */
export interface SweepResult { staleRuns: string[]; deadWorkers: string[]; prunedEvents: number; abandonedGates: string[]; timeLimited?: string[] }

export async function sweep(sql: Sql, now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { staleRuns: [], deadWorkers: [], prunedEvents: 0, abandonedGates: [] };
  await sql.begin(async (tx) => {
    // Workers past TTL: their running tasks are orphaned, then they are forgotten.
    const dead = await tx`SELECT id FROM worker WHERE last_heartbeat < ${now}::timestamptz - make_interval(secs => ${config.workerTtlSeconds})`;
    for (const d of dead) {
      const id = String(d.id);
      const held = await tx`SELECT id, run_id FROM run_task WHERE worker_id = ${id} AND state = 'running'`;
      for (const h of held) { await orphanTask(tx, String(h.id), String(h.runId), `worker ${id} missed heartbeats`); result.staleRuns.push(String(h.runId)); }
      await tx`DELETE FROM worker WHERE id = ${id}`;
      result.deadWorkers.push(id);
    }
    // Running runs with no event for STALE_AFTER_MIN.
    const silent = await tx`SELECT r.id, r.last_event_at, (SELECT kind FROM run_events e WHERE e.run_id = r.id ORDER BY seq DESC LIMIT 1) AS last_kind
      FROM agent_run r WHERE r.state = 'running' AND r.last_event_at < ${now}::timestamptz - make_interval(mins => ${config.staleAfterMin})`;
    for (const s of silent) {
      const id = String(s.id);
      const reason = `no event for ${config.staleAfterMin} min (last: ${s.lastKind ?? 'none'})`;
      await tx`UPDATE run_task SET state = 'failed', reason = ${reason}, finished_at = now() WHERE run_id = ${id} AND state = 'running'`;
      await setRunState(tx, id, 'stale', reason);
      await appendEventTx(tx, { runId: id, taskId: null, kind: 'run:stale', source: 'orchestrator', payload: { reason, lastEventAt: s.lastEventAt } });
      result.staleRuns.push(id);
    }
    const pruned = await tx`DELETE FROM run_events WHERE at < ${now}::timestamptz - make_interval(days => ${config.eventRetentionDays}) RETURNING id`;
    result.prunedEvents = pruned.length;
  });
  result.abandonedGates = await abandonExpiredGates(sql, now);
  result.timeLimited = await enforceTimeLimit(sql, now);
  return result;
}

export function startSweeper(sql: Sql, log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }): () => void {
  const timer = setInterval(async () => {
    try {
      const r = await sweep(sql);
      if (r.staleRuns.length || r.deadWorkers.length || r.prunedEvents || r.abandonedGates.length || r.timeLimited?.length) log.info(r, 'sweep');
    } catch (err) { log.error(err, 'sweep failed'); }
  }, config.reconcileIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
