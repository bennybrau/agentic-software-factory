import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CreateRecurringTaskInput } from '@asf/shared';
import {
  createRecurring, getRecurring, listRecurring, updateRecurring, setRecurringPaused, deleteRecurring,
  upcomingRecurring, fireDueRecurring,
} from './recurring-store.js';
import { getAdhoc } from './adhoc-store.js';
import { NotFoundError } from './store.js';
import { dbAvailable, testDb, ownTestDb, heardQueueChanges } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('recurring'); });
after(async () => { if (db) await db.close(); });
beforeEach(async () => {
  if (skip) return;
  await db.sql`DELETE FROM recurring_task`;
  await db.sql`DELETE FROM work_queue`;
  await db.sql`DELETE FROM agent_run`;
  await db.sql`DELETE FROM adhoc_task`;
});

const at = (s: string) => new Date(s);
const quiet = { error: () => {} };

function input(over: Partial<CreateRecurringTaskInput> = {}): CreateRecurringTaskInput {
  return { title: 'Dependency bump', body: 'Bump everything.', repoId: 'repo-1',
    schedule: { kind: 'daily', time: '09:00' }, timezone: 'UTC', paused: false, ...over };
}

async function setNext(id: string, iso: string) {
  await db.sql`UPDATE recurring_task SET next_run_at = ${at(iso)} WHERE id = ${id}`;
}
const createdBy = (id: string) => db.sql`SELECT * FROM adhoc_task WHERE recurring_id = ${id} ORDER BY created_at`;
async function addRun(ticketId: string, state: string) {
  await db.sql`INSERT INTO agent_run (id, ticket_id, ticket_key, ticket_provider, state, team_name, team, gates, max_cost_usd)
    VALUES (${`run_${ticketId.slice(6)}`}, ${ticketId}, 'K', 'adhoc', ${state}, 't', '{}'::jsonb, '{}'::jsonb, 10)`;
}

test('create computes next_run_at, list/get/upcoming read it back', { skip }, async () => {
  const t = await createRecurring(db.sql, input(), 'ana', at('2026-10-02T08:00:00Z'));
  assert.match(t.id, /^rec_/);
  assert.equal(t.nextRunAt, '2026-10-02T09:00:00.000Z');
  assert.equal(t.createdBy, 'ana');
  assert.equal(t.lastRun, null);
  assert.deepEqual(t.schedule, { kind: 'daily', time: '09:00' });
  assert.deepEqual(await getRecurring(db.sql, t.id), t);
  assert.deepEqual((await listRecurring(db.sql)).map((x) => x.id), [t.id]);
  assert.equal(await getRecurring(db.sql, 'rec_missing'), null);

  assert.deepEqual((await upcomingRecurring(db.sql, 2, at('2026-10-02T08:00:00Z'))).map((x) => x.id), [t.id]);
  assert.deepEqual(await upcomingRecurring(db.sql, 0.5, at('2026-10-02T08:00:00Z')), []);
});

test('a due task fires once: an ad-hoc task copy, queued in parallel, next_run_at advanced', { skip }, async () => {
  const t = await createRecurring(db.sql, input(), 'ana', at('2026-10-02T08:00:00Z'));
  const r = await fireDueRecurring(db.sql, at('2026-10-02T09:05:00Z'), quiet);
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0].slotAt, '2026-10-02T09:00:00.000Z');

  const [task] = await createdBy(t.id);
  assert.equal(task.title, 'Dependency bump');
  assert.equal(task.body, 'Bump everything.');
  assert.equal(task.createdBy, 'schedule');
  assert.equal((await getAdhoc(db.sql, String(task.id)))!.recurringId, t.id);

  const q = await db.sql`SELECT * FROM work_queue WHERE ticket_id = ${task.id}`;
  assert.equal(q.length, 1);
  assert.equal(q[0].state, 'queued');
  assert.equal(q[0].mode, 'parallel');
  assert.equal(q[0].ticketProvider, 'adhoc');
  assert.equal(q[0].ticketKey, task.key);
  assert.equal(q[0].repoId, 'repo-1');
  assert.equal(q[0].addedBy, 'schedule:Dependency bump');

  const after = (await getRecurring(db.sql, t.id))!;
  assert.equal(after.nextRunAt, '2026-10-03T09:00:00.000Z');
  assert.deepEqual({ ...after.lastRun, at: undefined },
    { adhocId: String(task.id), key: String(task.key), runId: null, state: null, deliveryOutcome: null, skipped: false, at: undefined });

  const again = await fireDueRecurring(db.sql, at('2026-10-02T09:10:00Z'), quiet);
  assert.deepEqual(again, { fired: [], skipped: [] });
  assert.equal((await createdBy(t.id)).length, 1);
});

test('two concurrent tickers with the same now create exactly one ad-hoc task', { skip }, async () => {
  const t = await createRecurring(db.sql, input(), null, at('2026-10-02T08:00:00Z'));
  const now = at('2026-10-02T09:01:00Z');
  const [a, b] = await Promise.all([fireDueRecurring(db.sql, now, quiet), fireDueRecurring(db.sql, now, quiet)]);
  assert.equal(a.fired.length + b.fired.length, 1);
  assert.equal((await createdBy(t.id)).length, 1);
});

