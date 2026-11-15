import type { ScmProvider, TicketProvider, Run } from '@asf/shared';
import { resolve } from '@asf/shared';
import { registry } from './registry/client.js';
import { cfg } from './settings.js';
import { transitionTicketTo, parsePreferredStatuses } from './tickets/transition.js';
import { ticketsFor } from './tickets/route.js';
import { closeSplitParentIfDone } from './tickets/split-parent.js';

type Log = { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

/**
 * The external-merge watcher. When the merge stage is off (mergeEnabled=false)
 * a run pushes the change request, marks it ready for review, and finishes
 * `succeeded` with deliveryOutcome='awaiting_external_merge' — the factory is
 * deliberately blocked from merging, so a human merges (or closes) the MR/PR in
 * the SCM. Nothing else notices that. This poller closes the loop: each tick it
 * asks the registry which runs are still awaiting an external merge, reads the
 * live change-request state from the SCM, and when it has moved:
 *
 *   merged → emit change_request:merged (the registry stamps the run row to
 *            'merged' and records a "merged externally" notification), then move
 *            the ticket to Done — the same tail as the internal /api/scm/merge.
 *   closed → emit change_request:closed (run row → 'closed', notification); the
 *            ticket is left where it is (a human rejected the work, on purpose).
 *
 * A run leaves the watch set once merged. A closed one is re-checked for a day
 * and corrected to merged if the SCM says so (see runsAwaitingExternalMerge). Best-effort per run: one unreachable
 * repo or transient SCM error is logged and retried next tick, never stalling
 * the batch. Lives in the api because it needs the SCM + ticket providers and
 * the org config, exactly like the work-queue scheduler.
 */
export async function tickMergeWatch(deps: { tickets: TicketProvider; scm: ScmProvider }, log: Log): Promise<number> {
  if (!cfg('MERGE_WATCH_ENABLED')) return 0;
  const { runs } = await registry.runsAwaitingExternalMerge();
  let resolved = 0;
  for (const run of runs) {
    try {
      if (await checkOne(deps, run, log)) resolved += 1;
    } catch (err) {
      // Transient (SCM blip / rate limit): leave the run in the watch set for the next tick.
      log.error({ runId: run.id, err: (err as Error).message }, 'merge-watch: check threw; will retry');
    }
  }
  return resolved;
}

/** Poll one run's change request; act if it has merged or closed. Returns true if it resolved. */
async function checkOne(deps: { tickets: TicketProvider; scm: ScmProvider }, run: Run, log: Log): Promise<boolean> {
  if (!run.repoId || run.changeRequestNumber == null) return false;
  const repo = await deps.scm.getRepo(run.repoId);
  const cr = await deps.scm.getChangeRequest(repo, run.changeRequestNumber);
  if (cr.state === 'open') return false; // still awaiting the human
  // Already recorded as closed and still closed: nothing new (it's only re-checked in
  // case it was wrongly closed or gets reopened and merged).
  if (cr.state === 'closed' && run.changeRequestState === 'closed') return false;

  if (cr.state === 'merged') {
    await registry.appendEvent({
      runId: run.id, taskId: null, kind: 'change_request:merged', source: 'orchestrator',
      payload: { url: cr.url, number: cr.number, external: true },
    });
    // Merged → the work landed; move the ticket to Done, same as the internal merge route.
    const moved = await transitionTicketTo(ticketsFor(deps.tickets, run.ticketId), run.ticketId, parsePreferredStatuses(cfg('TICKET_STATUS_DONE')));
    log.info({ runId: run.id, ticket: run.ticketKey, number: cr.number, ticketMovedTo: moved }, 'merge-watch: merged externally');
    await closeSplitParentIfDone(deps.tickets, run.id, log);
    return true;
  }

  // closed (without merging): mark the run closed and notify; leave the ticket where it is.
  await registry.appendEvent({
    runId: run.id, taskId: null, kind: 'change_request:closed', source: 'orchestrator',
    payload: { url: cr.url, number: cr.number, external: true },
  });
  log.info({ runId: run.id, ticket: run.ticketKey, number: cr.number }, 'merge-watch: closed without merging');
  return true;
}

export function startMergeWatch(deps: { tickets: TicketProvider; scm: ScmProvider }, log: Log): () => void {
  const period = resolve('MERGE_WATCH_POLL_MS');
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap ticks
    running = true;
    try { await tickMergeWatch(deps, log); }
    catch (err) { log.error({ err: (err as Error).message }, 'merge-watch tick failed'); }
    finally { running = false; }
  }, period);
  timer.unref();
  return () => clearInterval(timer);
}
