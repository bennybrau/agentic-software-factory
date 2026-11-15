import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChangeRequest, Repo, ScmProvider } from '@asf/shared';
import { ScmSet, qualifyScm, scmConnections } from './set.js';

const repo = (id: string): Repo => ({ id, path: id, url: `https://gitlab.test/${id}`, defaultBranch: 'main', cloneUrl: `https://gitlab.test/${id}.git` });
const cr = (repoId: string): ChangeRequest => ({
  id: '4', number: 4, repoId, url: 'https://gitlab.test/mr/4', title: 'T', state: 'open', draft: true, headBranch: 'h', baseBranch: 'main',
  reviewState: null, ciState: null, updatedAt: '2026-11-01T00:00:00Z',
});

/** A GitLab-like provider that records the repo id every call is handed. */
function recording() {
  const seen: string[] = [];
  const p = {
    kind: 'gitlab' as const,
    preflight: async () => ({ ok: true as const, identity: 'x' }),
    searchRepos: async () => [repo('acme/web'), repo('acme/platform/web/shared-ui')],
    getRepo: async (idOrPath: string) => { seen.push(`getRepo ${idOrPath}`); return repo(idOrPath); },
    cloneCredential: async (r: Repo) => { seen.push(`cloneCredential ${r.id}`); return { url: r.cloneUrl }; },
    openChangeRequest: async (r: Repo) => { seen.push(`openChangeRequest ${r.id}`); return cr(r.id); },
    listChangeRequests: async (r: Repo) => { seen.push(`listChangeRequests ${r.id}`); return [cr(r.id)]; },
    getChangeRequest: async (r: Repo) => { seen.push(`getChangeRequest ${r.id}`); return { ...cr(r.id), diffRefs: null }; },
    listReviewComments: async (r: Repo) => { seen.push(`listReviewComments ${r.id}`); return []; },
    replyToThread: async (r: Repo) => { seen.push(`replyToThread ${r.id}`); },
    comment: async (r: Repo) => { seen.push(`comment ${r.id}`); },
    markReady: async (r: Repo) => { seen.push(`markReady ${r.id}`); },
    merge: async (r: Repo) => { seen.push(`merge ${r.id}`); },
    changedFiles: async (r: Repo) => { seen.push(`changedFiles ${r.id}`); return ['a.ts']; },
  } satisfies ScmProvider;
  return { p, seen };
}

test('repositories out carry their connection and a qualified id; bare and qualified ids both resolve', async () => {
  const { p, seen } = recording();
  const q = qualifyScm(p);
  assert.equal(q.kind, 'gitlab');
  assert.deepEqual((await q.searchRepos('')).map((r) => [r.id, r.connection, r.path]), [
    ['gitlab:acme/web', 'gitlab', 'acme/web'], ['gitlab:acme/platform/web/shared-ui', 'gitlab', 'acme/platform/web/shared-ui'],
  ]);
  assert.equal((await q.getRepo('acme/web')).id, 'gitlab:acme/web');
  assert.equal((await q.getRepo('gitlab:acme/web')).id, 'gitlab:acme/web');
  assert.deepEqual(seen, ['getRepo acme/web', 'getRepo acme/web']);
});

test('every method that takes a Repo hands the provider its native id; change requests come back qualified', async () => {
  const { p, seen } = recording();
  const q = qualifyScm(p);
  for (const r of [await q.getRepo('acme/web'), repo('acme/web')]) {
    seen.length = 0;
    await q.cloneCredential(r);
    assert.equal((await q.openChangeRequest(r, { head: 'h', base: 'main', title: 't', body: '', draft: true })).repoId, 'gitlab:acme/web');
    assert.deepEqual((await q.listChangeRequests(r, {})).map((c) => c.repoId), ['gitlab:acme/web']);
    assert.equal((await q.getChangeRequest(r, 4)).repoId, 'gitlab:acme/web');
    await q.listReviewComments(r, 4); await q.replyToThread(r, 4, 'T1', 'done'); await q.comment(r, 4, 'hi'); await q.markReady(r, 4);
    await q.merge(r, 4, { method: 'squash' });
    assert.deepEqual(await q.changedFiles!(r, 4, 10), ['a.ts']);
    assert.ok(seen.length === 10 && seen.every((s) => s.endsWith(' acme/web')), seen.join(', '));
  }
});

test('a provider without changedFiles still has none', () => {
  const { changedFiles: _, ...without } = recording().p;
  assert.equal(qualifyScm(without).changedFiles, undefined);
});

