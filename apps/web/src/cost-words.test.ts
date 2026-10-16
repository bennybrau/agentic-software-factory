import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCostText, taskCostText } from './cost-words';

test('an Ollama task at $0 reads as free; anything else as dollars', () => {
  assert.equal(taskCostText({ costUsd: 0, model: 'ollama-cloud:gpt-oss:120b' }), 'free (Ollama)');
  assert.equal(taskCostText({ costUsd: 0, model: 'ollama:qwen3-coder' }), 'free (Ollama)');
  assert.equal(taskCostText({ costUsd: 0, model: 'claude-sonnet-5' }), '$0.00', 'a $0 Claude task is unpriced, not free');
  assert.equal(taskCostText({ costUsd: 0.2041, model: 'claude-opus-5-5' }, 4), '$0.2041');
});

test('the run header: an all-Ollama run is free; a mixed one notes its free jobs', () => {
  const run = { costUsd: 0, maxCostUsd: 2 };
  const pub = { costUsd: 0, model: null, runtime: 'publish' };
  const o = (m = 'ollama-cloud:gpt-oss:120b') => ({ costUsd: 0, model: m, runtime: 'claude-code' });
  assert.equal(runCostText(run, [o(), o(), pub]), 'free (Ollama) / $2');
  assert.equal(runCostText({ costUsd: 0.48, maxCostUsd: 3 }, [{ costUsd: 0.2, model: 'claude-opus-5-5', runtime: 'claude-code' }, o(), pub]), '$0.48 / $3 · Ollama jobs free');
  assert.equal(runCostText({ costUsd: 1.5, maxCostUsd: 20 }, [{ costUsd: 1.5, model: 'claude-opus-5-5', runtime: 'claude-code' }]), '$1.50 / $20');
  assert.equal(runCostText(run, []), '$0.00 / $2', 'nothing ran yet');
});
