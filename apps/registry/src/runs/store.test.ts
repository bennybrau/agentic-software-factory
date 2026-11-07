import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRun, RunConflictError, appendEvent, getEvents, requestCancel, getRun, listRuns, taskProgress, runsAwaitingExternalMerge, hiveMergedRuns } from './store.js';
import { finishTask, claimTask, registerWorker } from './workers.js';
import { dbAvailable, testDb, runInput, drain } from '../test/harness.js';
import { DEFAULT_GATES } from '@asf/shared';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('store'); });
after(async () => { if (db) await db.close(); });

test('createRun writes one task per role, seq ordered, and a run:queued event', { skip }, async () => {
  const { run, tasks } = await createRun(db.sql, runInput({ ticketId: 'c1', ticketKey: 'C-1', gates: DEFAULT_GATES }));
  assert.equal(run.state, 'queued');
  assert.deepEqual(tasks.map((t) => [t.role, t.seq, t.state]), [['planner', 0, 'pending'], ['implementer', 1, 'pending'], ['tester', 2, 'pending'], ['reviewer', 3, 'pending']]);
  assert.equal(run.gates.before_merge.mode, 'required');
  const events = await getEvents(db.sql, run.id, 0, 10);
  assert.deepEqual(events.map((e) => e.kind), ['run:queued']);
});

test('one live run per ticket; a finished run frees the ticket', { skip }, async () => {
  const a = await createRun(db.sql, runInput({ ticketId: 'c2', ticketKey: 'C-2' }));
  await assert.rejects(() => createRun(db.sql, runInput({ ticketId: 'c2', ticketKey: 'C-2' })),
    (e: unknown) => e instanceof RunConflictError && e.existingRunId === a.run.id);
  await requestCancel(db.sql, a.run.id, 'test'); // nothing running -> cancelled immediately
  assert.equal((await getRun(db.sql, a.run.id))!.run.state, 'cancelled');
  const b = await createRun(db.sql, runInput({ ticketId: 'c2', ticketKey: 'C-2' }));
  assert.notEqual(b.run.id, a.run.id);
});

test('appendEvent seq is monotonic under concurrency', { skip }, async () => {
  const { run } = await createRun(db.sql, runInput({ ticketId: 'c3', ticketKey: 'C-3' }));
  await Promise.all(Array.from({ length: 20 }, (_, i) => appendEvent(db.sql, { runId: run.id, taskId: null, kind: 'tool:pre', source: 'agent', payload: { i } })));
  const events = await getEvents(db.sql, run.id, 0, 100);
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(seqs, Array.from({ length: 21 }, (_, i) => i + 1));
});

