import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ticket, TicketProvider } from '@asf/shared';
import { TicketSet, qualifyTickets, ticketConnections } from './set.js';

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

// --- Several trackers (M12 WP3) ---

/** A TicketSet over recording providers, one per kind; `down` kinds fail to list. */
function twoTrackers(list: string[] = ['jira', 'github'], down: string[] = []) {
  const built = new Map<string, ReturnType<typeof recording>>();
  const set = new TicketSet(async (kind) => {
    const r = recording(kind as TicketProvider['kind']);
    if (down.includes(kind)) r.p.list = async () => { throw new Error(`${kind} is down`); };
    else r.p.list = async () => ({ tickets: [ticket(kind === 'github' ? 'acme/web#1' : 'PROJ-1')], next: 'c2' });
    built.set(kind, r);
    return r.p;
  }, () => list);
  return { set, seen: (kind: string) => built.get(kind)?.seen ?? [] };
}

test('ticketConnections: split, trimmed, deduped, known kinds only; empty falls back to TICKET_PROVIDER', () => {
  const of = (list: string) => (k: string) => (k === 'TICKET_PROVIDERS' ? list : 'jira');
  assert.deepEqual(ticketConnections(of(' github, jira ,github,nope ')), ['github', 'jira']);
  assert.deepEqual(ticketConnections(of('')), ['jira']);
  assert.deepEqual(ticketConnections(of('nope')), ['jira']);
});

test('the set routes each id to the tracker its prefix names; a bare id goes to the default', async () => {
  const { set, seen } = twoTrackers();
  assert.deepEqual([set.connections, set.defaultConnection, set.live.kind], [['jira', 'github'], 'jira', 'jira']);
  assert.equal((await set.live.get('github:acme/web#42')).id, 'github:acme/web#42');
  assert.equal((await set.live.get('PROJ-7')).id, 'jira:PROJ-7');
  await set.live.comment('github:acme/web#42', 'hi');
  await set.live.transition('jira:PROJ-7', '21');
  assert.deepEqual(seen('github'), ['get acme/web#42', 'comment acme/web#42']);
  assert.deepEqual(seen('jira'), ['get PROJ-7', 'transition PROJ-7']);
  assert.equal(set.ticketsFor('github:acme/web#42').kind, 'github');
  assert.equal(set.ticketsFor({ ...ticket('x'), connection: 'github' }).kind, 'github');
});

test('a connection that is not set up throws from ticketsFor and rejects from live', async () => {
  const { set } = twoTrackers();
  assert.throws(() => set.ticketsFor('trello:card1'), /Ticket connection "trello" is not set up/);
  await assert.rejects(set.live.get('trello:card1'), /not set up/);
  assert.throws(() => set.registryFor('trello'), /not set up/);
});

test('listAll merges every tracker in connection order, or only the ones asked for', async () => {
  const { set } = twoTrackers();
  const all = await set.live.listAll({ scope: [], limit: 10 });
  assert.deepEqual(all.tickets.map((t) => [t.id, t.connection]), [['jira:PROJ-1', 'jira'], ['github:acme/web#1', 'github']]);
  assert.deepEqual(all.sources, [{ connection: 'jira', ok: true }, { connection: 'github', ok: true }]);
  assert.ok(!('next' in all), 'no paging cursor across trackers');
  const one = await set.live.listAll({ scope: [], limit: 10 }, ['github']);
  assert.deepEqual(one.tickets.map((t) => t.id), ['github:acme/web#1']);
});

test('one tracker failing: its reason shows and the other still lists', async () => {
  const { set } = twoTrackers(['jira', 'github'], ['jira']);
  const r = await set.live.listAll({ scope: [], limit: 10 });
  assert.deepEqual(r.tickets.map((t) => t.id), ['github:acme/web#1']);
  assert.deepEqual(r.sources, [{ connection: 'jira', ok: false, reason: 'jira is down' }, { connection: 'github', ok: true }]);
});
