import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerBrowserRoutes } from './browser.js';
import { MockTicketProvider } from '../providers/tickets/mock.js';
import { MockScmProvider } from '../providers/scm/mock.js';
import type { Repo, ReviewThread } from '@asf/shared';

// The needs-human answer/skip routes are a thin surface over registry RPCs.
// Stub the registry and assert the HTTP calls map to answerNeedsHuman/skipNeedsHuman.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; delete process.env.HIVE_DASHBOARD_URL; });

function stub() {
  const calls: Array<{ op: string; body: Record<string, unknown> }> = [];
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string };
    calls.push({ op: body.op, body: body as unknown as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, result: { ok: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return calls;
}

async function app() {
  const a = Fastify();
  registerBrowserRoutes(a, { tickets: new MockTicketProvider(), scm: new MockScmProvider() });
  await a.ready();
  return a;
}

test('POST /api/runs/:id/answer forwards the reply to answerNeedsHuman', async () => {
  const calls = stub();
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/runs/run_1/answer', payload: { reply: 'use oauth', by: 'jon' } });
  assert.equal(res.statusCode, 200);
  const call = calls.find((c) => c.op === 'answerNeedsHuman')!;
  assert.equal(call.body.runId, 'run_1');
  assert.equal(call.body.reply, 'use oauth');
  assert.equal(call.body.by, 'jon');
  await a.close();
});

test('POST /api/runs/:id/answer rejects an empty reply before hitting the registry', async () => {
  const calls = stub();
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/runs/run_1/answer', payload: { reply: '   ' } });
  assert.equal(res.statusCode, 400);
  assert.ok(!calls.some((c) => c.op === 'answerNeedsHuman'), 'must not call the registry on a blank reply');
  await a.close();
});

test('POST /api/runs/:id/request-changes forwards the feedback to requestChanges', async () => {
  const calls = stub();
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/runs/run_1/request-changes', payload: { message: 'rename the flag', by: 'jon' } });
  assert.equal(res.statusCode, 200);
  const call = calls.find((c) => c.op === 'requestChanges')!;
  assert.deepEqual([call.body.runId, call.body.body, call.body.by], ['run_1', 'rename the flag', 'jon']);
  const blank = await a.inject({ method: 'POST', url: '/api/runs/run_1/request-changes', payload: { message: '  ' } });
  assert.equal(blank.statusCode, 400);
  assert.equal(calls.filter((c) => c.op === 'requestChanges').length, 1, 'a blank message never reaches the registry');
  await a.close();
});

test('POST /api/runs/:id/request-changes returns 409 with the registry\'s reason when refused', async () => {
  global.fetch = (async () => new Response(JSON.stringify({ error: 'chat_error', reason: 'the pull request is already merged; dispatch a new run for further changes' }),
    { status: 409, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/runs/run_1/request-changes', payload: { message: 'more' } });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().reason, /already merged/);
  await a.close();
});

test('POST /api/runs/:id/skip forwards to skipNeedsHuman', async () => {
  const calls = stub();
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/runs/run_1/skip', payload: { by: 'jon' } });
  assert.equal(res.statusCode, 200);
  const call = calls.find((c) => c.op === 'skipNeedsHuman')!;
  assert.equal(call.body.runId, 'run_1');
  await a.close();
});

function stubRunDetail(opts: {
  ticketId: string; adhocTask?: { recurringId?: string | null; recurringTitle?: string | null; body?: string } | null;
  artifacts?: { name: string; content: string }[];
}) {
  const artifacts = (opts.artifacts ?? []).map((a) => ({ ...a, updatedAt: '' }));
  const versions = artifacts.map((a) => ({ name: a.name, content: a.content, taskId: null, attempt: null, source: 'agent', createdAt: '' }));
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string };
    const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    switch (body.op) {
      case 'getRun': return reply({ run: { id: 'run_1', ticketId: opts.ticketId }, tasks: [] });
      case 'listGates': return reply({ gates: [] });
      case 'listArtifacts': return reply({ artifacts });
      case 'listArtifactVersions': return reply({ versions });
      case 'listMessages': return reply({ messages: [] });
      case 'getSplitFamily': return reply(null);
      case 'getAdhoc':
        return opts.adhocTask === null
          ? reply({ task: null })
          : reply({ task: { id: opts.ticketId, key: opts.ticketId, title: 't', body: '', createdAt: new Date().toISOString(), attachments: [], ...opts.adhocTask } });
      default: return reply({});
    }
  }) as unknown as typeof fetch;
}

test('GET /api/runs/:id on an adhoc run started by a schedule adds recurring: { id, title }', async () => {
  stubRunDetail({ ticketId: 'adhoc:t1', adhocTask: { recurringId: 'rec_1', recurringTitle: 'Dead code sweep' } });
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_1' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().recurring, { id: 'rec_1', title: 'Dead code sweep' });
  await a.close();
});

test('GET /api/runs/:id on an adhoc run whose schedule was deleted gives recurring with a null title', async () => {
  stubRunDetail({ ticketId: 'adhoc:t1', adhocTask: { recurringId: 'rec_1', recurringTitle: null } });
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_1' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().recurring, { id: 'rec_1', title: null });
  await a.close();
});

test('GET /api/runs/:id on an adhoc run gives the opening request without the chat\'s repository list', async () => {
  stubRunDetail({ ticketId: 'adhoc:t1', adhocTask: { body: 'Fix the **login** page.\n\nRepositories connected:\n- org/web' } });
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_1' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().request, 'Fix the **login** page.');
  await a.close();
});

const FACTS = [{ id: 'aaaaaaaa1111', kind: 'gotcha', text: 'Never edit an applied migration', scope: 'global' }];

test('GET /api/runs/:id keeps hive-brief.json out of both artifact lists and returns it as hiveBrief', async () => {
  process.env.HIVE_DASHBOARD_URL = ' https://hive.example.com// ';
  stubRunDetail({ ticketId: 'JIRA-1', artifacts: [{ name: 'hive-brief.json', content: JSON.stringify(FACTS) }, { name: 'plan.md', content: 'the plan' }] });
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_1' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.artifacts.map((x: { name: string }) => x.name), ['plan.md']);
  assert.deepEqual(body.artifactVersions.map((x: { name: string }) => x.name), ['plan.md']);
  assert.deepEqual(body.hiveBrief, { facts: FACTS, dashboardUrl: 'https://hive.example.com' });
  await a.close();
});

test('GET /api/runs/:id: hiveBrief has a null dashboardUrl when the setting is blank', async () => {
  stubRunDetail({ ticketId: 'JIRA-1', artifacts: [{ name: 'hive-brief.json', content: JSON.stringify(FACTS) }] });
  const a = await app();
  assert.deepEqual((await a.inject({ method: 'GET', url: '/api/runs/run_1' })).json().hiveBrief, { facts: FACTS, dashboardUrl: null });
  await a.close();
});

test('GET /api/runs/:id: no hive-brief.json, bad JSON or [] gives hiveBrief: null', async () => {
  for (const artifacts of [[], [{ name: 'hive-brief.json', content: '{not json' }], [{ name: 'hive-brief.json', content: '[]' }]]) {
    stubRunDetail({ ticketId: 'JIRA-1', artifacts });
    const a = await app();
    const body = (await a.inject({ method: 'GET', url: '/api/runs/run_1' })).json();
    assert.equal(body.hiveBrief, null);
    assert.deepEqual(body.artifacts, []);
    await a.close();
  }
});

test('GET /api/runs/:id on a tracker-ticket run has recurring: null and never calls the ad-hoc store', async () => {
  const calls: string[] = [];
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string };
    calls.push(body.op);
    const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    switch (body.op) {
      case 'getRun': return reply({ run: { id: 'run_1', ticketId: 'JIRA-1' }, tasks: [] });
      case 'listGates': return reply({ gates: [] });
      case 'listArtifacts': return reply({ artifacts: [] });
      case 'listArtifactVersions': return reply({ versions: [] });
      case 'listMessages': return reply({ messages: [] });
      case 'getSplitFamily': return reply(null);
      default: return reply({});
    }
  }) as unknown as typeof fetch;
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_1' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().recurring, null);
  assert.equal(res.json().request, null);
  assert.ok(!calls.includes('getAdhoc'), 'a non-adhoc ticket must never hit the ad-hoc store');
  await a.close();
});

