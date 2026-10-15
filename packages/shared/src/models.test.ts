import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, DEFAULT_ROLE_MODELS, DEFAULT_ROLE_EFFORT, isKnownModel, isKnownEffort, EFFORT_LEVELS, mergeCatalogue, effectiveCatalogue, parseModelAllowlist, substituteModel, nativeModelId, isOllamaCloud, providerOfModel } from './models.js';
import { STANDARD_TEAM } from './team.js';
import { priceUsage, rateFor } from './pricing.js';
import { resolve, SettingError } from './settings.js';

test('catalogue ids are unique and every one is priced', () => {
  const ids = MODELS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    const usd = priceUsage(id, { inputTokens: 1_000_000, outputTokens: 0 });
    assert.ok(usd !== null && usd > 0, `${id} has no pricing row`);
  }
});

test("default team: Opus 4.8 plans and implements, Sonnet 5 tests and reviews", () => {
  assert.equal(DEFAULT_ROLE_MODELS.planner, 'claude-opus-4-8');
  assert.equal(DEFAULT_ROLE_MODELS.implementer, 'claude-opus-4-8');
  assert.equal(DEFAULT_ROLE_MODELS.tester, 'claude-sonnet-5');
  assert.equal(DEFAULT_ROLE_MODELS.reviewer, 'claude-sonnet-5');
  assert.ok(MODELS.some((m) => m.id === 'claude-opus-4-8' && m.tier === 'max'));
  // Explicit ids only: the bare alias `opus` resolves to Opus 5 in the CLI, not 4.8.
  for (const m of MODELS.filter((x) => x.providerId === 'anthropic')) assert.match(m.id, /^claude-(opus|sonnet|haiku|fable)-\d/);
});

