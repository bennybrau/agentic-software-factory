import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeSplitParentIfDone } from './split-parent.js';
import { MockTicketProvider } from '../providers/tickets/mock.js';
import type { SplitFamilyWire, SplitPartWire, TicketProvider } from '@asf/shared';

// Once every part of a split is merged, the parent run's ticket moves to Done and gets
// one comment. The registry (getSplitFamily, getRun) is stubbed; the tracker records calls.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; delete process.env.TICKET_STATUS_DONE; });

const silent = { info: () => {}, error: () => {} };

function part(n: number, merged: boolean, runId: string): SplitPartWire {
  return { part: n, key: `ADHOC-P${n}`, ticketId: `adhoc:p${n}`, title: `Part ${n}`, dependsOn: [], waitingOn: [],
    queueState: 'dispatched', merged,
    run: { id: runId, state: 'running', deliveryOutcome: null, changeRequestUrl: `https://gh/acme/web/pull/${n}`, changeRequestState: 'draft', costUsd: 0 } };
}

function family(parts: SplitPartWire[], currentPart: number | null = 2): SplitFamilyWire {
  return { parent: { runId: 'run_parent', ticketKey: 'JIRA-9', title: 'Big work' }, currentPart, parts };
}

/** Stub the registry: getSplitFamily returns `fam` (or throws), getRun returns the parent run. */
function stub(fam: unknown | (() => never)) {
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string; id?: string };
    switch (body.op) {
      case 'getSplitFamily':
        if (typeof fam === 'function') return json({ ok: false, error: 'boom' }, 500);
        return json({ ok: true, result: fam });
      case 'getRun': return json({ ok: true, result: { run: { id: body.id, ticketId: 'JIRA-9', ticketKey: 'JIRA-9' }, tasks: [] } });
      default: return json({ ok: true, result: {} });
    }
  }) as unknown as typeof fetch;
}
function json(obj: unknown, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }); }

function trackedTickets() {
  const transitioned: string[] = [];
  const comments: Array<{ id: string; md: string }> = [];
  const tickets = new Proxy(new MockTicketProvider(), {
    get(target, prop, recv) {
      if (prop === 'transitions') return async () => [{ id: 'tr_done', name: 'Done', toStatus: 'Done' }];
      if (prop === 'transition') return async (id: string, t: string) => { transitioned.push(`${id} ${t}`); };
      if (prop === 'comment') return async (id: string, md: string) => { comments.push({ id, md }); return { commentId: 'c1' }; };
      return Reflect.get(target, prop, recv);
    },
  }) as unknown as TicketProvider;
  return { tickets, transitioned, comments };
}

test('last part merges: the parent ticket moves to Done and gets one comment', async () => {
  process.env.TICKET_STATUS_DONE = 'Done';
  // Part 2 is this run; the registry hasn't stamped it merged yet.
  stub(family([part(1, true, 'run_p1'), part(2, false, 'run_p2')]));
  const { tickets, transitioned, comments } = trackedTickets();
  await closeSplitParentIfDone(tickets, 'run_p2', silent);
  assert.deepEqual(transitioned, ['JIRA-9 tr_done']);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, 'JIRA-9');
  assert.equal(comments[0].md, 'All 2 parts merged: ADHOC-P1 (https://gh/acme/web/pull/1), ADHOC-P2 (https://gh/acme/web/pull/2)');
});

test('a part still unmerged: no move', async () => {
  process.env.TICKET_STATUS_DONE = 'Done';
  stub(family([part(1, true, 'run_p1'), part(2, false, 'run_p2'), part(3, false, 'run_p3')]));
  const { tickets, transitioned, comments } = trackedTickets();
  await closeSplitParentIfDone(tickets, 'run_p2', silent);
  assert.deepEqual(transitioned, []);
  assert.deepEqual(comments, []);
});

test('not a part, or no split family: no move', async () => {
  process.env.TICKET_STATUS_DONE = 'Done';
  for (const fam of [family([part(1, true, 'run_p1')], null), null, {}]) {
    stub(fam);
    const { tickets, transitioned, comments } = trackedTickets();
    await closeSplitParentIfDone(tickets, 'run_parent', silent);
    assert.deepEqual(transitioned, []);
    assert.deepEqual(comments, []);
  }
});

test('getSplitFamily throws: logged, not thrown', async () => {
  stub(() => { throw new Error('boom'); });
  const errors: unknown[] = [];
  const { tickets, transitioned } = trackedTickets();
  await closeSplitParentIfDone(tickets, 'run_p2', { info: () => {}, error: (o) => { errors.push(o); } });
  assert.deepEqual(transitioned, []);
  assert.equal(errors.length, 1);
});
