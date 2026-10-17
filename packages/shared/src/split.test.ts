import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSplit, subtaskBody } from './split.js';

const plan = (json: string) => `# Plan\n\nBig thing.\n\n\`\`\`asf-split\n${json}\n\`\`\`\n\nNo open questions.`;
const two = JSON.stringify([
  { title: 'Data model', body: 'Add the tables.' },
  { title: 'UI', body: 'Show it.', dependsOn: [1, 1] },
]);

test('a plan without a split block is an ordinary plan', () => {
  assert.deepEqual(parseSplit('# Plan\n\nSmall change.'), { kind: 'none' });
  assert.deepEqual(parseSplit(null), { kind: 'none' });
  assert.deepEqual(parseSplit('```json\n[]\n```'), { kind: 'none' });
});

test('a valid split parses, defaults dependsOn and dedupes it', () => {
  const r = parseSplit(plan(two));
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.subtasks.length, 2);
  assert.deepEqual(r.subtasks[0].dependsOn, []);
  assert.deepEqual(r.subtasks[1].dependsOn, [1]);
});

test('invalid splits are refused with a reason, never guessed at', () => {
  const cases: Array<[string, RegExp]> = [
    [plan('[{"title": "x", "body": "y"'), /not valid JSON/],
    [plan(JSON.stringify([{ title: 'only one', body: 'b' }])), /at least 2/],
    [plan(JSON.stringify([{ title: 'a', body: 'b', dependsOn: [2] }, { title: 'c', body: 'd' }])), /may only depend on earlier/],
    [plan(JSON.stringify([{ title: 'a', body: 'b' }, { title: 'c', body: 'd', dependsOn: [2] }])), /may only depend on earlier/],
    [plan(JSON.stringify([{ title: '', body: 'b' }, { title: 'c', body: 'd' }])), /sub-task 1 title/],
    [plan(JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, body: 'b' })))), /at most 8/],
    ['```asf-split\n[]', /not closed/],
    [plan(two) + '\n' + plan(two), /2 `asf-split` blocks/],
  ];
  for (const [md, re] of cases) {
    const r = parseSplit(md);
    assert.equal(r.kind, 'invalid', md);
    if (r.kind === 'invalid') assert.match(r.reason, re);
  }
});

test('a sub-task body is self-contained and forbids re-splitting', () => {
  const body = subtaskBody({ title: 'UI', body: 'Show it.', dependsOn: [1] }, 2, 3, { key: 'ADHOC-1', title: 'Big' }, ['ADHOC-A']);
  assert.match(body, /^Show it\./);
  assert.match(body, /part 2 of 3 of ADHOC-1 \(Big\)/);
  assert.match(body, /after ADHOC-A is merged/);
  assert.match(body, /do not split it again/);
});

test('a part may name another repository; one part is allowed only as such a hand-off', () => {
  const r = parseSplit(plan(JSON.stringify([{ title: 'a', body: 'b' }, { title: 'c', body: 'd', repo: ' org/other ' }])));
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') { assert.equal(r.subtasks[0].repo, undefined); assert.equal(r.subtasks[1].repo, 'org/other'); }

  const one = parseSplit(plan(JSON.stringify([{ title: 'hand off', body: 'b', repo: 'org/other' }])));
  assert.equal(one.kind, 'ok');

  const bare = parseSplit(plan(JSON.stringify([{ title: 'only one', body: 'b' }])));
  assert.equal(bare.kind, 'invalid');
  if (bare.kind === 'invalid') assert.match(bare.reason, /single part needs a `repo`/);
});

test('a sub-task body names the repository it goes into', () => {
  const body = subtaskBody({ title: 'API', body: 'Add it.', dependsOn: [], repo: 'org/other' }, 1, 1, { key: 'ADHOC-1', title: 'Big' }, []);
  assert.match(body, /It goes into the repository `org\/other`\./);
  assert.doesNotMatch(subtaskBody({ title: 'UI', body: 'x', dependsOn: [] }, 1, 2, { key: 'ADHOC-1', title: 'Big' }, []), /goes into the repository/);
});
