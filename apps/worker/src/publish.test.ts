import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunContext, Run, RunTask } from '@asf/shared';
import { STANDARD_TEAM, DEFAULT_GATES } from '@asf/shared';

const exec = promisify(execFile);

// git.ts reads config.worktreeRoot at call time; point it at a temp dir before importing.
let root: string;
let originDir: string;
let git: typeof import('./git.js');
let publish: typeof import('./publish.js');
let api: typeof import('./api.js')['api'];
const realFetch = global.fetch;

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run_pub0000001', ticketId: 't1', ticketKey: 'ASF-P', ticketProvider: 'mock', state: 'running',
  teamName: 'standard', team: STANDARD_TEAM, gates: DEFAULT_GATES, repoId: 'r1', worktreePath: null, branchName: null,
  changeRequestUrl: null, changeRequestNumber: null, changeRequestState: null, deliveryOutcome: null, costUsd: 0, maxCostUsd: 15, reviewIterations: 0, dispatchedBy: 'test', reason: null,
  createdAt: new Date().toISOString(), startedAt: null, lastEventAt: null, cancelRequestedAt: null, finishedAt: null, ...over,
});
const task = (role: string): RunTask => ({ id: `task_${role}`, runId: 'run_pub0000001', role, seq: 5, state: 'running', attempt: 1, inputRef: null, outputRef: null,
  workerId: 'w', runtime: 'publish', model: null, effort: null, costUsd: 0, gateChecked: false, startedAt: null, finishedAt: null, reason: null, queuedBy: 'plan', queuedReason: null });
const ctx = (): RunContext => ({
  runId: 'run_pub0000001', ticket: { id: 't1', key: 'ASF-P', title: 'Publish it', body: '', url: '', links: [] },
  repo: { id: 'rp', path: 'example/app', url: 'file://origin', defaultBranch: 'main', cloneUrl: originDir },
  cloneCredential: { url: originDir }, auth: { providerKind: 'anthropic', mode: 'api-key' }, auths: {}, roleSkills: {},
} as unknown as RunContext);

type Call = { what: string; args: unknown[] };
function stubApi(artifacts: { name: string; content: string }[] = [], replyError: string | null = null): Call[] {
  const calls: Call[] = [];
  api.replyToThreads = async (...args: unknown[]) => {
    calls.push({ what: 'replyToThreads', args });
    if (replyError) throw new Error(replyError);
    return { replied: [], failed: [] };
  };
  api.event = async (...args: unknown[]) => { calls.push({ what: 'event', args }); };
  api.openChangeRequest = async (...args: unknown[]) => { calls.push({ what: 'open', args }); return { number: 3, url: 'https://github.com/o/r/pull/3' }; };
  api.markReadyChangeRequest = async (...args: unknown[]) => { calls.push({ what: 'markReady', args }); };
  // The registry reads publish makes directly: the artifacts for the PR body, the events for the CR number.
  global.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { artifacts,
    events: [{ kind: 'change_request:opened', payload: { number: 3 } }] } }), { status: 200 })) as unknown as typeof fetch;
  return calls;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'asf-pub-wt-'));
  process.env.WORKTREE_ROOT = root;
  git = await import('./git.js');
  publish = await import('./publish.js');
  api = (await import('./api.js')).api;
  originDir = await mkdtemp(join(tmpdir(), 'asf-pub-origin-'));
  await exec('git', ['init', '-b', 'main', originDir]);
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: originDir });
});
after(async () => { global.fetch = realFetch; await rm(root, { recursive: true, force: true }); await rm(originDir, { recursive: true, force: true }); });

