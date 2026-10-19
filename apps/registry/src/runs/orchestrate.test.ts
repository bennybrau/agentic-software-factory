import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_TEAM, DEFAULT_GATES } from '@asf/shared';
import { createRun, getRun, getEvents } from './store.js';
import { claimTask, finishTask, registerWorker } from './workers.js';
import { resolveGate } from './gates.js';
import { getOpenGate, saveArtifact } from './gates-store.js';
import { dbAvailable, testDb, runInput, drain } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('orch'); });
after(async () => { if (db) await db.close(); });

async function drive(runId: string, wid: string) {
  const c = await claimTask(db.sql, wid, ['claude-code']);
  return c;
}

test('a required after_plan gate parks the run; approval resumes it to the implementer', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'g1', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId: 'g-plan', ticketKey: 'G-1', gates: DEFAULT_GATES, repoId: null }));

  const planner = await drive(run.id, 'g1');
  assert.equal(planner?.task.role, 'planner');
  await saveArtifact(db.sql, run.id, 'plan.md', 'THE PLAN');
  await finishTask(db.sql, planner!.task.id, { outcome: 'done', outputRef: 'plan.md', costUsd: 0.1, reason: null });

  // Parked at the gate; the implementer is NOT claimable yet.
  const parked = await getRun(db.sql, run.id);
  assert.equal(parked!.run.state, 'awaiting_checkpoint');
  assert.equal(await claimTask(db.sql, 'g1', ['claude-code']), null);
  const gate = await getOpenGate(db.sql, run.id);
  assert.equal(gate?.gateName, 'after_plan');
  assert.equal(gate?.artifact, 'THE PLAN');

  // Approve -> run resumes, implementer claimable.
  await resolveGate(db.sql, gate!.id, { decision: 'approve', by: 'jon', note: null, editedArtifact: null });
  assert.equal((await getRun(db.sql, run.id))!.run.state, 'running');
  const impl = await claimTask(db.sql, 'g1', ['claude-code']);
  assert.equal(impl?.task.role, 'implementer');
});

test('editing the plan on approval replaces the stored artifact', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'g2', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId: 'g-edit', ticketKey: 'G-2', gates: DEFAULT_GATES, repoId: null }));
  const planner = await claimTask(db.sql, 'g2', ['claude-code']);
  await saveArtifact(db.sql, run.id, 'plan.md', 'ORIGINAL');
  await finishTask(db.sql, planner!.task.id, { outcome: 'done', outputRef: 'plan.md', costUsd: 0, reason: null });
  const gate = await getOpenGate(db.sql, run.id);
  await resolveGate(db.sql, gate!.id, { decision: 'approve', by: 'jon', note: null, editedArtifact: 'EDITED BY HUMAN' });
  const { getArtifact } = await import('./gates-store.js');
  assert.equal(await getArtifact(db.sql, run.id, 'plan.md'), 'EDITED BY HUMAN');
});

test('rejecting a gate re-queues the producing role with the note', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'g3', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId: 'g-rej', ticketKey: 'G-3', gates: DEFAULT_GATES, repoId: null }));
  const planner = await claimTask(db.sql, 'g3', ['claude-code']);
  await saveArtifact(db.sql, run.id, 'plan.md', 'v1');
  await finishTask(db.sql, planner!.task.id, { outcome: 'done', outputRef: 'plan.md', costUsd: 0, reason: null });
  const gate = await getOpenGate(db.sql, run.id);
  await resolveGate(db.sql, gate!.id, { decision: 'reject', by: 'jon', note: 'add error handling', editedArtifact: null });
  // planner is re-queued (a new pending planner task), run running again.
  const again = await claimTask(db.sql, 'g3', ['claude-code']);
  assert.equal(again?.task.role, 'planner');
  assert.equal(again?.task.attempt, 2);
  assert.match(again!.task.reason ?? '', /add error handling/);
});

