import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewHeading, runPillLabel, runResultLabel } from './review-view';

const target = (url: string, number: number) => ({ url, number, headBranch: 'feat', baseBranch: 'main', fetchRef: 'refs/x' });
const run = (over: Record<string, unknown> = {}) => ({ state: 'running', deliveryOutcome: null, team: { reviewTarget: null }, ...over }) as Parameters<typeof runPillLabel>[0];

test('reviewHeading: a GitHub pull request', () => {
  const url = 'https://github.com/acme/web/pull/42';
  assert.deepEqual(reviewHeading(run({ team: { reviewTarget: target(url, 42) } })), { text: 'Review of PR #42', url });
});

test('reviewHeading: a GitLab merge request', () => {
  const url = 'https://gitlab.example.com/grp/sub/api/-/merge_requests/7';
  assert.deepEqual(reviewHeading(run({ team: { reviewTarget: target(url, 7) } })), { text: 'Review of MR !7', url });
});

test('reviewHeading: an ordinary run has none', () => {
  assert.equal(reviewHeading(run()), null);
  assert.equal(reviewHeading(run({ team: {} })), null);
});

test('runPillLabel: reviewed, split and running runs', () => {
  assert.equal(runPillLabel(run({ state: 'succeeded', deliveryOutcome: 'reviewed' })), 'Reviewed');
  assert.equal(runPillLabel(run({ state: 'succeeded', deliveryOutcome: 'split' })), 'Split into smaller tasks');
  assert.equal(runPillLabel(run({ state: 'running' })), 'Working');
});

const result = (deliveryOutcome: string | null, changeRequestState: string | null = null) =>
  runResultLabel({ deliveryOutcome, changeRequestState } as Parameters<typeof runResultLabel>[0]);

test('runResultLabel: a run left for someone to merge follows its pull request', () => {
  assert.equal(result('awaiting_external_merge', 'merged'), 'Merged');
  assert.equal(result('awaiting_external_merge', 'closed'), 'Closed without merging');
  assert.equal(result('awaiting_external_merge', 'ready'), 'Ready for someone to merge');
  assert.equal(result('awaiting_external_merge', 'open'), 'Ready for someone to merge');
  assert.equal(result('awaiting_external_merge', null), 'Ready for someone to merge');
});

test('runResultLabel: other outcomes are unchanged', () => {
  assert.equal(result('merged', 'merged'), 'Merged');
  assert.equal(result('split'), 'Split into smaller tasks');
  assert.equal(result('no_repo'), 'No repository');
  assert.equal(result(null), '—');
});
