import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishedTodayCount, finishedTodayText, msUntilLocalMidnight } from './finished-today';

// Local times, so the tests hold in any timezone.
const now = new Date(2026, 10, 14, 10, 0, 0);
const local = (d: number, h: number, m: number, s: number) => new Date(2026, 10, d, h, m, s).toISOString();

test('wording: nothing for 0, then "N finished today"', () => {
  assert.equal(finishedTodayText(0), null);
  assert.equal(finishedTodayText(1), '1 finished today');
  assert.equal(finishedTodayText(3), '3 finished today');
});

test('counts from local midnight: 00:00:00 today counts, 23:59:59 yesterday does not', () => {
  assert.equal(finishedTodayCount([{ state: 'succeeded', finishedAt: local(14, 0, 0, 0) }], now), 1);
  assert.equal(finishedTodayCount([{ state: 'succeeded', finishedAt: local(13, 23, 59, 59) }], now), 0);
});

test('every terminal state counts; unfinished runs and runs with no finish time do not', () => {
  const at = local(14, 9, 0, 0);
  assert.equal(finishedTodayCount([
    { state: 'succeeded', finishedAt: at },
    { state: 'failed', finishedAt: at },
    { state: 'cancelled', finishedAt: at },
    { state: 'halted', finishedAt: at },
    { state: 'running', finishedAt: at },
    { state: 'awaiting_checkpoint', finishedAt: null },
    { state: 'succeeded', finishedAt: null },
  ], now), 4);
});

test('msUntilLocalMidnight: 30 s before midnight, a full day at midnight', () => {
  assert.equal(msUntilLocalMidnight(new Date(2026, 10, 14, 23, 59, 30)), 30_000);
  const midnight = new Date(2026, 10, 14, 0, 0, 0);
  assert.equal(msUntilLocalMidnight(midnight), new Date(2026, 10, 15).getTime() - midnight.getTime());
});
