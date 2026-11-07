import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSpawn, CreateAdhocInput, RunContext, TeamTemplate } from '@asf/shared';
import { roleSkillFor, maxTurnsFor, policyFor, drainTodosOutbox } from './segment.js';
import { buildArgs } from './runtimes/claude-code.js';

// A minimal team with one role carrying a per-dispatch skill, and a context with an
// org-tier skill for the same role. roleSkillFor composes org first, per-run second.
function team(plannerSkill: string | null): TeamTemplate {
  return {
    name: 't', roles: [{ role: 'planner', runtime: 'claude-code', model: null, effort: null, writes: false, input: null, output: null, skill: plannerSkill, maxCostUsd: null }],
    loop: null, gates: {}, maxCostUsd: 15, mergeEnabled: true,
  } as unknown as TeamTemplate;
}
function ctx(roleSkills: Record<string, string>): RunContext {
  return { runId: 'r', ticket: { id: 't', key: 'K-1', title: '', body: '', url: '', links: [] }, repo: null, cloneCredential: null, auth: { mode: 'api-key' }, roleSkills } as unknown as RunContext;
}

test('roleSkillFor: neither org nor per-run → undefined (no section)', () => {
  assert.equal(roleSkillFor(team(null), ctx({}), 'planner'), undefined);
});

test('roleSkillFor: org only', () => {
  assert.equal(roleSkillFor(team(null), ctx({ planner: 'ORG GUIDANCE' }), 'planner'), 'ORG GUIDANCE');
});

test('roleSkillFor: per-dispatch only', () => {
  assert.equal(roleSkillFor(team('RUN GUIDANCE'), ctx({}), 'planner'), 'RUN GUIDANCE');
});

test('roleSkillFor: org first, then the per-dispatch addition', () => {
  const composed = roleSkillFor(team('RUN GUIDANCE'), ctx({ planner: 'ORG GUIDANCE' }), 'planner');
  assert.equal(composed, 'ORG GUIDANCE\n\nRUN GUIDANCE');
  assert.ok(composed!.indexOf('ORG') < composed!.indexOf('RUN'), 'org guidance precedes the per-run addition');
});

test('roleSkillFor: a role with no entry either place → undefined', () => {
  assert.equal(roleSkillFor(team('RUN'), ctx({ planner: 'ORG' }), 'reviewer'), undefined);
});

test('maxTurnsFor: MAX_TURNS_<ROLE> wins, a role without one falls back to WORKER_MAX_TURNS', () => {
  const c = { ...ctx({}), workerSettings: { maxTurns: 40, segmentTimeoutMs: 1, maxTurnsByRole: { implementer: 150 } } } as RunContext;
  const implementer = maxTurnsFor(c, 'implementer', 7);
  const planner = maxTurnsFor(c, 'planner', 7);
  assert.equal(implementer, 150);
  assert.equal(planner, 40);
  assert.equal(maxTurnsFor(ctx({}), 'planner', 7), 7, 'an older api with no workerSettings → local env > default');
  // What the worker actually hands Claude Code for each.
  const turnsArg = (n: number) => { const a = buildArgs({ role: 'x', prompt: 'P', cwd: '/', maxTurns: n, maxCostUsd: 1, policy: policyFor(false), timeoutMs: 1, env: {} } as unknown as AgentSpawn, undefined, []); return a[a.indexOf('--max-turns') + 1]; };
  assert.equal(turnsArg(implementer), '150');
  assert.equal(turnsArg(planner), '40');
});

// drainTodosOutbox: run-dir outbox lines → createAdhoc calls, skipping junk and capping.
async function drainWith(lines: string | null): Promise<CreateAdhocInput[]> {
  const dir = await mkdtemp(join(tmpdir(), 'asf-todos-'));
  if (lines !== null) await writeFile(join(dir, 'todos.outbox.jsonl'), lines);
  const made: CreateAdhocInput[] = [];
  await drainTodosOutbox(dir, 'implementer', 'run_1', async (input) => { made.push(input); return null; });
  await rm(dir, { recursive: true, force: true });
  return made;
}

test('drainTodosOutbox: parses each line into a createAdhoc call tagged with the role and the run', async () => {
  const made = await drainWith([
    JSON.stringify({ title: 'First', body: 'b1' }),
    JSON.stringify({ title: 'Second' }),
  ].join('\n'));
  assert.equal(made.length, 2);
  assert.deepEqual(made[0], { title: 'First', body: 'b1', createdBy: 'agent:implementer', attachments: [], sourceRunId: 'run_1' });
  assert.deepEqual(made[1], { title: 'Second', body: '', createdBy: 'agent:implementer', attachments: [], sourceRunId: 'run_1' });
});

test('drainTodosOutbox: a later role in the same run dir files nothing again', async () => {
  // The run dir is shared by the whole team: the implementer's items were filed three
  // times (implementer, tester, reviewer) before the outbox was moved aside on drain.
  const dir = await mkdtemp(join(tmpdir(), 'asf-todos-'));
  await writeFile(join(dir, 'todos.outbox.jsonl'), JSON.stringify({ title: 'Follow-up' }) + '\n');
  const made: CreateAdhocInput[] = [];
  for (const role of ['implementer', 'tester', 'reviewer']) {
    await drainTodosOutbox(dir, role, 'run_1', async (input) => { made.push(input); return null; });
  }
  await rm(dir, { recursive: true, force: true });
  assert.deepEqual(made.map((m) => [m.title, m.createdBy]), [['Follow-up', 'agent:implementer']]);
});

test('drainTodosOutbox: no-ops when the file is absent or empty', async () => {
  assert.deepEqual(await drainWith(null), []);
  assert.deepEqual(await drainWith('\n  \n'), []);
});

test('drainTodosOutbox: skips malformed lines and ones without a non-empty title', async () => {
  const made = await drainWith([
    'not json',
    JSON.stringify({ body: 'no title' }),
    JSON.stringify({ title: '   ' }),
    JSON.stringify({ title: 'Kept' }),
  ].join('\n'));
  assert.equal(made.length, 1);
  assert.equal(made[0].title, 'Kept');
});

test('drainTodosOutbox: enforces item cap and title/body length caps', async () => {
  const many = Array.from({ length: 25 }, (_, i) => JSON.stringify({ title: `t${i}` })).join('\n');
  assert.equal((await drainWith(many)).length, 20);

  const [big] = await drainWith(JSON.stringify({ title: 'x'.repeat(500), body: 'y'.repeat(200_000) }));
  assert.equal(big.title.length, 200);
  assert.equal(big.body.length, 100_000);
});
