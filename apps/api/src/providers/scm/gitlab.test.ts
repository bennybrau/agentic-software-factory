import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitlabScmProvider, type GitlabScmConfig } from './gitlab.js';
import type { Repo } from '@asf/shared';

const PROJECT_JSON = {
  id: 42,
  path_with_namespace: 'acme/scratch',
  web_url: 'https://gitlab.com/acme/scratch',
  default_branch: 'main',
  http_url_to_repo: 'https://gitlab.com/acme/scratch.git',
  permissions: { project_access: { access_level: 40 }, group_access: null },
};
const MR_JSON = {
  iid: 5,
  web_url: 'https://gitlab.com/acme/scratch/-/merge_requests/5',
  title: 'Draft: ASF: fix thing',
  state: 'opened',
  draft: true,
  work_in_progress: true,
  source_branch: 'agent/scratch-1-abc',
  target_branch: 'main',
  updated_at: '2026-09-14T10:00:00Z',
  sha: 'headsha',
  diff_refs: { base_sha: 'basesha', head_sha: 'headsha', start_sha: 'startsha' },
  head_pipeline: { status: 'running' },
};
const REPO: Repo = { id: 'acme/scratch', path: 'acme/scratch', url: PROJECT_JSON.web_url, defaultBranch: 'main', cloneUrl: PROJECT_JSON.http_url_to_repo };

const cfg = (over: Partial<GitlabScmConfig> = {}): GitlabScmConfig => ({
  baseUrl: 'https://gitlab.com', token: 'gltok', repos: ['acme/scratch'], ...over,
});

function stubFetch(routes: Array<{ m: string; re: RegExp; status?: number; json?: unknown }>) {
  const calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({
      method, url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const r = routes.find((x) => x.m === method && x.re.test(String(url)));
    if (!r) throw new Error(`no stub for ${method} ${url}`);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200,
      json: async () => r.json, text: async () => JSON.stringify(r.json) } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('getRepo maps to neutral Repo (url-encoded project path)', async () => {
  const s = stubFetch([{ m: 'GET', re: /\/projects\/acme%2Fscratch$/, json: PROJECT_JSON }]);
  try {
    const r = await new GitlabScmProvider(cfg()).getRepo('acme/scratch');
    assert.deepEqual(r, REPO);
    // path must be url-encoded as :id
    assert.ok(s.calls.some((c) => c.url.includes('/projects/acme%2Fscratch')));
    // auth via PRIVATE-TOKEN header
    assert.equal(s.calls[0].headers['PRIVATE-TOKEN'], 'gltok');
  } finally { s.restore(); }
});

test('cloneCredential returns oauth2-tokenized HTTPS URL for clone+push', async () => {
  const { url } = await new GitlabScmProvider(cfg()).cloneCredential(REPO);
  assert.equal(url, 'https://oauth2:gltok@gitlab.com/acme/scratch.git');
});

test('openChangeRequest posts an MR, prefixes Draft:, maps iid→number', async () => {
  const s = stubFetch([
    { m: 'POST', re: /\/merge_requests$/, json: MR_JSON },
    { m: 'GET', re: /\/merge_requests\/5\/approvals$/, json: { approved: false } },
  ]);
  try {
    const cr = await new GitlabScmProvider(cfg()).openChangeRequest(REPO, {
      head: 'agent/scratch-1-abc', base: 'main', title: 'ASF: fix thing', body: 'body', draft: true,
    });
    assert.equal(cr.number, 5);
    assert.equal(cr.draft, true);
    assert.equal(cr.state, 'open');
    assert.equal(cr.headBranch, 'agent/scratch-1-abc');
    assert.equal(cr.baseBranch, 'main');
    assert.equal(cr.ciState, 'running');
    assert.equal(cr.url, 'https://gitlab.com/acme/scratch/-/merge_requests/5');
    const post = s.calls.find((c) => c.method === 'POST')!.body as { title: string; source_branch: string };
    assert.equal(post.title, 'Draft: ASF: fix thing');
    assert.equal(post.source_branch, 'agent/scratch-1-abc');
  } finally { s.restore(); }
});

test('review state: approved via /approvals; diffRefs mapped', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/merge_requests\/5$/, json: MR_JSON },
    { m: 'GET', re: /\/merge_requests\/5\/approvals$/, json: { approved: true } },
  ]);
  try {
    const cr = await new GitlabScmProvider(cfg()).getChangeRequest(REPO, 5);
    assert.equal(cr.reviewState, 'approved');
    assert.deepEqual(cr.diffRefs, { headSha: 'headsha', baseSha: 'basesha', startSha: 'startsha' });
  } finally { s.restore(); }
});

