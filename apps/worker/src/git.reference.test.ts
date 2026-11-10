import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Repo, Run, RunContext } from '@asf/shared';
import { STANDARD_TEAM, DEFAULT_GATES } from '@asf/shared';

const exec = promisify(execFile);

// Read-only copies of other repositories a ticket names (RunContext.referenceRepos):
// a detached checkout of each default branch tip, outside the run's worktree, removed after.
let root: string;
let appOrigin: string;
let libOrigin: string;
let git: typeof import('./git.js');
let segment: typeof import('./segment.js');

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run_refs00000001', ticketId: 't1', ticketKey: 'ASF-9', ticketProvider: 'mock', state: 'running',
  teamName: 'standard', team: STANDARD_TEAM, gates: DEFAULT_GATES, repoId: 'app', worktreePath: null, branchName: null,
  changeRequestUrl: null, changeRequestNumber: null, changeRequestState: null, deliveryOutcome: null, costUsd: 0, maxCostUsd: 15, reviewIterations: 0, dispatchedBy: 'test', reason: null,
  createdAt: new Date().toISOString(), startedAt: null, lastEventAt: null, cancelRequestedAt: null, finishedAt: null, ...over,
});
const appRepo = (): Repo => ({ id: 'app', path: 'acme/platform/web/storefront', url: 'file://app', defaultBranch: 'main', cloneUrl: appOrigin });
const libRepo = (): Repo => ({ id: 'lib', path: 'acme/platform/web/shared-ui', url: 'file://lib', defaultBranch: 'main', cloneUrl: libOrigin });
const ctxWith = (refs: { repo: Repo; url: string }[]): RunContext => ({
  referenceRepos: refs.map((r) => ({ repo: r.repo, cloneCredential: { url: r.url }, reason: `The ticket description mentions ${r.repo.path}.` })),
}) as unknown as RunContext;

async function originWith(file: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asf-refs-origin-'));
  await exec('git', ['init', '-b', 'main', dir]);
  await writeFile(join(dir, file), content);
  await exec('git', ['add', '-A'], { cwd: dir });
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: dir });
  return dir;
}
const head = async (dir: string) => (await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
const exists = (p: string) => stat(p).then(() => true, () => false);
const worktrees = async (bare: string) => (await exec('git', ['--git-dir', bare, 'worktree', 'list', '--porcelain'])).stdout;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'asf-refs-wt-'));
  process.env.WORKTREE_ROOT = root;
  git = await import('./git.js');
  segment = await import('./segment.js');
  appOrigin = await originWith('app.ts', 'export const app = 1;\n');
  libOrigin = await originWith('button.ts', 'export function Button() {}\n');
});
after(async () => { for (const d of [root, appOrigin, libOrigin]) await rm(d, { recursive: true, force: true }); });

