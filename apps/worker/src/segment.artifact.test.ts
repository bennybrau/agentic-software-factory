import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaimResponse, RunContext, Run, RunAuth } from '@asf/shared';
import { STANDARD_TEAM, DEFAULT_GATES } from '@asf/shared';

// #41: a role that finishes `done` without writing its declared output file. Runs the
// real runSegment against a fake `claude` that writes NO file and replies with whatever
// the test puts in `reply.txt` (empty = an empty reply).

let dir: string;
let segment: typeof import('./segment.js');
let apiMod: typeof import('./api.js');
let cfg: typeof import('./config.js');
type Ev = { kind: string; payload: Record<string, unknown> };
let events: Ev[] = [];
let saved: { name: string; body: string }[] = [];
let messages: { kind: string; body: string }[] = [];
const PATCHED = ['event', 'saveArtifact', 'listArtifacts', 'listArtifactVersions', 'listMessages', 'listAdhoc', 'cancelRequested', 'appendMessage', 'createAdhoc', 'attachment'] as const;
const realApi = {} as Record<string, unknown>;
let replyFile: string;
let writeFileTo: string; // when set, the fake agent writes its artifact here (the normal case)

async function fakeClaude(): Promise<string> {
  const bin = join(dir, 'claude');
  // Emit the result envelope with the reply text JSON-escaped by node (the fake's only dependency).
  await writeFile(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
if [ -s "${dir}/write-to.txt" ]; then printf '# Plan\\n\\nfrom the file\\n' > "$(cat "${dir}/write-to.txt")"; fi
exec node -e 'const r=require("fs").readFileSync(process.argv[1],"utf8");process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:r,num_turns:2,total_cost_usd:0,usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0}})+"\\n")' "${replyFile}"
`);
  await chmod(bin, 0o755);
  return bin;
}

const RUN_ID = 'run_artifact001';
const run = (): Run => ({
  id: RUN_ID, ticketId: 't1', ticketKey: 'ASF-41', ticketProvider: 'mock', state: 'running',
  teamName: 'standard', team: STANDARD_TEAM, gates: DEFAULT_GATES, repoId: null, worktreePath: null, branchName: null,
  changeRequestUrl: null, changeRequestNumber: null, changeRequestState: null, deliveryOutcome: null, costUsd: 0, maxCostUsd: 15, reviewIterations: 0, dispatchedBy: 'test', reason: null,
  createdAt: new Date().toISOString(), startedAt: null, lastEventAt: null, cancelRequestedAt: null, finishedAt: null,
});
const claim = (role: string, outputRef: string): ClaimResponse & object => ({
  run: run(), team: STANDARD_TEAM,
  task: { id: `task_${Math.random().toString(36).slice(2, 8)}`, runId: RUN_ID, role, seq: 1, state: 'running', attempt: 1, inputRef: null, outputRef,
    workerId: 'w', runtime: 'claude-code', model: 'claude-sonnet-5', effort: 'low', costUsd: 0, gateChecked: false, startedAt: null, finishedAt: null,
    reason: null, queuedBy: 'plan', queuedReason: null },
}) as unknown as ClaimResponse & object;

const anth: RunAuth = { providerKind: 'anthropic', mode: 'api-key', credential: 'sk-ant' };
const ctx = (): RunContext => ({
  runId: RUN_ID, ticket: { id: 't1', key: 'ASF-41', title: 'T', body: 'B', url: 'u', links: [] },
  repo: null, cloneCredential: null, auth: anth, auths: { anthropic: anth }, roleSkills: {}, thirdPartySkills: [],
  workerSettings: { maxTurns: 40, segmentTimeoutMs: 60_000 },
}) as unknown as RunContext;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asf-segart-'));
  replyFile = join(dir, 'reply.txt');
  process.env.RUN_DATA_ROOT = join(dir, 'runs');
  process.env.WORKTREE_ROOT = join(dir, 'wt');
  process.env.WORKER_ID = 'worker-test-1';
  cfg = await import('./config.js');
  apiMod = await import('./api.js');
  segment = await import('./segment.js');
  for (const k of PATCHED) realApi[k] = (apiMod.api as Record<string, unknown>)[k];
  (cfg.config as { claudeBin: string }).claudeBin = await fakeClaude();
});
after(async () => {
  for (const k of PATCHED) (apiMod.api as Record<string, unknown>)[k] = realApi[k];
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  events = []; saved = []; messages = [];
  writeFileTo = '';
  await writeFile(join(dir, 'write-to.txt'), '');
  await rm(join(dir, 'runs'), { recursive: true, force: true });
  const a = apiMod.api as Record<string, unknown>;
  a.event = async (_runId: string, kind: string, payload: Record<string, unknown>) => { events.push({ kind, payload }); };
  a.saveArtifact = async (_runId: string, name: string, body: string) => { saved.push({ name, body }); };
  a.listArtifacts = async () => ({});
  a.listArtifactVersions = async () => [];
  a.listMessages = async () => [];
  a.listAdhoc = async () => [];
  a.cancelRequested = async () => false;
  a.appendMessage = async (m: { kind: string; body: string }) => { messages.push(m); };
  a.createAdhoc = async () => null;
  a.attachment = async () => Buffer.from('');
});

const runDir = () => join(dir, 'runs', RUN_ID);

test('a planner that replies with its plan but writes no plan.md: the reply becomes plan.md, and says so', async () => {
  const plan = '## Plan\n\n1. Add a test for enforceTimeLimit.\n2. Run it against Postgres.';
  await writeFile(replyFile, plan);
  const res = await segment.runSegment(claim('planner', 'plan.md'), ctx(), () => {});
  assert.equal(res.outcome, 'done', res.reason ?? '');
  const planMd = saved.filter((s) => s.name === 'plan.md');
  assert.equal(planMd.length, 1, 'the gate gets a plan.md');
  assert.equal(planMd[0].body.trim(), plan);
  assert.equal((await readFile(join(runDir(), 'plan.md'), 'utf8')).trim(), plan, 'later roles find it in the run dir');
  const ev = events.find((e) => e.kind === 'artifact:from_reply');
  assert.ok(ev, 'an event says the reply was used');
  assert.equal(ev.payload.name, 'plan.md');
  assert.equal(ev.payload.role, 'planner');
});

test('a reviewer that writes no review.md: its reply (verdict first) becomes review.md', async () => {
  await writeFile(replyFile, 'APPROVE\n\nThe change matches the plan.');
  const res = await segment.runSegment(claim('reviewer', 'review.md'), ctx(), () => {});
  assert.equal(res.outcome, 'done', res.reason ?? '');
  assert.equal(saved.find((s) => s.name === 'review.md')?.body.split('\n')[0], 'APPROVE');
});

test('no file and an empty reply: the task fails with a clear reason instead of finishing done', async () => {
  await writeFile(replyFile, '   \n');
  const res = await segment.runSegment(claim('planner', 'plan.md'), ctx(), () => {});
  assert.equal(res.outcome, 'failed');
  assert.match(res.reason ?? '', /finished without writing plan\.md/);
  assert.match(res.reason ?? '', /Retry the role/);
  assert.ok(!saved.some((s) => s.name === 'plan.md'), 'nothing saved as plan.md');
  assert.ok(events.some((e) => e.kind === 'artifact:missing' && e.payload.name === 'plan.md'));
  assert.ok(!messages.some((m) => m.kind === 'plan'), 'no "here is the plan" chat message for a failed planner');
  assert.equal(events.find((e) => e.kind === 'segment:finished')?.payload.outcome, 'failed');
});

test('a role that writes its file: the file wins over the reply, and no fallback event', async () => {
  await mkdir(runDir(), { recursive: true });
  writeFileTo = join(runDir(), 'plan.md');
  await writeFile(join(dir, 'write-to.txt'), writeFileTo);
  await writeFile(replyFile, 'Plan written to plan.md. Ready for review.');
  const res = await segment.runSegment(claim('planner', 'plan.md'), ctx(), () => {});
  assert.equal(res.outcome, 'done', res.reason ?? '');
  assert.match(saved.find((s) => s.name === 'plan.md')?.body ?? '', /from the file/);
  assert.ok(!events.some((e) => e.kind.startsWith('artifact:')), 'no fallback, no missing');
});

test('resolveOutputArtifact: file, then reply, then missing; whitespace counts as absent', async () => {
  const d = await mkdtemp(join(tmpdir(), 'asf-resolve-'));
  try {
    assert.deepEqual(await segment.resolveOutputArtifact(d, 'plan.md', undefined, '  '), { source: 'missing' });
    assert.deepEqual(await segment.resolveOutputArtifact(d, 'plan.md', undefined, null), { source: 'missing' });
    assert.deepEqual(await segment.resolveOutputArtifact(d, 'plan.md', undefined, ' the plan '), { source: 'reply', body: 'the plan\n' });
    await writeFile(join(d, 'plan.md'), '\n\n');
    assert.equal((await segment.resolveOutputArtifact(d, 'plan.md', undefined, 'r')).source, 'reply', 'an empty file is no artifact');
    await writeFile(join(d, 'plan.md'), 'real plan');
    assert.deepEqual(await segment.resolveOutputArtifact(d, 'plan.md', undefined, 'r'), { source: 'file', body: 'real plan' });
  } finally { await rm(d, { recursive: true, force: true }); }
});
