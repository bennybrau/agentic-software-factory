import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { Ticket, TicketListQuery, TicketProvider } from '@asf/shared';
import { registerTicketRoutes } from './tickets.js';
import { TicketSet } from '../providers/tickets/set.js';

// The Planned tasks routes over several trackers (M12 WP3): the `connection`
// parameter picks which trackers list and which one answers discovery, and
// `find` sends each looked-up id to the tracker its form names.
afterEach(() => { delete process.env.JIRA_PROJECTS; });

const ticket = (id: string): Ticket => ({
  id, key: id, url: '', title: 'T', body: '', status: 'To Do', bucket: 'ready', priority: null, assignee: null,
  labels: [], links: [], parentId: null, children: [], updatedAt: '2026-11-01T00:00:00Z',
});

/** A tracker of one kind holding `ids`, recording each list query and each id it is asked for. */
function fake(kind: string, ids: string[], log: { lists: Array<[string, TicketListQuery]>; gets: string[] }): TicketProvider {
  const boards = kind === 'jira';
  return {
    kind,
    preflight: async () => ({ ok: true, identity: kind }),
    capabilities: () => ({ subtasks: false, priority: false, links: false, transitions: false, assignable: false, boards, sprints: boards, statuses: boards }),
    list: async (q: TicketListQuery) => { log.lists.push([kind, q]); return { tickets: ids.map(ticket), next: 'c' }; },
    get: async (id: string) => { log.gets.push(`${kind} ${id}`); if (!ids.includes(id)) throw new Error('404'); return ticket(id); },
    listScopes: async () => [{ id: '10', name: `${kind} board` }],
    listSprints: async (scope: string) => [{ id: '5', name: `sprint of ${scope}`, state: 'active' }],
    listStatuses: async () => ['To Do'],
  } as unknown as TicketProvider;
}

async function app(connections = ['jira', 'github'], scmConnections = ['github']) {
  const log = { lists: [] as Array<[string, TicketListQuery]>, gets: [] as string[] };
  const held: Record<string, string[]> = { jira: ['PROJ-12', 'ABC-5'], github: ['acme/web#3'], trello: [] };
  const set = new TicketSet(async (kind) => fake(kind, held[kind] ?? [], log), () => connections);
  const a = Fastify();
  registerTicketRoutes(a, { set, scm: { connections: scmConnections } });
  await a.ready();
  const get = async (url: string) => { const r = await a.inject({ url }); return { status: r.statusCode, body: r.json() }; };
  return { get, log };
}

test('GET /api/connections names the trackers and code hosts in connection order', async () => {
  const { get } = await app(['github', 'jira'], ['gitlab', 'github']);
  const r = await get('/api/connections');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { tickets: ['github', 'jira'], scm: ['gitlab', 'github'] });
});

test('GET /api/tickets lists every tracker by default, without board, sprint or status filters', async () => {
  const { get, log } = await app();
  const r = await get('/api/tickets?scope=10&sprint=5&status=To%20Do');
  assert.deepEqual(r.body.tickets.map((t: Ticket) => t.id), ['jira:PROJ-12', 'jira:ABC-5', 'github:acme/web#3']);
  assert.deepEqual(r.body.sources, [{ connection: 'jira', ok: true }, { connection: 'github', ok: true }]);
  assert.equal(r.body.next, undefined);
  assert.deepEqual(log.lists.map(([k, q]) => [k, q.scope, q.sprint, q.status]), [['jira', [], undefined, undefined], ['github', [], undefined, undefined]]);
});

test('GET /api/tickets?connection= lists only that tracker, with its filters', async () => {
  const { get, log } = await app();
  const r = await get('/api/tickets?connection=jira&scope=10&sprint=5');
  assert.deepEqual(r.body.sources, [{ connection: 'jira', ok: true }]);
  assert.deepEqual(log.lists.map(([k, q]) => [k, q.scope, q.sprint]), [['jira', ['10'], ['5']]]);
  const unknown = await get('/api/tickets?connection=trello');
  assert.deepEqual(unknown.body, { tickets: [], sources: [{ connection: 'trello', ok: false, reason: 'Ticket connection "trello" is not set up' }] });
});

test('discovery asks the default tracker, or ?connection=; capabilities are the built tracker\'s', async () => {
  const { get } = await app();
  // The first call on a fresh set: capabilities come from the real jira tracker, not the all-false placeholder.
  assert.deepEqual((await get('/api/tickets/scopes')).body, [{ id: '10', name: 'jira board' }]);
  assert.deepEqual((await get('/api/tickets/scopes/10/sprints')).body, [{ id: '5', name: 'sprint of 10', state: 'active' }]);
  assert.deepEqual((await get('/api/tickets/statuses?connection=jira')).body, ['To Do']);
  assert.deepEqual((await get('/api/tickets/scopes?connection=github')).body, [], 'github has no boards');
  assert.deepEqual((await get('/api/tickets/statuses?connection=github')).body, []);
  const bad = await get('/api/tickets/scopes?connection=trello');
  assert.equal(bad.status, 400);
  assert.match(bad.body.reason, /not set up/);
});

test('find: a PROJ-12 key goes to Jira, owner/repo#n to GitHub, a qualified id to its own tracker', async () => {
  const { get, log } = await app();
  assert.deepEqual((await get('/api/tickets/find?q=proj-12')).body.tickets.map((t: Ticket) => t.id), ['jira:PROJ-12']);
  assert.deepEqual(log.gets, ['jira PROJ-12']);
  log.gets.length = 0;
  assert.deepEqual((await get('/api/tickets/find?q=acme/web%233')).body.tickets.map((t: Ticket) => t.id), ['github:acme/web#3']);
  assert.deepEqual(log.gets, ['github acme/web#3']);
  log.gets.length = 0;
  assert.deepEqual((await get('/api/tickets/find?q=github:acme/web%233')).body.tickets.map((t: Ticket) => t.id), ['github:acme/web#3']);
  assert.deepEqual(log.gets, ['github acme/web#3']);
});

test('find: a form no connected tracker claims asks every tracker', async () => {
  const { get, log } = await app(['github', 'trello']);
  assert.deepEqual((await get('/api/tickets/find?q=PROJ-12')).body.tickets, []);
  assert.deepEqual(log.gets.sort(), ['github PROJ-12', 'trello PROJ-12']);
});

test('find: JIRA_PROJECTS prefixes a bare number only when Jira is connected', async () => {
  process.env.JIRA_PROJECTS = 'ABC';
  const withJira = await app();
  assert.deepEqual((await withJira.get('/api/tickets/find?q=5')).body.tickets.map((t: Ticket) => t.id), ['jira:ABC-5']);
  const without = await app(['github']);
  assert.deepEqual((await without.get('/api/tickets/find?q=5')).body.tickets, []);
  assert.deepEqual(without.log.gets, [], 'no prefixes, so nothing to look up');
});
