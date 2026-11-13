import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GitError } from './git.js';

export interface RepoLockOptions {
  /** Give up waiting after this long. Default 10 min. */
  timeoutMs?: number;
  /** A lock whose mtime is older than this is stale (its holder died). Default 30 s. */
  staleMs?: number;
  /** How often the holder refreshes the lock's mtime. Default 5 s. */
  heartbeatMs?: number;
  /** Stop waiting when this aborts. */
  signal?: AbortSignal;
  /** Test-only: runs after a waiter judges the lock stale and before it takes it over. */
  beforeTakeover?: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const poll = () => sleep(100 + Math.random() * 150);

/**
 * Run `fn` holding a cross-process lock on one bare clone (#124). Every run of a repo shares
 * its bare clone, and setting it up (`git config`, `fetch`, `worktree add`) writes the shared
 * `config` and refs; two workers doing it at once fail on git's own `config.lock`.
 *
 * The lock is the directory `<bareDir>.lock`, made by renaming a fully built temp dir (with
 * an `owner` file) into place: rename onto a non-empty dir fails, so a lock is never empty
 * and never silently replaced. The holder touches it every heartbeat; a lock older than
 * `staleMs` is taken over by moving it aside and deleting it only if the moved dir is the
 * same one (inode and mtime) the waiter judged stale — a fresh lock moved by mistake is put back.
 */
export async function withRepoLock<T>(bareDir: string, fn: () => Promise<T>, opts: RepoLockOptions = {}): Promise<T> {
  const lock = `${bareDir}.lock`;
  const owner = `${process.pid}-${randomUUID()}`;
  await mkdir(dirname(lock), { recursive: true });
  await acquire(lock, owner, opts);
  const beatMs = opts.heartbeatMs ?? 5_000;
  const beat = setInterval(() => { const now = new Date(); utimes(lock, now, now).catch(() => {}); }, beatMs);
  beat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    // Only remove it if it is still ours (it may have been taken over as stale).
    const held = await readFile(join(lock, 'owner'), 'utf8').catch(() => null);
    if (held === owner) await rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}

async function acquire(lock: string, owner: string, opts: RepoLockOptions): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  const staleMs = opts.staleMs ?? 30_000;
  for (;;) {
    if (opts.signal?.aborted) throw new GitError(`gave up waiting for ${lock}: aborted`);
    if (await tryCreate(lock, owner)) return;
    const st = await stat(lock).catch(() => null);
    if (!st) continue;   // released between our attempt and the stat: try again now
    if (Date.now() - st.mtimeMs > staleMs) {
      await opts.beforeTakeover?.();
      const moved = `${lock}.stale-${randomUUID()}`;
      // Only one waiter's rename of a given lock succeeds; the rest go back to waiting.
      if (await rename(lock, moved).then(() => true, () => false)) {
        const was = await stat(moved).catch(() => null);
        // Same inode AND mtime: a freed inode is reused at once, so a fresh lock can share the stale one's.
        if (was && was.ino === st.ino && was.mtimeMs === st.mtimeMs) {
          await rm(moved, { recursive: true, force: true }).catch(() => {});
          continue;
        }
        // We moved a fresh lock someone took in the meantime: put it back.
        await rename(moved, lock).catch(() => rm(moved, { recursive: true, force: true }).catch(() => {}));
      }
    }
    if (Date.now() > deadline) throw new GitError(`timed out waiting for ${lock}`);
    await poll();
  }
}

/** Build a lock dir beside the target and rename it into place. False when the lock is held. */
async function tryCreate(lock: string, owner: string): Promise<boolean> {
  const tmp = `${lock}.tmp-${randomUUID()}`;
  await mkdir(tmp);
  try {
    await writeFile(join(tmp, 'owner'), owner);
    try {
      await rename(tmp, lock);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
      throw e;
    }
    const now = new Date();
    await utimes(lock, now, now).catch(() => {});
    return true;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