test('repeat detection: the same blocker twice parks at needs_human before the bound is spent (M11 WP4)', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'grep', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  // maxIterations 3 so the bound is NOT what stops it — the repeat detector is.
  const team = { ...STANDARD_TEAM, loop: { onReviewFail: 'implementer' as const, maxIterations: 3 } };
  const { run } = await createRun(db.sql, runInput({ ticketId: 'g-rep', ticketKey: 'G-REP', repoId: null, team }));
  const finishRole = async (reviewText?: string) => {
    const c = await claimTask(db.sql, 'grep', ['claude-code']);
    if (!c) return null;
    if (String(c.task.role) === 'reviewer' && reviewText) await saveArtifact(db.sql, run.id, 'review.md', reviewText, { taskId: c.task.id });
    await finishTask(db.sql, c.task.id, { outcome: 'done', outputRef: c.task.outputRef, costUsd: 0.01, reason: null });
    return c;
  };
  const blocker = 'REQUEST_CHANGES\n- must fix: the header names AGENT_AUTH_MODE but the plan says AUTH_MODE';

  // Cycle 1: planner→implementer→tester→reviewer, REQUEST_CHANGES → loop 1 (first time, no prior to compare).
  await finishRole(); await finishRole(); await finishRole(); await finishRole(blocker);
  let cur = await getRun(db.sql, run.id);
  assert.equal(cur!.run.reviewIterations, 1, 'first REQUEST_CHANGES loops (nothing to compare yet)');

  // Cycle 2: reviewer repeats the SAME blocker (reformatted). Detector fires:
  // park at needs_human instead of a 2nd loop, even though the bound (3) is not reached.
  await finishRole(); await finishRole();
  await finishRole('REQUEST_CHANGES\n\n- **Must fix:** the header names `AGENT_AUTH_MODE`, but the plan says `AUTH_MODE`.');
  cur = await getRun(db.sql, run.id);
  assert.equal(cur!.run.reviewIterations, 1, 'no second loop — the repeat detector stopped it before the bound');
  assert.equal(cur!.run.state, 'awaiting_checkpoint', 'parked for a human');
  assert.ok(cur!.tasks.some((t) => String(t.role) === 'reviewer' && t.state === 'needs_human'), 'the reviewer task is parked needs_human');
  const evs = await getEvents(db.sql, run.id, 0, 500);
  assert.ok(evs.some((e) => e.kind === 'loop:disputed'), 'a loop:disputed event records why');
});

test('ESCALATE verdict parks at needs_human immediately (M11 WP4)', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'gesc', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId: 'g-esc', ticketKey: 'G-ESC', repoId: null }));
  const finishRole = async (reviewText?: string) => {
    const c = await claimTask(db.sql, 'gesc', ['claude-code']);
    if (!c) return null;
    if (String(c.task.role) === 'reviewer' && reviewText) await saveArtifact(db.sql, run.id, 'review.md', reviewText, { taskId: c.task.id });
    await finishTask(db.sql, c.task.id, { outcome: 'done', outputRef: c.task.outputRef, costUsd: 0.01, reason: null });
    return c;
  };
  await finishRole(); await finishRole(); await finishRole(); await finishRole('ESCALATE\nthe implementer and I disagree on the header key');
  const cur = await getRun(db.sql, run.id);
  assert.equal(cur!.run.reviewIterations, 0, 'ESCALATE never loops');
  assert.equal(cur!.run.state, 'awaiting_checkpoint');
  assert.ok(cur!.tasks.some((t) => String(t.role) === 'reviewer' && t.state === 'needs_human'));
});

