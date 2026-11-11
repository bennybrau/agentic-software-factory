import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tickMergeWatch } from './merge-watcher.js';
import { MockTicketProvider } from './providers/tickets/mock.js';
import type { ChangeRequest, Repo, Run, ScmProvider, TicketProvider } from '@asf/shared';

// The watcher asks the registry which runs are awaiting an external merge, reads
// each change request's live state from the SCM, and — when it merged or closed —
// emits the corresponding event back and (merged only) transitions the ticket.
// We stub the registry RPCs it calls (runsAwaitingExternalMerge, appendEvent) and
// record the appended events; the SCM + ticket providers are fakes we control.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; for (const k of ['MERGE_WATCH_ENABLED', 'TICKET_STATUS_DONE']) delete process.env[k]; });

const silent = { info: () => {}, error: () => {} };

function run(over: Partial<Run> = {}): Run {
  return {
    id: 'run_1', ticketId: 'asf-1', ticketKey: 'ASF-1', ticketProvider: 'mock',
    state: 'succeeded', teamName: 'standard', team: null as never, gates: null as never,
    repoId: '1', worktreePath: null, branchName: 'asf/asf-1',
    changeRequestUrl: 'mock://repos/example/app/pulls/1', changeRequestNumber: 1,
    changeRequestState: 'ready', deliveryOutcome: 'awaiting_external_merge',
    costUsd: 0, maxCostUsd: null, reviewIterations: 0, dispatchedBy: 'jon', reason: null,
    createdAt: new Date().toISOString(), startedAt: null, lastEventAt: new Date().toISOString(),
    cancelRequestedAt: null, finishedAt: new Date().toISOString(), ...over,
  } as Run;
}

/** A ScmProvider whose getChangeRequest returns a CR in the given state. */
function scmReturning(state: ChangeRequest['state']): ScmProvider {
  const repo: Repo = { id: '1', path: 'example/app', url: 'mock://repos/example/app', defaultBranch: 'main', cloneUrl: '/tmp/x.git' };
  const cr: ChangeRequest = { id: '1', number: 1, repoId: '1', url: repo.url + '/pulls/1', title: 't', state,
    draft: false, headBranch: 'asf/asf-1', baseBranch: 'main', reviewState: 'approved', ciState: 'success', updatedAt: new Date().toISOString() };
  return {
    kind: 'mock', preflight: async () => ({ ok: true, identity: 'mock' }),
    searchRepos: async () => [repo], getRepo: async () => repo,
    cloneCredential: async () => ({ url: repo.cloneUrl }),
    openChangeRequest: async () => cr, listChangeRequests: async () => [cr],
    getChangeRequest: async () => ({ ...cr, diffRefs: null }),
    listReviewComments: async () => [], replyToThread: async () => {}, comment: async () => {},
    markReady: async () => {}, merge: async () => {},
  } as ScmProvider;
}

/** Stub the registry: runsAwaitingExternalMerge returns `runs`; appendEvent calls are captured. */
function stub(runs: Run[]) {
  const events: Array<{ runId: string; kind: string }> = [];
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string; input?: { runId: string; kind: string } };
    switch (body.op) {
      case 'runsAwaitingExternalMerge': return json({ ok: true, result: { runs } });
      case 'appendEvent': events.push({ runId: body.input!.runId, kind: body.input!.kind }); return json({ ok: true, result: { event: {} } });
      default: return json({ ok: true, result: {} });
    }
  }) as unknown as typeof fetch;
  return events;
}
function json(obj: unknown) { return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } }); }

/** A ticket provider that records transition() calls so we can assert Done moves. */
function trackedTickets(): { tickets: TicketProvider; transitioned: string[] } {
  const base = new MockTicketProvider();
  const transitioned: string[] = [];
  const tickets = new Proxy(base, {
    get(target, prop, recv) {
      if (prop === 'transitions') return async () => [{ id: 'tr_done', name: 'Done', toStatus: 'Done' }];
      if (prop === 'transition') return async (_id: string, transitionId: string) => { transitioned.push(transitionId); };
      return Reflect.get(target, prop, recv);
    },
  }) as unknown as TicketProvider;
  return { tickets, transitioned };
}

