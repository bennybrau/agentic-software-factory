import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerDispatchRoutes } from './dispatch.js';
import { MockTicketProvider } from '../providers/tickets/mock.js';
import { MockScmProvider } from '../providers/scm/mock.js';
import type { TeamTemplate } from '@asf/shared';

// The dispatch route enforces the org cost caps (WP 7.4) before it asks the
// registry to create a run. It reaches the registry over HTTP via registry/client.ts,
// so we stub global fetch to fake the two RPCs it can call here — monthCost and
// createRun — and drive the caps from the environment (org cache is empty in a test).
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; for (const k of ['ORG_MAX_COST_USD', 'ORG_MONTHLY_BUDGET_USD', 'RUN_EVENT_SECRET', 'TICKET_ASSIGNEE', 'ROLE_SKILL_PLANNER', 'ROLE_SKILL_IMPLEMENTER']) delete process.env[k]; });

function stubRegistry(opts: { monthTotal?: number; onCreateRun?: (input: unknown) => void } = {}) {
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string; input?: unknown };
    if (body.op === 'monthCost') return json({ ok: true, result: { totalUsd: opts.monthTotal ?? 0 } });
    if (body.op === 'createRun') { opts.onCreateRun?.(body.input); return json({ ok: true, result: { run: { id: 'run_test' } } }); }
    return json({ ok: true, result: {} });
  }) as unknown as typeof fetch;
}
function json(obj: unknown) { return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } }); }

async function app(tickets = new MockTicketProvider()) {
  const a = Fastify();
  registerDispatchRoutes(a, { tickets, scm: new MockScmProvider() });
  await a.ready();
  return a;
}

test('dispatch refuses a maxCostUsd above ORG_MAX_COST_USD, naming the limit', async () => {
  process.env.ORG_MAX_COST_USD = '10';
  stubRegistry();
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', maxCostUsd: 50 } });
  assert.equal(res.statusCode, 400);
  const b = res.json();
  assert.equal(b.error, 'cost_cap');
  assert.match(b.reason, /ORG_MAX_COST_USD=10/);
  await a.close();
});

test('dispatch refuses a ticket that is already done', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  stubRegistry();
  const tickets = new MockTicketProvider();
  await tickets.transition('asf-1', 'done'); // asf-1 is now bucket=done, status=Done
  const a = await app(tickets);
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1' } });
  assert.equal(res.statusCode, 409);
  const b = res.json();
  assert.equal(b.error, 'ticket_done');
  assert.match(b.reason, /done/i);
  await a.close();
});

test('dispatch refuses once the month is over ORG_MONTHLY_BUDGET_USD', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '200';
  stubRegistry({ monthTotal: 250 });
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', maxCostUsd: 15 } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'over_budget');
  await a.close();
});

test('dispatch under both caps creates the run (201)', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '200';
  stubRegistry({ monthTotal: 10 });
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', maxCostUsd: 15 } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().run.id, 'run_test');
  await a.close();
});

test('the run records the per-role defaults; a modelOverride replaces one role only', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  let created: { team: { roles: { role: string; model: string | null }[] } } | undefined;
  stubRegistry({ onCreateRun: (i) => { created = i as typeof created; } });
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', modelOverrides: { tester: 'claude-opus-4-8' } } });
  assert.equal(res.statusCode, 201);
  assert.ok(created);
  const model = (role: string) => created!.team.roles.find((r) => r.role === role)!.model;
  assert.equal(model('planner'), 'claude-opus-4-8');
  assert.equal(model('tester'), 'claude-opus-4-8');
  assert.equal(model('reviewer'), 'claude-sonnet-5');
  await a.close();
});

test('a skillOverride lands on the created run team role; a blank clears it to null; others untouched', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  let created: { team: { roles: { role: string; skill: string | null }[] } } | undefined;
  stubRegistry({ onCreateRun: (i) => { created = i as typeof created; } });
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch',
    payload: { repoId: '1', skillOverrides: { implementer: '  prefer small diffs  ', reviewer: '' } } });
  assert.equal(res.statusCode, 201);
  assert.ok(created);
  const skill = (role: string) => created!.team.roles.find((r) => r.role === role)!.skill;
  assert.equal(skill('implementer'), 'prefer small diffs', 'the per-run skill is trimmed and stored');
  assert.equal(skill('reviewer'), null, 'a blank skill clears to null');
  assert.equal(skill('planner'), null, 'a role with no override is left at the team default (null)');
  await a.close();
});

