import type { Db, Sql } from '../db/pool.js';
import { newId } from './ids.js';

/** Gate rows and run artifacts. Reads for the UI, writes from the orchestrator and the api. */

export interface GateRow {
  id: string; runId: string; gateName: string; mode: string; state: string;
  afterTask: string | null; artifact: string | null; decidedBy: string | null;
  note: string | null; editedArtifact: string | null; createdAt: string; decidedAt: string | null;
  hiveSentAt: string | null;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
function toGate(r: Record<string, unknown>): GateRow {
  return { id: String(r.id), runId: String(r.runId), gateName: String(r.gateName), mode: String(r.mode), state: String(r.state),
    afterTask: r.afterTask ? String(r.afterTask) : null, artifact: r.artifact ? String(r.artifact) : null,
    decidedBy: r.decidedBy ? String(r.decidedBy) : null, note: r.note ? String(r.note) : null,
    editedArtifact: r.editedArtifact ? String(r.editedArtifact) : null, createdAt: iso(r.createdAt)!, decidedAt: iso(r.decidedAt),
    hiveSentAt: iso(r.hiveSentAt) };
}

export async function openGate(tx: Db, input: { runId: string; gateName: string; mode: string; afterTask: string | null; artifact: string | null }): Promise<GateRow> {
  const id = newId('gate');
  const state = input.mode === 'required' ? 'open' : input.mode === 'notify' ? 'auto' : 'auto';
  const rows = await tx`INSERT INTO run_gate (id, run_id, gate_name, mode, state, after_task, artifact, decided_at)
    VALUES (${id}, ${input.runId}, ${input.gateName}, ${input.mode}, ${state}, ${input.afterTask}, ${input.artifact},
            ${state === 'auto' ? tx`now()` : null}) RETURNING *`;
  return toGate(rows[0]);
}

export async function getOpenGate(sql: Sql, runId: string): Promise<GateRow | null> {
  const rows = await sql`SELECT * FROM run_gate WHERE run_id = ${runId} AND state = 'open' ORDER BY created_at DESC LIMIT 1`;
  return rows.length ? toGate(rows[0]) : null;
}

export async function getGate(sql: Sql, id: string): Promise<GateRow | null> {
  const rows = await sql`SELECT * FROM run_gate WHERE id = ${id}`;
  return rows.length ? toGate(rows[0]) : null;
}

export async function listGates(sql: Sql, runId: string): Promise<GateRow[]> {
  return (await sql`SELECT * FROM run_gate WHERE run_id = ${runId} ORDER BY created_at`).map(toGate);
}

export async function decideGate(tx: Db, id: string, d: { state: 'approved' | 'rejected'; decidedBy: string | null; note: string | null; editedArtifact: string | null }): Promise<void> {
  await tx`UPDATE run_gate SET state = ${d.state}, decided_by = ${d.decidedBy}, note = ${d.note},
    edited_artifact = ${d.editedArtifact}, decided_at = now() WHERE id = ${id}`;
}

export async function saveArtifact(sql: Db, runId: string, name: string, content: string, opts: { taskId?: string | null; source?: string } = {}): Promise<void> {
  const taskId = opts.taskId ?? null;
  const source = opts.source ?? 'agent';
  // A version per producing task: upsert on (run, name, task) so a task that
  // re-writes its own artifact replaces its row, but a DIFFERENT task (the next
  // review-loop iteration) adds a new version. A NULL task_id collapses to one
  // "no task" slot per name (legacy rows + human gate edits without a task link).
  // attempt is copied from the task so the UI can label "reviewer #3".
  await sql`INSERT INTO run_artifact (id, run_id, name, content, task_id, attempt, source, created_at, updated_at)
    VALUES (${newId('artf')}, ${runId}, ${name}, ${content}, ${taskId},
            ${taskId ? sql`(SELECT attempt FROM run_task WHERE id = ${taskId})` : null}, ${source}, now(), now())
    ON CONFLICT (run_id, name, coalesce(task_id, '')) DO UPDATE
      SET content = EXCLUDED.content, attempt = EXCLUDED.attempt, source = EXCLUDED.source, updated_at = now()`;
}

/** The current version of an artifact (newest per name) — what the gate check, publish and prior-artifact loading want. */
export async function getArtifact(sql: Sql, runId: string, name: string): Promise<string | null> {
  const rows = await sql`SELECT content FROM latest_run_artifact WHERE run_id = ${runId} AND name = ${name}`;
  return rows.length ? String(rows[0].content) : null;
}

/** The current version of every artifact (newest per name), for the UI list and prior-artifact loading. */
export async function listArtifacts(sql: Sql, runId: string): Promise<Array<{ name: string; content: string; updatedAt: string }>> {
  return (await sql`SELECT name, content, updated_at FROM latest_run_artifact WHERE run_id = ${runId} ORDER BY name`)
    .map((r) => ({ name: String(r.name), content: String(r.content), updatedAt: iso(r.updatedAt)! }));
}

/** EVERY version of every artifact, newest first — the versioned view for the RunView (M11 WP1). */
export async function listArtifactVersions(sql: Sql, runId: string): Promise<Array<{ name: string; content: string; taskId: string | null; attempt: number | null; source: string; createdAt: string }>> {
  return (await sql`SELECT name, content, task_id, attempt, source, created_at FROM run_artifact WHERE run_id = ${runId} ORDER BY created_at DESC, name`)
    .map((r) => ({ name: String(r.name), content: String(r.content), taskId: r.taskId ? String(r.taskId) : null,
      attempt: r.attempt == null ? null : Number(r.attempt), source: String(r.source), createdAt: iso(r.createdAt)! }));
}
