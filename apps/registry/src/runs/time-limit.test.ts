import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_TEAM, teamTemplateSchema } from '@asf/shared';
import { createRun, getRun, requestCancel } from './store.js';
import { claimTask, finishTask, registerWorker, monthUnpricedRuns } from './workers.js';
import { putOrgSetting, deleteOrgSetting } from '../settings/store.js';
import { enforceTimeLimit } from './time-limit.js';
import { dbAvailable, testDb, runInput, drain } from '../test/harness.js';

// M11 WP6: RUN_MAX_MINUTES cancels a run whose agents worked too long; a person's
// waiting time doesn't count. And Ollama tasks are free, not "unpriced".

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('time_limit'); });
after(async () => { if (db) await db.close(); });

async function startPlanner(ticket: string) {
  await registerWorker(db.sql, { id: 'w', host: 'h', runtimes: ['claude-code'], maxConcurrent: 4, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId: ticket, ticketKey: ticket.toUpperCase() }));
  const c = await claimTask(db.sql, 'w', ['claude-code']);
  assert.equal(c?.run.id, run.id);
  return { runId: run.id, taskId: c!.task.id };
}
/** Pretend the task started `min` minutes ago. */
const aged = (taskId: string, min: number) => db.sql`UPDATE run_task SET started_at = now() - make_interval(mins => ${min}) WHERE id = ${taskId}`;

test('off by default: a long-running run is left alone', { skip }, async () => {
  await drain(db.sql);
  await deleteOrgSetting(db.sql, 'RUN_MAX_MINUTES');
  const { runId, taskId } = await startPlanner('tl1');
  await aged(taskId, 600);
  assert.deepEqual(await enforceTimeLimit(db.sql), []);
  assert.equal((await getRun(db.sql, runId))!.run.cancelRequestedAt, null);
});

test('under the limit: nothing happens; over it with a task running: cancel requested, then settled with the reason', { skip }, async () => {
  await drain(db.sql);
  await putOrgSetting(db.sql, 'RUN_MAX_MINUTES', 180, 'test');
  const { runId, taskId } = await startPlanner('tl2');
  await aged(taskId, 120);
  assert.deepEqual(await enforceTimeLimit(db.sql), []);
  await aged(taskId, 200);
  assert.deepEqual(await enforceTimeLimit(db.sql), [runId]);
  let r = (await getRun(db.sql, runId))!;
  assert.ok(r.run.cancelRequestedAt, 'the worker sees the cancel flag');
  assert.notEqual(r.run.state, 'cancelled', 'still running until the worker stops the task');
  assert.deepEqual(await enforceTimeLimit(db.sql), [], 'trips once');
  // The worker stops the agent and reports the task; the orchestrator settles the run.
  await finishTask(db.sql, taskId, { outcome: 'failed', outputRef: null, costUsd: 0, reason: 'run cancelled by the operator' });
  r = (await getRun(db.sql, runId))!;
  assert.equal(r.run.state, 'cancelled');
  const plannerTask = r.tasks.find(t => t.id === taskId);
  assert.ok(plannerTask);
  assert.equal(plannerTask!.reason, 'cancelled: run time limit');
  assert.match(r.run.reason ?? '', /^time limit reached: its agents worked 200 min, over the 180 min limit/);
  const n = await db.sql`SELECT title FROM notification WHERE run_id = ${runId}`;
  assert.ok(n.some((x) => /time limit/.test(String(x.title))));
});

// New test: over the limit with a task running: a second sweep before the task finishes changes nothing
test('over the limit with a task running: a second sweep before the task finishes changes nothing', { skip }, async () => {
  await drain(db.sql);
  await putOrgSetting(db.sql, 'RUN_MAX_MINUTES', 180, 'test');
  const { runId, taskId } = await startPlanner('tl5');

  // First enforcement should trip the limit.
  await aged(taskId, 200);
  assert.deepEqual(await enforceTimeLimit(db.sql), [runId]);

  // Snapshot reason, cancelRequestedAt, event and notification counts.
  const [{ reason: preReason, cancelRequestedAt: preCancel }] = await db.sql`SELECT reason, cancel_requested_at FROM agent_run WHERE id = ${runId}`;
  const [{ n: preEventCount }] = await db.sql`SELECT count(*)::int AS n FROM run_events WHERE run_id = ${runId} AND kind = 'run:time_limit'`;
  const [{ n: preNotifCount }] = await db.sql`SELECT count(*)::int AS n FROM notification WHERE run_id = ${runId}`;

  // Age further; if re‑evaluated it would change reason text.
  await aged(taskId, 260);

  // Second enforcement should not change anything.
  assert.deepEqual(await enforceTimeLimit(db.sql), [], 'second sweep does nothing');

  // Re‑read values.
  const [{ reason: postReason, cancelRequestedAt: postCancel }] = await db.sql`SELECT reason, cancel_requested_at FROM agent_run WHERE id = ${runId}`;
  const [{ n: postEventCount }] = await db.sql`SELECT count(*)::int AS n FROM run_events WHERE run_id = ${runId} AND kind = 'run:time_limit'`;
  const [{ n: postNotifCount }] = await db.sql`SELECT count(*)::int AS n FROM notification WHERE run_id = ${runId}`;
  const [{ state }] = await db.sql`SELECT state FROM agent_run WHERE id = ${runId}`;

  // Verify unchanged.
  assert.equal(postReason, preReason);
  assert.deepEqual(postCancel, preCancel);
  assert.equal(postEventCount, preEventCount);
  assert.equal(postNotifCount, preNotifCount);
  assert.notEqual(state, 'cancelled');

  await deleteOrgSetting(db.sql, 'RUN_MAX_MINUTES');
});