test('markReady strips the Draft: title prefix via PUT', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/merge_requests\/5$/, json: MR_JSON },
    { m: 'PUT', re: /\/merge_requests\/5$/, json: { ...MR_JSON, title: 'ASF: fix thing', draft: false } },
  ]);
  try {
    await new GitlabScmProvider(cfg()).markReady(REPO, 5);
    const put = s.calls.find((c) => c.method === 'PUT')!.body as { title: string };
    assert.equal(put.title, 'ASF: fix thing');
  } finally { s.restore(); }
});

test('markReady is a no-op when the MR is not a draft', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/merge_requests\/5$/, json: { ...MR_JSON, title: 'ASF: fix thing' } },
  ]);
  try {
    await new GitlabScmProvider(cfg()).markReady(REPO, 5);
    assert.ok(!s.calls.some((c) => c.method === 'PUT'), 'no PUT when already ready');
  } finally { s.restore(); }
});

test('merge maps squash method to squash=true', async () => {
  const s = stubFetch([{ m: 'PUT', re: /\/merge_requests\/5\/merge$/, json: { state: 'merged' } }]);
  try {
    await new GitlabScmProvider(cfg()).merge(REPO, 5, { method: 'squash' });
    const put = s.calls.find((c) => c.method === 'PUT')!.body as { squash: boolean };
    assert.equal(put.squash, true);
  } finally { s.restore(); }
});

test('comment: plain body → note; anchored → positioned discussion', async () => {
  const s = stubFetch([
    { m: 'POST', re: /\/merge_requests\/5\/notes$/, json: {} },
    { m: 'GET', re: /\/merge_requests\/5$/, json: MR_JSON },
    { m: 'POST', re: /\/merge_requests\/5\/discussions$/, json: {} },
  ]);
  try {
    const p = new GitlabScmProvider(cfg());
    await p.comment(REPO, 5, 'ship it');
    assert.ok(s.calls.some((c) => /\/merge_requests\/5\/notes$/.test(c.url)));
    await p.comment(REPO, 5, 'nit', { path: 'src/x.ts', line: 10 });
    const disc = s.calls.find((c) => /\/discussions$/.test(c.url))!.body as { position: { new_line: number; head_sha: string; new_path: string } };
    assert.equal(disc.position.new_line, 10);
    assert.equal(disc.position.new_path, 'src/x.ts');
    assert.equal(disc.position.head_sha, 'headsha');
  } finally { s.restore(); }
});

test('listReviewComments drops system notes and maps position', async () => {
  const notes = [
    { id: 1, author: { username: 'alice' }, body: 'real comment', created_at: '2026-09-14T10:00:00Z', system: false, resolvable: true, resolved: false, position: { new_path: 'src/x.ts', new_line: 3 } },
    { id: 2, author: { username: 'gitlab-bot' }, body: 'changed the milestone', created_at: '2026-09-14T10:01:00Z', system: true },
  ];
  const s = stubFetch([{ m: 'GET', re: /\/merge_requests\/5\/notes/, json: notes }]);
  try {
    const cs = await new GitlabScmProvider(cfg()).listReviewComments(REPO, 5);
    assert.equal(cs.length, 1);
    assert.equal(cs[0].author, 'alice');
    assert.equal(cs[0].path, 'src/x.ts');
    assert.equal(cs[0].line, 3);
    assert.equal(cs[0].resolved, false);
  } finally { s.restore(); }
});

test('listChangeRequests filters by ticket key in title or branch', async () => {
  const other = { ...MR_JSON, iid: 6, title: 'unrelated', source_branch: 'feat/x' };
  const s = stubFetch([
    { m: 'GET', re: /\/merge_requests\?/, json: [MR_JSON, other] },
    { m: 'GET', re: /\/merge_requests\/5\/approvals$/, json: { approved: false } },
    { m: 'GET', re: /\/merge_requests\/6\/approvals$/, json: { approved: false } },
  ]);
  try {
    const crs = await new GitlabScmProvider(cfg()).listChangeRequests(REPO, { ticketKeys: ['ASF'] });
    assert.deepEqual(crs.map((c) => c.number), [5]);
  } finally { s.restore(); }
});

