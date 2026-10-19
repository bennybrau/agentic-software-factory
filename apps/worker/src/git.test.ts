import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloneCredential, Repo, Run } from '@asf/shared';
import { STANDARD_TEAM, DEFAULT_GATES } from '@asf/shared';

const exec = promisify(execFile);

// git.ts reads config.worktreeRoot at call time; point it at a temp dir before importing.
let root: string;
let originDir: string;
let git: typeof import('./git.js');

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run_deadbeef1234', ticketId: 't1', ticketKey: 'ASF-9', ticketProvider: 'mock', state: 'running',
  teamName: 'standard', team: STANDARD_TEAM, gates: DEFAULT_GATES, repoId: 'r1', worktreePath: null, branchName: null,
  changeRequestUrl: null, changeRequestNumber: null, changeRequestState: null, deliveryOutcome: null, costUsd: 0, maxCostUsd: 15, reviewIterations: 0, dispatchedBy: 'test', reason: null,
  createdAt: new Date().toISOString(), startedAt: null, lastEventAt: null, cancelRequestedAt: null, finishedAt: null, ...over,
});
const repo = (): Repo => ({ id: 'r1', path: 'example/app', url: 'file://origin', defaultBranch: 'main', cloneUrl: originDir });

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'asf-wt-'));
  process.env.WORKTREE_ROOT = root;
  git = await import('./git.js');
  // A real origin repo with one commit on main.
  originDir = await mkdtemp(join(tmpdir(), 'asf-origin-'));
  await exec('git', ['init', '-b', 'main', originDir]);
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: originDir });
});
after(async () => { await rm(root, { recursive: true, force: true }); await rm(originDir, { recursive: true, force: true }); });

const cred: CloneCredential = { url: '' };

test('creates a worktree on agent/<key>-<runid> from origin/main', async () => {
  const ws = await git.ensureWorkspace(run(), repo(), { url: originDir }, () => {});
  assert.equal(ws.branchName, 'agent/ASF-9-deadbeef');
  assert.equal(ws.resumed, false);
  const entries = await readdir(ws.worktreePath);
  assert.ok(entries.includes('.git'));
});

test('rebaseOntoBase re-anchors the run onto a base that moved, cleanly, as one commit', async () => {
  // origin already has an initial commit on main (from the before() hook). Make a worktree,
  // add the run's file, then advance main on the origin so the run's base is now stale.
  const r = run({ id: 'run_rebase01', ticketKey: 'ASF-RB' });
  const ws = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  await writeFile(join(ws.worktreePath, 'feature.txt'), 'the ticket work\n');
  await git.commitPending(ws, r, 'implementer', 'add feature', () => {});

  // Someone else merges to main after the run started (a different file, no overlap).
  await exec('git', ['-C', originDir, 'config', 'receive.denyCurrentBranch', 'ignore']);
  const other = await mkdtemp(join(tmpdir(), 'asf-other-'));
  await exec('git', ['clone', originDir, other]);
  await writeFile(join(other, 'unrelated.txt'), 'landed since the run started\n');
  await exec('git', ['-c', 'user.email=o@o', '-c', 'user.name=o', 'add', '-A'], { cwd: other });
  await exec('git', ['-c', 'user.email=o@o', '-c', 'user.name=o', 'commit', '-m', 'other work'], { cwd: other });
  await exec('git', ['push', 'origin', 'HEAD:main'], { cwd: other });

  await git.rebaseOntoBase(ws, r, { url: originDir }, () => {});

  // The run branch now sits on top of the moved main: it shares main's new commit as an
  // ancestor (so a PR would merge cleanly) and still carries the feature file.
  const mergeBase = (await exec('git', ['merge-base', ws.branchName, 'origin/main'], { cwd: ws.worktreePath })).stdout.trim();
  const mainTip = (await exec('git', ['rev-parse', 'origin/main'], { cwd: ws.worktreePath })).stdout.trim();
  assert.equal(mergeBase, mainTip, 'the run branch descends from the current main tip');
  const files = (await exec('git', ['show', '--stat', '--name-only', '--format=', 'HEAD'], { cwd: ws.worktreePath })).stdout;
  assert.match(files, /feature\.txt/, 'the delivery survives the rebase');
  // Exactly one commit on top of main (squashed).
  const ahead = (await exec('git', ['rev-list', '--count', `origin/main..${ws.branchName}`], { cwd: ws.worktreePath })).stdout.trim();
  assert.equal(ahead, '1', 'squashed to a single commit');

  await rm(other, { recursive: true, force: true });
});

