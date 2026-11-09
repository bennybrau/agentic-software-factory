import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runContextSchema } from './context.js';

const payload = {
  runId: 'run_1',
  ticket: { id: 't1', key: 'ASF-1', title: 'T', body: '', url: 'http://x' },
  repo: null,
  cloneCredential: null,
  auth: { providerKind: 'anthropic', mode: 'oauth-token', credential: 'x' },
};

test('a context without thirdPartySkills (an older api) parses to []', () => {
  assert.deepEqual(runContextSchema.parse(payload).thirdPartySkills, []);
});

test('a context carries its third-party skills', () => {
  const skill = {
    id: 'pdf-tools', name: 'pdf-tools', description: 'PDFs', sourceUrl: 'https://github.com/o/r', sourceRef: 'main',
    commitSha: 'abcdef1', files: [{ path: 'SKILL.md', content: '---\nname: pdf-tools\n---\nbody' }],
    enabled: true, roles: ['implementer'], addedBy: null, updatedAt: '2026-01-01T00:00:00Z',
  };
  assert.deepEqual(runContextSchema.parse({ ...payload, thirdPartySkills: [skill] }).thirdPartySkills.map((s) => s.id), ['pdf-tools']);
});

test('referenceRepos is optional: an older api parses without it, and the field round-trips', () => {
  assert.equal('referenceRepos' in runContextSchema.parse(payload), false);
  const ref = {
    repo: { id: '2', path: 'acme/platform/web/shared-ui', url: 'https://example.test/acme/platform/web/shared-ui', defaultBranch: 'main', cloneUrl: 'https://example.test/acme/platform/web/shared-ui.git' },
    cloneCredential: { url: 'https://example.test/acme/platform/web/shared-ui.git' },
    reason: 'The ticket description mentions shared-ui.',
  };
  assert.deepEqual(runContextSchema.parse({ ...payload, referenceRepos: [ref] }).referenceRepos, [ref]);
  assert.throws(() => runContextSchema.parse({ ...payload, referenceRepos: [{ ...ref, reason: undefined }] }));
});