test('the dispatch preview surfaces the org-tier role skills (orgRoleSkills)', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ROLE_SKILL_PLANNER = 'always list open questions';
  stubRegistry();
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/api/tickets/asf-1/dispatch' });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.equal(b.orgRoleSkills.planner, 'always list open questions');
  assert.ok(!('implementer' in b.orgRoleSkills), 'roles with no org skill are absent, not empty strings');
  await a.close();
});

test('an unknown model id is refused with 400 bad_model, before any run is created', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  let createRunCalls = 0;
  stubRegistry({ onCreateRun: () => { createRunCalls++; } });
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', modelOverrides: { planner: 'gpt-9' } } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'bad_model');
  assert.match(res.json().reason, /planner/);
  assert.match(res.json().reason, /gpt-9/);
  assert.equal(createRunCalls, 0);
  await a.close();
});

test('the dispatch preview carries the model catalogue and the resolved defaults', async () => {
  stubRegistry();
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/api/tickets/asf-1/dispatch' });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.ok(Array.isArray(b.models) && b.models.some((m: { id: string }) => m.id === 'claude-opus-4-8'));
  assert.equal(b.defaultModels.planner, 'claude-opus-4-8');
  assert.equal(b.defaultModels.reviewer, 'claude-sonnet-5');
  // effort catalogue + resolved defaults ride along (M11 effort work)
  assert.ok(Array.isArray(b.efforts) && b.efforts.includes('high'));
  assert.equal(b.defaultEfforts.planner, 'high');
  assert.equal(b.defaultEfforts.reviewer, 'medium');
  await a.close();
});

test('a successful dispatch moves the ticket into its in-progress status', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  stubRegistry({ monthTotal: 0 });
  const tickets = new MockTicketProvider();
  const before = await tickets.get('asf-1');
  assert.equal(before.status, 'To Do');
  const a = await app(tickets);
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', maxCostUsd: 15 } });
  assert.equal(res.statusCode, 201);
  // The default TICKET_STATUS_INPROGRESS matches the mock's Start→In Progress transition.
  const after = await tickets.get('asf-1');
  assert.equal(after.status, 'In Progress');
  assert.equal(after.bucket, 'inflight');
  await a.close();
});

test('a successful dispatch assigns the ticket to TICKET_ASSIGNEE when set', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  process.env.TICKET_ASSIGNEE = 'asf-factory-bot';
  stubRegistry({ monthTotal: 0 });
  const tickets = new MockTicketProvider();
  assert.equal((await tickets.get('asf-1')).assignee, null);
  const a = await app(tickets);
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', maxCostUsd: 15 } });
  assert.equal(res.statusCode, 201);
  assert.equal((await tickets.get('asf-1')).assignee, 'asf-factory-bot');
  await a.close();
});

test('a successful dispatch leaves the assignee alone when TICKET_ASSIGNEE is blank', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  // TICKET_ASSIGNEE unset → default '' → assignment disabled.
  stubRegistry({ monthTotal: 0 });
  const tickets = new MockTicketProvider();
  const a = await app(tickets);
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', maxCostUsd: 15 } });
  assert.equal(res.statusCode, 201);
  assert.equal((await tickets.get('asf-1')).assignee, null);
  await a.close();
});

test('a zero ORG_MONTHLY_BUDGET_USD means no budget check (does not call monthCost)', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  let monthCostCalled = false;
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string };
    if (body.op === 'monthCost') { monthCostCalled = true; return json({ ok: true, result: { totalUsd: 9999 } }); }
    return json({ ok: true, result: { run: { id: 'run_test' } } });
  }) as unknown as typeof fetch;
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', maxCostUsd: 15 } });
  assert.equal(res.statusCode, 201);
  assert.equal(monthCostCalled, false);
  await a.close();
});

// --- WP 4.3: repo-binding suggestion in the preview ---
import { GithubTicketProvider } from '../providers/tickets/github.js';
import { GithubScmProvider } from '../providers/scm/github.js';

