import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewThread } from '@asf/shared';
import { addressPayload, buttonState, clip, where } from './address-review';

const thread = (id: string, over: Partial<ReviewThread> = {}): ReviewThread => ({
  id, resolved: false, path: 'src/a.ts', line: 4, author: 'alice', authorIsTokenAccount: false, own: false,
  body: `Fix ${id}`, createdAt: '2026-01-01T00:00:00Z', replies: [], ...over,
});

test('loading is disabled with no reason; a fetch error says so', () => {
  assert.deepEqual(buttonState(null), { label: 'Address review comments', disabled: true, reason: null });
  assert.deepEqual(buttonState('error'), { label: 'Address review comments', disabled: true, reason: "Couldn't read review threads" });
});

test('eligible: the count is in the label and the button is enabled', () => {
  const s = buttonState({ eligible: true, reason: null, url: 'u', threads: [thread('a'), thread('b')] });
  assert.deepEqual(s, { label: 'Address review comments (2)', disabled: false, reason: null });
});

test('not eligible: disabled with the API reason, first letter capitalised', () => {
  const s = buttonState({ eligible: false, reason: 'no open review threads to address', url: 'u', threads: [] });
  assert.deepEqual(s, { label: 'Address review comments (0)', disabled: true, reason: 'No open review threads to address' });
});

test('unticking one sends only the rest, in order; a blank note is left out', () => {
  const threads = [thread('a'), thread('b'), thread('c')];
  assert.deepEqual(addressPayload(threads, new Set(['b']), '   '), { threadIds: ['a', 'c'] });
  assert.deepEqual(addressPayload(threads, new Set(), ''), { threadIds: ['a', 'b', 'c'] });
});

test('the note is passed through, trimmed', () => {
  assert.deepEqual(addressPayload([thread('a')], new Set(), '  keep the API as is \n'), { threadIds: ['a'], note: 'keep the API as is' });
});

test('clip keeps the first lines and says whether it cut', () => {
  assert.deepEqual(clip('one\ntwo\nthree'), { text: 'one\ntwo\nthree', clipped: false });
  assert.deepEqual(clip('one\ntwo\nthree\nfour'), { text: 'one\ntwo\nthree', clipped: true });
  assert.deepEqual(clip('one\ntwo', 1), { text: 'one', clipped: true });
  assert.deepEqual(clip('one\n\n'), { text: 'one', clipped: false });
});

test('where: path:line, path, or nothing', () => {
  assert.equal(where({ path: 'a.ts', line: 3 }), 'a.ts:3');
  assert.equal(where({ path: 'a.ts', line: null }), 'a.ts');
  assert.equal(where({ path: null, line: null }), '');
});