test('GET /api/runs maps filter + pagination query params to the listRuns RPC', async () => {
  const calls = stub();
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/api/runs?state=failed&teamName=standard&deliveryOutcome=merged&search=ASF-9&since=2026-01-01T00:00:00.000Z&limit=25&offset=50' });
  assert.equal(res.statusCode, 200);
  const call = calls.find((c) => c.op === 'listRuns')!;
  assert.equal(call.body.state, 'failed');
  assert.equal(call.body.teamName, 'standard');
  assert.equal(call.body.deliveryOutcome, 'merged');
  assert.equal(call.body.search, 'ASF-9');
  assert.equal(call.body.since, '2026-01-01T00:00:00.000Z');
  assert.equal(call.body.limit, 25);
  assert.equal(call.body.offset, 50);
  await a.close();
});

test('GET /api/runs defaults page size to 25 and omits blank filters', async () => {
  const calls = stub();
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/api/runs' });
  assert.equal(res.statusCode, 200);
  const call = calls.find((c) => c.op === 'listRuns')!;
  assert.equal(call.body.limit, 25);
  assert.equal(call.body.offset, 0);
  assert.equal(call.body.state, undefined);
  assert.equal(call.body.search, undefined);
  await a.close();
});

// Posting a review-only run's review to its PR: a stub registry with the run, its
// review.md and events, and an SCM that records comments and won't anchor one path.
class RecordingScm extends MockScmProvider {
  comments: Array<{ number: number; body: string; anchor?: { path: string; line: number } }> = [];
  constructor(private failPath: string | null = null) { super(); }
  override async comment(_repo: unknown, number: number, body: string, anchor?: { path: string; line: number }) {
    if (anchor && anchor.path === this.failPath) throw new Error('line not in diff');
    this.comments.push({ number, body, anchor });
  }
}

