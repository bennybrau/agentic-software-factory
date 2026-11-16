import type { SettingView } from '@asf/shared';
import { connectionKind, resolve } from '@asf/shared';
import { registry } from './registry/client.js';
import { describe } from './settings.js';
import { providerPreflights, type Pf, type PreflightDeps } from './provider-preflights.js';

type Log = { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
export type CredentialHealth = NonNullable<SettingView['health']>;

/**
 * Credential health (#139): tell the operator a token has stopped working (or is
 * about to expire) before a run fails on it.
 *
 *  - The token of every tracker and code connection in use is live-checked with the same preflights the
 *    setup checklist uses. Each result is recorded in the registry, which keeps
 *    when the failure started and sends one notification per failure.
 *  - A Claude subscription token lasts about a year. Only one saved through the
 *    UI has a known age (org_secret.updated_at), so it warns 30 days before
 *    updated_at + 365d. A token set by env gets no expiry warning.
 *
 * Runs every CREDENTIAL_CHECK_MS, and on Settings load (cached 30s).
 */

const DAY_MS = 86_400_000;
export const SUBSCRIPTION_TOKEN_DAYS = 365;
export const EXPIRY_WARN_DAYS = 30;
const CHECK_TTL_MS = 30_000;

const LABEL: Record<string, string> = {
  GITHUB_TOKEN: 'GitHub token', JIRA_API_TOKEN: 'Jira API token', TRELLO_TOKEN: 'Trello token', GITLAB_TOKEN: 'GitLab token',
};
/** Which secret a provider's preflight exercises. Other kinds (mock, …) have none to check. */
const TICKET_KEY: Record<string, string> = { github: 'GITHUB_TOKEN', jira: 'JIRA_API_TOKEN', trello: 'TRELLO_TOKEN', gitlab: 'GITLAB_TOKEN' };
const SCM_KEY: Record<string, string> = { github: 'GITHUB_TOKEN', gitlab: 'GITLAB_TOKEN' };

/** The expiry of a UI-saved subscription token, when it is within the warning window (or past). */
export function subscriptionExpiryWarning(savedAt: string, now: number): string | undefined {
  const expires = Date.parse(savedAt) + SUBSCRIPTION_TOKEN_DAYS * DAY_MS;
  return expires - now <= EXPIRY_WARN_DAYS * DAY_MS ? new Date(expires).toISOString() : undefined;
}

let cache: { at: number; health: Record<string, CredentialHealth> } | null = null;
let last: Record<string, CredentialHealth> = {};

/** After a settings write: re-check on the next load, and forget the written key's stale health. */
export function forgetCredentialHealth(key?: string): void {
  cache = null;
  if (key) { last = { ...last }; delete last[key]; }
}

/** Test hook. */
export function __resetCredentialHealth(): void { cache = null; last = {}; }

export async function checkCredentials(deps: PreflightDeps, opts: { force?: boolean; now?: number } = {}): Promise<Record<string, CredentialHealth>> {
  const now = opts.now ?? Date.now();
  if (!opts.force && cache && now - cache.at < CHECK_TTL_MS) return cache.health;
  const views = new Map(describe().map((v) => [v.key, v]));
  const health: Record<string, CredentialHealth> = {};

  // Every tracker + code connection: one check per secret (GitHub tickets and code share GITHUB_TOKEN).
  const { tickets, scm } = await providerPreflights(deps, { force: opts.force });
  const checks = new Map<string, { pf: Pf; link: string }>();
  const add = (key: string | undefined, pf: Pf, link: string) => {
    if (!key || views.get(key)?.value == null) return; // not saved: nothing has "stopped working"
    const prev = checks.get(key);
    if (!prev || (prev.pf.ok && !pf.ok)) checks.set(key, { pf, link });
  };
  for (const { connection, pf } of tickets) add(TICKET_KEY[connectionKind(connection)], pf, '/settings#tickets');
  for (const { connection, pf } of scm) add(SCM_KEY[connectionKind(connection)], pf, '/settings#code');
  for (const [key, { pf, link }] of checks) {
    const { health: h } = await registry.recordCredentialHealth({
      key, ok: pf.ok, reason: pf.ok ? null : pf.reason ?? 'The connection test failed.', label: LABEL[key] ?? key, link,
    });
    health[key] = { ok: h.ok, reason: h.reason, since: h.failingSince };
  }

  // Claude subscription token: age from org_secret.updated_at, UI-saved only.
  if (!views.get('CLAUDE_CODE_OAUTH_TOKEN')?.envPinned) {
    const { secrets } = await registry.listOrgSecretNames();
    const saved = (secrets ?? []).find((s) => s.name === 'CLAUDE_CODE_OAUTH_TOKEN');
    const expiresAt = saved && subscriptionExpiryWarning(saved.updatedAt, now);
    if (expiresAt) health.CLAUDE_CODE_OAUTH_TOKEN = { ok: true, reason: null, since: null, expiresAt };
  }

  cache = { at: now, health };
  last = health;
  return health;
}

/** The last known health, without a new check (for the settings write responses). */
export function lastCredentialHealth(): Record<string, CredentialHealth> { return last; }

export function withHealth(views: SettingView[], health: Record<string, CredentialHealth>): SettingView[] {
  return views.map((v) => (health[v.key] ? { ...v, health: health[v.key] } : v));
}

export function startCredentialChecks(deps: PreflightDeps, log: Log): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap ticks
    running = true;
    try {
      const health = await checkCredentials(deps, { force: true });
      const failing = Object.entries(health).filter(([, h]) => !h.ok || h.expiresAt).map(([k]) => k);
      if (failing.length) log.info({ keys: failing }, 'credential check: needs attention');
    } catch (err) { log.error({ err: (err as Error).message }, 'credential check failed'); }
    finally { running = false; }
  }, resolve('CREDENTIAL_CHECK_MS'));
  return () => clearInterval(timer);
}
