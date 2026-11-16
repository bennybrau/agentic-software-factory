import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RepoSelect } from './RepoSelect';

const repos = [{ id: 'github:acme/web', path: 'acme/web' }, { id: 'gitlab:acme/web', path: 'acme/web' }];
const noop = () => {};

test('one host: a flat list and no host badge, as before', () => {
  const html = renderToStaticMarkup(<RepoSelect repos={[repos[0]]} scm={['github']} value="github:acme/web" onChange={noop} />);
  assert.doesNotMatch(html, /optgroup/);
  assert.doesNotMatch(html, /pill source/);
  assert.match(html, /<option value="github:acme\/web" selected="">acme\/web<\/option>/);
});

test('two hosts: options grouped by host, and the chosen one\'s host beside the select', () => {
  const html = renderToStaticMarkup(<RepoSelect repos={repos} scm={['github', 'gitlab']} value="gitlab:acme/web" onChange={noop} aria-label="Repository" />);
  assert.match(html, /<optgroup label="GitHub"><option value="github:acme\/web">acme\/web<\/option><\/optgroup><optgroup label="GitLab">/);
  assert.match(html, /<span class="pill source">GitLab<\/span>/);
  assert.match(html, /aria-label="Repository"/);
});

test('a placeholder comes first; nothing chosen shows no badge', () => {
  const html = renderToStaticMarkup(<RepoSelect repos={repos} scm={['github', 'gitlab']} value="" onChange={noop} placeholder="Choose…" />);
  assert.match(html, /<select><option value="" selected="">Choose…<\/option><optgroup/);
  assert.doesNotMatch(html, /pill source/);
});
