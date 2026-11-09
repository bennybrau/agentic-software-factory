import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResult, buildArgs, claudeTools, ClaudeCodeRuntime } from './claude-code.js';
import { policyFor } from '../segment.js';
import type { AgentSpawn } from '@asf/shared';

const spawn = (over: Partial<AgentSpawn> = {}): AgentSpawn => ({
  role: 'planner', prompt: 'do it', cwd: '/wt', maxCostUsd: 15,
  policy: policyFor(false), env: {}, auth: { providerKind: 'anthropic', mode: 'api-key', credential: 'sk-test' }, timeoutMs: 1000, ...over,
});

const envelope = (over: Record<string, unknown>) => JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.42,
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50 }, ...over });

test('parses a successful result with cost and usage', () => {
  const r = parseResult(envelope({ result: 'Done. Plan written to plan.md.' }));
  assert.equal(r?.outcome, 'done');
  assert.equal(r?.costUsd, 0.42);
  assert.deepEqual(r?.usage, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 0 });
});

test('NEEDS_HUMAN: in the result text -> needs_human with the question', () => {
  const r = parseResult(envelope({ result: 'Looked at the repo.\nNEEDS_HUMAN: which repo holds the billing service?' }));
  assert.equal(r?.outcome, 'needs_human');
  assert.equal(r?.text, 'which repo holds the billing service?');
});

test('is_error true is a failed segment even with a result string', () => {
  const r = parseResult(envelope({ is_error: true, result: 'Failed to authenticate' }));
  assert.equal(r?.outcome, 'failed');
  assert.match(r!.text, /authenticate/);
});

test('the last result object wins when several are streamed', () => {
  const stream = [
    JSON.stringify({ type: 'assistant', text: 'thinking' }),
    envelope({ result: 'first', total_cost_usd: 0.1 }),
    envelope({ result: 'second', total_cost_usd: 0.3 }),
  ].join('\n');
  const r = parseResult(stream);
  assert.equal(r?.text, 'second');
  assert.equal(r?.costUsd, 0.3);
});

test('no result envelope returns null (caller treats as failed)', () => {
  assert.equal(parseResult('{"type":"assistant","text":"hi"}'), null);
  assert.equal(parseResult('not json at all'), null);
});

test('buildArgs passes --model and --max-turns when set, omits max-turns when 0', () => {
  const withTurns = buildArgs(spawn({ model: 'claude-haiku-4-5', maxTurns: 8 }), '/run/settings.json', []);
  assert.ok(withTurns.includes('--model') && withTurns[withTurns.indexOf('--model') + 1] === 'claude-haiku-4-5');
  assert.ok(withTurns.includes('--max-turns') && withTurns[withTurns.indexOf('--max-turns') + 1] === '8');
  assert.ok(withTurns.includes('--settings') && withTurns.includes('/run/settings.json'));

  const noTurns = buildArgs(spawn({ maxTurns: 0 }), undefined, []);
  assert.ok(!noTurns.includes('--max-turns'), '0 means no ceiling');
  assert.ok(!noTurns.includes('--model'), 'no model when unset');
  assert.ok(!noTurns.includes('--settings'), 'no settings when unset');
});

// GOLDEN (M8 WP B): the neutral ToolPolicy must reproduce, byte for byte, the argv the
// worker built before the refactor, when segment.ts passed
//   allowedTools = READ_TOOLS ++ WRITE_TOOLS, deniedTools = []  for EVERY role.
// If this changes, Claude Code's behavior changed — that is not a refactor.
const PRE_WP_B_ALLOWED = 'Read,Grep,Glob,Bash,WebFetch,WebSearch,TodoWrite,Write,Edit,MultiEdit,NotebookEdit';
for (const writes of [true, false]) {
  test(`golden argv: ${writes ? 'writer' : 'reader'} role builds the exact pre-WP-B claude argv`, () => {
    const args = buildArgs(spawn({ role: writes ? 'implementer' : 'reviewer', prompt: 'P', policy: policyFor(writes),
      model: 'claude-sonnet-5', effort: 'low', maxTurns: 40 }), '/run/settings-t1.json', ['--verbose']);
    assert.deepEqual(args, [
      '-p', 'P', '--output-format', 'json', '--permission-mode', 'acceptEdits',
      '--settings', '/run/settings-t1.json',
      '--allowedTools', PRE_WP_B_ALLOWED,
      '--model', 'claude-sonnet-5', '--effort', 'low', '--max-turns', '40',
      '--verbose',
    ]);
    assert.ok(!args.includes('--disallowedTools'), 'nothing was denied before; nothing is now');
  });
}

