import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GATES } from '@asf/shared';
import { createRun, getRun, getEvents, appendEvent } from './store.js';
import { claimTask, finishTask, registerWorker } from './workers.js';
import { getOpenGate, saveArtifact } from './gates-store.js';
import { moveRunToRepo, MoveError } from './move.js';
import { recordRepoChoice, latestChoiceForEpic } from './repo-choice.js';
import { dbAvailable, testDb, runInput, drain } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('move'); });
after(async () => { if (db) await db.close(); });

const choices = async (runId: string) => db.sql`SELECT * FROM ticket_repo_choice WHERE run_id = ${runId} ORDER BY id`;

test('a planner parked at needs_human moves to the new repo and restarts from the planner', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'mv1', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId: 'mv-nh', ticketKey: 'MV-1', repoId: 'github:acme/web', epicId: 'EPIC-1' }));
  const planner = await claimTask(db.sql, 'mv1', ['claude-code']);
  await db.sql`UPDATE agent_run SET worktree_path = '/tmp/wt', branch_name = 'agent/MV-1' WHERE id = ${run.id}`;
  await finishTask(db.sql, planner!.task.id, { outcome: 'needs_human', outputRef: null, costUsd: 0.1, reason: 'this looks like the wrong repo' });
  assert.equal((await getRun(db.sql, run.id))!.run.state, 'awaiting_checkpoint');
  const oldIds = (await getRun(db.sql, run.id))!.tasks.map((t) => t.id);

  await moveRunToRepo(db.sql, run.id, { repoId: 'github:acme/api', repoConnection: null, by: 'jon', note: 'it is the api' });

  const after = await getRun(db.sql, run.id);
  assert.equal(after!.run.repoId, 'github:acme/api');
  assert.equal(after!.run.worktreePath, null);
  assert.equal(after!.run.branchName, null);
  assert.equal(after!.run.state, 'running');
  assert.equal(after!.run.reason, null);
  assert.equal(after!.run.costUsd, 0.1, 'the spend stays with the run');
  const [row] = await db.sql`SELECT repo_connection FROM agent_run WHERE id = ${run.id}`;
  assert.equal(row.repoConnection, 'github');
  for (const t of after!.tasks.filter((x) => oldIds.includes(x.id))) assert.equal(t.state, 'skipped', `${t.role} is skipped`);
  const fresh = after!.tasks.filter((t) => !oldIds.includes(t.id));
  assert.deepEqual(fresh.map((t) => String(t.role)), ['planner', 'implementer', 'tester', 'reviewer']);
  assert.ok(fresh.every((t) => t.state === 'pending' && t.queuedBy === 'move'));

  const moved = (await getEvents(db.sql, run.id, 0, 200)).find((e) => e.kind === 'run:moved');
  assert.deepEqual(moved?.payload, { from: 'github:acme/web', to: 'github:acme/api', by: 'jon', note: 'it is the api' });

  const again = await claimTask(db.sql, 'mv1', ['claude-code']);
  assert.equal(again?.task.role, 'planner');
  assert.equal(again?.run.repoId, 'github:acme/api');

  // The dispatch row at createRun, then the correction, which keeps the epic.
  const rows = await choices(run.id);
  assert.deepEqual(rows.map((r) => [r.kind, r.repoId, r.repoConnection, r.fromRepoId, r.epicId, r.by]), [
    ['dispatch', 'github:acme/web', 'github', null, 'EPIC-1', 'test'],
    ['correction', 'github:acme/api', 'github', 'github:acme/web', 'EPIC-1', 'jon'],
  ]);
});

