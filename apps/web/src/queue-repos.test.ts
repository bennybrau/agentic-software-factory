import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseForAll, chooseRepo, initialChoices, needsRepoConfirm, queueItems, stillNeedRepo } from './queue-repos';

const tickets = [
  { id: 'p-1', key: 'P-1', title: 'Header overlaps in shared-ui' },
  { id: 'p-2', key: 'P-2', title: 'Totals are off' },
];
const previews = [
  { ticketId: 'p-1', repoId: 'acme/platform/web/shared-ui', reason: 'The ticket title mentions shared-ui.', mentionedRepoIds: ['acme/platform/web/shared-ui'] },
  { ticketId: 'p-2', repoId: null, reason: 'Choose which repository P-2 should change (…).', mentionedRepoIds: [] },
];

test('the panel shows only when there is more than one repository', () => {
  assert.equal(needsRepoConfirm(0), false);
  assert.equal(needsRepoConfirm(1), false);
  assert.equal(needsRepoConfirm(5), true);
});

test('suggestions are preselected; a ticket ASF can\'t place stays blank and holds Start', () => {
  const c = initialChoices(tickets, previews);
  assert.deepEqual(c.map((x) => x.repoId), ['acme/platform/web/shared-ui', '']);
  assert.deepEqual(stillNeedRepo(c).map((x) => x.ticketKey), ['P-2']);
  const done = chooseRepo(c, 'p-2', 'acme/platform/api/billing');
  assert.deepEqual(stillNeedRepo(done), []);
  assert.equal(done[0].repoId, 'acme/platform/web/shared-ui', 'other rows untouched');
});

test('a ticket with no preview (couldn\'t be read) also waits for a choice', () => {
  const c = initialChoices(tickets, [previews[0]]);
  assert.equal(c[1].repoId, '');
});

test('one repository for all overrides every row', () => {
  const c = chooseForAll(initialChoices(tickets, previews), 'acme/platform/api/billing');
  assert.deepEqual(c.map((x) => x.repoId), ['acme/platform/api/billing', 'acme/platform/api/billing']);
});

test('queue items carry each chosen repository', () => {
  const c = chooseRepo(initialChoices(tickets, previews), 'p-2', 'acme/platform/api/billing');
  assert.deepEqual(queueItems(c), [
    { ticketId: 'p-1', ticketKey: 'P-1', ticketProvider: '', repoId: 'acme/platform/web/shared-ui' },
    { ticketId: 'p-2', ticketKey: 'P-2', ticketProvider: '', repoId: 'acme/platform/api/billing' },
  ]);
});

test('a preview and a ticket match by native id, bare or qualified (the browser does not know the default connection)', () => {
  const previews = [{ ticketId: 'p-1', repoId: 'gitlab:acme/web', reason: 'Named.', mentionedRepoIds: [] }];
  const qualified = [{ id: 'jira:p-1', key: 'P-1', title: 'T' }];
  assert.equal(initialChoices(qualified, previews)[0].repoId, 'gitlab:acme/web');
  const bare = initialChoices([{ id: 'p-1', key: 'P-1', title: 'T' }], [{ ...previews[0], ticketId: 'jira:p-1' }]);
  assert.equal(bare[0].repoId, 'gitlab:acme/web');
  assert.equal(chooseRepo(initialChoices(qualified, []), 'p-1', 'gitlab:acme/api')[0].repoId, 'gitlab:acme/api');
});