test('a restart (next_run_at reset to before the slot) lands on the same slot and creates no duplicate', { skip }, async () => {
  const t = await createRecurring(db.sql, input(), null, at('2026-10-02T08:00:00Z'));
  await fireDueRecurring(db.sql, at('2026-10-02T09:05:00Z'), quiet);
  await setNext(t.id, '2026-10-02T09:00:00Z');
  const r = await fireDueRecurring(db.sql, at('2026-10-02T09:30:00Z'), quiet);
  assert.deepEqual(r, { fired: [], skipped: [] });
  assert.equal((await createdBy(t.id)).length, 1);
  assert.equal((await getRecurring(db.sql, t.id))!.nextRunAt, '2026-10-03T09:00:00.000Z');
});

test('skips while the previous task is queued, running or at a gate, and fires once it has ended', { skip }, async () => {
  const t = await createRecurring(db.sql, input(), null, at('2026-10-01T08:00:00Z'));
  await fireDueRecurring(db.sql, at('2026-10-01T09:05:00Z'), quiet);
  const [first] = await createdBy(t.id);
  const firstId = String(first.id);

  // Day 2: still queued.
  let r = await fireDueRecurring(db.sql, at('2026-10-02T09:05:00Z'), quiet);
  assert.equal(r.fired.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].adhocId, firstId);
  assert.match(r.skipped[0].reason, /still queued/);
  const skippedRun = (await getRecurring(db.sql, t.id))!.lastRun!;
  assert.equal(skippedRun.skipped, true);
  assert.equal(skippedRun.adhocId, firstId);

  // Day 3: dispatched, running.
  await db.sql`UPDATE work_queue SET state = 'dispatched' WHERE ticket_id = ${firstId}`;
  await addRun(firstId, 'running');
  r = await fireDueRecurring(db.sql, at('2026-10-03T09:05:00Z'), quiet);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /still running/);

  // Day 4: at a gate.
  await db.sql`UPDATE agent_run SET state = 'awaiting_checkpoint' WHERE ticket_id = ${firstId}`;
  r = await fireDueRecurring(db.sql, at('2026-10-04T09:05:00Z'), quiet);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /gate/);
  assert.equal((await createdBy(t.id)).length, 1);

  // Day 5: finished, so it fires again. lastRun follows the newest task.
  await db.sql`UPDATE agent_run SET state = 'succeeded' WHERE ticket_id = ${firstId}`;
  r = await fireDueRecurring(db.sql, at('2026-10-05T09:05:00Z'), quiet);
  assert.equal(r.fired.length, 1);
  assert.equal((await createdBy(t.id)).length, 2);
  const last = (await getRecurring(db.sql, t.id))!.lastRun!;
  assert.equal(last.adhocId, r.fired[0].adhocId);
  assert.equal(last.skipped, false);
});

test('lastRun carries the latest run of the fired task', { skip }, async () => {
  const t = await createRecurring(db.sql, input(), null, at('2026-10-02T08:00:00Z'));
  const r = await fireDueRecurring(db.sql, at('2026-10-02T09:05:00Z'), quiet);
  await addRun(r.fired[0].adhocId, 'succeeded');
  await db.sql`UPDATE agent_run SET delivery_outcome = 'merged'`;
  const last = (await getRecurring(db.sql, t.id))!.lastRun!;
  assert.equal(last.runId, `run_${r.fired[0].adhocId.slice(6)}`);
  assert.equal(last.state, 'succeeded');
  assert.equal(last.deliveryOutcome, 'merged');
});

