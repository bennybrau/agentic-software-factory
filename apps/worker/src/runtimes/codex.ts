import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentOutcome, AgentRuntime, AgentSpawn, AgentUsage, EventSink, PreflightResult, RunAuth, RunControl, RuntimeCapabilities } from '@asf/shared';
import { config } from '../config.js';
import { applyAuth, codexAuthArgs, prepareAuthHome } from '../auth/index.js';
import type { RuntimeTaskOptions } from './index.js';
import { killTree, spawnAgent } from './proc.js';
import { outcomeFromText } from './outcome.js';

export type CodexSandbox = 'workspace-write' | 'off';

/** ASF's effort levels -> Codex's model_reasoning_effort (which tops out at high). */
const CODEX_EFFORT: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

/**
 * The `codex` argv for one role. With sandbox 'workspace-write' every role gets
 * Codex's sandbox scoped to the worktree plus the run dir: a read-only role must
 * still write plan.md/review.md there, and the worker's post-run audit (guard.ts)
 * is what holds it to read-only in the worktree. With sandbox 'off' (a worker that
 * is already a container) Codex runs unsandboxed and approval-free
 * (--dangerously-bypass-approvals-and-sandbox): the container, the per-task
 * worktree and that same audit are the boundary, as they are for Claude Code.
 * `-a never` is Codex's global flag, so it goes before `exec` (exec rejects it).
 * --skip-git-repo-check: a role with no repo bound runs in the (non-git) run dir.
 * The prompt goes on stdin (`-`), never argv.
 */
export function buildCodexArgs(spawnReq: AgentSpawn, lastMessagePath: string, providerArgs: string[], extraArgs: string[], sandbox: CodexSandbox = 'workspace-write'): string[] {
  const args = sandbox === 'off' ? ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox'] : ['-a', 'never', 'exec', '--json'];
  if (spawnReq.model) args.push('-m', spawnReq.model);
  if (sandbox !== 'off') args.push('-s', 'workspace-write');
  args.push('-C', spawnReq.cwd, '--skip-git-repo-check');
  if (sandbox !== 'off' && spawnReq.env.ASF_RUN_DIR) args.push('--add-dir', spawnReq.env.ASF_RUN_DIR);
  args.push('--ephemeral', '-o', lastMessagePath);
  const effort = spawnReq.effort ? CODEX_EFFORT[spawnReq.effort] : undefined;
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  args.push(...providerArgs, ...extraArgs, '-');
  return args;
}

/**
 * OpenAI Codex CLI, headless: `codex exec --json` streams JSONL — thread/turn/item
 * events with per-turn token usage. No per-tool hooks, so tool telemetry comes from
 * the stream and scope is enforced by Codex's sandbox + the worker's post-run audit.
 * Codex reports tokens, not dollars: segment.ts prices them from the catalogue rate.
 */
export class CodexRuntime implements AgentRuntime {
  readonly kind = 'codex';
  constructor(private readonly opts: RuntimeTaskOptions & { bin?: string; sandbox?: CodexSandbox } = {}) {}
  private get sandbox(): CodexSandbox { return this.opts.sandbox ?? config.codexSandbox; }
  /** Codex confines writes only while its own sandbox is on; with it off (a container
   * worker, or CODEX_SANDBOX=off) the container has to be the boundary. */
  get capabilities(): RuntimeCapabilities {
    return { toolHooks: false, eventStream: true, reportsCost: false, listsModels: false, confinesWrites: this.sandbox !== 'off' };
  }

  async probe(): Promise<{ ok: boolean; version: string; models: string[] }> {
    return new Promise((resolve) => {
      const child = spawn(this.opts.bin ?? config.codexBin, ['--version']);
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', () => resolve({ ok: false, version: 'not found', models: [] }));
      child.on('close', (code) => resolve({ ok: code === 0, version: out.trim() || 'unknown', models: [] }));
    });
  }