test('listChangeRequests matches the whole ticket key, so PROJ-12 does not pick up PROJ-123', async () => {
  const byTitle = { ...MR_JSON, iid: 7, title: 'PROJ-12: fix login', source_branch: 'feat/login' };
  const byBranch = { ...MR_JSON, iid: 8, title: 'fix login', source_branch: 'agent/PROJ-12-abcd1234' };
  const longer = { ...MR_JSON, iid: 9, title: 'PROJ-123: fix signup', source_branch: 'agent/PROJ-123-abcd1234' };
  const s = stubFetch([
    { m: 'GET', re: /\/merge_requests\?/, json: [byTitle, byBranch, longer] },
    { m: 'GET', re: /\/merge_requests\/\d+\/approvals$/, json: { approved: false } },
  ]);
  try {
    const crs = await new GitlabScmProvider(cfg()).listChangeRequests(REPO, { ticketKeys: ['PROJ-12'] });
    assert.deepEqual(crs.map((c) => c.number), [7, 8]);
  } finally { s.restore(); }
});

test('preflight returns username; fails on empty token and on below-Developer access', async () => {
  assert.deepEqual(await new GitlabScmProvider(cfg({ token: '' })).preflight(), { ok: false, reason: 'GITLAB_TOKEN is empty' });
  const s = stubFetch([
    { m: 'GET', re: /\/user$/, json: { username: 'octocat' } },
    { m: 'GET', re: /\/projects\/acme%2Fscratch$/, json: { ...PROJECT_JSON, permissions: { project_access: { access_level: 20 }, group_access: null } } },
  ]);
  try {
    assert.deepEqual(await new GitlabScmProvider(cfg()).preflight(), { ok: false, reason: 'token lacks push access to acme/scratch' });
  } finally { s.restore(); }
});

test('preflight passes with Developer+ access', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/user$/, json: { username: 'octocat' } },
    { m: 'GET', re: /\/projects\/acme%2Fscratch$/, json: PROJECT_JSON },
  ]);
  try {
    assert.deepEqual(await new GitlabScmProvider(cfg()).preflight(), { ok: true, identity: 'octocat' });
  } finally { s.restore(); }
});

test('preflight explains a bad token and a missing project in plain words, not raw API JSON', async () => {
  let s = stubFetch([{ m: 'GET', re: /\/user$/, status: 401, json: { message: 'Bad credentials' } }]);
  try {
    const r = await new GitlabScmProvider(cfg()).preflight();
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /rejected the saved access token/);
    assert.doesNotMatch(r.reason ?? '', /\{/);
  } finally { s.restore(); }
  s = stubFetch([
    { m: 'GET', re: /\/user$/, json: { username: 'octocat' } },
    { m: 'GET', re: /\/projects\/acme%2Fscratch$/, status: 404, json: { message: 'Not Found' } },
  ]);
  try {
    assert.deepEqual(await new GitlabScmProvider(cfg()).preflight(),
      { ok: false, reason: 'GitLab can’t find the project acme/scratch. Check the spelling (group/project), or that octocat has access to it.' });
  } finally { s.restore(); }
});

function stubPagedDiffs(totalFiles: number) {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const page = Number(new URL(String(url)).searchParams.get('page'));
    const start = (page - 1) * 100;
    const names = Array.from({ length: Math.max(0, Math.min(100, totalFiles - start)) },
      (_, i) => `file-${start + i}.ts`);
    return { ok: true, status: 200, json: async () => names.map((new_path) => ({ new_path })), text: async () => '[]' } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('changedFiles pages until a short page, under the cap', async () => {
  const s = stubPagedDiffs(150);
  try {
    const files = await new GitlabScmProvider(cfg()).changedFiles(REPO, 5, 500);
    assert.equal(files.length, 150);
    assert.equal(s.calls.length, 2);
  } finally { s.restore(); }
});

test('changedFiles stops paging once the 500 cap is reached', async () => {
  const s = stubPagedDiffs(600);
  try {
    const files = await new GitlabScmProvider(cfg()).changedFiles(REPO, 5, 1000);
    assert.equal(files.length, 500);
    assert.equal(s.calls.length, 5);
  } finally { s.restore(); }
});
