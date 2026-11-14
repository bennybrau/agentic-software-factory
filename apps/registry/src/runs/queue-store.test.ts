import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, listQueue, reorderQueue, removeQueueEntry, readyQueueEntries, markQueueEntry, retryQueueEntry } from './queue-store.js';
import { createRun } from './store.js';
import { dbAvailable, testDb, runInput } from '../test/harness.js';
import type { EnqueueItem } from '@asf/shared';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('queue'); });
after(async () => { if (db) await db.close(); });

const item = (n: string): EnqueueItem => ({ ticketId: n, ticketKey: n.toUpperCase(), ticketProvider: 'mock', repoId: null, teamName: null, maxCostUsd: null });

test('enqueue appends a batch at the tail in order; dedupes an already-queued ticket', { skip }, async () => {
  const first = await enqueue(db.sql, [item('q1'), item('q2')], 'parallel', 'jon');
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((e) => e.ticketId), ['q1', 'q2']);
  assert.ok(first[0].position < first[1].position, 'positions ascend');
  // q1 is already queued -> skipped; q3 is new -> added.
  const second = await enqueue(db.sql, [item('q1'), item('q3')], 'parallel', 'jon');
  assert.deepEqual(second.map((e) => e.ticketId), ['q3']);
  const all = await listQueue(db.sql, { limit: 100 });
  assert.deepEqual(all.filter((e) => e.state === 'queued').map((e) => e.ticketId), ['q1', 'q2', 'q3']);
});

test('reorder moves an entry before another; remove cancels it', { skip }, async () => {
  const [a, _b, c] = await enqueue(db.sql, [item('r1'), item('r2'), item('r3')], 'parallel', 'jon');
  // Move r3 before r1 -> order r3, r1, r2.
  await reorderQueue(db.sql, c.id, a.id);
  let order = (await listQueue(db.sql, { state: 'queued', limit: 100 })).filter((e) => e.ticketId.startsWith('r')).map((e) => e.ticketId);
  assert.deepEqual(order, ['r3', 'r1', 'r2']);
  // Remove r1.
  await removeQueueEntry(db.sql, a.id, 'jon');
  order = (await listQueue(db.sql, { state: 'queued', limit: 100 })).filter((e) => e.ticketId.startsWith('r')).map((e) => e.ticketId);
  assert.deepEqual(order, ['r3', 'r2']);
  const removed = (await listQueue(db.sql, { limit: 100 })).find((e) => e.id === a.id)!;
  assert.equal(removed.state, 'cancelled');
  assert.match(removed.reason ?? '', /removed by jon/);
});

test('parallel entries are all ready at once', { skip }, async () => {
  await db.sql`UPDATE work_queue SET state = 'cancelled'`; // clear the queue
  await enqueue(db.sql, [item('p1'), item('p2'), item('p3')], 'parallel', 'jon');
  const ready = await readyQueueEntries(db.sql, 20);
  assert.deepEqual(ready.map((e) => e.ticketId).sort(), ['p1', 'p2', 'p3']);
});

test('serial: only the head is ready; the next releases when the prior run reaches a gate', { skip }, async () => {
  await db.sql`UPDATE work_queue SET state = 'cancelled'`;
  const [s1, s2, s3] = await enqueue(db.sql, [item('s1'), item('s2'), item('s3')], 'serial', 'jon');

  // Only the batch head is ready initially.
  let ready = await readyQueueEntries(db.sql, 20);
  assert.deepEqual(ready.map((e) => e.ticketId), ['s1']);

  // Dispatch s1 -> a real run in 'queued' (not yet claimed). s2 must still be blocked.
  const run1 = await createRun(db.sql, runInput({ ticketId: 's1-run', ticketKey: 'S1' }));
  await markQueueEntry(db.sql, s1.id, 'dispatched', run1.run.id, null);
  ready = await readyQueueEntries(db.sql, 20);
  assert.deepEqual(ready.map((e) => e.ticketId), [], 's2 blocked while s1 run is queued/running');

  // s1 run reaches its first gate (awaiting_checkpoint) -> s2 releases.
  await db.sql`UPDATE agent_run SET state = 'awaiting_checkpoint' WHERE id = ${run1.run.id}`;
  ready = await readyQueueEntries(db.sql, 20);
  assert.deepEqual(ready.map((e) => e.ticketId), ['s2'], 's2 ready once s1 is at a gate');

  // Dispatch s2, then let its run finish terminally -> s3 releases.
  const run2 = await createRun(db.sql, runInput({ ticketId: 's2-run', ticketKey: 'S2' }));
  await markQueueEntry(db.sql, s2.id, 'dispatched', run2.run.id, null);
  assert.deepEqual((await readyQueueEntries(db.sql, 20)).map((e) => e.ticketId), []);
  await db.sql`UPDATE agent_run SET state = 'succeeded', finished_at = now() WHERE id = ${run2.run.id}`;
  assert.deepEqual((await readyQueueEntries(db.sql, 20)).map((e) => e.ticketId), ['s3']);
  void s3;
});

