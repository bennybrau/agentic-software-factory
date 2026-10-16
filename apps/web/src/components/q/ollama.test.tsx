import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OllamaModel } from '@asf/shared/ui';
import type { SettingsStore } from './ui';
import { LATER, aiQ } from './questions';
import { checkRow, modelNote } from './ollama';

const store: SettingsStore = { byKey: {}, loaded: true, err: null, saveMany: async () => null, reload: () => {} };
const withSettings = (v: Record<string, unknown>): SettingsStore =>
  ({ ...store, byKey: Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { key: k, value, orgValue: value, tiers: ['env', 'org'] }])) as never });
const ollamaQ = LATER.find((q) => q.id === 'ollama')!;
const model = (over: Partial<OllamaModel> = {}): OllamaModel => ({
  id: 'ollama:qwen3-coder', name: 'qwen3-coder', source: 'local', sizeBytes: 18_600_000_000, paramsB: 30.5,
  maxContext: 262_144, capabilities: ['completion', 'tools'], tools: true, tier: 'balanced', ...over,
});

test('the Ollama question sits right before the per-role models question', () => {
  const ids = LATER.map((q) => q.id);
  assert.equal(ids.indexOf('ollama') + 1, ids.indexOf('models'));
});

test('a fresh Ollama question: a server address, a Cloud key, and no lists until something is set', () => {
  const html = renderToStaticMarkup(<ollamaQ.Body store={store} actions={() => null} />);
  assert.match(html, /Ollama server address/);
  assert.match(html, /placeholder="http:\/\/host\.docker\.internal:11434"/);
  assert.match(html, /OLLAMA_HOST=0\.0\.0\.0/);
  assert.match(html, /Ollama Cloud key/);
  assert.ok(!html.includes('Find models on this server') && !html.includes('Find my Cloud models'));
  assert.match(renderToStaticMarkup(<>{ollamaQ.summary(store.byKey)}</>), /Not set up/);
});

test('with a server and a Cloud key saved, both lists are offered', () => {
  const s = withSettings({ OLLAMA_BASE_URL: 'http://host.docker.internal:11434', OLLAMA_API_KEY: '[redacted]' });
  const html = renderToStaticMarkup(<ollamaQ.Body store={s} actions={() => null} />);
  assert.match(html, /Find models on this server/);
  assert.match(html, /Find my Cloud models/);
  assert.match(renderToStaticMarkup(<>{ollamaQ.summary(s.byKey)}</>), /server at http:\/\/host\.docker\.internal:11434 · Ollama Cloud key saved/);
});

test('modelNote: size and context; a model without tools or with a small context is flagged', () => {
  assert.deepEqual(modelNote(model()), { text: '30.5B · 19 GB · 262k context', warn: false });
  assert.equal(modelNote(model({ tools: false })).warn, true);
  assert.match(modelNote(model({ tools: false })).text, /can’t call tools/);
  assert.match(modelNote(model({ maxContext: 32_768 })).text, /too small: jobs need 64k/);
});

test('checkRow: a pass shows the effective context; a fail shows the api’s reason (with its fix)', () => {
  assert.deepEqual(checkRow({ ok: true, source: 'local', model: 'qwen3-coder', version: '0.40.4', effectiveContext: 65_536, maxContext: 262_144, reply: 'ok' }), { state: 'ok', note: 'works · 66k context' });
  const fix = 'This model runs with 4k of context; jobs need 64k. Set OLLAMA_CONTEXT_LENGTH=65536 and restart Ollama.';
  assert.deepEqual(checkRow({ ok: false, source: 'local', model: 'm', code: 'context_too_small', reason: fix }), { state: 'bad', reason: fix });
});

test('the AI summary reads a Claude + Ollama team as mixed', () => {
  const s = withSettings({ MODEL_DEFAULT_PLANNER: 'claude-opus-4-8', MODEL_DEFAULT_IMPLEMENTER: 'ollama-cloud:gpt-oss:120b', MODEL_DEFAULT_TESTER: 'claude-sonnet-5', MODEL_DEFAULT_REVIEWER: 'claude-sonnet-5', AGENT_AUTH_MODE: 'api-key' });
  assert.match(renderToStaticMarkup(<>{aiQ.summary(s.byKey)}</>), /Mixed: Claude \+ Ollama/);
});

test('the per-role picker groups models by AI', () => {
  const modelsQ = LATER.find((q) => q.id === 'models')!;
  const html = renderToStaticMarkup(<modelsQ.Body store={withSettings({ MODEL_DEFAULT_PLANNER: 'claude-sonnet-5', RUNTIME_DEFAULT_PLANNER: 'claude-code' })} actions={() => null} />);
  assert.match(html, /<optgroup label="Claude">/);
  assert.match(html, /<optgroup label="OpenAI">/, 'every model is offered; picking one moves the role to a runtime that drives it');
});
