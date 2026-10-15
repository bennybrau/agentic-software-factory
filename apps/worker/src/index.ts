/**
 * apps/worker — claims a task, runs one role, reports the outcome, repeats.
 *
 * Owns the credentialed and destructive parts: the git worktree, the
 * per-run clone credential from the api (never handed to the agent), spawning
 * the runtime. Reports facts; the registry derives state. Never connects to
 * Postgres — HTTP to the registry (fleet) and the api (work).
 */
import './boot-secrets.js';
import { createServer } from 'node:http';
import type { AgentRuntime, ProviderKind } from '@asf/shared';
import { config } from './config.js';
import { preflightAgentAuth } from './auth-preflight.js';
import { extraProviders, providerFor } from './auth/index.js';
import { preflightOllama } from './ollama-preflight.js';
import { api } from './api.js';
import { loadRuntime } from './runtimes/index.js';
import { runSegment, googleLogin } from './segment.js';
import { runPublish } from './publish.js';
import { RuntimeOffer, containerRefusal, type Preflight } from './offer.js';
import { mintToken, runVertexCheck } from './vertex-check.js';
import { LoginWatch } from './login-watch.js';

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), worker: config.id, msg, ...extra }));
}

let running = 0;
let stopping = false;
/** Tasks this worker is executing: a re-register lists them so the registry doesn't stale them. */
const inFlightIds = new Set<string>();
const inFlight = (): string[] => [...inFlightIds];

async function executeClaim(claim: NonNullable<Awaited<ReturnType<typeof api.claim>>>): Promise<void> {
  const { run, task } = claim;
  const rlog = (m: string) => log(m, { runId: run.id, taskId: task.id, role: task.role });
  try {
    const ctx = await api.context(run.id);
    if (String(task.runtime) === 'publish') {
      const pr = await runPublish(claim, ctx, rlog);
      await api.finish(task.id, { outcome: pr.outcome, outputRef: null, costUsd: pr.costUsd, reason: pr.reason });
      rlog(`publish ${task.role}: ${pr.outcome}`);
      return;
    }
    const result = await runSegment(claim, ctx, rlog);
    await api.finish(task.id, { outcome: result.outcome === 'timeout' ? 'failed' : result.outcome,
      outputRef: result.outputRef, costUsd: result.costUsd, reason: result.reason });
    rlog(`task ${result.outcome} ($${result.costUsd.toFixed(3)})`);
  } catch (err) {
    // Never a silent exit: a thrown error is a failed task with a reason, so the run does not hang.
    const reason = err instanceof Error ? err.message : String(err);
    rlog(`task errored: ${reason}`);
    await api.finish(task.id, { outcome: 'failed', outputRef: null, costUsd: 0, reason }).catch(() => {});
  }
}

async function pollOnce(runtimes: string[], capabilities: string[]): Promise<boolean> {
  if (stopping || running >= config.maxConcurrent || !runtimes.length) return false;
  const claim = await api.claim(runtimes, capabilities).catch((e) => { log(`claim failed: ${e}`); return null; });
  if (!claim) return false;
  running++; inFlightIds.add(claim.task.id);
  log('claimed', { runId: claim.run.id, role: claim.task.role, seq: claim.task.seq });
  void executeClaim(claim).finally(() => { running--; inFlightIds.delete(claim.task.id); });
  return true;
}

