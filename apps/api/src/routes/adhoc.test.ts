import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { TicketProvider } from '@asf/shared';
import { registerAdhocRoutes } from './adhoc.js';
import { registerDispatchRoutes } from './dispatch.js';
import { registerRunRoutes } from './runs.js';
import { MockTicketProvider } from '../providers/tickets/mock.js';
import { MockScmProvider } from '../providers/scm/mock.js';

// Everything ad-hoc lives in the registry, reached over HTTP via registry/client.ts,
// so global fetch is stubbed with a tiny in-memory registry.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; for (const k of ['ADHOC_MAX_ATTACHMENTS', 'ADHOC_MAX_ATTACHMENT_MB', 'ORG_MAX_COST_USD']) delete process.env[k]; });

const TASK = {
  id: 'adhoc:0123456789abcdef', key: 'ADHOC-01234567', title: 'Fix the login page', body: 'It **breaks**.',
  createdBy: 'ana', attachments: [{ name: 'shot.png', mime: 'image/png', size: 4 }], createdAt: '2026-09-30T00:00:00.000Z',
};
const RUN = { id: 'run_a', ticketId: TASK.id, ticketKey: TASK.key, repoId: null };
const BYTES = Buffer.from([1, 2, 3, 4]);

function stubRegistry(
  calls: { op: string; [k: string]: unknown }[] = [],
  opts: { skills?: unknown[]; listSkillsFails?: boolean } = {},
) {
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string; [k: string]: unknown };
    calls.push(body);
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    switch (body.op) {
      case 'createAdhoc': return ok({ task: TASK });
      case 'getAdhoc': return ok({ task: body.id === TASK.id ? TASK : null });
      case 'listAdhoc': return ok({ tasks: [TASK] });
      case 'deleteAdhoc': return ok({ ok: body.id === TASK.id });
      case 'getAdhocAttachment': return ok({ attachment: body.name === 'shot.png' ? { name: 'shot.png', mime: 'image/png', size: 4, contentBase64: BYTES.toString('base64') } : null });
      case 'getRun': return ok(body.id === RUN.id ? { run: RUN, tasks: [] } : body.id === 'run_tracker' ? { run: { ...RUN, id: 'run_tracker', ticketId: 'asf-1' }, tasks: [] } : null);
      case 'createRun': return ok({ run: { id: 'run_new' } });
      case 'monthCost': return ok({ totalUsd: 0 });
      case 'listFleet': return ok({ workers: [], capacity: 0, running: 0 });
      case 'listSkills':
        if (opts.listSkillsFails) return new Response(JSON.stringify({ error: 'internal' }), { status: 500 });
        return ok({ skills: opts.skills ?? [] });
      default: return ok({});
    }
  }) as unknown as typeof fetch;
  return calls;
}

async function app(register: (a: ReturnType<typeof Fastify>) => void) {
  const a = Fastify();
  register(a);
  await a.ready();
  return a;
}

const file = (name: string, mime: string, bytes: Buffer) => ({ name, mime, contentBase64: bytes.toString('base64') });