  /** One trivial prompt through the real binary with this auth — the same call a role makes. */
  async preflight(auth: RunAuth): Promise<PreflightResult> {
    const bin = this.opts.bin ?? config.codexBin;
    const env = applyAuth(process.env, auth);
    // Same sandbox choice as a real role: read-only on a host, none inside a container (bubblewrap can't start there).
    const sandboxArgs = this.sandbox === 'off' ? ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox'] : ['-a', 'never', 'exec', '--json', '-s', 'read-only'];
    const args = [...sandboxArgs, '-C', tmpdir(), '--skip-git-repo-check', '--ephemeral', ...codexAuthArgs(auth), '-'];
    try {
      const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolveP, rejectP) => {
        const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = ''; let err = '';
        child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
        const t = setTimeout(() => { child.kill('SIGKILL'); rejectP(new Error('timed out after 60s')); }, 60_000);
        child.on('error', (e) => { clearTimeout(t); rejectP(e); });
        child.on('close', (c) => { clearTimeout(t); resolveP({ stdout: out, stderr: err, code: c }); });
        child.stdin.end('Reply with exactly: pong');
      });
      const parsed = parseCodexStream(stdout).outcome;
      if (!parsed) return { ok: false, reason: `exit ${code}: ${stderr.trim().split('\n').pop()?.slice(0, 300) || 'no output'}` };
      if (parsed.outcome === 'failed') return { ok: false, reason: parsed.text };
      return { ok: true, detail: auth.mode === 'api-key' ? 'metered' : 'no per-run cost figure (plan/flat)' };
    } catch (e) {
      return { ok: false, reason: `could not run ${bin}: ${(e as Error).message}` };
    }
  }

  async run(spawnReq: AgentSpawn, sink: EventSink, ctl?: RunControl): Promise<AgentOutcome> {
    const bin = this.opts.bin ?? config.codexBin;
    const runDir = spawnReq.env.ASF_RUN_DIR || spawnReq.cwd;
    // A fresh CODEX_HOME per task: no config, session or memory leaks between tasks or from the operator's own ~/.codex.
    const home = join(runDir, `codex-home-${spawnReq.env.ASF_TASK_ID || 'task'}`);
    await mkdir(home, { recursive: true });
    await prepareAuthHome(spawnReq.auth, home);
    const args = buildCodexArgs(spawnReq, join(runDir, 'last.md'), codexAuthArgs(spawnReq.auth), config.codexExtraArgs, this.sandbox);
    // Credentials are set/stripped by the auth layer; this file never spells a credential name.
    const env = { ...applyAuth({ ...process.env, ...spawnReq.env }, spawnReq.auth), CODEX_HOME: home };

    const done = await new Promise<AgentOutcome | null>((resolve) => {
      // detached: codex leads its own process group so a cancel/timeout kills every command it started.
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

      // Tail the JSONL as it arrives: tool events are the liveness signal for a hookless runtime.
      child.stdout.on('data', (d) => {
        stdout += d; logStream?.write(d);
        pending += d;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) for (const e of codexToolEvents(parseLine(line))) sink.emit(e);
      });
      child.stderr.on('data', (d) => { stderr += d; logStream?.write(d); });
      child.stdin.on('error', () => { /* codex exited before reading the prompt; close reports it */ });
      child.stdin.end(spawnReq.prompt);
      child.on('error', (err) => finish({ outcome: 'failed', text: `could not run ${bin}: ${err.message}. Install the Codex CLI or set CODEX_BIN.`, usage: null, costUsd: null }));
      child.on('close', (code) => {
        const parsed = parseCodexStream(stdout).outcome;
        if (code !== 0 && !parsed) return finish({ outcome: 'failed', text: stderr.trim().split('\n').slice(-5).join('\n') || `exited ${code} with no result`, usage: null, costUsd: null });
        finish(parsed);
      });
    });
    return done ?? { outcome: 'failed', text: 'no result in codex output', usage: null, costUsd: null };
  }
}

type Json = Record<string, unknown>;
export interface CodexEvent { kind: 'tool:post' | 'tool:denied'; payload: Record<string, unknown> }

function parseLine(line: string): Json | null {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  try { return JSON.parse(s) as Json; } catch { return null; }
}

/** What a sandbox refusal looks like from inside a command (macOS seatbelt, Linux landlock/RO mounts). */
const SANDBOX_DENIED = /operation not permitted|read-only file system|permission denied/i;

