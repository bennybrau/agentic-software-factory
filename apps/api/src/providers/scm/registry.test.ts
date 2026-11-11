import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScmProvider } from '@asf/shared';
import { ScmProviderRegistry } from './registry.js';

/** A do-nothing ScmProvider whose kind/preflight we can assert on. Only the fields the registry touches are real. */
function fake(kind: string): ScmProvider {
  return {
    kind: kind as ScmProvider['kind'],
    async preflight() { return { ok: true as const, identity: `id-${kind}` }; },
    async searchRepos() { return []; },
    async getRepo() { throw new Error('not used'); },
    async cloneCredential() { return { url: 'mock://clone' }; },
    async openChangeRequest() { throw new Error('not used'); },
    async listChangeRequests() { return []; },
    async getChangeRequest() { throw new Error('not used'); },
    async listReviewComments() { return []; },
    async replyToThread() {},
    async comment() {},
    async markReady() {},
    async merge() {},
  };
}

test('current() builds once and caches until invalidate()', async () => {
  let builds = 0;
  const reg = new ScmProviderRegistry(async (k) => { builds += 1; return fake(k); }, () => 'mock');

  const a = await reg.current();
  const b = await reg.current();
  assert.equal(builds, 1, 'second current() must not rebuild');
  assert.equal(a, b, 'same instance returned while clean');

  reg.invalidate();
  const c = await reg.current();
  assert.equal(builds, 2, 'invalidate() forces exactly one rebuild');
  assert.notEqual(a, c, 'a fresh instance after invalidate');
  await reg.current();
  assert.equal(builds, 2, 'no rebuild once clean again');
});

test('current() reads the live kind at build time, not a boot snapshot', async () => {
  let kind = 'github';
  const reg = new ScmProviderRegistry(async (k) => fake(k), () => kind);

  assert.equal((await reg.current()).kind, 'github');
  kind = 'gitlab';
  // No invalidate yet -> still the cached github instance.
  assert.equal((await reg.current()).kind, 'github');
  reg.invalidate();
  assert.equal((await reg.current()).kind, 'gitlab', 'rebuild picks up the new kind');
});

test('concurrent current() during a build share one in-flight build', async () => {
  let builds = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const reg = new ScmProviderRegistry(async (k) => { builds += 1; await gate; return fake(k); }, () => 'mock');

  const p1 = reg.current();
  const p2 = reg.current();
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(builds, 1, 'two concurrent callers trigger exactly one build');
  assert.equal(a, b);
});

test('an invalidate() arriving mid-build re-dirties so the next current() rebuilds', async () => {
  let builds = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const reg = new ScmProviderRegistry(async (k) => { builds += 1; await gate; return fake(k); }, () => 'mock');

  const inflight = reg.current();
  reg.invalidate();      // arrives while the first build is still pending
  release();
  await inflight;
  assert.equal(builds, 1);
  await reg.current();   // must rebuild because we were re-dirtied mid-build
  assert.equal(builds, 2, 'invalidate during a build is not lost');
});

test('a failed build re-dirties so the next current() retries', async () => {
  let builds = 0;
  const reg = new ScmProviderRegistry(async (k) => {
    builds += 1;
    if (builds === 1) throw new Error('boom');
    return fake(k);
  }, () => 'mock');

  await assert.rejects(reg.current(), /boom/);
  const p = await reg.current();
  assert.equal(builds, 2, 'a failed build does not get cached; next call retries');
  assert.equal(p.kind, 'mock');
});

test('live proxy forwards to the current instance and survives a hot-swap', async () => {
  let kind = 'github';
  const reg = new ScmProviderRegistry(async (k) => fake(k), () => kind);

  // Force the first build via a forwarded call.
  assert.deepEqual(await reg.live.preflight(), { ok: true, identity: 'id-github' });
  assert.equal(reg.live.kind, 'github');

  kind = 'gitlab';
  reg.invalidate();
  assert.deepEqual(await reg.live.preflight(), { ok: true, identity: 'id-gitlab' }, 'proxy reflects the swap');
  assert.equal(reg.live.kind, 'gitlab');
});
