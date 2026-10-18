import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_TEAM, type GateWire, type RunTask } from '@asf/shared';
import type { RunDetail } from './api';
import { chatStatus } from './chat-status';

const task = (role: string, state: RunTask['state'], seq: number, over: Partial<RunTask> = {}) => ({
  id: `t_${seq}`, runId: 'run_1', role, seq, state, attempt: 1, inputRef: null, outputRef: null, workerId: null, runtime: 'claude-code',
  model: null, effort: null, costUsd: 0, gateChecked: false, startedAt: null, finishedAt: null, reason: null, queuedBy: 'plan', queuedReason: null, ...over,
}) as RunTask;
const gate = (gateName: string, state: string) => ({ id: `g_${gateName}`, runId: 'run_1', gateName, mode: 'required', state, afterTask: null,
  artifact: '# Plan', decidedBy: null, note: null, editedArtifact: null, createdAt: '', decidedAt: null }) as GateWire;
const detail = (run: Partial<RunDetail['run']>, tasks: RunTask[] = [], gates: GateWire[] = [], more: Partial<RunDetail> = {}) => ({
  run: { id: 'run_1', ticketId: 'adhoc:x', ticketKey: 'ADHOC-X', ticketProvider: 'adhoc', state: 'running', teamName: 'standard', team: STANDARD_TEAM,
    gates: {}, repoId: 'r1', worktreePath: null, branchName: null, changeRequestUrl: null, changeRequestNumber: null, changeRequestState: null,
    deliveryOutcome: null, costUsd: 0, maxCostUsd: 15, reviewIterations: 0, dispatchedBy: null, reason: null, createdAt: '', startedAt: null,
    lastEventAt: null, cancelRequestedAt: null, finishedAt: null, ...run },
  tasks, gates, artifacts: [], ...more,
}) as RunDetail;
const planned = task('planner', 'done', 1);

test('queued, or the planner not picked up yet: waiting for a worker', () => {
  assert.deepEqual(chatStatus(detail({ state: 'queued' }), 'org/web'), { tone: 'working', text: 'Created task ADHOC-X. Waiting for a worker to pick it up.' });
  assert.equal(chatStatus(detail({}, [task('planner', 'pending', 1)]), 'org/web').text, 'Created task ADHOC-X. Waiting for a worker to pick it up.');
});

test('the planner running: planning it in the repository', () => {
  assert.deepEqual(chatStatus(detail({}, [task('planner', 'running', 1)]), 'org/web'), { tone: 'working', text: 'Created task ADHOC-X. I\'m planning it in `org/web`…' });
  assert.equal(chatStatus(detail({}, [task('planner', 'running', 1)]), null).text, 'Created task ADHOC-X. I\'m planning it…');
});

test('an open plan gate, or a planner question: over to you', () => {
  const over = { tone: 'waiting', text: 'Over to you: approve the plan or reply below.' };
  assert.deepEqual(chatStatus(detail({ state: 'awaiting_checkpoint' }, [planned], [gate('after_plan', 'open')]), null), over);
  assert.deepEqual(chatStatus(detail({ state: 'awaiting_checkpoint' }, [task('planner', 'needs_human', 1)]), null), over);
});

test('auto after_plan with the implementer running: the team is on it, with the step', () => {
  // No after_plan gate was ever opened, so nothing gate-based can say this.
  assert.deepEqual(chatStatus(detail({}, [planned, task('implementer', 'running', 2)]), null), { tone: 'working', text: 'The team is on it: Write code (step 2 of 4).' });
  assert.equal(chatStatus(detail({}, [planned, task('implementer', 'done', 2), task('tester', 'pending', 3)]), null).text, 'The team is on it: Test (step 3 of 4).');
  assert.equal(chatStatus(detail({}, [planned, task('reviewer', 'running', 4)]), null).text, 'The team is on it: Review (step 4 of 4).');
});

test('the publish phase opens the pull request, then waits at before_merge', () => {
  const tasks = [planned, task('reviewer', 'done', 4), task('publish:push_open', 'running', 5, { runtime: 'publish' })];
  assert.deepEqual(chatStatus(detail({}, tasks), null), { tone: 'working', text: 'Opening the pull request.' });
  const atMerge = chatStatus(detail({ state: 'awaiting_checkpoint', changeRequestUrl: 'https://x/pr/1' }, tasks, [gate('before_merge', 'open')]), null);
  assert.deepEqual(atMerge, { tone: 'waiting', text: 'Ready for you to merge.', prUrl: 'https://x/pr/1' });
});

test('succeeded: done with the pull request link', () => {
  assert.deepEqual(chatStatus(detail({ state: 'succeeded', deliveryOutcome: 'merged', changeRequestUrl: 'https://x/pr/1' }), null),
    { tone: 'done', text: 'Done.', prUrl: 'https://x/pr/1' });
  assert.deepEqual(chatStatus(detail({ state: 'succeeded' }), null), { tone: 'done', text: 'Done.' });
});

test('a split: queued N tasks', () => {
  const split = { parent: { runId: 'run_1', ticketKey: 'ADHOC-X', title: 't' }, currentPart: null, parts: [{}, {}, {}] } as unknown as RunDetail['split'];
  assert.deepEqual(chatStatus(detail({ state: 'succeeded', deliveryOutcome: 'split' }, [], [], { split }), null), { tone: 'done', text: 'Queued 3 tasks.' });
});

test('failed, cancelled, halted or stale: the state and its reason', () => {
  assert.deepEqual(chatStatus(detail({ state: 'failed', reason: 'tests failed' }, [planned, task('implementer', 'failed', 2)]), null), { tone: 'bad', text: 'Failed: tests failed' });
  assert.deepEqual(chatStatus(detail({ state: 'cancelled' }), null), { tone: 'bad', text: 'Cancelled.' });
  assert.equal(chatStatus(detail({ state: 'halted', reason: 'cost limit' }), null).text, 'Hit a limit: cost limit');
  assert.equal(chatStatus(detail({ state: 'stale' }), null).text, 'Interrupted.');
});
