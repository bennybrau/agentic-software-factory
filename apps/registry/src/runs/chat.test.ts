import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GATES, STANDARD_TEAM } from '@asf/shared';
import { createRun, getRun, getEvents, appendEvent } from './store.js';
import { claimTask, finishTask, registerWorker } from './workers.js';
import { saveArtifact, getOpenGate, listGates } from './gates-store.js';
import { resolveGate } from './gates.js';
import { appendMessage, listMessages, sendChatMessage, requestChanges, ChatError } from './chat.js';
import { dbAvailable, testDb, runInput, drain } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('chat'); });
after(async () => { if (db) await db.close(); });

async function startRun(wid: string, key: string) {
  await registerWorker(db.sql, { id: wid, host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId: key.toLowerCase(), ticketKey: key, gates: DEFAULT_GATES, repoId: null }));
  const planner = await claimTask(db.sql, wid, ['claude-code']);
  assert.equal(planner?.task.role, 'planner');
  return { runId: run.id, plannerTaskId: planner!.task.id };
}

test('planner asks -> person replies in the chat -> planner re-runs (attempt 2, queued_by chat, chat: reason) with the thread', { skip }, async () => {
  await drain(db.sql);
  const { runId, plannerTaskId } = await startRun('c1', 'CH-1');
  await finishTask(db.sql, plannerTaskId, { outcome: 'needs_human', outputRef: null, costUsd: 0.1, reason: '1. Python or Node?' });
  await appendMessage(db.sql, { runId, taskId: plannerTaskId, role: 'planner', author: 'agent', kind: 'question', body: '1. Python or Node?', by: null, sessionId: 'sess-1' });
  assert.equal((await getRun(db.sql, runId))!.run.state, 'awaiting_checkpoint');

  await sendChatMessage(db.sql, runId, 'Node, please.', 'jon');

  const after1 = await getRun(db.sql, runId);
  assert.equal(after1!.run.state, 'running');
  const rerun = await claimTask(db.sql, 'c1', ['claude-code']);
  assert.equal(rerun?.task.role, 'planner');
  assert.equal(rerun?.task.attempt, 2);
  assert.equal(rerun?.task.queuedBy, 'chat');
  assert.match(rerun?.task.reason ?? '', /^chat: Node, please\./);

  const thread = await listMessages(db.sql, runId);
  assert.deepEqual(thread.map((m) => [m.author, m.kind, m.body]), [['agent', 'question', '1. Python or Node?'], ['human', 'message', 'Node, please.']]);
  assert.equal(thread[0].sessionId, 'sess-1', 'the agent turn keeps its session id for the next resume');
  assert.equal(thread[1].by, 'jon');
});

test('replying at the plan gate keeps talking (planner re-runs); approving then lets the team go', { skip }, async () => {
  await drain(db.sql);
  const { runId, plannerTaskId } = await startRun('c2', 'CH-2');
  await saveArtifact(db.sql, runId, 'plan.md', 'PLAN v1');
  await finishTask(db.sql, plannerTaskId, { outcome: 'done', outputRef: 'plan.md', costUsd: 0.1, reason: null });
  const gate = await getOpenGate(db.sql, runId);
  assert.equal(gate?.gateName, 'after_plan');

  await sendChatMessage(db.sql, runId, 'Also handle empty input.', 'jon');
  assert.equal(await getOpenGate(db.sql, runId), null, 'the reply closes the gate');
  const replied = (await listGates(db.sql, runId)).find((g) => g.id === gate!.id)!;
  assert.deepEqual([replied.state, replied.decision, replied.decidedBy], ['rejected', 'reply', 'jon'], 'stored as rejected, read back as a reply');
  const rerun = await claimTask(db.sql, 'c2', ['claude-code']);
  assert.equal(rerun?.task.role, 'planner');
  assert.equal(rerun?.task.queuedBy, 'chat');
  assert.doesNotMatch(rerun?.task.reason ?? '', /^revise:/, 'a chat reply is not a rejection banner');

  // Planner writes v2 -> a fresh gate opens -> approve -> implementer is next.
  await saveArtifact(db.sql, runId, 'plan.md', 'PLAN v2', { taskId: rerun!.task.id });
  await finishTask(db.sql, rerun!.task.id, { outcome: 'done', outputRef: 'plan.md', costUsd: 0.05, reason: null });
  const gate2 = await getOpenGate(db.sql, runId);
  assert.equal(gate2?.artifact, 'PLAN v2');
  await resolveGate(db.sql, gate2!.id, { decision: 'approve', by: 'jon', note: null, editedArtifact: null });
  const impl = await claimTask(db.sql, 'c2', ['claude-code']);
  assert.equal(impl?.task.role, 'implementer');
  assert.deepEqual((await listGates(db.sql, runId)).map((g) => g.decision), ['reply', 'approve']);
});

