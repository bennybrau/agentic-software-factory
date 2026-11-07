import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { backfillHive, buildEpisode, newHiveHookState, tickHive, HIVE_MAX_ATTEMPTS } from './hive.js';
import type { MergedRun } from './hive.js';
import type { ArtifactWire, Repo, ScmProvider, Ticket, TicketProvider } from '@asf/shared';

// One fake fetch plays both sides: the registry RPC (hiveMergedRuns, listArtifacts) and
// Hive's POST /v1/episodes, which we record (or fail on demand).
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; for (const k of ['HIVE_URL', 'HIVE_TOKEN', 'SCM_PROVIDER']) delete process.env[k]; });

const logs: string[] = [];
const log = { info: () => {}, error: (_o: unknown, m?: string) => { logs.push(m ?? ''); } };

function run(over: Partial<MergedRun> = {}): MergedRun {
  return {
    id: 'run_1', ticketId: 'asf-1', ticketKey: 'ASF-1', ticketProvider: 'mock',
    state: 'succeeded', teamName: 'standard', team: null as never, gates: null as never,
    repoId: 'example/app', worktreePath: null, branchName: 'asf/asf-1',
    changeRequestUrl: 'https://github.com/example/app/pull/7', changeRequestNumber: 7,
    changeRequestState: 'merged', deliveryOutcome: 'merged',
    costUsd: 0, maxCostUsd: null, reviewIterations: 0, dispatchedBy: 'jon', reason: null,
    createdAt: new Date().toISOString(), startedAt: null, lastEventAt: new Date().toISOString(),
    cancelRequestedAt: null, finishedAt: new Date().toISOString(), mergedAt: new Date().toISOString(), ...over,
  } as MergedRun;
}

const artifacts: ArtifactWire[] = [
  { name: 'plan.md', content: 'the plan\n', updatedAt: '' },
  { name: 'review.md', content: 'APPROVE', updatedAt: '' },
  { name: 'test.md', content: 'not sent', updatedAt: '' },
];

const tickets = { get: async (id: string) => ({ id, key: id.toUpperCase(), title: 'Fix the thing' } as Ticket) } as unknown as TicketProvider;

/** A fake SCM whose changedFiles answers `files` (or is missing / throws). */
function fakeScm(files: string[] | 'throw' | 'missing' = ['src/a.ts', 'src/b.ts']): ScmProvider {
  const scm = { getRepo: async (id: string) => ({ id, path: id } as Repo) } as Partial<ScmProvider>;
  if (files === 'throw') scm.changedFiles = async () => { throw new Error('scm down'); };
  else if (files !== 'missing') scm.changedFiles = async (_r, _n, limit) => files.slice(0, limit);
  return scm as ScmProvider;
}
const deps = { tickets, scm: fakeScm() };

type Sent = { url: string; auth: string | null; body: { ref: string; repo_key: string; content: string; kind: string; metadata: { merged_at: string; pr_url: string | null; title: string; paths: string[] } } };

/**
 * Stub fetch. `runs` is every run the registry knows; hiveMergedRuns answers the
 * merged ones (like the registry, filtering on since and ordering by mergedAt).
 * `hive` decides each Hive answer: a status, or 'throw' for a network error.
 */
function stub(runs: MergedRun[], hive: (n: number) => number | 'throw' = () => 200) {
  const sent: Sent[] = [];
  let hiveCalls = 0;
  global.fetch = (async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    if (String(url).endsWith('/internal/rpc')) {
      const body = JSON.parse(init?.body ?? '{}') as { op: string; offset: number; since?: string };
      if (body.op === 'hiveMergedRuns') {
        const merged = runs.filter((r) => r.changeRequestState === 'merged' && (!body.since || r.mergedAt >= body.since))
          .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
        return json({ ok: true, result: { runs: body.offset ? [] : merged } });
      }
      if (body.op === 'listArtifacts') return json({ ok: true, result: { artifacts } });
      return json({ ok: true, result: {} });
    }
    const outcome = hive(hiveCalls++);
    if (outcome === 'throw') throw new TypeError('fetch failed');
    if (outcome < 300) sent.push({ url: String(url), auth: init?.headers?.authorization ?? null, body: JSON.parse(init!.body!) });
    return new Response(outcome < 300 ? '{}' : 'boom', { status: outcome });
  }) as unknown as typeof fetch;
  return sent;
}
function json(obj: unknown) { return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } }); }