const REVIEW_TARGET = { url: 'https://github.com/example/app/pull/7', number: 7, headBranch: 'feat', baseBranch: 'main', fetchRef: 'refs/pull/7/head' };
function stubReviewRun(opts: { state?: string; reviewTarget?: typeof REVIEW_TARGET | null; reviewMd?: string | null; events?: Array<{ kind: string; seq: number }> } = {}) {
  const appended: Array<Record<string, unknown>> = [];
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string; input?: Record<string, unknown> };
    const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    switch (body.op) {
      case 'getRun': return reply({ run: { id: 'run_1', ticketId: 'adhoc:t1', state: opts.state ?? 'succeeded', repoId: '1',
        team: { reviewTarget: opts.reviewTarget === undefined ? REVIEW_TARGET : opts.reviewTarget } }, tasks: [] });
      case 'listArtifacts': return reply({ artifacts: opts.reviewMd === null ? [] : [{ name: 'review.md', content: opts.reviewMd ?? 'APPROVE', updatedAt: '' }] });
      case 'getEvents': return reply({ events: opts.events ?? [] });
      case 'appendEvent': appended.push(body.input!); return reply({ event: {} });
      default: return reply({});
    }
  }) as unknown as typeof fetch;
  return appended;
}

async function reviewApp(scm: RecordingScm) {
  const a = Fastify();
  registerBrowserRoutes(a, { tickets: new MockTicketProvider(), scm });
  await a.ready();
  return a;
}

