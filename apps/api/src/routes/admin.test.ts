import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { TicketProvider, ScmProvider } from '@asf/shared';
import { registerAdminRoutes } from './admin.js';
import { TicketProviderRegistry } from '../providers/tickets/registry.js';
import { ScmProviderRegistry } from '../providers/scm/registry.js';

// Admin settings routes are a thin surface over registry RPCs (getOrgSettings on
// refresh, putOrgSetting/deleteOrgSetting on write). Stub the registry HTTP layer.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function stubRegistry() {
  const calls: string[] = [];
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string };
    calls.push(body.op);
    // getOrgSettings must return a settings map; everything else an ok result.
    const result = body.op === 'getOrgSettings' ? { settings: {} } : { ok: true };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return calls;
}

function fakeProvider(kind: string, preflight: TicketProvider['preflight']): TicketProvider {
  return {
    kind: kind as TicketProvider['kind'], preflight,
    capabilities() { return { subtasks: false, priority: false, links: false, transitions: false, assignable: false, boards: false, sprints: false, statuses: false }; },
    async list() { return { tickets: [] }; },
    async get() { throw new Error('nope'); },
    async update() { throw new Error('nope'); },
    async createSubtask() { throw new Error('nope'); },
    async addLink() {}, async comment() { return { commentId: 'c' }; },
    async listComments() { return []; }, async transitions() { return []; },
    async transition() {}, async assign() {},
    async listScopes() { return []; }, async listSprints() { return []; }, async listStatuses() { return []; },
  };
}

function fakeScm(kind: string, preflight: ScmProvider['preflight']): ScmProvider {
  return {
    kind: kind as ScmProvider['kind'], preflight,
    async searchRepos() { return []; },
    async getRepo() { throw new Error('nope'); },
    async cloneCredential() { return { url: 'mock://clone' }; },
    async openChangeRequest() { throw new Error('nope'); },
    async listChangeRequests() { return []; },
    async getChangeRequest() { throw new Error('nope'); },
    async listReviewComments() { return []; },
    async replyToThread() {},
    async comment() {}, async markReady() {}, async merge() {},
  };
}

/** A default mock SCM registry for tests that only exercise the ticket surface. */
function mockScmReg() {
  return new ScmProviderRegistry(async (k) => fakeScm(k, async () => ({ ok: true, identity: 'scm' })), () => 'mock');
}

async function app(reg: TicketProviderRegistry, scm: ScmProviderRegistry = mockScmReg()) {
  const a = Fastify();
  registerAdminRoutes(a, { tickets: reg, scm });
  await a.ready();
  return a;
}