/**
 * One JSONL event -> ASF tool events. A completed command_execution/file_change is a
 * `tool:post`; one the sandbox refused is a `tool:denied` instead. A denial is
 * recorded only: it never changes the outcome — the agent's own NEEDS_HUMAN decides.
 */
export function codexToolEvents(o: Json | null): CodexEvent[] {
  if (!o || o.type !== 'item.completed' || !o.item || typeof o.item !== 'object') return [];
  const item = o.item as Json;
  if (item.type === 'command_execution') {
    const summary = String(item.command ?? '');
    const failed = item.status === 'declined' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
    if (item.status === 'declined' || (failed && SANDBOX_DENIED.test(String(item.aggregated_output ?? '')))) {
      return [{ kind: 'tool:denied', payload: { tool: 'command_execution', summary, reason: lastLine(String(item.aggregated_output ?? '')) || 'declined by the sandbox' } }];
    }
    return [{ kind: 'tool:post', payload: { tool: 'command_execution', summary, ok: !failed && item.status !== 'failed' } }];
  }
  if (item.type === 'file_change') {
    const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : [];
    const summary = changes.map((c) => `${String(c.kind ?? 'update')} ${String(c.path ?? '')}`).join(', ');
    if (item.status === 'declined') return [{ kind: 'tool:denied', payload: { tool: 'file_change', summary, reason: 'declined by the sandbox' } }];
    return [{ kind: 'tool:post', payload: { tool: 'file_change', summary, ok: item.status !== 'failed' } }];
  }
  return [];
}

function lastLine(s: string): string {
  return s.trim().split('\n').pop()?.slice(0, 300) ?? '';
}

/**
 * The whole `codex exec --json` stdout -> an outcome plus the tool events it carried.
 * Usage is summed over every turn.completed (cached input is reported inside
 * input_tokens, so it is split out into cacheReadTokens). The last agent_message is
 * the role's final text, read with the shared NEEDS_HUMAN/DISPUTE protocol. A
 * turn.failed, or an `error` no later turn completed past (Codex emits transient
 * "Reconnecting..." errors it recovers from), is a failed segment. null = no result.
 */
export function parseCodexStream(stdout: string): { outcome: AgentOutcome | null; events: CodexEvent[] } {
  const events: CodexEvent[] = [];
  let input = 0; let cached = 0; let written = 0; let output = 0;
  let turns = 0;
  let lastMessage: string | null = null;
  let failure: { text: string; reason: string } | null = null;
  for (const line of stdout.split('\n')) {
    const o = parseLine(line);
    if (!o) continue;
    events.push(...codexToolEvents(o));
    if (o.type === 'turn.completed') {
      turns++; failure = null;
      const u = (o.usage ?? {}) as Record<string, number>;
      input += Number(u.input_tokens ?? 0); cached += Number(u.cached_input_tokens ?? 0); written += Number(u.cache_write_input_tokens ?? 0); output += Number(u.output_tokens ?? 0);
    } else if (o.type === 'turn.failed') {
      failure = { text: String((o.error as Json | undefined)?.message ?? 'codex turn failed'), reason: 'turn.failed' };
    } else if (o.type === 'error') {
      failure = { text: String(o.message ?? 'codex reported an error'), reason: 'error' };
    } else if (o.type === 'item.completed' && (o.item as Json | undefined)?.type === 'agent_message') {
      lastMessage = String((o.item as Json).text ?? '');
    }
  }
  const usage: AgentUsage | null = input || output
    ? { inputTokens: Math.max(0, input - cached - written), outputTokens: output, cacheReadTokens: cached, cacheWriteTokens: written }
    : null;
  const meta = { usage, costUsd: null, turns };
  if (failure) return { outcome: { outcome: 'failed', text: failure.text, terminalReason: failure.reason, ...meta }, events };
  if (lastMessage === null && turns === 0) return { outcome: null, events };
  return { outcome: { ...outcomeFromText(lastMessage ?? ''), terminalReason: 'turn.completed', ...meta }, events };
}
