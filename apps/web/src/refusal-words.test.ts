import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TodayWire, WorkQueueEntry } from '@asf/shared';
import { QUEUE_POLL_MS, budgetReachedText, queuePollInterval, refusalFor, wherePill } from './refusal-words';

const entry = (over: Partial<WorkQueueEntry>): WorkQueueEntry => ({
  id: 'q1', ticketId: 't1', ticketProvider: 'jira', ticketKey: 'PROJ-1', repoId: null, teamName: null, maxCostUsd: null,
  mode: 'parallel', position: 1, batchId: 'b1', state: 'failed', runId: null, reason: 'No repository.', addedBy: null,
  addedAt: '2026-11-14T00:00:00Z', dispatchedAt: null, dependsOn: [], refusedAt: '2026-11-14T00:01:00Z', reasonCode: 'repo_missing', ...over,
});

test('the budget line appears once spend reaches the budget, and above it', () => {
  assert.equal(budgetReachedText(50, 50),
    "This month's runs have cost $50.00, which has reached the monthly budget of $50. Raise the budget in Settings, or wait for next month.");
  assert.match(budgetReachedText(61.234, 50)!, /cost \$61\.23, which has reached the monthly budget of \$50\./);
});

test('no budget line with no budget, or below it', () => {
  assert.equal(budgetReachedText(100, 0), null);
  assert.equal(budgetReachedText(100, -1), null);
  assert.equal(budgetReachedText(100, undefined), null);
  assert.equal(budgetReachedText(49.99, 50), null);
});

test('refusalFor keeps the newest refusal per ticket', () => {
  const list = [entry({ id: 'new' }), entry({ id: 'old' }), entry({ id: 'other', ticketId: 't2' })];
  assert.equal(refusalFor(list, 't1')!.id, 'new');
  assert.equal(refusalFor(list, 't2')!.id, 'other');
});

test('an unqualified entry matches a qualified row id, and the other way round', () => {
  assert.equal(refusalFor([entry({ ticketId: 'PROJ-12' })], 'jira:PROJ-12')!.id, 'q1');
  assert.equal(refusalFor([entry({ ticketId: 'jira:PROJ-12' })], 'PROJ-12')!.id, 'q1');
});

test('a qualified row id doesn’t match another provider’s entry with the same native id', () => {
  assert.equal(refusalFor([entry({ ticketId: 'PROJ-12', ticketProvider: 'linear' })], 'jira:PROJ-12'), undefined);
});

test('different ids never match', () => {
  assert.equal(refusalFor([entry({ ticketId: 'PROJ-12' })], 'PROJ-13'), undefined);
  assert.equal(refusalFor([entry({ ticketId: 'PROJ-12' })], 'jira:PROJ-1'), undefined);
});

test('an ad-hoc id matches exactly', () => {
  const list = [entry({ ticketId: 'adhoc:abc', ticketProvider: 'adhoc' })];
  assert.equal(refusalFor(list, 'adhoc:abc')!.id, 'q1');
  assert.equal(refusalFor(list, 'adhoc:abd'), undefined);
});

test('the queue is polled only while something is queued', () => {
  const today = (queued: WorkQueueEntry[]) => ({ waitingOnYou: [], running: [], queued, refused: [], doneToday: [], comingUp: [] }) as TodayWire;
  assert.equal(queuePollInterval(undefined), false);
  assert.equal(queuePollInterval(today([])), false);
  assert.equal(queuePollInterval(today([entry({ state: 'queued' })])), QUEUE_POLL_MS);
});

test('the pill says where it is, or that it couldn’t start and why', () => {
  assert.deepEqual(wherePill('backlog'), { label: 'Not started' });
  assert.deepEqual(wherePill('backlog', entry({})), { label: 'Couldn’t start', note: 'No repository.' });
  assert.deepEqual(wherePill('inflight', entry({ reason: null })), { label: 'Couldn’t start' });
});