test('POST /api/adhoc stores the task and returns its adhoc: id', async () => {
  const calls = stubRegistry();
  const a = await app((x) => registerAdhocRoutes(x, { scm: new MockScmProvider() }));
  const res = await a.inject({ method: 'POST', url: '/api/adhoc', payload: { title: 'Fix the login page', body: 'It **breaks**.', files: [file('../../etc/shot.png', 'image/png', BYTES), file('shot.png', 'image/png', BYTES)] } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().task.id, TASK.id);
  const sent = calls.find((c) => c.op === 'createAdhoc')!.input as { title: string; attachments: { name: string }[] };
  assert.equal(sent.title, 'Fix the login page');
  // Directory parts are stripped and a clash is renamed, since the worker writes by name.
  assert.deepEqual(sent.attachments.map((f) => f.name), ['shot.png', 'shot-2.png']);
  await a.close();
});

test('POST /api/adhoc from the chat appends the connected repositories; without chat the body is unchanged', async () => {
  const calls = stubRegistry();
  const a = await app((x) => registerAdhocRoutes(x, { scm: new MockScmProvider() }));
  const sentBody = () => (calls.filter((c) => c.op === 'createAdhoc').pop()!.input as { body: string }).body;

  assert.equal((await a.inject({ method: 'POST', url: '/api/adhoc', payload: { title: 'T', body: 'Do it.', chat: true } })).statusCode, 201);
  assert.equal(sentBody(), 'Do it.\n\nRepositories connected:\n- example/app');

  await a.inject({ method: 'POST', url: '/api/adhoc', payload: { title: 'T', body: 'Do it.' } });
  assert.equal(sentBody(), 'Do it.');
  await a.close();

  // No repository reachable: the task is still created, just without the list.
  const b = await app((x) => registerAdhocRoutes(x, { scm: new MockScmProvider('') }));
  assert.equal((await b.inject({ method: 'POST', url: '/api/adhoc', payload: { title: 'T', body: 'Do it.', chat: true } })).statusCode, 201);
  assert.equal(sentBody(), 'Do it.');
  await b.close();
});

test('POST /api/adhoc refuses a missing title, a disallowed type, too many files and an oversized file', async () => {
  process.env.ADHOC_MAX_ATTACHMENTS = '2';
  process.env.ADHOC_MAX_ATTACHMENT_MB = '1';
  const calls = stubRegistry();
  const a = await app((x) => registerAdhocRoutes(x, { scm: new MockScmProvider() }));
  const post = (payload: unknown) => a.inject({ method: 'POST', url: '/api/adhoc', payload: payload as object });

  assert.equal((await post({ title: '  ', body: 'x' })).statusCode, 400);

  const svg = await post({ title: 'T', files: [file('x.svg', 'image/svg+xml', BYTES)] });
  assert.equal(svg.statusCode, 400);
  assert.equal(svg.json().error, 'bad_attachment');
  assert.match(svg.json().reason, /only images/);

  const many = await post({ title: 'T', files: [1, 2, 3].map((n) => file(`${n}.txt`, 'text/plain', BYTES)) });
  assert.equal(many.statusCode, 400);
  assert.match(many.json().reason, /At most 2 files/);

  const big = await post({ title: 'T', files: [file('big.pdf', 'application/pdf', Buffer.alloc(1024 * 1024 + 1))] });
  assert.equal(big.statusCode, 400);
  assert.match(big.json().reason, /larger than 1 MB/);

  assert.equal(calls.filter((c) => c.op === 'createAdhoc').length, 0, 'nothing refused reaches the registry');
  await a.close();
});

test('GET /api/adhoc lists stored tasks; DELETE removes one then 404s', async () => {
  const calls = stubRegistry();
  const a = await app((x) => registerAdhocRoutes(x, { scm: new MockScmProvider() }));

  const list = await a.inject({ method: 'GET', url: '/api/adhoc' });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().tasks, [TASK]);

  const del = await a.inject({ method: 'DELETE', url: `/api/adhoc/${encodeURIComponent(TASK.id)}` });
  assert.equal(del.statusCode, 204);
  assert.equal(calls.find((c) => c.op === 'deleteAdhoc')!.id, TASK.id);

  const gone = await a.inject({ method: 'DELETE', url: '/api/adhoc/adhoc:missing' });
  assert.equal(gone.statusCode, 404);
  await a.close();
});

test('POST /api/adhoc accepts a body above the default 1 MiB limit (route-level bodyLimit)', async () => {
  stubRegistry();
  const a = await app((x) => registerAdhocRoutes(x, { scm: new MockScmProvider() }));
  const res = await a.inject({ method: 'POST', url: '/api/adhoc', payload: { title: 'T', files: [file('a.png', 'image/png', Buffer.alloc(3 * 1024 * 1024, 7))] } });
  assert.equal(res.statusCode, 201);
  await a.close();
});

