import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from '@asf/shared';

/**
 * AGENT_RUNTIMES (comma list), else the deprecated single AGENT_RUNTIME, else the
 * default. The alias is read only when AGENT_RUNTIMES is unset, with a warning.
 */
export function agentRuntimes(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = console.warn): string[] {
  const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const legacy = !env.AGENT_RUNTIMES?.trim() && env.AGENT_RUNTIME?.trim();
  if (!legacy) return [...new Set(split(resolve('AGENT_RUNTIMES', env)))];
  // Every .env written before AGENT_RUNTIMES existed carries AGENT_RUNTIME=claude-code
  // (it was the only agent, so setup.sh wrote the default). Reading it as "only this
  // one" would hide Codex from every upgraded install until someone edits .env. So the
  // legacy value only puts its runtime first; the rest of the shipped runtimes still
  // follow, and each is offered only once its auth preflight passes. To really
  // restrict a worker to one agent, set AGENT_RUNTIMES.
  warn(`AGENT_RUNTIME is deprecated and no longer limits this worker to ${legacy}; it now offers every agent that is connected. To restrict it, set AGENT_RUNTIMES=${legacy}`);
  return [...new Set([legacy, ...split(resolve('AGENT_RUNTIMES', {}))])];
}

/** Is this worker itself a container (/.dockerenv, or ASF_IN_CONTAINER=1 for runtimes that don't write it)? */
export function inContainer(env: NodeJS.ProcessEnv = process.env, dockerenv = existsSync('/.dockerenv')): boolean {
  return dockerenv || env.ASF_IN_CONTAINER === '1';
}

/**
 * Codex's own sandbox for this worker: `off` inside a container (its bubblewrap
 * sandbox cannot start under Docker's default seccomp profile, and the container
 * is the sandbox), `workspace-write` on a bare host. CODEX_SANDBOX pins it.
 */
export function codexSandboxMode(env: NodeJS.ProcessEnv = process.env, dockerenv = existsSync('/.dockerenv')): 'workspace-write' | 'off' {
  const v = resolve('CODEX_SANDBOX', env);
  if (v === 'workspace-write' || v === 'off') return v;
  return inContainer(env, dockerenv) ? 'off' : 'workspace-write';
}

/** All values via the settings catalogue (packages/shared/src/settings.ts). */
const strip = (u: string) => u.replace(/\/+$/, '');

export const config = {
  id: resolve('WORKER_ID') || `worker-${hostname()}-${process.pid}`,
  host: hostname(),
  registryUrl: strip(resolve('REGISTRY_URL')),
  bffUrl: strip(resolve('BFF_URL') || resolve('API_URL')),
  runEventSecret: resolve('RUN_EVENT_SECRET'),
  /** The runtimes this worker offers, in preference order (AGENT_RUNTIMES, or the deprecated AGENT_RUNTIME). */
  runtimes: agentRuntimes(),
  /** AGENT_PROVIDERS: limit the providers offered (M11 WP4); [] = every one that passes. */
  providers: resolve('AGENT_PROVIDERS', process.env).split(',').map((x) => x.trim()).filter(Boolean),
  agentAuthMode: resolve('AGENT_AUTH_MODE'),
  claudeBin: resolve('CLAUDE_BIN'),
  codexBin: resolve('CODEX_BIN'),
  codexSandbox: codexSandboxMode(),
  opencodeBin: resolve('OPENCODE_BIN'),
  copilotBin: resolve('COPILOT_BIN'),
  inContainer: inContainer(),
  maxConcurrent: resolve('WORKER_MAX_CONCURRENT'),
  pollIntervalMs: resolve('WORKER_POLL_INTERVAL_MS'),
  heartbeatIntervalMs: resolve('WORKER_HEARTBEAT_INTERVAL_MS'),
  /** A runtime whose auth preflight failed is re-tried at least this often (sooner when the api's view of its provider changes). */
  authRecheckMs: 10 * 60_000,
  /** While no runtime is offered yet, how often to ask the api whether an AI has been connected. */
  authWaitPollMs: 15_000,
  /** M9 #2: how often the Google login is re-checked in vertex mode (a token refresh, no model call). */
  googleLoginRecheckMs: resolve('AGENT_AUTH_RECHECK_MS'),
  /** How often an idle worker asks the api for a queued Vertex check (M9). */
  vertexCheckPollMs: 3_000,
  segmentTimeoutMs: resolve('SEGMENT_TIMEOUT_MS'),
  maxTurns: resolve('WORKER_MAX_TURNS'),
  dryRun: resolve('WORKER_DRY_RUN'),
  worktreeRoot: resolve('WORKTREE_ROOT') || join(tmpdir(), 'asf-worktrees'),
  runDataRoot: resolve('RUN_DATA_ROOT') || join(tmpdir(), 'asf-runs'),
  /** How often a running segment asks the api whether its run was cancelled (M8 WP A). */
  cancelPollMs: 5000,
  claudeExtraArgs: resolve('CLAUDE_EXTRA_ARGS').split(' ').filter(Boolean),
  codexExtraArgs: resolve('CODEX_EXTRA_ARGS').split(' ').filter(Boolean),  /** Health listener for container platforms that require one; 0 = off. PORT (PaaS) turns it on. */
  healthPort: process.env.PORT ? Number(process.env.PORT) : 0,
};

export function ephemeralSecret(): string {
  return config.runEventSecret || randomBytes(16).toString('hex');
}