test('the squashed commit carries the Conventional Commits type, the ticket title and the trailers', async () => {
  const r = run({ id: 'run_cctype01', ticketKey: 'ASF-CC' });
  const ws = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  await writeFile(join(ws.worktreePath, 'cc.txt'), 'typed\n');
  await git.commitPending(ws, r, 'implementer', 'wip', () => {});
  await git.rebaseOntoBase(ws, r, { url: originDir }, () => {}, { type: 'feat', title: 'Add  the\nwidget' });
  const msg = (await exec('git', ['log', '-1', '--format=%B'], { cwd: ws.worktreePath })).stdout;
  assert.equal(msg.split('\n')[0], 'feat: ASF-CC Add the widget');
  assert.match(msg, /^Ticket: ASF-CC$/m);
  assert.match(msg, /^Run-Id: run_cctype01$/m);
  assert.match(msg, /^Co-Authored-By: /m);
  assert.doesNotMatch(msg, /BREAKING CHANGE/);
});

test('a feat! delivery gets a BREAKING CHANGE footer; no title falls back to "agent delivery"', () => {
  const r = run({ id: 'run_cctype02', ticketKey: 'ASF-BR' });
  const msg = git.deliveryMessage(r, { type: 'feat!', title: 'Drop v1 API' });
  assert.equal(msg.split('\n')[0], 'feat!: ASF-BR Drop v1 API');
  assert.match(msg, /\n\nBREAKING CHANGE: Drop v1 API\nTicket: ASF-BR\nRun-Id: run_cctype02\nCo-Authored-By: /);
  assert.equal(git.deliveryMessage(r, { type: 'fix', title: '' }).split('\n')[0], 'fix: ASF-BR agent delivery');
});

test('the worktree origin carries no credential, and a poisoned cached clone is scrubbed', async () => {
  const r = run({ id: 'run_nocred01', ticketKey: 'ASF-NC' });
  const ws = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  // Simulate a clone cached before M8 WP A: `git clone` stored the tokened URL as origin.
  await exec('git', ['config', 'remote.origin.url', 'https://x-access-token:ghp_SECRET@github.com/o/r.git'], { cwd: ws.worktreePath });
  const ws2 = await git.ensureWorkspace(run({ id: 'run_nocred02', ticketKey: 'ASF-NC' }), repo(), { url: originDir }, () => {});
  for (const wt of [ws.worktreePath, ws2.worktreePath]) {
    const url = (await exec('git', ['remote', 'get-url', 'origin'], { cwd: wt })).stdout.trim();
    assert.equal(url, originDir);
    assert.doesNotMatch(url, /@|SECRET/, 'an agent reading its remote sees no token');
  }
});

test('a second call for the same run reuses the worktree', async () => {
  const r = run({ id: 'run_reuse01' });
  const first = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  const second = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  assert.equal(second.resumed, true);
  assert.equal(second.worktreePath, first.worktreePath);
});

test('commitPending writes trailers and no-ops on a clean tree', async () => {
  const r = run({ id: 'run_commit01' });
  const ws = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  assert.equal(await git.commitPending(ws, r, 'implementer', 'do it', () => {}), null); // clean
  await writeFile(join(ws.worktreePath, 'new.txt'), 'hi');
  const sha = await git.commitPending(ws, r, 'implementer', 'add new.txt', () => {});
  assert.ok(sha);
  const body = (await exec('git', ['log', '-1', '--format=%B'], { cwd: ws.worktreePath })).stdout;
  assert.match(body, /Ticket: ASF-9/);
  assert.match(body, /Run-Id: run_commit01/);
  assert.match(body, /Role: implementer/);
});

