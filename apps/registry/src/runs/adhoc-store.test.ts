import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAdhoc, getAdhoc, getAdhocAttachment, listAdhoc, deleteAdhoc } from './adhoc-store.js';
import { rpcHandlers } from '../routes/rpc.js';
import { createRun } from './store.js';
import { dbAvailable, testDb, runInput } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('adhoc'); });
after(async () => { if (db) await db.close(); });

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);

test('createAdhoc stores the task and its attachments; getAdhoc reads them back in order', { skip }, async () => {
  const task = await createAdhoc(db.sql, {
    title: 'Fix the login page', body: '## Steps\n\nIt breaks.', createdBy: 'ana',
    attachments: [
      { name: 'shot.png', mime: 'image/png', contentBase64: png.toString('base64') },
      { name: 'notes.txt', mime: 'text/plain', contentBase64: Buffer.from('hello').toString('base64') },
    ],
  });
  assert.match(task.id, /^adhoc:[0-9a-f]{16}$/);
  assert.match(task.key, /^ADHOC-[0-9A-F]{8}$/);
  assert.equal(task.title, 'Fix the login page');
  assert.equal(task.createdBy, 'ana');
  assert.deepEqual(task.attachments, [
    { name: 'shot.png', mime: 'image/png', size: png.length },
    { name: 'notes.txt', mime: 'text/plain', size: 5 },
  ]);

  const again = await getAdhoc(db.sql, task.id);
  assert.deepEqual(again, task);
});

test('an agent to-do carries the repository of the run that added it; a hand-made one has none', { skip }, async () => {
  const { run } = await createRun(db.sql, runInput({ ticketId: 'src-1', ticketKey: 'SRC-1', repoId: 'bennybrau/hive' }));
  const todo = await createAdhoc(db.sql, { title: 'Follow-up', body: '', createdBy: 'agent:implementer', attachments: [], sourceRunId: run.id });
  const hand = await createAdhoc(db.sql, { title: 'By hand', body: '', createdBy: 'ana', attachments: [] });
  assert.equal(todo.sourceRepoId, 'bennybrau/hive');
  assert.equal((await getAdhoc(db.sql, todo.id))!.sourceRepoId, 'bennybrau/hive');
  assert.equal(hand.sourceRepoId, null);
  const listed = await listAdhoc(db.sql);
  assert.equal(listed.find((t) => t.id === todo.id)?.sourceRepoId, 'bennybrau/hive');
  assert.equal(listed.find((t) => t.id === hand.id)?.sourceRepoId, null);
});

test('getAdhocAttachment returns the exact bytes; unknown task or name is null', { skip }, async () => {
  const task = await createAdhoc(db.sql, { title: 'T', body: '', createdBy: null,
    attachments: [{ name: 'shot.png', mime: 'image/png', contentBase64: png.toString('base64') }] });
  const a = await getAdhocAttachment(db.sql, task.id, 'shot.png');
  assert.ok(a);
  assert.deepEqual(Buffer.from(a!.contentBase64, 'base64'), png);
  assert.equal(a!.mime, 'image/png');
  assert.equal(await getAdhocAttachment(db.sql, task.id, 'nope.png'), null);
  assert.equal(await getAdhocAttachment(db.sql, 'adhoc:missing', 'shot.png'), null);
  assert.equal(await getAdhoc(db.sql, 'adhoc:missing'), null);
});

test('listAdhoc returns only run-less tasks; deleteAdhoc removes one', { skip }, async () => {
  await db.sql`DELETE FROM adhoc_task`;
  const consumed = await createAdhoc(db.sql, { title: 'Has a run', body: '', createdBy: null, attachments: [] });
  const free = await createAdhoc(db.sql, { title: 'Still waiting', body: '',
    createdBy: null, attachments: [{ name: 'shot.png', mime: 'image/png', contentBase64: png.toString('base64') }] });
  // A run that consumed the first task's ticket id hides it from the list.
  await db.sql`INSERT INTO agent_run (id, ticket_id, ticket_key, ticket_provider, state, team_name, team, gates, max_cost_usd)
    VALUES ('run_x', ${consumed.id}, ${consumed.key}, 'adhoc', 'running', 't', '{}'::jsonb, '{}'::jsonb, 100)`;

  const listed = await listAdhoc(db.sql);
  assert.deepEqual(listed.map((t) => t.id), [free.id]);
  assert.deepEqual(listed[0], free, 'same AdhocTask shape, with attachment metadata');

  assert.equal(await deleteAdhoc(db.sql, free.id), true);
  assert.equal(await deleteAdhoc(db.sql, free.id), false, 'already gone');
  assert.equal(await getAdhoc(db.sql, free.id), null);
  assert.deepEqual(await listAdhoc(db.sql), []);
});

test('the RPC ops round-trip a task with no attachments', { skip }, async () => {
  const h = rpcHandlers(db.sql);
  const { task } = await h.createAdhoc({ op: 'createAdhoc', input: { title: 'Plain', body: 'x', createdBy: null, attachments: [] } });
  assert.deepEqual(task.attachments, []);
  assert.deepEqual((await h.getAdhoc({ op: 'getAdhoc', id: task.id })).task, task);
  assert.equal((await h.getAdhocAttachment({ op: 'getAdhocAttachment', id: task.id, name: 'x' })).attachment, null);
});

test('the listAdhoc/deleteAdhoc RPC ops dispatch to the store', { skip }, async () => {
  await db.sql`DELETE FROM adhoc_task`;
  const h = rpcHandlers(db.sql);
  const { task } = await h.createAdhoc({ op: 'createAdhoc', input: { title: 'Via RPC', body: '', createdBy: null, attachments: [] } });
  assert.deepEqual((await h.listAdhoc({ op: 'listAdhoc' })).tasks, [task]);
  assert.equal((await h.deleteAdhoc({ op: 'deleteAdhoc', id: task.id })).ok, true);
  assert.deepEqual((await h.listAdhoc({ op: 'listAdhoc' })).tasks, []);
});

test('getAdhoc carries the creating schedule\'s title, or null once the schedule is deleted', { skip }, async () => {
  const task = await createAdhoc(db.sql, { title: 'T', body: '', createdBy: null, attachments: [] });
  assert.equal(task.recurringTitle, null);
  await db.sql`INSERT INTO recurring_task (id, title, body, repo_id, schedule, timezone, paused, next_run_at)
    VALUES ('rec_t', 'Update deps', '', 'repo-1', ${db.sql.json({ kind: 'daily', time: '09:00' })}, 'UTC', false, now())`;
  await db.sql`UPDATE adhoc_task SET recurring_id = 'rec_t' WHERE id = ${task.id}`;
  const got = await getAdhoc(db.sql, task.id);
  assert.equal(got!.recurringId, 'rec_t');
  assert.equal(got!.recurringTitle, 'Update deps');
  await db.sql`DELETE FROM recurring_task WHERE id = 'rec_t'`;
  const orphan = await getAdhoc(db.sql, task.id);
  assert.equal(orphan!.recurringId, 'rec_t');
  assert.equal(orphan!.recurringTitle, null);
});
