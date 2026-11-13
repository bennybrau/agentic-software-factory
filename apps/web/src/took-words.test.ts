import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tookIsLive, tookText } from './took-words';

const now = Date.parse('2026-11-13T12:00:00Z');
const at = (msBeforeNow: number) => new Date(now - msBeforeNow).toISOString();
const START = '2026-11-13T10:00:00Z';
const after = (ms: number) => new Date(Date.parse(START) + ms).toISOString();
const done = (ms: number) => ({ state: 'succeeded' as const, startedAt: START, finishedAt: after(ms), lastEventAt: after(ms) });

test('a finished run reads as seconds, minutes, or hours and minutes', () => {
  assert.equal(tookText(done(42_000), now), '42 s');
  assert.equal(tookText(done(13 * 60_000 + 59_000), now), '13 min', 'minutes round down');
  assert.equal(tookText(done(65 * 60_000), now), '1 h 5 min');
  assert.equal(tookText(done(2 * 3_600_000), now), '2 h', 'no "0 min"');
  assert.equal(tookText(done(-5_000), now), '0 s', 'a clock skew never goes negative');
});

test('a run still going counts "so far", including one waiting at a gate', () => {
  assert.equal(tookText({ state: 'running', startedAt: at(4 * 60_000 + 10_000), finishedAt: null, lastEventAt: at(1_000) }, now), '4 min so far');
  assert.equal(tookText({ state: 'awaiting_checkpoint', startedAt: at(90 * 60_000), finishedAt: null, lastEventAt: at(80 * 60_000) }, now), '1 h 30 min so far');
});

test('never started, stale, and terminal-without-a-finish-time', () => {
  assert.equal(tookText({ state: 'queued', startedAt: null, finishedAt: null, lastEventAt: null }, now), '—');
  assert.equal(tookText({ state: 'running', startedAt: 'not a date', finishedAt: null, lastEventAt: null }, now), '—');
  assert.equal(tookText({ state: 'stale', startedAt: START, finishedAt: null, lastEventAt: after(7 * 60_000) }, now), '7 min', 'to the last event, no "so far"');
  assert.equal(tookText({ state: 'stale', startedAt: START, finishedAt: null, lastEventAt: null }, now), '—');
  assert.equal(tookText({ state: 'failed', startedAt: START, finishedAt: null, lastEventAt: after(60_000) }, now), '—');
});

test('tookIsLive drives the "so far" tick: only unstarted/stale/terminal runs stop counting', () => {
  assert.equal(tookIsLive({ state: 'running', startedAt: START }), true);
  assert.equal(tookIsLive({ state: 'awaiting_checkpoint', startedAt: START }), true);
  assert.equal(tookIsLive({ state: 'queued', startedAt: null }), false, 'never started');
  assert.equal(tookIsLive({ state: 'stale', startedAt: START }), false);
  assert.equal(tookIsLive({ state: 'succeeded', startedAt: START }), false, 'terminal');
});