test('a reference checkout is detached at the default branch tip, outside the run worktree, and cleanup removes it', async () => {
  const r = run();
  const ws = await git.ensureWorkspace(r, appRepo(), { url: appOrigin }, () => {});
  const events: { kind: string; payload: Record<string, unknown> }[] = [];
  const refs = await segment.prepareReferenceCheckouts(ctxWith([{ repo: libRepo(), url: libOrigin }]), r.id, 'task_1', () => {}, (kind, payload) => { events.push({ kind, payload }); });

  assert.equal(refs.ready.length, 1);
  const c = refs.ready[0];
  assert.equal(c.dir, join(root, 'refs', r.id, 'task_1', 'shared-ui'));
  assert.ok(relative(ws.worktreePath, c.dir).startsWith('..'), 'outside the run worktree');
  assert.equal(c.sha, await head(libOrigin), 'at the default branch tip');
  assert.equal(await head(c.dir), c.sha);
  const branch = await exec('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: c.dir }).then(() => 'attached', () => 'detached');
  assert.equal(branch, 'detached', 'no branch made in the shared clone');
  assert.ok(await exists(join(c.dir, 'button.ts')));
  assert.equal((await stat(join(c.dir, 'button.ts'))).mode & 0o022, 0, 'not writable by the group (the agent user) or others');
  assert.equal((await stat(c.dir)).mode & 0o022, 0);
  assert.deepEqual(events, [{ kind: 'refs:ready', payload: { repos: [{ path: libRepo().path, dir: c.dir, sha: c.sha }], skipped: [] } }]);
  // The stored remote carries no credential, as for the run's own clone.
  const remote = (await exec('git', ['--git-dir', git.bareDirFor(libRepo()), 'config', 'remote.origin.url'])).stdout.trim();
  assert.equal(remote, libOrigin);

  const registered = await realpath(c.dir);
  assert.ok((await worktrees(git.bareDirFor(libRepo()))).includes(registered), 'registered as a worktree of the cached clone');
  await writeFile(join(c.dir, 'button.ts'), 'an edit that must not persist\n');
  await refs.cleanup();
  assert.equal(await exists(c.dir), false, 'the copy is gone');
  assert.equal(await exists(join(root, 'refs', r.id)), false, 'and the run\'s refs dir with it');
  assert.ok(!(await worktrees(git.bareDirFor(libRepo()))).includes(registered), 'the worktree registration is pruned');
  assert.ok(await exists(join(ws.worktreePath, 'app.ts')), 'the run worktree is untouched');
  await refs.cleanup();   // idempotent
});

test('a repository that fails is skipped and reported; the others are still checked out', async () => {
  const r = run({ id: 'run_refs00000002' });
  const missing: Repo = { ...libRepo(), id: 'gone', path: 'acme/platform/web/gone', cloneUrl: join(root, 'no-such-origin') };
  const dupe: Repo = { ...libRepo(), id: 'lib2', path: 'acme/other/shared-ui' };
  const events: { kind: string; payload: Record<string, unknown> }[] = [];
  const refs = await segment.prepareReferenceCheckouts(
    ctxWith([{ repo: libRepo(), url: libOrigin }, { repo: missing, url: missing.cloneUrl }, { repo: dupe, url: libOrigin }]),
    r.id, 'task_2', () => {}, (kind, payload) => { events.push({ kind, payload }); });
  assert.deepEqual(refs.ready.map((c) => c.dir.split('/').pop()), ['shared-ui', 'shared-ui-2'], 'colliding names are deduped');
  assert.deepEqual(refs.skipped.map((s) => s.path), [missing.path]);
  assert.equal(await exists(git.bareDirFor(missing)), false, 'a failed first clone leaves no half-made cache behind');
  assert.equal((events[0].payload.skipped as unknown[]).length, 1);
  await refs.cleanup();
  for (const c of refs.ready) assert.equal(await exists(c.dir), false);
});

test('a copy that takes too long is skipped with a timeout reason', async () => {
  const r = run({ id: 'run_refs00000003' });
  const refs = await segment.prepareReferenceCheckouts(ctxWith([{ repo: { ...libRepo(), id: 'slow' }, url: libOrigin }]), r.id, 'task_3', () => {}, () => {}, 0);
  assert.equal(refs.ready.length, 0);
  assert.match(refs.skipped[0].reason, /timed out/);
  await refs.cleanup();
});

test('no referenceRepos: nothing is created and no event is sent', async () => {
  const events: unknown[] = [];
  const refs = await segment.prepareReferenceCheckouts({} as RunContext, 'run_refs00000004', 'task_4', () => {}, (k) => { events.push(k); });
  assert.deepEqual([refs.ready, refs.skipped, events], [[], [], []]);
  assert.equal(await exists(join(root, 'refs', 'run_refs00000004')), false);
  await refs.cleanup();
});

test('referenceDirNames: last path segment, deduped, filesystem-safe', () => {
  assert.deepEqual(segment.referenceDirNames(['acme/web/shared-ui', 'acme/mobile/shared-ui', 'acme/x/shared-ui', 'a/..', 'a/we ird']),
    ['shared-ui', 'shared-ui-2', 'shared-ui-3', 'repo', 'we_ird']);
});

test('a failed git command never carries the clone credential in its message', () => {
  assert.equal(
    git.redactUrlCredentials("fatal: unable to access 'https://oauth2:glpat-SECRET@gitlab.example.com/acme/lib.git/': timeout"),
    "fatal: unable to access 'https://***@gitlab.example.com/acme/lib.git/': timeout",
  );
  assert.equal(git.redactUrlCredentials('https://x-access-token:ghs_abc@github.com/o/r and http://u:p@h/x'), 'https://***@github.com/o/r and http://***@h/x');
  assert.equal(git.redactUrlCredentials('https://github.com/o/r.git no creds'), 'https://github.com/o/r.git no creds');
});
