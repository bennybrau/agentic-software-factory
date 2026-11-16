import { isTerminal } from '@asf/shared';
import type { RunWithTasks } from '@asf/shared';
import type { Sql } from '../db/pool.js';
import { appendEventTx, getRun, rowToRun, rowToTask, repoConnectionOf, NotFoundError } from './store.js';
import { advance } from './orchestrate.js';
import { newId } from './ids.js';
import { recordRepoChoice, epicOfRun } from './repo-choice.js';

export class MoveError extends Error {}

/**
 * Move a run to another repo (M10 WP5): the planner (or a person) found the run
 * is working in the wrong repository. Only a run that is waiting (queued, or
 * parked at a gate or needs-human checkpoint) with nothing running and no PR
 * open can move. The old work is discarded: open gates are abandoned, every task
 * is skipped, the worktree and branch are cleared, and the team starts again from
 * the planner in the new repo. The choice is recorded as a correction.
 * Cost and review_iterations stay with the run.
 */
export async function moveRunToRepo(sql: Sql, runId: string,
  m: { repoId: string; repoConnection: string | null; by: string | null; note: string | null }): Promise<RunWithTasks> {
  await sql.begin(async (tx) => {
    const rows = await tx`SELECT * FROM agent_run WHERE id = ${runId} FOR UPDATE`;
    if (!rows.length) throw new NotFoundError('run', runId);
    const run = rowToRun(rows[0]);
    const tasks = (await tx`SELECT * FROM run_task WHERE run_id = ${runId} ORDER BY seq, attempt`).map(rowToTask);

    if (isTerminal(run.state)) throw new MoveError(`run ${runId} is ${run.state}, a finished run cannot move`);
    if (tasks.some((t) => t.state === 'running')) throw new MoveError(`run ${runId} has a task running, wait for it to finish`);
    if (run.changeRequestNumber != null) throw new MoveError(`run ${runId} already opened change request #${run.changeRequestNumber}`);
    if (run.team.reviewTarget) throw new MoveError(`run ${runId} reviews an existing change request, it cannot move`);
    if (run.state !== 'queued' && run.state !== 'awaiting_checkpoint') throw new MoveError(`run ${runId} is ${run.state}, only a queued or waiting run can move`);
    if (run.repoId === m.repoId) throw new MoveError(`run ${runId} is already in ${m.repoId}`);

    const repoConnection = m.repoConnection ?? repoConnectionOf(m.repoId);
    await tx`UPDATE run_gate SET state = 'abandoned', decided_at = now(), decided_by = ${m.by} WHERE run_id = ${runId} AND state = 'open'`;
    await tx`UPDATE run_task SET state = 'skipped', reason = 'superseded by move' WHERE run_id = ${runId} AND state <> 'skipped'`;
    // Fresh copies of the team after the current max seq, so the claim query offers the planner first.
    const [{ next }] = await tx`SELECT coalesce(max(seq),0)+1 AS next FROM run_task WHERE run_id = ${runId}`;
    for (const [i, role] of run.team.roles.entries()) {
      await tx`INSERT INTO run_task (id, run_id, role, seq, state, input_ref, output_ref, runtime, model, effort, queued_by, queued_reason)
        VALUES (${newId('task')}, ${runId}, ${role.role}, ${Number(next) + i}, 'pending', ${role.input}, ${role.output}, ${role.runtime}, ${role.model}, ${role.effort}, 'move', ${m.note})`;
    }
    await tx`UPDATE agent_run SET repo_id = ${m.repoId}, repo_connection = ${repoConnection}, worktree_path = NULL, branch_name = NULL,
      state = 'running', reason = NULL, finished_at = NULL WHERE id = ${runId}`;
    await appendEventTx(tx, { runId, taskId: null, kind: 'run:moved', source: 'human', payload: { from: run.repoId, to: m.repoId, by: m.by, note: m.note } });
    await recordRepoChoice(tx, { ticketProvider: run.ticketProvider, ticketId: run.ticketId, ticketKey: run.ticketKey,
      epicId: await epicOfRun(tx, runId), repoId: m.repoId, repoConnection, runId, kind: 'correction', fromRepoId: run.repoId, by: m.by });
  });
  await advance(sql, runId);
  return (await getRun(sql, runId))!;
}