function stubGithub(routes: Array<{ m: string; re: RegExp; json: unknown }>) {
  const orig = global.fetch;
  global.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const r = routes.find((x) => x.m === method && x.re.test(String(url)));
    if (!r) return json({ ok: true, result: {} }); // registry RPCs fall through harmlessly
    return new Response(JSON.stringify(r.json), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return () => { global.fetch = orig; };
}

test('preview suggests the issue\'s own repo when the SCM knows it', async () => {
  const restore = stubGithub([
    { m: 'GET', re: /\/repos\/acme\/scratch\/issues\/9$/, json: { number: 9, title: 'T', body: '', html_url: 'https://github.com/acme/scratch/issues/9', state: 'open', labels: [], assignee: null, updated_at: '2026-09-14T00:00:00Z' } },
    { m: 'GET', re: /\/repos\/acme\/scratch$/, json: { full_name: 'acme/scratch', html_url: 'https://github.com/acme/scratch', default_branch: 'main', clone_url: 'https://github.com/acme/scratch.git', id: 1, permissions: { push: true } } },
  ]);
  try {
    const a = Fastify();
    const tickets = new GithubTicketProvider({ token: 't', repos: ['acme/scratch'], bucketMap: [], apiUrl: 'https://api.github.com' });
    const scm = new GithubScmProvider({ token: 't', repos: ['acme/scratch'], apiUrl: 'https://api.github.com', graphqlUrl: 'https://api.github.com/graphql', host: 'github.com' });
    registerDispatchRoutes(a, { tickets, scm });
    await a.ready();
    const res = await a.inject({ method: 'GET', url: '/api/tickets/acme%2Fscratch%239/dispatch' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().suggestedRepoId, 'acme/scratch');
    await a.close();
  } finally { restore(); }
});

test('preview suggestedRepoId is null for a mock ticket (provider has no suggestion)', async () => {
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/api/tickets/asf-1/dispatch' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().suggestedRepoId, null);
  await a.close();
});

// --- M8 WP D: model catalogue as data, filtered by what the live fleet runs ---
import { registerAdminRoutes } from './admin.js';
import { TicketProviderRegistry } from '../providers/tickets/registry.js';
import { ScmProviderRegistry } from '../providers/scm/registry.js';
import { loadOrgSettings } from '../settings.js';

const deepseek = { id: 'deepseek-chat', providerId: 'deepseek', tier: 'balanced', runtimes: ['codex'], rate: { inputPerM: 0.27, outputPerM: 1.1 } };

/** A registry stub with an in-memory org_setting table and a fleet advertising `runtimes` (one worker each). */
function stubFleet(fleet: string[][], opts: { onCreateRun?: (input: unknown) => void } = {}) {
  const org: Record<string, unknown> = {};
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string; key?: string; value?: unknown; input?: unknown };
    if (body.op === 'listFleet') return json({ ok: true, result: { workers: fleet.map((runtimes, i) => ({ id: `w${i}`, host: 'h', runtimes, authMode: null, maxConcurrent: 1, running: 0, lastHeartbeat: new Date().toISOString() })), capacity: fleet.length, running: 0 } });
    if (body.op === 'getOrgSettings') return json({ ok: true, result: { settings: org } });
    if (body.op === 'putOrgSetting') { org[body.key!] = body.value; return json({ ok: true, result: { ok: true } }); }
    if (body.op === 'monthCost') return json({ ok: true, result: { totalUsd: 0 } });
    if (body.op === 'createRun') { opts.onCreateRun?.(body.input); return json({ ok: true, result: { run: { id: 'run_test' } } }); }
    return json({ ok: true, result: {} });
  }) as unknown as typeof fetch;
  return org;
}

/** Clear the api's org cache so a catalogue set in one test does not leak into the next. */
async function clearOrg() { stubFleet([]); await loadOrgSettings(); }

