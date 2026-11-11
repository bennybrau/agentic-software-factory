import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRun } from './store.js';
import { appendMessage, listMessages } from './chat.js';
import { listGates } from './gates-store.js';
import { hiveDialog, markHiveSent } from './hive-dialog.js';
import { dbAvailable, testDb, runInput } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('hive_dialog'); });
after(async () => { if (db) await db.close(); });

async function mkRun(key: string, repo: string | null = 'example/app') {
  const { run } = await createRun(db.sql, runInput({ ticketId: `hd-${key}`, ticketKey: `HD-${key}`, repoId: repo }));
  await db.sql`UPDATE agent_run SET repo_id = ${repo} WHERE id = ${run.id}`;
  return run.id;
}
async function gate(runId: string, id: string, note: string | null, artifact: string | null, ago = '1 minute') {
  await db.sql`INSERT INTO run_gate (id, run_id, gate_name, mode, state, artifact, decided_by, note, decided_at)
    VALUES (${id}, ${runId}, 'after_plan', 'required', 'approved', ${artifact}, 'jon', ${note}, now() - ${ago}::interval)`;
}
async function msg(runId: string, author: 'agent' | 'human', body: string, by: string | null) {
  const m = await appendMessage(db.sql, { runId, taskId: null, role: 'planner', author, kind: author === 'agent' ? 'question' : 'reply', body, by, sessionId: null });
  return m.id;
}
const mine = async (runIds: string[], since?: string) =>
  (await hiveDialog(db.sql, { since, limit: 1000 })).filter((i) => runIds.includes(i.runId));

test('hiveDialog: a gate with a note is returned (artifact cut at 1,500 chars); a blank note is not', { skip }, async () => {
  const runId = await mkRun('gate');
  await gate(runId, 'gate_hd_note', 'Use Node, not Python.', 'x'.repeat(2000));
  await gate(runId, 'gate_hd_blank', '   ', 'plan');
  await gate(runId, 'gate_hd_null', null, 'plan');
  const items = await mine([runId]);
  assert.equal(items.length, 1);
  assert.deepEqual({ ...items[0], answer: items[0].answer.length, at: typeof items[0].at },
    { kind: 'gate', runId, repoId: 'example/app', id: 'gate_hd_note', text: 'Use Node, not Python.', answer: 1500, author: 'jon', at: 'string' });
});

test('hiveDialog: a human message is paired with the agent message before it; agent messages alone are not returned', { skip }, async () => {
  const runId = await mkRun('msg');
  const early = await msg(runId, 'human', 'hello?', 'jon');
  await msg(runId, 'agent', 'Python or Node?', null);
  await msg(runId, 'agent', 'Postgres or SQLite?', null);
  const reply = await msg(runId, 'human', 'Postgres.', 'jon');
  await msg(runId, 'agent', 'thanks', null);
  const items = await mine([runId]);
  assert.deepEqual(items.map((i) => [i.kind, i.id, i.text, i.answer, i.author]), [
    ['msg', early, 'hello?', '', 'jon'],
    ['msg', reply, 'Postgres.', 'Postgres or SQLite?', 'jon'],
  ]);
});

test('hiveDialog: since filters; a run with no repo is excluded; ordered by time', { skip }, async () => {
  const runId = await mkRun('since');
  const noRepo = await mkRun('norepo', null);
  await gate(runId, 'gate_hd_old', 'old note', 'p', '3 days');
  await gate(runId, 'gate_hd_new', 'new note', 'p', '1 hour');
  await gate(noRepo, 'gate_hd_norepo', 'note', 'p', '1 hour');
  await msg(noRepo, 'human', 'hi', 'jon');
  const all = await mine([runId, noRepo]);
  assert.deepEqual(all.map((i) => i.id), ['gate_hd_old', 'gate_hd_new']);
  const since = new Date(Date.now() - 86_400_000).toISOString();
  assert.deepEqual((await mine([runId, noRepo], since)).map((i) => i.id), ['gate_hd_new']);
});

test('markHiveSent: stamps a gate and a message once; listGates and listMessages carry hiveSentAt', { skip }, async () => {
  const runId = await mkRun('sent');
  await gate(runId, 'gate_hd_sent', 'Use Node.', 'plan');
  await gate(runId, 'gate_hd_unsent', 'later', 'plan');
  const m = await msg(runId, 'human', 'Postgres.', 'jon');
  assert.deepEqual((await listGates(db.sql, runId)).map((g) => g.hiveSentAt), [null, null]);
  assert.equal((await listMessages(db.sql, runId))[0].hiveSentAt, null);

  await markHiveSent(db.sql, 'gate', 'gate_hd_sent');
  await markHiveSent(db.sql, 'msg', m);
  const sentGate = (await listGates(db.sql, runId)).find((g) => g.id === 'gate_hd_sent')!.hiveSentAt;
  const sentMsg = (await listMessages(db.sql, runId))[0].hiveSentAt;
  assert.ok(sentGate && !Number.isNaN(Date.parse(sentGate)));
  assert.ok(sentMsg && !Number.isNaN(Date.parse(sentMsg)));
  assert.equal((await listGates(db.sql, runId)).find((g) => g.id === 'gate_hd_unsent')!.hiveSentAt, null);

  // A second mark keeps the first time.
  await new Promise((r) => setTimeout(r, 20));
  await markHiveSent(db.sql, 'gate', 'gate_hd_sent');
  await markHiveSent(db.sql, 'msg', m);
  assert.equal((await listGates(db.sql, runId)).find((g) => g.id === 'gate_hd_sent')!.hiveSentAt, sentGate);
  assert.equal((await listMessages(db.sql, runId))[0].hiveSentAt, sentMsg);
});
