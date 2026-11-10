import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHiveBrief } from './hive-brief.js';

test('formatHiveBrief: playbook first, then gotchas, facts, where to look, past runs, tests', () => {
  const text = formatHiveBrief({
    playbook: [{
      title: 'Add a setting', scope: 'repo:gh/acme/app',
      steps: [{ text: 'Edit settings.ts ', fact_ids: ['aaaaaaaa1111'] }, { text: 'Run pnpm gen:config', fact_ids: [] }],
      pitfalls: [{ text: 'CI fails on drift', fact_ids: ['bbbbbbbb2222', 'cccccccc3333'] }],
    }],
    gotchas: [{ id: 'dddddddd4444', text: 'Never edit an applied migration', kind: 'gotcha', scope: 'repo:gh/acme/app', verify: 'drifted' }],
    facts: [{ id: 'eeeeeeee5555', text: 'Only the registry talks to Postgres', kind: 'decision', scope: 'personal:jon' }],
    locations: [{ ref: 'docs/HIVE.md:10-20', path: 'docs/HIVE.md' }, { path: 'apps/api/src/hive.ts' }],
    runs: [{ ref: 'run_1', title: 'Send episodes', pr_url: 'https://github.com/acme/app/pull/7' }, { ref: 'run_2', title: null }],
    tests: [{ path: 'apps/api/src/hive.test.ts' }, { path: 'packages/shared/src/settings.test.ts' }],
  });
  assert.equal(text, [
    'Playbook: Add a setting (repo:gh/acme/app)',
    'Steps:',
    '1. Edit settings.ts [hive:aaaaaaaa]',
    '2. Run pnpm gen:config',
    'Pitfalls:',
    '- CI fails on drift [hive:bbbbbbbb] [hive:cccccccc]',
    'Gotchas:',
    '- Never edit an applied migration (repo:gh/acme/app, gotcha, source changed since) [hive:dddddddd]',
    'Facts:',
    '- Only the registry talks to Postgres (personal, decision) [hive:eeeeeeee]',
    'Where to look: docs/HIVE.md:10-20, apps/api/src/hive.ts',
    'Past runs:',
    '- Send episodes (https://github.com/acme/app/pull/7)',
    '- run_2',
    'Tests: apps/api/src/hive.test.ts, packages/shared/src/settings.test.ts',
  ].join('\n'));
});

test('formatHiveBrief: a brief with nothing in it is empty', () => {
  assert.equal(formatHiveBrief({}), '');
  assert.equal(formatHiveBrief({ playbook: [], gotchas: [], facts: [], locations: [], runs: [], tests: [] }), '');
});