test('waiting at a gate does not count; a run already over the limit there settles at once', { skip }, async () => {
  await drain(db.sql);
  await putOrgSetting(db.sql, 'RUN_MAX_MINUTES', 60, 'test');
  const { runId, taskId } = await startPlanner('tl3');
  await finishTask(db.sql, taskId, { outcome: 'done', outputRef: 'plan.md', costUsd: 0.1, reason: null });
  // 30 min of planning, then a long wait for a person: under the limit.
  await db.sql`UPDATE run_task SET started_at = now() - interval '10 hours', finished_at = now() - interval '570 minutes' WHERE id = ${taskId}`;
  assert.deepEqual(await enforceTimeLimit(db.sql), []);
  // 90 min of planning: over, with nothing running -> cancelled now.
  await db.sql`UPDATE run_task SET finished_at = now() - interval '510 minutes' WHERE id = ${taskId}`;
  assert.deepEqual(await enforceTimeLimit(db.sql), [runId]);
  const r = (await getRun(db.sql, runId))!;
  assert.equal(r.run.state, 'cancelled');
  assert.match(r.run.reason ?? '', /time limit reached: its agents worked 90 min, over the 60 min limit/);
  assert.ok(r.tasks.filter((t) => t.state === 'pending').length === 0, 'the rest of the team is skipped');
  await deleteOrgSetting(db.sql, 'RUN_MAX_MINUTES');
});


test('operator cancel request leaves task reason unchanged', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'w3', host: 'h', runtimes: ['claude-code'], maxConcurrent: 4, inFlightTaskIds: [] });
  const { runId, taskId } = await startPlanner('tl4');
  // Request cancellation while task is running.
  await requestCancel(db.sql, runId, null);
  // Worker reports operator cancellation.
  await finishTask(db.sql, taskId, { outcome: 'failed', outputRef: null, costUsd: 0, reason: 'run cancelled by the operator' });
  const r = (await getRun(db.sql, runId))!;
  assert.equal(r.run.state, 'cancelled');
  assert.equal(r.run.reason, 'cancelled by operator');
  const task = r.tasks.find(t => t.id === taskId);
  assert.ok(task);
  assert.equal(task!.reason, 'run cancelled by the operator');
});

test('a $0 task on an Ollama model is free, not unpriced', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'w2', host: 'h', runtimes: ['claude-code'], maxConcurrent: 4, inFlightTaskIds: [] });
  const base = await monthUnpricedRuns(db.sql);
  const team = (model: string) => teamTemplateSchema.parse({ ...STANDARD_TEAM, roles: STANDARD_TEAM.roles.map((r) => (r.role === 'planner' ? { ...r, model } : r)) });
  await createRun(db.sql, runInput({ ticketId: 'fr1', ticketKey: 'FR-1', team: team('ollama-cloud:gpt-oss:120b') }));
  const a = await claimTask(db.sql, 'w2', ['claude-code']);
  await finishTask(db.sql, a!.task.id, { outcome: 'done', outputRef: 'plan.md', costUsd: 0, reason: null });
  assert.equal(await monthUnpricedRuns(db.sql), base, 'the Ollama planner at $0 is free');
  await drain(db.sql);
  await createRun(db.sql, runInput({ ticketId: 'fr2', ticketKey: 'FR-2' }));
  const b = await claimTask(db.sql, 'w2', ['claude-code']);
  await finishTask(db.sql, b!.task.id, { outcome: 'done', outputRef: 'plan.md', costUsd: 0, reason: null });
  assert.equal(await monthUnpricedRuns(db.sql), base + 1, 'a Claude task at $0 is still unpriced');
});