test('chatting when the planner is not waiting is a ChatError (nothing re-queued)', { skip }, async () => {
  await drain(db.sql);
  const { runId } = await startRun('c3', 'CH-3'); // planner is running
  await assert.rejects(() => sendChatMessage(db.sql, runId, 'hello?', 'jon'), (e: unknown) => e instanceof ChatError);
  await assert.rejects(() => sendChatMessage(db.sql, runId, '   ', 'jon'), (e: unknown) => e instanceof ChatError);
  assert.equal((await listMessages(db.sql, runId)).length, 0);
});

// --- request changes after the MR/PR is open (#157) --------------------------

/** Merge OFF, all gates auto: drive the team + publish to succeeded/awaiting_external_merge with CR #3. */
async function deliverAwaitingMerge(wid: string, key: string) {
  await registerWorker(db.sql, { id: wid, host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const team = { ...STANDARD_TEAM, mergeEnabled: false };
  const { run } = await createRun(db.sql, runInput({ ticketId: key.toLowerCase(), ticketKey: key, repoId: 'repo1', team }));
  await driveRoles(run.id, wid);
  await publishMergeOff(run.id, wid, 'change_request:opened');
  return run.id;
}

async function driveRoles(runId: string, wid: string, roles = ['planner', 'implementer', 'tester', 'reviewer']) {
  for (const role of roles) {
    const c = await claimTask(db.sql, wid, ['claude-code']);
    assert.equal(String(c!.task.role), role);
    if (role === 'reviewer') await saveArtifact(db.sql, runId, 'review.md', 'APPROVE', { taskId: c!.task.id });
    await finishTask(db.sql, c!.task.id, { outcome: 'done', outputRef: c!.task.outputRef, costUsd: 0, reason: null });
  }
}

/** What the worker does on the merge-OFF path: push_open (opened, or updated when the PR exists), then mark_ready. */
async function publishMergeOff(runId: string, wid: string, pushedKind: 'change_request:opened' | 'change_request:updated') {
  const push = await claimTask(db.sql, wid, ['claude-code']);
  assert.equal(String(push!.task.role), 'publish:push_open');
  await appendEvent(db.sql, { runId, taskId: push!.task.id, kind: pushedKind, source: 'worker', payload: { number: 3, url: 'https://github.com/o/r/pull/3' } });
  await finishTask(db.sql, push!.task.id, { outcome: 'done', outputRef: null, costUsd: 0, reason: null });
  const ready = await claimTask(db.sql, wid, ['claude-code']);
  assert.equal(String(ready!.task.role), 'publish:mark_ready');
  await appendEvent(db.sql, { runId, taskId: ready!.task.id, kind: 'change_request:ready', source: 'worker', payload: { number: 3 } });
  await finishTask(db.sql, ready!.task.id, { outcome: 'done', outputRef: null, costUsd: 0, reason: null });
}

test('request changes on a PR ready for review: same run re-plans (forced plan gate), re-runs, pushes onto the same PR', { skip }, async () => {
  await drain(db.sql);
  const runId = await deliverAwaitingMerge('rc1', 'RC-1');
  const done = (await getRun(db.sql, runId))!.run;
  assert.equal(done.deliveryOutcome, 'awaiting_external_merge');
  await db.sql`UPDATE agent_run SET review_iterations = 2 WHERE id = ${runId}`;

  await requestChanges(db.sql, runId, 'Rename the flag to --dry.', 'jon');

  const reopened = (await getRun(db.sql, runId))!;
  assert.equal(reopened.run.state, 'running');
  assert.equal(reopened.run.finishedAt, null);
  assert.equal(reopened.run.deliveryOutcome, null);
  assert.equal(reopened.run.reviewIterations, 0);
  assert.equal(reopened.run.changeRequestUrl, 'https://github.com/o/r/pull/3', 'the same PR stays on the run');
  assert.ok(reopened.tasks.filter((t) => t.runtime === 'publish').every((t) => t.state === 'skipped'), 'publish runs again after the revision');
  const thread = await listMessages(db.sql, runId);
  assert.deepEqual(thread.map((m) => [m.author, m.body, m.by]), [['human', 'Rename the flag to --dry.', 'jon']]);
  const events = await getEvents(db.sql, runId, 0, 1000);
  assert.ok(events.some((e) => e.kind === 'change_request:feedback' && e.payload.text === 'Rename the flag to --dry.'));

  const planner = await claimTask(db.sql, 'rc1', ['claude-code']);
  assert.equal(planner?.task.role, 'planner');
  assert.equal(planner?.task.attempt, 2);
  assert.equal(planner?.task.queuedBy, 'pr_feedback');
  assert.match(planner?.task.reason ?? '', /^chat: Rename the flag/);

  // The gates are all auto, but with a PR open the plan gate is forced to required.
  await saveArtifact(db.sql, runId, 'plan.md', 'PLAN v2', { taskId: planner!.task.id });
  await finishTask(db.sql, planner!.task.id, { outcome: 'done', outputRef: 'plan.md', costUsd: 0, reason: null });
  const gate = await getOpenGate(db.sql, runId);
  assert.equal(gate?.gateName, 'after_plan');
  assert.equal(gate?.mode, 'required');
  assert.equal((await getRun(db.sql, runId))!.run.state, 'awaiting_checkpoint');
  await resolveGate(db.sql, gate!.id, { decision: 'approve', by: 'jon', note: null, editedArtifact: null });

  await driveRoles(runId, 'rc1', ['implementer', 'tester', 'reviewer']);
  await publishMergeOff(runId, 'rc1', 'change_request:updated');

  const after2 = (await getRun(db.sql, runId))!.run;
  assert.equal(after2.state, 'succeeded');
  assert.equal(after2.deliveryOutcome, 'awaiting_external_merge');
  assert.equal(after2.changeRequestNumber, 3);
  const opened = (await getEvents(db.sql, runId, 0, 1000)).filter((e) => e.kind === 'change_request:opened');
  assert.equal(opened.length, 1, 'no second PR');
});

test('request changes at the before_merge gate rejects it and re-plans; the merge gate reopens after the revision', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'rc2', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const gates = { ...DEFAULT_GATES, after_plan: { mode: 'auto' as const }, before_change_request: { mode: 'auto' as const } };
  const { run } = await createRun(db.sql, runInput({ ticketId: 'rc-2', ticketKey: 'RC-2', repoId: 'repo1', gates }));
  await driveRoles(run.id, 'rc2');
  const push = await claimTask(db.sql, 'rc2', ['claude-code']);
  await appendEvent(db.sql, { runId: run.id, taskId: push!.task.id, kind: 'change_request:opened', source: 'worker', payload: { number: 9, url: 'https://github.com/o/r/pull/9' } });
  await finishTask(db.sql, push!.task.id, { outcome: 'done', outputRef: null, costUsd: 0, reason: null });
  const mergeGate = await getOpenGate(db.sql, run.id);
  assert.equal(mergeGate?.gateName, 'before_merge');

  await requestChanges(db.sql, run.id, 'Split the migration out.', 'jon');

  assert.equal(await getOpenGate(db.sql, run.id), null);
  const gatesNow = await db.sql`SELECT state, note FROM run_gate WHERE id = ${mergeGate!.id}`;
  assert.equal(gatesNow[0].state, 'rejected');
  assert.equal(gatesNow[0].note, 'Split the migration out.');
  const planner = await claimTask(db.sql, 'rc2', ['claude-code']);
  assert.equal(planner?.task.role, 'planner');
  assert.equal(planner?.task.queuedBy, 'pr_feedback');
  await finishTask(db.sql, planner!.task.id, { outcome: 'done', outputRef: 'plan.md', costUsd: 0, reason: null });
  const planGate = await getOpenGate(db.sql, run.id);
  assert.equal(planGate?.gateName, 'after_plan', 'forced even though after_plan is auto');
  await resolveGate(db.sql, planGate!.id, { decision: 'approve', by: 'jon', note: null, editedArtifact: null });
  await driveRoles(run.id, 'rc2', ['implementer', 'tester', 'reviewer']);
  const push2 = await claimTask(db.sql, 'rc2', ['claude-code']);
  assert.equal(String(push2!.task.role), 'publish:push_open');
  await finishTask(db.sql, push2!.task.id, { outcome: 'done', outputRef: null, costUsd: 0, reason: null });
  assert.equal((await getOpenGate(db.sql, run.id))?.gateName, 'before_merge', 'a fresh merge decision');
});

test('request changes is refused with a reason when there is no live PR to change or the run is busy', { skip }, async () => {
  await drain(db.sql);
  const refused = async (runId: string, re: RegExp, body = 'please change it') =>
    assert.rejects(() => requestChanges(db.sql, runId, body, 'jon'), (e: unknown) => e instanceof ChatError && re.test((e as Error).message));

  // Running, no PR yet.
  const { runId: running } = await startRun('rc3', 'RC-3');
  await refused(running, /no pull request/);
  // Running with a PR (e.g. mid-revision): not while the team is working.
  await appendEvent(db.sql, { runId: running, taskId: null, kind: 'change_request:opened', source: 'worker', payload: { number: 1, url: 'https://x/pull/1' } });
  await refused(running, /the run is running/);
  await drain(db.sql);

  // Merged / closed PRs.
  const merged = await deliverAwaitingMerge('rc4', 'RC-4');
  await refused(merged, /feedback is empty/, '   ');
  await appendEvent(db.sql, { runId: merged, taskId: null, kind: 'change_request:merged', source: 'connector', payload: {} });
  await refused(merged, /already merged/);
  const closed = await deliverAwaitingMerge('rc5', 'RC-5');
  await appendEvent(db.sql, { runId: closed, taskId: null, kind: 'change_request:closed', source: 'connector', payload: {} });
  await refused(closed, /was closed/);

  // Another run for the same ticket is live: reopening would make two.
  const ready = await deliverAwaitingMerge('rc6', 'RC-6');
  await createRun(db.sql, runInput({ ticketId: 'rc-6', ticketKey: 'RC-6', repoId: 'repo1' }));
  await refused(ready, /another run for RC-6 is live/);
  assert.equal((await getRun(db.sql, ready))!.run.state, 'succeeded', 'a refusal changes nothing');
  assert.equal((await listMessages(db.sql, ready)).length, 0);
});