test('the preview lists the fleet runtimes and only the models the fleet can run', async () => {
  const org = stubFleet([['claude-code']]);
  org.MODEL_CATALOG_EXTRA = { models: [deepseek] };
  await loadOrgSettings();
  try {
    const a = await app();
    const b = (await a.inject({ method: 'GET', url: '/api/tickets/asf-1/dispatch' })).json();
    assert.deepEqual(b.runtimes, ['claude-code']);
    assert.ok(b.models.some((m: { id: string }) => m.id === 'claude-opus-4-8'));
    assert.ok(!b.models.some((m: { id: string }) => m.id === 'deepseek-chat'), 'no live worker runs codex');
    assert.deepEqual(b.models.find((m: { id: string }) => m.id === 'claude-opus-4-8').runtimes, ['claude-code', 'opencode']);
    assert.equal(b.defaultRuntimes.planner, 'claude-code');
    await a.close();
  } finally { await clearOrg(); }
});

test('with no live worker the preview shows every model and the dispatch is not refused', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  const org = stubFleet([]);
  org.MODEL_CATALOG_EXTRA = { models: [deepseek] };
  await loadOrgSettings();
  try {
    const a = await app();
    const b = (await a.inject({ method: 'GET', url: '/api/tickets/asf-1/dispatch' })).json();
    assert.deepEqual(b.runtimes, []);
    assert.ok(b.models.some((m: { id: string }) => m.id === 'deepseek-chat'));
    const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', runtimeOverrides: { tester: 'codex' }, modelOverrides: { tester: 'deepseek-chat' } } });
    assert.equal(res.statusCode, 201);
    await a.close();
  } finally { await clearOrg(); }
});

test('a role whose runtime no live worker offers is refused with 400 no_worker_for_runtime', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  let createRunCalls = 0;
  const org = stubFleet([['claude-code']], { onCreateRun: () => { createRunCalls++; } });
  org.MODEL_CATALOG_EXTRA = { models: [deepseek] };
  await loadOrgSettings();
  try {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', runtimeOverrides: { tester: 'codex' }, modelOverrides: { tester: 'deepseek-chat' } } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'no_worker_for_runtime');
    assert.match(res.json().reason, /codex/);
    assert.match(res.json().reason, /tester/);
    assert.equal(createRunCalls, 0);
    await a.close();
  } finally { await clearOrg(); }
});

test('a runtime the model does not list is refused as bad_model; a good pair on a live runtime is stored', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  let created: { team: { roles: { role: string; model: string | null; runtime: string }[] } } | undefined;
  const org = stubFleet([['claude-code'], ['codex']], { onCreateRun: (i) => { created = i as typeof created; } });
  org.MODEL_CATALOG_EXTRA = { models: [deepseek] };
  await loadOrgSettings();
  try {
    const a = await app();
    const bad = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', runtimeOverrides: { tester: 'codex' } } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'bad_model', 'claude-sonnet-5 does not run on codex');
    const ok = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', runtimeOverrides: { tester: 'codex' }, modelOverrides: { tester: 'deepseek-chat' } } });
    assert.equal(ok.statusCode, 201);
    const tester = created!.team.roles.find((r) => r.role === 'tester')!;
    assert.equal(tester.model, 'deepseek-chat');
    assert.equal(tester.runtime, 'codex');
    assert.equal(created!.team.roles.find((r) => r.role === 'planner')!.runtime, 'claude-code');
    await a.close();
  } finally { await clearOrg(); }
});

test('done when: PUT MODEL_CATALOG_EXTRA and the model appears in the preview with no restart; a bad shape is a 400', async () => {
  stubFleet([['claude-code', 'codex']]);
  await loadOrgSettings();
  try {
    const a = Fastify();
    const tickets = new MockTicketProvider();
    registerDispatchRoutes(a, { tickets, scm: new MockScmProvider() });
    registerAdminRoutes(a, { tickets: new TicketProviderRegistry(async () => tickets, () => 'mock'), scm: new ScmProviderRegistry(async () => new MockScmProvider(), () => 'mock') });
    await a.ready();
    const before = (await a.inject({ method: 'GET', url: '/api/tickets/asf-1/dispatch' })).json();
    assert.ok(!before.models.some((m: { id: string }) => m.id === 'deepseek-chat'));

    const badPut = await a.inject({ method: 'PUT', url: '/api/settings/MODEL_CATALOG_EXTRA', payload: { value: { models: [{ id: 'x', tier: 'huge' }] } } });
    assert.equal(badPut.statusCode, 400);
    assert.equal(badPut.json().error, 'setting_error');
    assert.match(badPut.json().reason, /MODEL_CATALOG_EXTRA/);

    const put = await a.inject({ method: 'PUT', url: '/api/settings/MODEL_CATALOG_EXTRA', payload: { value: { models: [deepseek] } } });
    assert.equal(put.statusCode, 200);
    const after = (await a.inject({ method: 'GET', url: '/api/tickets/asf-1/dispatch' })).json();
    const m = after.models.find((x: { id: string }) => x.id === 'deepseek-chat');
    assert.ok(m, 'the extra model is in the preview');
    assert.deepEqual(m.runtimes, ['codex']);
    assert.deepEqual([...after.runtimes].sort(), ['claude-code', 'codex']);
    await a.close();
  } finally { await clearOrg(); }
});

