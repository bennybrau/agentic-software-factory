import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopyLinkButtonView, copyLink, runPageUrl } from './CopyLinkButton';

test('runPageUrl builds the run page address', () => {
  assert.equal(runPageUrl('https://h.example', 'run_abc'), 'https://h.example/run/run_abc');
});

function fakeScheduler() {
  const calls: { fn: () => void; ms: number }[] = [];
  return { calls, schedule: (fn: () => void, ms: number) => { calls.push({ fn, ms }); return calls.length; } };
}

test('a successful copy writes the exact URL, shows Copied, then goes back after 1500 ms', async () => {
  const written: string[] = [];
  const labels: string[] = [];
  const { calls, schedule } = fakeScheduler();
  await copyLink(async (t) => { written.push(t); }, 'https://h.example/run/run_abc', (l) => labels.push(l), schedule);
  assert.deepEqual(written, ['https://h.example/run/run_abc']);
  assert.deepEqual(labels, ['Copied']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ms, 1500);
  calls[0]!.fn();
  assert.deepEqual(labels, ['Copied', 'Copy link']);
});

test("a rejected or missing writeText shows Couldn't copy, then goes back", async () => {
  for (const writeText of [async () => { throw new Error('denied'); }, undefined]) {
    const labels: string[] = [];
    const { calls, schedule } = fakeScheduler();
    await copyLink(writeText, 'https://h.example/run/x', (l) => labels.push(l), schedule);
    assert.deepEqual(labels, ["Couldn't copy"]);
    assert.equal(calls[0]!.ms, 1500);
    calls[0]!.fn();
    assert.deepEqual(labels, ["Couldn't copy", 'Copy link']);
  }
});

test('the view renders its label in a plain button', () => {
  const idle = renderToStaticMarkup(<CopyLinkButtonView label="Copy link" />);
  assert.match(idle, /<button type="button" class="btn ghost sm copy-link" aria-live="polite">Copy link<\/button>/);
  assert.match(renderToStaticMarkup(<CopyLinkButtonView label="Copied" />), />Copied</);
});
