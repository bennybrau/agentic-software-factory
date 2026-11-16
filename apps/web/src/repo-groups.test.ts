import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupReposByHost, hostBadge, sourceBadge } from './repo-groups';

const r = (id: string) => ({ id, path: id.replace(/^\w+:/, '') });

test('groupReposByHost groups in connection order; a bare id is the first host\'s', () => {
  const g = groupReposByHost([r('github:acme/web'), r('gitlab:acme/ui'), r('acme/bare')], ['gitlab', 'github']);
  assert.deepEqual(g.map((x) => [x.connection, x.label, x.repos.map((y) => y.id)]), [
    ['gitlab', 'GitLab', ['gitlab:acme/ui', 'acme/bare']],
    ['github', 'GitHub', ['github:acme/web']],
  ]);
});

test('groupReposByHost drops empty hosts and puts unlisted hosts last', () => {
  const g = groupReposByHost([r('github:acme/web'), r('mock:demo')], ['gitlab', 'github']);
  assert.deepEqual(g.map((x) => x.connection), ['github', 'mock']);
  assert.deepEqual(groupReposByHost([], ['github']), []);
});

test('sourceBadge names the tracker only with several, never for ad-hoc', () => {
  assert.equal(sourceBadge('jira', ['jira', 'github']), 'Jira');
  assert.equal(sourceBadge('jira', ['jira']), null);
  assert.equal(sourceBadge('adhoc', ['jira', 'github']), null);
  assert.equal(sourceBadge(undefined, ['jira', 'github']), null);
});

test('hostBadge names the host only with several hosts and a repository', () => {
  assert.equal(hostBadge('gitlab:acme/ui', ['github', 'gitlab']), 'GitLab');
  assert.equal(hostBadge('acme/web', ['github', 'gitlab']), 'GitHub');
  assert.equal(hostBadge('gitlab:acme/ui', ['gitlab']), null);
  assert.equal(hostBadge(null, ['github', 'gitlab']), null);
});