test('the review-cycle bound counts loop_back AND gate_reject re-runs; at the cap the run parks at a gate, never loops again', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'gx', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  // maxIterations = 2. after_role:reviewer required so we can reject a review and
  // observe that a rejection-driven re-run ALSO counts against the loop bound
  // (before the fix, only loopBack counted, so a rejection was a free extra cycle).
  const team = { ...STANDARD_TEAM, loop: { onReviewFail: 'implementer' as const, maxIterations: 2 } };
  const gates = { after_plan: { mode: 'auto' as const }, before_change_request: { mode: 'auto' as const }, before_merge: { mode: 'auto' as const }, 'after_role:reviewer': { mode: 'required' as const } };
  const { run } = await createRun(db.sql, runInput({ ticketId: 'g-bound', ticketKey: 'G-X', repoId: null, team, gates }));

  const finishRole = async (reviewText?: string) => {
    const c = await claimTask(db.sql, 'gx', ['claude-code']);
    if (!c) return null;
    if (String(c.task.role) === 'reviewer' && reviewText) await saveArtifact(db.sql, run.id, 'review.md', reviewText, { taskId: c.task.id });
    await finishTask(db.sql, c.task.id, { outcome: 'done', outputRef: c.task.outputRef, costUsd: 0.01, reason: null });
    return c;
  };

  // Initial planner→implementer→tester→reviewer; REQUEST_CHANGES → loop 1 (loop_back → implementer).
  // Each cycle names a DIFFERENT blocker so the repeat detector (WP4) does not fire — we are testing the bound.
  await finishRole(); await finishRole(); await finishRole(); await finishRole('REQUEST_CHANGES\n- must fix: the pagination offset is computed off-by-one');
  let cur = await getRun(db.sql, run.id);
  assert.equal(cur!.run.reviewIterations, 1, 'iteration 1 recorded');
  assert.equal(cur!.run.state, 'running', 'looped, not parked');
  assert.ok(cur!.tasks.some((t) => String(t.role) === 'implementer' && t.queuedBy === 'loop_back'), 'the re-run implementer is tagged loop_back');

  // Drive loop-1 implementer→tester→reviewer; a DIFFERENT blocker → loop 2 (bound now reached).
  await finishRole(); await finishRole(); await finishRole('REQUEST_CHANGES\n- must fix: the error path leaks a file handle on timeout');
  cur = await getRun(db.sql, run.id);
  assert.equal(cur!.run.reviewIterations, 2, 'iteration 2 recorded (= maxIterations)');
  assert.equal(cur!.run.state, 'running', 'still looping at the cap boundary, not yet parked');

  // Drive loop-2 implementer→tester→reviewer; a THIRD distinct blocker.
  // Bounded: reviewIterations stays 2, no third loop. The run parks at the
  // after_role:reviewer gate with a loop:exhausted event instead of burning
  // another implementer cycle (the run_d0cd6bf6… runaway).
  await finishRole(); await finishRole(); await finishRole('REQUEST_CHANGES\n- must fix: the config default should be UTC not local time');
  cur = await getRun(db.sql, run.id);
  assert.equal(cur!.run.reviewIterations, 2, 'bound held — no third review cycle counted');
  assert.equal(cur!.run.state, 'awaiting_checkpoint', 'parked at a gate for a human decision instead of looping again');
  assert.ok(await getOpenGate(db.sql, run.id), 'the after_role:reviewer gate is open');
  const evs = await getEvents(db.sql, run.id, 0, 500);
  assert.ok(evs.some((e) => e.kind === 'loop:exhausted'), 'a loop:exhausted event explains why it stopped looping');
});

test('a reviewer REQUEST_CHANGES loops back to the implementer, bounded', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'g4', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  // All gates auto so the loop is what we observe, not gates.
  const { run } = await createRun(db.sql, runInput({ ticketId: 'g-loop', ticketKey: 'G-4', repoId: null }));

  async function finishAll(reviewText: string) {
    for (let i = 0; i < 4; i++) {
      const c = await claimTask(db.sql, 'g4', ['claude-code']);
      if (!c) break;
      if (String(c.task.role) === 'reviewer') await saveArtifact(db.sql, run.id, 'review.md', reviewText);
      await finishTask(db.sql, c.task.id, { outcome: 'done', outputRef: c.task.outputRef, costUsd: 0.01, reason: null });
    }
  }
  // First pass: reviewer asks for changes -> loop back to implementer.
  await finishAll('REQUEST_CHANGES\n- fix it');
  let after = await getRun(db.sql, run.id);
  assert.equal(after!.run.reviewIterations, 1);
  const looped = await claimTask(db.sql, 'g4', ['claude-code']);
  assert.equal(looped?.task.role, 'implementer', 'review loop re-queues from the implementer');
  // REGRESSION GUARD (run_1f1378ab…): the reviewer's blocking line must reach the
  // implementer's `reason` as `revise: <line>` — that is the ONLY field the worker
  // reads (segment.ts) to render the "## REVISION REQUESTED" banner. Before the
  // fix loopBack wrote it to queued_reason only, so the implementer re-ran with an
  // identical prompt and reproduced the same diff (a wasted, paid review cycle).
  assert.match(looped!.task.reason ?? '', /^revise:/, 'the looped implementer carries a revise: reason for the prompt banner');
  assert.match(looped!.task.reason ?? '', /fix it/, 'the reviewer blocking line is threaded into the re-run reason');

  // Finish the looped implementer+tester+reviewer, this time APPROVE.
  await finishTask(db.sql, looped!.task.id, { outcome: 'done', outputRef: 'x', costUsd: 0, reason: null });
  for (const _ of ['tester', 'reviewer']) {
    const c = await claimTask(db.sql, 'g4', ['claude-code']);
    if (String(c!.task.role) === 'reviewer') await saveArtifact(db.sql, run.id, 'review.md', 'APPROVE\nlgtm');
    await finishTask(db.sql, c!.task.id, { outcome: 'done', outputRef: c!.task.outputRef, costUsd: 0, reason: null });
  }
  after = await getRun(db.sql, run.id);
  // repoId null -> no publish -> succeeds.
  assert.equal(after!.run.state, 'succeeded');
});

