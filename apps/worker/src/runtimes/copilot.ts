import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { AgentOutcome, AgentRuntime, AgentSpawn, EventSink, PreflightResult, RunAuth, RunControl, RuntimeCapabilities, ToolPolicy } from '@asf/shared';
import { config } from '../config.js';
import { applyAuth } from '../auth/index.js';
import type { RuntimeTaskOptions } from './index.js';
import { killTree, spawnAgent } from './proc.js';
import { outcomeFromText } from './outcome.js';

/**
 * Copilot's tools to exclude for a neutral ToolPolicy. Copilot has no path-scoped
 * write permission to map a read-only role onto (a reader must still write its
 * run-dir artifact), so where it writes is held by the container and the worker's
 * post-run audit, not by a flag.
 */
export function copilotExcludedTools(policy: ToolPolicy): string[] {
  const excluded: string[] = [];
  if (!policy.shell) excluded.push('shell');
  if (!policy.network) excluded.push('web_fetch');
  return excluded;
}

/**
 * The `copilot` argv for one role. -p runs one prompt non-interactively; --silent
 * prints only the agent's reply (the text the NEEDS_HUMAN protocol reads).
 * --allow-all-tools is required headless (nobody answers a tool prompt); the policy
 * narrows it with --excluded-tools, and `git push` is always denied (the worker
 * pushes). --add-dir lets every role write its artifact under the run dir.
 */
export function buildCopilotArgs(spawnReq: AgentSpawn): string[] {
  const args = ['-p', spawnReq.prompt, '--silent', '--no-color', '--allow-all-tools'];
  const excluded = copilotExcludedTools(spawnReq.policy);
  if (excluded.length) args.push(`--excluded-tools=${excluded.join(',')}`);
  args.push('--deny-tool', 'shell(git push)');
  if (spawnReq.env.ASF_RUN_DIR) args.push('--add-dir', spawnReq.env.ASF_RUN_DIR);
  if (spawnReq.model) args.push('--model', spawnReq.model);
  return args;
}

/**
 * GitHub Copilot CLI, headless. Plain text out: no event stream, no tool hooks, no
 * token usage — so it is silent while it works (segment.ts posts a heartbeat) and
 * its runs are unpriced (plan-billed; Admin counts them). No OS sandbox either, so
 * only a containerised worker offers it.
 */
export class CopilotRuntime implements AgentRuntime {
  readonly kind = 'copilot';
  readonly capabilities: RuntimeCapabilities = { toolHooks: false, eventStream: false, reportsCost: false, listsModels: false, confinesWrites: false };
  constructor(private readonly opts: RuntimeTaskOptions & { bin?: string } = {}) {}
  private get bin(): string { return this.opts.bin ?? config.copilotBin; }

  async probe(): Promise<{ ok: boolean; version: string; models: string[] }> {
    return new Promise((resolve) => {
      const child = spawn(this.bin, ['--version']);
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', () => resolve({ ok: false, version: 'not found', models: [] }));
      child.on('close', (code) => resolve({ ok: code === 0, version: out.trim().split('\n')[0] || 'unknown', models: [] }));
    });
  }

  /** One trivial prompt through the real binary with this auth — the same call a role makes. */
  async preflight(auth: RunAuth): Promise<PreflightResult> {
    const env = applyAuth(process.env, auth);
    try {
      const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolveP, rejectP) => {
        const child = spawn(this.bin, ['-p', 'Reply with exactly: pong', '--silent', '--no-color'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; let err = '';
        child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
        const t = setTimeout(() => { child.kill('SIGKILL'); rejectP(new Error('timed out after 60s')); }, 60_000);
        child.on('error', (e) => { clearTimeout(t); rejectP(e); });
        child.on('close', (c) => { clearTimeout(t); resolveP({ stdout: out, stderr: err, code: c }); });
      });
      if (code !== 0 || !stdout.trim()) return { ok: false, reason: `exit ${code}: ${(stderr || stdout).trim().split('\n').pop()?.slice(0, 300) || 'no output'}` };
      return { ok: true, detail: 'no per-run cost figure (Copilot plan)' };
    } catch (e) {
      return { ok: false, reason: `could not run ${this.bin}: ${(e as Error).message}` };
    }
  }

  run(spawnReq: AgentSpawn, sink: EventSink, ctl?: RunControl): Promise<AgentOutcome> {
    const bin = this.bin;
    const args = buildCopilotArgs(spawnReq);
    return new Promise((resolve) => {
      // Credentials are set/stripped by the auth layer; this file never spells a credential name.
      const env = applyAuth({ ...process.env, ...spawnReq.env }, spawnReq.auth);
      // detached: copilot leads its own process group so a cancel/timeout kills every command it started.
      const child = spawnAgent(bin, args, { cwd: spawnReq.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const logStream = this.opts.logPath ? createWriteStream(this.opts.logPath, { flags: 'a' }) : null;
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (o: AgentOutcome) => {
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

      child.stdout.on('data', (d) => { stdout += d; logStream?.write(d); });
      child.stderr.on('data', (d) => { stderr += d; logStream?.write(d); });
      child.on('error', (err) => finish({ outcome: 'failed', text: `could not run ${bin}: ${err.message}. Install the Copilot CLI or set COPILOT_BIN.`, usage: null, costUsd: null }));
      child.on('close', (code) => finish(copilotOutcome(code, stdout, stderr)));
    });
  }
}

/** Exit code + text -> an outcome. Copilot reports no usage or cost, so both are null (unpriced). */
export function copilotOutcome(code: number | null, stdout: string, stderr: string): AgentOutcome {
  const text = stdout.trim();
  const meta = { usage: null, costUsd: null };
  if (code !== 0) return { outcome: 'failed', text: stderr.trim().split('\n').slice(-5).join('\n') || text.split('\n').slice(-5).join('\n') || `exited ${code} with no result`, terminalReason: `exit ${code}`, ...meta };
  if (!text) return { outcome: 'failed', text: 'copilot exited without a reply', terminalReason: 'exit 0', ...meta };
  return { ...outcomeFromText(text), terminalReason: 'exit 0', ...meta };
}
