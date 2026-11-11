import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASF_COMMENT_MARKER, isFactoryComment, markFactoryComment, parseReviewRequest } from './index.js';

test('parseReviewRequest: a GitHub pull request', () => {
  assert.deepEqual(parseReviewRequest('Please review https://github.com/acme/web/pull/42.'),
    { url: 'https://github.com/acme/web/pull/42', repoPath: 'acme/web', number: 42 });
});

test('parseReviewRequest: a GitLab merge request in a subgroup, any case, trailing path', () => {
  assert.deepEqual(parseReviewRequest('REVIEW this: https://gitlab.example.com/grp/sub/api/-/merge_requests/7/diffs'),
    { url: 'https://gitlab.example.com/grp/sub/api/-/merge_requests/7', repoPath: 'grp/sub/api', number: 7 });
});

test('parseReviewRequest: needs the word review', () => {
  assert.equal(parseReviewRequest('look at https://github.com/acme/web/pull/42'), null);
});

test('parseReviewRequest: needs a PR/MR URL', () => {
  assert.equal(parseReviewRequest('review the login page'), null);
  assert.equal(parseReviewRequest('review https://github.com/acme/web/issues/42'), null);
  assert.equal(parseReviewRequest('review https://github.com/acme/web/pull/abc'), null);
});

test('isFactoryComment: the marker anywhere, or the reviewer summary header', () => {
  assert.equal(isFactoryComment(`Fixed in abc123.\n\n${ASF_COMMENT_MARKER}`), true);
  assert.equal(isFactoryComment('**ASF review (run run_1)**\n\nLooks fine.'), true);
  assert.equal(isFactoryComment('Please rename this.'), false);
  assert.equal(isFactoryComment('quoting **ASF review (run run_1)** mid-text'), false);
});

test('markFactoryComment appends the marker once', () => {
  const once = markFactoryComment('Done.');
  assert.equal(once, `Done.\n\n${ASF_COMMENT_MARKER}`);
  assert.equal(markFactoryComment(once), once);
  assert.equal(isFactoryComment(once), true);
});
