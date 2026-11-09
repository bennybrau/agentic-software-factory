import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TicketScope } from '@asf/shared';
import { BACKLOG_FILTERS_KEY, loadBacklogFilters, NO_FILTERS, restoreScope, saveBacklogFilters, type FilterStore, latestOnly, nextSort, sortTickets } from './backlog-filters';

function memStore(init?: string): FilterStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  if (init !== undefined) map.set(BACKLOG_FILTERS_KEY, init);
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
}
const broken: FilterStore = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };

const board = (id: string, team: string | null, boardType?: 'scrum' | 'kanban') =>
  ({ id, name: id, kind: 'board', team, boardType } as unknown as TicketScope);
const scopes = [board('b1', 'Payments', 'scrum'), board('b2', 'Payments', 'kanban'), board('b3', 'Search')];

test('every filter round-trips', () => {
  const s = memStore();
  const f = { team: 'Payments', scope: 'b1', sprint: '42', status: ['To Do', 'In Review'], bucket: 'inflight', showDone: true, sortBy: 'priority' as const, sortDir: 'desc' as const };
  saveBacklogFilters(f, s);
  assert.deepEqual(loadBacklogFilters(s), f);
});

test('nothing saved, garbage, or no storage loads as no filters', () => {
  assert.deepEqual(loadBacklogFilters(memStore()), NO_FILTERS);
  assert.deepEqual(loadBacklogFilters(memStore('not json')), NO_FILTERS);
  assert.deepEqual(loadBacklogFilters(memStore('[1,2]')), NO_FILTERS);
  assert.deepEqual(loadBacklogFilters(memStore('null')), NO_FILTERS);
  assert.deepEqual(loadBacklogFilters(null), NO_FILTERS);
  assert.deepEqual(loadBacklogFilters(broken), NO_FILTERS);
  assert.deepEqual(loadBacklogFilters(), NO_FILTERS); // node: no localStorage at all
});

test('filters saved by the previous version (no bucket/showDone) still load', () => {
  const f = loadBacklogFilters(memStore(JSON.stringify({ team: 'Payments', scope: 'b2', sprint: '', status: ['Done'] })));
  assert.deepEqual(f, { team: 'Payments', scope: 'b2', sprint: '', status: ['Done'], bucket: '', showDone: false, sortBy: 'updated', sortDir: 'desc' });
});

test('malformed fields are dropped one by one', () => {
  const f = loadBacklogFilters(memStore(JSON.stringify({ team: 7, scope: 'b1', status: ['ok', 3, null], bucket: 'done', showDone: 'yes', sortBy: 'title', sortDir: 'up' })));
  assert.deepEqual(f, { team: '', scope: 'b1', sprint: '', status: ['ok'], bucket: '', showDone: false, sortBy: 'updated', sortDir: 'desc' });
});

test('saving to storage that throws is ignored', () => {
  assert.doesNotThrow(() => saveBacklogFilters(NO_FILTERS, broken));
});

test('a board that still exists is restored with its own team and the sprint', () => {
  assert.deepEqual(restoreScope({ team: 'Search', scope: 'b1', sprint: 'active' }, scopes), { team: 'Payments', scope: 'b1', sprint: 'active' });
  assert.deepEqual(restoreScope({ team: '', scope: 'b3', sprint: '' }, scopes), { team: 'Search', scope: 'b3', sprint: '' });
});

test('a board that is gone falls back to its team, else to everything', () => {
  assert.deepEqual(restoreScope({ team: 'Payments', scope: 'gone', sprint: '9' }, scopes), { team: 'Payments', scope: '', sprint: '' });
  assert.deepEqual(restoreScope({ team: 'Gone team', scope: 'gone', sprint: '9' }, scopes), { team: '', scope: '', sprint: '' });
  assert.deepEqual(restoreScope({ team: 'Payments', scope: '', sprint: '' }, []), { team: '', scope: '', sprint: '' });
});

