import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODELS, PROVIDERS } from '@asf/shared';
import type { AgentOutcome, AgentRuntime, AgentSpawn, AgentUsage, EventSink, PreflightResult, RunAuth, RunControl, RuntimeCapabilities, ToolPolicy } from '@asf/shared';
import { config } from '../config.js';
import { applyAuth, opencodeAuthConfig } from '../auth/index.js';
import type { RuntimeTaskOptions } from './index.js';
import { killTree, spawnAgent } from './proc.js';
import { outcomeFromText } from './outcome.js';

export type OpencodeAgent = 'asf-writer' | 'asf-reader';
type Action = 'allow' | 'deny';

/** The generated agent a role runs as: a writing role edits the worktree, the rest only their run-dir artifact. */
export function opencodeAgent(policy: ToolPolicy): OpencodeAgent {
  return policy.fileWrite === 'worktree' ? 'asf-writer' : 'asf-reader';
}

/**
 * OpenCode's permission map for a neutral ToolPolicy. Only allow/deny, never `ask`:
 * under `opencode run` nobody is there to answer, so an `ask` would stall the role.
 * Pattern maps are last-match-wins, so the catch-all comes first. Every role may
 * write its artifact under the run dir (outside the project, hence external_directory);
 * a read-only role may edit nothing else. `git push` is denied whatever the shell
 * policy (the worker pushes, and the worktree remote carries no credential anyway).
 * doom_loop defaults to `ask`, so it is pinned too. Advisory by itself: OpenCode
 * plugin hooks may not fire under `opencode run`, which is why this runtime is
 * container-only (docs/RUNTIMES.md).
 */
export function opencodePermissions(policy: ToolPolicy, runDir: string): Record<string, Action | Record<string, Action>> {
  const runDirOnly: Record<string, Action> = { '*': 'deny', [`${runDir}/**`]: 'allow' };
  return {
    read: 'allow',
    edit: policy.fileWrite === 'worktree' ? 'allow' : runDirOnly,
    bash: policy.shell ? { '*': 'allow', 'git push': 'deny', 'git push *': 'deny' } : 'deny',
    webfetch: policy.network ? 'allow' : 'deny',
    websearch: policy.network ? 'allow' : 'deny',
    external_directory: runDirOnly,
    task: 'deny',
    doom_loop: 'deny',
  };
}

/** The whole generated opencode.json for one task: both ASF agents + the provider OpenCode needs for this auth. */
export function opencodeConfig(spawnReq: AgentSpawn, runDir: string): Record<string, unknown> {
  const agent = (writes: boolean) => ({
    mode: 'primary',
    description: writes ? 'ASF writing role' : 'ASF read-only role',
    permission: opencodePermissions({ ...spawnReq.policy, fileWrite: writes ? 'worktree' : 'run-dir-only' }, runDir),
  });
  const { provider } = opencodeAuthConfig(spawnReq.auth, spawnReq.model);
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    agent: { 'asf-writer': agent(true), 'asf-reader': agent(false) },
    ...(Object.keys(provider).length ? { provider } : {}),
  };
}

/**
 * The `opencode run` argv for one role. The model is `<provider>/<model>` with the
 * provider resolved from the task's auth. The prompt goes on stdin (opencode run
 * appends piped stdin to the message), never argv.
 */
export function buildOpencodeArgs(spawnReq: AgentSpawn): string[] {
  const args = ['run', '--format', 'json'];
  if (spawnReq.model) args.push('-m', `${opencodeAuthConfig(spawnReq.auth, spawnReq.model).id}/${spawnReq.model}`);
  args.push('--agent', opencodeAgent(spawnReq.policy), '--dir', spawnReq.cwd);
  return args;
}

/**
 * OpenCode, headless: `opencode run --format json` streams one JSON event per line
 * (step_start / text / tool_use / step_finish / error) with per-step token usage.
 * Its plugin hooks are not reliable under `run`, so toolHooks is false; its
 * permission map is advisory and it has no OS sandbox, so confinesWrites is false
 * and only a containerised worker offers it. Priced by segment.ts from the catalogue.
 */
export class OpencodeRuntime implements AgentRuntime {
  readonly kind = 'opencode';
  readonly capabilities: RuntimeCapabilities = { toolHooks: false, eventStream: true, reportsCost: false, listsModels: false, confinesWrites: false };
  constructor(private readonly opts: RuntimeTaskOptions & { bin?: string } = {}) {}
  private get bin(): string { return this.opts.bin ?? config.opencodeBin; }

  async probe(): Promise<{ ok: boolean; version: string; models: string[] }> {
    return new Promise((resolve) => {
      const child = spawn(this.bin, ['--version']);
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', () => resolve({ ok: false, version: 'not found', models: [] }));
      child.on('close', (code) => resolve({ ok: code === 0, version: out.trim() || 'unknown', models: [] }));
    });
  }

