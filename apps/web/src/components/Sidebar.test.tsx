import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINKS } from './Sidebar';
import { PAGE } from '../words';

test('every primary nav link has a short label for the phone tab bar', () => {
  for (const l of LINKS) {
    assert.ok(l.short && l.short.trim(), `${l.to} needs a short label`);
    assert.ok(l.short.length <= 10, `${l.to}: "${l.short}" is too long for a tab`);
  }
});

test('the /runs link is called Activity, not History', () => {
  const runs = LINKS.find((l) => l.to === '/runs');
  assert.ok(runs, 'there is a /runs link');
  assert.equal(runs.label, PAGE.activity);
  assert.equal(runs.label, 'Activity');
  assert.equal(runs.short, 'Activity');
  assert.doesNotMatch(`${runs.label} ${runs.short}`, /History/);
});