test('a run whose tasks all finish done becomes succeeded, cost summed', { skip }, async () => {
  await drain(db.sql);
  const { run } = await createRun(db.sql, runInput({ ticketId: 'c4', ticketKey: 'C-4', team: { ...runInput().team, roles: runInput().team.roles.slice(0, 2) } }));
  await registerWorker(db.sql, { id: 'w1', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  for (const cost of [0.5, 1.25]) {
    const claim = await claimTask(db.sql, 'w1', ['claude-code']);
    assert.ok(claim, 'expected a claim');
    await finishTask(db.sql, claim.task.id, { outcome: 'done', outputRef: null, costUsd: cost, reason: null });
  }
  const after = (await getRun(db.sql, run.id))!;
  assert.equal(after.run.state, 'succeeded');
  assert.equal(after.run.costUsd, 1.75);
  assert.equal(await claimTask(db.sql, 'w1', ['claude-code']), null);
});

test('a failed task fails the run; needs_human parks it', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'w2', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const a = await createRun(db.sql, runInput({ ticketId: 'c5', ticketKey: 'C-5' }));
  let claim = await claimTask(db.sql, 'w2', ['claude-code']);
  await finishTask(db.sql, claim!.task.id, { outcome: 'failed', outputRef: null, costUsd: 0, reason: 'boom' });
  assert.equal((await getRun(db.sql, a.run.id))!.run.state, 'failed');
  const b = await createRun(db.sql, runInput({ ticketId: 'c6', ticketKey: 'C-6' }));
  claim = await claimTask(db.sql, 'w2', ['claude-code']);
  assert.equal(claim!.run.id, b.run.id);
  await finishTask(db.sql, claim!.task.id, { outcome: 'needs_human', outputRef: null, costUsd: 0, reason: 'which repo?' });
  assert.equal((await getRun(db.sql, b.run.id))!.run.state, 'awaiting_checkpoint');
});

test('listRuns filters (state/team/outcome/search/since), paginates with offset, and reports total', { skip }, async () => {
  await drain(db.sql);
  // Seed six runs on two teams, distinct states/outcomes/created_at.
  const mk = async (over: Parameters<typeof runInput>[0], patch: Record<string, unknown>) => {
    const r = await createRun(db.sql, runInput(over));
    const sets = Object.entries(patch);
    for (const [col, val] of sets) await db.sql`UPDATE agent_run SET ${db.sql(col)} = ${val as never} WHERE id = ${r.run.id}`;
    return r.run.id;
  };
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  await mk({ ticketId: 'lr1', ticketKey: 'LR-1' }, { state: 'succeeded', team_name: 'standard', delivery_outcome: 'merged', created_at: day(1) });
  await mk({ ticketId: 'lr2', ticketKey: 'LR-2' }, { state: 'failed', team_name: 'standard', created_at: day(2) });
  await mk({ ticketId: 'lr3', ticketKey: 'LR-3' }, { state: 'succeeded', team_name: 'fast', delivery_outcome: 'awaiting_external_merge', created_at: day(3) });
  await mk({ ticketId: 'lr4', ticketKey: 'LR-4' }, { state: 'succeeded', team_name: 'standard', delivery_outcome: 'merged', created_at: day(10) });
  await mk({ ticketId: 'lr5', ticketKey: 'ZZ-5' }, { state: 'cancelled', team_name: 'standard', created_at: day(40) });
  await mk({ ticketId: 'lr6', ticketKey: 'LR-6' }, { state: 'succeeded', team_name: 'fast', delivery_outcome: 'merged', created_at: day(2) });

  // No filter: total counts everything seeded (drain removed prior live runs; older tests' terminal runs may exist, so assert >= 6 and that our keys are present).
  const all = await listRuns(db.sql, { limit: 100 });
  assert.ok(all.total >= 6);

  // state filter
  const failed = await listRuns(db.sql, { state: 'failed', limit: 100 });
  assert.ok(failed.runs.every((r) => r.state === 'failed'));
  assert.ok(failed.runs.some((r) => r.ticketKey === 'LR-2'));

  // team filter
  const fast = await listRuns(db.sql, { teamName: 'fast', limit: 100 });
  assert.ok(fast.runs.every((r) => r.teamName === 'fast'));
  assert.deepEqual(fast.runs.map((r) => r.ticketKey).sort(), ['LR-3', 'LR-6']);

  // delivery outcome filter
  const merged = await listRuns(db.sql, { deliveryOutcome: 'merged', limit: 100 });
  assert.ok(merged.runs.every((r) => r.deliveryOutcome === 'merged'));

  // ticket-key search (case-insensitive, substring)
  const zz = await listRuns(db.sql, { search: 'zz-', limit: 100 });
  assert.deepEqual(zz.runs.map((r) => r.ticketKey), ['ZZ-5']);

  // since window: last 7 days excludes the 10/40-day-old ones
  const recent = await listRuns(db.sql, { since: day(7), limit: 100, search: 'LR-' });
  assert.ok(recent.runs.every((r) => !['LR-4'].includes(r.ticketKey)), 'the 10-day-old LR-4 is outside a 7-day window');

  // offset pagination: page size 2 over the 'fast' team + a combined filter that yields a stable set
  const succ = await listRuns(db.sql, { state: 'succeeded', limit: 2, offset: 0 });
  assert.equal(succ.runs.length, 2);
  const succTotal = succ.total;
  const page2 = await listRuns(db.sql, { state: 'succeeded', limit: 2, offset: 2 });
  assert.equal(page2.total, succTotal, 'total is stable across pages');
  // No overlap between page 1 and page 2.
  const overlap = succ.runs.map((r) => r.id).filter((id) => page2.runs.some((p) => p.id === id));
  assert.deepEqual(overlap, [], 'pages do not overlap');
});

test('taskProgress counts tool:pre since segment:started and reports the last tool + ceiling (M11 WP5)', { skip }, async () => {
  const { run, tasks } = await createRun(db.sql, runInput({ ticketId: 'tp-1', ticketKey: 'TP-1' }));
  const t = tasks[0];
  await appendEvent(db.sql, { runId: run.id, taskId: t.id, kind: 'segment:started', source: 'worker', payload: { role: t.role, maxTurns: 150, timeoutMs: 2_700_000 } });
  await appendEvent(db.sql, { runId: run.id, taskId: t.id, kind: 'tool:pre', source: 'agent', payload: { tool: 'Read', summary: 'Read a.ts' } });
  await appendEvent(db.sql, { runId: run.id, taskId: t.id, kind: 'tool:post', source: 'agent', payload: { tool: 'Read' } });
  await appendEvent(db.sql, { runId: run.id, taskId: t.id, kind: 'tool:pre', source: 'agent', payload: { tool: 'Edit', summary: 'Edit b.ts' } });

  const prog = await taskProgress(db.sql, [t.id]);
  const p = prog[t.id];
  assert.equal(p.toolCalls, 2, 'two tool:pre events counted');
  assert.equal(p.lastTool, 'Edit b.ts', 'last tool summary');
  assert.equal(p.maxTurns, 150);
  assert.equal(p.timeoutMs, 2_700_000);
  assert.ok(p.startedAt, 'startedAt from segment:started');
});

test('taskProgress counts only tool calls AFTER the latest segment:started (a re-run resets the clock)', { skip }, async () => {
  const { run, tasks } = await createRun(db.sql, runInput({ ticketId: 'tp-2', ticketKey: 'TP-2' }));
  const t = tasks[0];
  await appendEvent(db.sql, { runId: run.id, taskId: t.id, kind: 'segment:started', source: 'worker', payload: {} });
  await appendEvent(db.sql, { runId: run.id, taskId: t.id, kind: 'tool:pre', source: 'agent', payload: { tool: 'Read' } });
  // A second attempt (re-run) starts a fresh clock.
  await appendEvent(db.sql, { runId: run.id, taskId: t.id, kind: 'segment:started', source: 'worker', payload: {} });
  await appendEvent(db.sql, { runId: run.id, taskId: t.id, kind: 'tool:pre', source: 'agent', payload: { tool: 'Grep' } });
  const p = (await taskProgress(db.sql, [t.id]))[t.id];
  assert.equal(p.toolCalls, 1, 'only the tool call after the latest segment:started counts');
  assert.equal(p.lastTool, 'Grep');  // falls back to payload.tool when no summary
});

test('merge watch set: open/ready, plus closed for a day so a wrong "closed" can be corrected to merged', { skip }, async () => {
  const mk = async (key: string, crState: string, lastEventAgo: string) => {
    const { run } = await createRun(db.sql, runInput({ ticketId: `mw-${key}`, ticketKey: `MW-${key}` }));
    await db.sql`UPDATE agent_run SET state = 'succeeded', delivery_outcome = 'awaiting_external_merge', repo_id = 'r',
      change_request_number = 1, change_request_state = ${crState}, last_event_at = now() - ${lastEventAgo}::interval WHERE id = ${run.id}`;
    return run.id;
  };
  const ready = await mk('ready', 'ready', '0 minutes');
  const justClosed = await mk('closed-new', 'closed', '5 minutes');
  const oldClosed = await mk('closed-old', 'closed', '2 days');
  const merged = await mk('merged', 'merged', '5 minutes');
  const ids = (await runsAwaitingExternalMerge(db.sql, 100)).map((r) => r.id);
  assert.ok(ids.includes(ready) && ids.includes(justClosed));
  assert.ok(!ids.includes(oldClosed) && !ids.includes(merged));

  // The watcher corrects it: change_request:merged stamps it merged and it leaves the set.
  await appendEvent(db.sql, { runId: justClosed, taskId: null, kind: 'change_request:merged', source: 'orchestrator', payload: { number: 1, external: true } });
  assert.equal((await getRun(db.sql, justClosed))!.run.changeRequestState, 'merged');
  assert.ok(!(await runsAwaitingExternalMerge(db.sql, 100)).some((r) => r.id === justClosed));
});

test('hiveMergedRuns: merged runs with a repo, stamped and ordered by merge time, since filters on it', { skip }, async () => {
  const mk = async (key: string, set: { crState: string | null; repo: string | null; finishedAgo: string }) => {
    const { run } = await createRun(db.sql, runInput({ ticketId: `hv-${key}`, ticketKey: `HV-${key}` }));
    await db.sql`UPDATE agent_run SET state = 'succeeded', repo_id = ${set.repo}, change_request_number = 1,
      change_request_state = ${set.crState}, finished_at = now() - ${set.finishedAgo}::interval WHERE id = ${run.id}`;
    return run.id;
  };
  // Finished long ago, merged (by the watcher) just now.
  const lateMerge = await mk('late', { crState: 'merged', repo: 'r', finishedAgo: '30 days' });
  await appendEvent(db.sql, { runId: lateMerge, taskId: null, kind: 'change_request:merged', source: 'orchestrator', payload: { number: 1 } });
  // Merged with no event: falls back to finished_at.
  const noEvent = await mk('noevent', { crState: 'merged', repo: 'r', finishedAgo: '2 days' });
  const closed = await mk('closed', { crState: 'closed', repo: 'r', finishedAgo: '1 hour' });
  const noCr = await mk('nocr', { crState: null, repo: 'r', finishedAgo: '1 hour' });
  const noRepo = await mk('norepo', { crState: 'merged', repo: null, finishedAgo: '1 hour' });

  const mine = new Set([lateMerge, noEvent, closed, noCr, noRepo]);
  const all = (await hiveMergedRuns(db.sql, { limit: 1000 })).filter((r) => mine.has(r.id));
  assert.deepEqual(all.map((r) => r.id), [noEvent, lateMerge]);
  const [ev] = (await getEvents(db.sql, lateMerge, 0, 100)).filter((e) => e.kind === 'change_request:merged');
  assert.equal(all[1].mergedAt, ev.at);
  assert.equal(all[0].mergedAt, (await getRun(db.sql, noEvent))!.run.finishedAt);

  const since = new Date(Date.now() - 86_400_000).toISOString();
  const recent = (await hiveMergedRuns(db.sql, { since, limit: 1000 })).filter((r) => mine.has(r.id));
  assert.deepEqual(recent.map((r) => r.id), [lateMerge]);
});
