import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaimResponse, RunContext, Run, RunAuth } from '@asf/shared';
import { STANDARD_TEAM, DEFAULT_GATES } from '@asf/shared';

// M11 WP2: an Ollama-model task through the real runSegment, against a fake `claude`
// that records its argv + the env it was spawned with and reports a Claude-priced cost
// (as the real CLI does for any model; docs/OLLAMA_SPIKE.md finding 4).

let dir: string;
let segment: typeof import('./segment.js');
let apiMod: typeof import('./api.js');
let cfg: typeof import('./config.js');
type Ev = { kind: string; payload: Record<string, unknown> };
let events: Ev[] = [];
const PATCHED = ['event', 'saveArtifact', 'listArtifacts', 'listArtifactVersions', 'listMessages', 'listAdhoc', 'cancelRequested', 'appendMessage', 'createAdhoc', 'attachment'] as const;
const realApi = {} as Record<string, unknown>;

const ENV_SEEN = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];
let record: string;

async function fakeClaude(): Promise<string> {
  const bin = join(dir, 'claude');
  const envelope = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Looks good. APPROVE', num_turns: 3, total_cost_usd: 0.42,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  const envLines = ENV_SEEN.map((k) => `echo "${k}=\${${k}-<unset>}" >> "${record}"`).join('\n');
  await writeFile(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
for a in "$@"; do printf 'ARG %s\\n' "$a" >> "${record}"; done
${envLines}
cat <<'EOF'
${envelope}
EOF
`);
  await chmod(bin, 0o755);
  return bin;
}

const run = (): Run => ({
  id: 'run_ollama0001', ticketId: 't1', ticketKey: 'ASF-9', ticketProvider: 'mock', state: 'running',
  teamName: 'standard', team: STANDARD_TEAM, gates: DEFAULT_GATES, repoId: null, worktreePath: null, branchName: null,
  changeRequestUrl: null, changeRequestNumber: null, changeRequestState: null, deliveryOutcome: null, costUsd: 0, maxCostUsd: 15, reviewIterations: 0, dispatchedBy: 'test', reason: null,
  createdAt: new Date().toISOString(), startedAt: null, lastEventAt: null, cancelRequestedAt: null, finishedAt: null,
});
const claim = (model: string, effort: string | null = 'medium'): ClaimResponse & object => ({
  run: run(), team: STANDARD_TEAM,
  task: { id: `task_${Math.random().toString(36).slice(2, 8)}`, runId: 'run_ollama0001', role: 'reviewer', seq: 3, state: 'running', attempt: 1, inputRef: null, outputRef: null,
    workerId: 'w', runtime: 'claude-code', model, effort, costUsd: 0, gateChecked: false, startedAt: null, finishedAt: null,
    reason: null, queuedBy: 'plan', queuedReason: null },
}) as unknown as ClaimResponse & object;

const anth: RunAuth = { providerKind: 'anthropic', mode: 'api-key', credential: 'sk-ant' };
const modelCatalogExtra = { models: [{ id: 'ollama:gpt-oss:20b', tier: 'fast', providerId: 'ollama', runtimes: ['claude-code', 'codex'], rate: { inputPerM: 0, outputPerM: 0 } }] };
const ctx = (ollama: RunAuth | null): RunContext => ({
  runId: 'run_ollama0001', ticket: { id: 't1', key: 'ASF-9', title: 'T', body: 'B', url: 'u', links: [] },
  repo: null, cloneCredential: null, auth: anth, auths: { anthropic: anth, ...(ollama ? { ollama } : {}) }, roleSkills: {}, thirdPartySkills: [],
  workerSettings: { maxTurns: 40, segmentTimeoutMs: 60_000, modelCatalogExtra },
}) as unknown as RunContext;
const localOllama: RunAuth = { providerKind: 'ollama', mode: 'none', baseUrl: 'http://host.docker.internal:11434' };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asf-segollama-'));
  record = join(dir, 'seen.txt');
  process.env.RUN_DATA_ROOT = join(dir, 'runs');
  process.env.WORKTREE_ROOT = join(dir, 'wt');
  process.env.WORKER_ID = 'worker-test-1';
  cfg = await import('./config.js');
  apiMod = await import('./api.js');
  segment = await import('./segment.js');
  for (const k of PATCHED) realApi[k] = (apiMod.api as Record<string, unknown>)[k];
  (cfg.config as { claudeBin: string }).claudeBin = await fakeClaude();
});
after(async () => {
  for (const k of PATCHED) (apiMod.api as Record<string, unknown>)[k] = realApi[k];
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  events = [];
  await rm(record, { force: true });
  const a = apiMod.api as Record<string, unknown>;
  a.event = async (_runId: string, kind: string, payload: Record<string, unknown>) => { events.push({ kind, payload }); };
  a.saveArtifact = async () => {};
  a.listArtifacts = async () => ({});
  a.listArtifactVersions = async () => [];
  a.listMessages = async () => [];
  a.listAdhoc = async () => [];
  a.cancelRequested = async () => false;
  a.appendMessage = async () => {};
  a.createAdhoc = async () => null;
  a.attachment = async () => Buffer.from('');
});

async function seen(): Promise<{ args: string[]; env: Record<string, string> }> {
  const lines = (await readFile(record, 'utf8')).split('\n').filter(Boolean);
  const args = lines.filter((l) => l.startsWith('ARG ')).map((l) => l.slice(4));
  const env = Object.fromEntries(lines.filter((l) => !l.startsWith('ARG ')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { args, env };
}
const after1 = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

test('an Ollama task: native model id, no effort flag, Ollama env, and $0 whatever the CLI reports', async () => {
  const res = await segment.runSegment(claim('ollama:gpt-oss:20b'), ctx(localOllama), () => {});
  assert.equal(res.outcome, 'done', res.reason ?? '');
  const { args, env } = await seen();
  assert.equal(after1(args, '--model'), 'gpt-oss:20b', 'the provider prefix is stripped');
  assert.ok(!args.includes('--effort'), 'no vendor effort flag for an Ollama model');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://host.docker.internal:11434');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'ollama');
  assert.equal(env.ANTHROPIC_API_KEY, '<unset>', 'the Claude key never reaches an Ollama task');
  assert.equal(env.ANTHROPIC_MODEL, 'gpt-oss:20b');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gpt-oss:20b');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'gpt-oss:20b');
  assert.equal(res.costUsd, 0, 'the CLI\'s Claude-priced $0.42 is dropped');
  const result = events.find((e) => e.kind === 'segment:result')!;
  assert.equal(result.payload.costUsd, 0);
  assert.deepEqual((result.payload.usage as { inputTokens: number }).inputTokens, 1000, 'token usage is kept');
});

test('a Claude task in the same (mixed) team is unchanged: its model, effort, auth and reported cost', async () => {
  const res = await segment.runSegment(claim('claude-sonnet-5'), ctx(localOllama), () => {});
  const { args, env } = await seen();
  assert.equal(after1(args, '--model'), 'claude-sonnet-5');
  assert.equal(after1(args, '--effort'), 'medium');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant');
  assert.equal(env.ANTHROPIC_BASE_URL, '<unset>');
  assert.equal(res.costUsd, 0.42);
});

test('an Ollama task with no server URL fails with the fix and never runs the agent', async () => {
  const res = await segment.runSegment(claim('ollama:gpt-oss:20b'), ctx(null), () => {});
  assert.equal(res.outcome, 'failed');
  assert.match(res.reason ?? '', /OLLAMA_BASE_URL/);
  assert.equal(existsSync(record), false, 'the agent binary was not spawned');
  assert.equal(res.costUsd, 0);
});
