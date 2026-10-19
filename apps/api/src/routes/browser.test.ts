import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerBrowserRoutes } from './browser.js';
import { MockTicketProvider } from '../providers/tickets/mock.js';
import { MockScmProvider } from '../providers/scm/mock.js';

// The needs-human answer/skip routes are a thin surface over registry RPCs.
// Stub the registry and assert the HTTP calls map to answerNeedsHuman/skipNeedsHuman.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

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

function stubRunDetail(opts: { ticketId: string; adhocTask?: { recurringId?: string | null; recurringTitle?: string | null; body?: string } | null }) {
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string };
    const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    switch (body.op) {
      case 'getRun': return reply({ run: { id: 'run_1', ticketId: opts.ticketId }, tasks: [] });
      case 'listGates': return reply({ gates: [] });
      case 'listArtifacts': return reply({ artifacts: [] });
      case 'listArtifactVersions': return reply({ versions: [] });
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
