import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRun, getRun, getEvents } from './store.js';
import { claimTask, finishTask, registerWorker } from './workers.js';
import { saveArtifact, getOpenGate } from './gates-store.js';
import { resolveGate } from './gates.js';
import { getSplitFamily } from './split.js';
import { createAdhoc } from './adhoc-store.js';
import { readyQueueEntries } from './queue-store.js';
import { dbAvailable, testDb, runInput, drain, AUTO_GATES } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('split'); });
after(async () => { if (db) await db.close(); });

const SPLIT_PLAN = `# Plan\n\nToo big for one PR, so three parts.\n\n\`\`\`asf-split
[
  { "title": "Data model", "body": "Add the tables and store." },
  { "title": "Tracker links", "body": "Jira and GitHub links." },
  { "title": "UI", "body": "Chips and the picker.", "dependsOn": [1, 2] }
]
\`\`\`\n`;

/** A run whose plan stage is AUTO (a common org setup) with the planner done and plan.md written. */
async function plannedRun(wid: string, key: string, plan: string, ticketId = key.toLowerCase()) {
  await drain(db.sql);
  await db.sql`UPDATE work_queue SET state = 'cancelled' WHERE state = 'queued'`;
  await registerWorker(db.sql, { id: wid, host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId, ticketKey: key, gates: AUTO_GATES, repoId: 'repo-1' }));
  const planner = await claimTask(db.sql, wid, ['claude-code']);
  assert.equal(planner?.task.role, 'planner');
  await saveArtifact(db.sql, run.id, 'plan.md', plan);
  await finishTask(db.sql, planner!.task.id, { outcome: 'done', outputRef: 'plan.md', costUsd: 0.1, reason: null });
  return run.id;
}

test('a plan proposing a split stops at the plan gate even when the plan stage is auto', { skip }, async () => {
  const runId = await plannedRun('s1', 'SP-1', SPLIT_PLAN);
  const gate = await getOpenGate(db.sql, runId);
  assert.equal(gate?.gateName, 'after_plan');
  assert.equal(gate?.mode, 'required');
  assert.equal((await getRun(db.sql, runId))!.run.state, 'awaiting_checkpoint');
});

test('an ordinary plan with an auto plan stage does not stop', { skip }, async () => {
  const runId = await plannedRun('s2', 'SP-2', '# Plan\n\nSmall change.');
  assert.equal(await getOpenGate(db.sql, runId), null);
  assert.equal((await claimTask(db.sql, 's2', ['claude-code']))?.task.role, 'implementer');
});

test('approving a split creates the parts, queues them with merge deps, and finishes the parent as split', { skip }, async () => {
  const runId = await plannedRun('s3', 'SP-3', SPLIT_PLAN);
  const gate = await getOpenGate(db.sql, runId);
  await resolveGate(db.sql, gate!.id, { decision: 'approve', by: 'jon', note: null, editedArtifact: null });

  const { run, tasks } = (await getRun(db.sql, runId))!;
  assert.equal(run.state, 'succeeded');
  assert.equal(run.deliveryOutcome, 'split');
  assert.ok(tasks.filter((t) => t.role !== 'planner').every((t) => t.state === 'skipped'), 'the parent builds nothing');
  assert.equal(await claimTask(db.sql, 's3', ['claude-code']), null, 'no implementer is claimable on the parent');

  const parts = await db.sql`SELECT id, key, title, body, part, parent_run_id FROM adhoc_task WHERE parent_run_id = ${runId} ORDER BY part`;
  assert.equal(parts.length, 3);
  assert.match(String(parts[0].title), /^Data model \(SP-3 part 1\/3\)$/);
  assert.match(String(parts[2].body), /part 3 of 3 of SP-3/);
  assert.match(String(parts[2].body), new RegExp(`after ${parts[0].key}, ${parts[1].key} are merged`));

  const queued = await db.sql`SELECT ticket_id, ticket_provider, repo_id, mode, depends_on FROM work_queue WHERE state = 'queued' ORDER BY position`;
  assert.deepEqual(queued.map((q) => q.ticketId), parts.map((p) => p.id), 'queued in plan order');
  assert.ok(queued.every((q) => q.ticketProvider === 'adhoc' && q.repoId === 'repo-1' && q.mode === 'parallel'));
  assert.deepEqual(queued[2].dependsOn, [parts[0].id, parts[1].id]);

  // Parts 1 and 2 may start now (in parallel); part 3 waits for both to MERGE.
  const ready = async () => (await readyQueueEntries(db.sql, 10)).map((e) => e.ticketKey);
  assert.deepEqual(await ready(), [parts[0].key, parts[1].key]);

  // Part 1 merged by ASF, part 2 only has an OPEN PR: part 3 still waits.
  await db.sql`INSERT INTO agent_run (id, ticket_id, ticket_key, ticket_provider, state, team_name, team, gates, max_cost_usd, delivery_outcome)
    VALUES ('run_p1', ${parts[0].id}, ${parts[0].key}, 'adhoc', 'succeeded', 'standard', '{}', '{}', 5, 'merged')`;
  await db.sql`INSERT INTO agent_run (id, ticket_id, ticket_key, ticket_provider, state, team_name, team, gates, max_cost_usd, delivery_outcome, change_request_state)
    VALUES ('run_p2', ${parts[1].id}, ${parts[1].key}, 'adhoc', 'succeeded', 'standard', '{}', '{}', 5, 'awaiting_external_merge', 'open')`;
  await db.sql`UPDATE work_queue SET state = 'dispatched' WHERE ticket_id IN (${parts[0].id}, ${parts[1].id})`;
  assert.deepEqual(await ready(), [], 'an open PR is not merged');

  // A person merges part 2 (the merge watcher stamps change_request_state merged): part 3 is ready.
  await db.sql`UPDATE agent_run SET change_request_state = 'merged' WHERE id = 'run_p2'`;
  assert.deepEqual(await ready(), [parts[2].key]);

  const ev = (await getEvents(db.sql, runId, 0, 1000)).find((e) => e.kind === 'run:split');
  assert.equal((ev?.payload.parts as unknown[]).length, 3);

  // The run page's view of the split, from the parent and from a part's run (#split UX).
  const fam = await getSplitFamily(db.sql, runId);
  assert.ok(fam);
  assert.equal(fam!.parent.runId, runId);
  assert.equal(fam!.currentPart, null, 'viewing the parent');
  assert.deepEqual(fam!.parts.map((p) => p.title), ['Data model', 'Tracker links', 'UI'], 'titles without the "(KEY part n/m)" suffix');
  assert.deepEqual(fam!.parts.map((p) => p.merged), [true, true, false]);
  assert.equal(fam!.parts[0].run?.id, 'run_p1');
  assert.equal(fam!.parts[1].run?.changeRequestState, 'merged');
  assert.equal(fam!.parts[2].run, null, 'part 3 not started');
  assert.deepEqual(fam!.parts[2].dependsOn, [parts[0].key, parts[1].key]);
  assert.deepEqual(fam!.parts[2].waitingOn, [], 'both deps merged -> waiting on nothing');
  assert.equal(fam!.parts[2].queueState, 'queued');
  const fromPart = await getSplitFamily(db.sql, 'run_p2');
  assert.equal(fromPart?.parent.runId, runId);
  assert.equal(fromPart?.currentPart, 2);
  assert.equal(fromPart?.parts.length, 3);
  // Before part 2 merged, part 3 named it as what it waits on.
  await db.sql`UPDATE agent_run SET change_request_state = 'open' WHERE id = 'run_p2'`;
  assert.deepEqual((await getSplitFamily(db.sql, runId))!.parts[2].waitingOn, [parts[1].key]);
  // An ordinary run is in no split.
  assert.equal(await getSplitFamily(db.sql, 'run_nonexistent'), null);
  await db.sql`DELETE FROM agent_run WHERE id IN ('run_p1','run_p2')`;
});

