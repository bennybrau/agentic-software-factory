import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRunRoutes } from './runs.js';
import { config } from '../config.js';
import { MockTicketProvider } from '../providers/tickets/mock.js';
import { MockScmProvider } from '../providers/scm/mock.js';
import { clearHiveBriefCache } from '../hive.js';
import type { Repo, ScmProvider, Ticket, TicketProvider } from '@asf/shared';

// GET /api/runs/:id/cancel-requested (M8 WP A): how a hookless runtime learns of a
// cancel. Worker-only, so it is behind X-Run-Secret like /context and /events.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; delete process.env.HIVE_URL; clearHiveBriefCache(); });

function stubGetRun(run: { cancelRequestedAt: string | null } | null) {
  global.fetch = (async () => new Response(JSON.stringify({ ok: true, result: run ? { run, tasks: [] } : null }),
    { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

async function app() {
  const a = Fastify();
  registerRunRoutes(a, { tickets: new MockTicketProvider(), scm: new MockScmProvider() });
  await a.ready();
  return a;
}
const secret = () => ({ 'x-run-secret': config.runEventSecret });

test('cancel-requested: true once the run carries cancelRequestedAt', async () => {
  stubGetRun({ cancelRequestedAt: new Date().toISOString() });
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_1/cancel-requested', headers: secret() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { cancelRequested: true });
  await a.close();
});

test('cancel-requested: false for a live run and for an unknown run', async () => {
  const a = await app();
  stubGetRun({ cancelRequestedAt: null });
  assert.deepEqual((await a.inject({ method: 'GET', url: '/api/runs/run_1/cancel-requested', headers: secret() })).json(), { cancelRequested: false });
  stubGetRun(null);
  assert.deepEqual((await a.inject({ method: 'GET', url: '/api/runs/nope/cancel-requested', headers: secret() })).json(), { cancelRequested: false });
  await a.close();
});

test('cancel-requested: refused without the run secret', async () => {
  stubGetRun({ cancelRequestedAt: null });
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_1/cancel-requested', headers: { 'x-run-secret': 'wrong' } });
  assert.equal(res.statusCode, 401);
  await a.close();
});

// GET /api/runs/:id/context carries Hive's briefing (#93) when Hive answers, and is served without it when not.
async function contextWithHive(hive: number | 'throw') {
  process.env.HIVE_URL = 'http://hive.test';
  const hiveCalls: string[] = [];
  global.fetch = (async (url: string, init?: { body?: string }) => {
    if (String(url).startsWith('http://hive.test')) {
      hiveCalls.push(String(url));
      if (hive === 'throw') throw new Error('connect ECONNREFUSED');
      return new Response(JSON.stringify({ facts: [{ id: 'eeeeeeee5555', text: 'Use the mock', kind: 'decision', scope: 'repo' }] }), { status: hive });
    }
    const body = JSON.parse(init?.body ?? '{}') as { op: string };
    const result = body.op === 'getRun' ? { run: { id: 'run_h', ticketId: 'ASF-7', ticketKey: 'ASF-7', repoId: 'acme/app' }, tasks: [] }
      : body.op === 'listSkills' ? { skills: [] } : {};
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const repo: Repo = { id: 'acme/app', path: 'acme/app', url: 'https://example.test/acme/app', defaultBranch: 'main', cloneUrl: 'https://example.test/acme/app.git' };
  const scm = { kind: 'mock', searchRepos: async () => [repo], getRepo: async () => repo, cloneCredential: async () => ({ url: 'x' }) } as unknown as ScmProvider;
  const tickets = { get: async () => ({ id: 'ASF-7', key: 'ASF-7', url: 'u', title: 'T', body: 'B', links: [] } as unknown as Ticket) } as unknown as TicketProvider;
  const a = Fastify();
  registerRunRoutes(a, { tickets, scm });
  await a.ready();
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_h/context', headers: secret() });
  await a.close();
  return { res, hiveCalls };
}

test('context: Hive answers -> the brief is in the context', async () => {
  const { res, hiveCalls } = await contextWithHive(200);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().hiveBrief, 'Facts:\n- Use the mock (repo, decision) [hive:eeeeeeee]');
  assert.deepEqual(hiveCalls, ['http://hive.test/v1/brief']);
});

test('context: Hive down or failing -> still served, with no brief', async () => {
  for (const hive of [500, 'throw'] as const) {
    clearHiveBriefCache();
    const { res } = await contextWithHive(hive);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal('hiveBrief' in res.json(), false);
  }
});
