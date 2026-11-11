import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_CONNECTIONS, connectionKind, formatRef, isKnownConnection, nativeId, parseRef, sameRef,
  repoSchema, ticketSchema,
} from './index.js';

test('parseRef/formatRef: qualified refs round-trip', () => {
  for (const [ref, connection, native] of [
    ['jira:PROJ-12', 'jira', 'PROJ-12'],
    ['github:acme/web#42', 'github', 'acme/web#42'],
    ['gitlab:acme/platform/web/shared-ui', 'gitlab', 'acme/platform/web/shared-ui'],
    ['adhoc:ce17', 'adhoc', 'adhoc:ce17'],
  ] as const) {
    const parsed = parseRef(ref, 'mock');
    assert.deepEqual(parsed, { connection, native, qualified: true });
    assert.equal(formatRef(parsed.connection, parsed.native), ref);
  }
});

test('parseRef: bare ids fall back to the default connection', () => {
  assert.deepEqual(parseRef('PROJ-12', 'jira'), { connection: 'jira', native: 'PROJ-12', qualified: false });
  assert.deepEqual(parseRef('acme/web', 'github'), { connection: 'github', native: 'acme/web', qualified: false });
});

test('parseRef: an unknown prefix stays part of the native id', () => {
  assert.deepEqual(parseRef('foo:bar', 'jira'), { connection: 'jira', native: 'foo:bar', qualified: false });
});

test('parseRef: only the first colon splits', () => {
  assert.deepEqual(parseRef('jira:PROJ:12', 'mock'), { connection: 'jira', native: 'PROJ:12', qualified: true });
});

test('parseRef: prefix matching is case-sensitive', () => {
  assert.equal(parseRef('JIRA:PROJ-12', 'mock').qualified, false);
});

test('formatRef: idempotent', () => {
  const once = formatRef('jira', 'PROJ-12');
  assert.equal(once, 'jira:PROJ-12');
  assert.equal(formatRef('jira', once), once);
  assert.equal(formatRef('adhoc', formatRef('adhoc', 'adhoc:ce17')), 'adhoc:ce17');
});

test('KNOWN_CONNECTIONS / isKnownConnection / connectionKind', () => {
  assert.equal(new Set(KNOWN_CONNECTIONS).size, KNOWN_CONNECTIONS.length);
  for (const id of ['mock', 'jira', 'github', 'gitlab', 'trello', 'adhoc']) assert.ok(isKnownConnection(id), id);
  assert.equal(isKnownConnection('foo'), false);
  assert.equal(isKnownConnection('Jira'), false);
  assert.equal(connectionKind('github'), 'github');
});

test('nativeId strips a known prefix only', () => {
  assert.equal(nativeId('jira:PROJ-12'), 'PROJ-12');
  assert.equal(nativeId('PROJ-12'), 'PROJ-12');
  assert.equal(nativeId('foo:bar'), 'foo:bar');
  assert.equal(nativeId('adhoc:ce17'), 'adhoc:ce17');
});

test('sameRef: bare and qualified refs to the same object match', () => {
  assert.ok(sameRef('PROJ-12', 'jira:PROJ-12', 'jira'));
  assert.ok(sameRef('jira:PROJ-12', 'jira:PROJ-12', 'github'));
  assert.equal(sameRef('PROJ-12', 'jira:PROJ-12', 'github'), false);
  assert.equal(sameRef('jira:PROJ-12', 'jira:PROJ-123', 'jira'), false);
});

test('ticketSchema and repoSchema still parse payloads without connection', () => {
  const ticket = ticketSchema.parse({
    id: 'PROJ-12', key: 'PROJ-12', url: 'https://x/PROJ-12', title: 't', status: 'To Do', bucket: 'backlog',
    priority: null, assignee: null, parentId: null, updatedAt: '2026-01-01T00:00:00Z',
  });
  assert.equal(ticket.connection, undefined);
  const repo = repoSchema.parse({ id: '1', path: 'acme/web', url: 'u', defaultBranch: 'main', cloneUrl: 'c' });
  assert.equal(repo.connection, undefined);
  assert.equal(repoSchema.parse({ id: '1', path: 'acme/web', url: 'u', defaultBranch: 'main', cloneUrl: 'c', connection: 'github' }).connection, 'github');
});
