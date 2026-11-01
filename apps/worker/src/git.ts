import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CloneCredential, Repo, Run } from '@asf/shared';
import { isForbiddenBranch, formatMergeConflict } from '@asf/shared';
import { config } from './config.js';
import type { ChangeType } from './commit-type.js';

const exec = promisify(execFile);

export class GitError extends Error {}

export interface Workspace {
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  resumed: boolean;
  /** True when the origin repo had no commits: the run branch is an orphan and its first commit creates history. */
  unborn: boolean;
}

/**
 * The worker's own git commands (commit, merge, rebase, push) never run the target
 * repo's client-side hooks. Hooks such as husky + lint-staged assume a developer
 * machine with the repo's package manager and installed dependencies; in the worker
 * they fail with "pnpm: not found" and block the merge request. The MR's CI pipeline is
 * the quality gate. core.hooksPath is overridden through the environment (it beats the
 * `core.hooksPath=.husky` husky writes into the repo's config), and HUSKY=0 covers
 * husky versions that check it.
 */
export const NO_REPO_HOOKS: Readonly<Record<string, string>> = {
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', HUSKY: '0',
};

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, env: { ...process.env, ...NO_REPO_HOOKS, ...env }, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    // Name the subcommand, not a leading `-c key=value` option.
    let i = 0;
    while (args[i] === '-c' || args[i] === '-C') i += 2;
    throw new GitError(`git ${args[i] ?? args[0]} failed: ${(e.stderr || e.message || '').trim()}`);
  }
}

/** origin/<default> if it exists (live clone), else the local <default> ref (bare clone of a local origin). */
async function resolveStart(bareDir: string, defaultBranch: string): Promise<string> {
  for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
    try { await git(bareDir, ['rev-parse', '--verify', `${ref}^{commit}`]); return ref; } catch { /* try next */ }
  }
  return defaultBranch;
}

/** True if the repo's default branch exists (origin/<default> or a local <default>). Its
 * ABSENCE — not "no commits anywhere" — is what makes a workspace unborn: once the
 * implementer commits, the bare clone has commits and a run-branch ref, but the default
 * branch still does not exist until the first delivery bootstraps it. */
async function baseBranchExists(bareDir: string, defaultBranch: string): Promise<boolean> {
  for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
    try { await git(bareDir, ['rev-parse', '--verify', `${ref}^{commit}`]); return true; } catch { /* try next */ }
  }
  return false;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

/**
 * A clone URL with any userinfo (user:token@) removed. A local path or a URL with
 * no credential is returned unchanged.
 */
export function credentialLessUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }   // a bare filesystem path
  if (!u.username && !u.password) return url;
  u.username = '';
  u.password = '';
  return u.toString();
}

/** agent/<TICKET>-<run id, short>. Carries the ticket and the run so a re-dispatch can't collide. */
export function branchFor(run: Run): string {
  const short = run.id.replace(/^run_/, '').slice(0, 8);
  return `agent/${run.ticketKey}-${short}`;
}

/**
 * A bare clone cached per repo (fetched if already present), then a worktree
 * per run branched from the repo's default branch. Refuses a forbidden branch
 * before creating anything. Reuses an existing worktree on resume so an
 * interrupted run continues from its own commits.
 *
 * A review-only run (team.reviewTarget) branches from the PR head instead, and its
 * base is the PR's base. Its branch is never pushed.
 */
