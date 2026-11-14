import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopyLinkButtonView, copyLink, runPageUrl, type CopyState } from './CopyLinkButton';

test('runPageUrl builds the run page address', () => {
  assert.equal(runPageUrl('https://h.example', 'run_abc'), 'https://h.example/run/run_abc');
});

function fakeScheduler() {
  const calls: { fn: () => void; ms: number }[] = [];
  return { calls, schedule: (fn: () => void, ms: number) => { calls.push({ fn, ms }); return calls.length; } };
}
function fakeEvent() {
  const e = { stopped: 0, stopPropagation() { e.stopped++; } };
  return e;
}

test('a successful copy stops the row click, writes the exact URL, shows copied, then goes back after 1500 ms', async () => {
  const written: string[] = [];
  const states: CopyState[] = [];
  const e = fakeEvent();
  const { calls, schedule } = fakeScheduler();
  await copyLink(e, async (t) => { written.push(t); }, 'https://h.example/run/run_abc', (s) => states.push(s), schedule);
  assert.equal(e.stopped, 1);
  assert.deepEqual(written, ['https://h.example/run/run_abc']);
  assert.deepEqual(states, ['copied']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ms, 1500);
  calls[0]!.fn();
  assert.deepEqual(states, ['copied', 'idle']);
});

test('a rejected or missing writeText shows failed, still stops the row click, then goes back', async () => {
  for (const writeText of [async () => { throw new Error('denied'); }, undefined]) {
    const states: CopyState[] = [];
    const e = fakeEvent();
    const { calls, schedule } = fakeScheduler();
    await copyLink(e, writeText, 'https://h.example/run/x', (s) => states.push(s), schedule);
    assert.equal(e.stopped, 1);
    assert.deepEqual(states, ['failed']);
    assert.equal(calls[0]!.ms, 1500);
    calls[0]!.fn();
    assert.deepEqual(states, ['failed', 'idle']);
  }
});

test('the view is an icon-only button with an accessible label and tooltip per state', () => {
  const idle = renderToStaticMarkup(<CopyLinkButtonView state="idle" />);
  assert.match(idle, /^<button type="button" class="icon-btn copy-link idle"/);
  assert.match(idle, /aria-label="Copy link to this run" title="Copy link to this run"/);
  assert.match(idle, /<span class="material-symbols-outlined" aria-hidden="true">link<\/span>/);
  assert.doesNotMatch(idle, />Copy link</, 'no visible text label');

  const copied = renderToStaticMarkup(<CopyLinkButtonView state="copied" />);
  assert.match(copied, /aria-hidden="true">check</);
  assert.match(copied, /aria-live="polite">Link copied</);

  const failed = renderToStaticMarkup(<CopyLinkButtonView state="failed" />);
  assert.match(failed, /aria-hidden="true">link_off</);
  assert.match(failed, /aria-label="Couldn&#x27;t copy the link"/);
});