test('dispatch refuses (409) with no repository to put code in, and never creates a run', async () => {
  let created = false;
  stubRegistry({ onCreateRun: () => { created = true; } });
  const a = Fastify();
  registerDispatchRoutes(a, { tickets: new MockTicketProvider(), scm: new MockScmProvider('') });
  await a.ready();
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { maxCostUsd: 15 } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'scm_not_connected');
  assert.equal(res.json().link, '/settings#code');
  assert.equal(created, false);
  // The preview says the same thing up front, so the Start button can stay off.
  const pv = (await a.inject({ method: 'GET', url: '/api/tickets/asf-1/dispatch' })).json();
  assert.equal(pv.blocker.code, 'scm_not_connected');
  assert.match(pv.whyNot[0], /Connect the repository/);
  const ready = (await a.inject({ method: 'GET', url: '/api/start-readiness' })).json();
  assert.equal(ready.ok, false);
  await a.close();
});

test('dispatch with no repoId binds the only repository, so every run has somewhere to put code', async () => {
  let input: { repoId?: string | null } | undefined;
  stubRegistry({ onCreateRun: (i) => { input = i as typeof input; } });
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { maxCostUsd: 15 } });
  assert.equal(res.statusCode, 201);
  assert.equal(input?.repoId, '1');
  await a.close();
});

test('skipRoles switches roles off for this run only; skipping the implementer is a 400 pipeline_config', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  let created: { team: { roles: { role: string }[] } } | undefined;
  stubRegistry({ onCreateRun: (i) => { created = i as typeof created; } });
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', skipRoles: ['planner', 'tester'] } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(created!.team.roles.map((r) => r.role), ['implementer', 'reviewer']);

  created = undefined;
  const bad = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', skipRoles: ['implementer'] } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'pipeline_config');
  assert.equal(created, undefined, 'no run is created');
  await a.close();
});

test('the dispatch preview lists the roles the org switched off (none by default)', async () => {
  stubRegistry();
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/api/tickets/asf-1/dispatch' });
  assert.deepEqual(res.json().orgDisabledRoles, []);
  await a.close();
});

