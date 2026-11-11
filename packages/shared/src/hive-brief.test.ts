import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHiveBrief, hiveBriefFacts, parseTeamMemory } from './hive-brief.js';

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

test('hiveBriefFacts: gotchas then facts, with kind and scope defaulted', () => {
  assert.deepEqual(hiveBriefFacts({
    playbook: [{ title: 'P', steps: [{ text: 'step', fact_ids: ['aaaaaaaa'] }] }],
    facts: [{ id: 'ffff0001', text: 'A decision', kind: 'decision', scope: 'global' }, { id: 'ffff0002', text: 'Plain' }],
    gotchas: [{ id: 'gggg0001', text: 'Watch out', scope: 'repo:gh/acme/app', verify: 'drifted' }],
    locations: [{ path: 'x.ts' }],
  }), [
    { id: 'gggg0001', kind: 'gotcha', text: 'Watch out', scope: 'repo:gh/acme/app' },
    { id: 'ffff0001', kind: 'decision', text: 'A decision', scope: 'global' },
    { id: 'ffff0002', kind: 'fact', text: 'Plain', scope: '' },
  ]);
  assert.deepEqual(hiveBriefFacts({}), []);
});

const plan = (section: string) => `# Plan\n\nDo the thing.\n\n## Team memory\n${section}\n\nNo open questions.\n\nChange-Type: feat\n`;

test('parseTeamMemory: applied, overridden with its reason, and doesn\'t apply', () => {
  assert.deepEqual(parseTeamMemory(plan([
    '- [hive:aaaaaaaa] Only the registry talks to Postgres: applied',
    '- [hive:bbbbbbbb] Keep the old endpoint: overridden: the ticket retires it, see #12',
    '- [hive:cccccccc] Things-to-do without MCP: doesn\'t apply here',
  ].join('\n'))), {
    aaaaaaaa: { verdict: 'applied' },
    bbbbbbbb: { verdict: 'overridden', reason: 'the ticket retires it, see #12' },
    cccccccc: { verdict: 'not_applicable' },
  });
});

test('parseTeamMemory: curly apostrophe, "does not", dash separators, any case', () => {
  assert.deepEqual(parseTeamMemory(plan([
    '- [hive:aaaaaaaa] Planner chat renders markdown: Doesn’t apply here',
    '- [hive:bbbbbbbb] Human review of facts - does not apply',
    '- [hive:cccccccc] Never edit a migration — APPLIED',
    '- [hive:dddddddd] Settings via the catalogue – overridden – no setting changes',
  ].join('\n'))), {
    aaaaaaaa: { verdict: 'not_applicable' },
    bbbbbbbb: { verdict: 'not_applicable' },
    cccccccc: { verdict: 'applied' },
    dddddddd: { verdict: 'overridden', reason: 'no setting changes' },
  });
});

test('parseTeamMemory: a verdict followed by its reason', () => {
  assert.deepEqual(parseTeamMemory(plan([
    '- [hive:aaaaaaaa] Things-to-do without MCP: doesn\'t apply here (MCP isn\'t touched; the change is in the web panel)',
    '- [hive:bbbbbbbb] Keep the old endpoint: applied (the endpoint stays as it is)',
    '- [hive:cccccccc] Never edit a migration - applied - because x',
    '- [hive:dddddddd] Human review of facts: doesn\'t apply here.',
    '- [hive:eeeeeeee] Settings via the catalogue: overridden. reason',
    '- [hive:ffffffff] Fact was applied to the worker: doesn\'t apply here',
    '- [hive:11111111] Settings load at boot: applied at boot',
  ].join('\n'))), {
    aaaaaaaa: { verdict: 'not_applicable', reason: 'MCP isn\'t touched; the change is in the web panel' },
    bbbbbbbb: { verdict: 'applied', reason: 'the endpoint stays as it is' },
    cccccccc: { verdict: 'applied', reason: 'because x' },
    dddddddd: { verdict: 'not_applicable' },
    eeeeeeee: { verdict: 'overridden', reason: 'reason' },
    ffffffff: { verdict: 'not_applicable' },
  });
});

test('parseTeamMemory: malformed lines are skipped, unknown tags dropped, only the section counts', () => {
  const text = [
    '# Plan', '', 'Mentions [hive:99999999] Something: applied in the body.', '',
    '## Team memory',
    '- [hive:aaaaaaaa] No verdict on this one',
    '- hive:bbbbbbbb Missing brackets: applied',
    '- [hive:cccccccc] Known fact: applied',
    '- [hive:dddddddd] Not in the brief: applied',
    '',
    'Change-Type: feat',
    '- [hive:eeeeeeee] After the section: applied',
  ].join('\n');
  assert.deepEqual(parseTeamMemory(text, ['cccccccc1234', 'aaaaaaaa5678', 'eeeeeeee0000']), { cccccccc: { verdict: 'applied' } });
  assert.deepEqual(parseTeamMemory(text), { cccccccc: { verdict: 'applied' }, dddddddd: { verdict: 'applied' } });
});

test('parseTeamMemory: no section, nothing remembered, or junk = {}', () => {
  assert.deepEqual(parseTeamMemory('# Plan\n\n- [hive:aaaaaaaa] Fact: applied\n'), {});
  assert.deepEqual(parseTeamMemory(plan('Nothing remembered applies to this ticket.')), {});
  assert.deepEqual(parseTeamMemory(undefined as unknown as string), {});
});