test('creates a root worktree when the origin repo is empty (unborn HEAD)', async () => {
  // An origin that was `git init --bare`'d and never committed: no HEAD, no branches.
  const emptyOrigin = await mkdtemp(join(tmpdir(), 'asf-empty-origin-'));
  await exec('git', ['init', '--bare', '-b', 'main', emptyOrigin]);
  const emptyRepo = (): Repo => ({ id: 'empty1', path: 'example/empty', url: 'file://empty', defaultBranch: 'main', cloneUrl: emptyOrigin });
  const r = run({ id: 'run_empty0001', ticketKey: 'ASF-EMPTY' });

  const ws = await git.ensureWorkspace(r, emptyRepo(), { url: emptyOrigin }, () => {});

  assert.equal(ws.branchName, 'agent/ASF-EMPTY-empty000');
  assert.equal(ws.resumed, false);
  const entries = await readdir(ws.worktreePath);
  assert.ok(entries.includes('.git'));
  // On an orphan branch HEAD is unborn, so read the symbolic ref (rev-parse --abbrev-ref needs a commit).
  const branch = (await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: ws.worktreePath })).stdout.trim();
  assert.equal(branch, ws.branchName);

  // The very first files can be written and committed from the orphan state.
  await writeFile(join(ws.worktreePath, 'first.txt'), 'hi');
  const sha = await git.commitPending(ws, r, 'implementer', 'first commit', () => {});
  assert.ok(sha, 'first commit should land on the orphan branch');
  // And the first commit counts every file it introduced.
  assert.ok((await git.changedFileCount(ws)) >= 1, 'first commit files should be counted');

  await rm(emptyOrigin, { recursive: true, force: true });
});

