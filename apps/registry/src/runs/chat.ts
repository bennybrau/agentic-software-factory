import type { RunMessageInput, RunMessageWire } from '@asf/shared';
import type { Sql, Db } from '../db/pool.js';
import { appendEventTx, getRun } from './store.js';
import { advance } from './orchestrate.js';
import { newId } from './ids.js';

/**
 * The planner chat. The plan stage is a conversation instead of an approve/reject
 * form: the planner either asks its blocking questions (the task parks at
 * needs_human) or writes plan.md and the run waits at the after_plan gate. Either
 * way a person can reply in the chat, which re-runs the planner with the thread;
 * approving the gate ends the conversation and the rest of the team just goes.
 *
 * Every turn (agent and human) is a run_message row. The worker records the
 * agent's turns (with the runtime session id, so the next turn can resume it);
 * a human's turn goes through sendChatMessage below.
 */

export class ChatError extends Error {}

/** The role the chat talks to. Only the planner is conversational; the rest of the team just goes. */
export const CHAT_ROLE = 'planner';

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
function toMessage(r: Record<string, unknown>): RunMessageWire {
  return {
    id: String(r.id), runId: String(r.runId), taskId: r.taskId ? String(r.taskId) : null, role: String(r.role),
    author: String(r.author) as RunMessageWire['author'], kind: String(r.kind) as RunMessageWire['kind'],
    body: String(r.body), by: r.byUser ? String(r.byUser) : null, sessionId: r.sessionId ? String(r.sessionId) : null,
    createdAt: iso(r.createdAt), hiveSentAt: r.hiveSentAt == null ? null : iso(r.hiveSentAt),
  };
}

export async function appendMessage(sql: Db, m: RunMessageInput): Promise<RunMessageWire> {
  const rows = await sql`INSERT INTO run_message (id, run_id, task_id, role, author, kind, body, by_user, session_id)
    VALUES (${newId('msg')}, ${m.runId}, ${m.taskId}, ${m.role}, ${m.author}, ${m.kind}, ${m.body}, ${m.by}, ${m.sessionId})
    RETURNING *`;
  return toMessage(rows[0]);
}

/** The whole conversation on a run, oldest first. */
export async function listMessages(sql: Sql, runId: string): Promise<RunMessageWire[]> {
  return (await sql`SELECT * FROM run_message WHERE run_id = ${runId} ORDER BY created_at, id`).map(toMessage);
}

/**
 * A person replied to the planner. Valid while the planner is waiting on them —
 * parked with a question (needs_human) or at the open after_plan gate. Records
 * the message, closes whichever of the two was waiting, and re-queues the planner
 * (attempt+1, queued_by 'chat') so a worker runs its next turn.
 */
export async function sendChatMessage(sql: Sql, runId: string, body: string, by: string | null): Promise<RunMessageWire> {
  const text = body.trim();
  if (!text) throw new ChatError('message is empty');
  const cur = await getRun(sql, runId);
  if (!cur) throw new ChatError(`no run ${runId}`);
  const parked = cur.tasks.find((t) => t.state === 'needs_human' && String(t.role) === CHAT_ROLE);
  const [gate] = await sql`SELECT id, after_task FROM run_gate WHERE run_id = ${runId} AND gate_name = 'after_plan' AND state = 'open'
    ORDER BY created_at DESC LIMIT 1`;
  const targetTaskId = parked?.id ?? (gate?.afterTask ? String(gate.afterTask) : null);
  if (!targetTaskId) throw new ChatError('the planner is not waiting for a reply right now');

  const msg = await sql.begin(async (tx) => {
    const m = await appendMessage(tx, { runId, taskId: targetTaskId, role: CHAT_ROLE, author: 'human', kind: 'message', body: text, by, sessionId: null });
    if (gate) {
      // Replying at the plan gate is neither approve nor reject: the conversation goes on.
      await tx`UPDATE run_gate SET state = 'rejected', decided_by = ${by}, note = ${text}, decided_at = now() WHERE id = ${gate.id}`;
      await appendEventTx(tx, { runId, taskId: targetTaskId, kind: 'gate:resolved', source: 'human',
        payload: { gate: 'after_plan', gateId: String(gate.id), decision: 'reply', by, note: text.slice(0, 500) } });
    }
    await requeueForChat(tx, runId, targetTaskId, text);
    await tx`UPDATE agent_run SET state = 'running' WHERE id = ${runId} AND state = 'awaiting_checkpoint'`;
    await appendEventTx(tx, { runId, taskId: targetTaskId, kind: 'chat:message', source: 'human',
      payload: { role: CHAT_ROLE, by, text: text.slice(0, 500) } });
    return m;
  });
  await advance(sql, runId);
  return msg;
}

/**
 * A person asked for changes after the MR/PR was opened. The SAME run reopens —
 * same branch, same PR, same planner thread: their feedback becomes a planner chat
 * turn (queued_by 'pr_feedback'), the team re-runs, and the publish phase pushes
 * onto the existing PR. Allowed while the PR is live and nothing is running: the
 * run finished awaiting an external merge (CR open|ready), or it waits at the
 * before_merge gate. Anything else is refused with the reason.
 */