test('markQueueEntry failed records the reason and drops it from ready', { skip }, async () => {
  await db.sql`UPDATE work_queue SET state = 'cancelled'`;
  const [f1] = await enqueue(db.sql, [item('f1')], 'parallel', 'jon');
  await markQueueEntry(db.sql, f1.id, 'failed', null, 'no repo bound');
  const row = (await listQueue(db.sql, { limit: 100 })).find((e) => e.id === f1.id)!;
  assert.equal(row.state, 'failed');
  assert.equal(row.reason, 'no repo bound');
  assert.deepEqual((await readyQueueEntries(db.sql, 20)).map((e) => e.ticketId), []);
});

const notes = async (entryId: string) =>
  db.sql`SELECT kind, title, body, actions, run_id FROM notification WHERE queue_entry_id = ${entryId}`;

test('a refusal is stamped with when and why, and puts exactly one notification in the bell', { skip }, async () => {
  await db.sql`UPDATE work_queue SET state = 'cancelled'`;
  const [rf, ok] = await enqueue(db.sql, [item('rf1'), item('rf2')], 'parallel', 'jon');
  await markQueueEntry(db.sql, rf.id, 'failed', null, 'over the monthly budget', 'over_budget');
  // A second report for the same entry (it is no longer queued) changes nothing.
  await markQueueEntry(db.sql, rf.id, 'failed', null, 'again', 'other');
  await markQueueEntry(db.sql, ok.id, 'dispatched', null, null);

  const row = (await listQueue(db.sql, { limit: 100 })).find((e) => e.id === rf.id)!;
  assert.equal(row.reasonCode, 'over_budget');
  assert.equal(row.reason, 'over the monthly budget');
  assert.ok(row.refusedAt, 'refusedAt is set');
  const n = await notes(rf.id);
  assert.equal(n.length, 1);
  assert.equal(n[0].kind, 'refused');
  assert.equal(n[0].title, 'RF1: couldn\u2019t start');
  assert.equal(n[0].body, 'over the monthly budget');
  assert.deepEqual(n[0].actions, [{ label: 'Open Activity', url: '/runs' }]);
  assert.equal(n[0].runId, null);

  const dispatched = (await listQueue(db.sql, { limit: 100 })).find((e) => e.id === ok.id)!;
  assert.equal(dispatched.refusedAt, null);
  assert.equal(dispatched.reasonCode, null);
  assert.equal((await notes(ok.id)).length, 0, 'no notification for a dispatched entry');
});

test('dismissing a refused entry cancels it and deletes its notification', { skip }, async () => {
  const [d] = await enqueue(db.sql, [item('dm1')], 'parallel', 'jon');
  await markQueueEntry(db.sql, d.id, 'failed', null, 'nope', 'not_found');
  await removeQueueEntry(db.sql, d.id, 'jon');
  const row = (await listQueue(db.sql, { limit: 100 })).find((e) => e.id === d.id)!;
  assert.equal(row.state, 'cancelled');
  assert.equal((await notes(d.id)).length, 0);
});

