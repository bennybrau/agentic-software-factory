import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TicketProvider, ScmProvider, Preflight } from '@asf/shared';
import { checkCredentials, subscriptionExpiryWarning, __resetCredentialHealth } from './credential-health.js';
import { resetPreflightCache } from './provider-preflights.js';
import { TicketSet } from './providers/tickets/set.js';
import { ScmSet } from './providers/scm/set.js';

// Credential health drives the preflights through fake provider registries and
// stubs the registry RPC layer: recordCredentialHealth mimics the registry's
// failing_since bookkeeping, listOrgSecretNames returns the saved secrets' ages.
const realFetch = global.fetch;
const ENV_KEYS = ['TICKET_PROVIDER', 'SCM_PROVIDER', 'GITHUB_TOKEN', 'JIRA_API_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
afterEach(() => {
  global.fetch = realFetch;
  resetPreflightCache();
  __resetCredentialHealth();
  for (const k of ENV_KEYS) delete process.env[k];
});

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-29T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

function stubRegistry(opts: { secrets?: { name: string; updatedAt: string }[] } = {}) {
  const recorded: { key: string; ok: boolean; reason: string | null; label: string }[] = [];
  let failingSince: string | null = null;
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string; key: string; ok: boolean; reason: string | null; label: string };
    let result: unknown = { ok: true };
    if (body.op === 'recordCredentialHealth') {
      recorded.push({ key: body.key, ok: body.ok, reason: body.reason, label: body.label });
      failingSince = body.ok ? null : failingSince ?? '2026-09-03T08:00:00.000Z';
      result = { health: { key: body.key, ok: body.ok, reason: body.reason, failingSince, alertedAt: failingSince, checkedAt: new Date().toISOString() } };
    } else if (body.op === 'listOrgSecretNames') {
      const secrets = opts.secrets ?? [];
      result = { names: secrets.map((s) => s.name), secrets };
    }
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return recorded;
}

/** Tracker connections whose preflight answers from `pf(kind)`; code connections that pass. */
function sets(tickets: string[], scm: string[], pf: (kind: string) => Preflight, scmPf: (kind: string) => Preflight = () => ({ ok: true, identity: 'octocat' })) {
  return {
    tickets: new TicketSet(async (k) => ({ kind: k, preflight: async () => pf(k) }) as unknown as TicketProvider, () => tickets),
    scm: new ScmSet(async (k) => ({ kind: k, preflight: async () => scmPf(k) }) as unknown as ScmProvider, () => scm),
  };
}

/** GitHub tickets whose preflight answers from `pf`; a mock SCM (nothing to check). */
const deps = (pf: () => Preflight) => sets(['github'], ['mock'], pf);

test('a failing preflight is recorded and reported, then clears on recovery', async () => {
  process.env.TICKET_PROVIDER = 'github';
  process.env.GITHUB_TOKEN = 'ghp_test';
  const recorded = stubRegistry();
  let pf: Preflight = { ok: false, reason: 'HTTP 401 Bad credentials' };
  const d = deps(() => pf);

  let health = await checkCredentials(d, { force: true, now: NOW });
  assert.deepEqual(health.GITHUB_TOKEN, { ok: false, reason: 'HTTP 401 Bad credentials', since: '2026-09-03T08:00:00.000Z' });
  assert.deepEqual(recorded[0], { key: 'GITHUB_TOKEN', ok: false, reason: 'HTTP 401 Bad credentials', label: 'GitHub token' });

  pf = { ok: true, identity: 'octocat' };
  health = await checkCredentials(d, { force: true, now: NOW });
  assert.deepEqual(health.GITHUB_TOKEN, { ok: true, reason: null, since: null });
  assert.equal(recorded.length, 2);
});

test('the Settings-load check is cached for 30s; a forced (timer) check is not', async () => {
  process.env.TICKET_PROVIDER = 'github';
  process.env.GITHUB_TOKEN = 'ghp_test';
  const recorded = stubRegistry();
  const d = deps(() => ({ ok: true, identity: 'octocat' }));
  await checkCredentials(d, { now: NOW });
  await checkCredentials(d, { now: NOW + 10_000 });
  assert.equal(recorded.length, 1);
  await checkCredentials(d, { force: true, now: NOW + 10_000 });
  assert.equal(recorded.length, 2);
});

test('an unsaved token is not checked (nothing has stopped working)', async () => {
  process.env.TICKET_PROVIDER = 'github';
  const recorded = stubRegistry();
  const health = await checkCredentials(deps(() => ({ ok: false, reason: 'no token' })), { force: true, now: NOW });
  assert.equal(recorded.length, 0);
  assert.equal(health.GITHUB_TOKEN, undefined);
});

test('subscription expiry warns within 30 days of saved-on + 365d', () => {
  assert.equal(subscriptionExpiryWarning(daysAgo(334), NOW), undefined, '31 days left: no warning yet');
  assert.equal(subscriptionExpiryWarning(daysAgo(335), NOW), new Date(NOW + 30 * DAY).toISOString(), '30 days left: warn');
  assert.equal(subscriptionExpiryWarning(daysAgo(366), NOW), new Date(NOW - DAY).toISOString(), 'expired: still warns');
});

test('a UI-saved subscription token near expiry gets expiresAt; a fresh one does not', async () => {
  stubRegistry({ secrets: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', updatedAt: daysAgo(335) }] });
  let health = await checkCredentials(deps(() => ({ ok: true, identity: 'octocat' })), { force: true, now: NOW });
  assert.deepEqual(health.CLAUDE_CODE_OAUTH_TOKEN, { ok: true, reason: null, since: null, expiresAt: new Date(NOW + 30 * DAY).toISOString() });

  stubRegistry({ secrets: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', updatedAt: daysAgo(334) }] });
  health = await checkCredentials(deps(() => ({ ok: true, identity: 'octocat' })), { force: true, now: NOW });
  assert.equal(health.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('a subscription token set by env gets no expiry warning', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-env';
  stubRegistry({ secrets: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', updatedAt: daysAgo(366) }] });
  const health = await checkCredentials(deps(() => ({ ok: true, identity: 'octocat' })), { force: true, now: NOW });
  assert.equal(health.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('every tracker connection is checked: jira and github are both recorded', async () => {
  process.env.GITHUB_TOKEN = 'ghp_test';
  process.env.JIRA_API_TOKEN = 'jira_test';
  const recorded = stubRegistry();
  const health = await checkCredentials(sets(['jira', 'github'], ['mock'], (k) => (k === 'jira' ? { ok: false, reason: 'Jira said 401' } : { ok: true, identity: 'octocat' })), { force: true, now: NOW });
  assert.deepEqual(recorded.map((r) => [r.key, r.ok]).sort(), [['GITHUB_TOKEN', true], ['JIRA_API_TOKEN', false]]);
  assert.equal(health.JIRA_API_TOKEN.reason, 'Jira said 401');
  assert.equal(health.GITHUB_TOKEN.ok, true);
});

test('github tickets + github code make one GITHUB_TOKEN check, and a failure wins', async () => {
  process.env.GITHUB_TOKEN = 'ghp_test';
  const recorded = stubRegistry();
  const health = await checkCredentials(sets(['github'], ['github'], () => ({ ok: true, identity: 'octocat' }), () => ({ ok: false, reason: 'HTTP 401 Bad credentials' })), { force: true, now: NOW });
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], { key: 'GITHUB_TOKEN', ok: false, reason: 'HTTP 401 Bad credentials', label: 'GitHub token' });
  assert.equal(health.GITHUB_TOKEN.ok, false);
});
