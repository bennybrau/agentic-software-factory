import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_TEAM, teamTemplateSchema } from '@asf/shared';
import { createRun } from './store.js';
import { claimTask, finishTask, registerWorker } from './workers.js';
import { putOrgSetting } from '../settings/store.js';
import { dbAvailable, testDb, runInput, drain } from '../test/harness.js';

// M11 WP4: provider-aware claim. A worker reports `<runtime>@<provider>` capabilities;
// an Ollama-model task goes only to `<runtime>@ollama`, any other only to a worker with
// the runtime under a non-Ollama provider. No capabilities = pre-WP4 runtime-only match.

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('claim_provider'); });
after(async () => { if (db) await db.close(); });

/** A team whose planner (the first claimable task) runs on `model`. */
const teamWith = (model: string) => teamTemplateSchema.parse({
  ...STANDARD_TEAM, roles: STANDARD_TEAM.roles.map((r) => (r.role === 'planner' ? { ...r, model } : r)),
});
const CLAUDE_ONLY = ['claude-code@anthropic'];
const OLLAMA_ONLY = ['claude-code@ollama'];

async function worker(id: string) {
  await registerWorker(db.sql, { id, host: 'h', runtimes: ['claude-code'], maxConcurrent: 4, inFlightTaskIds: [] });
}

test('(a) an Ollama-only worker claims an Ollama task; (b) a Claude-only worker never does', { skip }, async () => {
  await drain(db.sql);
  await worker('claude-w'); await worker('ollama-w');
  const { run } = await createRun(db.sql, runInput({ ticketId: 'op1', ticketKey: 'OP-1', team: teamWith('ollama-cloud:gpt-oss:120b') }));
  assert.equal(await claimTask(db.sql, 'claude-w', ['claude-code'], CLAUDE_ONLY), null, 'Claude-only worker skips the Ollama task');
  const c = await claimTask(db.sql, 'ollama-w', ['claude-code'], OLLAMA_ONLY);
  assert.equal(c?.run.id, run.id);
  assert.equal(c?.task.model, 'ollama-cloud:gpt-oss:120b');
});

test('an Ollama-only worker never claims a Claude task; a Claude-only one does', { skip }, async () => {
  await drain(db.sql);
  await worker('claude-w2'); await worker('ollama-w2');
  const { run } = await createRun(db.sql, runInput({ ticketId: 'op2', ticketKey: 'OP-2' }));
  assert.equal(await claimTask(db.sql, 'ollama-w2', ['claude-code'], OLLAMA_ONLY), null);
  assert.equal((await claimTask(db.sql, 'claude-w2', ['claude-code'], CLAUDE_ONLY))?.run.id, run.id);
});

test('a mixed team hands each role to the worker that can serve its provider', { skip }, async () => {
  await drain(db.sql);
  await worker('claude-w3'); await worker('ollama-w3');
  const team = teamTemplateSchema.parse({ ...STANDARD_TEAM, roles: STANDARD_TEAM.roles.map((r) => (r.role === 'implementer' ? { ...r, model: 'ollama:qwen3-coder' } : r)) });
  await createRun(db.sql, runInput({ ticketId: 'op3', ticketKey: 'OP-3', team }));
  const plan = await claimTask(db.sql, 'claude-w3', ['claude-code'], CLAUDE_ONLY);
  assert.equal(plan?.task.role, 'planner');
  await finishTask(db.sql, plan!.task.id, { outcome: 'done', outputRef: 'plan.md', costUsd: 0.1, reason: null });
  assert.equal(await claimTask(db.sql, 'claude-w3', ['claude-code'], CLAUDE_ONLY), null, 'the Ollama implementer is not for the Claude worker');
  const impl = await claimTask(db.sql, 'ollama-w3', ['claude-code'], OLLAMA_ONLY);
  assert.equal(impl?.task.role, 'implementer');
  await finishTask(db.sql, impl!.task.id, { outcome: 'done', outputRef: null, costUsd: 0, reason: null });
  assert.equal(await claimTask(db.sql, 'ollama-w3', ['claude-code'], OLLAMA_ONLY), null, 'the Claude tester is not for the Ollama worker');
  assert.equal((await claimTask(db.sql, 'claude-w3', ['claude-code'], CLAUDE_ONLY))?.task.role, 'tester');
});

test('a worker offering both providers takes either; a pre-WP4 worker (no capabilities) matches by runtime', { skip }, async () => {
  await drain(db.sql);
  await worker('both-w'); await worker('old-w');
  await createRun(db.sql, runInput({ ticketId: 'op4', ticketKey: 'OP-4', team: teamWith('ollama:qwen3-coder') }));
  assert.ok(await claimTask(db.sql, 'both-w', ['claude-code'], ['claude-code@anthropic', 'claude-code@ollama']));
  await drain(db.sql);
  await createRun(db.sql, runInput({ ticketId: 'op5', ticketKey: 'OP-5', team: teamWith('ollama:qwen3-coder') }));
  assert.ok(await claimTask(db.sql, 'old-w', ['claude-code']));
});

test('a catalogue model on an ollama-kind provider without the ollama prefix is still routed to Ollama', { skip }, async () => {
  await drain(db.sql);
  await worker('claude-w6'); await worker('ollama-w6');
  await putOrgSetting(db.sql, 'MODEL_CATALOG_EXTRA', {
    providers: [{ id: 'lan-box', kind: 'ollama', baseUrl: 'http://10.0.0.5:11434' }],
    models: [{ id: 'lan-qwen', label: 'LAN qwen', tier: 'balanced', providerId: 'lan-box', runtimes: ['claude-code'], rate: { inputPerM: 0, outputPerM: 0 } }],
  }, 'test');
  await createRun(db.sql, runInput({ ticketId: 'op6', ticketKey: 'OP-6', team: teamWith('lan-qwen') }));
  assert.equal(await claimTask(db.sql, 'claude-w6', ['claude-code'], CLAUDE_ONLY), null);
  assert.ok(await claimTask(db.sql, 'ollama-w6', ['claude-code'], OLLAMA_ONLY));
});