test('bootstrapBaseBranch creates main on an empty origin and re-parents the work branch onto it', async () => {
  const emptyOrigin = await mkdtemp(join(tmpdir(), 'asf-empty-origin-'));
  await exec('git', ['init', '--bare', '-b', 'main', emptyOrigin]);
  const emptyRepo = (): Repo => ({ id: 'empty2', path: 'example/empty2', url: 'file://empty2', defaultBranch: 'main', cloneUrl: emptyOrigin });
  const r = run({ id: 'run_boot00001', ticketKey: 'ASF-BOOT' });

  const ws = await git.ensureWorkspace(r, emptyRepo(), { url: emptyOrigin }, () => {});
  await writeFile(join(ws.worktreePath, 'app.js'), 'export const x = 1;\n');
  await git.commitPending(ws, r, 'implementer', 'add app.js', () => {});

  // Bootstrap the base branch on the origin, then push the work branch.
  await git.bootstrapBaseBranch(ws, { url: emptyOrigin }, () => {});
  await git.pushBranch(ws, { url: emptyOrigin }, () => {});

  // main now exists on the origin, pointing at an (empty) root commit.
  const originBranches = (await exec('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: emptyOrigin })).stdout.trim().split('\n');
  assert.ok(originBranches.includes('main'), `origin should have main; has: ${originBranches.join(',')}`);
  assert.ok(originBranches.includes(ws.branchName), 'origin should have the work branch');

  // The work branch and main share history (a PR base..head diff is possible and mergeable).
  const mergeBase = (await exec('git', ['merge-base', 'main', ws.branchName], { cwd: emptyOrigin })).stdout.trim();
  assert.ok(mergeBase.length > 0, 'main and the work branch must share a merge base');
  // And the diff main..work still shows the delivered file (a real, non-empty PR).
  const diff = (await exec('git', ['diff', '--name-only', `main..${ws.branchName}`], { cwd: emptyOrigin })).stdout.trim();
  assert.match(diff, /app\.js/, 'the PR diff must contain the delivered file');

  await rm(emptyOrigin, { recursive: true, force: true });
});

test('unborn stays true on resume after the implementer commits (base branch still absent)', async () => {
  const emptyOrigin = await mkdtemp(join(tmpdir(), 'asf-empty-origin-'));
  await exec('git', ['init', '--bare', '-b', 'main', emptyOrigin]);
  const emptyRepo = (): Repo => ({ id: 'empty3', path: 'example/empty3', url: 'file://empty3', defaultBranch: 'main', cloneUrl: emptyOrigin });
  const r = run({ id: 'run_resume0001', ticketKey: 'ASF-RES' });

  const ws1 = await git.ensureWorkspace(r, emptyRepo(), { url: emptyOrigin }, () => {});
  assert.equal(ws1.unborn, true, 'first pass into an empty repo is unborn');
  // Implementer writes + commits into the shared object store (creates a branch ref in the bare clone).
  await writeFile(join(ws1.worktreePath, 'app.js'), 'export const x = 1;\n');
  await git.commitPending(ws1, r, 'implementer', 'add app.js', () => {});

  // A later segment (e.g. publish) re-resolves the workspace. The DEFAULT branch still
  // does not exist on the remote, so the workspace must still be unborn — otherwise
  // changedFileCount/bootstrap take the born path and the publish fails.
  const ws2 = await git.ensureWorkspace(r, emptyRepo(), { url: emptyOrigin }, () => {});
  assert.equal(ws2.resumed, true, 'the worktree is reused');
  assert.equal(ws2.unborn, true, 'still unborn: the default branch does not exist on the remote yet');
  assert.ok((await git.changedFileCount(ws2)) >= 1, 'the delivered file is still counted');

  await rm(emptyOrigin, { recursive: true, force: true });
});

test('refuses a run whose branch would be protected', async () => {
  // Force the branch to `main` by faking the run id resolution is not possible; instead assert isForbiddenBranch guard
  // by pushing to a protected branch name.
  const r = run({ id: 'run_prot0001' });
  const ws = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  (ws as { branchName: string }).branchName = 'main';
  await assert.rejects(() => git.pushBranch(ws, cred, () => {}), /protected branch/);
});

test('a deleted worktree is rebuilt from the pushed run branch, and a revision pushes onto it', async () => {
  const r = run({ id: 'run_rebuild001', ticketKey: 'ASF-RB2' });
  const ws = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  await writeFile(join(ws.worktreePath, 'round1.txt'), 'first delivery\n');
  await git.commitPending(ws, r, 'implementer', 'round 1', () => {});
  await git.rebaseOntoBase(ws, r, { url: originDir }, () => {});
  await git.pushBranch(ws, { url: originDir }, () => {});
  const pushed1 = (await exec('git', ['rev-parse', ws.branchName], { cwd: originDir })).stdout.trim();

  // The worktree vanishes (a different worker picks up the change request).
  await rm(ws.worktreePath, { recursive: true, force: true });
  const ws2 = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  assert.equal(ws2.resumed, true);
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: ws2.worktreePath })).stdout.trim(), pushed1, 'rebuilt on the pushed branch tip');
  assert.ok((await readdir(ws2.worktreePath)).includes('round1.txt'), 'round 1 work is there');

  // Round 2 lands on top and pushes onto the same branch.
  await writeFile(join(ws2.worktreePath, 'round2.txt'), 'revision\n');
  await git.commitPending(ws2, r, 'implementer', 'round 2', () => {});
  await git.rebaseOntoBase(ws2, r, { url: originDir }, () => {});
  await git.pushBranch(ws2, { url: originDir }, () => {});
  const files = (await exec('git', ['ls-tree', '--name-only', ws2.branchName], { cwd: originDir })).stdout;
  assert.match(files, /round1\.txt/);
  assert.match(files, /round2\.txt/);
});

async function landOnMain(files: Record<string, string>, msg: string) {
  await exec('git', ['-C', originDir, 'config', 'receive.denyCurrentBranch', 'ignore']);
  const other = await mkdtemp(join(tmpdir(), 'asf-other-'));
  await exec('git', ['clone', originDir, other]);
  for (const [f, body] of Object.entries(files)) await writeFile(join(other, f), body);
  await exec('git', ['-c', 'user.email=o@o', '-c', 'user.name=o', 'add', '-A'], { cwd: other });
  await exec('git', ['-c', 'user.email=o@o', '-c', 'user.name=o', 'commit', '-m', msg], { cwd: other });
  await exec('git', ['push', 'origin', 'HEAD:main'], { cwd: other });
  await rm(other, { recursive: true, force: true });
}

