import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSpawn } from '@asf/shared';
import { buildCopilotArgs, copilotOutcome, CopilotRuntime } from './copilot.js';
import { needsHeartbeat, policyFor } from '../segment.js';

const spawn = (over: Partial<AgentSpawn> = {}): AgentSpawn => ({
  role: 'implementer', prompt: 'do it', cwd: '/wt', maxCostUsd: 15, policy: policyFor(true),
  env: { ASF_RUN_DIR: '/runs/r1', ASF_TASK_ID: 't1' }, auth: { providerKind: 'github', mode: 'gh-token', credential: 'k' }, timeoutMs: 1000, ...over,
});

test('argv golden: headless, all tools allowed, git push denied, run dir added, model last', () => {
  assert.deepEqual(buildCopilotArgs(spawn({ model: 'claude-sonnet-5' })), [
    '-p', 'do it', '--silent', '--no-color', '--allow-all-tools', '--deny-tool', 'shell(git push)',
    '--add-dir', '/runs/r1', '--model', 'claude-sonnet-5',
  ]);
});

test('argv: a policy without shell/network excludes those tools', () => {
  const args = buildCopilotArgs(spawn({ policy: { fileWrite: 'run-dir-only', shell: false, network: false, gitPush: false } }));
  assert.ok(args.includes('--excluded-tools=shell,web_fetch'));
  assert.ok(!args.includes('--model'), 'no model = the CLI default');
});

test('outcome: text is the reply (NEEDS_HUMAN protocol applies); a non-zero exit fails with stderr; always unpriced', () => {
  assert.deepEqual(copilotOutcome(0, 'All done.\n', ''), { outcome: 'done', text: 'All done.', terminalReason: 'exit 0', usage: null, costUsd: null });
  const nh = copilotOutcome(0, 'Read it.\nNEEDS_HUMAN: which branch?\n', '');
  assert.equal(nh.outcome, 'needs_human');
  assert.equal(nh.text, 'which branch?');
  const failed = copilotOutcome(1, '', 'Error: No authentication information found.\n');
  assert.equal(failed.outcome, 'failed');
  assert.match(failed.text, /No authentication/);
  assert.equal(copilotOutcome(0, '  \n', '').outcome, 'failed', 'an empty reply is not success');
});

test('capabilities: silent (heartbeat), unpriced, cannot confine its own writes', () => {
  const caps = new CopilotRuntime().capabilities;
  assert.deepEqual(caps, { toolHooks: false, eventStream: false, reportsCost: false, listsModels: false, confinesWrites: false });
  assert.equal(needsHeartbeat(caps), true);
});

test('argv: the read-only copies dir is added after the run dir when there are copies', () => {
  const args = buildCopilotArgs(spawn({ env: { ASF_RUN_DIR: '/runs/r1', ASF_REFS_DIR: '/wt/refs/r1/t1' } }));
  assert.deepEqual(args.slice(args.indexOf('--add-dir')), ['--add-dir', '/runs/r1', '--add-dir', '/wt/refs/r1/t1']);
});
