import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_TEAM } from './team.js';
import { resolvePipeline, skipRoles, disabledRoles, reviewOnlyStages, PipelineConfigError, GatePolicyError } from './index.js';

test('empty config = standard team, merge on; plan + merge wait for a person, the team in between just goes', () => {
  const r = resolvePipeline(STANDARD_TEAM, {});
  assert.equal(r.team.mergeEnabled, true);
  assert.deepEqual(r.team.roles.map((x) => x.role), ['planner', 'implementer', 'tester', 'reviewer']);
  assert.equal(r.gates.after_plan.mode, 'required');
  assert.equal(r.gates['after_role:implementer'].mode, 'auto');
  assert.equal(r.gates['after_role:tester'].mode, 'auto');
  assert.equal(r.gates['after_role:reviewer'].mode, 'auto');
  assert.equal(r.gates.before_change_request.mode, 'notify');
  assert.equal(r.gates.before_merge.mode, 'required');
});

test('a disabled role stage is dropped from the team', () => {
  const r = resolvePipeline(STANDARD_TEAM, { review: { enabled: false, gate: 'auto' } });
  assert.deepEqual(r.team.roles.map((x) => x.role), ['planner', 'implementer', 'tester']);
  assert.ok(r.disabledStages.includes('review'));
});

test('merge off -> mergeEnabled false, before_merge gate not required to run', () => {
  const r = resolvePipeline(STANDARD_TEAM, { merge: { enabled: false, gate: 'required' } });
  assert.equal(r.team.mergeEnabled, false);
});

test('per-stage gate mode maps onto the stage gate name', () => {
  const r = resolvePipeline(STANDARD_TEAM, {
    plan: { enabled: true, gate: 'auto' },
    create_mr: { enabled: true, gate: 'notify' },
  });
  assert.equal(r.gates.after_plan.mode, 'auto');
  assert.equal(r.gates.before_change_request.mode, 'notify');
});

test('merge.gate=notify relaxes before_merge (org tier, allowed)', () => {
  const r = resolvePipeline(STANDARD_TEAM, { merge: { enabled: true, gate: 'notify' } });
  assert.equal(r.gates.before_merge.mode, 'notify');
});

test('a dispatch request STILL cannot relax before_merge (invariant preserved)', () => {
  assert.throws(
    () => resolvePipeline(STANDARD_TEAM, {}, { request: { before_merge: { mode: 'auto' } } }),
    GatePolicyError,
  );
});

test('merge on while create_mr off is refused', () => {
  assert.throws(
    () => resolvePipeline(STANDARD_TEAM, { create_mr: { enabled: false, gate: 'auto' }, merge: { enabled: true, gate: 'required' } }),
    PipelineConfigError,
  );
});

test('disabling implement while create_mr is on is refused', () => {
  assert.throws(
    () => resolvePipeline(STANDARD_TEAM, { implement: { enabled: false, gate: 'auto' } }),
    PipelineConfigError,
  );
});

test('create_mr off AND merge off is allowed (plan/implement/test/review only, deliver nothing to SCM)', () => {
  const r = resolvePipeline(STANDARD_TEAM, {
    create_mr: { enabled: false, gate: 'auto' },
    merge: { enabled: false, gate: 'auto' },
  });
  assert.equal(r.team.mergeEnabled, false);
  assert.ok(r.disabledStages.includes('create_mr'));
});

test('skipRoles switches each role stage off for one run', () => {
  for (const [role, stage] of [['planner', 'plan'], ['tester', 'test'], ['reviewer', 'review']] as const) {
    const stages = skipRoles({}, [role]);
    assert.equal(stages[stage]?.enabled, false);
    const r = resolvePipeline(STANDARD_TEAM, stages);
    assert.ok(!r.team.roles.some((x) => x.role === role), `${role} dropped`);
    assert.ok(r.team.roles.some((x) => x.role === 'implementer'));
  }
});

test('skipRoles keeps the stage gate (configured or default)', () => {
  assert.deepEqual(skipRoles({ test: { enabled: true, gate: 'notify' } }, ['tester']).test, { enabled: false, gate: 'notify' });
  assert.deepEqual(skipRoles({}, ['planner']).plan, { enabled: false, gate: 'required' });
});

test('skipping the implementer is refused while a PR is opened', () => {
  assert.throws(() => resolvePipeline(STANDARD_TEAM, skipRoles({}, ['implementer'])), PipelineConfigError);
});

test('skipRoles refuses an unknown role', () => {
  assert.throws(() => skipRoles({}, ['designer']), PipelineConfigError);
});

test('disabledRoles lists the roles the org switched off', () => {
  assert.deepEqual(disabledRoles({ test: { enabled: false, gate: 'auto' }, merge: { enabled: false, gate: 'auto' } }), ['tester']);
  assert.deepEqual(disabledRoles({}), []);
});

test('reviewOnlyStages: only the reviewer runs, nothing is published, the org review gate is kept', () => {
  const stages = reviewOnlyStages({ review: { enabled: true, gate: 'required' }, merge: { enabled: true, gate: 'required' } });
  for (const s of ['plan', 'implement', 'test', 'create_mr', 'merge'] as const) assert.equal(stages[s]?.enabled, false, s);
  assert.deepEqual(stages.review, { enabled: true, gate: 'required' });
  const r = resolvePipeline(STANDARD_TEAM, stages);
  assert.deepEqual(r.team.roles.map((x) => x.role), ['reviewer']);
  assert.equal(r.team.mergeEnabled, false);
  assert.equal(r.gates['after_role:reviewer'].mode, 'required');
});

test('reviewOnlyStages: unconfigured review keeps the default gate', () => {
  assert.deepEqual(reviewOnlyStages({}).review, { enabled: true, gate: 'auto' });
});

test('reviewOnlyStages: refused when the org switched review off', () => {
  assert.throws(() => reviewOnlyStages({ review: { enabled: false, gate: 'auto' } }), PipelineConfigError);
});
