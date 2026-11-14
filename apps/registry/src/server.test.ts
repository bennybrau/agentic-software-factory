import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { dbAvailable, TEST_URL } from './test/harness.js';

const skip = !(await dbAvailable());

test('rpc + worker routes over HTTP with the shared secret; SSE carries events', { skip }, async () => {
  const schema = `t_server_${Date.now().toString(36)}`;
  const admin = postgres(TEST_URL, { onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const { buildServer } = await import('./server.js');
  const { app, secret } = await buildServer({ secret: 's3cret', migrate: true, sweeper: false, recurring: false, databaseUrl: TEST_URL, schema });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const H = { 'content-type': 'application/json', 'x-run-secret': secret };
  try {
    assert.equal((await fetch(`${base}/internal/rpc`, { method: 'POST', body: '{}' })).status, 401);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.db, true);

    const ticket = `srv-${Date.now()}`;
    const created = await (await fetch(`${base}/internal/rpc`, { method: 'POST', headers: H, body: JSON.stringify({ op: 'createRun', input: {
      ticketId: ticket, ticketKey: ticket.toUpperCase(), ticketProvider: 'mock', maxCostUsd: 5, dispatchedBy: 'jon',
      team: { name: 'solo', roles: [{ role: 'planner', output: 'plan.md' }] }, gates: { after_plan: { mode: 'auto' } } } }) })).json();
    assert.equal(created.ok, true);
    const runId: string = created.result.run.id;

    // SSE: subscribe, then produce events, then read them back.
    const sse = await fetch(`${base}/internal/events/runs`, { headers: { 'x-run-secret': secret } });
    const reader = sse.body!.getReader();
    const sseDone = () => reader.cancel().catch(() => {});
    let buf = '';
    const readUntil = async (needle: string) => { while (!buf.includes(needle)) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); } };
    await readUntil('event: hello');

    const reg = await fetch(`${base}/workers/register`, { method: 'POST', headers: H, body: JSON.stringify({ id: 'w', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1 }) });
    assert.equal(reg.status, 200);
    const claim = await (await fetch(`${base}/workers/w/claim`, { method: 'POST', headers: H, body: JSON.stringify({ runtimes: ['claude-code'] }) })).json();
    assert.equal(claim.claim.run.id, runId);
    const fin = await (await fetch(`${base}/tasks/${claim.claim.task.id}/finish`, { method: 'POST', headers: H, body: JSON.stringify({ outcome: 'done', costUsd: 0.2 }) })).json();
    assert.equal(fin.runId, runId);
    await readUntil('run:succeeded');
    // Every event, in commit order: a client resuming from Last-Event-ID must not skip one.
    const seqs = [...buf.matchAll(new RegExp(`id: ${runId}:(\\d+)`, 'g'))].map((m) => Number(m[1]));
    // Contiguous from wherever the subscription caught the run: run:created commits
    // before the SSE client subscribes, so whether seq 1 arrives is a race (it lost
    // often under a busy test DB). What matters is no gap and no reordering after it.
    assert.ok(seqs.length >= 3 && seqs[0]! <= 2, `too few events: ${seqs.join(',')}`);
    assert.deepEqual(seqs, seqs.map((_, i) => seqs[0]! + i), `events out of order or missing: ${seqs.join(',')}`);
    assert.match(buf, /task:started/);
    assert.match(buf, /task:finished/);
    await sseDone();

    const got = await (await fetch(`${base}/internal/rpc`, { method: 'POST', headers: H, body: JSON.stringify({ op: 'getRun', id: runId }) })).json();
    assert.equal(got.result.run.state, 'succeeded');
    const dup = await fetch(`${base}/internal/rpc`, { method: 'POST', headers: H, body: JSON.stringify({ op: 'createRun', input: {
      ticketId: 'never', ticketKey: 'NEVER', ticketProvider: 'mock', maxCostUsd: 5, team: { name: 'solo', roles: [{ role: 'planner' }] }, gates: {} } }) });
    assert.equal(dup.status, 200);
  } finally {
    await app.close();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('SSE sends queue:changed when the scheduler moves a queue entry, and nothing when it does not', { skip }, async () => {
  const schema = `t_server_q_${Date.now().toString(36)}`;
  const admin = postgres(TEST_URL, { onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const { buildServer } = await import('./server.js');
  const { app, secret } = await buildServer({ secret: 's3cret', migrate: true, sweeper: false, recurring: false, databaseUrl: TEST_URL, schema });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const H = { 'content-type': 'application/json', 'x-run-secret': secret };
  const rpc = async (body: unknown) => (await fetch(`${base}/internal/rpc`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
  try {
    const sse = await fetch(`${base}/internal/events/runs`, { headers: { 'x-run-secret': secret } });
    const reader = sse.body!.getReader();
    let buf = '';
    const readUntil = async (needle: string) => { while (!buf.includes(needle)) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); } };
    await readUntil('event: hello');

    const enq = await rpc({ op: 'enqueue', items: [
      { ticketId: 'q1', ticketKey: 'Q-1', ticketProvider: 'mock' },
      { ticketId: 'q2', ticketKey: 'Q-2', ticketProvider: 'mock' },
    ] });
    const [a, b] = enq.result.entries as { id: string }[];
    await rpc({ op: 'markQueueEntry', id: a!.id, state: 'failed', reason: 'over budget' });
    await readUntil(a!.id);
    assert.match(buf, new RegExp(`event: queue:changed\ndata: \\{"id":"${a!.id}","state":"failed"\\}\n\n`));

    // Marking the same entry again moves nothing, so no frame; the next real move is the only one that follows.
    await rpc({ op: 'markQueueEntry', id: a!.id, state: 'failed', reason: 'again' });
    await rpc({ op: 'markQueueEntry', id: b!.id, state: 'dispatched' });
    await readUntil(b!.id);
    assert.equal([...buf.matchAll(/event: queue:changed/g)].length, 2);
    assert.match(buf, new RegExp(`"id":"${b!.id}","state":"dispatched"`));
    await reader.cancel().catch(() => {});
  } finally {
    await app.close();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('POST /workers/:id/heartbeat over HTTP: a valid preflight body is stored, a malformed one is refused (#69)', { skip }, async () => {
  const schema = `t_server_hb_${Date.now().toString(36)}`;
  const admin = postgres(TEST_URL, { onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const { buildServer } = await import('./server.js');
  const { app, secret } = await buildServer({ secret: 's3cret', migrate: true, sweeper: false, recurring: false, databaseUrl: TEST_URL, schema });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const H = { 'content-type': 'application/json', 'x-run-secret': secret };
  try {
    const reg = await fetch(`${base}/workers/register`, { method: 'POST', headers: H, body: JSON.stringify({ id: 'w-hb', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1 }) });
    assert.equal(reg.status, 200);

    const preflight = [{ kind: 'claude-code', installed: true, version: '2.1.0', ok: true, checkedAt: new Date().toISOString() }];
    const hb = await fetch(`${base}/workers/w-hb/heartbeat`, { method: 'POST', headers: H, body: JSON.stringify({ preflight }) });
    assert.equal(hb.status, 200);

    const rpc = await (await fetch(`${base}/internal/rpc`, { method: 'POST', headers: H, body: JSON.stringify({ op: 'listFleet' }) })).json();
    assert.deepEqual(rpc.result.workers.find((w: { id: string }) => w.id === 'w-hb').preflight, preflight);

    const bad = await fetch(`${base}/workers/w-hb/heartbeat`, { method: 'POST', headers: H, body: JSON.stringify({ preflight: [{ kind: 'claude-code' }] }) });
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
