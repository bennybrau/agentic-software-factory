import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GithubScmProvider, type GithubScmConfig } from './github.js';
import type { Repo } from '@asf/shared';

const REPO_JSON = {
  full_name: 'acme/scratch', html_url: 'https://github.com/acme/scratch',
  default_branch: 'main', clone_url: 'https://github.com/acme/scratch.git', id: 123,
  permissions: { push: true },
};
const PR_JSON = {
  number: 5, html_url: 'https://github.com/acme/scratch/pull/5', title: 'ASF: fix thing',
  draft: true, state: 'open', merged_at: null, node_id: 'PR_kwABC',
  head: { ref: 'agent/scratch-1-abc', sha: 'headsha' }, base: { ref: 'main', sha: 'basesha' },
  updated_at: '2026-09-14T10:00:00Z',
};
const REPO: Repo = { id: 'acme/scratch', path: 'acme/scratch', url: REPO_JSON.html_url, defaultBranch: 'main', cloneUrl: REPO_JSON.clone_url };

const cfg = (over: Partial<GithubScmConfig> = {}): GithubScmConfig => ({
  token: 'ghtok', repos: ['acme/scratch'], apiUrl: 'https://api.github.com',
  graphqlUrl: 'https://api.github.com/graphql', host: 'github.com', ...over,
});

function stubFetch(routes: Array<{ m: string; re: RegExp; status?: number; json?: unknown }>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes.find((x) => x.m === method && x.re.test(String(url)));
    if (!r) throw new Error(`no stub for ${method} ${url}`);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200,
      json: async () => r.json, text: async () => JSON.stringify(r.json) } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('getRepo maps to neutral Repo', async () => {
  const s = stubFetch([{ m: 'GET', re: /\/repos\/acme\/scratch$/, json: REPO_JSON }]);
  try {
    const r = await new GithubScmProvider(cfg()).getRepo('acme/scratch');
    assert.deepEqual(r, REPO);
  } finally { s.restore(); }
});

test('cloneCredential returns tokenized HTTPS URL for clone+push', async () => {
  const { url } = await new GithubScmProvider(cfg()).cloneCredential(REPO);
  assert.equal(url, 'https://x-access-token:ghtok@github.com/acme/scratch.git');
});

test('openChangeRequest posts a draft PR and maps it', async () => {
  const s = stubFetch([
    { m: 'POST', re: /\/repos\/acme\/scratch\/pulls$/, json: PR_JSON },
    { m: 'GET', re: /\/pulls\/5\/reviews/, json: [] },
  ]);
  try {
    const cr = await new GithubScmProvider(cfg()).openChangeRequest(REPO, {
      head: 'agent/scratch-1-abc', base: 'main', title: 'ASF: fix thing', body: 'body', draft: true,
    });
    assert.equal(cr.number, 5);
    assert.equal(cr.draft, true);
    assert.equal(cr.state, 'open');
    assert.equal(cr.headBranch, 'agent/scratch-1-abc');
    assert.equal(cr.url, 'https://github.com/acme/scratch/pull/5');
    const post = s.calls.find((c) => c.method === 'POST')!.body as { draft: boolean };
    assert.equal(post.draft, true);
  } finally { s.restore(); }
});

test('closed with merged_at not yet set: asks the merge endpoint, and a 204 means merged', async () => {
  // PR #231 was read 1s after its merge as closed/merged_at null, and the run was marked
  // "closed without merging", so the split part waiting on it never started.
  const closed = { ...PR_JSON, state: 'closed', merged_at: null };
  const s = stubFetch([
    { m: 'GET', re: /\/pulls\/5$/, json: closed },
    { m: 'GET', re: /\/pulls\/5\/merge$/, status: 204 },
    { m: 'GET', re: /\/pulls\/5\/reviews/, json: [] },
  ]);
  try {
    assert.equal((await new GithubScmProvider(cfg()).getChangeRequest(REPO, 5)).state, 'merged');
  } finally { s.restore(); }
});

test('closed and the merge endpoint says 404: closed without merging', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/pulls\/5$/, json: { ...PR_JSON, state: 'closed', merged_at: null } },
    { m: 'GET', re: /\/pulls\/5\/merge$/, status: 404, json: { message: 'Not Found' } },
    { m: 'GET', re: /\/pulls\/5\/reviews/, json: [] },
  ]);
  try {
    assert.equal((await new GithubScmProvider(cfg()).getChangeRequest(REPO, 5)).state, 'closed');
  } finally { s.restore(); }
});

test('closed and the merge check errors: throws, so the watcher retries instead of guessing', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/pulls\/5$/, json: { ...PR_JSON, state: 'closed', merged_at: null } },
    { m: 'GET', re: /\/pulls\/5\/merge$/, status: 502, json: { message: 'Bad Gateway' } },
  ]);
  try {
    await assert.rejects(new GithubScmProvider(cfg()).getChangeRequest(REPO, 5), /502/);
  } finally { s.restore(); }
});

test('review state: latest decisive review wins', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/pulls\/5$/, json: PR_JSON },
    { m: 'GET', re: /\/pulls\/5\/reviews/, json: [{ state: 'CHANGES_REQUESTED' }, { state: 'APPROVED' }] },
  ]);
  try {
    const cr = await new GithubScmProvider(cfg()).getChangeRequest(REPO, 5);
    assert.equal(cr.reviewState, 'approved');
    assert.deepEqual(cr.diffRefs, { headSha: 'headsha', baseSha: 'basesha' });
  } finally { s.restore(); }
});

