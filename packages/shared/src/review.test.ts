import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewComments } from './review.js';

test('every separator style anchors a comment', () => {
  const r = reviewComments([
    'REQUEST_CHANGES',
    '- `src/a.ts:1` — em dash',
    '- `src/b.ts:2` – en dash',
    '* `src/c.ts:3` - hyphen',
    '- `src/d.ts:4`: colon',
  ].join('\n'));
  assert.deepEqual(r.anchored, [
    { path: 'src/a.ts', line: 1, body: 'em dash' },
    { path: 'src/b.ts', line: 2, body: 'en dash' },
    { path: 'src/c.ts', line: 3, body: 'hyphen' },
    { path: 'src/d.ts', line: 4, body: 'colon' },
  ]);
  assert.equal(r.summary, 'REQUEST_CHANGES');
});

test('paths with colons and dashes anchor at the last line number', () => {
  const r = reviewComments('- `apps/my-app/c:d/x-y.ts:42` — off by one');
  assert.deepEqual(r.anchored, [{ path: 'apps/my-app/c:d/x-y.ts', line: 42, body: 'off by one' }]);
});

test('a line that is not a number goes to the summary', () => {
  const r = reviewComments('- `src/a.ts:abc` — not a line\n- `src/a.ts` — no line\n- `src/a.ts:0` — zero');
  assert.deepEqual(r.anchored, []);
  assert.equal(r.summary, '- `src/a.ts:abc` — not a line\n- `src/a.ts` — no line\n- `src/a.ts:0` — zero');
});

test('indented continuation lines join the previous comment', () => {
  const r = reviewComments('APPROVE\n- `src/a.ts:5` — first\n  second\n    third\nAfterword');
  assert.deepEqual(r.anchored, [{ path: 'src/a.ts', line: 5, body: 'first\nsecond\nthird' }]);
  assert.equal(r.summary, 'APPROVE\nAfterword');
});

test('empty input gives nothing', () => {
  assert.deepEqual(reviewComments(''), { summary: '', anchored: [] });
  assert.deepEqual(reviewComments(null as unknown as string), { summary: '', anchored: [] });
});

test('prose only is all summary', () => {
  const r = reviewComments('\nAPPROVE\n\nLooks right; tests cover it.\n  - an indented aside\n');
  assert.deepEqual(r.anchored, []);
  assert.equal(r.summary, 'APPROVE\n\nLooks right; tests cover it.\n  - an indented aside');
});
