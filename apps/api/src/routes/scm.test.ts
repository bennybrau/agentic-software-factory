import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { RunEvent, ReviewThread } from '@asf/shared';
import { registerBrowserRoutes } from './browser.js';
import { registerScmRoutes, threadReplies } from './scm.js';
import { MockTicketProvider } from '../providers/tickets/mock.js';
import { MockScmProvider } from '../providers/scm/mock.js';

// Replying on addressed review threads (#109 part 3): the browser route records which
// threads were sent, the implementer's thread-replies.json is saved, and the publish
// step's call posts the replies. The registry is stubbed in memory; the SCM is the mock.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

const RUN = 'run_threads01';
const secret = { 'x-run-secret': process.env.RUN_EVENT_SECRET ?? '' };

function thread(id: string): ReviewThread {
  return { id, resolved: false, path: 'src/a.ts', line: 3, author: 'ana', authorIsTokenAccount: false, own: false, body: `body ${id}`, createdAt: '', replies: [] };
}

/** An in-memory registry: events with seq/at, artifact versions with createdAt, on one shared clock. */
function stubRegistry(changeRequestNumber: number) {
  const events: RunEvent[] = [];
  const versions: Array<{ name: string; content: string; taskId: string | null; attempt: number | null; source: string; createdAt: string }> = [];
  let tick = Date.parse('2026-11-12T10:00:00Z');
  const now = () => new Date(tick += 1000).toISOString();
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown> & { op: string };
    const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    switch (body.op) {
      case 'getRun': return reply({ run: { id: RUN, ticketId: 'JIRA-1', state: 'succeeded', repoId: '1',
        changeRequestUrl: 'mock://repos/example/app/pulls/1', changeRequestNumber, team: {} }, tasks: [] });
      case 'requestChanges': return reply({ message: {} });
      case 'appendEvent': {
        const input = body.input as Omit<RunEvent, 'id' | 'seq' | 'at'>;
        const ev = { ...input, id: events.length + 1, seq: events.length + 1, at: now() } as RunEvent;
        events.push(ev);
        return reply({ event: ev });
      }
      case 'getEvents': return reply({ events: events.filter((e) => e.seq > Number(body.afterSeq)).slice(0, Number(body.limit)) });
      case 'saveArtifact':
        versions.unshift({ name: String(body.name), content: String(body.content), taskId: null, attempt: null, source: 'agent', createdAt: now() });
        return reply({ ok: true });
      case 'listArtifactVersions': return reply({ versions });
      default: return reply({});
    }
  }) as unknown as typeof fetch;
  return {
    events,
    save: (name: string, content: string) => fetch('http://registry/internal/rpc', { method: 'POST', body: JSON.stringify({ op: 'saveArtifact', name, content }) }),
  };
}

async function setup() {
  const scm = new MockScmProvider();
  const cr = await scm.openChangeRequest(await scm.getRepo('1'), { head: 'agent/x', base: 'main', title: 't', body: '', draft: true });
  scm.seedThreads(cr.number, [thread('t1'), thread('t2'), thread('t3')]);
  const reg = stubRegistry(cr.number);
  const a = Fastify();
  const tickets = new MockTicketProvider();
  registerBrowserRoutes(a, { tickets, scm });
  registerScmRoutes(a, { tickets, scm });
  await a.ready();
  return { a, scm, cr, reg };
}