test('push_open opens one PR; after changes are requested it pushes onto that PR and never opens a second', async () => {
  const r1 = run();
  const ws = await git.ensureWorkspace(r1, ctx().repo!, ctx().cloneCredential!, () => {});
  await writeFile(join(ws.worktreePath, 'feature.txt'), 'round 1\n');
  await git.commitPending(ws, r1, 'implementer', 'round 1', () => {});

  let calls = stubApi();
  const first = await publish.runPublish({ run: r1, task: task('publish:push_open'), team: STANDARD_TEAM }, ctx(), () => {});
  assert.equal(first.outcome, 'done');
  assert.equal(calls.filter((c) => c.what === 'open').length, 1);
  assert.ok(calls.some((c) => c.what === 'event' && c.args[1] === 'change_request:opened'));
  assert.ok(!calls.some((c) => c.what === 'replyToThreads'), 'nothing to reply on when the PR is new');

  // Round 2: the run carries the PR, the worktree is gone, the revision is committed on the rebuilt branch.
  const r2 = run({ changeRequestNumber: 3, changeRequestUrl: 'https://github.com/o/r/pull/3', changeRequestState: 'ready' });
  await rm(ws.worktreePath, { recursive: true, force: true });
  const ws2 = await git.ensureWorkspace(r2, ctx().repo!, ctx().cloneCredential!, () => {});
  await writeFile(join(ws2.worktreePath, 'feature.txt'), 'round 2\n');
  await git.commitPending(ws2, r2, 'implementer', 'round 2', () => {});

  calls = stubApi();
  const second = await publish.runPublish({ run: r2, task: task('publish:push_open'), team: STANDARD_TEAM }, ctx(), () => {});
  assert.equal(second.outcome, 'done', second.reason ?? '');
  assert.equal(calls.filter((c) => c.what === 'open').length, 0, 'no second PR');
  const updated = calls.find((c) => c.what === 'event' && c.args[1] === 'change_request:updated');
  assert.deepEqual(updated?.args[2], { number: 3, url: 'https://github.com/o/r/pull/3' });
  assert.deepEqual(calls.filter((c) => c.what === 'replyToThreads').map((c) => c.args), [['run_pub0000001', 3]], 'the update push replies on the threads');
  const pushed = (await exec('git', ['show', `${ws2.branchName}:feature.txt`], { cwd: originDir })).stdout;
  assert.equal(pushed, 'round 2\n', 'the revision is on the PR branch');

  // mark_ready on a PR that is already ready does not call the SCM again.
  calls = stubApi();
  const ready = await publish.runPublish({ run: r2, task: task('publish:mark_ready'), team: STANDARD_TEAM }, ctx(), () => {});
  assert.equal(ready.outcome, 'done');
  assert.equal(calls.filter((c) => c.what === 'markReady').length, 0);
  assert.ok(calls.some((c) => c.what === 'event' && c.args[1] === 'change_request:ready'));
});

test('push_open types the commit and the PR title from review.md, then plan.md', async () => {
  const r = run({ id: 'run_pubtype001', ticketKey: 'ASF-P' });
  const ws = await git.ensureWorkspace(r, ctx().repo!, ctx().cloneCredential!, () => {});
  await writeFile(join(ws.worktreePath, 'typed.txt'), 'x\n');
  await git.commitPending(ws, r, 'implementer', 'wip', () => {});

  const calls = stubApi([
    { name: 'plan.md', content: '# Plan\n\nChange-Type: fix' },
    { name: 'review.md', content: 'APPROVE\nok\n\nChange-Type: feat' },
  ]);
  const res = await publish.runPublish({ run: r, task: task('publish:push_open'), team: STANDARD_TEAM }, ctx(), () => {});
  assert.equal(res.outcome, 'done', res.reason ?? '');
  const open = calls.find((c) => c.what === 'open');
  assert.equal((open?.args[1] as { title: string }).title, 'feat: ASF-P: Publish it');
  const subject = (await exec('git', ['log', '-1', '--format=%s', ws.branchName], { cwd: originDir })).stdout.trim();
  assert.equal(subject, 'feat: ASF-P Publish it');
});

test('push_open onto an open PR: a failed thread reply is recorded and the push still succeeds', async () => {
  const r = run({ id: 'run_pubreply01', changeRequestNumber: 3, changeRequestUrl: 'https://github.com/o/r/pull/3' });
  const ws = await git.ensureWorkspace(r, ctx().repo!, ctx().cloneCredential!, () => {});
  await writeFile(join(ws.worktreePath, 'reply.txt'), 'x\n');
  await git.commitPending(ws, r, 'implementer', 'wip', () => {});

  const calls = stubApi([], 'POST /api/scm/thread-replies -> 502 {}');
  const res = await publish.runPublish({ run: r, task: task('publish:push_open'), team: STANDARD_TEAM }, ctx(), () => {});
  assert.equal(res.outcome, 'done', res.reason ?? '');
  assert.equal(calls.filter((c) => c.what === 'replyToThreads').length, 1);
  const failed = calls.find((c) => c.what === 'event' && c.args[1] === 'review_threads:reply_failed');
  assert.deepEqual(failed?.args[2], { reason: 'POST /api/scm/thread-replies -> 502 {}' });
});
