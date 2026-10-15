import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_TEAM, mergeCatalogue } from '@asf/shared';
import { resolveRoleModels, defaultRoleModels, applyRoleSkills, catalogue, BadModelError, BadEffortError } from './models.js';

const org = { planner: 'claude-fable-5-1' };

test('template defaults apply when nothing overrides', () => {
  const team = resolveRoleModels(STANDARD_TEAM, {}, undefined);
  assert.equal(team.roles.find((r) => r.role === 'planner')!.model, 'claude-opus-4-8');
  assert.equal(team.roles.find((r) => r.role === 'tester')!.model, 'claude-sonnet-5');
  // effort defaults ride along with the template too
  assert.equal(team.roles.find((r) => r.role === 'planner')!.effort, 'high');
  assert.equal(team.roles.find((r) => r.role === 'tester')!.effort, 'low');
});

test('org setting beats the template; request beats the org', () => {
  const viaOrg = resolveRoleModels(STANDARD_TEAM, org, undefined);
  assert.equal(viaOrg.roles.find((r) => r.role === 'planner')!.model, 'claude-fable-5-1');
  const viaRequest = resolveRoleModels(STANDARD_TEAM, org, { planner: 'claude-haiku-4-5' });
  assert.equal(viaRequest.roles.find((r) => r.role === 'planner')!.model, 'claude-haiku-4-5');
  // untouched roles keep their defaults
  assert.equal(viaRequest.roles.find((r) => r.role === 'implementer')!.model, 'claude-opus-4-8');
});

test('effort resolves request > org > template, and an unknown level is refused', () => {
  const viaOrg = resolveRoleModels(STANDARD_TEAM, {}, undefined, { reviewer: 'xhigh' }, undefined);
  assert.equal(viaOrg.roles.find((r) => r.role === 'reviewer')!.effort, 'xhigh');
  const viaReq = resolveRoleModels(STANDARD_TEAM, {}, undefined, { reviewer: 'xhigh' }, { reviewer: 'low' });
  assert.equal(viaReq.roles.find((r) => r.role === 'reviewer')!.effort, 'low');
  assert.throws(() => resolveRoleModels(STANDARD_TEAM, {}, undefined, {}, { tester: 'turbo' }), (e: unknown) =>
    e instanceof BadEffortError && /tester/.test(e.message) && /turbo/.test(e.message));
});

test('a Fable 5.1 override is accepted', () => {
  const team = resolveRoleModels(STANDARD_TEAM, {}, { planner: 'claude-fable-5-1' });
  assert.equal(team.roles.find((r) => r.role === 'planner')!.model, 'claude-fable-5-1');
});

test('an unknown model id is refused, naming the role and the id', () => {
  assert.throws(() => resolveRoleModels(STANDARD_TEAM, {}, { tester: 'gpt-9' }), (e: unknown) =>
    e instanceof BadModelError && /tester/.test(e.message) && /gpt-9/.test(e.message));
  // Aliases are rejected too: `opus` would silently mean Opus 5.
  assert.throws(() => resolveRoleModels(STANDARD_TEAM, {}, { planner: 'opus' }), BadModelError);
});

test('does not mutate the shared template', () => {
  const before = JSON.stringify(STANDARD_TEAM);
  resolveRoleModels(STANDARD_TEAM, org, { reviewer: 'claude-opus-4-8' });
  assert.equal(JSON.stringify(STANDARD_TEAM), before);
});

test('applyRoleSkills sets per-run skill, trims, blanks to null, and never mutates the template', () => {
  const before = JSON.stringify(STANDARD_TEAM);
  const team = applyRoleSkills(STANDARD_TEAM, { implementer: '  small diffs  ', tester: '' });
  assert.equal(team.roles.find((r) => r.role === 'implementer')!.skill, 'small diffs');
  assert.equal(team.roles.find((r) => r.role === 'tester')!.skill, null, 'blank clears to null');
  assert.equal(team.roles.find((r) => r.role === 'planner')!.skill, null, 'untouched role keeps default null');
  assert.equal(JSON.stringify(STANDARD_TEAM), before, 'shared template is not mutated');
});

