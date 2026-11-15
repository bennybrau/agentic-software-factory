import type { FastifyInstance, FastifyReply } from 'fastify';
import { formatRef, parseRef } from '@asf/shared';
import type { Ticket, TicketProvider } from '@asf/shared';
import type { TicketSet } from '../providers/tickets/set.js';
import { cfg } from '../settings.js';
import { findTicketsByRef } from '../tickets/find.js';
import { ticketsFor } from '../tickets/route.js';

const csv = (s?: string) => (s ? s.split(',').map((v) => v.trim()).filter(Boolean) : undefined);

/**
 * The trackers a looked-up id can live in (M12 WP3): the one a qualified id
 * names, Jira for a `PROJ-12` key, GitHub for `owner/repo#42`, and every
 * connected tracker when the form doesn't say (or that tracker isn't connected).
 */
export function findConnections(id: string, connections: readonly string[]): string[] {
  const ref = parseRef(id, '');
  if (ref.qualified) return connections.includes(ref.connection) ? [ref.connection] : [];
  const guess = /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(id) ? 'jira' : /^[^\s#]+\/[^\s#]+#\d+$/.test(id) ? 'github' : null;
  return guess && connections.includes(guess) ? [guess] : [...connections];
}

/**
 * The Planned tasks routes (M12 WP3): the merged list of every tracker (or the
 * ones `connection` names), and the board/sprint/status discovery of one
 * tracker. `set.live` routes each per-ticket call to the ticket's tracker.
 */
export function registerTicketRoutes(app: FastifyInstance, deps: { set: TicketSet }): void {
  const { set } = deps;
  const tickets: TicketProvider = set.live;

  /** The one tracker a discovery route asks: `?connection=`, else the default. A tracker that is not set up is a 400. */
  async function oneTracker(connection: string | undefined, reply: FastifyReply): Promise<TicketProvider | null> {
    try {
      // Built first, so capabilities() are the real tracker's and not the all-false placeholder.
      return await set.registryFor(connection || set.defaultConnection).current();
    } catch (e) {
      void reply.code(400).send({ error: 'bad_connection', reason: (e as Error).message });
      return null;
    }
  }

  // Every selected tracker in parallel, merged in connection order. A tracker that errors
  // is reported in `sources` and the rest still list. Board, sprint and status filters
  // belong to one tracker, so they apply only when exactly one is selected.
  app.get('/api/tickets', async (req) => {
    const q = req.query as { connection?: string; scope?: string; search?: string; bucket?: string; sprint?: string; status?: string; excludeDone?: string; updatedWithinDays?: string; limit?: string };
    const connections = csv(q.connection) ?? set.connections;
    const one = connections.length === 1;
    const days = Number(q.updatedWithinDays);
    return set.live.listAll({
      scope: one ? csv(q.scope) ?? [] : [], search: q.search, bucket: csv(q.bucket) as never,
      sprint: one ? csv(q.sprint) : undefined, status: one ? csv(q.status) : undefined,
      excludeDone: q.excludeDone === 'true',
      updatedWithinDays: Number.isFinite(days) && days > 0 ? days : undefined,
      limit: Number(q.limit ?? 200),
    }, connections);
  });

  // Backlog-scoping discovery (capability-gated: a tracker that does not support a
  // dimension reports it in capabilities() and returns [] here rather than erroring,
  // so the UI can render only the controls the tracker offers).
  app.get('/api/tickets/scopes', async (req, reply) => {
    const p = await oneTracker((req.query as { connection?: string }).connection, reply);
    if (!p) return reply;
    return p.capabilities().boards ? p.listScopes() : [];
  });
  app.get<{ Params: { id: string } }>('/api/tickets/scopes/:id/sprints', async (req, reply) => {
    const p = await oneTracker((req.query as { connection?: string }).connection, reply);
    if (!p) return reply;
    return p.capabilities().sprints ? p.listSprints(req.params.id) : [];
  });
  app.get('/api/tickets/statuses', async (req, reply) => {
    const q = req.query as { scope?: string; connection?: string };
    const p = await oneTracker(q.connection, reply);
    if (!p) return reply;
    return p.capabilities().statuses ? p.listStatuses(q.scope || undefined) : [];
  });

  // Find by ticket number across the whole tracker (Planned tasks search): the
  // page's own list is limited to the selected board/sprint and open tickets.
  // Each candidate id goes to the tracker its form names, else to every tracker.
  app.get('/api/tickets/find', async (req) => {
    const q = req.query as { q?: string; prefixes?: string };
    const connections = set.connections;
    const configured = connections.includes('jira') ? String(cfg('JIRA_PROJECTS') ?? '').split(',') : [];
    const prefixes = [...configured, ...(q.prefixes ?? '').split(',')].map((s) => s.trim()).filter(Boolean);
    const get = async (id: string): Promise<Ticket> => {
      const native = parseRef(id, '').native;
      const got = await Promise.allSettled(findConnections(id, connections).map((c) => tickets.get(formatRef(c, native))));
      const hit = got.find((r): r is PromiseFulfilledResult<Ticket> => r.status === 'fulfilled');
      if (!hit) throw new Error(`no ticket ${id}`);
      return hit.value;
    };
    return { tickets: await findTicketsByRef(get, q.q ?? '', prefixes) };
  });

  app.get<{ Params: { id: string } }>('/api/tickets/:id', async (req) => ticketsFor(tickets, req.params.id).get(req.params.id));
}
