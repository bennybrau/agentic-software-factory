import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopyRunLinkView, copyRunLink, runUrl } from './CopyRunLink';

test('runUrl builds the full run page address', () => {
  assert.equal(runUrl('https://h', 'run_1'), 'https://h/run/run_1');
});

test('copying stops the row click, writes the full URL, and resets the label after 1500 ms', async () => {
  let stopped = false;
  const written: string[] = [];
  const copied: boolean[] = [];
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  await copyRunLink({ stopPropagation: () => { stopped = true; } }, {
    url: runUrl('https://h', 'run_1'),
    writeText: async (t) => { written.push(t); },
    setCopied: (v) => copied.push(v),
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
  });
  assert.equal(stopped, true);
  assert.deepEqual(written, ['https://h/run/run_1']);
  assert.deepEqual(copied, [true]);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]!.ms, 1500);
  scheduled[0]!.fn();
  assert.deepEqual(copied, [true, false]);
});

test('a refused or missing clipboard shows nothing and does not throw', async () => {
  const copied: boolean[] = [];
  const base = { url: 'https://h/run/run_1', setCopied: (v: boolean) => copied.push(v), schedule: () => undefined };
  let stopped = 0;
  const e = { stopPropagation: () => { stopped++; } };
  await copyRunLink(e, { ...base, writeText: async () => { throw new Error('denied'); } });
  await copyRunLink(e, { ...base, writeText: undefined });
  assert.equal(stopped, 2);
  assert.deepEqual(copied, []);
});

test('the view is a plain button labelled "Copy link" or "Copied"', () => {
  const idle = renderToStaticMarkup(<CopyRunLinkView copied={false} />);
  assert.match(idle, /type="button"/);
  assert.match(idle, />Copy link</);
  assert.match(idle, /aria-label="Copy link to this run"/);
  assert.match(renderToStaticMarkup(<CopyRunLinkView copied={true} />), />Copied</);
});