test('the update push replies only on sent threads with an entry, once, and resolves nothing', async () => {
  const { a, scm, cr, reg } = await setup();
  const sent = await a.inject({ method: 'POST', url: `/api/runs/${RUN}/address-review-comments`, payload: { threadIds: ['t1', 't2'] } });
  assert.equal(sent.statusCode, 200);
  assert.deepEqual(sent.json().sentIds, ['t1', 't2']);
  // The implementer answered t1 (sent) and t3 (never sent); nothing for t2.
  await reg.save('thread-replies.json', JSON.stringify([
    { thread: 't1', reply: '  Renamed the flag to `dryRun`.  ' },
    { thread: 't3', reply: 'Not asked about this one.' },
  ]));

  const res = await a.inject({ method: 'POST', url: '/api/scm/thread-replies', headers: secret, payload: { runId: RUN, number: cr.number } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { replied: ['t1'], failed: [] });
  assert.deepEqual(scm.repliesFor(cr.number), [{ threadId: 't1', body: `Renamed the flag to \`dryRun\`.\n\n— ASF run ${RUN}\n\n<!-- asf -->` }]);
  assert.equal((await scm.listChangeRequests()).length, 1, 'still the one change request');
  assert.ok((await scm.listReviewComments(await scm.getRepo('1'), cr.number)).every((t) => !t.resolved), 'no thread is resolved');
  const replied = reg.events.filter((e) => e.kind === 'review_threads:replied');
  assert.deepEqual(replied.map((e) => e.payload), [{ number: cr.number, replied: ['t1'], failed: [] }]);

  const again = await a.inject({ method: 'POST', url: '/api/scm/thread-replies', headers: secret, payload: { runId: RUN, number: cr.number } });
  assert.deepEqual(again.json(), { replied: [], failed: [] });
  assert.equal(scm.repliesFor(cr.number).length, 1, 'a second call posts nothing');
  assert.equal(reg.events.filter((e) => e.kind === 'review_threads:replied').length, 1, 'and records nothing');
  await a.close();
});

test('a thread-replies.json older than the sent event is ignored', async () => {
  const { a, scm, cr, reg } = await setup();
  await reg.save('thread-replies.json', JSON.stringify([{ thread: 't1', reply: 'From an earlier round.' }]));
  await a.inject({ method: 'POST', url: `/api/runs/${RUN}/address-review-comments`, payload: { threadIds: ['t1'] } });
  const res = await a.inject({ method: 'POST', url: '/api/scm/thread-replies', headers: secret, payload: { runId: RUN, number: cr.number } });
  assert.deepEqual(res.json(), { replied: [], failed: [] });
  assert.deepEqual(scm.repliesFor(cr.number), []);
  await a.close();
});

test('nothing sent, or sent for another number: no reply and no event', async () => {
  const { a, scm, cr, reg } = await setup();
  const call = (number: number) => a.inject({ method: 'POST', url: '/api/scm/thread-replies', headers: secret, payload: { runId: RUN, number } });
  assert.deepEqual((await call(cr.number)).json(), { replied: [], failed: [] });
  await a.inject({ method: 'POST', url: `/api/runs/${RUN}/address-review-comments`, payload: { threadIds: ['t1'] } });
  await reg.save('thread-replies.json', JSON.stringify([{ thread: 't1', reply: 'Done.' }]));
  assert.deepEqual((await call(cr.number + 1)).json(), { replied: [], failed: [] });
  assert.deepEqual(scm.repliesFor(cr.number), []);
  assert.ok(!reg.events.some((e) => e.kind === 'review_threads:replied'));
  await a.close();
});

test('a failed reply is reported per thread; a long reply is capped', async () => {
  const { a, scm, cr, reg } = await setup();
  const real = scm.replyToThread.bind(scm);
  scm.replyToThread = async (repo, number, threadId, body) => { if (threadId === 't2') throw new Error('thread is locked'); return real(repo, number, threadId, body); };
  await a.inject({ method: 'POST', url: `/api/runs/${RUN}/address-review-comments`, payload: { threadIds: ['t1', 't2'] } });
  await reg.save('thread-replies.json', JSON.stringify([{ thread: 't1', reply: 'x'.repeat(900) }, { thread: 't2', reply: 'ok' }]));
  const res = await a.inject({ method: 'POST', url: '/api/scm/thread-replies', headers: secret, payload: { runId: RUN, number: cr.number } });
  assert.deepEqual(res.json(), { replied: ['t1'], failed: [{ thread: 't2', reason: 'thread is locked' }] });
  const body = scm.repliesFor(cr.number)[0].body;
  assert.ok(body.startsWith(`${'x'.repeat(599)}…\n\n— ASF run ${RUN}`), body.slice(590, 640));
  assert.deepEqual(reg.events.at(-1)?.payload, { number: cr.number, replied: ['t1'], failed: [{ thread: 't2', reason: 'thread is locked' }] });
  await a.close();
});

test('the run secret guards thread-replies', async () => {
  const { a } = await setup();
  const res = await a.inject({ method: 'POST', url: '/api/scm/thread-replies', headers: { 'x-run-secret': 'wrong' }, payload: { runId: RUN, number: 1 } });
  assert.equal(res.statusCode, 401);
  await a.close();
});

test('threadReplies reads leniently: bad JSON or bad entries are no entries', () => {
  assert.deepEqual(threadReplies(undefined), []);
  assert.deepEqual(threadReplies('not json'), []);
  assert.deepEqual(threadReplies('{"thread":"t1","reply":"x"}'), []);
  assert.deepEqual(threadReplies(JSON.stringify([null, 3, { thread: 't1' }, { thread: '', reply: 'x' }, { thread: 't2', reply: '  ' }, { thread: 't3', reply: 'ok' }])),
    [{ thread: 't3', reply: 'ok' }]);
});
