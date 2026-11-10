import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Repo, ScmProvider, Ticket, TicketProvider } from '@asf/shared';
import { startReadiness, pickRepo, previewRepo } from './start-readiness.js';
import { MockScmProvider } from './providers/scm/mock.js';
import { MockTicketProvider } from './providers/tickets/mock.js';

const repo = (p: string): Repo => ({ id: p, path: p, url: `https://x/${p}`, defaultBranch: 'main', cloneUrl: `https://x/${p}.git` });
function scm(opts: { ok?: boolean; reason?: string; repos?: Repo[]; getRepo?: (id: string) => Repo }): ScmProvider {
  return {
    kind: 'github',
    preflight: async () => (opts.ok === false ? { ok: false, reason: opts.reason ?? 'bad token' } : { ok: true, identity: 'me' }),
    searchRepos: async () => opts.repos ?? [],
    getRepo: async (id: string) => { if (opts.getRepo) return opts.getRepo(id); throw new Error('404'); },
  } as unknown as ScmProvider;
}
const ticket = { id: 't1', key: 'T-1' } as Ticket;
const tickets = (suggested: string | null = null) => ({ suggestedRepo: () => suggested }) as unknown as TicketProvider;

test('nothing can start while source control is not connected; the reason names the fix', async () => {
  const r = await startReadiness(scm({ ok: false, reason: 'GITHUB_TOKEN is empty' }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'scm_not_connected');
  assert.match(r.reason, /GITHUB_TOKEN is empty/);
  assert.equal(r.link, '/settings#code');
});

test('a connected source control with no repository chosen still blocks starting', async () => {
  const r = await startReadiness(scm({ repos: [] }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'no_repos');
});

test('the mock SCM with no MOCK_REPO_PATH is not a repository: a fresh install cannot start', async () => {
  const r = await startReadiness(new MockScmProvider(''));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'scm_not_connected');
  assert.equal((await startReadiness(new MockScmProvider('/some/repo.git'))).ok, true, 'a configured practice repo is reachable');
});

test('pickRepo: the requested repo wins; unknown ones are refused, not guessed', async () => {
  const repos = [repo('a/one'), repo('a/two')];
  const got = await pickRepo({ tickets: tickets(), scm: scm({ repos }) }, ticket, repos, 'a/two');
  assert.ok(got.ok && got.repo.id === 'a/two');
  const bad = await pickRepo({ tickets: tickets(), scm: scm({ repos }) }, ticket, repos, 'a/nope');
  assert.ok(!bad.ok && bad.code === 'repo_not_found');
});

test('pickRepo: else the ticket\'s own repo, else the only one; several and no hint is refused', async () => {
  const repos = [repo('a/one'), repo('a/two')];
  const own = await pickRepo({ tickets: tickets('a/two'), scm: scm({ repos }) }, ticket, repos);
  assert.ok(own.ok && own.repo.id === 'a/two');
  const only = await pickRepo({ tickets: tickets(), scm: scm({ repos: [repos[0]] }) }, ticket, [repos[0]]);
  assert.ok(only.ok && only.repo.id === 'a/one');
  const amb = await pickRepo({ tickets: tickets(), scm: scm({ repos }) }, ticket, repos);
  assert.ok(!amb.ok && amb.code === 'repo_ambiguous');
  assert.match(amb.ok ? '' : amb.reason, /T-1.*a\/one, a\/two/);
});

// --- The repository a ticket names settles it, when it names exactly one ---
const lib = [repo('acme/platform/web/shared-ui'), repo('acme/platform/web/storefront'), repo('acme/platform/api/billing')];
const named = (title: string, body = '') => ({ id: 't1', key: 'T-1', title, body }) as Ticket;
const pick = (t: Ticket, suggested: string | null = null, requested?: string) =>
  pickRepo({ tickets: tickets(suggested), scm: scm({ repos: lib }) }, t, lib, requested);

test('pickRepo: a ticket that names exactly one connected repository starts there', async () => {
  const body = await pick(named('Header overlaps', 'Seen in acme/platform/web/storefront on mobile.'));
  assert.ok(body.ok && body.repo.id === 'acme/platform/web/storefront');
  const title = await pick(named('Fix the header in shared-ui'));
  assert.ok(title.ok && title.repo.id === 'acme/platform/web/shared-ui');
});

test('pickRepo: one repository in the title settles it, even with others in the description', async () => {
  const got = await pick(named('Billing totals are off', 'The storefront and shared-ui show them too.'));
  assert.ok(got.ok && got.repo.id === 'acme/platform/api/billing');
});

test('pickRepo: several named and none settled is refused, naming the repositories the ticket mentions', async () => {
  const got = await pick(named('Header overlaps', 'Seen in storefront, and the fix is in shared-ui.'));
  assert.ok(!got.ok && got.code === 'repo_ambiguous');
  assert.match(got.ok ? '' : got.reason, /It mentions acme\/platform\/web\/storefront, acme\/platform\/web\/shared-ui/);
  const twoInTitle = await pick(named('Move the header from storefront into shared-ui'));
  assert.ok(!twoInTitle.ok && twoInTitle.code === 'repo_ambiguous');
  const none = await pick(named('Header overlaps'));
  assert.ok(!none.ok && !/It mentions/.test(none.reason), 'no mention: the reason only lists the choices');
});

test('pickRepo: the tracker\'s own repository and a requested one still win over a mention', async () => {
  const t = named('Fix the header in shared-ui');
  const own = await pick(t, 'acme/platform/api/billing');
  assert.ok(own.ok && own.repo.id === 'acme/platform/api/billing');
  const asked = await pick(t, 'acme/platform/api/billing', 'acme/platform/web/storefront');
  assert.ok(asked.ok && asked.repo.id === 'acme/platform/web/storefront');
});

test('previewRepo: says where a queued ticket starts and why, or null when a person must choose', () => {
  const p1 = previewRepo(tickets(), named('Fix the header in shared-ui'), lib);
  assert.equal(p1.repoId, 'acme/platform/web/shared-ui');
  assert.equal(p1.reason, 'The ticket title mentions shared-ui.');
  const own = previewRepo(tickets('acme/platform/api/billing'), named('Fix the header in shared-ui'), lib);
  assert.equal(own.repoId, 'acme/platform/api/billing');
  assert.deepEqual(own.mentionedRepoIds, ['acme/platform/web/shared-ui']);
  const amb = previewRepo(tickets(), named('Header', 'storefront and shared-ui'), lib);
  assert.equal(amb.repoId, null);
  assert.match(amb.reason, /It mentions/);
  assert.deepEqual(amb.mentionedRepoIds, ['acme/platform/web/storefront', 'acme/platform/web/shared-ui']);
  const only = previewRepo(tickets(), named('Header'), [lib[0]]);
  assert.equal(only.repoId, 'acme/platform/web/shared-ui');
});

void MockTicketProvider;
