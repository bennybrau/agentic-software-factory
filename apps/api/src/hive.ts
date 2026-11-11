import { formatHiveBrief, nativeId } from '@asf/shared';
import type { ArtifactWire, HiveBrief, HiveDialogItem, ReferenceRepo, Run, RunTask, ScmProvider, Ticket, TicketProvider } from '@asf/shared';
import { registry } from './registry/client.js';
import { cfg } from './settings.js';
import { ticketsFor } from './tickets/route.js';
import { resolveProviderSecret } from './providers/secrets.js';

type Log = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

/**
 * The Hive hook (#76, #78). Each merged run becomes one Hive "episode" — the
 * ticket, its pull request and the plan and review the agents wrote, plus the
 * paths it changed — so Hive can recall what the factory has already landed.
 * The api never hears about a merge directly, so (like the merge-watcher) it
 * polls the registry and sends whatever merged since it last looked. It runs beside the orchestrator,
 * never inside it: a Hive outage can only cost an episode, never a run.
 *
 * Every note a person left at a gate, and every chat message they wrote, also
 * becomes an `asf_dialog` episode (what the agent said, then what they said),
 * whatever state the run ended in.
 *
 * A dialog turn that was sent is stamped in the registry (`hive_sent_at`) so the
 * web can say "Sent to team memory for review" (#108).
 *
 * Sent state is in memory. After a restart the last day is sent again, which is
 * harmless because Hive dedupes on `ref`. Blank HIVE_URL = off.
 */
export interface HiveRunEpisode {
  kind: 'asf_run'; repo_key: string; ref: string; content: string;
  metadata: { merged_at: string; pr_url: string | null; title: string; paths: string[] };
}
export interface HiveDialogEpisode {
  kind: 'asf_dialog'; repo_key: string; ref: string; content: string;
  metadata: { author: string | null };
}
export type HiveEpisode = HiveRunEpisode | HiveDialogEpisode;
/** A merged run as the registry hands it to the hook. */
export type MergedRun = Run & { mergedAt: string };

export const HIVE_TICK_MS = 60_000;
/** On boot, look back this far so a run that merged while the api was down is still sent. */
export const HIVE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** A run whose episode fails this many times is given up on (logged), not retried forever. */
export const HIVE_MAX_ATTEMPTS = 5;

/** `gh/<owner/repo>` or `gl/<group/repo>` (bare or qualified repoId alike); null for a run with no repo (it is skipped). */
export function repoKey(run: Pick<Run, 'repoId'>): string | null {
  if (!run.repoId) return null;
  return `${cfg('SCM_PROVIDER') === 'gitlab' ? 'gl' : 'gh'}/${nativeId(run.repoId)}`;
}

/** Most paths an episode carries. */
export const HIVE_MAX_PATHS = 500;

/** The episode for one run: a heading, the PR link, then the latest plan.md and review.md. */
export function buildEpisode(run: MergedRun, artifacts: ArtifactWire[], title: string, paths: string[] = []): HiveRunEpisode | null {
  const repo_key = repoKey(run);
  if (!repo_key) return null;
  const latest = (name: string) => artifacts.find((a) => a.name === name)?.content.trim();
  const parts = [`# ${run.ticketKey}: ${title}`];
  if (run.changeRequestUrl) parts.push(`Pull request: ${run.changeRequestUrl}`);
  const plan = latest('plan.md');
  if (plan) parts.push(`## Plan\n\n${plan}`);
  const review = latest('review.md');
  if (review) parts.push(`## Review\n\n${review}`);
  return {
    kind: 'asf_run', repo_key, ref: run.id, content: parts.join('\n\n') + '\n',
    metadata: { merged_at: run.mergedAt, pr_url: run.changeRequestUrl, title, paths: paths.slice(0, HIVE_MAX_PATHS) },
  };
}

const dialogRef = (d: HiveDialogItem) => `${d.runId}:${d.kind}:${d.id}`;

