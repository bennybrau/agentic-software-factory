import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChangeRequest, Repo, ScmProvider } from '@asf/shared';
import { qualifyScm } from './set.js';

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