test('with a repo bound and auto gates, the run drives through publish to succeeded', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'g5', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId: 'g-pub', ticketKey: 'G-5', repoId: 'repo1' }));
  const roles = ['planner', 'implementer', 'tester', 'reviewer'];
  for (const role of roles) {
    const c = await claimTask(db.sql, 'g5', ['claude-code']);
    if (String(c!.task.role) === 'reviewer') await saveArtifact(db.sql, run.id, 'review.md', 'APPROVE');
    await finishTask(db.sql, c!.task.id, { outcome: 'done', outputRef: c!.task.outputRef, costUsd: 0, reason: null });
    void role;
  }
  // Now the publish tasks appear (auto gates), claimable by any worker.
  for (let i = 0; i < 3; i++) {
    const c = await claimTask(db.sql, 'g5', ['claude-code']);
    if (!c) break;
    assert.match(String(c.task.role), /^publish:/);
    await finishTask(db.sql, c.task.id, { outcome: 'done', outputRef: null, costUsd: 0, reason: null });
  }
  assert.equal((await getRun(db.sql, run.id))!.run.state, 'succeeded');
});

test('merge OFF: publish opens + marks ready, ends succeeded/awaiting_external_merge, never merges', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'gmo', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const team = { ...STANDARD_TEAM, mergeEnabled: false };
  const { run } = await createRun(db.sql, runInput({ ticketId: 'g-nomerge', ticketKey: 'G-9', repoId: 'repo1', team }));
  for (const _role of ['planner', 'implementer', 'tester', 'reviewer']) {
    const c = await claimTask(db.sql, 'gmo', ['claude-code']);
    if (String(c!.task.role) === 'reviewer') await saveArtifact(db.sql, run.id, 'review.md', 'APPROVE');
    await finishTask(db.sql, c!.task.id, { outcome: 'done', outputRef: c!.task.outputRef, costUsd: 0, reason: null });
  }
  // Publish steps: push_open then mark_ready (NO merge). Emit the opened event so the CR number resolves.
  const push = await claimTask(db.sql, 'gmo', ['claude-code']);
  assert.equal(String(push!.task.role), 'publish:push_open');
  const { appendEvent } = await import('./store.js');
  await appendEvent(db.sql, { runId: run.id, taskId: push!.task.id, kind: 'change_request:opened', source: 'worker', payload: { number: 3, url: 'https://gitlab.com/g/r/-/merge_requests/3', draft: true } });
  await finishTask(db.sql, push!.task.id, { outcome: 'done', outputRef: null, costUsd: 0, reason: null });

  const ready = await claimTask(db.sql, 'gmo', ['claude-code']);
  assert.equal(String(ready!.task.role), 'publish:mark_ready', 'mark_ready is enqueued, not merge');
  await appendEvent(db.sql, { runId: run.id, taskId: ready!.task.id, kind: 'change_request:ready', source: 'worker', payload: { number: 3 } });
  await finishTask(db.sql, ready!.task.id, { outcome: 'done', outputRef: null, costUsd: 0, reason: null });

  const after = await getRun(db.sql, run.id);
  assert.equal(after!.run.state, 'succeeded');
  assert.equal(after!.run.deliveryOutcome, 'awaiting_external_merge');
  assert.equal(after!.run.changeRequestState, 'ready');
  assert.ok(!after!.tasks.some((t) => String(t.role) === 'publish:merge'), 'no merge task was ever created');
  assert.ok(!after!.tasks.some((t) => t.state === 'awaiting_gate'), 'before_merge gate never opened');
});