/** The episode for one human turn: `<runId>:gate:<id>` or `<runId>:msg:<id>`, the agent's words then theirs. */
export function buildDialogEpisode(item: HiveDialogItem): HiveDialogEpisode | null {
  const repo_key = repoKey(item);
  if (!repo_key) return null;
  return {
    kind: 'asf_dialog', repo_key, ref: dialogRef(item),
    content: `assistant: ${item.answer}\nuser: ${item.text}`, metadata: { author: item.author },
  };
}

/** Ticket title from the tracker; the ticket key when the tracker can't be read. */
async function ticketTitle(tracker: TicketProvider, run: Run): Promise<string> {
  try { return (await ticketsFor(tracker, run.ticketId).get(run.ticketId)).title; }
  catch { return run.ticketKey; }
}

/** The paths a run's change request touched; [] when the SCM can't say (an episode is still sent). */
export async function pathsFor(scm: ScmProvider, run: Run): Promise<string[]> {
  if (!scm.changedFiles || !run.repoId || run.changeRequestNumber == null) return [];
  try {
    const repo = await scm.getRepo(run.repoId);
    return (await scm.changedFiles(repo, run.changeRequestNumber, HIVE_MAX_PATHS)).slice(0, HIVE_MAX_PATHS);
  } catch { return []; }
}

export interface HiveDeps { tickets: TicketProvider; scm: ScmProvider }

/** Read what a run's episode needs from the registry, tracker and SCM. Null = nothing to send. */
export async function episodeFor(deps: HiveDeps, run: MergedRun): Promise<HiveRunEpisode | null> {
  if (!repoKey(run)) return null;
  const [{ artifacts }, title, paths] = await Promise.all([
    registry.listArtifacts(run.id), ticketTitle(deps.tickets, run), pathsFor(deps.scm, run),
  ]);
  return buildEpisode(run, artifacts, title, paths);
}

/** HIVE_URL without trailing slashes; '' = Hive is off. */
const hiveBase = () => String(cfg('HIVE_URL') ?? '').trim().replace(/\/+$/, '');

