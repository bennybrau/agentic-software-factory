import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_DRAFT_KEY, loadChatDraft, saveChatDraft, type DraftStore } from './chat-draft';

function memStore(): DraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

const broken: DraftStore = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
  removeItem: () => { throw new Error('SecurityError'); },
};

test('a draft round-trips exactly, newlines and spacing included', () => {
  const s = memStore();
  const text = '  Fix the login page\n\n- keep the **remember me** box\n';
  saveChatDraft(text, s);
  assert.equal(s.map.get(CHAT_DRAFT_KEY), text);
  assert.equal(loadChatDraft(s), text);
});

test('no draft loads as empty', () => {
  assert.equal(loadChatDraft(memStore()), '');
  assert.equal(loadChatDraft(null), '');
});

test('clearing the box (or only whitespace) removes the draft', () => {
  const s = memStore();
  saveChatDraft('half a thought', s);
  saveChatDraft('', s);
  assert.equal(s.map.has(CHAT_DRAFT_KEY), false);
  saveChatDraft('again', s);
  saveChatDraft('  \n\t', s);
  assert.equal(s.map.has(CHAT_DRAFT_KEY), false);
});

test('storage that throws is ignored, never breaks the composer', () => {
  assert.doesNotThrow(() => saveChatDraft('x', broken));
  assert.doesNotThrow(() => saveChatDraft('', broken));
  assert.equal(loadChatDraft(broken), '');
});

test('with no sessionStorage at all (node), the defaults are safe', () => {
  assert.equal(loadChatDraft(), '');
  assert.doesNotThrow(() => saveChatDraft('x'));
});
