import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchSafeKey, changeRequestMentionsKey, mentionsTicketKey } from './ticket-key.js';

test('mentionsTicketKey matches the key on its own, followed by any separator or the end', () => {
  for (const text of [
    'PROJ-12', 'PROJ-12: fix login', 'Draft: PROJ-12 fix login', '[PROJ-12] fix', 'fix login (PROJ-12)',
    'agent/PROJ-12-abcd1234', 'feature/PROJ-12_login', 'PROJ-12/part-2',
  ]) assert.equal(mentionsTicketKey(text, 'PROJ-12'), true, text);
});

test('mentionsTicketKey does not match a longer key that starts or ends with it', () => {
  for (const text of ['PROJ-123: fix login', 'agent/PROJ-123-abcd1234', 'XPROJ-12: fix', 'agent/XPROJ-12-abcd1234', 'PROJ-12a'])
    assert.equal(mentionsTicketKey(text, 'PROJ-12'), false, text);
});

test('mentionsTicketKey ignores case', () => {
  assert.equal(mentionsTicketKey('feature/proj-12-login', 'PROJ-12'), true);
  assert.equal(mentionsTicketKey('feature/proj-123-login', 'PROJ-12'), false);
});

test('mentionsTicketKey treats hex ad-hoc keys as whole keys', () => {
  assert.equal(mentionsTicketKey('agent/ADHOC-CE1722DF-0a1b2c3d', 'ADHOC-CE1722DF'), true);
  assert.equal(mentionsTicketKey('ADHOC-CE1722DF: add skills', 'ADHOC-CE1722DF'), true);
  assert.equal(mentionsTicketKey('agent/ADHOC-CE1722DF-0a1b2c3d', 'ADHOC-CE17'), false);
  assert.equal(mentionsTicketKey('ADHOC-CE1722DF: add skills', 'ADHOC-CE17'), false);
});

test('mentionsTicketKey escapes regex characters in GitHub issue keys', () => {
  assert.equal(mentionsTicketKey('acme/web#42: fix', 'acme/web#42'), true);
  assert.equal(mentionsTicketKey('acme/web#420: fix', 'acme/web#42'), false);
  assert.equal(mentionsTicketKey('acmeXweb#42: fix', 'acme.web#42'), false);
  assert.equal(mentionsTicketKey('anything', ''), false);
});

test('changeRequestMentionsKey checks the title, the branch, and the branch-safe form of the key', () => {
  assert.equal(branchSafeKey('acme/web#42'), 'acme-web-42');
  assert.equal(changeRequestMentionsKey({ title: 'unrelated', branch: 'agent/acme-web-42-abcd1234' }, 'acme/web#42'), true);
  assert.equal(changeRequestMentionsKey({ title: 'unrelated', branch: 'agent/acme-web-420-abcd1234' }, 'acme/web#42'), false);
  assert.equal(changeRequestMentionsKey({ title: 'PROJ-12: fix', branch: 'feat/x' }, 'PROJ-12'), true);
  assert.equal(changeRequestMentionsKey({ title: 'PROJ-123: fix', branch: 'agent/PROJ-123-abcd1234' }, 'PROJ-12'), false);
});
