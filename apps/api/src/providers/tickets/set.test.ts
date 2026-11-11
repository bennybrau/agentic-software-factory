import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ticket, TicketProvider } from '@asf/shared';
import { qualifyTickets } from './set.js';

const ticket = (id: string, over: Partial<Ticket> = {}): Ticket => ({
  id, key: id, url: '', title: 'T', body: '', status: 'To Do', bucket: 'ready', priority: null, assignee: null,
  labels: [], links: [], parentId: null, children: [], updatedAt: '2026-11-01T00:00:00Z', ...over,
});

/** A provider that records every id it is handed and answers with native-id tickets. */
function recording(kind: TicketProvider['kind'] = 'jira') {
  const seen: string[] = [];
  const p = {
    kind,
    preflight: async () => ({ ok: true as const, identity: 'x' }),
    capabilities: () => ({ subtasks: true, priority: true, links: true, transitions: true, assignable: true, boards: false, sprints: false, statuses: false }),
    list: async () => ({ tickets: [ticket('PROJ-1', { parentId: 'PROJ-0', children: ['PROJ-2'] })], next: 'c2' }),
    get: async (id: string) => { seen.push(`get ${id}`); return ticket(id); },
    update: async (id: string) => { seen.push(`update ${id}`); return ticket(id); },
    createSubtask: async (parentId: string) => { seen.push(`createSubtask ${parentId}`); return ticket('PROJ-9', { parentId }); },
    addLink: async (id: string) => { seen.push(`addLink ${id}`); },
    comment: async (id: string) => { seen.push(`comment ${id}`); return { commentId: 'c' }; },
    listComments: async (id: string) => { seen.push(`listComments ${id}`); return []; },
    transitions: async (id: string) => { seen.push(`transitions ${id}`); return []; },
    transition: async (id: string) => { seen.push(`transition ${id}`); },
    assign: async (id: string) => { seen.push(`assign ${id}`); },
    listScopes: async () => [],
    listSprints: async () => [],
    listStatuses: async () => [],
    suggestedRepo: (t: Ticket) => { seen.push(`suggestedRepo ${t.id}`); return 'acme/web'; },
  } satisfies TicketProvider;
  return { p, seen };
}

test('the provider receives native ids, whether the caller passed a qualified or a bare one', async () => {
  const { p, seen } = recording();
  const q = qualifyTickets(p);
  for (const id of ['jira:PROJ-12', 'PROJ-12']) {
    await q.get(id); await q.update(id, { title: 'x' }); await q.createSubtask(id, { title: 's' });
    await q.addLink(id, { title: 'l', url: 'https://x.test', kind: 'other' }); await q.comment(id, 'hi');
    await q.listComments(id); await q.transitions(id); await q.transition(id, '21'); await q.assign(id, 'bot');
  }
  assert.ok(seen.length > 0 && seen.every((s) => s.endsWith(' PROJ-12')), seen.join(', '));
});

test('every ticket out carries its connection and qualified ids', async () => {
  const q = qualifyTickets(recording().p);
  const listed = await q.list({ scope: [], limit: 10 });
  assert.equal(listed.next, 'c2');
  assert.deepEqual(listed.tickets.map((t) => [t.id, t.connection, t.parentId, t.children]), [['jira:PROJ-1', 'jira', 'jira:PROJ-0', ['jira:PROJ-2']]]);
  assert.equal((await q.get('PROJ-3')).id, 'jira:PROJ-3');
  assert.equal((await q.update('jira:PROJ-3', {})).id, 'jira:PROJ-3');
  const sub = await q.createSubtask('jira:PROJ-3', { title: 's' });
  assert.deepEqual([sub.id, sub.parentId, sub.connection], ['jira:PROJ-9', 'jira:PROJ-3', 'jira']);
});

test('suggestedRepo gets the ticket back with its native id; kind passes through', () => {
  const { p, seen } = recording('github');
  const q = qualifyTickets(p);
  assert.equal(q.kind, 'github');
  assert.equal(q.suggestedRepo?.(ticket('github:acme/web#42')), 'acme/web');
  assert.deepEqual(seen, ['suggestedRepo acme/web#42']);
  const { suggestedRepo: _, ...without } = p;
  assert.equal(qualifyTickets(without).suggestedRepo, undefined, 'a provider with no suggestion still has none');
});

test('kind follows a hot-swapping provider; ad-hoc ids keep their adhoc: prefix both ways', async () => {
  const { p, seen } = recording('adhoc');
  const live = { ...p } as TicketProvider;
  const q = qualifyTickets(live);
  assert.equal((await q.get('adhoc:ce17')).id, 'adhoc:ce17');
  assert.deepEqual(seen, ['get adhoc:ce17']);
  (live as { kind: string }).kind = 'mock';
  assert.equal(q.kind, 'mock');
  assert.equal((await q.get('asf-1')).id, 'mock:asf-1');
});
