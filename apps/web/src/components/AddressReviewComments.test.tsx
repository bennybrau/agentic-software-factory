import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReviewThread } from '@asf/shared';
import type { ReviewThreadsWire } from '../api';
import { AddressReviewCommentsView } from './AddressReviewComments';

const noop = () => {};
const thread = (id: string, over: Partial<ReviewThread> = {}): ReviewThread => ({
  id, resolved: false, path: 'src/a.ts', line: 4, author: 'alice', authorIsTokenAccount: false, own: false,
  body: `Fix ${id}`, createdAt: '2026-01-01T00:00:00Z', replies: [], ...over,
});
const view = (res: ReviewThreadsWire | 'error' | null, over: { open?: boolean; unticked?: Set<string>; err?: string | null } = {}) =>
  renderToStaticMarkup(<AddressReviewCommentsView res={res} open={over.open ?? false} unticked={over.unticked ?? new Set()} expanded={new Set()}
    note="" busy={false} err={over.err ?? null} onOpen={noop} onCancel={noop} onTick={noop} onMore={noop} onNote={noop} onConfirm={noop} />);

test('not eligible: the button is disabled and the reason shows', () => {
  const html = view({ eligible: false, reason: 'the pull request is already merged', url: 'u', threads: [] });
  assert.match(html, /<button class="btn" disabled="">Address review comments \(0\)<\/button>/);
  assert.match(html, /The pull request is already merged/);
});

test('eligible: the count is in the label and the button is enabled', () => {
  const html = view({ eligible: true, reason: null, url: 'u', threads: [thread('a'), thread('b')] });
  assert.match(html, /<button class="btn">Address review comments \(2\)<\/button>/);
  assert.doesNotMatch(html, /type="checkbox"/, 'the panel is closed until clicked');
});

test('open: a row per thread, ticked by default, with author, path:line and a clipped body', () => {
  const long = 'l1\nl2\nl3\nl4 hidden';
  const html = view({ eligible: true, reason: null, url: 'u', threads: [thread('a', { body: long }), thread('b', { path: null, line: null, author: 'bob' })] }, { open: true });
  assert.equal(html.match(/type="checkbox" checked=""/g)?.length, 2);
  assert.match(html, /<b>alice<\/b><code class="muted">src\/a\.ts:4<\/code>/);
  assert.match(html, /<b>bob<\/b><\/label>/);
  assert.doesNotMatch(html, /l4 hidden/);
  assert.equal(html.match(/Show more/g)?.length, 1);
  assert.match(html, /<button class="btn">Confirm<\/button>/);
});

test('nothing ticked disables Confirm; a refusal shows inline', () => {
  const html = view({ eligible: true, reason: null, url: 'u', threads: [thread('a')] }, { open: true, unticked: new Set(['a']), err: 'changes cannot be requested on this run right now' });
  assert.match(html, /<button class="btn" disabled="">Confirm<\/button>/);
  assert.match(html, /color:var\(--bad\)[^>]*>changes cannot be requested on this run right now/);
});
