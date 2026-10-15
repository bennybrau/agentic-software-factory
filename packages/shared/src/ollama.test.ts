import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maxContextOf, ollamaCatalogueExtra, ollamaContextFix, ollamaModelId, ollamaSourceUrl, ollamaTier, ollamaVersionAtLeast, parseParamsB } from './ollama.js';

test('parseParamsB: Ollama local (30.5B), Cloud (raw count) and blanks', () => {
  assert.equal(parseParamsB('30.5B'), 30.5);
  assert.equal(parseParamsB('116829156672'), 116.8);
  assert.equal(parseParamsB('270M'), 0.3);
  assert.equal(parseParamsB('1T'), 1000);
  assert.equal(parseParamsB(''), null);
  assert.equal(parseParamsB(undefined), null);
  assert.equal(parseParamsB('big'), null);
});

test('ollamaTier by size; unknown is balanced', () => {
  assert.equal(ollamaTier(3.2), 'fast');
  assert.equal(ollamaTier(30.5), 'balanced');
  assert.equal(ollamaTier(116.8), 'max');
  assert.equal(ollamaTier(null), 'balanced');
});

test('maxContextOf reads <arch>.context_length', () => {
  assert.equal(maxContextOf({ 'qwen3moe.context_length': 262144, 'qwen3moe.embedding_length': 2048 }), 262144);
  assert.equal(maxContextOf({}), null);
  assert.equal(maxContextOf(null), null);
});

test('ollamaVersionAtLeast', () => {
  assert.equal(ollamaVersionAtLeast('0.40.4'), true);
  assert.equal(ollamaVersionAtLeast('0.14.0'), true);
  assert.equal(ollamaVersionAtLeast('0.13.9'), false);
  assert.equal(ollamaVersionAtLeast('v1.0.0-rc1'), true);
  assert.equal(ollamaVersionAtLeast('0.0.0'), false);
});

test('ids, source URLs and the context fix', () => {
  assert.equal(ollamaModelId('local', 'gpt-oss:20b'), 'ollama:gpt-oss:20b');
  assert.equal(ollamaModelId('cloud', 'glm-5.3'), 'ollama-cloud:glm-5.3');
  assert.equal(ollamaSourceUrl('cloud', 'http://evil'), 'https://ollama.com', 'Cloud is pinned whatever OLLAMA_BASE_URL says');
  assert.equal(ollamaSourceUrl('local', 'http://host.docker.internal:11434/v1/'), 'http://host.docker.internal:11434');
  assert.equal(ollamaSourceUrl('local', ' '), null);
  assert.match(ollamaContextFix(4096), /4k context.*64k.*OLLAMA_CONTEXT_LENGTH=65536/s);
});

test('ollamaCatalogueExtra: never writes a non-Ollama id or shadows a built-in; keeps providers', () => {
  const out = ollamaCatalogueExtra([{ id: 'claude-sonnet-5' }, { id: 'gpt-6-sol' }, { id: 'ollama:x', tier: 'fast' }], { providers: [{ id: 'p' }], models: [null, { nope: 1 }] });
  assert.deepEqual(out, { providers: [{ id: 'p' }], models: [{ id: 'ollama:x', label: 'x (Ollama, local)', tier: 'fast', providerId: 'ollama', runtimes: ['claude-code', 'codex'], rate: { inputPerM: 0, outputPerM: 0 } }] });
  assert.deepEqual(ollamaCatalogueExtra([{ id: 'ollama:x' }], undefined).models.length, 1);
});
