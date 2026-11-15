import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tickQueue } from './scheduler.js';
import { MockTicketProvider } from './providers/tickets/mock.js';
import { TicketSet, qualifyTickets } from './providers/tickets/set.js';
import { MockScmProvider } from './providers/scm/mock.js';
import type { TicketProvider, WorkQueueEntry } from '@asf/shared';

// The scheduler asks the registry which entries are ready, dispatches each
// through the same path as a hand-dispatch, and reports the outcome back. We
// stub the registry RPCs it calls: readyQueueEntries, monthCost, createRun,
// markQueueEntry — and record the marks to assert on.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; for (const k of ['ORG_MAX_COST_USD', 'ORG_MONTHLY_BUDGET_USD', 'QUEUE_ENABLED']) delete process.env[k]; });

const silent = { info: () => {}, error: () => {} };

function entry(over: Partial<WorkQueueEntry> = {}): WorkQueueEntry {
  return { id: 'wq_1', ticketId: 'asf-1', ticketProvider: 'mock', ticketKey: 'ASF-1', repoId: '1', teamName: null,
    maxCostUsd: null, mode: 'parallel', position: 1, batchId: 'b', state: 'queued', runId: null, reason: null,
    addedBy: 'jon', addedAt: new Date().toISOString(), dispatchedAt: null, dependsOn: [], refusedAt: null, reasonCode: null, ...over };
}

/** Stub the registry; `ready` is what readyQueueEntries returns; marks are captured. */
function stub(ready: WorkQueueEntry[], opts: { createFails?: 'conflict' } = {}) {
  const marks: Array<{ id: string; state: string; runId: string | null; reason: string | null; code: string | null }> = [];
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string; id?: string; state?: string; runId?: string | null; reason?: string | null; code?: string | null };
    switch (body.op) {
      case 'readyQueueEntries': return json({ ok: true, result: { entries: ready } });
      case 'monthCost': return json({ ok: true, result: { totalUsd: 0 } });
      case 'createRun':
        if (opts.createFails === 'conflict') return new Response(JSON.stringify({ error: 'run_conflict', reason: 'already live', existingRunId: 'run_existing' }), { status: 409, headers: { 'content-type': 'application/json' } });
        return json({ ok: true, result: { run: { id: 'run_new' } } });
      case 'markQueueEntry': marks.push({ id: body.id!, state: body.state!, runId: body.runId ?? null, reason: body.reason ?? null, code: body.code ?? null }); return json({ ok: true, result: { ok: true } });
      default: return json({ ok: true, result: {} });
    }
  }) as unknown as typeof fetch;
  return marks;
}
function json(obj: unknown) { return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } }); }
const deps = () => ({ tickets: qualifyTickets(new MockTicketProvider()), scm: new MockScmProvider() });

test('tickQueue does nothing when QUEUE_ENABLED is false', async () => {
  process.env.QUEUE_ENABLED = 'false';
  const marks = stub([entry()]);
  const n = await tickQueue(deps(), silent);
  assert.equal(n, 0);
  assert.equal(marks.length, 0);
});

test('a ready entry is dispatched and marked dispatched with its run id', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  const marks = stub([entry()]);
  const n = await tickQueue(deps(), silent);
  assert.equal(n, 1);
  assert.deepEqual(marks, [{ id: 'wq_1', state: 'dispatched', runId: 'run_new', reason: null, code: null }]);
});

test('a run_conflict is treated as dispatched (already running), not failed', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  const marks = stub([entry()], { createFails: 'conflict' });
  const n = await tickQueue(deps(), silent);
  assert.equal(n, 0); // not counted as a fresh dispatch
  assert.equal(marks[0].state, 'dispatched');
  assert.equal(marks[0].runId, 'run_existing');
  assert.equal(marks[0].code, null);
});

test('an over-cap entry is marked failed with the reason and does not run', async () => {
  process.env.ORG_MAX_COST_USD = '5';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  const marks = stub([entry({ maxCostUsd: 50 })]);
  const n = await tickQueue(deps(), silent);
  assert.equal(n, 0);
  assert.equal(marks[0].state, 'failed');
  assert.match(marks[0].reason ?? '', /ORG_MAX_COST_USD=5/);
  assert.equal(marks[0].code, 'cost_cap', 'the refusal code is passed through');
});

test('a missing ticket is marked failed (not_found), leaving other entries unaffected', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  const marks = stub([entry({ id: 'wq_bad', ticketId: 'does-not-exist' }), entry({ id: 'wq_ok' })]);
  const n = await tickQueue(deps(), silent);
  assert.equal(n, 1);
  const bad = marks.find((m) => m.id === 'wq_bad')!;
  assert.equal(bad.state, 'failed');
  assert.equal(bad.code, 'not_found');
  assert.equal(marks.find((m) => m.id === 'wq_ok')!.state, 'dispatched');
});

test('with no repository reachable the queue waits: nothing is dispatched, nothing is failed', async () => {
  const marks = stub([entry(), entry({ id: 'wq_2', ticketId: 'asf-2', ticketKey: 'ASF-2' })]);
  const n = await tickQueue({ tickets: qualifyTickets(new MockTicketProvider()), scm: new MockScmProvider('') }, silent);
  assert.equal(n, 0);
  assert.deepEqual(marks, [], 'entries stay queued; they start once a repository is connected');
});