test('applyRoleSkills with no request returns the team unchanged', () => {
  const team = applyRoleSkills(STANDARD_TEAM, undefined);
  assert.equal(team, STANDARD_TEAM);
});

// --- M8 WP D: the (runtime, model) pair, validated against the merged catalogue ---
const { models } = mergeCatalogue({ models: [
  { id: 'deepseek-chat', providerId: 'deepseek', tier: 'balanced', runtimes: ['codex', 'hermes'] },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', tier: 'balanced', providerId: 'anthropic', runtimes: ['claude-code', 'codex'] },
] });
const role = (t: ReturnType<typeof resolveRoleModels>, r: string) => t.roles.find((x) => x.role === r)!;

test('catalogue() is the built-ins when MODEL_CATALOG_EXTRA is unset', () => {
  assert.ok(catalogue().models.some((m) => m.id === 'claude-opus-4-8'));
  assert.ok(!catalogue().models.some((m) => m.id === 'deepseek-chat'));
});

test('runtime resolves request > org > template', () => {
  const tmpl = resolveRoleModels(STANDARD_TEAM, {}, undefined, {}, undefined, { models });
  assert.equal(role(tmpl, 'tester').runtime, 'claude-code');
  const viaOrg = resolveRoleModels(STANDARD_TEAM, { tester: 'deepseek-chat' }, undefined, {}, undefined, { models, org: { tester: 'codex' } });
  assert.equal(role(viaOrg, 'tester').runtime, 'codex');
  const viaReq = resolveRoleModels(STANDARD_TEAM, { tester: 'deepseek-chat' }, undefined, {}, undefined, { models, org: { tester: 'codex' }, request: { tester: 'hermes' } });
  assert.equal(role(viaReq, 'tester').runtime, 'hermes');
  assert.equal(role(viaReq, 'planner').runtime, 'claude-code', 'untouched roles keep the template runtime');
});

test('a model that does not list the runtime is refused, naming both', () => {
  // Template model claude-opus-4-8 is claude-code only.
  assert.throws(() => resolveRoleModels(STANDARD_TEAM, {}, undefined, {}, undefined, { models, request: { planner: 'codex' } }), (e: unknown) =>
    e instanceof BadModelError && /planner/.test(e.message) && /claude-opus-4-8/.test(e.message) && /codex/.test(e.message));
  // An extra model on the default claude-code runtime.
  assert.throws(() => resolveRoleModels(STANDARD_TEAM, {}, { reviewer: 'deepseek-chat' }, {}, undefined, { models }), BadModelError);
  // A pair both sides agree on is fine, and a replaced built-in picks up its new runtimes.
  const ok = resolveRoleModels(STANDARD_TEAM, {}, { reviewer: 'claude-sonnet-5' }, {}, undefined, { models, request: { reviewer: 'codex' } });
  assert.equal(role(ok, 'reviewer').model, 'claude-sonnet-5');
  assert.equal(role(ok, 'reviewer').runtime, 'codex');
});

test('MODEL_DEFAULT_<ROLE> may name an extra model; an unknown one is refused', () => {
  const d = defaultRoleModels(STANDARD_TEAM, { implementer: 'deepseek-chat' }, {}, { models, org: { implementer: 'codex' } });
  assert.equal(d.models.implementer, 'deepseek-chat');
  assert.equal(d.runtimes.implementer, 'codex');
  assert.throws(() => defaultRoleModels(STANDARD_TEAM, { implementer: 'deepseek-chat' }, {}, {}), BadModelError, 'not in the built-in catalogue');
});

