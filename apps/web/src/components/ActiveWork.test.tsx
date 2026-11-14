import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { WorkQueueEntry } from '@asf/shared';
import { CouldntStart } from './ActiveWork';

const entry = (over: Partial<WorkQueueEntry>): WorkQueueEntry => ({
  id: 'q1', ticketId: 't1', ticketProvider: 'jira', ticketKey: 'PROJ-1', repoId: null, teamName: null, maxCostUsd: null,
  mode: 'parallel', position: 1, batchId: 'b1', state: 'failed', runId: null, reason: 'No repository.', addedBy: null,
  addedAt: '2026-11-14T00:00:00Z', dispatchedAt: null, dependsOn: [], refusedAt: '2026-11-14T00:01:00Z', reasonCode: 'repo_missing', ...over,
});

const render = (refused: WorkQueueEntry[]) => renderToStaticMarkup(
  <MemoryRouter><CouldntStart refused={refused} onRetry={() => {}} onDismiss={() => {}} /></MemoryRouter>,
);

test('nothing refused renders nothing', () => {
  assert.equal(render([]), '');
});

test('a refused start shows its key, the reason and both actions, without a settings link', () => {
  const html = render([entry({})]);
  assert.match(html, /Couldn’t start/);
  assert.match(html, /PROJ-1/);
  assert.match(html, /No repository\./);
  assert.match(html, />Try again</);
  assert.match(html, />Dismiss</);
  assert.doesNotMatch(html, /\/settings#spending/);
});

test('an over-budget refusal links to the spending settings', () => {
  const html = render([entry({ reasonCode: 'over_budget', reason: 'This month’s runs have cost $50.00…' })]);
  assert.match(html, /href="\/settings#spending"/);
});
