import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFreeModel } from './ollama.js';

// Unit tests for isFreeModel covering various ID patterns and edge cases
test('isFreeModel: Ollama IDs, non-Ollama, empty values, and overrides list', () => {
  // Ollama local ID
  assert.ok(isFreeModel('ollama:gpt-oss:20b'));
  // Ollama Cloud ID
  assert.ok(isFreeModel('ollama-cloud:glm-5.3'));
  // Non-Ollama ID (e.g., Claude) should be false
  assert.equal(isFreeModel('claude-sonnet-5'), false);
  // Null, undefined, and empty string should be false
  assert.equal(isFreeModel(null), false);
  assert.equal(isFreeModel(undefined), false);
  assert.equal(isFreeModel(''), false);
  // ID free because it's included in the override list
  const customId = 'my-custom-model';
  assert.ok(isFreeModel(customId, [customId]));
  // Same ID without the override list should be false
  assert.equal(isFreeModel(customId), false);
});
