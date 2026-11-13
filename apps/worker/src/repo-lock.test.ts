import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRepoLock } from './repo-lock.js';

let root: string;
before(async () => { root = await mkdtemp(join(tmpdir(), 'asf-lock-')); });
after(async () => { await rm(root, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const exists = (p: string) => stat(p).then(() => true, () => false);

/** A lock left by a holder that died: an owner file and an mtime a minute ago. */
async function staleLock(bareDir: string, owner = 'dead') {
  const lock = `${bareDir}.lock`;
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'owner'), owner);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  return lock;
}

test('a waiter blocks until the holder releases, and a throwing holder releases too', async () => {
  const bare = join(root, 'a.git');
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const order: string[] = [];
  const first = withRepoLock(bare, async () => { order.push('first in'); await held; order.push('first out'); });
  await sleep(50);
  const second = withRepoLock(bare, async () => { order.push('second in'); });
  await sleep(400);
  assert.deepEqual(order, ['first in'], 'the second waits');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first in', 'first out', 'second in']);
  assert.equal(await exists(`${bare}.lock`), false);

  await assert.rejects(withRepoLock(bare, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await exists(`${bare}.lock`), false, 'released on throw');
  assert.equal(await withRepoLock(bare, async () => 'ok', { timeoutMs: 1_000 }), 'ok');
});

test('6 waiters on one stale lock: at most one is ever inside', async () => {
  const bare = join(root, 'b.git');
  await staleLock(bare);
  let inside = 0;
  let most = 0;
  let done = 0;
  // Every waiter judges the lock stale, then they take it over one after another, each while the
  // previous one holds it: the race the inode check exists for.
  let n = 0;
  const beforeTakeover = () => sleep(20 + 40 * n++);
  await Promise.all(Array.from({ length: 6 }, () => withRepoLock(bare, async () => {
    inside++; most = Math.max(most, inside);
    await sleep(100);
    inside--; done++;
  }, { beforeTakeover })));
  assert.equal(done, 6);
  assert.equal(most, 1);
});

test('a fresh lock moved aside by a waiter that judged the old one stale is put back', async () => {
  const bare = join(root, 'c.git');
  const lock = await staleLock(bare);
  let entered = false;
  const waiter = withRepoLock(bare, async () => { entered = true; }, {
    // Between the stale check and the takeover, the dead holder's lock is replaced by a live one.
    beforeTakeover: async () => {
      if (await readFile(join(lock, 'owner'), 'utf8').catch(() => '') !== 'dead') return;
      // Built before the old one goes, so it can't reuse the old inode.
      const tmp = `${lock}.live`;
      await mkdir(tmp);
      await writeFile(join(tmp, 'owner'), 'alive');
      await rm(lock, { recursive: true, force: true });
      await rename(tmp, lock);
    },
  });
  await sleep(400);
  assert.equal(entered, false, 'the waiter did not take the live lock');
  assert.equal(await readFile(join(lock, 'owner'), 'utf8'), 'alive', 'the live lock is back in place');
  await rm(lock, { recursive: true, force: true });   // the live holder releases
  await waiter;
  assert.equal(entered, true);
});

test('gives up after the timeout', async () => {
  const bare = join(root, 'd.git');
  await mkdir(`${bare}.lock`, { recursive: true });
  await writeFile(join(`${bare}.lock`, 'owner'), 'someone');
  await assert.rejects(withRepoLock(bare, async () => {}, { timeoutMs: 300 }), /timed out waiting/);
});