test('a conflict at publish names the files; resolving it via startConflictMerge then publishes cleanly', async () => {
  const { parseMergeConflict } = await import('@asf/shared');
  await landOnMain({ 'list.txt': 'a\nb\n' }, 'seed list');
  const r = run({ id: 'run_conflict01', ticketKey: 'ASF-CF' });
  const ws = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  // The run adds "mine" at the end of the list, in two commits (a replay would conflict twice).
  await writeFile(join(ws.worktreePath, 'list.txt'), 'a\nb\nmine-draft\n');
  await git.commitPending(ws, r, 'implementer', 'draft', () => {});
  await writeFile(join(ws.worktreePath, 'list.txt'), 'a\nb\nmine\n');
  await git.commitPending(ws, r, 'implementer', 'final', () => {});
  // Meanwhile main appends "theirs" at the same spot.
  await landOnMain({ 'list.txt': 'a\nb\ntheirs\n' }, 'their entry');

  const err = await git.rebaseOntoBase(ws, r, { url: originDir }, () => {}).then(() => null, (e: Error) => e);
  assert.ok(err, 'publishing must refuse a conflicting branch');
  assert.deepEqual(parseMergeConflict(err!.message), { base: 'main', files: ['list.txt'] });
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: ws.worktreePath })).stdout.trim(), '', 'the failed merge was aborted: clean tree');

  // The implementer's re-run: the worker starts the merge and leaves the markers.
  const files = await git.startConflictMerge(ws, { url: originDir }, () => {});
  assert.deepEqual(files, ['list.txt']);
  assert.deepEqual(await git.filesWithConflictMarkers(ws, files), ['list.txt'], 'markers are there for the agent');
  // ...and is idempotent if the role is retried mid-merge.
  assert.deepEqual(await git.startConflictMerge(ws, { url: originDir }, () => {}), ['list.txt']);

  // The agent keeps both sides and finishes the merge.
  await writeFile(join(ws.worktreePath, 'list.txt'), 'a\nb\ntheirs\nmine\n');
  assert.deepEqual(await git.filesWithConflictMarkers(ws, files), []);
  await exec('git', ['add', 'list.txt'], { cwd: ws.worktreePath });
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--no-edit'], { cwd: ws.worktreePath });

  // Publishing now succeeds: one squashed commit on top of the current main, with both entries.
  await git.rebaseOntoBase(ws, r, { url: originDir }, () => {});
  const mainTip = (await exec('git', ['rev-parse', 'origin/main'], { cwd: ws.worktreePath })).stdout.trim();
  assert.equal((await exec('git', ['rev-parse', 'HEAD~1'], { cwd: ws.worktreePath })).stdout.trim(), mainTip);
  assert.equal((await exec('git', ['show', 'HEAD:list.txt'], { cwd: ws.worktreePath })).stdout, 'a\nb\ntheirs\nmine\n');
  await git.pushBranch(ws, { url: originDir }, () => {});
});

test('a branch with intermediate commits that a replay would trip on publishes when the final work merges cleanly', async () => {
  await landOnMain({ 'cfg.txt': 'x=1\n' }, 'seed cfg');
  const r = run({ id: 'run_conflict02', ticketKey: 'ASF-CF2' });
  const ws = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  // A draft edits the line main will also edit, then the final commit reverts it.
  await writeFile(join(ws.worktreePath, 'cfg.txt'), 'x=2\n');
  await git.commitPending(ws, r, 'implementer', 'draft', () => {});
  await writeFile(join(ws.worktreePath, 'cfg.txt'), 'x=1\n');
  await writeFile(join(ws.worktreePath, 'new.txt'), 'feature\n');
  await git.commitPending(ws, r, 'implementer', 'final', () => {});
  await landOnMain({ 'cfg.txt': 'x=3\n' }, 'their cfg');

  await git.rebaseOntoBase(ws, r, { url: originDir }, () => {});
  assert.equal((await exec('git', ['show', 'HEAD:cfg.txt'], { cwd: ws.worktreePath })).stdout, 'x=3\n', 'main\'s change kept');
  assert.equal((await exec('git', ['show', 'HEAD:new.txt'], { cwd: ws.worktreePath })).stdout, 'feature\n');
});