test('an edited plan at approval is what gets split (a person can remove or reshape the split)', { skip }, async () => {
  const runId = await plannedRun('s4', 'SP-4', SPLIT_PLAN);
  const gate = await getOpenGate(db.sql, runId);
  await resolveGate(db.sql, gate!.id, { decision: 'approve', by: 'jon', note: null, editedArtifact: '# Plan\n\nDo it in one go after all.' });
  const { run } = (await getRun(db.sql, runId))!;
  assert.equal(run.state, 'running', 'no split block -> the team builds it as one');
  assert.equal(run.deliveryOutcome, null);
  assert.equal((await claimTask(db.sql, 's4', ['claude-code']))?.task.role, 'implementer');
});

test('a part naming another repository is queued for it; the others keep the parent repository', { skip }, async () => {
  const plan = '# Plan\n\n```asf-split\n[{"title": "Here", "body": "b"}, {"title": "There", "body": "b", "repo": "repo-2"}]\n```\n';
  const runId = await plannedRun('s7', 'SP-7', plan);
  const gate = await getOpenGate(db.sql, runId);
  await resolveGate(db.sql, gate!.id, { decision: 'approve', by: 'jon', note: null, editedArtifact: null });
  const parts = await db.sql`SELECT id, body FROM adhoc_task WHERE parent_run_id = ${runId} ORDER BY part`;
  const queued = await db.sql`SELECT ticket_id, repo_id FROM work_queue WHERE ticket_id IN ${db.sql(parts.map((p) => String(p.id)))} ORDER BY position`;
  assert.deepEqual(queued.map((q) => q.repoId), ['repo-1', 'repo-2']);
  assert.match(String(parts[1].body), /goes into the repository `repo-2`/);
});

test('a malformed split is refused at approval with the reason; the gate stays open', { skip }, async () => {
  const bad = '# Plan\n\n```asf-split\n[{"title": "only one", "body": "b"}]\n```\n';
  const runId = await plannedRun('s5', 'SP-5', bad);
  const gate = await getOpenGate(db.sql, runId);
  assert.equal(gate?.mode, 'required', 'an invalid block still stops for a person');
  await assert.rejects(resolveGate(db.sql, gate!.id, { decision: 'approve', by: 'jon', note: null, editedArtifact: null }), /at least 2/);
  assert.equal((await getOpenGate(db.sql, runId))?.id, gate!.id);
  assert.equal((await getRun(db.sql, runId))!.run.state, 'awaiting_checkpoint');
});

test('a part of a split cannot itself be split', { skip }, async () => {
  const child = await createAdhoc(db.sql, { title: 'part', body: 'b', createdBy: 'planner', attachments: [] });
  await db.sql`UPDATE adhoc_task SET parent_run_id = 'run_parent', part = 1 WHERE id = ${child.id}`;
  const runId = await plannedRun('s6', child.key, SPLIT_PLAN, child.id);
  const gate = await getOpenGate(db.sql, runId);
  await assert.rejects(resolveGate(db.sql, gate!.id, { decision: 'approve', by: 'jon', note: null, editedArtifact: null }), /already a part of a split/);
});
