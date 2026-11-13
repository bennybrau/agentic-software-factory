import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { OPERATOR_NAME_KEY, clearOperatorName, getOperatorName, nameInitial, onOperatorNameChange, operatorHeaders, setNameStore, setOperatorName, validateName } from './operator-name';
import { api } from './api';
import { fallbackMe, loadMe, subscribeMe } from './useMe';
import type { Identity } from './api';

function memoryStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
}

// A stand-in api: records the headers of every request and answers /api/me the way
// apps/api does in AUTH_MODE=none (the decoded X-Operator, else 'operator').
const sent: Headers[] = [];
globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
  const h = new Headers(init.headers);
  sent.push(h);
  const op = h.get('x-operator');
  const me: Identity = { user: op ? decodeURIComponent(op) : 'operator', verified: false, mode: 'none' };
  return new Response(JSON.stringify(me), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

beforeEach(() => { setNameStore(memoryStore()); sent.length = 0; });

test('validateName: 1 to 40 characters after trimming, else a reason', () => {
  assert.equal(validateName('jon'), null);
  assert.equal(validateName('  Zoë  '), null);
  assert.equal(validateName('x'.repeat(40)), null);
  assert.equal(validateName('ë'.repeat(40)), null, 'counted in characters');
  assert.match(validateName('x'.repeat(41))!, /40 characters/);
  assert.match(validateName('   ')!, /Enter a name/);
  assert.match(validateName('')!, /Enter a name/);
});

test('set keeps the trimmed name in storage; a refused name changes nothing; clear removes it', () => {
  const store = memoryStore();
  setNameStore(store);
  assert.equal(getOperatorName(), null);
  assert.equal(setOperatorName('  Zoë '), null);
  assert.equal(getOperatorName(), 'Zoë');
  assert.equal(store.m.get(OPERATOR_NAME_KEY), 'Zoë');
  assert.match(setOperatorName('   ')!, /Enter a name/);
  assert.equal(getOperatorName(), 'Zoë');
  clearOperatorName();
  assert.equal(getOperatorName(), null);
  assert.equal(store.m.has(OPERATOR_NAME_KEY), false);
});

test('a saved name is read back on load; an unusable one or broken storage gives no name', () => {
  setNameStore(memoryStore({ [OPERATOR_NAME_KEY]: 'jon' }));
  assert.equal(getOperatorName(), 'jon');
  setNameStore(memoryStore({ [OPERATOR_NAME_KEY]: 'x'.repeat(41) }));
  assert.equal(getOperatorName(), null);
  setNameStore({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } });
  assert.equal(getOperatorName(), null);
  assert.equal(setOperatorName('jon'), null, 'storage failing still sets it for this page');
  assert.equal(getOperatorName(), 'jon');
});

test('requests carry X-Operator, percent-encoded, only when a name is set', async () => {
  assert.deepEqual(operatorHeaders(), {});
  await api.health();
  assert.equal(sent[0].has('x-operator'), false);

  setOperatorName('Zoë');
  assert.deepEqual(operatorHeaders(), { 'X-Operator': 'Zo%C3%AB' });
  await api.health();
  await api.resolveGate('g_1', 'approve', 'Zoë');
  assert.equal(sent[1].get('x-operator'), 'Zo%C3%AB');
  assert.equal(sent[2].get('x-operator'), 'Zo%C3%AB');
  assert.equal(sent[2].get('content-type'), 'application/json', 'the request keeps its own headers');
});

test('by is the name, or "operator" when none is set', async () => {
  assert.equal(fallbackMe().user, 'operator');
  assert.equal((await loadMe()).user, 'operator');
  setOperatorName('jon');
  assert.equal(fallbackMe().user, 'jon');
  assert.equal((await loadMe()).user, 'jon');
  clearOperatorName();
});

test('useMe follows a change: the cached answer is dropped and /api/me asked again with the new name', async () => {
  await loadMe();
  const heard: string[] = [];
  const off = subscribeMe((m) => heard.push(m.user));
  let changes = 0;
  const offChange = onOperatorNameChange(() => { changes++; });

  setOperatorName('Zoë');
  setOperatorName('Zoë'); // the same name again is not a change
  const me = await loadMe();
  assert.equal(me.user, 'Zoë');
  assert.equal(changes, 1);
  assert.deepEqual(heard, ['Zoë', 'Zoë'], 'the name at once, then the server\'s answer');
  assert.equal(sent.at(-1)!.get('x-operator'), 'Zo%C3%AB');

  clearOperatorName();
  assert.equal((await loadMe()).user, 'operator');
  assert.equal(heard.at(-1), 'operator');
  off(); offChange();
});

test('nameInitial: the first character, upper-cased, for the tablet rail; ? when no name is set', () => {
  assert.equal(nameInitial('jon'), 'J');
  assert.equal(nameInitial('  zoë müller'), 'Z');
  assert.equal(nameInitial('Østergaard'), 'Ø');
  assert.equal(nameInitial('😀 sam'), '😀', 'one whole character, not half of a pair');
  assert.equal(nameInitial(null), '?');
  assert.equal(nameInitial('   '), '?');
});
