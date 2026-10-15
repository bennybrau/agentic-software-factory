import type { FastifyInstance } from 'fastify';
import { claimInputSchema, finishTaskInputSchema, workerHeartbeatSchema, workerRegisterSchema } from '@asf/shared';
import type { Sql } from '../db/pool.js';
import { config } from '../config.js';
import * as workers from '../runs/workers.js';

export function registerWorkerRoutes(app: FastifyInstance, sql: Sql): void {
  app.post('/workers/register', async (req, reply) => {
    const p = workerRegisterSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', issues: p.error.issues });
    return workers.registerWorker(sql, p.data);
  });
  app.post<{ Params: { id: string } }>('/workers/:id/heartbeat', async (req, reply) => {
    const p = workerHeartbeatSchema.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: 'bad_request', issues: p.error.issues });
    const ok = await workers.heartbeat(sql, req.params.id, p.data.preflight);
    if (!ok) return reply.code(404).send({ error: 'not_found', reason: 'unknown worker; register again' });
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/workers/:id/deregister', async (req) => workers.deregisterWorker(sql, req.params.id));
  app.post<{ Params: { id: string } }>('/workers/:id/claim', async (req, reply) => {
    const p = claimInputSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', issues: p.error.issues });
    const alive = await workers.heartbeat(sql, req.params.id);
    if (!alive) return reply.code(404).send({ error: 'not_found', reason: 'unknown worker; register again' });
    return { claim: await workers.claimTask(sql, req.params.id, p.data.runtimes, p.data.capabilities) };
  });
  app.post<{ Params: { id: string } }>('/tasks/:id/finish', async (req, reply) => {
    const p = finishTaskInputSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', issues: p.error.issues });
    return workers.finishTask(sql, req.params.id, p.data);
  });
  app.get('/workers', async () => ({ workers: await workers.listLiveWorkers(sql, config.workerTtlSeconds) }));
}