test('down 3 days (daily 09:00, now 08:00 today): nothing fires, next_run_at is today 09:00', { skip }, async () => {
  const t = await createRecurring(db.sql, input(), null, at('2026-09-28T08:00:00Z'));
  await setNext(t.id, '2026-09-29T09:00:00Z');
  const r = await fireDueRecurring(db.sql, at('2026-10-02T08:00:00Z'), quiet);
  assert.deepEqual(r, { fired: [], skipped: [] });
  assert.equal((await createdBy(t.id)).length, 0);
  const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM recurring_occurrence WHERE recurring_id = ${t.id}`;
  assert.equal(n, 0);
  assert.equal((await getRecurring(db.sql, t.id))!.nextRunAt, '2026-10-02T09:00:00.000Z');
});

test('missed yesterday and today: fires exactly once, for today\'s slot', { skip }, async () => {
  const t = await createRecurring(db.sql, input(), null, at('2026-09-30T10:00:00Z'));
  await setNext(t.id, '2026-10-01T09:00:00Z');
  const r = await fireDueRecurring(db.sql, at('2026-10-02T10:00:00Z'), quiet);
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0].slotAt, '2026-10-02T09:00:00.000Z');
  assert.equal((await getRecurring(db.sql, t.id))!.nextRunAt, '2026-10-03T09:00:00.000Z');
  await fireDueRecurring(db.sql, at('2026-10-02T11:00:00Z'), quiet);
  assert.equal((await createdBy(t.id)).length, 1);
});

test('local dates follow the task\'s zone', { skip }, async () => {
  // 23:30 in Los Angeles on Oct 1 is 06:30Z on Oct 2: still Oct 1 locally, so it fires.
  const t = await createRecurring(db.sql, input({ schedule: { kind: 'daily', time: '23:30' }, timezone: 'America/Los_Angeles' }),
    null, at('2026-10-02T06:00:00Z'));
  assert.equal(t.nextRunAt, '2026-10-02T06:30:00.000Z');
  const r = await fireDueRecurring(db.sql, at('2026-10-02T06:45:00Z'), quiet);
  assert.equal(r.fired.length, 1);
});

test('paused tasks never fire and are not upcoming; resume recomputes next_run_at from now', { skip }, async () => {
  const t = await createRecurring(db.sql, input({ paused: true }), null, at('2026-10-01T08:00:00Z'));
  const r = await fireDueRecurring(db.sql, at('2026-10-03T09:05:00Z'), quiet);
  assert.deepEqual(r, { fired: [], skipped: [] });
  assert.equal((await createdBy(t.id)).length, 0);
  assert.deepEqual(await upcomingRecurring(db.sql, 24 * 7, at('2026-10-01T08:00:00Z')), []);

  const resumed = await setRecurringPaused(db.sql, t.id, false, at('2026-10-03T09:05:00Z'));
  assert.equal(resumed.paused, false);
  assert.equal(resumed.nextRunAt, '2026-10-04T09:00:00.000Z');
});

test('editing leaves fired tasks unchanged and recomputes next_run_at only when the timing changes', { skip }, async () => {
  const t = await createRecurring(db.sql, input(), null, at('2026-10-02T08:00:00Z'));
  await fireDueRecurring(db.sql, at('2026-10-02T09:05:00Z'), quiet);

  const renamed = await updateRecurring(db.sql, t.id, { title: 'Renamed', body: 'New body' }, at('2026-10-02T12:00:00Z'));
  assert.equal(renamed.title, 'Renamed');
  assert.equal(renamed.nextRunAt, '2026-10-03T09:00:00.000Z', 'unchanged timing keeps next_run_at');
  const [task] = await createdBy(t.id);
  assert.equal(task.title, 'Dependency bump');
  assert.equal(task.body, 'Bump everything.');

  const moved = await updateRecurring(db.sql, t.id, { schedule: { kind: 'daily', time: '14:00' } }, at('2026-10-02T12:00:00Z'));
  assert.equal(moved.nextRunAt, '2026-10-02T14:00:00.000Z');
  const zoned = await updateRecurring(db.sql, t.id, { timezone: 'Europe/Berlin' }, at('2026-10-02T12:00:00Z'));
  assert.equal(zoned.nextRunAt, '2026-10-03T12:00:00.000Z');

  await assert.rejects(updateRecurring(db.sql, 'rec_missing', { title: 'x' }), NotFoundError);
  await assert.rejects(setRecurringPaused(db.sql, 'rec_missing', true), NotFoundError);
});

test('delete cascades occurrences but keeps the ad-hoc tasks', { skip }, async () => {
  const t = await createRecurring(db.sql, input(), null, at('2026-10-02T08:00:00Z'));
  await fireDueRecurring(db.sql, at('2026-10-02T09:05:00Z'), quiet);
  assert.equal(await deleteRecurring(db.sql, t.id), true);
  assert.equal(await deleteRecurring(db.sql, t.id), false);
  const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM recurring_occurrence WHERE recurring_id = ${t.id}`;
  assert.equal(n, 0);
  assert.equal((await createdBy(t.id)).length, 1);
});

test('one bad row is logged and the others still fire', { skip }, async () => {
  const bad = await createRecurring(db.sql, input({ title: 'Bad' }), null, at('2026-10-02T07:00:00Z'));
  const good = await createRecurring(db.sql, input({ title: 'Good' }), null, at('2026-10-02T08:00:00Z'));
  await db.sql`UPDATE recurring_task SET schedule = '{"kind":"hourly"}'::jsonb WHERE id = ${bad.id}`;
  const errors: unknown[] = [];
  const r = await fireDueRecurring(db.sql, at('2026-10-02T09:05:00Z'), { error: (o) => errors.push(o) });
  assert.equal(errors.length, 1);
  assert.deepEqual(r.fired.map((f) => f.recurringId), [good.id]);
});

test('a fire NOTIFYs work_queue for the entry it queues', { skip }, async () => {
  // Its own database, not a schema: NOTIFY crosses schemas and queue ids are serials (see testDatabase).
  const own = await ownTestDb('recurring_n');
  const q = await heardQueueChanges(own.sql);
  try {
    await createRecurring(own.sql, input(), 'ana', at('2026-10-02T08:00:00Z'));
    assert.equal((await fireDueRecurring(own.sql, at('2026-10-02T09:05:00Z'), quiet)).fired.length, 1);
    const [entry] = await own.sql`SELECT id FROM work_queue`;
    await q.waitFor(`${String(entry.id)}:queued`);
  } finally {
    await q.unlisten();
    await own.close();
  }
});
