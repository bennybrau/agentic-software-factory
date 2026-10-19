import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TicketScope } from '@asf/shared';
import { BACKLOG_FILTERS_KEY, loadBacklogFilters, NO_FILTERS, restoreScope, saveBacklogFilters, type FilterStore } from './backlog-filters';

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
  const f = { team: 'Payments', scope: 'b1', sprint: '42', status: ['To Do', 'In Review'], bucket: 'inflight', showDone: true };
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
  assert.deepEqual(f, { team: 'Payments', scope: 'b2', sprint: '', status: ['Done'], bucket: '', showDone: false });
});

test('malformed fields are dropped one by one', () => {
  const f = loadBacklogFilters(memStore(JSON.stringify({ team: 7, scope: 'b1', status: ['ok', 3, null], bucket: 'done', showDone: 'yes' })));
  assert.deepEqual(f, { team: '', scope: 'b1', sprint: '', status: ['ok'], bucket: '', showDone: false });
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
