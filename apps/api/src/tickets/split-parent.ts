import type { TicketProvider } from '@asf/shared';
import { registry } from '../registry/client.js';
import { cfg } from '../settings.js';
import { transitionTicketTo, parsePreferredStatuses } from './transition.js';
import { runTicketRef, ticketsFor } from './route.js';

type Log = { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

/**
 * A split parent run finishes as `split` and never merges anything itself, so its
 * ticket would stay open forever. Called after a part's PR merges (the internal
 * /api/scm/merge and the external merge watcher): once every part of the split is
 * merged, move the parent's ticket to Done and comment the parts on it.
 *
 * `runId` counts as merged even if the registry hasn't stamped it yet: on the
 * internal path the merge route runs before the worker emits change_request:merged.
 * The comment is posted only when the ticket actually moved, so a repeat doesn't
 * post twice. Best-effort: every error is logged, never thrown, so the part's own
 * merge is unaffected.
 */
export async function closeSplitParentIfDone(tracker: TicketProvider, runId: string, log: Log): Promise<void> {
  try {
    const family = await registry.getSplitFamily(runId);
    if (!family?.parts?.length || family.currentPart == null) return; // not a part of a split
    if (!family.parts.every((p) => p.merged || p.run?.id === runId)) return;
    const parent = await registry.getRun(family.parent.runId);
    if (!parent?.run.ticketId) return;
    const ticketId = runTicketRef(parent.run);
    const tickets = ticketsFor(tracker, ticketId);
    const moved = await transitionTicketTo(tickets, ticketId, parsePreferredStatuses(cfg('TICKET_STATUS_DONE')));
    if (moved) {
      const list = family.parts.map((p) => p.run?.changeRequestUrl ? `${p.key} (${p.run.changeRequestUrl})` : p.key).join(', ');
      await tickets.comment(ticketId, `All ${family.parts.length} parts merged: ${list}`);
    }
    log.info({ runId, parentRunId: family.parent.runId, ticket: family.parent.ticketKey, ticketMovedTo: moved }, 'split parent: every part merged');
  } catch (err) {
    log.error({ runId, err: (err as Error).message }, 'split parent: could not close the parent ticket');
  }
}
