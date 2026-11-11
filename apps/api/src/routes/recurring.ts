import type { FastifyInstance, FastifyReply } from 'fastify';
import { createRecurringTaskInputSchema, isValidTimeZone, sameRef, updateRecurringTaskInputSchema } from '@asf/shared';
import type { ScmProvider } from '@asf/shared';
import { registry } from '../registry/client.js';
import { resolveIdentity } from '../identity.js';
import { startReadiness } from '../start-readiness.js';

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');

/**
 * Recurring tasks (#188): an ad-hoc task the factory creates on a schedule. These
 * routes are the UI's CRUD over the registry's store; the firing loop lives elsewhere.
 * Refuses an unknown time zone or a repository source control can't reach, rather
 * than store a schedule that could never run.
 */
export function registerRecurringRoutes(app: FastifyInstance, deps: { scm: ScmProvider }): void {
  /**
   * Sends a 400 when the body's zone or repository is wrong and returns true; false when
   * both are fine. (A boolean, not the reply: a FastifyReply is thenable, so awaiting one
   * would resolve to undefined and let the route carry on.)
   */
  async function refused(reply: FastifyReply, body: unknown): Promise<boolean> {
    const { timezone, repoId } = (body ?? {}) as { timezone?: unknown; repoId?: unknown };
    if (typeof timezone === 'string' && !isValidTimeZone(timezone)) {
      reply.code(400).send({ error: 'bad_timezone', reason: `"${timezone}" isn't a time zone this server knows (e.g. Europe/London).` });
      return true;
    }
    if (typeof repoId === 'string') {
      const ready = await startReadiness(deps.scm);
      const repos = ready.ok ? ready.repos : [];
      if (!repos.some((r) => sameRef(r.id, repoId, deps.scm.kind))) {
        reply.code(400).send({ error: 'repo_not_found', reason: ready.ok
          ? `The repository "${repoId}" isn't one source control can reach. Pick one of: ${repos.map((r) => r.path).join(', ')}.`
          : ready.reason });
        return true;
      }
    }
    return false;
  }

  app.get('/api/recurring', async () => {
    const { tasks } = await registry.listRecurring();
    return { tasks };
  });

  app.get<{ Params: { id: string } }>('/api/recurring/:id', async (req, reply) => {
    const { task } = await registry.getRecurring(req.params.id);
    if (!task) return reply.code(404).send({ error: 'not_found', reason: `no recurring task ${req.params.id}` });
    return { task };
  });

  app.post('/api/recurring', async (req, reply) => {
    if (await refused(reply, req.body)) return reply;
    const parsed = createRecurringTaskInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', reason: issues(parsed.error) });
    const { task } = await registry.createRecurring(parsed.data, resolveIdentity(req).user || null);
    return reply.code(201).send({ task });
  });

  app.patch<{ Params: { id: string } }>('/api/recurring/:id', async (req, reply) => {
    if (await refused(reply, req.body)) return reply;
    const parsed = updateRecurringTaskInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', reason: issues(parsed.error) });
    const { task: existing } = await registry.getRecurring(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not_found', reason: `no recurring task ${req.params.id}` });
    const { task } = await registry.updateRecurring(req.params.id, parsed.data);
    return { task };
  });

  app.delete<{ Params: { id: string } }>('/api/recurring/:id', async (req, reply) => {
    const { deleted } = await registry.deleteRecurring(req.params.id);
    if (!deleted) return reply.code(404).send({ error: 'not_found', reason: `no recurring task ${req.params.id}` });
    return reply.code(204).send();
  });

  for (const [action, paused] of [['pause', true], ['resume', false]] as const) {
    app.post<{ Params: { id: string } }>(`/api/recurring/:id/${action}`, async (req, reply) => {
      const { task: existing } = await registry.getRecurring(req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not_found', reason: `no recurring task ${req.params.id}` });
      const { task } = await registry.setRecurringPaused(req.params.id, paused);
      return { task };
    });
  }
}