test('a move abandons an open after_plan gate', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'mv2', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId: 'mv-gate', ticketKey: 'MV-2', gates: DEFAULT_GATES, repoId: 'github:acme/web' }));
  const planner = await claimTask(db.sql, 'mv2', ['claude-code']);
  await saveArtifact(db.sql, run.id, 'plan.md', 'THE PLAN');
  await finishTask(db.sql, planner!.task.id, { outcome: 'done', outputRef: 'plan.md', costUsd: 0, reason: null });
  const gate = await getOpenGate(db.sql, run.id);
  assert.equal(gate?.gateName, 'after_plan');

  await moveRunToRepo(db.sql, run.id, { repoId: 'github:acme/api', repoConnection: 'github', by: 'jon', note: null });

  const [g] = await db.sql`SELECT state FROM run_gate WHERE id = ${gate!.id}`;
  assert.equal(g.state, 'abandoned');
  assert.equal(await getOpenGate(db.sql, run.id), null);
  assert.equal((await getRun(db.sql, run.id))!.run.state, 'running');
  assert.equal((await claimTask(db.sql, 'mv2', ['claude-code']))?.task.role, 'planner');
});

test('a move is refused with a reason', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'mv3', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const move = (runId: string, repoId = 'github:acme/api') => moveRunToRepo(db.sql, runId, { repoId, repoConnection: null, by: null, note: null });

  // A running task.
  const { run: busy } = await createRun(db.sql, runInput({ ticketId: 'mv-busy', ticketKey: 'MV-3', repoId: 'github:acme/web' }));
  const planner = await claimTask(db.sql, 'mv3', ['claude-code']);
  await assert.rejects(() => move(busy.id), (e) => e instanceof MoveError && /task running/.test(e.message));
  await finishTask(db.sql, planner!.task.id, { outcome: 'needs_human', outputRef: null, costUsd: 0, reason: 'wrong repo?' });

  // The same repo.
  await assert.rejects(() => move(busy.id, 'github:acme/web'), (e) => e instanceof MoveError && /already in github:acme\/web/.test(e.message));

  // A change request already opened.
  await appendEvent(db.sql, { runId: busy.id, taskId: null, kind: 'change_request:opened', source: 'worker', payload: { url: 'https://x/pr/7', number: 7 } });
  await assert.rejects(() => move(busy.id), (e) => e instanceof MoveError && /change request #7/.test(e.message));

  // A terminal run.
  await drain(db.sql);
  await assert.rejects(() => move(busy.id), (e) => e instanceof MoveError && /cancelled/.test(e.message));
  assert.equal((await getRun(db.sql, busy.id))!.run.repoId, 'github:acme/web', 'nothing changed');
  assert.equal((await choices(busy.id)).length, 1, 'only the dispatch row');
});

test('createRun with no repo writes no choice, and latestChoiceForEpic prefers a correction over a newer dispatch', { skip }, async () => {
  await drain(db.sql);
  const { run: bare } = await createRun(db.sql, runInput({ ticketId: 'mv-none', ticketKey: 'MV-4', repoId: null, epicId: 'EPIC-2' }));
  assert.equal((await choices(bare.id)).length, 0);
  assert.equal(await latestChoiceForEpic(db.sql, 'EPIC-2'), null);

  const base = { ticketProvider: 'mock', ticketKey: 'MV-5', epicId: 'EPIC-2', runId: bare.id, repoConnection: 'github' };
  await recordRepoChoice(db.sql, { ...base, ticketId: 'mv-5', repoId: 'github:acme/api', kind: 'correction', fromRepoId: 'github:acme/web', by: 'jon' });
  await recordRepoChoice(db.sql, { ...base, ticketId: 'mv-6', repoId: 'github:acme/web', kind: 'dispatch' });
  const latest = await latestChoiceForEpic(db.sql, 'EPIC-2');
  assert.equal(latest?.kind, 'correction');
  assert.equal(latest?.repoId, 'github:acme/api');
  assert.equal(latest?.fromRepoId, 'github:acme/web');
  assert.equal(await latestChoiceForEpic(db.sql, 'EPIC-none'), null);

  // An unprefixed repo id has no known connection.
  const { run: plain } = await createRun(db.sql, runInput({ ticketId: 'mv-plain', ticketKey: 'MV-7', repoId: 'acme/web' }));
  assert.equal((await choices(plain.id))[0].repoConnection, null);
});
