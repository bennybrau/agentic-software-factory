import { formatRef, isKnownConnection, parseRef } from '@asf/shared';
import type { TicketProvider } from '@asf/shared';
import { adhocTickets } from '../providers/tickets/index.js';
import { qualifyTickets } from '../providers/tickets/set.js';
import type { TicketSetLive } from '../providers/tickets/set.js';

/** The ad-hoc store with qualified ids at the seam, like the tracker (its ids already carry `adhoc:`). */
const adhoc = qualifyTickets(adhocTickets);

/**
 * Which provider owns a ticket id: the ad-hoc store for an `adhoc:` id (#179),
 * else the tracker the id names when `tracker` is the set of trackers (M12 WP3;
 * a bare id is the default tracker's), else `tracker` itself. Every place that
 * acts on a run's or a dispatch's ticket goes through this, so an ad-hoc task
 * never reaches a tracker and a Jira ticket never reaches GitHub Issues.
 */
export function ticketsFor(tracker: TicketProvider, id: string): TicketProvider {
  if (parseRef(id, tracker.kind).connection === 'adhoc') return adhoc;
  if (!('ticketsFor' in tracker)) return tracker;
  // A connection that is not set up: the set's own methods refuse with that reason, as any tracker error.
  try { return (tracker as TicketSetLive).ticketsFor(id); } catch { return tracker; }
}

/**
 * A stored run's or queue entry's ticket as a qualified ref: the registry keeps
 * the native id beside its connection (`ticketProvider`). A provider that isn't
 * a known connection leaves the id as it is, for the default tracker.
 */
export function runTicketRef(r: { ticketProvider: string; ticketId: string }): string {
  return isKnownConnection(r.ticketProvider) ? formatRef(r.ticketProvider, r.ticketId) : r.ticketId;
}