test('buildEpisode: asf_run with gh/ repo key, run id ref, title, PR, latest plan and review', () => {
  const ep = buildEpisode(run(), artifacts, 'Fix the thing')!;
  assert.equal(ep.kind, 'asf_run');
  assert.equal(ep.repo_key, 'gh/example/app');
  assert.equal(ep.ref, 'run_1');
  assert.ok(ep.content.startsWith('# ASF-1: Fix the thing\n'));
  assert.match(ep.content, /https:\/\/github\.com\/example\/app\/pull\/7/);
  assert.match(ep.content, /## Plan\n\nthe plan/);
  assert.match(ep.content, /## Review\n\nAPPROVE/);
  assert.doesNotMatch(ep.content, /not sent/);
});

test('buildEpisode: gl/ on GitLab; null for a run with no repo', () => {
  process.env.SCM_PROVIDER = 'gitlab';
  assert.equal(buildEpisode(run({ repoId: 'grp/app' }), [], 't')!.repo_key, 'gl/grp/app');
  assert.equal(buildEpisode(run({ repoId: null }), [], 't'), null);
});

test('tick: posts to HIVE_URL/v1/episodes with a Bearer token', async () => {
  process.env.HIVE_URL = 'http://hive.test/';
  process.env.HIVE_TOKEN = 'tok';
  const sent = stub([run()]);
  assert.equal(await tickHive(deps, newHiveHookState(), log), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'http://hive.test/v1/episodes');
  assert.equal(sent[0].auth, 'Bearer tok');
  assert.equal(sent[0].body.ref, 'run_1');
  assert.match(sent[0].body.content, /^# ASF-1: Fix the thing/);
});

test('tick: the ticket key stands in for the title when the tracker read fails', async () => {
  process.env.HIVE_URL = 'http://hive.test';
  const sent = stub([run()]);
  const broken = { get: async () => { throw new Error('tracker down'); } } as unknown as TicketProvider;
  await tickHive({ tickets: broken, scm: fakeScm() }, newHiveHookState(), log);
  assert.match(sent[0].body.content, /^# ASF-1: ASF-1\n/);
});

test('tick: blank HIVE_URL sends nothing', async () => {
  const sent = stub([run()]);
  assert.equal(await tickHive(deps, newHiveHookState(), log), 0);
  assert.equal(sent.length, 0);
});

test('tick: a run is sent once across ticks; one merged before the lookback is not sent', async () => {
  process.env.HIVE_URL = 'http://hive.test';
  const old = run({ id: 'run_old', mergedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
  const sent = stub([run(), old]);
  const state = newHiveHookState();
  await tickHive(deps, state, log);
  await tickHive(deps, state, log);
  assert.deepEqual(sent.map((s) => s.body.ref), ['run_1']);
});

test('tick: a 500 or network error is logged and retried, then given up; never thrown', async () => {
  process.env.HIVE_URL = 'http://hive.test';
  logs.length = 0;
  const sent = stub([run()], (n) => (n % 2 ? 500 : 'throw'));
  const state = newHiveHookState();
  for (let i = 0; i < HIVE_MAX_ATTEMPTS + 2; i++) assert.equal(await tickHive(deps, state, log), 0);
  assert.equal(sent.length, 0);
  assert.equal(logs.filter((m) => /will retry/.test(m)).length, HIVE_MAX_ATTEMPTS - 1);
  assert.equal(logs.filter((m) => /giving up/.test(m)).length, 1);
});

test('tick: a send that fails then succeeds is sent on the next tick', async () => {
  process.env.HIVE_URL = 'http://hive.test';
  const sent = stub([run()], (n) => (n === 0 ? 500 : 200));
  const state = newHiveHookState();
  await tickHive(deps, state, log);
  await tickHive(deps, state, log);
  assert.equal(sent.length, 1);
});

test('backfill: oldest first by mergedAt, filtered by since, throttled', async () => {
  process.env.HIVE_URL = 'http://hive.test';
  const at = (d: string) => new Date(d).toISOString();
  const sent = stub([
    run({ id: 'b', mergedAt: at('2026-03-02') }),
    run({ id: 'a', mergedAt: at('2026-03-01') }),
    run({ id: 'c', mergedAt: at('2026-03-03'), finishedAt: at('2026-01-01') }),
    run({ id: 'z', mergedAt: at('2026-01-01') }),
    run({ id: 'norepo', repoId: null, mergedAt: at('2026-03-04') }),
  ]);
  const sleeps: number[] = [];
  const r = await backfillHive(deps, { since: Date.parse('2026-02-01'), sleep: async (ms) => { sleeps.push(ms); } }, log);
  assert.deepEqual(sent.map((s) => s.body.ref), ['a', 'b', 'c']);
  assert.deepEqual(sleeps.map(Math.round), [333, 333]);
  assert.deepEqual({ runs: r.runs, sent: r.sent, failed: r.failed }, { runs: 3, sent: 3, failed: 0 });
});

test('backfill --dry-run: totals merged runs and bytes, sends nothing', async () => {
  const mergedAt = new Date().toISOString();
  const sent = stub([run({ id: 'a', mergedAt }), run({ id: 'b', mergedAt }), run({ id: 'open', changeRequestState: 'open' })]);
  const r = await backfillHive(deps, { dryRun: true }, log);
  const one = Buffer.byteLength(JSON.stringify(buildEpisode(run({ id: 'a', mergedAt }), artifacts, 'Fix the thing', ['src/a.ts', 'src/b.ts'])));
  assert.equal(sent.length, 0);
  assert.equal(r.runs, 2);
  assert.equal(r.bytes, one * 2);
});

test('tick: metadata carries merged_at, pr_url, title and the changed paths', async () => {
  process.env.HIVE_URL = 'http://hive.test';
  const r = run();
  const sent = stub([r]);
  await tickHive(deps, newHiveHookState(), log);
  assert.deepEqual(sent[0].body.metadata, {
    merged_at: r.mergedAt, pr_url: 'https://github.com/example/app/pull/7', title: 'Fix the thing', paths: ['src/a.ts', 'src/b.ts'],
  });
});

test('tick: 600 changed files are capped at 500 paths', async () => {
  process.env.HIVE_URL = 'http://hive.test';
  const many = Array.from({ length: 600 }, (_, i) => `f${i}.ts`);
  const sent = stub([run()]);
  const loose = { ...fakeScm(), changedFiles: async () => many } as ScmProvider; // ignores the limit
  await tickHive({ tickets, scm: loose }, newHiveHookState(), log);
  assert.equal(sent[0].body.metadata.paths.length, 500);
  assert.equal(buildEpisode(run(), [], 't', many)!.metadata.paths.length, 500);
});

test('tick: changedFiles throwing or missing gives [] paths and the episode is still sent', async () => {
  process.env.HIVE_URL = 'http://hive.test';
  for (const files of ['throw', 'missing'] as const) {
    const sent = stub([run()]);
    assert.equal(await tickHive({ tickets, scm: fakeScm(files) }, newHiveHookState(), log), 1);
    assert.deepEqual(sent[0].body.metadata.paths, []);
  }
});

test('tick: a succeeded run whose PR is not merged is not sent', async () => {
  process.env.HIVE_URL = 'http://hive.test';
  const sent = stub([run({ id: 'open', changeRequestState: 'open' }), run({ id: 'closed', changeRequestState: 'closed' }), run()]);
  await tickHive(deps, newHiveHookState(), log);
  assert.deepEqual(sent.map((s) => s.body.ref), ['run_1']);
});
