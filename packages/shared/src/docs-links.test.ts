import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const docs = [
  'docs/PROVIDERS.md',
  'docs/PIPELINE.md',
  'docs/UPGRADING.md',
  'docs/M12_MULTI_PROVIDER.md',
  'docs/runs/m12-multi-provider-live.md',
];

test('M12 docs: relative links resolve', () => {
  for (const doc of docs) {
    const file = resolve(root, doc);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1]!.split('#')[0]!;
      if (!target || /^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(file), target)), `${doc}: broken link ${m[1]}`);
    }
  }
});

test('M12 docs: PROVIDERS describes several connections, not the stale single-tracker note', () => {
  const text = readFileSync(resolve(root, 'docs/PROVIDERS.md'), 'utf8');
  assert.match(text, /Several connections/);
  assert.doesNotMatch(text, /SCM is deploy-time only/i);
});

test('M12 live-check log is marked pending with placeholders', () => {
  const text = readFileSync(resolve(root, 'docs/runs/m12-multi-provider-live.md'), 'utf8');
  assert.match(text, /pending/i);
  assert.match(text, /<[^>]+>/);
});
