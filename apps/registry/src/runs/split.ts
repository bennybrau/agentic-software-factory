import { randomBytes } from 'node:crypto';
import { ADHOC_ID_PREFIX, parseSplit, subtaskBody, stripPartSuffix } from '@asf/shared';
import type { SplitSubtask, SplitFamilyWire, SplitPartWire } from '@asf/shared';
import type { Db } from '../db/pool.js';
import { appendEventTx, setRunState } from './store.js';
import { recordNotification } from './notification-store.js';
import { newId } from './ids.js';

/**
 * Carry out an approved planner split, inside the gate-resolution transaction:
 * create each part as an ad-hoc task (linked to this run), queue them as one
 * batch with their merge dependencies, skip the parent's remaining roles, and
 * finish the parent run as delivery_outcome 'split'. Deterministic: the LLM only
 * proposed the parts; this code decides what happens to them.
 *
 * Returns null when the plan has no split block (an ordinary approve), the
 * created keys when it split, and throws SplitError (-> 409 with the reason)
 * when the block can't be acted on, so approval never guesses.
 */
export class SplitError extends Error { override name = 'GateError'; }

export async function applySplit(tx: Db, runId: string, planMd: string | null, by: string | null): Promise<string[] | null> {
  const parsed = parseSplit(planMd);
  if (parsed.kind === 'none') return null;
  if (parsed.kind === 'invalid') throw new SplitError(`can't split this plan: ${parsed.reason}. Ask the planner to fix it, or edit the plan.`);

  const [run] = await tx`SELECT id, ticket_id, ticket_key, repo_id, change_request_url FROM agent_run WHERE id = ${runId}`;
  if (!run) throw new SplitError(`no run ${runId}`);
  if (run.changeRequestUrl) {
    throw new SplitError(`${run.ticketKey} already has a pull request, so it can't be split now. Remove the asf-split block from the plan to keep working on that pull request.`);
  }
  const [parentTask] = await tx`SELECT title, parent_run_id FROM adhoc_task WHERE id = ${String(run.ticketId)}`;
  if (parentTask?.parentRunId) {
    throw new SplitError(`${run.ticketKey} is already a part of a split; split it no further. Remove the asf-split block from the plan, or ask the planner to fit it in one pull request.`);
  }
  const parent = { key: String(run.ticketKey), title: parentTask?.title ? String(parentTask.title) : String(run.ticketKey) };

  const created = await createParts(tx, runId, parent, parsed.subtasks, by);
  await queueParts(tx, created, run.repoId == null ? null : String(run.repoId), by);

  // The parent does no building of its own: skip what is left of its team.
  await tx`UPDATE run_task SET state = 'skipped', reason = 'split into sub-tasks'
    WHERE run_id = ${runId} AND state IN ('pending', 'awaiting_gate')`;
  await tx`UPDATE agent_run SET delivery_outcome = 'split' WHERE id = ${runId}`;
  await setRunState(tx, runId, 'succeeded');
  const keys = created.map((c) => c.key);
  await appendEventTx(tx, { runId, taskId: null, kind: 'run:split', source: 'orchestrator',
    payload: { by, parts: created.map((c) => ({ key: c.key, ticketId: c.id, title: c.title, dependsOn: c.dependsOnKeys })) } });
  await appendEventTx(tx, { runId, taskId: null, kind: 'run:succeeded', source: 'orchestrator', payload: { deliveryOutcome: 'split' } });
  await recordNotification(tx, { runId, kind: 'finished', title: `${parent.key}: split into ${keys.length} tasks`,
    body: `Queued ${keys.join(', ')}. Each starts once the parts it depends on are merged.`,
    actions: [{ label: 'Open run', url: `/run/${runId}` }] });
  return keys;
}

/**
 * The split a run belongs to, for the run page: called with the PARENT run (the one
 * that was split) or with a run of one of its PARTS. Null when the run is neither.
 * Read-only; each part's state comes from its latest run, its Up next entry, and
 * whether the parts it depends on have merged (the same rule the queue uses).
 */