async function main(): Promise<void> {
  log('starting', { runtimes: config.runtimes, dryRun: config.dryRun, maxConcurrent: config.maxConcurrent });

  // Each runtime this worker is configured for is probed (installed?) and its auth
  // preflighted — before this worker offers capacity. A dead subscription login or a
  // missing API key shows up as "No worker connected", not as twenty failed runs.
  // The worker advertises the runtimes that pass and exits only if none do.
  // The effective auth mode is owned by the api (env > org > default), not the
  // worker's local env — so a UI-entered api-key (in the org secret sink, which
  // only the api can resolve) brings a fresh worker up with no restart. Ask the
  // api; fall back to the worker's local mode if the api is briefly unreachable.
  // M8 WP C: the api reports one status per model provider; each runtime is checked
  // against the provider it talks to, via the runtime's own preflight().
  // #163: a runtime whose preflight fails is kept pending and re-checked on the
  // heartbeat, so a key entered in Settings later brings it online with no restart
  // (see offer.ts). A worker with nothing offered yet waits instead of exiting.
  type Eff = Awaited<ReturnType<typeof api.agentAuth>>;
  let eff: Eff = await api.agentAuth();
  const effFor = (e: Eff, provider: ProviderKind) => e?.providers?.[provider] ?? (provider === 'anthropic' && e ? { mode: e.mode, credentialPresent: e.credentialPresent } : null);
  const fallbackMode = (p: ProviderKind) => (p === 'anthropic' ? config.agentAuthMode : 'unset');
  const probed: Array<{ runtime: AgentRuntime; provider: ProviderKind; version?: string }> = [];
  const missing: Array<{ kind: string; reason: string }> = [];
  for (const kind of config.runtimes) {
    let runtime: AgentRuntime;
    try { runtime = loadRuntime(kind); } catch (e) { log(`runtime ${kind}: ${(e as Error).message}`); missing.push({ kind, reason: (e as Error).message }); continue; }
    const refusal = containerRefusal(runtime.capabilities, config.inContainer);
    if (refusal) { log(`runtime ${kind} cannot confine its own writes and this worker is not a container; not offering it`); missing.push({ kind, reason: refusal }); continue; }
    const probe = await runtime.probe();
    log('runtime probe', { runtime: kind, ok: probe.ok, version: probe.version });
    if (!probe.ok) { log(`runtime ${kind} did not probe cleanly; not offering it`); missing.push({ kind, reason: 'not installed on this worker' }); continue; }
    // M11 WP4: also checked (and offered) under each extra provider it can drive, so an
    // Ollama-only worker offers claude-code@ollama though its Claude check fails.
    // AGENT_PROVIDERS, when set, limits which providers are offered at all.
    const providers = [providerFor(kind), ...extraProviders(kind)].filter((p) => !config.providers.length || config.providers.includes(p));
    if (!providers.length) { missing.push({ kind, reason: `AGENT_PROVIDERS=${config.providers.join(',')} leaves it no provider` }); continue; }
    for (const provider of providers) probed.push({ runtime, provider, version: probe.version || undefined });
  }
  if (!probed.length) { log(`no runtime is installed (tried ${config.runtimes.join(', ')}); exiting`); process.exit(1); }
  // Vertex checks (M9) run here, the only place with the Google login. Started before
  // the wait-for-an-AI loop below: a fresh worker is exactly where the first check runs.
  const claude = probed.find((p) => p.runtime.kind === 'claude-code');
  if (claude) startVertexChecks(claude.runtime);
  const preflight: Preflight = (rt, auth, o) => (auth.providerKind === 'ollama' ? preflightOllama(auth, o) : preflightAgentAuth(rt, auth, o));
  const offer = new RuntimeOffer(probed, preflight, log, config.authRecheckMs);
  for (const m of missing) offer.notInstalled(m.kind, m.reason);
  await offer.refresh((p) => effFor(eff, p), fallbackMode);
  while (!offer.kinds.length && !stopping) {
    log(`waiting for an AI to be connected in Settings → Which AI should do the work? (${offer.pending.join(', ')} not ready)`);
    await new Promise((r) => setTimeout(r, config.authWaitPollMs));
    eff = await api.agentAuth();
    await offer.refresh((p) => effFor(eff, p), fallbackMode);
  }
  const offered = offer.offered;
  // The fleet records one auth mode per worker: the first offered runtime's provider.
  const provider = offered[0].provider;

  // The mode this worker is registered under (the api's effective mode at boot,
  // updated live by reconcileAuthMode). /health and registration report it.
  let registeredAuthMode: string = offered[0].mode;

  // Container platforms need something listening; /health also answers "is this worker alive and what is it?"
  if (config.healthPort) {
    createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, id: config.id, runtime: offer.kinds[0], runtimes: offer.kinds, pendingRuntimes: offer.pending, authMode: registeredAuthMode, running, maxConcurrent: config.maxConcurrent, ...(loginWatch?.reason ? { googleLogin: loginWatch.reason } : {}) })); }
      else { res.writeHead(404); res.end(); }
    }).listen(config.healthPort, '0.0.0.0', () => log('health listener', { port: config.healthPort }));
  }

  // False after the registry says it doesn't know this worker (heartbeat 404: swept
  // after a pause, or a restarted registry): the next reconcile registers again.
  let registered = true;
  const loginWatch = new LoginWatch({
    check: async () => {
      const r = await mintToken();
      return r.ok ? { ok: true, ...(r.account ? { account: r.account } : {}) } : { ok: false, code: r.code, reason: r.reason, ...(r.kind ? { kind: r.kind } : {}) };
    },
    suspend: (reason) => { offer.suspend('anthropic', reason); },
    resume: () => { offer.resume('anthropic'); },
    record: (h) => api.recordLoginHealth(h),
    log, worker: config.id, intervalMs: config.googleLoginRecheckMs,
  });
  googleLogin.confirm = () => loginWatch.confirm();
  const { staled } = await api.register({ runtimes: offer.kinds, maxConcurrent: config.maxConcurrent, inFlightTaskIds: [], authMode: registeredAuthMode, preflight: offer.status });
  if (staled.length) log('staled runs this worker previously held', { staled });

  // On an org-side switch we re-register so the fleet view is honest. The real
  // credential test happens on the next spawn (which receives the resolved key via
  // the run context), so the health check here is cheap and never carries the key.
  async function reconcileAuthMode(): Promise<void> {
    const fresh = await api.agentAuth();
    if (fresh) eff = fresh;
    const cur = effFor(eff, provider);
    const modeChanged = !!cur && cur.mode !== registeredAuthMode;
    if (modeChanged) {
      log('agent auth mode changed; re-registering', { from: registeredAuthMode, to: cur.mode, credentialPresent: cur.credentialPresent });
      if (!cur.credentialPresent) log((cur as { error?: string }).error
        ? `warning: ${provider} ${cur.mode} credential is saved but unreadable: ${(cur as { error?: string }).error}`
        : `warning: ${provider} ${cur.mode} mode selected but its credential is not set; runs will fail until one is entered in Settings → Which AI should do the work?`);
    }
    const before = offer.kinds.join(',');
    // Google login (M9 #2) first: a login that came back is re-preflighted in the refresh below.
    // null = the api is unreachable: the mode is unknown, so an expiry is kept as is.
    const loginChanged = await loginWatch.tick(fresh ? (effFor(eff, 'anthropic')?.mode ?? null) : null);
    const changed = (await offer.refresh((p) => effFor(eff, p), fallbackMode)) || loginChanged;
    // Nothing passes its check any more (a new setup that fails, an expired login):
    // take no tasks (pollOnce gets no runtimes) but stay registered, under the runtimes
    // it is configured for, and keep heartbeating, so the setup checklist shows why
    // (each runtime's status says ok:false and the reason).
    const idle = !offer.kinds.length;
    if (idle && changed) log('no runtime passes its auth check; taking no tasks until one does', { status: offer.status.map((s) => ({ kind: s.kind, ok: s.ok, reason: s.reason })) });
    if (!modeChanged && !changed && registered) return;
    if (changed && !idle) log('offered runtimes changed; re-registering', { from: before, runtimes: offer.kinds });
    if (!registered) log('the registry no longer knows this worker; registering again');
    const authMode = modeChanged ? cur.mode : registeredAuthMode;
    await api.register({ runtimes: idle ? probed.map((p) => p.runtime.kind) : offer.kinds, maxConcurrent: config.maxConcurrent, inFlightTaskIds: inFlight(), authMode, preflight: offer.status })
      .then(() => { registered = true; }).catch((e) => log(`re-register failed: ${e}`));
    registeredAuthMode = authMode;
  }

  // These timers are what keep the process alive — deliberately NOT unref'd.
  const heartbeat = setInterval(() => {
    void api.heartbeat(offer.status).then((h) => { if (h === 'unknown') registered = false; }, () => {}).then(() => reconcileAuthMode());
  }, config.heartbeatIntervalMs);
  const poll = setInterval(() => { void (async () => { while (await pollOnce(offer.kinds, offer.capabilities)) { /* drain capacity */ } })(); }, config.pollIntervalMs);

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log('shutting down; deregistering');
    clearInterval(heartbeat); clearInterval(poll);
    await api.deregister();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void shutdown(); });
  log('registered; polling for tasks');
  // The non-unref'd interval timers keep the event loop alive.
}

/** Poll the api for queued Vertex checks and run them one at a time. */
function startVertexChecks(claudeRuntime: AgentRuntime): void {
  let busy = false;
  const tick = async () => {
    if (busy || stopping) return;
    busy = true;
    try {
      const job = await api.vertexCheckNext();
      if (!job) return;
      log('vertex check', { id: job.id, project: job.request.projectId, region: job.request.region, models: job.request.models.length });
      const result = await runVertexCheck(job.request, { claudeCode: (auth) => claudeRuntime.preflight(auth) });
      log('vertex check done', { id: job.id, ok: result.ok, login: result.login.code ?? 'ok', working: result.models.filter((m) => m.ok).map((m) => m.id) });
      await api.vertexCheckResult(job.id, result).catch((e) => log(`vertex check result not delivered: ${e}`));
    } catch (e) {
      log(`vertex check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { busy = false; }
  };
  setInterval(() => { void tick(); }, config.vertexCheckPollMs);
}

main().catch((err) => { log(`fatal: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