export async function requestChanges(sql: Sql, runId: string, body: string, by: string | null): Promise<RunMessageWire> {
  const text = body.trim();
  if (!text) throw new ChatError('feedback is empty');
  const cur = await getRun(sql, runId);
  if (!cur) throw new ChatError(`no run ${runId}`);
  const { run, tasks } = cur;
  if (!run.changeRequestUrl && run.changeRequestNumber == null) throw new ChatError('this run has no pull request to change');
  if (run.changeRequestState === 'merged') throw new ChatError('the pull request is already merged; dispatch a new run for further changes');
  if (run.changeRequestState === 'closed') throw new ChatError('the pull request was closed; dispatch a new run for further changes');
  const [mergeGate] = await sql`SELECT id FROM run_gate WHERE run_id = ${runId} AND gate_name = 'before_merge' AND state = 'open'
    ORDER BY created_at DESC LIMIT 1`;
  const awaitingMerge = run.state === 'succeeded' && run.deliveryOutcome === 'awaiting_external_merge';
  if (!awaitingMerge && !mergeGate) {
    throw new ChatError(`the run is ${run.state}; changes can be requested once it is ready for review or waiting at the merge gate`);
  }
  const planner = [...tasks].reverse().find((t) => String(t.role) === CHAT_ROLE && t.state === 'done');
  if (!planner) throw new ChatError('this run has no planner to take the feedback');
  // Reopening makes the run live again; the one-live-run-per-ticket index would refuse it.
  const [live] = await sql`SELECT id FROM agent_run WHERE ticket_provider = ${run.ticketProvider} AND ticket_id = ${run.ticketId}
    AND id <> ${runId} AND state NOT IN ('succeeded','failed','cancelled','halted') LIMIT 1`;
  if (live) throw new ChatError(`another run for ${run.ticketKey} is live (${String(live.id)}); finish or cancel it first`);

  const msg = await sql.begin(async (tx) => {
    const m = await appendMessage(tx, { runId, taskId: planner.id, role: CHAT_ROLE, author: 'human', kind: 'message', body: text, by, sessionId: null });
    if (mergeGate) {
      await tx`UPDATE run_gate SET state = 'rejected', decided_by = ${by}, note = ${text}, decided_at = now() WHERE id = ${mergeGate.id}`;
      await appendEventTx(tx, { runId, taskId: null, kind: 'gate:resolved', source: 'human',
        payload: { gate: 'before_merge', decision: 'request_changes', by, note: text.slice(0, 500) } });
    }
    // The publish phase runs again after the revision (and pushes onto the same PR).
    await tx`UPDATE run_task SET state = 'skipped', reason = 'superseded by change request feedback'
      WHERE run_id = ${runId} AND runtime = 'publish' AND state IN ('pending','done')`;
    await requeueForChat(tx, runId, planner.id, text, 'pr_feedback');
    await tx`UPDATE agent_run SET state = 'running', reason = NULL, finished_at = NULL, delivery_outcome = NULL, review_iterations = 0
      WHERE id = ${runId}`;
    await appendEventTx(tx, { runId, taskId: planner.id, kind: 'change_request:feedback', source: 'human',
      payload: { by, text: text.slice(0, 500), url: run.changeRequestUrl, number: run.changeRequestNumber } });
    return m;
  });
  await advance(sql, runId);
  return msg;
}

/**
 * Same shape as the gate-reject / needs-human re-queue: skip the planner task and
 * every still-pending/done downstream role, then re-append them at fresh seqs so
 * the claim query offers the planner next. The reason is `chat: …` (NOT `revise:`)
 * so the worker renders the conversation, not a "your work was rejected" banner.
 */
async function requeueForChat(tx: Db, runId: string, taskId: string, text: string, queuedBy = 'chat'): Promise<void> {
  const [target] = await tx`SELECT seq FROM run_task WHERE id = ${taskId}`;
  const downstream = await tx`SELECT * FROM run_task WHERE run_id = ${runId} AND runtime <> 'publish'
    AND seq >= ${Number(target.seq)} AND state IN ('pending','done','needs_human') ORDER BY seq`;
  const [{ next }] = await tx`SELECT coalesce(max(seq),0)+1 AS next FROM run_task WHERE run_id = ${runId}`;
  let seq = Number(next);
  for (const t of downstream) {
    await tx`UPDATE run_task SET state = 'skipped', reason = 'superseded by chat reply' WHERE id = ${t.id}`;
    const isTarget = String(t.id) === taskId;
    await tx`INSERT INTO run_task (id, run_id, role, seq, state, attempt, input_ref, output_ref, runtime, model, effort, reason, queued_by, queued_reason)
      VALUES (${newId('task')}, ${runId}, ${t.role}, ${seq}, 'pending', ${Number(t.attempt) + 1}, ${t.inputRef}, ${t.outputRef}, ${t.runtime}, ${t.model}, ${t.effort},
              ${isTarget ? `chat: ${text.slice(0, 200)}` : null}, ${queuedBy}, ${isTarget ? text.slice(0, 300) : null})`;
    seq++;
  }
}
