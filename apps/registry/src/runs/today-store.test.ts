import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { today } from './today-store.js';
import { createRun, setRunState } from './store.js';
import { enqueue, markQueueEntry, removeQueueEntry } from './queue-store.js';
import { claimTask, finishTask, registerWorker } from './workers.js';
import { openGate } from './gates-store.js';
import { createRecurring } from './recurring-store.js';
import { dbAvailable, testDb, runInput, drain } from '../test/harness.js';
import type { EnqueueItem } from '@asf/shared';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('today'); });
after(async () => { if (db) await db.close(); });

const item = (n: string): EnqueueItem => ({ ticketId: n, ticketKey: n.toUpperCase(), ticketProvider: 'mock', repoId: null, teamName: null, maxCostUsd: null });
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

test('today buckets: queued entries appear under queued', { skip }, async () => {
  await drain(db.sql);
  await db.sql`UPDATE work_queue SET state = 'cancelled'`;
  await enqueue(db.sql, [item('t-q1'), item('t-q2')], 'parallel', 'jon');
  const v = await today(db.sql, midnight());
  assert.deepEqual(v.queued.map((q) => q.ticketKey).sort(), ['T-Q1', 'T-Q2']);
});

test('a run with an open gate is waitingOnYou with reason gate', { skip }, async () => {
  await drain(db.sql);
  const { run } = await createRun(db.sql, runInput({ ticketId: 't-g', ticketKey: 'T-G' }));
  await db.sql.begin(async (tx) => {
    await setRunState(tx, run.id, 'awaiting_checkpoint');
    await openGate(tx, { runId: run.id, gateName: 'after_plan', mode: 'required', afterTask: null, artifact: 'plan.md' });
  });
  const v = await today(db.sql, midnight());
  const w = v.waitingOnYou.find((x) => x.run.id === run.id);
  assert.ok(w, 'run should be waiting on you');
  assert.equal(w!.reason, 'gate');
  assert.equal(w!.gateName, 'after_plan');
  assert.equal(w!.artifact, 'plan.md');
  assert.ok(w!.gateId);
});