/** JSON headers, plus Authorization: Bearer when HIVE_TOKEN resolves to something. */
async function hiveHeaders(): Promise<Record<string, string>> {
  const token = (await resolveProviderSecret(String(cfg('HIVE_TOKEN') ?? ''))).trim();
  return { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

/** POST one episode to Hive. Throws on a network error or a non-2xx answer. */
export async function sendEpisode(episode: HiveEpisode): Promise<void> {
  const base = hiveBase();
  if (!base) throw new Error('HIVE_URL is blank');
  const res = await fetch(`${base}/v1/episodes`, { method: 'POST', headers: await hiveHeaders(), body: JSON.stringify(episode) });
  if (!res.ok) throw new Error(`Hive answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

export function hiveEnabled(): boolean {
  return hiveBase() !== '';
}

/** How long the context call waits for a briefing before going on without one. */
export const HIVE_BRIEF_TIMEOUT_MS = 2000;
/** Hive's limit on `task`. */
export const HIVE_BRIEF_MAX_TASK = 4000;
export const HIVE_BRIEF_BUDGET_TOKENS = 800;
/** Runs whose brief is remembered; the oldest is forgotten past this. */
const HIVE_BRIEF_CACHE_MAX = 500;

/**
 * The worker asks for the context on every step, so a run's brief is kept in memory, keyed
 * by how many chat re-plans the run has had: a reply to the planner fetches it again. Only a
 * successful answer is kept (an empty one too); a failure is tried again next step.
 */
const briefCache = new Map<string, { key: number; text: string }>();
/** Tests only. */
export function clearHiveBriefCache(): void { briefCache.clear(); }

/**
 * Hive's briefing on the ticket (#93), formatted for the planner's and implementer's prompt.
 * Undefined when Hive or HIVE_BRIEF is off, the run has no repo, or Hive fails or is slower
 * than HIVE_BRIEF_TIMEOUT_MS (one warning; the context is served without it).
 */
export async function fetchHiveBrief(
  got: { run: Pick<Run, 'id' | 'repoId'>; tasks: Pick<RunTask, 'role' | 'queuedBy'>[] },
  ticket: Pick<Ticket, 'title' | 'body'>,
  referenceRepos: ReferenceRepo[],
  log: { warn: (o: unknown, m?: string) => void },
  opts: { timeoutMs?: number } = {},
): Promise<string | undefined> {
  const base = hiveBase();
  const repo_key = repoKey(got.run);
  if (!base || !cfg('HIVE_BRIEF') || !repo_key) return undefined;
  const key = got.tasks.filter((t) => t.role === 'planner' && t.queuedBy === 'chat').length;
  const hit = briefCache.get(got.run.id);
  if (hit && hit.key === key) return hit.text || undefined;
  const also_repos = referenceRepos.map((r) => repoKey({ repoId: r.repo.path })).filter((k): k is string => !!k);
  const body = {
    task: `${ticket.title}\n\n${ticket.body}`.slice(0, HIVE_BRIEF_MAX_TASK),
    repo_key,
    ...(also_repos.length ? { also_repos } : {}),
    budget_tokens: HIVE_BRIEF_BUDGET_TOKENS,
  };
  try {
    const res = await fetch(`${base}/v1/brief`, {
      method: 'POST', headers: await hiveHeaders(), body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? HIVE_BRIEF_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Hive answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const text = formatHiveBrief((await res.json()) as HiveBrief);
    briefCache.delete(got.run.id);
    briefCache.set(got.run.id, { key, text });
    if (briefCache.size > HIVE_BRIEF_CACHE_MAX) briefCache.delete(briefCache.keys().next().value!);
    return text || undefined;
  } catch (err) {
    log.warn({ runId: got.run.id, err: (err as Error).message }, 'hive: no briefing for this step');
    return undefined;
  }
}

/** Every merged run (merged at or after `since`, if given), oldest merge first, a page at a time. */
export async function listMergedRuns(since?: number, pageSize = 500): Promise<MergedRun[]> {
  const out: MergedRun[] = [];
  const sinceIso = since == null ? undefined : new Date(since).toISOString();
  for (let offset = 0; ; offset += pageSize) {
    const { runs } = await registry.hiveMergedRuns({ since: sinceIso, limit: pageSize, offset });
    out.push(...runs);
    if (runs.length < pageSize) return out;
  }
}

/** Every human gate note and chat message (written at or after `since`, if given), oldest first, a page at a time. */
export async function listDialog(since?: number, pageSize = 500): Promise<HiveDialogItem[]> {
  const out: HiveDialogItem[] = [];
  const sinceIso = since == null ? undefined : new Date(since).toISOString();
  for (let offset = 0; ; offset += pageSize) {
    const { items } = await registry.hiveDialog({ since: sinceIso, limit: pageSize, offset });
    out.push(...items);
    if (items.length < pageSize) return out;
  }
}

/** What the hook remembers between ticks (in memory only). */
export interface HiveHookState { since: number; sent: Set<string>; attempts: Map<string, number>; gaveUp: Set<string> }

export function newHiveHookState(now = Date.now()): HiveHookState {
  return { since: now - HIVE_LOOKBACK_MS, sent: new Set(), attempts: new Map(), gaveUp: new Set() };
}

/**
 * Send one episode unless it is already sent or given up on (keyed by `key`).
 * A failure is logged and retried next tick, up to HIVE_MAX_ATTEMPTS; never
 * thrown. Returns whether an episode was sent.
 */
async function sendOnce(state: HiveHookState, key: string, ctx: object, build: () => Promise<HiveEpisode | null>, log: Log): Promise<boolean> {
  let sent = false;
  try {
    const episode = await build();
    if (episode) { await sendEpisode(episode); sent = true; log.info({ ...ctx, ref: episode.ref }, 'hive: episode sent'); }
    state.sent.add(key); // one with no repo is "done" too: nothing to send
    state.attempts.delete(key);
  } catch (err) {
    const n = (state.attempts.get(key) ?? 0) + 1;
    state.attempts.set(key, n);
    if (n >= HIVE_MAX_ATTEMPTS) {
      state.gaveUp.add(key);
      state.attempts.delete(key);
      log.error({ ...ctx, attempts: n, err: (err as Error).message }, 'hive: giving up on this episode');
    } else {
      log.error({ ...ctx, attempt: n, err: (err as Error).message }, 'hive: send failed; will retry');
    }
  }
  return sent;
}

/**
 * Stamp a sent dialog turn in the registry. A failure is only a warning: the
 * turn is already in `state.sent`, so it is never sent again for it.
 */
async function markSent(item: HiveDialogItem, log: Log): Promise<void> {
  try { await registry.markHiveSent(item.kind, item.id); }
  catch (err) { log.warn({ runId: item.runId, ref: dialogRef(item), err: (err as Error).message }, 'hive: could not mark as sent'); }
}

/**
 * One tick: send every run that merged, and every human dialog turn written,
 * since `state.since` that has not been sent yet. Returns how many episodes were sent.
 */
export async function tickHive(deps: HiveDeps, state: HiveHookState, log: Log): Promise<number> {
  if (!hiveEnabled()) return 0;
  const todo = (key: string) => !state.sent.has(key) && !state.gaveUp.has(key);
  const runs = (await listMergedRuns(state.since)).filter((r) => Date.parse(r.mergedAt) >= state.since && todo(r.id));
  let sent = 0;
  for (const run of runs) {
    if (await sendOnce(state, run.id, { runId: run.id, ticket: run.ticketKey }, () => episodeFor(deps, run), log)) sent += 1;
  }
  const dialog = (await listDialog(state.since)).filter((d) => Date.parse(d.at) >= state.since && todo(dialogRef(d)));
  for (const item of dialog) {
    if (await sendOnce(state, dialogRef(item), { runId: item.runId }, async () => buildDialogEpisode(item), log)) {
      sent += 1;
      await markSent(item, log);
    }
  }
  return sent;
}

export function startHiveHook(deps: HiveDeps, log: Log): () => void {
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
 * Backfill: every run that merged at or after `since`, oldest first, then every
 * human dialog turn written since then, about `perSecond` a second. `dryRun`
 * sends nothing and only totals the counts and episode bytes. Per-episode
 * failures are counted, not thrown. A dialog turn that is sent is marked sent.
 */
export async function backfillHive(
  deps: HiveDeps,
  opts: { since?: number; dryRun?: boolean; perSecond?: number; sleep?: (ms: number) => Promise<void> },
  log: Log,
): Promise<{ runs: number; dialog: number; bytes: number; sent: number; failed: number }> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const gap = 1000 / (opts.perSecond ?? 3);
  const after = (at: string) => opts.since == null || Date.parse(at) >= opts.since;
  const runs = (await listMergedRuns(opts.since))
    .filter((r) => after(r.mergedAt))
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  const out = { runs: 0, dialog: 0, bytes: 0, sent: 0, failed: 0 };
  /** Whether the episode was sent (never on a dry run). */
  const send = async (episode: HiveEpisode, ctx: object): Promise<boolean> => {
    out.bytes += Buffer.byteLength(JSON.stringify(episode));
    if (opts.dryRun) return false;
    if (out.sent + out.failed > 0) await sleep(gap);
    try { await sendEpisode(episode); out.sent += 1; log.info({ ...ctx, ref: episode.ref }, 'hive backfill: sent'); return true; }
    catch (err) { out.failed += 1; log.error({ ...ctx, ref: episode.ref, err: (err as Error).message }, 'hive backfill: send failed'); return false; }
  };
  for (const run of runs) {
    let episode: HiveEpisode | null;
    try { episode = await episodeFor(deps, run); }
    catch (err) { out.failed += 1; log.error({ runId: run.id, err: (err as Error).message }, 'hive backfill: could not build episode'); continue; }
    if (!episode) continue;
    out.runs += 1;
    await send(episode, { runId: run.id, ticket: run.ticketKey });
  }
  for (const item of (await listDialog(opts.since)).filter((d) => after(d.at))) {
    const episode = buildDialogEpisode(item);
    if (!episode) continue;
    out.dialog += 1;
    if (await send(episode, { runId: item.runId })) await markSent(item, log);
  }
  return out;
}