test('merged externally: emits change_request:merged and moves the ticket to Done', async () => {
  process.env.MERGE_WATCH_ENABLED = 'true';
  process.env.TICKET_STATUS_DONE = 'Done';
  const events = stub([run()]);
  const { tickets, transitioned } = trackedTickets();
  const n = await tickMergeWatch({ tickets, scm: scmReturning('merged') }, silent);
  assert.equal(n, 1);
  assert.deepEqual(events, [{ runId: 'run_1', kind: 'change_request:merged' }]);
  assert.deepEqual(transitioned, ['tr_done']);
});

test('closed without merging: emits change_request:closed and leaves the ticket alone', async () => {
  process.env.MERGE_WATCH_ENABLED = 'true';
  process.env.TICKET_STATUS_DONE = 'Done';
  const events = stub([run()]);
  const { tickets, transitioned } = trackedTickets();
  const n = await tickMergeWatch({ tickets, scm: scmReturning('closed') }, silent);
  assert.equal(n, 1);
  assert.deepEqual(events, [{ runId: 'run_1', kind: 'change_request:closed' }]);
  assert.deepEqual(transitioned, []); // ticket untouched on a rejected CR
});

test('recorded closed but actually merged: corrects it to merged and moves the ticket to Done', async () => {
  // The SCM said "closed" a moment after the merge; the run stays watched and is corrected.
  process.env.MERGE_WATCH_ENABLED = 'true';
  process.env.TICKET_STATUS_DONE = 'Done';
  const events = stub([run({ changeRequestState: 'closed' })]);
  const { tickets, transitioned } = trackedTickets();
  const n = await tickMergeWatch({ tickets, scm: scmReturning('merged') }, silent);
  assert.equal(n, 1);
  assert.deepEqual(events, [{ runId: 'run_1', kind: 'change_request:merged' }]);
  assert.deepEqual(transitioned, ['tr_done']);
});

test('recorded closed and still closed: no repeat event or notification', async () => {
  process.env.MERGE_WATCH_ENABLED = 'true';
  const events = stub([run({ changeRequestState: 'closed' })]);
  const { tickets } = trackedTickets();
  const n = await tickMergeWatch({ tickets, scm: scmReturning('closed') }, silent);
  assert.equal(n, 0);
  assert.deepEqual(events, []);
});

test('still open: no event, nothing resolved', async () => {
  process.env.MERGE_WATCH_ENABLED = 'true';
  const events = stub([run()]);
  const { tickets } = trackedTickets();
  const n = await tickMergeWatch({ tickets, scm: scmReturning('open') }, silent);
  assert.equal(n, 0);
  assert.deepEqual(events, []);
});

test('disabled: does not even query the registry', async () => {
  process.env.MERGE_WATCH_ENABLED = 'false';
  let queried = false;
  global.fetch = (async () => { queried = true; return json({ ok: true, result: { runs: [] } }); }) as unknown as typeof fetch;
  const { tickets } = trackedTickets();
  const n = await tickMergeWatch({ tickets, scm: scmReturning('merged') }, silent);
  assert.equal(n, 0);
  assert.equal(queried, false);
});

test('one bad run does not stall the batch', async () => {
  process.env.MERGE_WATCH_ENABLED = 'true';
  process.env.TICKET_STATUS_DONE = 'Done';
  const events = stub([run({ id: 'run_bad', repoId: 'gone' }), run({ id: 'run_ok' })]);
  const { tickets } = trackedTickets();
  // getRepo throws for the unknown repo id on the first run; the second still resolves.
  const scm = scmReturning('merged');
  const realGetRepo = scm.getRepo.bind(scm);
  scm.getRepo = (async (id: string) => { if (id === 'gone') throw new Error('no repo'); return realGetRepo(id); }) as ScmProvider['getRepo'];
  const n = await tickMergeWatch({ tickets, scm }, silent);
  assert.equal(n, 1);
  assert.deepEqual(events, [{ runId: 'run_ok', kind: 'change_request:merged' }]);
});