test('GET /api/runs/:id/attachments/:name needs X-Run-Secret and returns the raw bytes', async () => {
  stubRegistry();
  const a = await app((x) => registerAdhocRoutes(x, { scm: new MockScmProvider() }));
  const noSecret = await a.inject({ method: 'GET', url: '/api/runs/run_a/attachments/shot.png' });
  assert.equal(noSecret.statusCode, 401);

  const headers = { 'x-run-secret': process.env.RUN_EVENT_SECRET ?? '' };
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_a/attachments/shot.png', headers });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.deepEqual(res.rawPayload, BYTES);

  assert.equal((await a.inject({ method: 'GET', url: '/api/runs/run_a/attachments/other.png', headers })).statusCode, 404);
  assert.equal((await a.inject({ method: 'GET', url: '/api/runs/run_tracker/attachments/shot.png', headers })).statusCode, 404, 'a tracker run has no attachments');
  await a.close();
});

/** A tracker that fails the test if anything touches it. */
function untouchableTracker(): TicketProvider {
  const mock = new MockTicketProvider();
  return new Proxy(mock, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v === 'function' && prop !== 'capabilities') return () => { throw new Error(`tracker.${String(prop)} called for an ad-hoc task`); };
      return v;
    },
  });
}

test('dispatching an adhoc: id creates a run with provider adhoc and never calls the tracker', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  const calls = stubRegistry();
  const a = await app((x) => registerDispatchRoutes(x, { tickets: untouchableTracker(), scm: new MockScmProvider() }));
  const url = `/api/tickets/${encodeURIComponent(TASK.id)}/dispatch`;

  const preview = await a.inject({ method: 'GET', url });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().ticket.key, TASK.key);

  const res = await a.inject({ method: 'POST', url, payload: { repoId: '1' } });
  assert.equal(res.statusCode, 201, res.body);
  const created = calls.find((c) => c.op === 'createRun')!.input as { ticketId: string; ticketKey: string; ticketProvider: string };
  assert.deepEqual([created.ticketId, created.ticketKey, created.ticketProvider], [TASK.id, TASK.key, 'adhoc']);
  await a.close();
});

test('the run context for an ad-hoc run carries the task body and its attachment list', async () => {
  stubRegistry();
  const a = await app((x) => registerRunRoutes(x, { tickets: untouchableTracker(), scm: new MockScmProvider() }));
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_a/context', headers: { 'x-run-secret': process.env.RUN_EVENT_SECRET ?? '' } });
  assert.equal(res.statusCode, 200, res.body);
  const ctx = res.json();
  assert.equal(ctx.ticket.key, TASK.key);
  assert.equal(ctx.ticket.body, TASK.body);
  assert.deepEqual(ctx.ticket.attachments, TASK.attachments);
  await a.close();
});

const SKILL = {
  id: 'pdf-tools', name: 'pdf-tools', description: 'PDFs', sourceUrl: 'https://github.com/acme/skills', sourceRef: 'main',
  commitSha: 'a'.repeat(40), files: [{ path: 'SKILL.md', content: 'hi' }], roles: ['implementer'], addedBy: null, updatedAt: '',
};

test('the run context carries only enabled third-party skills', async () => {
  stubRegistry(undefined, { skills: [{ ...SKILL, enabled: true }, { ...SKILL, id: 'other', enabled: false }] });
  const a = await app((x) => registerRunRoutes(x, { tickets: untouchableTracker(), scm: new MockScmProvider() }));
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_a/context', headers: { 'x-run-secret': process.env.RUN_EVENT_SECRET ?? '' } });
  assert.equal(res.statusCode, 200, res.body);
  const ctx = res.json();
  assert.deepEqual(ctx.thirdPartySkills.map((s: { id: string }) => s.id), ['pdf-tools']);
  await a.close();
});

test('a registry that cannot list skills still returns a context, with none delivered', async () => {
  stubRegistry(undefined, { listSkillsFails: true });
  const a = await app((x) => registerRunRoutes(x, { tickets: untouchableTracker(), scm: new MockScmProvider() }));
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_a/context', headers: { 'x-run-secret': process.env.RUN_EVENT_SECRET ?? '' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().thirdPartySkills, []);
  await a.close();
});