  /** One trivial prompt through the real binary with this auth, on the cheapest built-in model it serves. */
  async preflight(auth: RunAuth): Promise<PreflightResult> {
    const kinds = new Map(PROVIDERS.map((p) => [p.id, p.kind]));
    const model = MODELS.find((m) => m.runtimes.includes(this.kind) && kinds.get(m.providerId) === auth.providerKind)?.id;
    const dir = join(tmpdir(), `asf-opencode-preflight-${process.pid}`);
    const spawnReq: AgentSpawn = { role: 'reviewer', prompt: 'Reply with exactly: pong', cwd: dir, model, maxCostUsd: 0, env: {}, auth, timeoutMs: 60_000,
      policy: { fileWrite: 'run-dir-only', shell: false, network: false, gitPush: false } };
    try {
      await mkdir(join(dir, '.opencode'), { recursive: true });
      const cfg = join(dir, '.opencode', 'opencode.json');
      await writeFile(cfg, JSON.stringify(opencodeConfig(spawnReq, dir), null, 2), 'utf8');
      const env = { ...applyAuth(process.env, auth), OPENCODE_CONFIG: cfg };
      const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolveP, rejectP) => {
        const child = spawn(this.bin, buildOpencodeArgs(spawnReq), { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = ''; let err = '';
        child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
        const t = setTimeout(() => { child.kill('SIGKILL'); rejectP(new Error('timed out after 60s')); }, 60_000);
        child.on('error', (e) => { clearTimeout(t); rejectP(e); });
        child.on('close', (c) => { clearTimeout(t); resolveP({ stdout: out, stderr: err, code: c }); });
        child.stdin.on('error', () => { /* exited before reading the prompt; close reports it */ });
        child.stdin.end(spawnReq.prompt);
      });
      const parsed = parseOpencodeStream(stdout).outcome;
      if (!parsed) return { ok: false, reason: `exit ${code}: ${stderr.trim().split('\n').pop()?.slice(0, 300) || 'no output'}` };
      if (parsed.outcome === 'failed') return { ok: false, reason: parsed.text };
      return { ok: true, detail: auth.mode === 'api-key' ? 'metered' : 'no per-run cost figure (plan/flat)' };
    } catch (e) {
      return { ok: false, reason: `could not run ${this.bin}: ${(e as Error).message}` };
    }
  }