test("the target repo's git hooks (husky pre-commit/pre-push) don't block the worker's commit or push", async () => {
  const r = run({ id: 'run_hooks001', ticketKey: 'ASF-HK' });
  const ws = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  // What husky leaves behind: core.hooksPath=.husky and hooks that need a tool the worker lacks.
  const hookDir = join(ws.worktreePath, '.husky');
  await exec('mkdir', ['-p', hookDir]);
  for (const h of ['pre-commit', 'commit-msg', 'pre-push']) {
    await writeFile(join(hookDir, h), '#!/bin/sh\necho "pnpm: not found" >&2\nexit 127\n', { mode: 0o755 });
  }
  await exec('git', ['config', 'core.hooksPath', '.husky'], { cwd: ws.worktreePath });
  // Sanity: the hook really fails a plain commit.
  await writeFile(join(ws.worktreePath, 'plain.txt'), 'y');
  await exec('git', ['add', '-A'], { cwd: ws.worktreePath });
  await assert.rejects(exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'plain'], { cwd: ws.worktreePath }), /pnpm: not found/);
  await writeFile(join(ws.worktreePath, 'hooked.txt'), 'x');
  const sha = await git.commitPending(ws, r, 'implementer', 'with hooks', () => {});
  assert.ok(sha, 'the worker commit succeeds despite a failing pre-commit hook');
  await exec('git', ['-C', originDir, 'config', 'receive.denyCurrentBranch', 'ignore']);
  await git.pushBranch(ws, { url: originDir }, () => {});
  const pushed = (await exec('git', ['-C', originDir, 'rev-parse', `refs/heads/${ws.branchName}`])).stdout.trim();
  assert.equal(pushed, sha, 'pushed despite a failing pre-push hook');
});

test('a review-only run checks out the PR head on the agent branch, with the PR base as its base, also on resume', async () => {
  // The origin serves the PR head under refs/pull/7/head (as GitHub does) and has a `develop` base.
  const g = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
  await exec('git', ['-C', originDir, 'branch', '-f', 'develop', 'main']);
  await exec('git', ['-C', originDir, ...g, 'commit-tree', '-p', 'main', '-m', 'the PR', 'main^{tree}']).then(async ({ stdout }) => {
    await exec('git', ['-C', originDir, 'update-ref', 'refs/pull/7/head', stdout.trim()]);
  });
  const prHead = (await exec('git', ['-C', originDir, 'rev-parse', 'refs/pull/7/head'])).stdout.trim();
  const team = { ...STANDARD_TEAM, reviewTarget: { url: 'https://github.com/example/app/pull/7', number: 7, headBranch: 'not-in-this-repo', baseBranch: 'develop', fetchRef: 'refs/pull/7/head' } };
  const r = run({ id: 'run_review07', ticketKey: 'ASF-RV', team });

  const ws = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  assert.equal(ws.branchName, 'agent/ASF-RV-review07');
  assert.equal(ws.baseBranch, 'develop');
  assert.equal(ws.resumed, false);
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: ws.worktreePath })).stdout.trim(), prHead);
  assert.equal((await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ws.worktreePath })).stdout.trim(), ws.branchName);

  const again = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  assert.equal(again.resumed, true);
  assert.equal(again.baseBranch, 'develop', 'the PR base survives a resume');
});

test('a review-only run falls back to the head branch when the remote has no PR ref', async () => {
  await exec('git', ['-C', originDir, 'branch', '-f', 'feature/pr8', 'main']);
  const team = { ...STANDARD_TEAM, reviewTarget: { url: 'https://github.com/example/app/pull/8', number: 8, headBranch: 'feature/pr8', baseBranch: 'main', fetchRef: 'refs/pull/8/head' } };
  const ws = await git.ensureWorkspace(run({ id: 'run_review08', ticketKey: 'ASF-RV', team }), repo(), { url: originDir }, () => {});
  const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: ws.worktreePath })).stdout.trim();
  assert.equal(head, (await exec('git', ['-C', originDir, 'rev-parse', 'feature/pr8'])).stdout.trim());
});