// --- Several repositories connected: a queued ticket needs to know which one ---
import type { Repo } from '@asf/shared';

class ManyReposScm extends MockScmProvider {
  constructor(private list: Repo[]) { super(); }
  override async searchRepos() { return this.list; }
  override async getRepo(idOrPath: string) { const r = this.list.find((x) => x.id === idOrPath || x.path === idOrPath); if (!r) throw new Error('no repo'); return r; }
}
const glRepo = (path: string): Repo => ({ id: path, path, url: `https://gitlab.com/${path}`, defaultBranch: 'main', cloneUrl: `https://gitlab.com/${path}.git` });
const fiveRepos = ['acme/platform/web/shared-ui', 'acme/platform/web/storefront', 'acme/platform/api/billing', 'acme/platform/api/orders', 'acme/platform/tools/scripts'].map(glRepo);

/** As stub(), also recording the repoId each createRun asked for. */
function stubRuns(ready: WorkQueueEntry[]) {
  const marks: Array<{ id: string; state: string; reason: string | null }> = [];
  const created: Array<string | null> = [];
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string; id?: string; state?: string; reason?: string | null; input?: { repoId?: string | null }; repoId?: string | null };
    switch (body.op) {
      case 'readyQueueEntries': return json({ ok: true, result: { entries: ready } });
      case 'monthCost': return json({ ok: true, result: { totalUsd: 0 } });
      case 'createRun': created.push(body.input?.repoId ?? body.repoId ?? null); return json({ ok: true, result: { run: { id: 'run_new' } } });
      case 'markQueueEntry': marks.push({ id: body.id!, state: body.state!, reason: body.reason ?? null }); return json({ ok: true, result: { ok: true } });
      default: return json({ ok: true, result: {} });
    }
  }) as unknown as typeof fetch;
  return { marks, created };
}

test('with several repositories, a queued entry that names its repository is dispatched there', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  const { marks, created } = stubRuns([entry({ repoId: 'acme/platform/api/billing' })]);
  const n = await tickQueue({ tickets: qualifyTickets(new MockTicketProvider()), scm: new ManyReposScm(fiveRepos) }, silent);
  assert.equal(n, 1);
  assert.equal(marks[0].state, 'dispatched');
  assert.deepEqual(created, ['acme/platform/api/billing']);
});

test('with several repositories, a queued entry with no repository starts in the one its ticket names', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  const tickets = new MockTicketProvider();
  await tickets.update('asf-1', { title: 'Fix the header in storefront' });
  const { marks, created } = stubRuns([entry({ repoId: null })]);
  const n = await tickQueue({ tickets: qualifyTickets(tickets), scm: new ManyReposScm(fiveRepos) }, silent);
  assert.equal(n, 1, marks[0]?.reason ?? '');
  assert.deepEqual(created, ['acme/platform/web/storefront']);
});

test('with several repositories, a queued entry that names none fails with a reason, not a guess', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  const { marks, created } = stubRuns([entry({ repoId: null })]);
  const n = await tickQueue({ tickets: qualifyTickets(new MockTicketProvider()), scm: new ManyReposScm(fiveRepos) }, silent);
  assert.equal(n, 0);
  assert.equal(marks[0].state, 'failed');
  assert.match(marks[0].reason ?? '', /Choose which repository ASF-1/);
  assert.deepEqual(created, []);
});

test('several trackers: a queued Jira entry dispatches to Jira, not the default tracker', async () => {
  process.env.ORG_MAX_COST_USD = '100';
  process.env.ORG_MONTHLY_BUDGET_USD = '0';
  // Both trackers hold an `asf-1`; only the one the entry names may answer.
  const asked: string[] = [];
  const tracker = (kind: string) => new Proxy(new MockTicketProvider(), {
    get(target, prop, recv) {
      if (prop === 'kind') return kind;
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? (...args: unknown[]) => { asked.push(`${kind} ${String(prop)} ${String(args[0])}`); return v.apply(target, args); } : v;
    },
  }) as unknown as TicketProvider;
  const set = new TicketSet(async (kind) => tracker(kind), () => ['mock', 'jira']);
  const created: Array<{ ticketId: string; ticketProvider: string }> = [];
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string; input?: { ticketId: string; ticketProvider: string } };
    switch (body.op) {
      case 'readyQueueEntries': return json({ ok: true, result: { entries: [entry({ ticketProvider: 'jira' })] } });
      case 'monthCost': return json({ ok: true, result: { totalUsd: 0 } });
      case 'createRun': created.push({ ticketId: body.input!.ticketId, ticketProvider: body.input!.ticketProvider }); return json({ ok: true, result: { run: { id: 'run_new' } } });
      default: return json({ ok: true, result: { ok: true } });
    }
  }) as unknown as typeof fetch;
  const n = await tickQueue({ tickets: set.live, scm: new MockScmProvider() }, silent);
  assert.equal(n, 1);
  assert.deepEqual(created, [{ ticketId: 'asf-1', ticketProvider: 'jira' }]);
  const perTicket = asked.filter((a) => / (get|comment|transitions|assign) /.test(a));
  assert.ok(perTicket.length > 0 && perTicket.every((a) => a.startsWith('jira ')), perTicket.join(', '));
});
