import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDurationText } from './duration-words';

const start = '2026-11-13T10:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(start) + ms).toISOString();
const done = (ms: number, state = 'succeeded') => ({ state, startedAt: start, finishedAt: at(ms) });

test('a finished run says how long it took', () => {
  assert.equal(runDurationText(done(42_000), 0), 'Took 42 s');
  assert.equal(runDurationText(done(13 * 60_000 + 59_000), 0), 'Took 13 min', 'whole minutes, rounded down');
  assert.equal(runDurationText(done(65 * 60_000), 0), 'Took 1 h 5 min');
  assert.equal(runDurationText(done(120 * 60_000), 0), 'Took 2 h');
  assert.equal(runDurationText(done(5 * 60_000, 'halted'), 0), 'Took 5 min');
  assert.equal(runDurationText(done(-5_000, 'failed'), 0), 'Took 0 s', 'a negative gap counts as 0 s');
});

test('an unfinished run counts up to now', () => {
  const run = { state: 'running', startedAt: start, finishedAt: null };
  assert.equal(runDurationText(run, Date.parse(at(4 * 60_000 + 10_000))), 'Running for 4 min');
  assert.equal(runDurationText({ ...run, state: 'awaiting_checkpoint' }, Date.parse(at(30_000))), 'Running for 30 s');
});

test('no text for a run that never started, or a finished one without a finish time', () => {
  assert.equal(runDurationText({ state: 'queued', startedAt: null, finishedAt: null }, Date.now()), null);
  assert.equal(runDurationText({ state: 'cancelled', startedAt: start, finishedAt: null }, Date.now()), null);
});
