import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AdhocTicketProvider, adhocToTicket } from './adhoc.js';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

const TASK = {
  id: 'adhoc:0123456789abcdef', key: 'ADHOC-01234567', title: 'Fix the login page', body: 'It **breaks**.',
  createdBy: 'ana', attachments: [{ name: 'shot.png', mime: 'image/png', size: 4 }], createdAt: '2026-09-30T00:00:00.000Z',
};

function stubRegistry() {
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string; id?: string };
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    switch (body.op) {
      case 'listAdhoc': return ok({ tasks: [TASK] });
      case 'getAdhoc': return ok({ task: body.id === TASK.id ? TASK : null });
      default: return ok({});
    }
  }) as unknown as typeof fetch;
}

test('list() returns every stored ad-hoc task as a neutral, read-only ticket', async () => {
  stubRegistry();
  const { tickets } = await new AdhocTicketProvider().list();
  assert.deepEqual(tickets, [adhocToTicket(TASK)]);
  assert.equal(tickets[0].status, 'Ad-hoc');
  assert.equal(tickets[0].url, '');
});

test('get() resolves a stored task; a missing id throws', async () => {
  stubRegistry();
  const p = new AdhocTicketProvider();
  assert.deepEqual(await p.get(TASK.id), adhocToTicket(TASK));
  await assert.rejects(() => p.get('adhoc:missing'));
});

test('get() carries the schedule that created the task, with a null title once it is deleted', async () => {
  const withTask = (task: Record<string, unknown>) => {
    global.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { task } }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  };
  const p = new AdhocTicketProvider();
  withTask({ ...TASK, recurringId: 'rec_1', recurringTitle: 'Update deps' });
  const t = await p.get(TASK.id);
  assert.equal(t.recurringId, 'rec_1');
  assert.equal(t.recurringTitle, 'Update deps');
  withTask({ ...TASK, recurringId: 'rec_1', recurringTitle: null });
  const orphan = await p.get(TASK.id);
  assert.equal(orphan.recurringId, 'rec_1');
  assert.equal(orphan.recurringTitle, null);
});


test('suggestedRepo is the repository of the run that added the to-do, or null', () => {
  const p = new AdhocTicketProvider();
  assert.equal(p.suggestedRepo(adhocToTicket({ ...TASK, sourceRepoId: 'bennybrau/hive' })), 'bennybrau/hive');
  assert.equal(p.suggestedRepo(adhocToTicket(TASK)), null);
});

test('update/createSubtask/addLink refuse: ad-hoc tasks are not editable', async () => {
  const p = new AdhocTicketProvider();
  await assert.rejects(() => p.update());
  await assert.rejects(() => p.createSubtask());
  await assert.rejects(() => p.addLink());
});
