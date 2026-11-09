import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatesFor, isCustomised, modelsFor, overridesDiff, reconcileModel, repoHint, roleLock, runtimeOptions, skipRolesPayload } from './dispatch-roles';

const models = [
  { id: 'claude-opus', label: 'Opus', runtimes: ['claude-code'] },
  { id: 'claude-sonnet', label: 'Sonnet', runtimes: ['claude-code', 'codex'] },
  { id: 'gpt-5.5', label: 'GPT-5.5', runtimes: ['codex'] },
];

test('switching a role to codex narrows its models and picks one that fits', () => {
  assert.deepEqual(modelsFor(models, 'codex').map((m) => m.id), ['claude-sonnet', 'gpt-5.5']);
  assert.equal(reconcileModel(models, 'codex', 'claude-opus'), 'claude-sonnet');
  assert.equal(reconcileModel(models, 'codex', 'gpt-5.5'), 'gpt-5.5', 'a model that already fits is kept');
  assert.equal(reconcileModel(models, 'hermes', 'claude-opus'), 'claude-opus', 'nothing fits: leave it for the server to refuse');
});

test('overridesDiff sends only the roles changed off the default', () => {
  const defaults = { planner: 'claude-code', implementer: 'claude-code', tester: 'claude-code' };
  assert.deepEqual(overridesDiff({ planner: 'claude-code', implementer: 'codex', tester: 'claude-code' }, defaults), { implementer: 'codex' });
  assert.deepEqual(overridesDiff({ ...defaults }, defaults), {});
});

test('the runtime select always offers the current choice, even with no worker up', () => {
  assert.deepEqual(runtimeOptions([], 'claude-code'), ['claude-code']);
  assert.deepEqual(runtimeOptions(['claude-code', 'codex'], 'codex'), ['claude-code', 'codex']);
  assert.deepEqual(runtimeOptions(['codex'], 'claude-code'), ['claude-code', 'codex']);
});

test('the implementer is locked on, and a role the org switched off is locked off', () => {
  assert.match(roleLock('implementer', [])!, /write the code/);
  assert.match(roleLock('tester', ['tester'])!, /Settings/);
  assert.equal(roleLock('planner', ['tester']), null);
});

test('skipRolesPayload sends only the roles switched off on this page', () => {
  assert.deepEqual(skipRolesPayload({ planner: true, tester: true, reviewer: false }, ['tester']), ['planner']);
  assert.deepEqual(skipRolesPayload({}, []), []);
});

test('with the planner off the after-plan check-in is not offered', () => {
  const gates = ['after_plan', 'before_change_request', 'before_merge'];
  assert.deepEqual(gatesFor(gates, true), ['before_change_request', 'before_merge']);
  assert.deepEqual(gatesFor(gates, false), gates);
});

test('isCustomised: the defaults as loaded are not, any change to them is', () => {
  const preview = {
    defaultModels: { planner: 'claude-opus', reviewer: 'claude-sonnet' },
    defaultRuntimes: { planner: 'claude-code', reviewer: 'claude-code' },
    defaultEfforts: { planner: 'high', reviewer: null },
    gates: { after_plan: { mode: 'required' }, before_merge: { mode: 'required' } },
    orgDisabledRoles: ['tester'],
  };
  // Mirrors how Dispatch loads its state from the preview.
  const loaded = {
    models: { ...preview.defaultModels }, runtimes: { ...preview.defaultRuntimes },
    efforts: { planner: 'high', reviewer: '' },
    gates: { after_plan: 'required', before_merge: 'required' },
    off: { tester: true } as Record<string, boolean>,
  };
  assert.equal(isCustomised(loaded, preview), false, 'defaults as loaded');
  assert.equal(isCustomised({ ...loaded, models: { ...loaded.models, planner: 'claude-sonnet' } }, preview), true, 'model');
  assert.equal(isCustomised({ ...loaded, runtimes: { ...loaded.runtimes, reviewer: 'codex' } }, preview), true, 'runtime');
  assert.equal(isCustomised({ ...loaded, efforts: { ...loaded.efforts, reviewer: 'low' } }, preview), true, 'effort');
  assert.equal(isCustomised({ ...loaded, gates: { ...loaded.gates, after_plan: 'auto' } }, preview), true, 'gate');
  assert.equal(isCustomised({ ...loaded, off: { ...loaded.off, reviewer: true } }, preview), true, 'a role switched off here');
  assert.equal(isCustomised({ ...loaded, off: { tester: true, reviewer: false } }, preview), false, 'off only because the org disables it');
});

test('the repository hint gives the reason, and the other repositories the ticket names', () => {
  const repos = [
    { id: 'a/web/shared-ui', path: 'a/web/shared-ui' },
    { id: 'a/web/shared-components-web', path: 'a/web/shared-components-web' },
    { id: 'a/web/billing', path: 'a/web/billing' },
    { id: 'a/mobile/billing', path: 'a/mobile/billing' },
  ];
  const preview = { repos, suggestedRepoId: 'a/web/shared-ui', suggestedRepoReason: 'The ticket title mentions shared-ui.', mentionedRepoIds: ['a/web/shared-ui', 'a/web/shared-components-web', 'a/mobile/billing'] };
  assert.equal(repoHint(preview, 'a/web/shared-ui', false), 'The ticket title mentions shared-ui. Also mentioned: shared-components-web, a/mobile/billing.');
  assert.equal(repoHint(preview, 'a/web/billing', false), null, 'another repository chosen: nothing to explain');
  assert.equal(repoHint({ ...preview, mentionedRepoIds: ['a/web/shared-ui'] }, 'a/web/shared-ui', false), 'The ticket title mentions shared-ui.');
  assert.equal(repoHint({ repos, suggestedRepoId: null, suggestedRepoReason: null, mentionedRepoIds: [] }, 'a/web/shared-ui', false), null);
});

test('the repository hint still reads well from an older server with no reason', () => {
  const repos = [{ id: '1', path: 'o/r' }];
  assert.match(repoHint({ repos, suggestedRepoId: '1' }, '1', false)!, /issue.s own repository/);
  assert.match(repoHint({ repos, suggestedRepoId: '1' }, '1', true)!, /run that added it/);
});
