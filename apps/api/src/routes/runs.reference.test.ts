import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { Repo, ScmProvider, Ticket, TicketProvider } from '@asf/shared';
import { registerRunRoutes, computeReferenceRepos, MAX_REFERENCE_REPOS } from './runs.js';
import { config } from '../config.js';

// RunContext.referenceRepos: the other connected repositories a ticket names, each with its
// own clone credential, so the worker can check them out read-only next to the run's own.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

const repo = (id: string, path: string): Repo => ({ id, path, url: `https://example.test/${path}`, defaultBranch: 'main', cloneUrl: `https://example.test/${path}.git` });
const STOREFRONT = repo('1', 'acme/platform/web/storefront');
const SHARED_UI = repo('2', 'acme/platform/web/shared-ui');
const DESIGN_TOKENS = repo('3', 'acme/platform/web/design-tokens');
const ICONS = repo('4', 'acme/platform/web/icon-set');
const CHECKOUT = repo('5', 'acme/platform/web/checkout-flow');
const ALL = [STOREFRONT, SHARED_UI, DESIGN_TOKENS, ICONS, CHECKOUT];

/** Source control with these repos; cloneCredential fails for the paths in `failFor`. */
function scm(repos: Repo[], failFor: string[] = [], calls: { searchRepos: number } = { searchRepos: 0 }): ScmProvider {
  return {
    kind: 'mock',
    preflight: async () => ({ ok: true, identity: 'test' }),
    searchRepos: async () => { calls.searchRepos++; return repos; },
    getRepo: async (idOrPath: string) => { const r = repos.find((x) => x.id === idOrPath || x.path === idOrPath); if (!r) throw new Error('no repo'); return r; },
    cloneCredential: async (r: Repo) => { if (failFor.includes(r.path)) throw new Error('token expired'); return { url: `${r.cloneUrl}#cred` }; },
  } as unknown as ScmProvider;
}

const ticket = (title: string, body: string): Ticket => ({
  id: 'ASF-7', key: 'ASF-7', url: 'https://example.test/ASF-7', title, body, status: 'To Do', bucket: 'ready', priority: null,
  assignee: null, labels: [], links: [], parentId: null, children: [], updatedAt: '2026-11-01T00:00:00Z',
});
const tracker = (t: Ticket) => ({ get: async () => t }) as unknown as TicketProvider;

function stubRegistry(repoId: string | null) {
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string };
    const result = body.op === 'getRun' ? { run: { id: 'run_ref', ticketId: 'ASF-7', ticketKey: 'ASF-7', repoId }, tasks: [] }
      : body.op === 'listSkills' ? { skills: [] } : {};
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

async function context(t: Ticket, s: ScmProvider, repoId: string | null = STOREFRONT.id) {
  stubRegistry(repoId);
  const a = Fastify();
  registerRunRoutes(a, { tickets: tracker(t), scm: s });
  await a.ready();
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_ref/context', headers: { 'x-run-secret': config.runEventSecret } });
  await a.close();
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

test('the repositories a ticket names become read-only references, never the run\'s own', async () => {
  const calls = { searchRepos: 0 };
  const ctx = await context(ticket('Use the new Button from shared-ui', 'In acme/platform/web/storefront, replace the local button.'), scm(ALL, [], calls));
  assert.equal(ctx.repo.id, STOREFRONT.id);
  assert.deepEqual(ctx.referenceRepos, [{ repo: SHARED_UI, cloneCredential: { url: `${SHARED_UI.cloneUrl}#cred` }, reason: 'The ticket title mentions shared-ui.' }]);
  assert.equal(ctx.connectedRepos.length, ALL.length, 'the hand-off list is still there');
  assert.equal(calls.searchRepos, 1, 'one repository lookup serves both lists');
});

test('at most MAX_REFERENCE_REPOS, best match first', async () => {
  const ctx = await context(ticket('Bump checkout-flow', 'Touches icon-set, design-tokens and shared-ui.'), scm(ALL));
  assert.equal(MAX_REFERENCE_REPOS, 3);
  assert.deepEqual(ctx.referenceRepos.map((r: { repo: Repo }) => r.repo.path), [CHECKOUT.path, ICONS.path, DESIGN_TOKENS.path]);
  assert.equal(ctx.referenceRepos[1].reason, 'The ticket description mentions icon-set.');
});

test('a repository whose credential fails is left out; the others and the context are fine', async () => {
  const ctx = await context(ticket('T', 'Uses shared-ui and design-tokens.'), scm(ALL, [SHARED_UI.path]));
  assert.deepEqual(ctx.referenceRepos.map((r: { repo: Repo }) => r.repo.path), [DESIGN_TOKENS.path]);
});

test('a ticket that names no other repository gets no referenceRepos field', async () => {
  assert.equal('referenceRepos' in await context(ticket('Fix the header', 'Only in acme/platform/web/storefront.'), scm(ALL)), false);
  // Every credential failing leaves the field out too.
  assert.equal('referenceRepos' in await context(ticket('T', 'shared-ui'), scm(ALL, [SHARED_UI.path])), false);
});

test('a run with no repository of its own still gets the repositories the ticket names', async () => {
  const ctx = await context(ticket('T', 'Read shared-ui.'), scm(ALL), null);
  assert.deepEqual(ctx.referenceRepos.map((r: { repo: Repo }) => r.repo.id), [SHARED_UI.id]);
});

test('computeReferenceRepos warns once per skipped repository', async () => {
  const warned: unknown[] = [];
  const out = await computeReferenceRepos(ticket('T', 'shared-ui, icon-set'), STOREFRONT, ALL, scm(ALL, [ICONS.path]), (d) => warned.push(d));
  assert.deepEqual(out.map((r) => r.repo.id), [SHARED_UI.id]);
  assert.deepEqual(warned, [{ repo: ICONS.path, reason: 'token expired' }]);
});
