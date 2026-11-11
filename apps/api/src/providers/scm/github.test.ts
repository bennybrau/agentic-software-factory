import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GithubScmProvider, type GithubScmConfig } from './github.js';
import { ASF_COMMENT_MARKER, type Repo } from '@asf/shared';

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

/** `json` may be a function of the request body (to answer GraphQL by its variables). */
function stubFetch(routes: Array<{ m: string; re: RegExp; status?: number; json?: unknown }>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(url), body });
    const r = routes.find((x) => x.m === method && x.re.test(String(url)));
    if (!r) throw new Error(`no stub for ${method} ${url}`);
    const json = typeof r.json === 'function' ? (r.json as (b: unknown) => unknown)(body) : r.json;
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200,
      json: async () => json, text: async () => JSON.stringify(json) } as Response;
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

// Shaped like GitHub's GraphQL reviewThreads response, two pages.
const ghComment = (databaseId: number, login: string | null, body: string, createdAt: string) =>
  ({ databaseId, author: login ? { login } : null, body, createdAt });
const THREAD_PAGES: Record<string, unknown> = {
  first: { data: { repository: { pullRequest: { reviewThreads: {
    nodes: [
      { id: 'PRRT_kwA1', isResolved: false, path: 'src/x.ts', line: 3, comments: { nodes: [
        ghComment(11, 'alice', 'rename this', '2026-09-14T10:00:00Z'),
        ghComment(12, 'asf-bot', `Renamed in abc123.\n\n${ASF_COMMENT_MARKER}`, '2026-09-14T11:00:00Z'),
        ghComment(13, 'alice', 'thanks', '2026-09-14T12:00:00Z'),
      ] } },
    ],
    pageInfo: { hasNextPage: true, endCursor: 'CUR1' },
  } } } } },
  CUR1: { data: { repository: { pullRequest: { reviewThreads: {
    nodes: [
      { id: 'PRRT_kwA2', isResolved: true, path: 'src/y.ts', line: null, comments: { nodes: [
        ghComment(21, 'asf-bot', `nit: typo\n\n${ASF_COMMENT_MARKER}`, '2026-09-14T10:30:00Z'),
      ] } },
    ],
    pageInfo: { hasNextPage: false, endCursor: 'CUR2' },
  } } } } },
};

test('listReviewComments reads every page of review threads over GraphQL', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/user$/, json: { login: 'asf-bot' } },
    { m: 'POST', re: /\/graphql$/, json: (b: { variables: { cursor: string | null } }) => THREAD_PAGES[b.variables.cursor ?? 'first'] },
  ]);
  try {
    const p = new GithubScmProvider(cfg());
    const ts = await p.listReviewComments(REPO, 5);
    const gql = s.calls.filter((c) => c.url.endsWith('/graphql')).map((c) => (c.body as { variables: Record<string, unknown> }).variables);
    assert.deepEqual(gql, [
      { owner: 'acme', name: 'scratch', number: 5, cursor: null },
      { owner: 'acme', name: 'scratch', number: 5, cursor: 'CUR1' },
    ]);
    assert.deepEqual(ts.map((t) => [t.id, t.resolved, t.path, t.line, t.author, t.authorIsTokenAccount, t.own]), [
      ['PRRT_kwA1', false, 'src/x.ts', 3, 'alice', false, false],
      ['PRRT_kwA2', true, 'src/y.ts', null, 'asf-bot', true, true],
    ]);
    assert.equal(ts[0].body, 'rename this');
    assert.deepEqual(ts[0].replies.map((r) => [r.id, r.author, r.own]), [['12', 'asf-bot', true], ['13', 'alice', false]]);
    assert.deepEqual(ts[1].replies, []);
    // The login is cached: a second read doesn't ask /user again.
    await p.listReviewComments(REPO, 5);
    assert.equal(s.calls.filter((c) => c.url.endsWith('/user')).length, 1);
  } finally { s.restore(); }
});

test('replyToThread posts addPullRequestReviewThreadReply on the thread id, with the marker', async () => {
  const s = stubFetch([
    { m: 'POST', re: /\/graphql$/, json: { data: { addPullRequestReviewThreadReply: { comment: { id: 'PRRC_1' } } } } },
  ]);
  try {
    await new GithubScmProvider(cfg()).replyToThread(REPO, 5, 'PRRT_kwA1', 'Fixed in abc123.');
    const gql = s.calls[0].body as { query: string; variables: { id: string; body: string } };
    assert.match(gql.query, /addPullRequestReviewThreadReply\(input: \{ pullRequestReviewThreadId: \$id, body: \$body \}\)/);
    assert.deepEqual(gql.variables, { id: 'PRRT_kwA1', body: `Fixed in abc123.\n\n${ASF_COMMENT_MARKER}` });
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
    const plain = s.calls.find((c) => /\/issues\/5\/comments$/.test(c.url))!.body as { body: string };
    assert.equal(plain.body, `ship it\n\n${ASF_COMMENT_MARKER}`);
    await p.comment(REPO, 5, 'nit', { path: 'src/x.ts', line: 10 });
    const line = s.calls.find((c) => /\/pulls\/5\/comments$/.test(c.url))!.body as { commit_id: string; line: number; body: string };
    assert.equal(line.commit_id, 'headsha');
    assert.equal(line.line, 10);
    assert.equal(line.body, `nit\n\n${ASF_COMMENT_MARKER}`);
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

test('listChangeRequests matches the whole ticket key, so PROJ-12 does not pick up PROJ-123', async () => {
  const byTitle = { ...PR_JSON, number: 7, title: 'PROJ-12: fix login', head: { ref: 'feat/login', sha: 's' }, node_id: 'PR_7' };
  const byBranch = { ...PR_JSON, number: 8, title: 'fix login', head: { ref: 'agent/PROJ-12-abcd1234', sha: 's' }, node_id: 'PR_8' };
  const longer = { ...PR_JSON, number: 9, title: 'PROJ-123: fix signup', head: { ref: 'agent/PROJ-123-abcd1234', sha: 's' }, node_id: 'PR_9' };
  const s = stubFetch([
    { m: 'GET', re: /\/pulls\?state=all/, json: [byTitle, byBranch, longer] },
    { m: 'GET', re: /\/pulls\/\d+\/reviews/, json: [] },
  ]);
  try {
    const crs = await new GithubScmProvider(cfg()).listChangeRequests(REPO, { ticketKeys: ['PROJ-12'] });
    assert.deepEqual(crs.map((c) => c.number), [7, 8]);
  } finally { s.restore(); }
});

test('listChangeRequests finds a GitHub issue key by its branch form, but not #42 inside #420', async () => {
  const mine = { ...PR_JSON, number: 7, title: 'fix', head: { ref: 'agent/acme-web-42-abcd1234', sha: 's' }, node_id: 'PR_7' };
  const other = { ...PR_JSON, number: 8, title: 'acme/web#420: fix', head: { ref: 'agent/acme-web-420-abcd1234', sha: 's' }, node_id: 'PR_8' };
  const s = stubFetch([
    { m: 'GET', re: /\/pulls\?state=all/, json: [mine, other] },
    { m: 'GET', re: /\/pulls\/\d+\/reviews/, json: [] },
  ]);
  try {
    const crs = await new GithubScmProvider(cfg()).listChangeRequests(REPO, { ticketKeys: ['acme/web#42'] });
    assert.deepEqual(crs.map((c) => c.number), [7]);
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
