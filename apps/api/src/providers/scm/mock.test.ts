import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockScmProvider } from './mock.js';
import { ASF_COMMENT_MARKER, type Repo, type ReviewThread } from '@asf/shared';

const REPO: Repo = { id: '1', path: 'example/app', url: 'mock://repos/example/app', defaultBranch: 'main', cloneUrl: '/tmp/example-app.git' };

const THREAD: ReviewThread = {
  id: 't1', resolved: false, path: 'src/x.ts', line: 3, author: 'alice',
  authorIsTokenAccount: false, own: false, body: 'rename this', createdAt: '2026-09-14T10:00:00Z',
  replies: [],
};

test('listReviewComments returns nothing for a change request with no seeded threads', async () => {
  const p = new MockScmProvider('');
  assert.deepEqual(await p.listReviewComments(REPO, 5), []);
});

test('seedThreads makes listReviewComments return exactly those threads, per change request number', async () => {
  const p = new MockScmProvider('');
  p.seedThreads(5, [THREAD]);
  assert.deepEqual(await p.listReviewComments(REPO, 5), [THREAD]);
  assert.deepEqual(await p.listReviewComments(REPO, 6), []);
});

test('replyToThread records the reply with the marker, in order, visible via repliesFor', async () => {
  const p = new MockScmProvider('');
  await p.replyToThread(REPO, 5, 't1', 'Fixed in abc123.');
  await p.replyToThread(REPO, 5, 't1', 'Also handled the edge case.');
  assert.deepEqual(p.repliesFor(5), [
    { threadId: 't1', body: `Fixed in abc123.\n\n${ASF_COMMENT_MARKER}` },
    { threadId: 't1', body: `Also handled the edge case.\n\n${ASF_COMMENT_MARKER}` },
  ]);
  assert.deepEqual(p.repliesFor(6), []);
});
