import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { AgentOutcome, AgentRuntime, AgentSpawn, AgentUsage, EventSink, PreflightResult, RunAuth, RunControl, RuntimeCapabilities, ToolPolicy } from '@asf/shared';
import { config } from '../config.js';
import { applyAuth } from '../auth/index.js';
import { killTree, spawnAgent } from './proc.js';
import { outcomeFromText } from './outcome.js';

/**
 * Claude Code's tool names for a neutral ToolPolicy. Every role gets the editing
 * tools: a read-only role must still write its artifact (plan.md, review.md) under
 * the run dir, and WHERE it may write (worktree vs run dir only) is enforced by the
 * PreToolUse hook, not the allowlist — denying Write outright made a read-only
 * planner unable to write its plan. `gitPush` is enforced by the credential-less
 * worktree remote + the hook's Bash regex, so it maps to no flag.
 */
const CLAUDE_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
export function claudeTools(policy: ToolPolicy): { allowed: string[]; denied: string[] } {
  const allowed = ['Read', 'Grep', 'Glob'];
  const denied: string[] = [];
  (policy.shell ? allowed : denied).push('Bash');
  (policy.network ? allowed : denied).push('WebFetch', 'WebSearch');
  allowed.push('TodoWrite', ...CLAUDE_WRITE_TOOLS);
  return { allowed, denied };
}

/**
 * The `claude` argv for one role. Extracted so it is unit-testable: the model
 * and the --max-turns backstop are the two knobs a run controls. `--max-turns`
 * is omitted when maxTurns is falsy (0 = no ceiling).
 */