test('MODEL_ALLOWLIST narrows the catalogue and refuses an unlisted model by name', () => {
  const before = process.env.MODEL_ALLOWLIST;
  process.env.MODEL_ALLOWLIST = 'claude-opus-4-8, claude-sonnet-5';
  try {
    assert.deepEqual(catalogue().models.map((m) => m.id).sort(), ['claude-opus-4-8', 'claude-sonnet-5']);
    assert.equal(resolveRoleModels(STANDARD_TEAM, {}, undefined).roles.find((r) => r.role === 'tester')!.model, 'claude-sonnet-5');
    assert.throws(() => resolveRoleModels(STANDARD_TEAM, {}, { tester: 'claude-haiku-4-5' }), (e: Error) =>
      e instanceof BadModelError && /not on this factory's allowed model list/.test(e.message) && /claude-sonnet-5/.test(e.message) && !/haiku/.test(e.message.split('choose one of')[1]));
    assert.throws(() => resolveRoleModels(STANDARD_TEAM, {}, { tester: 'claude-nope' }), /unknown model "claude-nope"/);
  } finally {
    if (before === undefined) delete process.env.MODEL_ALLOWLIST; else process.env.MODEL_ALLOWLIST = before;
  }
});

test('a template default hidden by MODEL_ALLOWLIST falls back to an allowed model of the same tier', () => {
  const before = process.env.MODEL_ALLOWLIST;
  process.env.MODEL_ALLOWLIST = 'claude-haiku-4-5, claude-sonnet-5';
  try {
    // fresh install: no MODEL_DEFAULT_<ROLE>; template = opus-4-8 (max) for plan/implement
    const team = resolveRoleModels(STANDARD_TEAM, {}, undefined);
    const m = (role: string) => team.roles.find((r) => r.role === role)!.model;
    assert.equal(m('planner'), 'claude-sonnet-5', 'max -> nearest allowed tier (balanced)');
    assert.equal(m('implementer'), 'claude-sonnet-5');
    assert.equal(m('tester'), 'claude-sonnet-5', 'an allowed template default is kept');
    // an override for one role leaves the others substituted, not failing
    assert.equal(resolveRoleModels(STANDARD_TEAM, {}, { tester: 'claude-haiku-4-5' }).roles.find((r) => r.role === 'tester')!.model, 'claude-haiku-4-5');
    // an explicit org pick is never substituted
    assert.throws(() => resolveRoleModels(STANDARD_TEAM, { planner: 'claude-opus-4-8' }, undefined), /not on this factory's allowed model list/);
    assert.doesNotThrow(() => defaultRoleModels(STANDARD_TEAM, {}, {}));
  } finally {
    if (before === undefined) delete process.env.MODEL_ALLOWLIST; else process.env.MODEL_ALLOWLIST = before;
  }
});

test('an allowlist that matches nothing refuses with a clear reason, not a TypeError', () => {
  const before = process.env.MODEL_ALLOWLIST;
  process.env.MODEL_ALLOWLIST = 'typo-model';
  try {
    assert.throws(() => defaultRoleModels(STANDARD_TEAM, {}, {}), (e: Error) => e instanceof BadModelError && /no allowed model can run the planner step/.test(e.message) && /MODEL_DEFAULT_PLANNER/.test(e.message));
  } finally {
    if (before === undefined) delete process.env.MODEL_ALLOWLIST; else process.env.MODEL_ALLOWLIST = before;
  }
});

test('M11: a mixed team — an Ollama model for the implementer, Claude for the rest', () => {
  const models = mergeCatalogue({ models: [
    { id: 'ollama:qwen3-coder', tier: 'balanced', providerId: 'ollama', runtimes: ['claude-code', 'codex'], rate: { inputPerM: 0, outputPerM: 0 } },
  ] }).models;
  const team = resolveRoleModels(STANDARD_TEAM, {}, { implementer: 'ollama:qwen3-coder' }, {}, undefined, { models });
  assert.equal(role(team, 'implementer').model, 'ollama:qwen3-coder');
  assert.equal(role(team, 'implementer').runtime, 'claude-code');
  assert.equal(role(team, 'planner').model, 'claude-opus-4-8');
  assert.equal(role(team, 'tester').model, 'claude-sonnet-5');
  const viaCodex = resolveRoleModels(STANDARD_TEAM, {}, { implementer: 'ollama:qwen3-coder' }, {}, undefined, { models, request: { implementer: 'codex' } });
  assert.equal(role(viaCodex, 'implementer').runtime, 'codex');
  assert.throws(() => resolveRoleModels(STANDARD_TEAM, {}, { implementer: 'ollama:qwen3-coder' }, {}, undefined, { models, request: { implementer: 'opencode' } }), BadModelError);
});