test('effort defaults: high for plan/implement, low for test, medium for review; all valid levels', () => {
  assert.equal(DEFAULT_ROLE_EFFORT.planner, 'high');
  assert.equal(DEFAULT_ROLE_EFFORT.implementer, 'high');
  assert.equal(DEFAULT_ROLE_EFFORT.tester, 'low');
  assert.equal(DEFAULT_ROLE_EFFORT.reviewer, 'medium');
  for (const e of Object.values(DEFAULT_ROLE_EFFORT)) assert.ok(isKnownEffort(e));
  assert.equal(isKnownEffort('turbo'), false);
  assert.deepEqual([...EFFORT_LEVELS], ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('every default is a catalogue model + valid effort, and the standard team carries both', () => {
  for (const [role, id] of Object.entries(DEFAULT_ROLE_MODELS)) {
    assert.ok(isKnownModel(id, MODELS), `${role} default ${id} is not in the catalogue`);
    const tr = STANDARD_TEAM.roles.find((r) => r.role === role);
    assert.ok(tr, `standard team has no ${role}`);
    assert.equal(tr.model, id, `standard team ${role} should default to ${id}`);
    assert.equal(tr.effort, DEFAULT_ROLE_EFFORT[role as keyof typeof DEFAULT_ROLE_EFFORT], `standard team ${role} effort should match`);
  }
  assert.equal(isKnownModel('claude-opus-5', MODELS), false);
});

test('tiers order from cheapest to strongest', () => {
  const tiers = (provider: string) => MODELS.filter((m) => m.providerId === provider).map((m) => m.tier);
  assert.deepEqual(tiers('anthropic'), ['fast', 'balanced', 'max', 'max', 'max']);
  assert.deepEqual(tiers('openai'), ['fast', 'balanced', 'max']);
});

test('Opus 5.5 is selectable and priced', () => {
  assert.ok(MODELS.some((m) => m.id === 'claude-opus-5-5' && m.tier === 'max'));
  assert.equal(isKnownModel('claude-opus-5-5', MODELS), true);
  assert.equal(priceUsage('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 90);
});

test('Fable 5.1 is selectable and priced', () => {
  assert.ok(MODELS.some((m) => m.id === 'claude-fable-5-1' && m.tier === 'max'));
  assert.equal(isKnownModel('claude-fable-5-1', MODELS), true);
  assert.equal(priceUsage('claude-fable-5-1', { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 60);
});

test('built-ins: Anthropic models run on claude-code, OpenAI models on codex, OpenCode drives both, each carrying its own rate', () => {
  const runtimeFor: Record<string, string> = { anthropic: 'claude-code', openai: 'codex' };
  for (const m of MODELS) {
    assert.ok(runtimeFor[m.providerId], `${m.id} has an unexpected provider ${m.providerId}`);
    assert.deepEqual(m.runtimes.filter((r) => r !== 'copilot'), [runtimeFor[m.providerId], 'opencode']);
    assert.ok(m.rate, `${m.id} has no rate`);
  }
  assert.deepEqual(MODELS.filter((m) => m.runtimes.includes('copilot')).map((m) => m.id), ['claude-sonnet-5', 'gpt-6-sol']);
});

test('OpenAI built-ins are priced from the published list (per 1M: input / cached / output)', () => {
  // GPT-6 Sol: $2 in, $0.20 cached, $10 out.
  assert.equal(priceUsage('gpt-6-sol', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }), 12.2);
  assert.equal(priceUsage('gpt-6-luna', { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 0.6);
  assert.equal(priceUsage('gpt-6-astra', { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 60);
});

const deepseek = { id: 'deepseek-chat', providerId: 'deepseek', tier: 'balanced', runtimes: ['codex'], rate: { inputPerM: 0.27, outputPerM: 1.1 } };

test('mergeCatalogue adds an extra model and provider, labelling it by id', () => {
  const c = mergeCatalogue({ providers: [{ id: 'deepseek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com' }], models: [deepseek] });
  assert.equal(c.models.length, MODELS.length + 1);
  const m = c.models.find((x) => x.id === 'deepseek-chat')!;
  assert.equal(m.label, 'deepseek-chat');
  assert.deepEqual(m.runtimes, ['codex']);
  assert.ok(c.providers.some((p) => p.id === 'anthropic'));
  assert.ok(c.providers.some((p) => p.id === 'deepseek' && p.kind === 'openai-compatible'));
  assert.ok(isKnownModel('deepseek-chat', c.models));
  assert.equal(isKnownModel('deepseek-chat', MODELS), false, 'the built-in list is not mutated');
});

test('mergeCatalogue: an extra entry with a built-in id replaces it', () => {
  const c = mergeCatalogue({ models: [{ id: 'claude-sonnet-5', label: 'Sonnet via codex', tier: 'balanced', providerId: 'anthropic', runtimes: ['claude-code', 'codex'] }] });
  assert.equal(c.models.length, MODELS.length);
  const m = c.models.find((x) => x.id === 'claude-sonnet-5')!;
  assert.equal(m.label, 'Sonnet via codex');
  assert.deepEqual(m.runtimes, ['claude-code', 'codex']);
  assert.deepEqual(mergeCatalogue({}).models, MODELS);
  assert.deepEqual(mergeCatalogue(undefined).models, MODELS);
});

test('MODEL_CATALOG_EXTRA rejects a bad shape by name, accepts a good one', () => {
  assert.throws(() => resolve('MODEL_CATALOG_EXTRA', {}, { MODEL_CATALOG_EXTRA: { models: [{ id: 'x', tier: 'huge', providerId: 'p', runtimes: [] }] } }),
    (e: unknown) => e instanceof SettingError && /MODEL_CATALOG_EXTRA/.test(e.message) && /tier|runtimes/.test(e.message));
  assert.throws(() => resolve('MODEL_CATALOG_EXTRA', {}, { MODEL_CATALOG_EXTRA: { models: 'nope' } }), SettingError);
  assert.throws(() => resolve('MODEL_CATALOG_EXTRA', { MODEL_CATALOG_EXTRA: '{}' }, {}), SettingError, 'org-only: not settable from env');
  assert.deepEqual(resolve('MODEL_CATALOG_EXTRA', {}, { MODEL_CATALOG_EXTRA: { models: [deepseek] } }), { models: [deepseek] });
});

test('MODEL_DEFAULT_<ROLE> is a free string now (validated against the merged catalogue at dispatch)', () => {
  assert.equal(resolve('MODEL_DEFAULT_PLANNER', {}, { MODEL_DEFAULT_PLANNER: 'deepseek-chat' }), 'deepseek-chat');
  assert.equal(resolve('RUNTIME_DEFAULT_PLANNER'), 'claude-code');
});

test('rateFor prices an extra model from its catalogue rate', () => {
  const { models } = mergeCatalogue({ models: [deepseek] });
  assert.deepEqual(rateFor('deepseek-chat', models), deepseek.rate);
  assert.equal(rateFor('deepseek-chat'), null, 'unpriced against the built-ins alone');
  assert.equal(priceUsage('deepseek-chat', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, models), 0.27 + 1.1);
});

test('MODEL_ALLOWLIST: blank means no list; ids split on commas and whitespace', () => {
  assert.equal(parseModelAllowlist(''), null);
  assert.equal(parseModelAllowlist('  ,  '), null);
  assert.equal(parseModelAllowlist(undefined), null);
  assert.deepEqual([...parseModelAllowlist('claude-sonnet-5, claude-haiku-4-5@20251001\nclaude-opus-5[1m]')!], ['claude-sonnet-5', 'claude-haiku-4-5@20251001', 'claude-opus-5[1m]']);
});

test('effectiveCatalogue: a Vertex org adds its own ids and the allowlist hides the rest', () => {
  const extra = { models: [{ id: 'claude-haiku-4-5@20251001', tier: 'fast', providerId: 'anthropic', runtimes: ['claude-code'] }] };
  assert.deepEqual(effectiveCatalogue(extra, '').models.map((m) => m.id), mergeCatalogue(extra).models.map((m) => m.id), 'no allowlist = the merged catalogue');
  const cat = effectiveCatalogue(extra, 'claude-sonnet-5,claude-haiku-4-5@20251001,claude-not-in-catalogue');
  assert.deepEqual(cat.models.map((m) => m.id).sort(), ['claude-haiku-4-5@20251001', 'claude-sonnet-5'], 'an allowlisted id missing from the catalogue is ignored, not invented');
  assert.equal(cat.models.find((m) => m.id === 'claude-haiku-4-5@20251001')!.label, 'claude-haiku-4-5@20251001');
  assert.ok(cat.providers.some((p) => p.id === 'openai'), 'providers are not filtered');
});

test('substituteModel: same tier first, then the nearest; only models the runtime can drive', () => {
  const vertex = mergeCatalogue({ models: [
    { id: 'claude-haiku-4-5@20251001', tier: 'fast', providerId: 'anthropic', runtimes: ['claude-code'] },
    { id: 'claude-opus-5-5', tier: 'max', providerId: 'anthropic', runtimes: ['claude-code'] },
  ] }).models.filter((m) => ['claude-haiku-4-5@20251001', 'claude-sonnet-5', 'claude-opus-5-5'].includes(m.id));
  assert.equal(substituteModel('claude-opus-4-8', 'claude-code', vertex), 'claude-opus-5-5');
  assert.equal(substituteModel('claude-haiku-4-5', 'claude-code', vertex), 'claude-haiku-4-5@20251001');
  assert.equal(substituteModel('claude-sonnet-5', 'claude-code', vertex), 'claude-sonnet-5', 'runnable = kept');
  assert.equal(substituteModel('gpt-6-astra', 'codex', vertex), null, 'nothing runs on codex');
  assert.equal(substituteModel('claude-opus-4-8', 'claude-code', vertex.filter((m) => m.tier === 'fast')), 'claude-haiku-4-5@20251001');
});

test('allowlist entries lose surrounding quotes', () => {
  assert.deepEqual([...parseModelAllowlist('"claude-sonnet-5", \'claude-opus-5[1m]\'')!], ['claude-sonnet-5', 'claude-opus-5[1m]']);
});

test('M11: Ollama providers are built in; ids are namespaced and stripped on the first colon only', () => {
  const cat = mergeCatalogue({ models: [
    { id: 'ollama:gpt-oss:20b', tier: 'fast', providerId: 'ollama', runtimes: ['claude-code'] },
    { id: 'ollama-cloud:glm-5.3', tier: 'max', providerId: 'ollama-cloud', runtimes: ['claude-code', 'codex'] },
  ] });
  const local = providerOfModel(cat, 'ollama:gpt-oss:20b');
  const cloud = providerOfModel(cat, 'ollama-cloud:glm-5.3');
  assert.deepEqual(local, { id: 'ollama', kind: 'ollama' });
  assert.equal(cloud?.baseUrl, 'https://ollama.com');
  assert.equal(nativeModelId('ollama:gpt-oss:20b', local), 'gpt-oss:20b');
  assert.equal(nativeModelId('ollama-cloud:glm-5.3', cloud), 'glm-5.3');
  assert.equal(nativeModelId('gpt-oss:20b', local), 'gpt-oss:20b', 'an un-prefixed id is passed through');
  assert.equal(nativeModelId('claude-sonnet-5', providerOfModel(cat, 'claude-sonnet-5')), 'claude-sonnet-5');
  assert.equal(nativeModelId('ollama:x', undefined), 'ollama:x', 'unknown provider: untouched');
  assert.equal(providerOfModel(cat, 'nope'), undefined);
  assert.equal(isOllamaCloud('https://ollama.com'), true);
  assert.equal(isOllamaCloud('https://ollama.com/'), true);
  assert.equal(isOllamaCloud('https://ollama.com.evil.example'), false);
  assert.equal(isOllamaCloud('http://ollama.com'), false, 'never over plain http');
  assert.equal(isOllamaCloud('http://localhost:11434'), false);
  assert.equal(isOllamaCloud(undefined), false);
  assert.equal(isOllamaCloud('not a url'), false);
});