export function buildArgs(spawnReq: AgentSpawn, settingsPath: string | undefined, extraArgs: string[]): string[] {
  const args = ['-p', spawnReq.prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits'];
  if (settingsPath) args.push('--settings', settingsPath);
  const tools = claudeTools(spawnReq.policy);
  if (tools.allowed.length) args.push('--allowedTools', tools.allowed.join(','));
  if (tools.denied.length) args.push('--disallowedTools', tools.denied.join(' '));
  if (spawnReq.model) args.push('--model', spawnReq.model);
  if (spawnReq.effort) args.push('--effort', spawnReq.effort);
  if (spawnReq.maxTurns && spawnReq.maxTurns > 0) args.push('--max-turns', String(spawnReq.maxTurns));
  // Continue an earlier session (the planner chat's next turn): -p is then just the new message.
  if (spawnReq.resumeSessionId) args.push('--resume', spawnReq.resumeSessionId);
  args.push(...extraArgs);
  return args;
}

/**
 * Claude Code, headless. `claude -p <prompt> --output-format json --settings
 * <hooks file> --permission-mode acceptEdits --allowedTools ... [--model ...]`.
 * Everything Claude-Code-specific — the flags, the result envelope, the usage
 * fields — is confined to this file, so a second runtime is a sibling here.
 */
export interface ClaudeCodeOptions {
  bin?: string;
  settingsPath?: string;   // per-task hooks settings; written by the caller
  logPath?: string;        // transcript sink (line-buffered, as it happens)
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly kind = 'claude-code';
  /** Hooks (scope/telemetry/cancel per tool) + a JSON result envelope with total_cost_usd.
   * No streaming event feed is tailed (--output-format json, not stream-json). The
   * PreToolUse hook blocks an out-of-scope write before it happens (confinesWrites). */
  readonly capabilities: RuntimeCapabilities = { toolHooks: true, eventStream: false, reportsCost: true, listsModels: false, resumesSessions: true, confinesWrites: true, loadsSkillFiles: true };

  /**
   * One trivial prompt through the real binary with this auth — the same call a
   * role makes. stdin ignored (the prompt is on -p; an open stdin makes Claude Code
   * wait). A non-zero exit still usually carries the JSON envelope, and its
   * `result` is the reason a person needs ("OAuth access token is invalid").
   */
  async preflight(auth: RunAuth): Promise<PreflightResult> {
    const env = applyAuth(process.env, auth);
    const bin = this.opts.bin ?? 'claude';
    try {
      const result = await new Promise<{ is_error?: boolean; result?: string; total_cost_usd?: number }>((resolveP, rejectP) => {
        const child = spawn(bin, ['-p', 'Reply with exactly: pong', '--output-format', 'json', '--max-turns', '1'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; let err = '';
        child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
        const t = setTimeout(() => { child.kill('SIGKILL'); rejectP(new Error('timed out after 60s')); }, 60_000);
        child.on('error', (e) => { clearTimeout(t); rejectP(e); });
        child.on('close', (code) => {
          clearTimeout(t);
          const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
          if (line) { try { return resolveP(JSON.parse(line)); } catch { /* fall through */ } }
          rejectP(new Error(`exit ${code}: ${(err || out).trim().split('\n').filter((l) => !l.startsWith('Warning: no stdin')).join(' ').slice(0, 300) || 'no output'}`));
        });
      });
      if (result.is_error) return { ok: false, reason: String(result.result ?? 'agent returned is_error') };
      const billing = typeof result.total_cost_usd === 'number' && result.total_cost_usd > 0 ? 'metered' : 'no per-run cost figure (plan/flat)';
      return { ok: true, detail: billing };
    } catch (e) {
      return { ok: false, reason: `could not run ${bin}: ${(e as Error).message}` };
    }
  }
  constructor(private readonly opts: ClaudeCodeOptions = {}) {}

  async probe(): Promise<{ ok: boolean; version: string; models: string[] }> {
    return new Promise((resolve) => {
      const child = spawn(this.opts.bin ?? config.claudeBin, ['--version']);
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', () => resolve({ ok: false, version: 'not found', models: [] }));
      child.on('close', (code) => resolve({ ok: code === 0, version: out.trim() || 'unknown', models: [] }));
    });
  }

  run(spawnReq: AgentSpawn, sink: EventSink, ctl?: RunControl): Promise<AgentOutcome> {
    const bin = this.opts.bin ?? config.claudeBin;
    const args = buildArgs(spawnReq, this.opts.settingsPath, config.claudeExtraArgs);

    return new Promise((resolve) => {
      // stdin ignored: the prompt is passed via -p, and an open stdin makes Claude Code wait for piped input.
      // Auth env (mode additions + api-key injection / subscription strip) is built in the auth layer from the
      // run's effective auth, not here — the runtime never spells a credential name.
      const env = applyAuth({ ...process.env, ...spawnReq.env }, spawnReq.auth);
      // detached: the agent leads its own process group, so a cancel/timeout kills the
      // whole tree (Bash tool children, test runners) — not just the `claude` parent.
      const child = spawnAgent(bin, args, { cwd: spawnReq.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const logStream = this.opts.logPath ? createWriteStream(this.opts.logPath, { flags: 'a' }) : null;
      let stdout = '';
      let stderr = '';
      let settled = false;
      const onAbort = () => {
        sink.emit({ kind: 'segment:cancelled', payload: { by: 'operator' } });
        killTree(child);
        finish({ outcome: 'failed', text: 'run cancelled by the operator', usage: null, costUsd: null, terminalReason: 'cancelled' });
      };
      const finish = (o: AgentOutcome) => {
        if (settled) return; settled = true; clearTimeout(timer); ctl?.signal.removeEventListener('abort', onAbort); logStream?.end(); resolve(o);
      };

      const timer = setTimeout(() => {
        sink.emit({ kind: 'segment:timeout', payload: { timeoutMs: spawnReq.timeoutMs } });
        killTree(child);
        finish({ outcome: 'timeout', text: `no result within ${Math.round(spawnReq.timeoutMs / 60000)} min`, usage: null, costUsd: null });
      }, spawnReq.timeoutMs);
      if (ctl?.signal.aborted) onAbort();
      else ctl?.signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (d) => { stdout += d; logStream?.write(d); });
      child.stderr.on('data', (d) => { stderr += d; logStream?.write(d); });
      child.on('error', (err) => finish({ outcome: 'failed', text: `could not run ${bin}: ${err.message}. Install Claude Code or set CLAUDE_BIN.`, usage: null, costUsd: null }));
      child.on('close', (code) => {
        const parsed = parseResult(stdout);
        if (code !== 0 && !parsed) return finish({ outcome: 'failed', text: stderr.trim() || `exited ${code} with no result`, usage: null, costUsd: null });
        if (!parsed) return finish({ outcome: 'failed', text: 'no result envelope in output', usage: null, costUsd: null });
        finish(parsed);
      });
    });
  }
}

export type ParsedResult = AgentOutcome;

/**
 * The last JSON object with type:"result". A `result` text beginning
 * NEEDS_HUMAN: is the role's own signal that a person is needed — the same
 * protocol the prompts describe — and becomes outcome `needs_human`. is_error
 * true is a failed segment even when a result string is present.
 */
export function parseResult(stdout: string): ParsedResult | null {
  const objects = jsonCandidates(stdout);
  const result = [...objects].reverse().find((o) => o.type === 'result');
  if (!result) return null;
  const text = typeof result.result === 'string' ? result.result : '';
  const usage = parseUsage(result.usage);
  const costUsd = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null;
  const turns = typeof result.num_turns === 'number' ? result.num_turns : null;
  const terminalReason = typeof result.subtype === 'string' ? result.subtype
    : typeof result.terminal_reason === 'string' ? result.terminal_reason : null;
  const sessionId = typeof result.session_id === 'string' ? result.session_id : null;
  const meta = { usage, costUsd, turns, terminalReason, sessionId };
  if (result.is_error === true) {
    // Name the ceiling when the CLI stopped a still-working agent: `subtype:
    // "error_max_turns"` + stop_reason "tool_use" is not the agent erring, it is
    // MAX_TURNS_<ROLE> (or the WORKER_MAX_TURNS default) being too low for this role's
    // ticket. Twice this surfaced as an opaque "agent reported an error" while ~$2 of
    // edits sat uncommitted.
    if (result.subtype === 'error_max_turns' || /maximum number of turns/i.test(errorsText(result))) {
      const n = /\((\d+)\)/.exec(errorsText(result))?.[1];
      return { outcome: 'failed', text: `hit the ${n ? `${n}-turn` : 'turn'} ceiling while still working — raise MAX_TURNS_<ROLE> for this role (or the WORKER_MAX_TURNS default) in Settings or .env, or split the ticket`, ...meta };
    }
    return { outcome: 'failed', text: text || errorsText(result) || 'agent reported an error', ...meta };
  }
  return { ...outcomeFromText(text), ...meta };
}

function errorsText(result: Record<string, unknown>): string {
  return Array.isArray(result.errors) ? result.errors.map(String).join('; ') : '';
}

function jsonCandidates(stdout: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  // Whole-string first (the common --output-format json case), then line-delimited.
  const trimmed = stdout.trim();
  try { const o = JSON.parse(trimmed); return Array.isArray(o) ? o : [o]; } catch { /* fall through */ }
  for (const line of trimmed.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip partial line */ }
  }
  return out;
}

function parseUsage(u: unknown): AgentUsage | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, number>;
  const input = Number(o.input_tokens ?? 0);
  const output = Number(o.output_tokens ?? 0);
  if (!input && !output && !o.cache_read_input_tokens && !o.cache_creation_input_tokens) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: Number(o.cache_read_input_tokens ?? 0),
    cacheWriteTokens: Number(o.cache_creation_input_tokens ?? 0),
  };
}