/** A fake host of `kind` whose repos are `paths`; `down` fails (or throws from) its preflight. */
function host(kind: 'github' | 'gitlab', paths: string[], down?: 'fails' | 'throws') {
  const seen: string[] = [];
  const own = (path: string): Repo => ({ ...repo(path), url: `https://${kind}.test/${path}` });
  const p = {
    kind,
    preflight: async () => {
      if (down === 'throws') throw new Error(`${kind} build failed`);
      return down ? { ok: false as const, reason: `${kind} token rejected` } : { ok: true as const, identity: kind };
    },
    searchRepos: async () => { if (down) throw new Error('down'); return paths.map(own); },
    getRepo: async (idOrPath: string) => { seen.push(`getRepo ${idOrPath}`); return own(idOrPath); },
    openChangeRequest: async (r: Repo) => { seen.push(`openChangeRequest ${r.id}`); return cr(r.id); },
    getChangeRequest: async (r: Repo) => { seen.push(`getChangeRequest ${r.id}`); return { ...cr(r.id), diffRefs: null }; },
  } as unknown as ScmProvider;
  return { p, seen };
}

function twoHosts(opts: { down?: 'fails' | 'throws'; list?: string[] } = {}) {
  const gl = host('gitlab', ['acme/platform/web', 'acme/shared']);
  const gh = host('github', ['acme/web', 'acme/shared'], opts.down);
  const builds: string[] = [];
  const list = opts.list ?? ['gitlab', 'github'];
  const set = new ScmSet(async (kind) => { builds.push(kind); return kind === 'gitlab' ? gl.p : gh.p; }, () => list);
  return { set, gl, gh, builds, list };
}

test('scmConnections: SCM_PROVIDERS split, trimmed, deduped and known-only; empty falls back to SCM_PROVIDER', () => {
  const of = (values: Record<string, string>) => (key: string) => values[key];
  assert.deepEqual(scmConnections(of({ SCM_PROVIDERS: ' gitlab , github,gitlab,svn', SCM_PROVIDER: 'mock' })), ['gitlab', 'github']);
  assert.deepEqual(scmConnections(of({ SCM_PROVIDERS: '', SCM_PROVIDER: 'github' })), ['github']);
  assert.deepEqual(scmConnections(of({ SCM_PROVIDERS: 'svn', SCM_PROVIDER: 'gitlab' })), ['gitlab']);
});

test('scmFor: a qualified ref goes to its host, a bare one to the default, a Repo by its connection; unknown throws', async () => {
  const { set, gl, gh } = twoHosts();
  assert.equal(set.defaultConnection, 'gitlab');
  assert.equal(set.live.kind, 'gitlab');
  assert.deepEqual(set.connections, ['gitlab', 'github']);
  assert.equal((await set.live.getRepo('github:acme/web')).id, 'github:acme/web');
  assert.equal((await set.live.getRepo('acme/platform/web')).id, 'gitlab:acme/platform/web');
  assert.deepEqual(gh.seen, ['getRepo acme/web']);
  assert.deepEqual(gl.seen, ['getRepo acme/platform/web']);
  gh.seen.length = 0; gl.seen.length = 0;
  // A Repo's connection wins over its (bare) id.
  await set.live.openChangeRequest({ ...repo('acme/shared'), connection: 'github' }, { head: 'h', base: 'main', title: 't', body: '', draft: true });
  assert.deepEqual(gh.seen, ['openChangeRequest acme/shared']);
  assert.deepEqual(gl.seen, []);
  assert.throws(() => set.scmFor({ ...repo('x/y'), connection: 'mock' }), /Code connection "mock" is not set up/);
  assert.throws(() => set.registryFor('mock'), /Code connection "mock" is not set up/);
});

test('searchRepos merges every host, each repo with its connection; one host down drops out', async () => {
  assert.deepEqual((await twoHosts().set.live.searchRepos('')).map((r) => r.id),
    ['gitlab:acme/platform/web', 'gitlab:acme/shared', 'github:acme/web', 'github:acme/shared']);
  assert.deepEqual((await twoHosts({ down: 'fails' }).set.live.searchRepos('')).map((r) => [r.id, r.connection]),
    [['gitlab:acme/platform/web', 'gitlab'], ['gitlab:acme/shared', 'gitlab']]);
});

test('readiness: a host whose preflight fails or throws is down with its reason; the others still list repos', async () => {
  for (const down of ['fails', 'throws'] as const) {
    const r = await twoHosts({ down }).set.live.readiness();
    assert.deepEqual(r.hosts, [
      { connection: 'gitlab', ok: true },
      { connection: 'github', ok: false, reason: down === 'fails' ? 'github token rejected' : 'github build failed' },
    ]);
    assert.deepEqual(r.repos.map((x) => x.id), ['gitlab:acme/platform/web', 'gitlab:acme/shared']);
  }
});

test('invalidate reaches every host; a changed connection list adds and drops hosts', async () => {
  const { set, builds, list } = twoHosts();
  await set.live.searchRepos('');
  assert.deepEqual(builds.sort(), ['github', 'gitlab']);
  set.invalidate();
  await set.live.searchRepos('');
  assert.equal(builds.length, 4);
  list.splice(0, list.length, 'github');
  assert.equal(set.defaultConnection, 'github');
  assert.throws(() => set.registryFor('gitlab'), /not set up/);
  assert.equal((await set.live.getRepo('acme/web')).id, 'github:acme/web');
});