test('a run with a needs_human task is waitingOnYou with reason needs_human', { skip }, async () => {
  await drain(db.sql);
  const { run } = await createRun(db.sql, runInput({ ticketId: 't-nh', ticketKey: 'T-NH' }));
  await registerWorker(db.sql, { id: 'w-nh', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const claim = await claimTask(db.sql, 'w-nh', ['claude-code']);
  await finishTask(db.sql, claim!.task.id, { outcome: 'needs_human', outputRef: null, costUsd: 0, reason: 'which db?' });
  const v = await today(db.sql, midnight());
  const w = v.waitingOnYou.find((x) => x.run.id === run.id);
  assert.ok(w, 'run parked on needs_human should be waiting');
  assert.equal(w!.reason, 'needs_human');
});

test('running runs appear under running and not under waiting', { skip }, async () => {
  await drain(db.sql);
  const { run } = await createRun(db.sql, runInput({ ticketId: 't-run', ticketKey: 'T-RUN' }));
  await registerWorker(db.sql, { id: 'w-run', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  await claimTask(db.sql, 'w-run', ['claude-code']); // moves run -> running, task -> running
  const v = await today(db.sql, midnight());
  assert.ok(v.running.some((r) => r.id === run.id), 'should be running');
  assert.ok(!v.waitingOnYou.some((w) => w.run.id === run.id), 'should not be waiting');
});

test('M12: a running row says who is working, since when, and each role\'s latest state', { skip }, async () => {
  await drain(db.sql);
  const { run } = await createRun(db.sql, runInput({ ticketId: 't-crew', ticketKey: 'T-CREW' }));
  await registerWorker(db.sql, { id: 'w-crew', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const claim = await claimTask(db.sql, 'w-crew', ['claude-code']);
  const role = claim!.task.role;
  const v = await today(db.sql, midnight());
  const r = v.running.find((x) => x.id === run.id)!;
  assert.equal(r.activeRole, role);
  assert.ok(r.activeSince && !Number.isNaN(Date.parse(r.activeSince)), 'activeSince is a timestamp');
  assert.equal(r.roleStates[role], 'running');
  const others = Object.entries(r.roleStates).filter(([k]) => k !== role);
  assert.ok(others.length > 0 && others.every(([, s]) => s === 'pending'), JSON.stringify(r.roleStates));

  // a loop-back: an older finished try and a newer pending one; the newest seq wins
  await db.sql`UPDATE run_task SET state = 'done' WHERE id = ${claim!.task.id}`;
  await db.sql`INSERT INTO run_task (id, run_id, role, seq, state) VALUES (${'task_crew_retry'}, ${run.id}, ${role}, 99, 'pending')`;
  const r2 = (await today(db.sql, midnight())).running.find((x) => x.id === run.id)!;
  assert.equal(r2.roleStates[role], 'pending');
  assert.equal(r2.activeRole, null, 'between tasks nobody is active');
  assert.equal(r2.activeSince, null);
});

test('a run finished today appears under doneToday; an old finish does not', { skip }, async () => {
  await drain(db.sql);
  const fresh = await createRun(db.sql, runInput({ ticketId: 't-done', ticketKey: 'T-DONE' }));
  await db.sql.begin(async (tx) => { await setRunState(tx, fresh.run.id, 'succeeded'); });
  const old = await createRun(db.sql, runInput({ ticketId: 't-old', ticketKey: 'T-OLD' }));
  await db.sql`UPDATE agent_run SET state = 'succeeded', finished_at = now() - interval '2 days' WHERE id = ${old.run.id}`;
  const v = await today(db.sql, midnight());
  assert.ok(v.doneToday.some((r) => r.id === fresh.run.id), 'today finish present');
  assert.ok(!v.doneToday.some((r) => r.id === old.run.id), 'old finish excluded');
});

test('comingUp: unpaused recurring tasks due within 24h, soonest first', { skip }, async () => {
  await db.sql`DELETE FROM recurring_task`;
  const now = new Date('2026-10-02T08:00:00Z');
  const sched = (title: string, next: Date, paused = false) => createRecurring(db.sql,
    { title, body: '', repoId: 'repo-1', schedule: { kind: 'daily', time: '09:00' }, timezone: 'UTC', paused }, null, now)
    .then(async (t) => { await db.sql`UPDATE recurring_task SET next_run_at = ${next} WHERE id = ${t.id}`; return t; });
  const h = (n: number) => new Date(now.getTime() + n * 3_600_000);
  const late = await sched('Dead code sweep', h(23));
  const soon = await sched('Update deps', h(1));
  await sched('Too far', h(25));
  await sched('Paused', h(2), true);
  const v = await today(db.sql, midnight(), now);
  assert.deepEqual(v.comingUp, [
    { id: soon.id, title: 'Update deps', nextRunAt: h(1).toISOString(), scheduleText: 'Every day at 9:00 AM' },
    { id: late.id, title: 'Dead code sweep', nextRunAt: h(23).toISOString(), scheduleText: 'Every day at 9:00 AM' },
  ]);
});

test('refused: a refusal in the last 7 days is listed with its reason, unless dismissed, old, or the ticket started since', { skip }, async () => {
  await db.sql`UPDATE work_queue SET state = 'cancelled'`;
  const [shown, dismissed, old, legacy, disp, ranLater, queuedLater] = await enqueue(db.sql,
    ['rx-shown', 'rx-dismissed', 'rx-old', 'rx-legacy', 'rx-disp', 'rx-ran', 'rx-requeued'].map(item), 'parallel', 'jon');
  for (const e of [shown, dismissed, old, legacy, ranLater, queuedLater]) {
    await markQueueEntry(db.sql, e.id, 'failed', null, `refused ${e.ticketId}`, 'over_budget');
  }
  await markQueueEntry(db.sql, disp.id, 'dispatched', null, null);
  await removeQueueEntry(db.sql, dismissed.id, 'jon');
  await db.sql`UPDATE work_queue SET refused_at = now() - interval '8 days' WHERE id = ${old.id}`;
  await db.sql`UPDATE work_queue SET refused_at = NULL WHERE id = ${legacy.id}`; // refused before #138
  await createRun(db.sql, runInput({ ticketId: 'rx-ran', ticketKey: 'RX-RAN' }));
  await enqueue(db.sql, [item('rx-requeued')], 'parallel', 'jon');

  const v = await today(db.sql, midnight());
  assert.deepEqual(v.refused.map((e) => e.ticketId), ['rx-shown']);
  assert.equal(v.refused[0].reason, 'refused rx-shown');
  assert.equal(v.refused[0].reasonCode, 'over_budget');
  assert.ok(v.refused[0].refusedAt);
});