test('latestOnly: a slower, older load answering last is ignored', async () => {
  const next = latestOnly();
  const list: string[][] = [];
  const load = (rows: string[], ms: number) => {
    const isLatest = next();
    return new Promise<void>((r) => setTimeout(r, ms)).then(() => { if (isLatest()) list.push(rows); });
  };
  // All boards (slow) starts first, then the saved board (fast) replaces it.
  await Promise.all([load(['all-1', 'all-2'], 20), load(['board-1'], 5)]);
  assert.deepEqual(list, [['board-1']]);
});

test('latestOnly: each new load supersedes the one before', () => {
  const next = latestOnly();
  const a = next();
  assert.equal(a(), true);
  const b = next();
  assert.equal(a(), false);
  assert.equal(b(), true);
});

test('a saved sort column without a direction gets that column’s default', () => {
  assert.equal(loadBacklogFilters(memStore(JSON.stringify({ sortBy: 'priority' }))).sortDir, 'asc');
  assert.equal(loadBacklogFilters(memStore(JSON.stringify({ sortBy: 'updated' }))).sortDir, 'desc');
});

test('nextSort: the same column flips, a new column starts at its default direction', () => {
  assert.deepEqual(nextSort({ sortBy: 'updated', sortDir: 'desc' }, 'updated'), { sortBy: 'updated', sortDir: 'asc' });
  assert.deepEqual(nextSort({ sortBy: 'updated', sortDir: 'desc' }, 'priority'), { sortBy: 'priority', sortDir: 'asc' });
  assert.deepEqual(nextSort({ sortBy: 'priority', sortDir: 'asc' }, 'key'), { sortBy: 'key', sortDir: 'asc' });
  assert.deepEqual(nextSort({ sortBy: 'key', sortDir: 'asc' }, 'updated'), { sortBy: 'updated', sortDir: 'desc' });
});

const row = (key: string, priority: number | null, updatedAt?: string) => ({ key, priority, updatedAt });
const keys = (rows: { key: string }[]) => rows.map((r) => r.key);

test('sortTickets: ticket numbers sort naturally, not as text', () => {
  const rows = [row('DCP-100', 1), row('DCP-9', 1), row('DCP-15976', 1), row('ABC-2', 1)];
  assert.deepEqual(keys(sortTickets(rows, 'key', 'asc')), ['ABC-2', 'DCP-9', 'DCP-100', 'DCP-15976']);
  assert.deepEqual(keys(sortTickets(rows, 'key', 'desc')), ['DCP-15976', 'DCP-100', 'DCP-9', 'ABC-2']);
});

test('sortTickets: priority 1 is first ascending, and no priority is last either way', () => {
  const rows = [row('A-1', 3), row('A-2', null), row('A-3', 1), row('A-4', 2)];
  assert.deepEqual(keys(sortTickets(rows, 'priority', 'asc')), ['A-3', 'A-4', 'A-1', 'A-2']);
  assert.deepEqual(keys(sortTickets(rows, 'priority', 'desc')), ['A-1', 'A-4', 'A-3', 'A-2']);
});

test('sortTickets: dates compare as times across zones; missing or bad dates go last', () => {
  const rows = [
    row('A-1', 1, '2026-11-09T16:12:24.533-0500'), // 21:12Z
    row('A-2', 1, '2026-11-09T21:30:00Z'),
    row('A-3', 1),
    row('A-4', 1, 'not a date'),
    row('A-5', 1, '2026-11-01T00:00:00Z'),
  ];
  assert.deepEqual(keys(sortTickets(rows, 'updated', 'desc')), ['A-2', 'A-1', 'A-5', 'A-3', 'A-4']);
  assert.deepEqual(keys(sortTickets(rows, 'updated', 'asc')), ['A-5', 'A-1', 'A-2', 'A-3', 'A-4']);
});

test('sortTickets: ties keep the tracker order, and the input is not changed', () => {
  const rows = [row('B-2', 2), row('B-1', 2), row('B-3', 1)];
  assert.deepEqual(keys(sortTickets(rows, 'priority', 'asc')), ['B-3', 'B-2', 'B-1']);
  assert.deepEqual(keys(rows), ['B-2', 'B-1', 'B-3']);
});
