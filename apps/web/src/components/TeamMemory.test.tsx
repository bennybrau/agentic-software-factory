import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { TeamMemory } from './TeamMemory';

const facts = [
  { id: 'aaaaaaaa1111', kind: 'gotcha', text: 'Never edit an applied migration', scope: 'global' },
  { id: 'bbbbbbbb2222', kind: 'decision', text: 'Only the registry talks to Postgres', scope: '' },
  { id: 'cccccccc3333', kind: 'fact', text: 'Settings drift fails CI', scope: 'repo:gh/acme/app' },
  { id: 'dddddddd4444', kind: 'fact', text: 'Nobody mentioned this one', scope: '' },
];
const plan = [
  '# Plan', '', '## Team memory',
  '- [hive:aaaaaaaa] Never edit an applied migration: applied (no migration in this change)',
  '- [hive:bbbbbbbb] Only the registry talks to Postgres: overridden: this ticket adds a read replica',
  '- [hive:cccccccc] Settings drift fails CI: doesn\'t apply here (no settings touched)',
  '', 'Change-Type: feat',
].join('\n');

test('a row per fact with its tag, kind, text, scope and the plan\'s verdict', () => {
  const html = renderToStaticMarkup(<TeamMemory brief={{ facts, dashboardUrl: null }} planMd={plan} />);
  assert.match(html, /Team memory/);
  assert.match(html, /<code>\[hive:aaaaaaaa\]<\/code>/);
  assert.match(html, /gotcha<\/span> Never edit an applied migration/);
  assert.match(html, /\(global\)/);
  assert.match(html, /<b>Applied<\/b><span class="muted">: no migration in this change<\/span>/);
  assert.match(html, /<b>Overridden<\/b><span class="muted">: this ticket adds a read replica<\/span>/);
  assert.match(html, /<b>Doesn(&#x27;|')t apply<\/b><span class="muted">: no settings touched<\/span>/);
  assert.match(html, /Nobody mentioned this one<\/li>/, 'no verdict = blank');
  assert.doesNotMatch(html, /<a /, 'no dashboard, no links');
});

test('with a dashboard the tag links to the fact page in a new tab', () => {
  const html = renderToStaticMarkup(<TeamMemory brief={{ facts: [{ ...facts[0]!, id: 'aaaaaaaa/1 1' }], dashboardUrl: 'https://hive.example.com' }} />);
  assert.match(html, /<a href="https:\/\/hive\.example\.com\/facts\/aaaaaaaa%2F1%201" target="_blank" rel="noreferrer"><code>\[hive:aaaaaaaa\]<\/code><\/a>/);
});

test('no brief or no facts renders nothing', () => {
  assert.equal(renderToStaticMarkup(<TeamMemory brief={null} planMd={plan} />), '');
  assert.equal(renderToStaticMarkup(<TeamMemory brief={undefined} />), '');
  assert.equal(renderToStaticMarkup(<TeamMemory brief={{ facts: [], dashboardUrl: 'https://h' }} />), '');
});
