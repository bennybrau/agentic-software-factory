import type { ArtifactWire, Run, TicketProvider } from '@asf/shared';
import { registry } from './registry/client.js';
import { cfg } from './settings.js';
import { ticketsFor } from './tickets/route.js';
import { resolveProviderSecret } from './providers/secrets.js';

type Log = { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

/**
 * The Hive hook (#76). Each succeeded run becomes one Hive "episode" — the
 * ticket, its pull request and the plan and review the agents wrote — so Hive
 * can recall what the factory has already done. The api never hears about a
 * finished run directly, so (like the merge-watcher) it polls the registry and
 * sends whatever finished since it last looked. It runs beside the orchestrator,
 * never inside it: a Hive outage can only cost an episode, never a run.
 *
 * Sent state is in memory. After a restart the last day is sent again, which is
 * harmless because Hive dedupes on `ref` (the run id). Blank HIVE_URL = off.
 */
export interface HiveEpisode { kind: 'asf_run'; repo_key: string; ref: string; content: string }

export const HIVE_TICK_MS = 60_000;
/** On boot, look back this far so a run that finished while the api was down is still sent. */
export const HIVE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** A run whose episode fails this many times is given up on (logged), not retried forever. */
export const HIVE_MAX_ATTEMPTS = 5;

/** `gh/<owner/repo>` or `gl/<group/repo>`; null for a run with no repo (it is skipped). */
export function repoKey(run: Run): string | null {
  if (!run.repoId) return null;
  return `${cfg('SCM_PROVIDER') === 'gitlab' ? 'gl' : 'gh'}/${run.repoId}`;
}

/** The episode for one run: a heading, the PR link, then the latest plan.md and review.md. */
export function buildEpisode(run: Run, artifacts: ArtifactWire[], title: string): HiveEpisode | null {
  const repo_key = repoKey(run);
  if (!repo_key) return null;
  const latest = (name: string) => artifacts.find((a) => a.name === name)?.content.trim();
  const parts = [`# ${run.ticketKey}: ${title}`];
  if (run.changeRequestUrl) parts.push(`Pull request: ${run.changeRequestUrl}`);
  const plan = latest('plan.md');
  if (plan) parts.push(`## Plan\n\n${plan}`);
  const review = latest('review.md');
  if (review) parts.push(`## Review\n\n${review}`);
  return { kind: 'asf_run', repo_key, ref: run.id, content: parts.join('\n\n') + '\n' };
}

/** Ticket title from the tracker; the ticket key when the tracker can't be read. */
async function ticketTitle(tracker: TicketProvider, run: Run): Promise<string> {
  try { return (await ticketsFor(tracker, run.ticketId).get(run.ticketId)).title; }
  catch { return run.ticketKey; }
}

/** Read what a run's episode needs from the registry and tracker. Null = nothing to send. */
export async function episodeFor(tracker: TicketProvider, run: Run): Promise<HiveEpisode | null> {
  if (!repoKey(run)) return null;
  const [{ artifacts }, title] = await Promise.all([registry.listArtifacts(run.id), ticketTitle(tracker, run)]);
  return buildEpisode(run, artifacts, title);
}

/** POST one episode to Hive. Throws on a network error or a non-2xx answer. */
export async function sendEpisode(episode: HiveEpisode): Promise<void> {
  const base = String(cfg('HIVE_URL') ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('HIVE_URL is blank');
  const token = (await resolveProviderSecret(String(cfg('HIVE_TOKEN') ?? ''))).trim();
  const res = await fetch(`${base}/v1/episodes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(episode),
  });
  if (!res.ok) throw new Error(`Hive answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

export function hiveEnabled(): boolean {
  return String(cfg('HIVE_URL') ?? '').trim() !== '';
}

/** Every succeeded run, a page at a time (listRuns orders by created_at, not finished_at). */
export async function listSucceededRuns(pageSize = 500): Promise<Run[]> {
  const out: Run[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { runs, total } = await registry.listRuns({ state: 'succeeded', limit: pageSize, offset });
    out.push(...runs);
    if (runs.length < pageSize || out.length >= total) return out;
  }
}

/** What the hook remembers between ticks (in memory only). */
export interface HiveHookState { since: number; sent: Set<string>; attempts: Map<string, number>; gaveUp: Set<string> }

export function newHiveHookState(now = Date.now()): HiveHookState {
  return { since: now - HIVE_LOOKBACK_MS, sent: new Set(), attempts: new Map(), gaveUp: new Set() };
}

/**
 * One tick: send every succeeded run that finished since `state.since` and has
 * not been sent yet. A failure is logged and retried next tick, up to
 * HIVE_MAX_ATTEMPTS; never thrown. Returns how many episodes were sent.
 */
export async function tickHive(deps: { tickets: TicketProvider }, state: HiveHookState, log: Log): Promise<number> {
  if (!hiveEnabled()) return 0;
  const runs = (await listSucceededRuns()).filter((r) =>
    r.finishedAt != null && Date.parse(r.finishedAt) >= state.since && !state.sent.has(r.id) && !state.gaveUp.has(r.id));
  let sent = 0;
  for (const run of runs) {
    try {
      const episode = await episodeFor(deps.tickets, run);
      if (episode) { await sendEpisode(episode); sent += 1; log.info({ runId: run.id, ticket: run.ticketKey }, 'hive: episode sent'); }
      state.sent.add(run.id); // a run with no repo is "done" too: nothing to send
      state.attempts.delete(run.id);
    } catch (err) {
      const n = (state.attempts.get(run.id) ?? 0) + 1;
      state.attempts.set(run.id, n);
      if (n >= HIVE_MAX_ATTEMPTS) {
        state.gaveUp.add(run.id);
        state.attempts.delete(run.id);
        log.error({ runId: run.id, attempts: n, err: (err as Error).message }, 'hive: giving up on this run');
      } else {
        log.error({ runId: run.id, attempt: n, err: (err as Error).message }, 'hive: send failed; will retry');
      }
    }
  }
  return sent;
}

export function startHiveHook(deps: { tickets: TicketProvider }, log: Log): () => void {
  const state = newHiveHookState();
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap ticks
    running = true;
    try { await tickHive(deps, state, log); }
    catch (err) { log.error({ err: (err as Error).message }, 'hive tick failed'); }
    finally { running = false; }
  }, HIVE_TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Backfill: every succeeded run that finished at or after `since`, oldest
 * first, about `perSecond` a second. `dryRun` sends nothing and only totals the
 * run count and episode bytes. Per-run failures are counted, not thrown.
 */
export async function backfillHive(
  deps: { tickets: TicketProvider },
  opts: { since?: number; dryRun?: boolean; perSecond?: number; sleep?: (ms: number) => Promise<void> },
  log: Log,
): Promise<{ runs: number; bytes: number; sent: number; failed: number }> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const gap = 1000 / (opts.perSecond ?? 3);
  const runs = (await listSucceededRuns())
    .filter((r) => r.finishedAt != null && (opts.since == null || Date.parse(r.finishedAt) >= opts.since))
    .sort((a, b) => Date.parse(a.finishedAt!) - Date.parse(b.finishedAt!));
  const out = { runs: 0, bytes: 0, sent: 0, failed: 0 };
  for (const run of runs) {
    let episode: HiveEpisode | null;
    try { episode = await episodeFor(deps.tickets, run); }
    catch (err) { out.failed += 1; log.error({ runId: run.id, err: (err as Error).message }, 'hive backfill: could not build episode'); continue; }
    if (!episode) continue;
    out.runs += 1;
    out.bytes += Buffer.byteLength(JSON.stringify(episode));
    if (opts.dryRun) continue;
    if (out.sent + out.failed > 0) await sleep(gap);
    try { await sendEpisode(episode); out.sent += 1; log.info({ runId: run.id, ticket: run.ticketKey }, 'hive backfill: sent'); }
    catch (err) { out.failed += 1; log.error({ runId: run.id, err: (err as Error).message }, 'hive backfill: send failed'); }
  }
  return out;
}