export async function ensureWorkspace(run: Run, repo: Repo, cred: CloneCredential, log: (m: string) => void): Promise<Workspace> {
  const branchName = branchFor(run);
  const review = run.team.reviewTarget ?? null;
  const baseBranch = review?.baseBranch ?? repo.defaultBranch;
  if (isForbiddenBranch(branchName) || isForbiddenBranch(repo.defaultBranch === branchName ? branchName : '')) {
    throw new GitError(`refusing to work on protected branch ${branchName}`);
  }
  const bareDir = join(config.worktreeRoot, 'repos', `${repo.id}.git`);
  const worktreePath = join(config.worktreeRoot, 'runs', run.id);
  await mkdir(join(config.worktreeRoot, 'repos'), { recursive: true });
  await mkdir(join(config.worktreeRoot, 'runs'), { recursive: true });

  const cloneUrl = cred.url;
  if (!(await exists(bareDir))) {
    log(`cloning ${repo.path} (bare)`);
    await git(config.worktreeRoot, ['clone', '--bare', cloneUrl, bareDir]);
  }
  // A `git clone --bare` maps refs into refs/heads, NOT refs/remotes/origin/*, so
  // `origin/<default>` never resolves and a cached clone silently works off a stale
  // base. Force the standard remote-tracking refspec, then always fetch it — a stale
  // base is the difference between a clean PR and a merge conflict, so a failed fetch
  // must be loud, not swallowed.
  await git(bareDir, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']).catch(() => {});
  // `git clone` persists the clone URL — credential and all — as remote.origin.url, and a
  // worktree shares that config. Rewrite it credential-less so an agent inside the worktree
  // can neither read the token (`git remote get-url origin`) nor push with it: `git push`
  // fails auth instead of being merely forbidden by a hook regex. Done on every call so a
  // clone cached before this change is scrubbed too. The worker's own fetch/push always
  // pass cred.url explicitly and never rely on the stored remote.
  await git(bareDir, ['config', 'remote.origin.url', credentialLessUrl(cloneUrl)]);
  // #68: the agent runs as its own user and commits into this clone's object store; keep what git writes group-writable.
  await git(bareDir, ['config', 'core.sharedRepository', 'group']);
  await git(bareDir, ['fetch', '--prune', cloneUrl, '+refs/heads/*:refs/remotes/origin/*'], {}).catch((e) => {
    log(`fetch failed (${(e as Error).message}); using cached clone — the base may be stale`);
  });

  if (await exists(worktreePath)) {
    log(`reusing worktree ${worktreePath}`);
    const resumedUnborn = !(await baseBranchExists(bareDir, baseBranch));
    return { worktreePath, branchName, baseBranch, resumed: true, unborn: resumedUnborn };
  }
  if (review) {
    // The PR's base, fetched loudly (the heads fetch above is best-effort), then the PR
    // head by its provider ref. A ref the remote doesn't serve (the mock's plain origin)
    // falls back to the head branch when it's in this repo.
    await git(bareDir, ['fetch', cloneUrl, `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`]);
    const prRef = `refs/remotes/origin/review/${review.number}`;
    await git(bareDir, ['fetch', cloneUrl, `+${review.fetchRef}:${prRef}`]).catch(async (e) => {
      log(`fetch of ${review.fetchRef} failed (${(e as Error).message}); trying the head branch ${review.headBranch}`);
      await git(bareDir, ['fetch', cloneUrl, `+refs/heads/${review.headBranch}:${prRef}`]);
    });
    await git(bareDir, ['worktree', 'prune']);
    await git(bareDir, ['worktree', 'add', '-B', branchName, worktreePath, prRef]);
    log(`worktree ${worktreePath} on ${branchName} at the head of ${review.url}`);
    return { worktreePath, branchName, baseBranch, resumed: false, unborn: false };
  }
  // Branch from the fetched tip of the default branch. A bare clone keeps branches
  // under refs/heads, and `git fetch origin` updates refs/remotes/origin/* — try the
  // remote-tracking ref first (the live-clone case), fall back to the local ref (a
  // bare clone of a bare/local origin, e.g. tests).
  const born = await baseBranchExists(bareDir, repo.defaultBranch);
  // The worktree is gone (another worker, a cleaned disk) but the run already pushed
  // its branch — e.g. changes requested on its open PR. Rebuild from that branch so the
  // revision lands on top of what the PR has, not on a fresh base.
  const pushed = await git(bareDir, ['rev-parse', '--verify', `refs/remotes/origin/${branchName}^{commit}`]).then(() => true, () => false);
  if (pushed) {
    await git(bareDir, ['worktree', 'prune']);   // forget a registration whose directory was deleted
    await git(bareDir, ['worktree', 'add', '-B', branchName, worktreePath, `origin/${branchName}`]);
    log(`rebuilt worktree ${worktreePath} from origin/${branchName}`);
    return { worktreePath, branchName, baseBranch, resumed: true, unborn: !born };
  }
  if (born) {
    const startRef = await resolveStart(bareDir, repo.defaultBranch);
    await git(bareDir, ['worktree', 'add', '-b', branchName, worktreePath, startRef]);
  } else {
    // Empty origin: no commit to branch from. Create an ORPHAN-branch worktree so the
    // implementer writes the very first files; the first commit + push creates the
    // branch (and, on merge, the repo's default branch) on the remote. git >= 2.42.
    log(`empty repo — creating root worktree on ${branchName}`);
    await git(bareDir, ['worktree', 'add', '--orphan', '-b', branchName, worktreePath]);
  }
  log(`worktree ${worktreePath} on ${branchName}`);
  return { worktreePath, branchName, baseBranch, resumed: false, unborn: !born };
}

const TRAILER_AUTHOR = 'Agentic Software Factory <factory@users.noreply.github.com>';

/** Commit whatever is pending, with trailers. No-op when the tree is clean. Returns the sha, or null. */
export async function commitPending(ws: Workspace, run: Run, role: string, message: string, log: (m: string) => void): Promise<string | null> {
  const status = await git(ws.worktreePath, ['status', '--porcelain']);
  if (status.trim() === '') { log('nothing to commit'); return null; }
  await git(ws.worktreePath, ['add', '-A']);
  const body = `${message}\n\nTicket: ${run.ticketKey}\nRun-Id: ${run.id}\nRole: ${role}\nCo-Authored-By: ${TRAILER_AUTHOR}`;
  await git(ws.worktreePath, ['-c', `user.name=asf-bot`, '-c', 'user.email=factory@users.noreply.github.com', 'commit', '-m', body]);
  const sha = (await git(ws.worktreePath, ['rev-parse', 'HEAD'])).trim();
  log(`committed ${sha.slice(0, 8)}`);
  return sha;
}

/**
 * If HEAD is a WIP commit for this role (subject begins `wip(<role>):`, written by
 * commitWipIfCutShort after a failed/timed-out attempt), return the reason it carries
 * so a re-run's prompt can tell the role to continue from it; else null. Best-effort —
 * an unborn HEAD or any git error reads as "no WIP".
 */
export async function wipAtHead(ws: Workspace, role: string): Promise<string | null> {
  const subject = (await git(ws.worktreePath, ['log', '-1', '--format=%s']).catch(() => '')).trim();
  const prefix = `wip(${role}):`;
  if (!subject.startsWith(prefix)) return null;
  const m = subject.match(/—\s*outcome:\s*(.*)$/);
  return (m ? m[1] : subject.slice(prefix.length)).trim() || null;
}

export async function changedFileCount(ws: Workspace): Promise<number> {
  // The well-known empty tree; diffing HEAD against it counts every file in the first commit.
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const start = ws.unborn ? EMPTY_TREE : await resolveStart(ws.worktreePath, ws.baseBranch);
  const range = ws.unborn ? `${start}..HEAD` : `${start}...HEAD`;
  const out = await git(ws.worktreePath, ['diff', '--name-only', range]);
  return out.split('\n').filter(Boolean).length;
}

export interface DiffStat {
  filesChanged: number; insertions: number; deletions: number;
  files: Array<{ path: string; insertions: number; deletions: number }>;
  patch: string;  // capped
}

/**
 * The diff a single commit introduced (M11 WP2): per-file +/- from --numstat and
 * the full patch, capped so a huge generated diff can't blow up an event/artifact.
 * Best-effort — returns null on any git error (observability must never fail a run).
 */
export async function diffStat(ws: Workspace, sha: string, opts: { maxFiles?: number; maxPatchBytes?: number } = {}): Promise<DiffStat | null> {
  const maxFiles = opts.maxFiles ?? 200;
  const maxPatchBytes = opts.maxPatchBytes ?? 512 * 1024;
  try {
    const numstat = await git(ws.worktreePath, ['show', '--numstat', '--format=', sha]);
    const files = numstat.split('\n').filter(Boolean).map((line) => {
      const [ins, del, ...rest] = line.split('\t');
      return { path: rest.join('\t'), insertions: Number(ins) || 0, deletions: Number(del) || 0 };
    }).slice(0, maxFiles);
    const insertions = files.reduce((s, f) => s + f.insertions, 0);
    const deletions = files.reduce((s, f) => s + f.deletions, 0);
    let patch = await git(ws.worktreePath, ['show', '--format=', sha]);
    if (patch.length > maxPatchBytes) patch = patch.slice(0, maxPatchBytes) + `\n\n… patch truncated at ${maxPatchBytes} bytes …`;
    return { filesChanged: files.length, insertions, deletions, files, patch };
  } catch {
    return null;
  }
}

/** Push the run branch. Refuses forbidden branches again, at the last moment. Worker-only — never the agent. */
export async function pushBranch(ws: Workspace, cred: CloneCredential, log: (m: string) => void): Promise<void> {
  if (isForbiddenBranch(ws.branchName)) throw new GitError(`refusing to push protected branch ${ws.branchName}`);
  // Pushing to a URL has no remote-tracking ref for a bare --force-with-lease to check,
  // so it would demand the branch not exist — refusing every push onto an open PR. Lease
  // on the tip ensureWorkspace fetched instead (empty = the branch must not exist yet).
  const seen = (await git(ws.worktreePath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ws.branchName}`]).catch(() => '')).trim();
  await git(ws.worktreePath, ['push', `--force-with-lease=refs/heads/${ws.branchName}:${seen}`, cred.url, `HEAD:${ws.branchName}`]);
  log(`pushed ${ws.branchName}`);
}

/**
 * First delivery into an empty (unborn) repo: the remote has no default branch, so a
 * PR with base=<default> can't be opened. Create an empty root commit, publish it as
 * the default branch on the remote, and re-parent the orphan work branch onto that
 * root so the PR has a real, mergeable base..head diff. No-op for a born repo.
 */
export async function bootstrapBaseBranch(ws: Workspace, cred: CloneCredential, log: (m: string) => void): Promise<void> {
  if (!ws.unborn) return;
  const base = ws.baseBranch;
  if (isForbiddenBranch(base) && base !== 'main' && base !== 'master') {
    // main/master are the expected defaults; anything else on the forbidden list is a misconfig.
    throw new GitError(`refusing to bootstrap protected base branch ${base}`);
  }
  const author = ['-c', 'user.name=asf-bot', '-c', 'user.email=factory@users.noreply.github.com'];
  // An empty root commit (empty tree, no parent) — the seed of the default branch.
  const emptyTree = (await git(ws.worktreePath, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
  const root = (await git(ws.worktreePath, [...author, 'commit-tree', emptyTree, '-m', 'chore: initialize repository'])).trim();
  // Point the local base branch at the root and publish it to the remote.
  await git(ws.worktreePath, ['branch', '-f', base, root]);
  await git(ws.worktreePath, ['push', cred.url, `${root}:refs/heads/${base}`]);
  log(`bootstrapped ${base} on the remote from an empty root commit`);
  // Re-parent the work branch's history onto the new root so it shares ancestry with base.
  await git(ws.worktreePath, [...author, 'rebase', '--onto', root, '--root', ws.branchName]);
  log(`re-parented ${ws.branchName} onto ${base}`);
}

export async function removeWorktree(worktreePath: string): Promise<void> {
  await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
}

/**
 * Before publishing a born repo: re-anchor the run's work onto the CURRENT tip of the
 * default branch as a single commit, so the PR is never stale (no conflict from a base
 * that moved since the clone) and has clean history. We fetch origin/<base> fresh, then
 * `reset --soft` to it and commit the accumulated tree once — the working tree already
 * holds the delivered files, so this replays them onto the new base in one commit. If
 * the delivered files touch paths that also changed on base, the PR shows a real diff
 * and GitHub merges cleanly (the branch shares base's history). No-op for an unborn repo
 * (bootstrapBaseBranch already re-parented it onto the freshly-created base).
 */
export async function rebaseOntoBase(ws: Workspace, run: Run, cred: CloneCredential, log: (m: string) => void, delivery: Delivery = { type: 'fix', title: '' }): Promise<void> {
  if (ws.unborn) return;
  const base = ws.baseBranch;
  await fetchBase(ws, cred, log);
  const baseRef = await resolveStart(ws.worktreePath, base);
  // Bring the CURRENT base into the run's work as ONE 3-way merge of the whole delivery
  // (not a commit-by-commit replay, which can conflict on an intermediate state the
  // final work no longer has). Already contains the base (e.g. the implementer just
  // resolved a conflict by merging it): nothing to merge, only squash.
  const contains = await git(ws.worktreePath, ['merge-base', '--is-ancestor', baseRef, 'HEAD']).then(() => true, () => false);
  if (!contains) {
    try {
      await git(ws.worktreePath, [...BOT, 'merge', '--no-ff', '--no-edit', '-m', `merge ${base} into ${ws.branchName}`, baseRef]);
    } catch (e) {
      const files = await conflictedFiles(ws);
      await git(ws.worktreePath, ['merge', '--abort']).catch(() => {});
      // Only a real content conflict is handed back to the implementer; anything else
      // (a broken repo, a hook) stays a plain failure with git's own words.
      if (!files.length) throw new GitError(`cannot merge ${base} into the run branch: ${(e as Error).message.split('\n')[0]}`);
      throw new GitError(formatMergeConflict(base, files));
    }
  }
  // Squash the run's commits into one for a clean PR: soft-reset to base (HEAD only),
  // then commit the now-combined index/tree once.
  await git(ws.worktreePath, ['reset', '--soft', baseRef]);
  const status = await git(ws.worktreePath, ['status', '--porcelain']);
  if (status.trim() === '') { log('nothing to publish over the current base'); return; }
  await git(ws.worktreePath, [...BOT, 'commit', '-m', deliveryMessage(run, delivery)]);
  log(`brought ${ws.branchName} up to current ${base} and squashed`);
}

/** What the squashed delivery commit says: its Conventional Commits type (see commit-type.ts) and the ticket title. */
export interface Delivery { type: ChangeType; title: string }

/** `<type>: <KEY> <title>` plus the trailers; `feat!` also gets a `BREAKING CHANGE:` footer. */
export function deliveryMessage(run: Run, d: Delivery): string {
  const title = d.title.replace(/\s+/g, ' ').trim() || 'agent delivery';
  const footer = [
    ...(d.type === 'feat!' ? [`BREAKING CHANGE: ${title}`] : []),
    `Ticket: ${run.ticketKey}`, `Run-Id: ${run.id}`, `Co-Authored-By: ${TRAILER_AUTHOR}`,
  ];
  return `${d.type}: ${run.ticketKey} ${title}\n\n${footer.join('\n')}`;
}

const BOT = ['-c', 'user.name=asf-bot', '-c', 'user.email=factory@users.noreply.github.com'];

async function fetchBase(ws: Workspace, cred: CloneCredential, log: (m: string) => void): Promise<void> {
  const base = ws.baseBranch;
  await git(ws.worktreePath, ['fetch', cred.url, `+refs/heads/${base}:refs/remotes/origin/${base}`]).catch((e) => {
    log(`fetch of ${base} failed (${(e as Error).message}); using the cached base`);
  });
}

/** Paths git left unmerged (both sides changed the same lines). */
export async function conflictedFiles(ws: Workspace): Promise<string[]> {
  const out = await git(ws.worktreePath, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Resolving a merge conflict (the run is re-queued with queued_by 'merge_conflict'):
 * start merging the CURRENT base into the run branch and leave git's conflict markers
 * in the worktree for the implementer to resolve. Returns the conflicted paths; empty
 * means it merged cleanly this time (base moved again) and the merge is committed.
 * A merge already in progress (a retried implementer) is left as it is.
 */
export async function startConflictMerge(ws: Workspace, cred: CloneCredential, log: (m: string) => void): Promise<string[]> {
  if (ws.unborn) return [];
  const inProgress = await git(ws.worktreePath, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).then(() => true, () => false);
  if (inProgress) return conflictedFiles(ws);
  await fetchBase(ws, cred, log);
  const baseRef = await resolveStart(ws.worktreePath, ws.baseBranch);
  try {
    await git(ws.worktreePath, [...BOT, 'merge', '--no-ff', '--no-edit', '-m', `merge ${ws.baseBranch} into ${ws.branchName}`, baseRef]);
    log(`${ws.baseBranch} now merges cleanly; no conflict left to resolve`);
    return [];
  } catch (e) {
    const files = await conflictedFiles(ws);
    if (!files.length) { await git(ws.worktreePath, ['merge', '--abort']).catch(() => {}); throw e; }
    log(`merging ${ws.baseBranch} left conflicts in ${files.join(', ')}`);
    return files;
  }
}

/** Of `files`, those that still carry conflict markers (the agent didn't finish). */
export async function filesWithConflictMarkers(ws: Workspace, files: string[]): Promise<string[]> {
  if (!files.length) return [];
  const out = await git(ws.worktreePath, ['grep', '-l', '-E', '^(<<<<<<<|>>>>>>>)( |$)', '--', ...files]).catch(() => '');
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}
