import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimPageSubject, getPageSubject, pageTitle, subscribePageSubject } from './page-title';

test('pageTitle puts the ticket key before the app title', () => {
  assert.equal(pageTitle('App', 'PROJ-123'), 'PROJ-123 · App');
  assert.equal(pageTitle('App', null), 'App');
  assert.equal(pageTitle('App', ''), 'App');
  assert.equal(pageTitle('App', '  '), 'App');
  assert.equal(pageTitle('App'), 'App');
});

test('another page (no claim) shows just the app title', () => {
  assert.equal(pageTitle('App', getPageSubject()), 'App');
});

test('a run page names its ticket and tells subscribers; leaving brings back the app title', () => {
  let calls = 0;
  const off = subscribePageSubject(() => { calls++; });
  const release = claimPageSubject('PROJ-123');
  assert.equal(pageTitle('App', getPageSubject()), 'PROJ-123 · App');
  assert.equal(calls, 1);
  release();
  assert.equal(pageTitle('App', getPageSubject()), 'App');
  assert.equal(calls, 2);
  off();
});

test('a stale release from run A after run B claimed leaves B', () => {
  const releaseA = claimPageSubject('A');
  const releaseB = claimPageSubject('B');
  releaseA();
  assert.equal(pageTitle('App', getPageSubject()), 'B · App');
  releaseB();
  assert.equal(pageTitle('App', getPageSubject()), 'App');
});
