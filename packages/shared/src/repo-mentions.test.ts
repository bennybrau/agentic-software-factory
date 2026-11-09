import test from 'node:test';
import assert from 'node:assert/strict';
import { reposMentioned } from './repo-mentions.js';

const SHARED_UI = { id: 'acme/platform/web/shared-ui', path: 'acme/platform/web/shared-ui' };
const COMPONENTS = { id: 'acme/platform/web/shared-components-web', path: 'acme/platform/web/shared-components-web' };
const THEMES = { id: 'acme/platform/web/shared-ui-themes', path: 'acme/platform/web/shared-ui-themes' };
const HIVE = { id: '7', path: 'bennybrau/hive' }; // GitHub: owner/repo, numeric id
const repos = [SHARED_UI, COMPONENTS, THEMES, HIVE];

const ids = (title: string, body = '', list = repos) => reposMentioned({ title, body }, list).map((m) => m.id);

test('the full path matches, case-insensitively', () => {
  assert.deepEqual(ids('Fix the header in ACME/Platform/web/Shared-UI'), [SHARED_UI.id]);
  assert.deepEqual(reposMentioned({ title: '', body: 'In acme/platform/web/shared-ui' }, repos), [{ id: SHARED_UI.id, path: SHARED_UI.path, where: 'body', name: SHARED_UI.path }]);
});

test('the last path segment matches on its own', () => {
  assert.deepEqual(ids('Button colours are wrong in shared-ui'), [SHARED_UI.id]);
  assert.deepEqual(ids('SHARED-COMPONENTS-WEB: bump react'), [COMPONENTS.id]);
});

test('GitHub owner/repo and its bare repo name match', () => {
  assert.deepEqual(ids('Port this to bennybrau/hive'), [HIVE.id]);
  assert.deepEqual(ids('hive should ingest faster'), [HIVE.id]);
});

test('only a whole name matches, not part of a longer one', () => {
  assert.deepEqual(ids('Update shared-ui-themes'), [THEMES.id]);
  assert.deepEqual(ids('Update my-shared-ui and shared_ui and shared-ui2 and xshared-ui'), []);
  assert.deepEqual(ids('the beehive is fine'), []);
  assert.deepEqual(ids('see shared-ui.v2 or foo.shared-ui'), [], 'a dot inside a name glues it to the next part');
});

test('sentence punctuation and brackets around a name still count as a boundary', () => {
  for (const t of ['Fix shared-ui.', 'Fix shared-ui, then ship', 'Fix shared-ui...', '(shared-ui)', 'shared-ui: header', '"shared-ui"', 'shared-ui!', 'shared-ui?']) {
    assert.deepEqual(ids(t), [SHARED_UI.id], t);
  }
});

test('a name in backticks, a URL or a clone URL matches', () => {
  assert.deepEqual(ids('', 'The bug is in `shared-ui`'), [SHARED_UI.id]);
  assert.deepEqual(ids('', 'See https://gitlab.com/acme/platform/web/shared-ui/-/merge_requests/1 for context'), [SHARED_UI.id]);
  assert.deepEqual(ids('', 'git clone git@gitlab.com:acme/platform/web/shared-ui.git'), [SHARED_UI.id]);
  assert.deepEqual(ids('', 'https://github.com/bennybrau/hive/pull/3'), [HIVE.id]);
});

test('a last segment two repos share is ambiguous: only the full path matches', () => {
  const a = { id: 'acme/web/shared-ui', path: 'acme/web/shared-ui' };
  const b = { id: 'acme/mobile/shared-ui', path: 'acme/mobile/shared-ui' };
  assert.deepEqual(ids('Fix shared-ui', '', [a, b]), []);
  assert.deepEqual(ids('Fix acme/mobile/shared-ui', '', [a, b]), [b.id]);
});

test('short last segments (under 4 characters) match only by full path', () => {
  const web = { id: 'acme/web', path: 'acme/web' };
  const api = { id: 'acme/api', path: 'acme/api' };
  assert.deepEqual(ids('The web page is slow, the api too', '', [web, api]), []);
  assert.deepEqual(ids('The page in acme/web is slow', '', [web, api]), [web.id]);
});

test('a path inside a longer repo path names only the longer repo', () => {
  const parent = { id: 'acme/web', path: 'acme/web' };
  const child = { id: 'acme/web/shared-ui', path: 'acme/web/shared-ui' };
  assert.deepEqual(ids('Fix acme/web/shared-ui', '', [parent, child]), [child.id]);
});

test('title mentions come first, then by first position; each repo once', () => {
  const ms = reposMentioned({ title: 'shared-components-web and hive', body: 'shared-ui first, then shared-ui-themes, hive again' }, repos);
  assert.deepEqual(ms.map((m) => [m.id, m.where]), [[COMPONENTS.id, 'title'], [HIVE.id, 'title'], [SHARED_UI.id, 'body'], [THEMES.id, 'body']]);
  assert.deepEqual(ids('', 'shared-ui-themes before shared-ui'), [THEMES.id, SHARED_UI.id]);
});

test('no mentions, no repos or empty text give nothing', () => {
  assert.deepEqual(ids('Make the login button blue', 'Nothing about repositories here.'), []);
  assert.deepEqual(ids('shared-ui', '', []), []);
  assert.deepEqual(ids('', ''), []);
});
