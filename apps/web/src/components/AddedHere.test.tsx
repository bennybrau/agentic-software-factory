import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AdhocTask, WorkQueueEntry } from '@asf/shared';
import { AddedHere } from './AddedHere';

const task = (over: Partial<AdhocTask>): AdhocTask => ({
  id: 'adhoc:a1', key: 'ADHOC-A1', title: 'Fix the login page', body: '', createdBy: null, attachments: [], createdAt: '2026-11-14T00:00:00Z', ...over,
});
const entry = (over: Partial<WorkQueueEntry>): WorkQueueEntry => ({
  id: 'q1', ticketId: 'adhoc:a1', ticketProvider: 'adhoc', ticketKey: 'ADHOC-A1', repoId: null, teamName: null, maxCostUsd: null,
  mode: 'parallel', position: 1, batchId: 'b1', state: 'failed', runId: null, reason: 'No repository.', addedBy: null,
  addedAt: '2026-11-14T00:00:00Z', dispatchedAt: null, dependsOn: [], refusedAt: '2026-11-14T00:01:00Z', reasonCode: 'repo_missing', ...over,
});

const render = (tasks: AdhocTask[], refused: WorkQueueEntry[]) => renderToStaticMarkup(
  <AddedHere tasks={tasks} repos={[]} refused={refused} blocked={false} onStart={() => {}} onRemove={() => {}} />,
);

test('a refused task shows Couldn’t start and its reason', () => {
  const html = render([task({})], [entry({})]);
  assert.match(html, /Fix the login page/);
  assert.match(html, /Couldn’t start/);
  assert.match(html, /No repository\./);
});

test('a task that wasn’t refused shows no pill', () => {
  const html = render([task({})], [entry({ ticketId: 'adhoc:a2' })]);
  assert.match(html, /Fix the login page/);
  assert.doesNotMatch(html, /Couldn’t start|class="pill"/);
});

test('nothing added renders nothing', () => {
  assert.equal(render([], []), '');
});
