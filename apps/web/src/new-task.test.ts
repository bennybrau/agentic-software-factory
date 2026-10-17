import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adhocNext, chatProblem, chatTitle, formatBytes, mimeOf, newTaskProblem, pickChatRepo, removeAdhoc } from './new-task';

const limits = { maxFiles: 2, maxFileMb: 1 };
const png = { name: 'shot.png', mime: 'image/png', size: 2048 };

test('a title is required and bounded', () => {
  assert.match(newTaskProblem('   ', [], limits)!, /title/);
  assert.match(newTaskProblem('x'.repeat(201), [], limits)!, /under 200/);
  assert.equal(newTaskProblem('Fix the login page', [], limits), null);
});

test('files are checked for type, count and size', () => {
  assert.equal(newTaskProblem('T', [png], limits), null);
  assert.match(newTaskProblem('T', [png, png, png], limits)!, /At most 2 files/);
  assert.match(newTaskProblem('T', [{ name: 'a.svg', mime: 'image/svg+xml', size: 10 }], limits)!, /only images/);
  assert.match(newTaskProblem('T', [{ name: 'a.zip', mime: '', size: 10 }], limits)!, /only images/);
  assert.match(newTaskProblem('T', [{ ...png, size: 1024 * 1024 + 1 }], limits)!, /larger than 1 MB/);
  assert.match(newTaskProblem('T', [{ ...png, size: 0 }], limits)!, /empty/);
});

test('mimeOf keeps the browser type and falls back to the extension', () => {
  assert.equal(mimeOf('a.png', 'image/png'), 'image/png');
  assert.equal(mimeOf('notes.MD', ''), 'text/markdown');
  assert.equal(mimeOf('Makefile', ''), '');
});

test('adhocNext routes start to dispatch and later to the backlog', () => {
  assert.equal(adhocNext('start', 'ADHOC-3f2a9c'), '/dispatch/ADHOC-3f2a9c');
  assert.equal(adhocNext('later', 'ADHOC-3f2a9c'), '/backlog');
});

test('Remove deletes the ad-hoc task by id, then refetches', async () => {
  const deleted: string[] = [];
  let refetched = false;
  await removeAdhoc({
    delete: async (id) => { deleted.push(id); },
    refetch: async () => { refetched = true; },
  }, 'adhoc:abc');
  assert.deepEqual(deleted, ['adhoc:abc']);
  assert.ok(refetched);
});

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});

test('chatTitle takes the first line, strips Markdown and cuts long text at a word', () => {
  assert.equal(chatTitle('\n\n## Fix the **login** page\nmore detail'), 'Fix the login page');
  assert.equal(chatTitle('> see [the docs](https://x.y) for `foo`'), 'see the docs for foo');
  assert.equal(chatTitle('- a list item'), 'a list item');
  const long = chatTitle('word '.repeat(40));
  assert.ok(long.length <= 80, long);
  assert.match(long, /word$/);
  assert.equal(chatTitle('   \n  \n'), 'New chat');
  assert.equal(chatTitle('***'), 'New chat');
});

test('chatProblem wants some text, then checks the files', () => {
  assert.match(chatProblem('  ', [], limits)!, /what we should work on/);
  assert.equal(chatProblem('Fix it', [png], limits), null);
  assert.match(chatProblem('Fix it', [png, png, png], limits)!, /At most 2 files/);
});

test('pickChatRepo prefers the suggested repo, else the first, else none', () => {
  const repos = [{ id: 'r1' }, { id: 'r2' }];
  assert.equal(pickChatRepo({ suggestedRepoId: 'r2', repos }), 'r2');
  assert.equal(pickChatRepo({ suggestedRepoId: null, repos }), 'r1');
  assert.equal(pickChatRepo({ suggestedRepoId: null, repos: [] }), null);
});
