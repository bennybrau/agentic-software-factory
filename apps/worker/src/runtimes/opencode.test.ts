import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSpawn } from '@asf/shared';
import { buildOpencodeArgs, opencodeConfig, opencodePermissions, parseOpencodeStream, OpencodeRuntime } from './opencode.js';
import { policyFor } from '../segment.js';

const jsonl = (...events: object[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const ev = (type: string, part: object = {}) => ({ type, timestamp: 1, sessionID: 'ses_1', part });
const stepFinish = (input: number, output: number, read = 0, write = 0, reasoning = 0) =>
  ev('step_finish', { type: 'step-finish', reason: 'stop', cost: 0.01, tokens: { input, output, reasoning, cache: { read, write } } });
const text = (t: string) => ev('text', { type: 'text', text: t });
const tool = (name: string, state: object) => ev('tool_use', { type: 'tool', tool: name, state });

const spawn = (over: Partial<AgentSpawn> = {}): AgentSpawn => ({
  role: 'implementer', prompt: 'do it', cwd: '/wt', maxCostUsd: 15, policy: policyFor(true),
  env: { ASF_RUN_DIR: '/runs/r1', ASF_TASK_ID: 't1' }, auth: { providerKind: 'openai', mode: 'api-key', credential: 'k' }, timeoutMs: 1000, ...over,
});

test('argv: provider/model from the task auth, the role\'s agent, --dir; the prompt is not on argv', () => {
  const args = buildOpencodeArgs(spawn({ model: 'gpt-6-sol' }));
  assert.deepEqual(args, ['run', '--format', 'json', '-m', 'openai/gpt-6-sol', '--agent', 'asf-writer', '--dir', '/wt']);
  assert.ok(!args.includes('do it'));
  const reader = buildOpencodeArgs(spawn({ role: 'reviewer', policy: policyFor(false), model: 'claude-sonnet-5', auth: { providerKind: 'anthropic', mode: 'api-key' } }));
  assert.deepEqual(reader, ['run', '--format', 'json', '-m', 'anthropic/claude-sonnet-5', '--agent', 'asf-reader', '--dir', '/wt']);
  const compat = buildOpencodeArgs(spawn({ model: 'deepseek-chat', auth: { providerKind: 'openai-compatible', mode: 'api-key', baseUrl: 'https://api.deepseek.com/v1' } }));
  assert.deepEqual(compat.slice(3, 5), ['-m', 'asf/deepseek-chat']);
});

test('permission map golden: allow/deny only, a reader edits only the run dir, git push always denied', () => {
  assert.deepEqual(opencodePermissions(policyFor(true), '/runs/r1'), {
    read: 'allow',
    edit: 'allow',
    bash: { '*': 'allow', 'git push': 'deny', 'git push *': 'deny' },
    webfetch: 'allow',
    websearch: 'allow',
    external_directory: { '*': 'deny', '/runs/r1/**': 'allow' },
    task: 'deny',
    doom_loop: 'deny',
  });
  assert.deepEqual(opencodePermissions({ fileWrite: 'run-dir-only', shell: false, network: false, gitPush: false }, '/runs/r1'), {
    read: 'allow',
    edit: { '*': 'deny', '/runs/r1/**': 'allow' },
    bash: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    external_directory: { '*': 'deny', '/runs/r1/**': 'allow' },
    task: 'deny',
    doom_loop: 'deny',
  });
  // Never `ask`: nobody answers under `opencode run`.
  const flat = JSON.stringify([opencodePermissions(policyFor(true), '/r'), opencodePermissions(policyFor(false), '/r')]);
  assert.ok(!flat.includes('"ask"'));
});

test('generated config: both agents; a compat provider references its key by env name, never the value', () => {
  const cfg = opencodeConfig(spawn({ model: 'deepseek-chat', auth: { providerKind: 'openai-compatible', mode: 'api-key', credential: 'shh-dont-tell', baseUrl: 'https://api.deepseek.com/v1' } }), '/runs/r1');
  const agents = cfg.agent as Record<string, { mode: string; permission: Record<string, unknown> }>;
  assert.deepEqual(Object.keys(agents), ['asf-writer', 'asf-reader']);
  assert.equal(agents['asf-writer'].permission.edit, 'allow');
  assert.deepEqual(agents['asf-reader'].permission.edit, { '*': 'deny', '/runs/r1/**': 'allow' });
  const asf = (cfg.provider as Record<string, { options: Record<string, string>; models: Record<string, unknown> }>).asf;
  assert.equal(asf.options.baseURL, 'https://api.deepseek.com/v1');
  assert.match(asf.options.apiKey, /^\{env:[A-Z_]+\}$/);
  assert.deepEqual(Object.keys(asf.models), ['deepseek-chat']);
  assert.ok(!JSON.stringify(cfg).includes('shh-dont-tell'), 'the credential never lands in the config file');
  assert.equal(opencodeConfig(spawn({ model: 'gpt-6-sol' }), '/runs/r1').provider, undefined, 'a built-in provider needs no block');
});

test('stream: usage summed over steps, final text is the last step\'s, tool events emitted', () => {
  const { outcome, events } = parseOpencodeStream(jsonl(
    ev('step_start'), text('Looking around.'),
    tool('bash', { status: 'completed', input: { command: 'ls' }, output: 'README.md', title: 'ls' }),
    tool('edit', { status: 'completed', input: { filePath: '/wt/src/a.ts' } }),
    stepFinish(1000, 200, 400, 50, 30),
    ev('step_start'), text('Done.'), text('Committed the change.'), stepFinish(500, 50, 100),
  ));
  assert.equal(outcome?.outcome, 'done');
  assert.equal(outcome?.text, 'Done.\nCommitted the change.');
  assert.equal(outcome?.costUsd, null, 'priced by the worker from the catalogue');
  assert.deepEqual(outcome?.usage, { inputTokens: 1500, outputTokens: 280, cacheReadTokens: 500, cacheWriteTokens: 50 });
  assert.equal(outcome?.turns, 2);
  assert.equal(outcome?.sessionId, 'ses_1');
  assert.deepEqual(events, [
    { kind: 'tool:post', payload: { tool: 'bash', summary: 'ls', ok: true } },
    { kind: 'tool:post', payload: { tool: 'edit', summary: '/wt/src/a.ts', ok: true } },
  ]);
});

test('stream: a permission refusal is tool:denied only; the outcome is the agent\'s own', () => {
  const { outcome, events } = parseOpencodeStream(jsonl(
    ev('step_start'),
    tool('edit', { status: 'error', input: { filePath: '/etc/x' }, error: 'The user rejected permission to use this specific tool call.' }),
    tool('bash', { status: 'error', input: { command: 'npm test' }, error: 'exit code 1' }),
    text('NEEDS_HUMAN: which directory holds billing?'), stepFinish(10, 5),
  ));
  assert.deepEqual(events.map((e) => e.kind), ['tool:denied', 'tool:post']);
  assert.equal(events[1].payload.ok, false);
  assert.equal(outcome?.outcome, 'needs_human');
  assert.equal(outcome?.text, 'which directory holds billing?');
});

test('stream: an error event fails the segment; no events at all is no result', () => {
  const { outcome } = parseOpencodeStream(jsonl(ev('step_start'), { type: 'error', timestamp: 1, sessionID: 'ses_1', error: { name: 'APIError', data: { message: '401 invalid x-api-key' } } }));
  assert.equal(outcome?.outcome, 'failed');
  assert.equal(outcome?.text, '401 invalid x-api-key');
  assert.equal(parseOpencodeStream('INFO booting\n').outcome, null);
});

test('capabilities: hookless, streamed, and it cannot confine its own writes', () => {
  assert.deepEqual(new OpencodeRuntime().capabilities, { toolHooks: false, eventStream: true, reportsCost: false, listsModels: false, confinesWrites: false });
});

test('permission map: the read-only copies are readable outside the project and never editable', () => {
  const writer = opencodePermissions(policyFor(true), '/runs/r1', '/wt/refs/r1/t1');
  assert.deepEqual(writer.external_directory, { '*': 'deny', '/runs/r1/**': 'allow', '/wt/refs/r1/t1/**': 'allow' });
  assert.deepEqual(writer.edit, { '*': 'allow', '/wt/refs/r1/t1/**': 'deny' });
  const reader = opencodePermissions(policyFor(false), '/runs/r1', '/wt/refs/r1/t1');
  assert.deepEqual(reader.edit, { '*': 'deny', '/runs/r1/**': 'allow' });
  assert.deepEqual(opencodeConfig(spawn({ env: { ASF_RUN_DIR: '/runs/r1', ASF_REFS_DIR: '/wt/refs/r1/t1' } }), '/runs/r1').agent,
    { 'asf-writer': { mode: 'primary', description: 'ASF writing role', permission: writer }, 'asf-reader': { mode: 'primary', description: 'ASF read-only role', permission: reader } });
});
