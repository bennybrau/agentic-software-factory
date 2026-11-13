import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerQueueRoutes } from './queue.js';
import { MockScmProvider } from '../providers/scm/mock.js';
import { MockTicketProvider } from '../providers/tickets/mock.js';

// The queue routes are a thin surface over registry RPCs. Stub the registry and
// assert the HTTP calls map to the right ops with the right shapes.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function stub() {
  const calls: Array<{ op: string; body: Record<string, unknown> }> = [];
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string };
    calls.push({ op: body.op, body: body as unknown as Record<string, unknown> });
    if (body.op === 'enqueue') return json({ ok: true, result: { entries: [{ id: 'wq_1', ticketId: 'asf-1', ticketProvider: 'mock', ticketKey: 'ASF-1', repoId: null, teamName: null, maxCostUsd: null, mode: 'parallel', position: 1, batchId: 'b', state: 'queued', runId: null, reason: null, addedBy: 'operator', addedAt: '2026-09-16T00:00:00Z', dispatchedAt: null }] } });
    if (body.op === 'listQueue') return json({ ok: true, result: { entries: [] } });
    if (body.op === 'retryQueueEntry') return json({ ok: true, result: { ok: true, requeued: true } });
    return json({ ok: true, result: { ok: true } });
  }) as unknown as typeof fetch;
  return calls;
}
function json(obj: unknown) { return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } }); }

async function app(scm = new MockScmProvider()) {
  const a = Fastify();
  registerQueueRoutes(a, { tickets: new MockTicketProvider(), scm });
  await a.ready();
  return a;
}

test('POST /api/queue enqueues a batch and reports added/skipped', async () => {
  const calls = stub();
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/queue', payload: { items: [{ ticketId: 'asf-1', ticketKey: 'ASF-1', ticketProvider: 'mock' }, { ticketId: 'asf-2', ticketKey: 'ASF-2', ticketProvider: 'mock' }], mode: 'serial' } });
  assert.equal(res.statusCode, 201);
  const b = res.json();
  assert.equal(b.added, 1);   // stub returns 1 entry
  assert.equal(b.skipped, 1); // asked for 2
  const enq = calls.find((c) => c.op === 'enqueue')!;
  assert.equal(enq.body.mode, 'serial');
  assert.equal((enq.body.items as unknown[]).length, 2);
  await a.close();
});

test('POST /api/queue stamps the provider server-side from the API provider (ignores client value)', async () => {
  const calls = stub();
  const a = await app();
  await a.inject({ method: 'POST', url: '/api/queue', payload: { items: [{ ticketId: 'asf-1', ticketKey: 'ASF-1', ticketProvider: 'lies' }], mode: 'parallel' } });
  const enq = calls.find((c) => c.op === 'enqueue')!;
  const items = enq.body.items as Array<{ ticketProvider: string }>;
  assert.equal(items[0].ticketProvider, 'mock'); // MockTicketProvider.kind, not the client's 'lies'
  await a.close();
});

test('POST /api/queue sends the registry native ticket ids beside their connection; bare ids still work', async () => {
  const calls = stub();
  const a = await app();
  await a.inject({ method: 'POST', url: '/api/queue', payload: { items: [
    { ticketId: 'mock:asf-1', ticketKey: 'ASF-1', ticketProvider: '' },
    { ticketId: 'asf-2', ticketKey: 'ASF-2', ticketProvider: '' },
    { ticketId: 'adhoc:ce17', ticketKey: 'ADHOC-CE17', ticketProvider: '', repoId: 'mock:1' },
  ], mode: 'parallel' } });
  const items = calls.find((c) => c.op === 'enqueue')!.body.items as Array<{ ticketId: string; ticketProvider: string; repoId?: string }>;
  assert.deepEqual(items.map((i) => [i.ticketId, i.ticketProvider]), [['asf-1', 'mock'], ['asf-2', 'mock'], ['adhoc:ce17', 'adhoc']]);
  assert.equal(items[2].repoId, 'mock:1', 'the repository keeps its qualified id');
  await a.close();
});

test('POST /api/queue keeps the repository chosen for each item', async () => {
  const calls = stub();
  const a = await app();
  await a.inject({ method: 'POST', url: '/api/queue', payload: { items: [{ ticketId: 'asf-1', ticketKey: 'ASF-1', ticketProvider: '', repoId: 'acme/platform/web/shared-ui' }, { ticketId: 'asf-2', ticketKey: 'ASF-2', ticketProvider: '' }], mode: 'parallel' } });
  const items = calls.find((c) => c.op === 'enqueue')!.body.items as Array<{ repoId?: string | null }>;
  assert.deepEqual(items.map((i) => i.repoId ?? null), ['acme/platform/web/shared-ui', null]);
  await a.close();
});

test('POST /api/queue rejects an empty items array', async () => {
  stub();
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/queue', payload: { items: [] } });
  assert.equal(res.statusCode, 400);
  await a.close();
});

test('GET /api/queue lists entries; DELETE removes; PATCH reorders', async () => {
  const calls = stub();
  const a = await app();
  assert.equal((await a.inject({ method: 'GET', url: '/api/queue' })).statusCode, 200);
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/queue/wq_1' })).statusCode, 200);
  assert.equal((await a.inject({ method: 'PATCH', url: '/api/queue/wq_1/reorder', payload: { beforeId: 'wq_2' } })).statusCode, 200);
  assert.ok(calls.some((c) => c.op === 'listQueue'));
  assert.ok(calls.some((c) => c.op === 'removeQueueEntry'));
  const reorder = calls.find((c) => c.op === 'reorderQueue')!;
  assert.equal(reorder.body.beforeId, 'wq_2');
  await a.close();
});

test('POST /api/queue/:id/retry puts a refused entry back as the person asking', async () => {
  const calls = stub();
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/queue/wq_1/retry', headers: { 'x-operator': 'Zo%C3%AB' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, requeued: true });
  const retry = calls.find((c) => c.op === 'retryQueueEntry')!;
  assert.equal(retry.body.id, 'wq_1');
  assert.equal(retry.body.by, 'Zoë');
  await a.close();
});

test('POST /api/queue refuses (409) until there is a repository to put code in, and enqueues nothing', async () => {
  const calls = stub();
  const a = await app(new MockScmProvider(''));   // mock SCM with no repo configured
  const res = await a.inject({ method: 'POST', url: '/api/queue', payload: { items: [{ ticketId: 'asf-1', ticketKey: 'ASF-1', ticketProvider: 'mock' }], mode: 'parallel' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'scm_not_connected');
  assert.equal(res.json().link, '/settings#code');
  assert.ok(!calls.some((c) => c.op === 'enqueue'), 'nothing reaches the queue');
  await a.close();
});
