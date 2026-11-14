import type { ScmProvider, TicketProvider } from '@asf/shared';
import { resolve } from '@asf/shared';
import { registry } from './registry/client.js';
import { cfg } from './settings.js';
import { dispatchTicket } from './routes/dispatch.js';
import { startReadiness } from './start-readiness.js';

type Log = { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

/**
 * The work-queue scheduler. Runs in the api because dispatching needs the
 * ticket/SCM providers and dispatch policy, which only the api holds. Each tick
 * it asks the registry which queued entries may run now (parallel = always;
 * serial = only once the previous batch entry has settled) and dispatches each
 * through the SAME dispatchTicket() a hand-dispatch uses, then reports the
 * outcome back so the entry leaves the queue. Fleet capacity is not checked
 * here — a dispatched run sits queued until a worker slot frees, which is the
 * correct backpressure; the queue's only job is ordering and serial gating.
 */
export async function tickQueue(deps: { tickets: TicketProvider; scm: ScmProvider }, log: Log): Promise<number> {
  if (!cfg('QUEUE_ENABLED')) return 0;
  const { entries } = await registry.readyQueueEntries();
  if (entries.length === 0) return 0;
  // Source control down (token expired, repo removed): hold the queue rather than fail
  // every entry. They start once a repository is reachable again.
  const ready = await startReadiness(deps.scm);
  if (!ready.ok) { log.info({ code: ready.code, waiting: entries.length }, 'queue: waiting for a repository'); return 0; }
  let dispatched = 0;
  for (const e of entries) {
    try {
      const result = await dispatchTicket(deps, {
        ticketId: e.ticketId, repoId: e.repoId, teamName: e.teamName,
        maxCostUsd: e.maxCostUsd, by: e.addedBy,
      });
      if (result.ok) {
        await registry.markQueueEntry(e.id, 'dispatched', result.runId, null);
        dispatched += 1;
        log.info({ entry: e.id, ticket: e.ticketKey, runId: result.runId }, 'queue: dispatched');
      } else if (result.code === 'run_conflict') {
        // Already has a live run (someone dispatched it by hand): treat as dispatched, not failed.
        await registry.markQueueEntry(e.id, 'dispatched', result.existingRunId ?? null, result.reason);
        log.info({ entry: e.id, ticket: e.ticketKey, reason: result.reason }, 'queue: already running');
      } else {
        await registry.markQueueEntry(e.id, 'failed', null, result.reason, result.code);
        log.info({ entry: e.id, ticket: e.ticketKey, code: result.code, reason: result.reason }, 'queue: refused');
      }
    } catch (err) {
      // A transient error (registry blip) leaves the entry queued for the next tick.
      log.error({ entry: e.id, err: (err as Error).message }, 'queue: dispatch threw; will retry');
    }
  }
  return dispatched;
}

export function startScheduler(deps: { tickets: TicketProvider; scm: ScmProvider }, log: Log): () => void {
  const period = resolve('QUEUE_TICK_MS');
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap ticks
    running = true;
    try { await tickQueue(deps, log); }
    catch (err) { log.error({ err: (err as Error).message }, 'queue tick failed'); }
    finally { running = false; }
  }, period);
  timer.unref();
  return () => clearInterval(timer);
}