/** Drive planner→implementer→tester→reviewer to done (approving after_plan on the way). */
async function driveRolesToPublish(runId: string, wid: string) {
  const planner = await claimTask(db.sql, wid, ['claude-code']);
  await saveArtifact(db.sql, runId, 'plan.md', 'PLAN');
  await finishTask(db.sql, planner!.task.id, { outcome: 'done', outputRef: 'plan.md', costUsd: 0, reason: null });
  const g = await getOpenGate(db.sql, runId); // after_plan
  await resolveGate(db.sql, g!.id, { decision: 'approve', by: 'jon', note: null, editedArtifact: null });
  for (const _ of ['implementer', 'tester', 'reviewer']) {
    const c = await claimTask(db.sql, wid, ['claude-code']);
    if (String(c!.task.role) === 'reviewer') await saveArtifact(db.sql, runId, 'review.md', 'APPROVE');
    await finishTask(db.sql, c!.task.id, { outcome: 'done', outputRef: c!.task.outputRef, costUsd: 0, reason: null });
  }
}

test('rejecting the before_change_request gate does NOT publish — it sends the work back and re-gates', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'gp', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId: 'g-pubrej', ticketKey: 'G-PR', gates: DEFAULT_GATES, repoId: 'repo1' }));
  await driveRolesToPublish(run.id, 'gp');

  // Parked at before_change_request (a required publish gate).
  const gate = await getOpenGate(db.sql, run.id);
  assert.equal(gate?.gateName, 'before_change_request');

  // Reject it. The bug was: the run pushed + merged anyway.
  await resolveGate(db.sql, gate!.id, { decision: 'reject', by: 'jon', note: 'not negative-zero safe', editedArtifact: null });

  const afterReject = await getRun(db.sql, run.id);
  assert.notEqual(afterReject!.run.state, 'succeeded', 'a rejected gate must not let the run succeed');
  // No publish task ran.
  assert.ok(!afterReject!.tasks.some((t) => String(t.role).startsWith('publish:') && t.state === 'done'),
    'no PR should have been opened or merged after a reject');
  // The reviewer was re-queued to revise (a fresh pending copy).
  const reviewers = afterReject!.tasks.filter((t) => String(t.role) === 'reviewer');
  assert.ok(reviewers.some((t) => t.state === 'pending' && t.attempt === 2), 'reviewer re-queued as attempt 2');

  // Complete the revision: reviewer re-runs -> the publish gate OPENS AGAIN
  // (it must not auto-proceed off the stale rejection).
  const rc = await claimTask(db.sql, 'gp', ['claude-code']);
  assert.equal(String(rc!.task.role), 'reviewer');
  await saveArtifact(db.sql, run.id, 'review.md', 'APPROVE');
  await finishTask(db.sql, rc!.task.id, { outcome: 'done', outputRef: 'review.md', costUsd: 0, reason: null });
  const reopened = await getOpenGate(db.sql, run.id);
  assert.equal(reopened?.gateName, 'before_change_request', 'the gate re-opens for a fresh decision after revision');
  assert.equal((await getRun(db.sql, run.id))!.run.state, 'awaiting_checkpoint');
});

test('rejecting before_merge also sends the work back rather than merging', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'gm', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId: 'g-mrej', ticketKey: 'G-MR', gates: DEFAULT_GATES, repoId: 'repo1' }));
  await driveRolesToPublish(run.id, 'gm');
  // Approve before_change_request so the PR opens and we reach before_merge.
  const gcr = await getOpenGate(db.sql, run.id);
  assert.equal(gcr?.gateName, 'before_change_request');
  await resolveGate(db.sql, gcr!.id, { decision: 'approve', by: 'jon', note: null, editedArtifact: null });
  const pushTask = await claimTask(db.sql, 'gm', ['claude-code']);
  assert.equal(String(pushTask!.task.role), 'publish:push_open');
  await finishTask(db.sql, pushTask!.task.id, { outcome: 'done', outputRef: null, costUsd: 0, reason: null });

  // Parked at before_merge. Reject it.
  const gm = await getOpenGate(db.sql, run.id);
  assert.equal(gm?.gateName, 'before_merge');
  await resolveGate(db.sql, gm!.id, { decision: 'reject', by: 'jon', note: 'hold the merge', editedArtifact: null });

  const after = await getRun(db.sql, run.id);
  assert.notEqual(after!.run.state, 'succeeded', 'rejecting before_merge must not merge');
  assert.ok(!after!.tasks.some((t) => String(t.role) === 'publish:merge' && t.state === 'done'), 'no merge task ran');
  assert.ok(after!.tasks.filter((t) => String(t.role) === 'reviewer').some((t) => t.state === 'pending'), 'reviewer re-queued to revise');
});

