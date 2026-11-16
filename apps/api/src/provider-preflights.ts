import type { TicketSet } from './providers/tickets/set.js';
import type { ScmSet } from './providers/scm/set.js';
import { orgSettingsLoaded } from './settings.js';

/**
 * The live tracker + SCM preflights of every connection (M12 WP4), shared by the
 * first-run checklist (routes/setup.ts), credential health (credential-health.ts)
 * and `/health`. A preflight is a round trip to Jira/GitHub/GitLab, so all the
 * results are cached together for a short window: a 10s poll resolves them at
 * most every ~30s.
 */

export type Pf = { ok: boolean; identity?: string; reason?: string; credentialRejected?: boolean };
export interface PreflightDeps { tickets: Pick<TicketSet, 'connections' | 'registryFor' | 'invalidate'>; scm: Pick<ScmSet, 'connections' | 'registryFor' | 'invalidate'> }
export type Side = keyof PreflightDeps;
export type ConnectionPf = { connection: string; pf: Pf };
export type Preflights = { tickets: ConnectionPf[]; scm: ConnectionPf[] };

const PREFLIGHT_TTL_MS = 30_000;
const NOT_CHECKED: Pf = { ok: false, reason: 'Not checked yet' };
let pfCache: { at: number; result: Preflights } | null = null;
let inflight: Promise<Preflights> | null = null;
// Bumped by a reset, so a check started before a settings write never fills the cache.
let generation = 0;

/** Test hook (and after a settings write): drop the cache so the next call re-checks. */
export function resetPreflightCache(): void { pfCache = null; inflight = null; generation += 1; }

/** One connection's preflight. An unknown connection, or a build that throws, is a failed check. */
export async function onePreflight(deps: PreflightDeps, side: Side, connection: string): Promise<Pf> {
  try {
    const p = await deps[side].registryFor(connection).current();
    return await p.preflight();
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Check every connection, sharing one in-flight check between callers. */
function refresh(deps: PreflightDeps): Promise<Preflights> {
  if (inflight) return inflight;
  const gen = generation;
  const all = (side: Side) => Promise.all(deps[side].connections.map(async (connection) => ({ connection, pf: await onePreflight(deps, side, connection) })));
  const p = (async () => {
    const [tickets, scm] = await Promise.all([all('tickets'), all('scm')]);
    const result = { tickets, scm };
    if (gen === generation) pfCache = { at: Date.now(), result };
    return result;
  })().finally(() => { if (inflight === p) inflight = null; });
  inflight = p;
  return p;
}

export async function providerPreflights(deps: PreflightDeps, opts: { force?: boolean } = {}): Promise<Preflights> {
  if (!opts.force && pfCache && Date.now() - pfCache.at < PREFLIGHT_TTL_MS) return pfCache.result;
  return refresh(deps);
}

/**
 * The last results, at once: never waits on a tracker. A stale cache starts one
 * background refresh; a connection with no result yet reads "Not checked yet".
 */
export function lastPreflights(deps: PreflightDeps): Preflights {
  if (!pfCache || Date.now() - pfCache.at >= PREFLIGHT_TTL_MS) void refresh(deps).catch(() => undefined);
  const got = pfCache?.result;
  const pick = (side: Side) => deps[side].connections.map((connection) => ({
    connection, pf: got?.[side].find((r) => r.connection === connection)?.pf ?? NOT_CHECKED,
  }));
  return { tickets: pick('tickets'), scm: pick('scm') };
}

/** The `/health` body: liveness plus each connection's last known preflight. */
export function healthBody(deps: PreflightDeps) {
  const { tickets, scm } = lastPreflights(deps);
  const brief = (rows: ConnectionPf[]) => rows.map(({ connection, pf }) => ({ connection, ok: pf.ok }));
  return { ok: true as const, orgSettingsLoaded: orgSettingsLoaded(), tickets: brief(tickets), scm: brief(scm) };
}