export async function getSplitFamily(sql: Db, runId: string): Promise<SplitFamilyWire | null> {
  const [run] = await sql`SELECT id, ticket_id, ticket_key FROM agent_run WHERE id = ${runId}`;
  if (!run) return null;
  let parentRunId = runId;
  let currentPart: number | null = null;
  const [mine] = await sql`SELECT parent_run_id, part FROM adhoc_task WHERE id = ${String(run.ticketId)}`;
  if (mine?.parentRunId) { parentRunId = String(mine.parentRunId); currentPart = mine.part == null ? null : Number(mine.part); }

  const tasks = await sql`SELECT id, key, title, part FROM adhoc_task WHERE parent_run_id = ${parentRunId} ORDER BY part`;
  if (tasks.length === 0) return null;
  const ids = tasks.map((t) => String(t.id));
  const keyOf = new Map(tasks.map((t) => [String(t.id), String(t.key)]));

  const [parentRun] = await sql`SELECT r.ticket_key, a.title FROM agent_run r LEFT JOIN adhoc_task a ON a.id = r.ticket_id WHERE r.id = ${parentRunId}`;
  const runs = await sql`SELECT DISTINCT ON (ticket_id) id, ticket_id, state, delivery_outcome, change_request_url, change_request_state, cost_usd
    FROM agent_run WHERE ticket_id IN ${sql(ids)} ORDER BY ticket_id, created_at DESC`;
  const merged = await sql`SELECT DISTINCT ticket_id FROM agent_run
    WHERE ticket_id IN ${sql(ids)} AND (delivery_outcome = 'merged' OR change_request_state = 'merged')`;
  const mergedSet = new Set(merged.map((m) => String(m.ticketId)));
  const queue = await sql`SELECT DISTINCT ON (ticket_id) ticket_id, state, depends_on FROM work_queue
    WHERE ticket_id IN ${sql(ids)} ORDER BY ticket_id, added_at DESC`;
  const runOf = new Map(runs.map((x) => [String(x.ticketId), x]));
  const queueOf = new Map(queue.map((q) => [String(q.ticketId), q]));

  const parts: SplitPartWire[] = tasks.map((t) => {
    const id = String(t.id);
    const q = queueOf.get(id);
    const depIds = Array.isArray(q?.dependsOn) ? (q!.dependsOn as unknown[]).map(String) : [];
    const r = runOf.get(id);
    return {
      part: Number(t.part), key: String(t.key), ticketId: id, title: stripPartSuffix(String(t.title)),
      dependsOn: depIds.map((d) => keyOf.get(d) ?? d),
      waitingOn: depIds.filter((d) => !mergedSet.has(d)).map((d) => keyOf.get(d) ?? d),
      queueState: (q?.state as SplitPartWire['queueState']) ?? null,
      merged: mergedSet.has(id),
      run: r ? { id: String(r.id), state: String(r.state), deliveryOutcome: r.deliveryOutcome == null ? null : String(r.deliveryOutcome),
        changeRequestUrl: r.changeRequestUrl == null ? null : String(r.changeRequestUrl),
        changeRequestState: r.changeRequestState == null ? null : String(r.changeRequestState), costUsd: Number(r.costUsd ?? 0) } : null,
    };
  });
  return {
    parent: { runId: parentRunId, ticketKey: String(parentRun?.ticketKey ?? ''), title: parentRun?.title ? String(parentRun.title) : String(parentRun?.ticketKey ?? '') },
    currentPart, parts,
  };
}

/** `repo` set = the part goes into that repository instead of the parent's. */
interface Part { id: string; key: string; title: string; dependsOnIds: string[]; dependsOnKeys: string[]; repo?: string }

async function createParts(tx: Db, runId: string, parent: { key: string; title: string }, subtasks: SplitSubtask[], by: string | null): Promise<Part[]> {
  // Ids first, so each body can name the keys it waits on.
  const ids = subtasks.map((): { id: string; key: string } => {
    const hex = randomBytes(8).toString('hex');
    return { id: `${ADHOC_ID_PREFIX}${hex}`, key: `ADHOC-${hex.slice(0, 8).toUpperCase()}` };
  });
  const parts: Part[] = [];
  for (const [i, s] of subtasks.entries()) {
    const deps = s.dependsOn.map((d) => ids[d - 1]);
    const title = `${s.title} (${parent.key} part ${i + 1}/${subtasks.length})`.slice(0, 300);
    const body = subtaskBody(s, i + 1, subtasks.length, parent, deps.map((d) => d.key));
    await tx`INSERT INTO adhoc_task (id, key, title, body, created_by, parent_run_id, part)
      VALUES (${ids[i].id}, ${ids[i].key}, ${title}, ${body}, ${by ?? 'planner'}, ${runId}, ${i + 1})`;
    parts.push({ ...ids[i], title, dependsOnIds: deps.map((d) => d.id), dependsOnKeys: deps.map((d) => d.key), repo: s.repo });
  }
  return parts;
}

/**
 * One batch, parallel mode: independents start together, depends_on holds the rest until merged.
 * A part naming another repository is queued for it; the queue refuses one it can't reach at dispatch.
 */
async function queueParts(tx: Db, parts: Part[], parentRepoId: string | null, by: string | null): Promise<void> {
  const batchId = newId('batch');
  const [{ tail }] = await tx`SELECT coalesce(max(position), 0) AS tail FROM work_queue WHERE state = 'queued'`;
  let pos = Number(tail);
  for (const p of parts) {
    pos += 1;
    await tx`INSERT INTO work_queue (ticket_id, ticket_provider, ticket_key, repo_id, team_name, max_cost_usd, mode, position, batch_id, added_by, depends_on)
      VALUES (${p.id}, 'adhoc', ${p.key}, ${p.repo ?? parentRepoId}, ${null}, ${null}, 'parallel', ${pos}, ${batchId}, ${by ?? 'planner'}, ${tx.json(p.dependsOnIds)})`;
  }
}
