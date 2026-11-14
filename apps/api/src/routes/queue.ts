import type { FastifyInstance } from 'fastify';
import { parseRef } from '@asf/shared';
import type { TicketProvider, ScmProvider, EnqueueItem, QueueMode } from '@asf/shared';
import { startReadiness } from '../start-readiness.js';
import { registry } from '../registry/client.js';
import { resolveIdentity } from '../identity.js';

/**
 * The work queue's HTTP surface. Enqueue a batch of tickets (serial or parallel),
 * list the queue, reorder an entry, remove one. The scheduler (scheduler.ts) is
 * what turns queued entries into runs; these routes only edit the queue. Body
 * shape is validated by the registry's rpcRequestSchema (enqueueItemSchema), so
 * a malformed item comes back as a 400 from the RPC layer.
 */
export function registerQueueRoutes(app: FastifyInstance, deps: { tickets: TicketProvider; scm: ScmProvider }): void {
  app.get('/api/queue', async () => {
    const { entries } = await registry.listQueue();
    return { entries };
  });

  app.post<{ Body: { items?: EnqueueItem[]; mode?: QueueMode } }>('/api/queue', async (req, reply) => {
    const body = req.body ?? {};
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return reply.code(400).send({ error: 'bad_request', reason: 'items must be a non-empty array' });
    }
    // Queuing is starting later: refuse it too until there is a repository to put code in.
    const ready = await startReadiness(deps.scm);
    if (!ready.ok) return reply.code(409).send({ error: ready.code, reason: ready.reason, link: ready.link });
    // Stamp the provider server-side from the ticket's own id (a bare id is the API's
    // configured tracker), so the browser never has to know its kind. The registry
    // stores the native id beside its connection, as a dispatch does.
    const items = body.items.map((it) => {
      // A malformed item goes through as it is, for the registry's schema to refuse.
      if (typeof it.ticketId !== 'string') return { ...it, ticketProvider: deps.tickets.kind };
      const ref = parseRef(it.ticketId, deps.tickets.kind);
      return { ...it, ticketId: ref.native, ticketProvider: ref.connection };
    });
    const by = resolveIdentity(req).user;
    const { entries } = await registry.enqueue({ items, mode: body.mode ?? 'parallel', by });
    return reply.code(201).send({ entries, added: entries.length, skipped: items.length - entries.length });
  });

  app.patch<{ Params: { id: string }; Body: { beforeId?: string | null } }>('/api/queue/:id/reorder', async (req) => {
    await registry.reorderQueue(req.params.id, req.body?.beforeId ?? null);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/queue/:id', async (req) => {
    const by = resolveIdentity(req).user;
    await registry.removeQueueEntry(req.params.id, by);
    return { ok: true };
  });

  // Try a refused start again: back to the tail of the queue as this person's.
  app.post<{ Params: { id: string } }>('/api/queue/:id/retry', async (req) => {
    const by = resolveIdentity(req).user;
    const { requeued } = await registry.retryQueueEntry(req.params.id, by);
    return { ok: true, requeued };
  });
}