test('GET /api/providers/ticket/preflight returns the provider identity on success', async () => {
  const reg = new TicketProviderRegistry(async (k) => fakeProvider(k, async () => ({ ok: true, identity: 'me@example.com' })), () => 'jira');
  const a = await app(reg);
  const res = await a.inject({ method: 'GET', url: '/api/providers/ticket/preflight' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { kind: 'jira', ok: true, identity: 'me@example.com' });
  await a.close();
});

test('a failing preflight is a 200 report with the reason, not a 500', async () => {
  const reg = new TicketProviderRegistry(async (k) => fakeProvider(k, async () => ({ ok: false, reason: 'JIRA_API_TOKEN is empty' })), () => 'jira');
  const a = await app(reg);
  const res = await a.inject({ method: 'GET', url: '/api/providers/ticket/preflight' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { kind: 'jira', ok: false, reason: 'JIRA_API_TOKEN is empty' });
  await a.close();
});

test('a build that throws (unconfigured/unknown provider) is reported, not a 500', async () => {
  const reg = new TicketProviderRegistry(async () => { throw new Error('Unknown TICKET_PROVIDER: nope'); }, () => 'nope');
  const a = await app(reg);
  const res = await a.inject({ method: 'GET', url: '/api/providers/ticket/preflight' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: false, reason: 'Unknown TICKET_PROVIDER: nope' });
  await a.close();
});

test('PUT /api/settings/:key invalidates the provider so the next request rebuilds', async () => {
  stubRegistry();
  let builds = 0;
  const reg = new TicketProviderRegistry(async (k) => { builds += 1; return fakeProvider(k, async () => ({ ok: true, identity: 'x' })); }, () => 'mock');
  await reg.current();                 // first build
  assert.equal(builds, 1);
  const a = await app(reg);
  const res = await a.inject({ method: 'PUT', url: '/api/settings/QUEUE_ENABLED', payload: { value: false } });
  assert.equal(res.statusCode, 200);
  await reg.current();                 // must rebuild because the write invalidated
  assert.equal(builds, 2, 'a settings write invalidates the provider registry');
  await a.close();
});

test('DELETE /api/settings/:key also invalidates the provider', async () => {
  stubRegistry();
  let builds = 0;
  const reg = new TicketProviderRegistry(async (k) => { builds += 1; return fakeProvider(k, async () => ({ ok: true, identity: 'x' })); }, () => 'mock');
  await reg.current();
  const a = await app(reg);
  await a.inject({ method: 'DELETE', url: '/api/settings/QUEUE_ENABLED' });
  await reg.current();
  assert.equal(builds, 2);
  await a.close();
});

test('GET /api/providers/scm/preflight returns the SCM identity on success', async () => {
  const scm = new ScmProviderRegistry(async (k) => fakeScm(k, async () => ({ ok: true, identity: 'octocat' })), () => 'github');
  const a = await app(new TicketProviderRegistry(async (k) => fakeProvider(k, async () => ({ ok: true, identity: 'x' })), () => 'mock'), scm);
  const res = await a.inject({ method: 'GET', url: '/api/providers/scm/preflight' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { kind: 'github', ok: true, identity: 'octocat' });
  await a.close();
});

test('a failing SCM preflight is a 200 report with the reason, not a 500', async () => {
  const scm = new ScmProviderRegistry(async (k) => fakeScm(k, async () => ({ ok: false, reason: 'GITLAB_TOKEN is empty' })), () => 'gitlab');
  const a = await app(new TicketProviderRegistry(async (k) => fakeProvider(k, async () => ({ ok: true, identity: 'x' })), () => 'mock'), scm);
  const res = await a.inject({ method: 'GET', url: '/api/providers/scm/preflight' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { kind: 'gitlab', ok: false, reason: 'GITLAB_TOKEN is empty' });
  await a.close();
});

test('a settings write invalidates the SCM registry too', async () => {
  stubRegistry();
  let scmBuilds = 0;
  const scm = new ScmProviderRegistry(async (k) => { scmBuilds += 1; return fakeScm(k, async () => ({ ok: true, identity: 'scm' })); }, () => 'mock');
  await scm.current();
  assert.equal(scmBuilds, 1);
  const a = await app(new TicketProviderRegistry(async (k) => fakeProvider(k, async () => ({ ok: true, identity: 'x' })), () => 'mock'), scm);
  const res = await a.inject({ method: 'PUT', url: '/api/settings/SCM_PROVIDER', payload: { value: 'github' } });
  assert.equal(res.statusCode, 200);
  await scm.current();
  assert.equal(scmBuilds, 2, 'a settings write invalidates the SCM provider registry');
  await a.close();
});

test('GET /api/fleet passes each worker\'s runtime status through (#69)', async () => {
  const preflight = [
    { kind: 'claude-code', installed: true, version: '2.1.0', ok: true, checkedAt: '2026-01-01T00:00:00.000Z' },
    { kind: 'codex', installed: true, version: '0.5.0', ok: false, reason: 'no OpenAI key', checkedAt: '2026-01-01T00:00:00.000Z' },
  ];
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string };
    const result = body.op === 'listFleet'
      ? { workers: [{ id: 'w1', host: 'h', runtimes: ['claude-code'], authMode: 'api-key', maxConcurrent: 1, running: 0, lastHeartbeat: '2026-01-01T00:00:00.000Z', preflight }], capacity: 1, running: 0 }
      : body.op === 'monthUnpricedRuns' ? { count: 3 } : { totalUsd: 0 };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const a = await app(new TicketProviderRegistry(async (k) => fakeProvider(k, async () => ({ ok: true, identity: 'me@example.com' })), () => 'jira'));
  const res = await a.inject({ method: 'GET', url: '/api/fleet' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().workers[0].preflight, preflight);
  assert.equal(res.json().monthUnpricedRuns, 3, 'the unpriced-run count rides beside the spend (M8 WP H)');
  await a.close();
});

test('GET /api/models returns the runnable catalogue, narrowed by MODEL_ALLOWLIST', async () => {
  stubRegistry();
  const reg = new TicketProviderRegistry(async (k) => fakeProvider(k, async () => ({ ok: true, identity: 'x' })), () => 'mock');
  const a = await app(reg);
  const all = (await a.inject({ method: 'GET', url: '/api/models' })).json() as { models: { id: string }[]; providers?: unknown };
  assert.ok(all.models.some((m) => m.id === 'claude-haiku-4-5'));
  assert.equal(all.providers, undefined, 'provider base URLs / credential key names stay server-side');
  const before = process.env.MODEL_ALLOWLIST;
  process.env.MODEL_ALLOWLIST = 'claude-sonnet-5';
  try {
    const narrowed = (await a.inject({ method: 'GET', url: '/api/models' })).json() as { models: { id: string }[] };
    assert.deepEqual(narrowed.models.map((m) => m.id), ['claude-sonnet-5']);
  } finally {
    if (before === undefined) delete process.env.MODEL_ALLOWLIST; else process.env.MODEL_ALLOWLIST = before;
  }
});
