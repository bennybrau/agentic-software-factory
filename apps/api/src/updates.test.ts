import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareSemver, latestRelease, checkNow, updateStatus, startUpdateChecks, __resetUpdates } from './updates.js';

const json = (body: unknown, init: { status?: number; link?: string } = {}) =>
  new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...(init.link ? { link: init.link } : {}) } });

/** A registry stub: token, then the tag pages in order (each may name the next with a Link header). */
function stubRegistry(pages: Array<{ tags: string[]; link?: string }>, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url));
    const u = new URL(String(url));
    if (u.pathname === '/token') return json({ token: 't' });
    const page = Number(u.searchParams.get('page') ?? 0);
    return json({ name: 'x', tags: pages[page].tags }, { link: pages[page].link });
  }) as unknown as typeof fetch;
}
const silent = { info: () => {}, error: () => {} };
const REPO = 'ghcr.io/bennybrau/asf-api';

afterEach(() => {
  delete process.env.ASF_BUILD_VERSION;
  delete process.env.UPDATE_CHECK_ENABLED;
  mock.timers.reset();
  __resetUpdates();
});

test('parseVersion: release tags and describe builds; dev and junk are null', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseVersion('v0.1.0-5-gabc123'), { major: 0, minor: 1, patch: 0 });
  for (const s of ['dev', '', 'latest', 'v1.2', 'sha-abc', 'v1.2.3-rc1']) assert.equal(parseVersion(s), null, s);
});

test('compareSemver orders numerically, and a describe build equals its tag', () => {
  const v = (s: string) => parseVersion(s)!;
  assert.ok(compareSemver(v('v1.10.0'), v('v1.9.9')) > 0);
  assert.ok(compareSemver(v('v1.2.3'), v('v2.0.0')) < 0);
  assert.equal(compareSemver(v('v0.1.0-5-gabc123'), v('v0.1.0')), 0);
  assert.ok(compareSemver(v('v0.1.0-5-gabc123'), v('v0.2.0')) < 0);
});

test('latestRelease: only strict vX.Y.Z tags count, across Link pages', async () => {
  const calls: string[] = [];
  const f = stubRegistry([
    { tags: ['latest', 'sha-abc', '0.1', '1.2', 'v1.2.3', 'v9.0.0-rc1'], link: '</v2/bennybrau/asf-api/tags/list?page=1>; rel="next"' },
    { tags: ['v1.10.0', 'v1.9.0', '2.0.0'] },
  ], calls);
  assert.equal(await latestRelease(REPO, f), 'v1.10.0');
  assert.equal(calls[0], 'https://ghcr.io/token?scope=repository:bennybrau/asf-api:pull');
  assert.equal(calls.length, 3);
  assert.equal(calls[2], 'https://ghcr.io/v2/bennybrau/asf-api/tags/list?page=1');
});

test('latestRelease: no release tag at all is null', async () => {
  assert.equal(await latestRelease(REPO, stubRegistry([{ tags: ['latest', 'sha-abc'] }])), null);
});

test('checkNow: newer release is available; equal describe build is not', async () => {
  process.env.ASF_BUILD_VERSION = 'v0.1.0-5-gabc123';
  let s = await checkNow(stubRegistry([{ tags: ['v0.2.0'] }]));
  assert.equal(s.available, true);
  assert.equal(s.latest, 'v0.2.0');
  assert.equal(s.error, null);
  assert.equal(s.canApply, false);
  assert.ok(s.checkedAt);
  s = await checkNow(stubRegistry([{ tags: ['v0.1.0'] }]));
  assert.equal(s.available, false);
  assert.deepEqual(updateStatus(), s);
});

test('checkNow: a dev build never reports an update', async () => {
  const s = await checkNow(stubRegistry([{ tags: ['v99.0.0'] }]));
  assert.equal(s.current, 'dev');
  assert.equal(s.latest, 'v99.0.0');
  assert.equal(s.available, false);
});

test('checkNow: token error, tags error and a network throw land in error, never thrown', async () => {
  const tokenFail = (async () => json({}, { status: 401 })) as unknown as typeof fetch;
  let s = await checkNow(tokenFail);
  assert.match(s.error!, /token answered 401/);
  assert.ok(s.checkedAt);

  const tagsFail = (async (url: string) => (String(url).includes('/token') ? json({ token: 't' }) : json({}, { status: 404 }))) as unknown as typeof fetch;
  s = await checkNow(tagsFail);
  assert.match(s.error!, /tags\/list answered 404/);

  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  s = await checkNow(down);
  assert.equal(s.error, 'fetch failed');
  assert.equal(s.available, false);
});

test('latestRelease: rejects a repo without a host/name slash', async () => {
  await assert.rejects(latestRelease('not-a-repo'), /host\/name/);
});

test('checkNow: concurrent calls share one in-flight check', async () => {
  const calls: string[] = [];
  const f = stubRegistry([{ tags: ['v1.0.0'] }], calls);
  const [a, b] = await Promise.all([checkNow(f), checkNow(f)]);
  assert.equal(calls.length, 2, 'token + one tags page, not four');
  assert.deepEqual(a, b);
});

test('timer: nothing while the setting is off; checks once it is turned on', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-10-01T00:00:00Z') });
  process.env.UPDATE_CHECK_ENABLED = 'false';
  const calls: string[] = [];
  const stop = startUpdateChecks(silent, stubRegistry([{ tags: ['v1.0.0'] }], calls));
  const flush = () => new Promise((r) => setImmediate(r));
  await flush();
  assert.equal(calls.length, 0, 'no boot check while off');
  mock.timers.tick(3_600_000);
  await flush();
  assert.equal(calls.length, 0, 'no tick check while off');

  process.env.UPDATE_CHECK_ENABLED = 'true';
  mock.timers.tick(3_600_000);
  await flush();
  assert.equal(calls.length, 2, 'token + one tags page');
  assert.equal(updateStatus().latest, 'v1.0.0');

  mock.timers.tick(3_600_000);
  await flush();
  assert.equal(calls.length, 2, 'not again within a day');
  mock.timers.tick(23 * 3_600_000);
  await flush();
  assert.equal(calls.length, 4, 'again after a day');
  stop();
});