test('claudeTools: turning shell/network off moves those tools to the deny list', () => {
  const t = claudeTools({ fileWrite: 'worktree', shell: false, network: false, gitPush: false });
  assert.deepEqual(t.denied, ['Bash', 'WebFetch', 'WebSearch']);
  for (const x of ['Bash', 'WebFetch', 'WebSearch']) assert.ok(!t.allowed.includes(x));
  for (const x of ['Read', 'Write', 'Edit']) assert.ok(t.allowed.includes(x));
});

test('claude-code declares hooks + self-reported cost + resumable sessions + skill folders', () => {
  assert.deepEqual(new ClaudeCodeRuntime().capabilities, { toolHooks: true, eventStream: false, reportsCost: true, listsModels: false, resumesSessions: true, confinesWrites: true, loadsSkillFiles: true });
});

test('buildArgs appends extra args last', () => {
  const args = buildArgs(spawn(), undefined, ['--foo', 'bar']);
  assert.deepEqual(args.slice(-2), ['--foo', 'bar']);
});

test('buildArgs passes --effort when set and omits it when unset', () => {
  const withEffort = buildArgs(spawn({ effort: 'high' }), undefined, []);
  assert.ok(withEffort.includes('--effort') && withEffort[withEffort.indexOf('--effort') + 1] === 'high');
  assert.ok(!buildArgs(spawn({}), undefined, []).includes('--effort'), 'no effort when unset');
});

test('error_max_turns names the ceiling instead of "agent reported an error"', () => {
  // The real envelope from run_7ba8d74d4ce14daf: is_error with an EMPTY result string,
  // subtype error_max_turns, stop_reason tool_use (the agent was mid-call, not wedged).
  const r = parseResult(envelope({ is_error: true, result: '', subtype: 'error_max_turns', stop_reason: 'tool_use',
    num_turns: 41, errors: ['Reached maximum number of turns (40)'], total_cost_usd: 2.51 }));
  assert.equal(r?.outcome, 'failed');
  assert.match(r!.text, /40-turn ceiling/);
  assert.match(r!.text, /MAX_TURNS_<ROLE>/);
  assert.match(r!.text, /WORKER_MAX_TURNS/);
  assert.equal(r?.costUsd, 2.51, 'cost of the partial work is still reported');
});

test('an is_error envelope with no result text falls back to its errors[] before the generic message', () => {
  const r = parseResult(envelope({ is_error: true, result: '', errors: ['OAuth access token is invalid'] }));
  assert.equal(r?.outcome, 'failed');
  assert.match(r!.text, /OAuth access token is invalid/);
});

test('parseResult surfaces num_turns and subtype as turns/terminalReason (M11 WP2)', () => {
  const r = parseResult(envelope({ result: 'done', num_turns: 12, subtype: 'success' }));
  assert.equal(r?.turns, 12);
  assert.equal(r?.terminalReason, 'success');
  const nometa = parseResult(envelope({ result: 'done' }));
  assert.equal(nometa?.turns, null, 'absent num_turns -> null, not undefined');
});

test('argv: the read-only copies dir is added with --add-dir only when there are copies', () => {
  const none = buildArgs(spawn({}), undefined, []);
  assert.ok(!none.includes('--add-dir'));
  const withRefs = buildArgs(spawn({ env: { ASF_REFS_DIR: '/wt/refs/run_1/task_1' } }), undefined, []);
  assert.equal(withRefs[withRefs.indexOf('--add-dir') + 1], '/wt/refs/run_1/task_1');
});