test('retry puts a refused entry back at the tail as the new person, keeping repo, team, cost cap, batch and dependencies', { skip }, async () => {
  await db.sql`UPDATE work_queue SET state = 'cancelled'`;
  const [rt] = await enqueue(db.sql, [{ ...item('rt1'), repoId: 'github:acme/web', teamName: 'standard', maxCostUsd: 7 }], 'serial', 'jon');
  await db.sql`UPDATE work_queue SET depends_on = '["dep-1"]'::jsonb WHERE id = ${rt.id}`;
  await markQueueEntry(db.sql, rt.id, 'failed', null, 'over budget', 'over_budget');
  const [later] = await enqueue(db.sql, [item('rt2')], 'parallel', 'jon');

  assert.deepEqual(await retryQueueEntry(db.sql, rt.id, 'zoe'), { requeued: true });
  const row = (await listQueue(db.sql, { limit: 100 })).find((e) => e.id === rt.id)!;
  assert.equal(row.state, 'queued');
  assert.equal(row.addedBy, 'zoe');
  assert.equal(row.repoId, 'github:acme/web');
  assert.equal(row.teamName, 'standard');
  assert.equal(row.maxCostUsd, 7);
  assert.equal(row.batchId, rt.batchId);
  assert.equal(row.mode, 'serial');
  assert.deepEqual(row.dependsOn, ['dep-1']);
  assert.equal(row.reason, null);
  assert.equal(row.reasonCode, null);
  assert.equal(row.refusedAt, null);
  assert.ok(row.position > later.position, 'back at the tail');
  assert.equal((await notes(rt.id)).length, 0, 'the old notification goes');
});

test('retry when the ticket is already queued again only cancels the refused entry', { skip }, async () => {
  await db.sql`UPDATE work_queue SET state = 'cancelled'`;
  const [old] = await enqueue(db.sql, [item('aq1')], 'parallel', 'jon');
  await markQueueEntry(db.sql, old.id, 'failed', null, 'nope', 'over_budget');
  const [fresh] = await enqueue(db.sql, [item('aq1')], 'parallel', 'ann');
  assert.ok(fresh, 'the ticket can be queued again beside its refusal');

  assert.deepEqual(await retryQueueEntry(db.sql, old.id, 'zoe'), { requeued: false });
  const all = await listQueue(db.sql, { limit: 100 });
  assert.equal(all.find((e) => e.id === old.id)!.state, 'cancelled');
  assert.equal(all.find((e) => e.id === fresh.id)!.state, 'queued');
  assert.equal((await notes(old.id)).length, 0);
});

test('retry acts only on a refused entry: dispatched, queued and cancelled entries are left exactly as they were', { skip }, async () => {
  await db.sql`UPDATE work_queue SET state = 'cancelled'`;
  const [dp, qd, cn] = await enqueue(db.sql, [item('ro1'), item('ro2'), item('ro3')], 'parallel', 'jon');
  await markQueueEntry(db.sql, dp.id, 'dispatched', null, null);
  await removeQueueEntry(db.sql, cn.id, 'jon');
  for (const e of [dp, qd, cn]) {
    await db.sql`INSERT INTO notification (run_id, queue_entry_id, kind, title) VALUES (NULL, ${e.id}, 'refused', ${e.ticketKey})`;
  }
  const snapshot = async (id: string) => {
    const row = (await listQueue(db.sql, { limit: 100 })).find((e) => e.id === id)!;
    return { state: row.state, position: row.position, addedBy: row.addedBy, notes: await notes(id) };
  };
  const before = new Map<string, Awaited<ReturnType<typeof snapshot>>>();
  for (const e of [dp, qd, cn]) before.set(e.id, await snapshot(e.id));
  assert.deepEqual([...before.values()].map((s) => s.state), ['dispatched', 'queued', 'cancelled']);

  for (const e of [dp, qd, cn]) {
    assert.deepEqual(await retryQueueEntry(db.sql, e.id, 'zoe'), { requeued: false });
    assert.deepEqual(await snapshot(e.id), before.get(e.id), `${e.ticketId} untouched`);
  }
});