  async run(spawnReq: AgentSpawn, sink: EventSink, ctl?: RunControl): Promise<AgentOutcome> {
    const bin = this.bin;
    const runDir = spawnReq.env.ASF_RUN_DIR || spawnReq.cwd;
    // The generated agents live in the run dir, never in the worktree the agent edits (and commits).
    const cfgDir = join(runDir, '.opencode');
    await mkdir(cfgDir, { recursive: true });
    const cfg = join(cfgDir, 'opencode.json');
    await writeFile(cfg, JSON.stringify(opencodeConfig(spawnReq, runDir), null, 2), 'utf8');
    const args = buildOpencodeArgs(spawnReq);
    // Credentials are set/stripped by the auth layer; this file never spells a credential name.
    const env = { ...applyAuth({ ...process.env, ...spawnReq.env }, spawnReq.auth), OPENCODE_CONFIG: cfg };

    const done = await new Promise<AgentOutcome | null>((resolve) => {
      // detached: opencode leads its own process group so a cancel/timeout kills every command it started.
      const child = spawnAgent(bin, args, { cwd: spawnReq.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const logStream = this.opts.logPath ? createWriteStream(this.opts.logPath, { flags: 'a' }) : null;
      let stdout = '';
      let stderr = '';
      let pending = '';
      let settled = false;
      const finish = (o: AgentOutcome | null) => {
        if (settled) return; settled = true; clearTimeout(timer); ctl?.signal.removeEventListener('abort', onAbort); logStream?.end(); resolve(o);
      };
      const onAbort = () => {
        sink.emit({ kind: 'segment:cancelled', payload: { by: 'operator' } });
        killTree(child);
        finish({ outcome: 'failed', text: 'run cancelled by the operator', usage: null, costUsd: null, terminalReason: 'cancelled' });
      };
      const timer = setTimeout(() => {
        sink.emit({ kind: 'segment:timeout', payload: { timeoutMs: spawnReq.timeoutMs } });
        killTree(child);
        finish({ outcome: 'timeout', text: `no result within ${Math.round(spawnReq.timeoutMs / 60000)} min`, usage: null, costUsd: null });
      }, spawnReq.timeoutMs);
      if (ctl?.signal.aborted) onAbort();
      else ctl?.signal.addEventListener('abort', onAbort, { once: true });

      // Tail the JSON events as they arrive: tool events are the liveness signal for a hookless runtime.
      child.stdout.on('data', (d) => {
        stdout += d; logStream?.write(d);
        pending += d;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) for (const e of opencodeToolEvents(parseLine(line))) sink.emit(e);
      });
      child.stderr.on('data', (d) => { stderr += d; logStream?.write(d); });
      child.stdin.on('error', () => { /* opencode exited before reading the prompt; close reports it */ });
      child.stdin.end(spawnReq.prompt);
      child.on('error', (err) => finish({ outcome: 'failed', text: `could not run ${bin}: ${err.message}. Install OpenCode or set OPENCODE_BIN.`, usage: null, costUsd: null }));
      child.on('close', (code) => {
        const parsed = parseOpencodeStream(stdout).outcome;
        if (code !== 0 && !parsed) return finish({ outcome: 'failed', text: stderr.trim().split('\n').slice(-5).join('\n') || `exited ${code} with no result`, usage: null, costUsd: null });
        finish(parsed);
      });
    });
    return done ?? { outcome: 'failed', text: 'no result in opencode output', usage: null, costUsd: null };
  }
}

type Json = Record<string, unknown>;
export interface OpencodeEvent { kind: 'tool:post' | 'tool:denied'; payload: Record<string, unknown> }

function parseLine(line: string): Json | null {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  try { return JSON.parse(s) as Json; } catch { return null; }
}

/** How OpenCode reports a call its permission map refused. */
const PERMISSION_DENIED = /permission|rejected|denied/i;

/**
 * One JSON event -> ASF tool events. A finished tool part is a `tool:post`; one the
 * permission map refused is a `tool:denied`. Recorded only: a denial never changes
 * the outcome — the agent's own NEEDS_HUMAN decides.
 */
export function opencodeToolEvents(o: Json | null): OpencodeEvent[] {
  if (!o || o.type !== 'tool_use' || !o.part || typeof o.part !== 'object') return [];
  const part = o.part as Json;
  const state = (part.state ?? {}) as Json;
  const tool = String(part.tool ?? 'tool');
  const summary = String(state.title ?? '') || summarise(state.input);
  if (state.status === 'error') {
    const err = String(state.error ?? '');
    if (PERMISSION_DENIED.test(err)) return [{ kind: 'tool:denied', payload: { tool, summary, reason: err.slice(0, 300) } }];
    return [{ kind: 'tool:post', payload: { tool, summary, ok: false } }];
  }
  if (state.status === 'completed') return [{ kind: 'tool:post', payload: { tool, summary, ok: true } }];
  return [];
}

function summarise(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Json;
  return String(i.command ?? i.filePath ?? i.path ?? i.url ?? '').slice(0, 300);
}

/**
 * The whole `opencode run --format json` stdout -> an outcome plus its tool events.
 * Usage is summed over every step_finish (`tokens.input` excludes cache reads/writes,
 * which come separately; reasoning tokens bill as output). The role's final text is
 * the text parts of its last step, read with the shared NEEDS_HUMAN/DISPUTE protocol.
 * An `error` event is a failed segment. null = no result.
 */
export function parseOpencodeStream(stdout: string): { outcome: AgentOutcome | null; events: OpencodeEvent[] } {
  const events: OpencodeEvent[] = [];
  let input = 0; let output = 0; let cacheRead = 0; let cacheWrite = 0;
  let steps = 0;
  let stepText: string[] = [];
  let lastText: string | null = null;
  let failure: string | null = null;
  let sessionId: string | null = null;
  for (const line of stdout.split('\n')) {
    const o = parseLine(line);
    if (!o) continue;
    events.push(...opencodeToolEvents(o));
    if (typeof o.sessionID === 'string') sessionId = o.sessionID;
    const part = (o.part ?? {}) as Json;
    if (o.type === 'step_start') {
      stepText = [];
    } else if (o.type === 'text') {
      stepText.push(String(part.text ?? ''));
      lastText = stepText.join('\n');
    } else if (o.type === 'step_finish') {
      steps++;
      const t = (part.tokens ?? {}) as Json;
      const cache = (t.cache ?? {}) as Json;
      input += Number(t.input ?? 0); output += Number(t.output ?? 0) + Number(t.reasoning ?? 0);
      cacheRead += Number(cache.read ?? 0); cacheWrite += Number(cache.write ?? 0);
    } else if (o.type === 'error') {
      const e = (o.error ?? {}) as Json;
      failure = String((e.data as Json | undefined)?.message ?? e.message ?? e.name ?? 'opencode reported an error');
    }
  }
  const usage: AgentUsage | null = input || output || cacheRead
    ? { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
    : null;
  const meta = { usage, costUsd: null, turns: steps, sessionId };
  if (failure) return { outcome: { outcome: 'failed', text: failure, terminalReason: 'error', ...meta }, events };
  if (lastText === null && steps === 0) return { outcome: null, events };
  return { outcome: { ...outcomeFromText(lastText ?? ''), terminalReason: 'step_finish', ...meta }, events };
}
