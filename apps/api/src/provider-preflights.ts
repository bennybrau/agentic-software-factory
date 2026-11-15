import type { TicketProviderRegistry } from './providers/tickets/registry.js';
import type { ScmProviderRegistry } from './providers/scm/registry.js';

/**
 * The live tracker + SCM preflights, shared by the first-run checklist
 * (routes/setup.ts) and credential health (credential-health.ts). A preflight is
 * a round trip to Jira/GitHub/GitLab, so both results are cached together for a
 * short window: a 10s poll resolves them at most every ~30s.
 */

export type Pf = { ok: boolean; identity?: string; reason?: string; credentialRejected?: boolean };
export interface PreflightDeps { tickets: Pick<TicketProviderRegistry, 'current' | 'invalidate'>; scm: Pick<ScmProviderRegistry, 'current' | 'invalidate'> }

const PREFLIGHT_TTL_MS = 30_000;
let pfCache: { at: number; ticket: Pf; scm: Pf } | null = null;

/** Test hook (and after a settings write): drop the cache so the next call re-checks. */
export function resetPreflightCache(): void { pfCache = null; }

async function onePreflight(current: () => Promise<{ preflight: () => Promise<Pf> }>): Promise<Pf> {
  try {
    const p = await current();
    return await p.preflight();
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export async function providerPreflights(deps: PreflightDeps, opts: { force?: boolean } = {}): Promise<{ ticket: Pf; scm: Pf }> {
  const now = Date.now();
  if (!opts.force && pfCache && now - pfCache.at < PREFLIGHT_TTL_MS) return { ticket: pfCache.ticket, scm: pfCache.scm };
  const [ticket, scm] = await Promise.all([
    onePreflight(() => deps.tickets.current()),
    onePreflight(() => deps.scm.current()),
  ]);
  pfCache = { at: now, ticket, scm };
  return { ticket, scm };
}