test('a change_request:opened event stamps the run row (url/number/state); ready+merged advance state', { skip }, async () => {
  const { appendEvent } = await import('./store.js');
  const run = await createRun(db.sql, runInput({ repoId: 'group/repo' }));
  // opened -> url + number + state=open
  await appendEvent(db.sql, { runId: run.run.id, taskId: null, kind: 'change_request:opened', source: 'worker',
    payload: { number: 7, url: 'https://gitlab.com/group/repo/-/merge_requests/7', draft: true } });
  let r = (await getRun(db.sql, run.run.id))!.run;
  assert.equal(r.changeRequestUrl, 'https://gitlab.com/group/repo/-/merge_requests/7');
  assert.equal(r.changeRequestNumber, 7);
  assert.equal(r.changeRequestState, 'open');
  // ready -> state advances, url/number preserved
  await appendEvent(db.sql, { runId: run.run.id, taskId: null, kind: 'change_request:ready', source: 'worker', payload: {} });
  r = (await getRun(db.sql, run.run.id))!.run;
  assert.equal(r.changeRequestState, 'ready');
  assert.equal(r.changeRequestNumber, 7, 'number preserved across ready');
  // merged -> merged
  await appendEvent(db.sql, { runId: run.run.id, taskId: null, kind: 'change_request:merged', source: 'worker', payload: { number: 7 } });
  r = (await getRun(db.sql, run.run.id))!.run;
  assert.equal(r.changeRequestState, 'merged');
});

/** A review-only run as dispatch builds it: the reviewer alone, no loop, a reviewTarget. */
const REVIEW_TEAM = {
  ...STANDARD_TEAM, mergeEnabled: false, loop: null,
  roles: STANDARD_TEAM.roles.filter((r) => r.role === 'reviewer'),
  reviewTarget: { url: 'https://github.com/acme/web/pull/42', number: 42, headBranch: 'feature/x', baseBranch: 'main', fetchRef: 'refs/pull/42/head' },
};

for (const verdict of ['APPROVE', 'REQUEST_CHANGES']) {
  test(`review-only run: ${verdict} ends succeeded/reviewed with no publish and a link to the PR`, { skip }, async () => {
    await drain(db.sql);
    await registerWorker(db.sql, { id: `grv-${verdict}`, host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
    const { run } = await createRun(db.sql, runInput({ ticketId: `g-review-${verdict}`, ticketKey: 'G-RV', repoId: 'repo1', team: REVIEW_TEAM }));
    const c = await claimTask(db.sql, `grv-${verdict}`, ['claude-code']);
    assert.equal(String(c!.task.role), 'reviewer');
    await saveArtifact(db.sql, run.id, 'review.md', `${verdict}\n- a finding`);
    await finishTask(db.sql, c!.task.id, { outcome: 'done', outputRef: c!.task.outputRef, costUsd: 0.01, reason: null });

    const after = await getRun(db.sql, run.id);
    assert.equal(after!.run.state, 'succeeded');
    assert.equal(after!.run.deliveryOutcome, 'reviewed');
    assert.equal(after!.run.reviewIterations, 0, 'no loop back');
    assert.deepEqual(after!.tasks.map((t) => String(t.role)), ['reviewer'], 'no implementer re-run, no publish task');
    const [n] = await db.sql`SELECT body, actions FROM notification WHERE run_id = ${run.id} AND kind = 'finished'`;
    assert.match(String(n.body), /The review is ready in ASF/);
    assert.ok((n.actions as { url: string }[]).some((a) => a.url === 'https://github.com/acme/web/pull/42'));
  });
}