test('POST /api/runs/:id/review/post posts line comments, a summary with what could not be anchored, and records review:posted', async () => {
  const appended = stubReviewRun({ reviewMd: 'REQUEST_CHANGES\n\nTwo problems.\n- `src/a.ts:3` — null check\n  missing on retry\n- `src/gone.ts:9` — stale import' });
  const scm = new RecordingScm('src/gone.ts');
  const a = await reviewApp(scm);
  const res = await a.inject({ method: 'POST', url: '/api/runs/run_1/review/post', payload: { by: 'jon' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, anchored: 1, fallback: 1 });
  assert.deepEqual(scm.comments[0], { number: 7, body: 'null check\nmissing on retry', anchor: { path: 'src/a.ts', line: 3 } });
  assert.equal(scm.comments.length, 2);
  const summary = scm.comments[1];
  assert.equal(summary.anchor, undefined);
  assert.ok(summary.body.startsWith('**ASF review (run run_1)**'), summary.body);
  assert.match(summary.body, /REQUEST_CHANGES\n\nTwo problems\./);
  assert.match(summary.body, /### Couldn't anchor\n\n- `src\/gone\.ts:9` — stale import/);
  assert.deepEqual(appended, [{ runId: 'run_1', taskId: null, kind: 'review:posted', source: 'human', payload: { anchored: 1, fallback: 1, by: 'jon' } }]);
  await a.close();
});

test('POST /api/runs/:id/review/post skips the summary comment when there is nothing to say', async () => {
  stubReviewRun({ reviewMd: '- `src/a.ts:3` — null check' });
  const scm = new RecordingScm();
  const a = await reviewApp(scm);
  const res = await a.inject({ method: 'POST', url: '/api/runs/run_1/review/post', payload: {} });
  assert.deepEqual(res.json(), { ok: true, anchored: 1, fallback: 0 });
  assert.equal(scm.comments.length, 1);
  await a.close();
});

test('POST /api/runs/:id/review/post 404s when the run does not exist', async () => {
  global.fetch = (async () => new Response(JSON.stringify({ ok: true, result: null }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const scm = new RecordingScm();
  const a = await reviewApp(scm);
  const res = await a.inject({ method: 'POST', url: '/api/runs/run_missing/review/post', payload: {} });
  assert.equal(res.statusCode, 404);
  assert.equal(scm.comments.length, 0);
  await a.close();
});

test('POST /api/runs/:id/review/post refuses with a reason and posts nothing', async () => {
  const cases: Array<[Parameters<typeof stubReviewRun>[0], RegExp]> = [
    [{ reviewTarget: null }, /not a review/],
    [{ state: 'running' }, /not finished/],
    [{ reviewMd: null }, /no review\.md/],
    [{ events: [{ kind: 'run:succeeded', seq: 1 }, { kind: 'review:posted', seq: 2 }] }, /already posted/],
  ];
  for (const [opts, reason] of cases) {
    const appended = stubReviewRun(opts);
    const scm = new RecordingScm();
    const a = await reviewApp(scm);
    const res = await a.inject({ method: 'POST', url: '/api/runs/run_1/review/post', payload: {} });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().reason, reason);
    assert.equal(scm.comments.length, 0);
    assert.equal(appended.length, 0);
    await a.close();
  }
});

// GET /api/runs/:id/tasks/:taskId/activity: one task's tool events, paged.
function stubEvents(seqs: number[]) {
  const calls: Array<Record<string, unknown>> = [];
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    calls.push(body);
    const limit = body.limit as number;
    const events = (body.afterSeq !== undefined ? seqs.slice(0, limit) : seqs.slice(-limit)).map((seq) => ({ seq, kind: 'tool:pre' }));
    return new Response(JSON.stringify({ ok: true, result: { events } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return calls;
}

test('GET activity: latest page says whether there is earlier history', async () => {
  const a = await app();
  let calls = stubEvents([1, 2, 3, 4, 5]);
  let res = await a.inject({ method: 'GET', url: '/api/runs/run_1/tasks/task_1/activity?limit=3' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().events.map((e: { seq: number }) => e.seq), [3, 4, 5]);
  assert.equal(res.json().hasEarlier, true);
  assert.deepEqual([calls[0].op, calls[0].runId, calls[0].taskId, calls[0].limit], ['getTaskEvents', 'run_1', 'task_1', 4]);
  assert.deepEqual(calls[0].kinds, ['tool:pre', 'tool:post', 'tool:denied']);

  calls = stubEvents([1, 2]);
  res = await a.inject({ method: 'GET', url: '/api/runs/run_1/tasks/task_1/activity?before=3&limit=3' });
  assert.deepEqual(res.json(), { events: [{ seq: 1, kind: 'tool:pre' }, { seq: 2, kind: 'tool:pre' }], hasEarlier: false });
  assert.equal(calls[0].beforeSeq, 3);

  calls = stubEvents([6, 7, 8, 9]);
  res = await a.inject({ method: 'GET', url: '/api/runs/run_1/tasks/task_1/activity?after=5&limit=3' });
  assert.deepEqual(res.json().events.map((e: { seq: number }) => e.seq), [6, 7, 8]);
  assert.equal(res.json().hasEarlier, false);
  assert.deepEqual([calls[0].afterSeq, calls[0].limit], [5, 3]);
  await a.close();
});

test('GET activity: exactly limit events is the whole history; limit + 1 drops the oldest', async () => {
  const a = await app();
  for (const qs of ['limit=3', 'before=10&limit=3']) {
    stubEvents([4, 5, 6]);
    let res = await a.inject({ method: 'GET', url: `/api/runs/run_1/tasks/task_1/activity?${qs}` });
    assert.deepEqual(res.json().events.map((e: { seq: number }) => e.seq), [4, 5, 6], qs);
    assert.equal(res.json().hasEarlier, false, qs);

    stubEvents([3, 4, 5, 6]);
    res = await a.inject({ method: 'GET', url: `/api/runs/run_1/tasks/task_1/activity?${qs}` });
    assert.deepEqual(res.json().events.map((e: { seq: number }) => e.seq), [4, 5, 6], qs);
    assert.equal(res.json().hasEarlier, true, qs);
  }
  await a.close();
});

test('GET activity: a bad query is a 400 and never reaches the registry', async () => {
  const a = await app();
  const calls = stubEvents([]);
  for (const qs of ['limit=0', 'limit=abc', 'limit=1000', 'before=-1', 'before=0', 'after=x', 'before=5&after=2']) {
    const res = await a.inject({ method: 'GET', url: `/api/runs/run_1/tasks/task_1/activity?${qs}` });
    assert.equal(res.statusCode, 400, qs);
  }
  assert.equal(calls.length, 0);
  await a.close();
});

// Addressing review threads (#109): a run with PR #1 on the mock SCM, whose state the
// test sets, and a stub registry that records requestChanges and appendEvent.
class ThreadsScm extends MockScmProvider {
  writes: string[] = [];
  constructor(private state: 'open' | 'merged' | 'closed' = 'open', private fail: string | null = null) { super(); }
  override async getChangeRequest(repo: Repo, number: number) {
    if (this.fail) throw new Error(this.fail);
    return { id: '1', number, repoId: repo.id, url: 'https://github.com/example/app/pull/1', title: 't', state: this.state, draft: false,
      headBranch: 'feat', baseBranch: 'main', reviewState: null, ciState: null, updatedAt: '', diffRefs: null };
  }
  override async replyToThread() { this.writes.push('replyToThread'); }
  override async comment() { this.writes.push('comment'); }
  override async markReady() { this.writes.push('markReady'); }
  override async merge() { this.writes.push('merge'); }
}

const reviewReply = (id: string, own = false) => ({ id, author: own ? 'asf' : 'bo', own, body: `reply ${id}`, createdAt: '' });
function reviewThread(id: string, over: Partial<ReviewThread> = {}): ReviewThread {
  return { id, resolved: false, path: 'src/a.ts', line: 3, author: 'ana', authorIsTokenAccount: false, own: false, body: `body ${id}`, createdAt: '', replies: [], ...over };
}

function stubThreadsRun(opts: { changeRequestNumber?: number | null; requestChanges409?: string } = {}) {
  const requested: Array<Record<string, unknown>> = [];
  const appended: Array<Record<string, unknown>> = [];
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string; input?: Record<string, unknown> };
    const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    switch (body.op) {
      case 'getRun': return reply({ run: { id: 'run_1', ticketId: 'JIRA-1', state: 'succeeded', repoId: '1',
        changeRequestUrl: 'https://github.com/example/app/pull/1',
        changeRequestNumber: opts.changeRequestNumber === undefined ? 1 : opts.changeRequestNumber, team: {} }, tasks: [] });
      case 'requestChanges':
        if (opts.requestChanges409) return new Response(JSON.stringify({ error: 'chat_error', reason: opts.requestChanges409 }), { status: 409, headers: { 'content-type': 'application/json' } });
        requested.push(body as unknown as Record<string, unknown>); return reply({ message: {} });
      case 'appendEvent': appended.push(body.input!); return reply({ event: {} });
      default: return reply({});
    }
  }) as unknown as typeof fetch;
  return { requested, appended };
}

async function threadsApp(scm: ThreadsScm, threads: ReviewThread[] = []) {
  scm.seedThreads(1, threads);
  const a = Fastify();
  registerBrowserRoutes(a, { tickets: new MockTicketProvider(), scm });
  await a.ready();
  return a;
}

test('GET /api/runs/:id/review-threads lists only the addressable threads, own replies stripped', async () => {
  stubThreadsRun();
  const scm = new ThreadsScm();
  const a = await threadsApp(scm, [
    reviewThread('t1', { replies: [reviewReply('r1', true), reviewReply('r2')] }),
    reviewThread('t2', { resolved: true }),
    reviewThread('t3', { own: true }),
    reviewThread('t4', { replies: [reviewReply('r3', true)] }),
  ]);
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_1/review-threads' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.eligible, true);
  assert.equal(body.reason, null);
  assert.equal(body.url, 'https://github.com/example/app/pull/1');
  assert.deepEqual(body.threads.map((t: ReviewThread) => t.id), ['t1']);
  assert.deepEqual(body.threads[0].replies.map((r: { id: string }) => r.id), ['r2']);
  assert.deepEqual(scm.writes, []);
  await a.close();
});

test('GET /api/runs/:id/review-threads is not eligible, with the reason, when there is nothing to address', async () => {
  const cases: Array<[Parameters<typeof stubThreadsRun>[0], ThreadsScm, ReviewThread[], RegExp]> = [
    [{ changeRequestNumber: null }, new ThreadsScm(), [reviewThread('t1')], /no open pull request/],
    [{}, new ThreadsScm('merged'), [reviewThread('t1')], /already merged/],
    [{}, new ThreadsScm('closed'), [reviewThread('t1')], /already closed/],
    [{}, new ThreadsScm('open', 'boom'), [reviewThread('t1')], /couldn't read the pull request: boom/],
    [{}, new ThreadsScm(), [reviewThread('t2', { resolved: true })], /no open review threads to address/],
  ];
  for (const [opts, scm, threads, reason] of cases) {
    stubThreadsRun(opts);
    const a = await threadsApp(scm, threads);
    const res = await a.inject({ method: 'GET', url: '/api/runs/run_1/review-threads' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().eligible, false);
    assert.match(res.json().reason, reason);
    assert.deepEqual(res.json().threads, []);
    await a.close();
  }
});

test('GET /api/runs/:id/review-threads 404s for a missing run', async () => {
  global.fetch = (async () => new Response(JSON.stringify({ ok: true, result: null }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const a = await threadsApp(new ThreadsScm());
  assert.equal((await a.inject({ method: 'GET', url: '/api/runs/run_x/review-threads' })).statusCode, 404);
  await a.close();
});

test('POST address-review-comments sends only the chosen threads and records review_threads:sent', async () => {
  const { requested, appended } = stubThreadsRun();
  const scm = new ThreadsScm();
  const a = await threadsApp(scm, [
    reviewThread('t1'), reviewThread('t2'), reviewThread('t3'),
    reviewThread('t4', { resolved: true }), reviewThread('t5', { own: true }),
  ]);
  const res = await a.inject({ method: 'POST', url: '/api/runs/run_1/address-review-comments',
    payload: { threadIds: ['t1', 't3', 't4', 't5'], note: 'Rename only.', by: 'jon' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, sentIds: ['t1', 't3'], notSentIds: [] });
  assert.equal(requested.length, 1);
  const text = requested[0].body as string;
  assert.deepEqual([requested[0].runId, requested[0].by], ['run_1', 'jon']);
  assert.ok(text.includes('### Thread t1 ') && text.includes('### Thread t3 '));
  for (const id of ['t2', 't4', 't5']) assert.ok(!text.includes(`body ${id}`), id);
  assert.match(text, /### Note from jon\n\nRename only\.$/);
  assert.deepEqual(appended, [{ runId: 'run_1', taskId: null, kind: 'review_threads:sent', source: 'human',
    payload: { number: 1, url: 'https://github.com/example/app/pull/1', threadIds: ['t1', 't3'], notSent: [] } }]);
  assert.deepEqual(scm.writes, []);
  await a.close();
});

test('POST address-review-comments: 25 chosen send 20, and a long body is cut', async () => {
  const { requested, appended } = stubThreadsRun();
  const threads = Array.from({ length: 25 }, (_, i) => reviewThread(`t${i + 1}`, i === 0 ? { body: 'x'.repeat(3000) } : {}));
  const a = await threadsApp(new ThreadsScm(), threads);
  const res = await a.inject({ method: 'POST', url: '/api/runs/run_1/address-review-comments', payload: { threadIds: threads.map((t) => t.id) } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().sentIds.length, 20);
  assert.deepEqual(res.json().notSentIds, ['t21', 't22', 't23', 't24', 't25']);
  const text = requested[0].body as string;
  assert.match(text, /> … \(cut at 2,000 characters\)/);
  assert.ok(!text.includes('x'.repeat(2001)));
  assert.match(text, /### Not sent \(over the limit\)\n\n- t21 \(@ana\)/);
  assert.deepEqual((appended[0].payload as { notSent: string[] }).notSent, ['t21', 't22', 't23', 't24', 't25']);
  await a.close();
});

test('POST address-review-comments: bad or stale thread ids are a 400 and reach nothing', async () => {
  for (const payload of [{}, { threadIds: [] }, { threadIds: 't1' }, { threadIds: ['t9'] }, { threadIds: ['t2'] }]) {
    const { requested, appended } = stubThreadsRun();
    const a = await threadsApp(new ThreadsScm(), [reviewThread('t1'), reviewThread('t2', { resolved: true })]);
    const res = await a.inject({ method: 'POST', url: '/api/runs/run_1/address-review-comments', payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(requested.length + appended.length, 0);
    await a.close();
  }
});

test('POST address-review-comments refuses with 409 when the PR is gone or the registry says no', async () => {
  const cases: Array<[Parameters<typeof stubThreadsRun>[0], ThreadsScm, RegExp]> = [
    [{ changeRequestNumber: null }, new ThreadsScm(), /no open pull request/],
    [{}, new ThreadsScm('merged'), /already merged/],
    [{}, new ThreadsScm('closed'), /already closed/],
    [{ requestChanges409: 'the run is still running' }, new ThreadsScm(), /still running/],
  ];
  for (const [opts, scm, reason] of cases) {
    const { appended } = stubThreadsRun(opts);
    const a = await threadsApp(scm, [reviewThread('t1')]);
    const res = await a.inject({ method: 'POST', url: '/api/runs/run_1/address-review-comments', payload: { threadIds: ['t1'] } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'request_changes_refused');
    assert.match(res.json().reason, reason);
    assert.equal(appended.length, 0);
    assert.deepEqual(scm.writes, []);
    await a.close();
  }
});