test('done when (#1): a Vertex org adds its ids + MODEL_ALLOWLIST; the preview offers only those and a fresh install still dispatches', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  let created: { team: { roles: { role: string; model: string | null }[] } } | undefined;
  stubFleet([['claude-code']], { onCreateRun: (input) => { created = input as typeof created; } });
  await loadOrgSettings();
  try {
    const a = Fastify();
    const tickets = new MockTicketProvider();
    registerDispatchRoutes(a, { tickets, scm: new MockScmProvider() });
    registerAdminRoutes(a, { tickets: new TicketProviderRegistry(async () => tickets, () => 'mock'), scm: new ScmProviderRegistry(async () => new MockScmProvider(), () => 'mock') });
    await a.ready();
    const vertexHaiku = { id: 'claude-haiku-4-5@20251001', tier: 'fast', providerId: 'anthropic', runtimes: ['claude-code'] };
    assert.equal((await a.inject({ method: 'PUT', url: '/api/settings/MODEL_CATALOG_EXTRA', payload: { value: { models: [vertexHaiku] } } })).statusCode, 200);
    assert.equal((await a.inject({ method: 'PUT', url: '/api/settings/MODEL_ALLOWLIST', payload: { value: 'claude-haiku-4-5@20251001, claude-sonnet-5' } })).statusCode, 200);
    const pv = (await a.inject({ method: 'GET', url: '/api/tickets/asf-1/dispatch' })).json();
    assert.deepEqual(pv.models.map((m: { id: string }) => m.id).sort(), ['claude-haiku-4-5@20251001', 'claude-sonnet-5']);
    assert.ok(!pv.models.some((m: { id: string }) => m.id === 'claude-fable-5-1'), 'fable gone');
    assert.equal(pv.defaultModels.planner, 'claude-sonnet-5', 'hidden opus-4-8 template default -> allowed substitute');
    assert.deepEqual(pv.whyNot, []);
    const ok = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { repoId: '1', modelOverrides: { tester: 'claude-haiku-4-5@20251001' } } });
    assert.equal(ok.statusCode, 201, ok.body);
    assert.ok(created);
    const roles = Object.fromEntries(created.team.roles.map((r) => [r.role, r.model]));
    assert.deepEqual(roles, { planner: 'claude-sonnet-5', implementer: 'claude-sonnet-5', tester: 'claude-haiku-4-5@20251001', reviewer: 'claude-sonnet-5' });
    // an allowlist nothing can run: the preview explains instead of a 500
    assert.equal((await a.inject({ method: 'PUT', url: '/api/settings/MODEL_ALLOWLIST', payload: { value: 'typo' } })).statusCode, 200);
    const bad = await a.inject({ method: 'GET', url: '/api/tickets/asf-1/dispatch' });
    assert.equal(bad.statusCode, 200);
    assert.ok(bad.json().whyNot.some((w: string) => /no allowed model can run/.test(w)));
    await a.close();
  } finally { await clearOrg(); }
});

test('reviewOf: a review-only run of the PR, in the PR\'s repository, reviewer only, no loop', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  let created: { repoId: string; team: TeamTemplate } | undefined;
  stubRegistry({ onCreateRun: (i) => { created = i as typeof created; } });
  const scm = new MockScmProvider();
  const repo = await scm.getRepo('example/app');
  await scm.openChangeRequest(repo, { head: 'feature/x', base: 'develop', title: 't', body: '', draft: false });
  const a = Fastify();
  registerDispatchRoutes(a, { tickets: new MockTicketProvider(), scm });
  await a.ready();
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { reviewOf: 'please review https://github.com/example/app/pull/1' } });
  assert.equal(res.statusCode, 201);
  assert.equal(created!.repoId, '1');
  assert.deepEqual(created!.team.roles.map((r) => r.role), ['reviewer']);
  assert.equal(created!.team.loop, null);
  assert.equal(created!.team.mergeEnabled, false);
  assert.deepEqual(created!.team.reviewTarget, {
    url: 'https://github.com/example/app/pull/1', number: 1, headBranch: 'feature/x', baseBranch: 'develop', fetchRef: 'refs/pull/1/head',
  });
  await a.close();
});

test('reviewOf: a GitLab URL fetches the merge-request ref', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  let created: { team: TeamTemplate } | undefined;
  stubRegistry({ onCreateRun: (i) => { created = i as typeof created; } });
  const scm = new MockScmProvider();
  await scm.openChangeRequest(await scm.getRepo('example/app'), { head: 'f', base: 'main', title: 't', body: '', draft: false });
  const a = Fastify();
  registerDispatchRoutes(a, { tickets: new MockTicketProvider(), scm });
  await a.ready();
  const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { reviewOf: 'Review https://gitlab.com/example/app/-/merge_requests/1' } });
  assert.equal(res.statusCode, 201);
  assert.equal(created!.team.reviewTarget?.fetchRef, 'refs/merge-requests/1/head');
  await a.close();
});

test('reviewOf: an unparsable URL or an unreachable PR is a 400 bad_review_target and no run', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  let created: unknown;
  stubRegistry({ onCreateRun: (i) => { created = i; } });
  const a = await app();
  for (const reviewOf of ['review the login page', 'review https://github.com/example/app/pull/99', 'review https://github.com/nobody/else/pull/1']) {
    const res = await a.inject({ method: 'POST', url: '/api/tickets/asf-1/dispatch', payload: { reviewOf } });
    assert.equal(res.statusCode, 400, reviewOf);
    assert.equal(res.json().error, 'bad_review_target', reviewOf);
  }
  assert.equal(created, undefined, 'no run is created');
  await a.close();
});