test('markReady calls GraphQL markPullRequestReadyForReview with the node id', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/pulls\/5$/, json: PR_JSON },
    { m: 'POST', re: /\/graphql$/, json: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } },
  ]);
  try {
    await new GithubScmProvider(cfg()).markReady(REPO, 5);
    const gql = s.calls.find((c) => c.url.endsWith('/graphql'))!.body as { query: string; variables: { id: string } };
    assert.match(gql.query, /markPullRequestReadyForReview/);
    assert.equal(gql.variables.id, 'PR_kwABC');
  } finally { s.restore(); }
});

test('merge uses the requested method', async () => {
  const s = stubFetch([{ m: 'PUT', re: /\/pulls\/5\/merge$/, json: { merged: true } }]);
  try {
    await new GithubScmProvider(cfg()).merge(REPO, 5, { method: 'squash' });
    const put = s.calls.find((c) => c.method === 'PUT')!.body as { merge_method: string };
    assert.equal(put.merge_method, 'squash');
  } finally { s.restore(); }
});

test('comment: plain body → issue comment; anchored → review line comment', async () => {
  const s = stubFetch([
    { m: 'POST', re: /\/issues\/5\/comments$/, json: {} },
    { m: 'GET', re: /\/pulls\/5$/, json: PR_JSON },
    { m: 'POST', re: /\/pulls\/5\/comments$/, json: {} },
  ]);
  try {
    const p = new GithubScmProvider(cfg());
    await p.comment(REPO, 5, 'ship it');
    assert.ok(s.calls.some((c) => /\/issues\/5\/comments$/.test(c.url)));
    await p.comment(REPO, 5, 'nit', { path: 'src/x.ts', line: 10 });
    const line = s.calls.find((c) => /\/pulls\/5\/comments$/.test(c.url))!.body as { commit_id: string; line: number };
    assert.equal(line.commit_id, 'headsha');
    assert.equal(line.line, 10);
  } finally { s.restore(); }
});

test('listChangeRequests filters by ticket key in title or branch', async () => {
  const other = { ...PR_JSON, number: 6, title: 'unrelated', head: { ref: 'feat/x', sha: 's' }, node_id: 'PR_x' };
  const s = stubFetch([
    { m: 'GET', re: /\/pulls\?state=all/, json: [PR_JSON, other] },
    { m: 'GET', re: /\/pulls\/5\/reviews/, json: [] },
    { m: 'GET', re: /\/pulls\/6\/reviews/, json: [] },
  ]);
  try {
    const crs = await new GithubScmProvider(cfg()).listChangeRequests(REPO, { ticketKeys: ['ASF'] });
    assert.deepEqual(crs.map((c) => c.number), [5]);
  } finally { s.restore(); }
});

test('preflight returns login; fails on empty token and on no-push permission', async () => {
  assert.deepEqual(await new GithubScmProvider(cfg({ token: '' })).preflight(), { ok: false, reason: 'GITHUB_TOKEN is empty' });
  const s = stubFetch([
    { m: 'GET', re: /\/user$/, json: { login: 'octocat' } },
    { m: 'GET', re: /\/repos\/acme\/scratch$/, json: { ...REPO_JSON, permissions: { push: false } } },
  ]);
  try {
    assert.deepEqual(await new GithubScmProvider(cfg()).preflight(), { ok: false, reason: 'token lacks push access to acme/scratch' });
  } finally { s.restore(); }
});

test('preflight explains a bad token and a missing repository in plain words, not raw API JSON', async () => {
  let s = stubFetch([{ m: 'GET', re: /\/user$/, status: 401, json: { message: 'Bad credentials' } }]);
  try {
    const r = await new GithubScmProvider(cfg()).preflight();
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /rejected the saved access token/);
    assert.doesNotMatch(r.reason ?? '', /\{/);
  } finally { s.restore(); }
  s = stubFetch([
    { m: 'GET', re: /\/user$/, json: { login: 'octocat' } },
    { m: 'GET', re: /\/repos\/acme\/scratch$/, status: 404, json: { message: 'Not Found' } },
  ]);
  try {
    assert.deepEqual(await new GithubScmProvider(cfg()).preflight(),
      { ok: false, reason: 'GitHub can’t find the repository acme/scratch. Check the spelling (owner/name), or that octocat has access to it.' });
  } finally { s.restore(); }
});

function stubPagedFiles(totalFiles: number) {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const page = Number(new URL(String(url)).searchParams.get('page'));
    const start = (page - 1) * 100;
    const names = Array.from({ length: Math.max(0, Math.min(100, totalFiles - start)) },
      (_, i) => `file-${start + i}.ts`);
    return { ok: true, status: 200, json: async () => names.map((filename) => ({ filename })), text: async () => '[]' } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('changedFiles pages until a short page, under the cap', async () => {
  const s = stubPagedFiles(150);
  try {
    const files = await new GithubScmProvider(cfg()).changedFiles(REPO, 5, 500);
    assert.equal(files.length, 150);
    assert.equal(s.calls.length, 2);
  } finally { s.restore(); }
});

test('changedFiles stops paging once the 500 cap is reached', async () => {
  const s = stubPagedFiles(600);
  try {
    const files = await new GithubScmProvider(cfg()).changedFiles(REPO, 5, 1000);
    assert.equal(files.length, 500);
    assert.equal(s.calls.length, 5);
  } finally { s.restore(); }
});
