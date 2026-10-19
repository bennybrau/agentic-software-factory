import { isTerminal, reviewVerdict, reviewsRepeat, gateAfterRole, gateMode, runReportSummary, parseSplit } from '@asf/shared';
import type { GateConfig, RunTask, Run } from '@asf/shared';
import type { Sql, Db } from '../db/pool.js';
import { appendEventTx, getRun, setRunState, rowToEvent } from './store.js';
import { openGate, getArtifact, listArtifactVersions } from './gates-store.js';
import { recordNotification } from './notification-store.js';
import { newId } from './ids.js';
import { maybeLoopBackForConflict } from './conflict.js';
import { config } from '../config.js';
import { TIME_LIMIT_PREFIX, settleTimeLimited } from './time-limit.js';

/**
 * The orchestrator. Deterministic, idempotent, plain TypeScript: called after
 * every task finish and every gate resolution, it looks at the whole run and
 * decides the single next thing that happens. An LLM never decides what a state
 * becomes — this file does, from facts already in the database.
 *
 * The shape of a run's life:
 *   role tasks in seq order, each optionally followed by a gate
 *     -> reviewer done: maybe loop back to implementer (bounded)
 *     -> all roles done: the publish phase (before_change_request gate, push +
 *        open PR, before_merge gate, merge) — the publish tasks are ordinary
 *        run_task rows with runtime 'publish', claimed by the worker.
 */
export async function advance(sql: Sql, runId: string): Promise<void> {
  const cur = await getRun(sql, runId);
  if (!cur) return;
  const { run, tasks } = cur;
  if (isTerminal(run.state)) return;

  await sql.begin(async (tx) => {
    // Cancellation wins as soon as nothing is running.
    const running = tasks.some((t) => t.state === 'running');
    if (run.cancelRequestedAt && !running) {
      // A run stopped by RUN_MAX_MINUTES keeps that reason (M11 WP6), not "by operator".
      return run.reason?.startsWith(TIME_LIMIT_PREFIX) ? settleTimeLimited(tx, runId, run.reason) : settleCancelled(tx, runId);
    }

    // A hard failure or an over-budget run stops everything (once nothing is running).
    const failed = tasks.find((t) => t.state === 'failed');
    // A push that failed on a merge conflict goes back to the implementer (bounded)
    // instead of failing the run; past the bound it fails like any other step.
    if (failed && run.state !== 'stale' && !running && await maybeLoopBackForConflict(tx, runId, tasks, failed)) return;
    if (failed && run.state !== 'stale') return fail(tx, run, tasks, failed);
    if (run.costUsd >= run.maxCostUsd && !running) return halt(tx, runId, run.costUsd, run.maxCostUsd, run.ticketKey);

    // A role parked at a needs_human checkpoint.
    const needsHuman = tasks.find((t) => t.state === 'needs_human');
    if (needsHuman) return checkpoint(tx, runId, needsHuman, run.ticketKey);

    // If a gate is open, we are waiting on a person; do nothing until it resolves.
    const openGates = await tx`SELECT id FROM run_gate WHERE run_id = ${runId} AND state = 'open' LIMIT 1`;
    if (openGates.length) return;

    // The most recent role task that finished and has not had its gate evaluated.
    const roleTasks = tasks.filter((t) => t.runtime !== 'publish');
    const lastDone = [...roleTasks].reverse().find((t) => t.state === 'done' && !t.gateChecked);
    if (lastDone) {
      // A reviewer that requested changes loops back to the implementer, bounded.
      if (String(lastDone.role) === 'reviewer') {
        const versions = await listArtifactVersions(sql as unknown as Sql, runId);
        const reviews = versions.filter((v) => v.name === 'review.md'); // newest first
        const reviewMd = reviews[0]?.content ?? await getArtifact(sql as unknown as Sql, runId, 'review.md');
        const prevReview = reviews[1]?.content ?? null;
        const verdict = reviewVerdict(reviewMd);
        const loop = run.team.loop;

        // ESCALATE, or a repeat of the previous review's blockers (the implementer's
        // changes didn't resolve them): the two roles are arguing in circles. Park
        // for a human NOW instead of spending the rest of the loop budget (M11 WP4).
        const repeats = config.loopRepeatDetect && verdict === 'request_changes' && reviewsRepeat(prevReview, reviewMd);
        if (loop && (verdict === 'escalate' || repeats)) {
          await tx`UPDATE run_task SET state = 'needs_human', reason = ${verdict === 'escalate'
            ? 'reviewer escalated: a human should decide'
            : 'reviewer repeated the same blocker; the implementer did not resolve it'} WHERE id = ${lastDone.id}`;
          await appendEventTx(tx, { runId, taskId: lastDone.id, kind: 'loop:disputed', source: 'orchestrator',
            payload: { reason: verdict === 'escalate' ? 'escalate' : 'repeat', verdictLine: firstBlockingLine(reviewMd) } });
          return checkpoint(tx, runId, { ...lastDone, state: 'needs_human',
            reason: verdict === 'escalate' ? 'Reviewer escalated — a human should decide.' : 'Reviewer repeated the same blocker; the implementer did not resolve it. A human should decide.' }, run.ticketKey);
        }

        if (verdict === 'request_changes' && loop) {
          // review_iterations is the single, transactional count of review cycles;
          // loopBack maintains it, and the gate_reject / needs_human re-queue paths
          // bump it too when they re-run the loop target (so a rejection is not a
          // free extra cycle — the bug behind run_d0cd6bf6…). Read it fresh inside
          // the tx to stay idempotent if advance() re-enters on the same state.
          const [{ ri }] = await tx`SELECT review_iterations AS ri FROM agent_run WHERE id = ${runId}`;
          if (Number(ri) < loop.maxIterations) {
            return loopBack(tx, runId, roleTasks, String(loop.onReviewFail), Number(ri) + 1, firstBlockingLine(reviewMd));
          }
          // Bound reached and the reviewer still wants changes: do NOT loop again.
          // Fall through to the after_role gate so a human decides (ship it, or
          // keep iterating by hand). Say so, so it isn't a silent give-up.
          await appendEventTx(tx, { runId, taskId: lastDone.id, kind: 'loop:exhausted', source: 'orchestrator',
            payload: { role: String(loop.onReviewFail), iterations: Number(ri), max: loop.maxIterations, verdictLine: firstBlockingLine(reviewMd) } });
        }
      }
      // Otherwise, evaluate the gate that follows this role.
      const gateName = gateAfterRole(String(lastDone.role));
      await tx`UPDATE run_task SET gate_checked = true WHERE id = ${lastDone.id}`;
      const cfg = run.gates[gateName] as GateConfig | undefined;
      // Once a PR exists the planner is re-planning on a person's feedback: always stop
      // at the plan so they can talk it through before the team pushes onto that PR.
      const hasChangeRequest = Boolean(run.changeRequestUrl) || run.changeRequestNumber != null;
      const artifact = lastDone.outputRef ? await getArtifact(sql as unknown as Sql, runId, lastDone.outputRef) : null;
      // A plan that proposes splitting the ticket always stops for a person, whatever the
      // plan stage's gate mode: creating and queueing new tasks is a human decision.
      const proposesSplit = gateName === 'after_plan' && parseSplit(artifact).kind !== 'none';
      const mode = gateName === 'after_plan' && (hasChangeRequest || proposesSplit) ? 'required' : (cfg?.mode ?? 'auto');
      if (mode !== 'auto') {
        const gate = await openGate(tx, { runId, gateName, mode, afterTask: lastDone.id, artifact });
        await appendEventTx(tx, { runId, taskId: lastDone.id, kind: 'gate:reached', source: 'orchestrator', payload: { gate: gateName, mode, gateId: gate.id } });
        if (mode === 'required') {
          await notifyGate(tx, runId, gate.id, gateName, run.ticketKey);
          await setRunState(tx, runId, 'awaiting_checkpoint', `waiting at ${gateName}`);
          return;
        }
        // notify: record it, but keep going.
      }
    }

    // Any pending role task? A worker will claim it; nothing to do here.
    if (roleTasks.some((t) => t.state === 'pending')) return;
    if (roleTasks.some((t) => t.state === 'running')) return;

    // All roles are done/skipped -> the publish phase. A review-only run publishes
    // nothing: the review is the delivery, whatever its verdict.
    if (roleTasks.every((t) => t.state === 'done' || t.state === 'skipped')) {
      if (run.team.reviewTarget) return succeed(tx, runId, run.ticketKey, 'reviewed', run.team.reviewTarget.url);
      return advancePublish(tx, runId, tasks, run.gates, run.repoId, run.ticketKey, run.team.mergeEnabled);
    }
  });
}

/** A deep link into the web UI for a run (the api/Telegram sink prepends the public base URL). */
const runLink = (runId: string) => `/run/${runId}`;

/**
 * The reviewer's headline: its verdict line and/or first "must fix"/"blocking"
 * bullet, trimmed for a timeline label and (M11 WP4) for comparing one review to
 * the next. Best-effort text extraction — never throws, empty string when absent.
 */
export function firstBlockingLine(reviewMd: string | null): string | null {
  if (!reviewMd) return null;
  const lines = reviewMd.split('\n').map((l) => l.trim()).filter(Boolean);
  const verdict = lines.find((l) => /REQUEST_CHANGES|APPROVE|ESCALATE/i.test(l));
  const blocker = lines.find((l) => /(must[- ]?fix|blocking|blocker)/i.test(l))
    ?? lines.find((l) => /^[-*]\s/.test(l)); // else the first bullet
  const pick = [verdict, blocker].filter(Boolean).join(' — ');
  return pick ? pick.slice(0, 300) : null;
}

/** Record a "needs a human" notification for an open required gate. */
async function notifyGate(tx: Db, runId: string, gateId: string, gateName: string, ticketKey: string): Promise<void> {
  await recordNotification(tx, {
    runId, gateId, kind: 'gate',
    title: `${ticketKey}: approval needed at ${gateName.replace(/_/g, ' ')}`,
    body: `Run ${runId} is waiting for you to approve or reject the ${gateName.replace(/_/g, ' ')} gate.`,
    actions: [{ label: 'Review', url: runLink(runId) }],
  });
}

async function settleCancelled(tx: Db, runId: string): Promise<void> {
  await tx`UPDATE run_task SET state = 'skipped', reason = 'cancelled' WHERE run_id = ${runId} AND state IN ('pending','awaiting_gate','needs_human')`;
  await tx`UPDATE run_gate SET state = 'abandoned' WHERE run_id = ${runId} AND state = 'open'`;
  await setRunState(tx, runId, 'cancelled', 'cancelled by operator');
  await appendEventTx(tx, { runId, taskId: null, kind: 'run:cancelled', source: 'orchestrator', payload: { immediate: true } });
}
async function fail(tx: Db, run: Run, tasks: RunTask[], failed: RunTask): Promise<void> {
  const runId = run.id;
  await setRunState(tx, runId, 'failed', failed.reason ?? `${failed.role} failed`);
  await appendEventTx(tx, { runId, taskId: failed.id, kind: 'run:failed', source: 'orchestrator', payload: { role: failed.role, reason: failed.reason } });
  // A one-paragraph summary in the notification body (M11 WP6) — 'cancelled after 3
  // review cycles on the same blocker: …' beats a bare 'run failed'. Built from the
  // run's own events so the loop/dispute context is included.
  const events = (await tx`SELECT id, run_id, task_id, seq, kind, source, payload, at FROM run_events WHERE run_id = ${runId} ORDER BY seq`).map((r) => rowToEvent(r as Record<string, unknown>));
  const summary = runReportSummary({ run: { ...run, state: 'failed' }, tasks, events, artifacts: [] });
  await recordNotification(tx, { runId, kind: 'failed', title: `${run.ticketKey}: run failed`,
    body: summary, actions: [{ label: 'Open run', url: runLink(runId) }] });
}
async function halt(tx: Db, runId: string, cost: number, max: number, ticketKey: string): Promise<void> {
  await setRunState(tx, runId, 'halted', `cost ceiling reached: $${cost.toFixed(2)} of $${max.toFixed(2)}`);
  await appendEventTx(tx, { runId, taskId: null, kind: 'run:halted', source: 'orchestrator', payload: { costUsd: cost, maxCostUsd: max } });
  await recordNotification(tx, { runId, kind: 'failed', title: `${ticketKey}: run halted on cost`,
    body: `Cost ceiling reached: $${cost.toFixed(2)} of $${max.toFixed(2)}.`, actions: [{ label: 'Open run', url: runLink(runId) }] });
}
async function checkpoint(tx: Db, runId: string, t: RunTask, ticketKey: string): Promise<void> {
  await setRunState(tx, runId, 'awaiting_checkpoint', t.reason ?? `${t.role} needs a person`);
  await appendEventTx(tx, { runId, taskId: t.id, kind: 'needs_human', source: 'orchestrator', payload: { role: t.role, reason: t.reason } });
  await recordNotification(tx, { runId, kind: 'needs_human', title: `${ticketKey}: ${t.role} needs a human answer`,
    body: t.reason ?? `The ${t.role} paused and needs a person to weigh in.`, actions: [{ label: 'Answer', url: runLink(runId) }] });
}

/**
 * Reviewer asked for changes: clone the roles from the loop target onward as new
 * pending tasks (attempt bumped), skip the current copies, bump the counter.
 */
async function loopBack(tx: Db, runId: string, roleTasks: RunTask[], fromRole: string, iteration: number, verdictLine: string | null): Promise<void> {
  const fromSeq = roleTasks.find((t) => String(t.role) === fromRole)?.seq;
  if (fromSeq === undefined) return;
  const toReplay = roleTasks.filter((t) => t.seq >= fromSeq).sort((a, b) => a.seq - b.seq);
  const maxSeq = Math.max(...roleTasks.map((t) => t.seq));
  let seq = maxSeq + 1;
  for (const t of toReplay) {
    await tx`UPDATE run_task SET state = 'skipped', reason = 'superseded by review loop' WHERE id = ${t.id}`;
    // The role at the loop target (usually the implementer) carries the reviewer's
    // verdict line so the re-run actually addresses it. It goes in BOTH columns:
    //   - `reason` as `revise: <line>` — this is what the worker reads
    //     (segment.ts) to render the "## REVISION REQUESTED" banner in the prompt.
    //     Without it the implementer re-runs with an identical prompt and
    //     reproduces the same diff (the wasted-money review loop).
    //   - `queued_reason` — surfaced verbatim in the RunView task tooltip.
    // The downstream copies (tester/reviewer) ride along with no note.
    const isTarget = String(t.role) === fromRole;
    const reason = isTarget && verdictLine ? `revise: ${verdictLine}` : null;
    const queuedReason = isTarget ? verdictLine : null;
    await tx`INSERT INTO run_task (id, run_id, role, seq, state, attempt, input_ref, output_ref, runtime, model, effort, reason, queued_by, queued_reason)
      VALUES (${newId('task')}, ${runId}, ${t.role}, ${seq}, 'pending', ${t.attempt + 1}, ${t.inputRef}, ${t.outputRef}, ${t.runtime}, ${t.model}, ${t.effort}, ${reason}, 'loop_back', ${queuedReason})`;
    seq++;
  }
  await tx`UPDATE agent_run SET review_iterations = ${iteration}, state = 'running' WHERE id = ${runId}`;
  await appendEventTx(tx, { runId, taskId: null, kind: 'review:loop', source: 'orchestrator', payload: { fromRole, iteration, verdictLine } });
}

/**
 * The publish phase. Modeled as ordinary run_task rows with runtime 'publish',
 * so the worker claims and performs them (push, open PR, merge) with the same
 * claim/finish machinery — the registry never touches git or an SCM API.
 *
 *   merge ON  : before_change_request gate -> publish:push_open -> before_merge gate -> publish:merge -> succeeded (merged)
 *   merge OFF : before_change_request gate -> publish:push_open -> publish:mark_ready -> succeeded (awaiting_external_merge)
 *
 * When merge is off ASF opens the MR/PR and marks it ready for review, then the
 * run ends cleanly — a human reviews + merges in the SCM system. The before_merge
 * gate/policy is untouched: it only applies on the merge-on path.
 */
async function advancePublish(tx: Db, runId: string, tasks: RunTask[], gates: Record<string, GateConfig>, repoId: string | null, ticketKey: string, mergeEnabled: boolean): Promise<void> {
  const publishTasks = tasks.filter((t) => t.runtime === 'publish');
  const done = (kind: string) => publishTasks.find((t) => String(t.role) === kind && t.state === 'done');
  const pending = (kind: string) => publishTasks.find((t) => String(t.role) === kind && (t.state === 'pending' || t.state === 'running'));

  // No repo bound: nothing to publish. The run succeeds on its artifacts alone.
  if (!repoId) { await succeed(tx, runId, ticketKey, 'no_repo'); return; }

  // Step 1: before_change_request gate, then the push+open task.
  if (!done('publish:push_open') && !pending('publish:push_open')) {
    if (await maybeGate(tx, runId, gates, 'before_change_request', ticketKey)) return;
    await enqueuePublish(tx, runId, 'publish:push_open', tasks);
    await appendEventTx(tx, { runId, taskId: null, kind: 'publish:queued', source: 'orchestrator', payload: { step: 'push_open' } });
    return;
  }
  if (pending('publish:push_open')) return; // worker is doing it

  // Merge OFF: mark the MR ready for review, then finish as awaiting_external_merge.
  // No before_merge gate, no merge task — a human takes it from here in the SCM.
  if (!mergeEnabled) {
    if (!done('publish:mark_ready') && !pending('publish:mark_ready')) {
      await enqueuePublish(tx, runId, 'publish:mark_ready', tasks);
      await appendEventTx(tx, { runId, taskId: null, kind: 'publish:queued', source: 'orchestrator', payload: { step: 'mark_ready' } });
      return;
    }
    if (pending('publish:mark_ready')) return;
    await succeed(tx, runId, ticketKey, 'awaiting_external_merge');
    return;
  }

  // Step 2 (merge ON): before_merge gate, then the merge task.
  if (!done('publish:merge') && !pending('publish:merge')) {
    if (await maybeGate(tx, runId, gates, 'before_merge', ticketKey)) return;
    await enqueuePublish(tx, runId, 'publish:merge', tasks);
    await appendEventTx(tx, { runId, taskId: null, kind: 'publish:queued', source: 'orchestrator', payload: { step: 'merge' } });
    return;
  }
  if (pending('publish:merge')) return;

  await succeed(tx, runId, ticketKey, 'merged');
}

/** Open a gate if its mode requires/notifies; return true if the run should now wait. */
async function maybeGate(tx: Db, runId: string, gates: Record<string, GateConfig>, name: string, ticketKey: string): Promise<boolean> {
  // Was this gate already answered? An approve/auto means proceed and don't
  // reopen. A REJECT is different: the rejection handler already re-queued the
  // work to revise, so when the publish phase comes back around after that
  // revision this gate must OPEN AGAIN for a fresh decision — never treat a
  // stale rejection as permission to proceed (that shipped a rejected change).
  const prior = await tx`SELECT state FROM run_gate WHERE run_id = ${runId} AND gate_name = ${name} ORDER BY created_at DESC LIMIT 1`;
  if (prior.length && ['approved', 'auto'].includes(String(prior[0].state))) return false;
  const mode = gateMode(gates, name);
  if (mode === 'auto') return false;
  const gate = await openGate(tx, { runId, gateName: name, mode, afterTask: null, artifact: null });
  await appendEventTx(tx, { runId, taskId: null, kind: 'gate:reached', source: 'orchestrator', payload: { gate: name, mode, gateId: gate.id } });
  if (mode === 'required') {
    await notifyGate(tx, runId, gate.id, name, ticketKey);
    await setRunState(tx, runId, 'awaiting_checkpoint', `waiting at ${name}`);
    return true;
  }
  return false; // notify: keep going
}

async function enqueuePublish(tx: Db, runId: string, kind: string, tasks: RunTask[]): Promise<void> {
  const maxSeq = Math.max(0, ...tasks.map((t) => t.seq));
  await tx`INSERT INTO run_task (id, run_id, role, seq, state, runtime) VALUES (${newId('task')}, ${runId}, ${kind}, ${maxSeq + 1}, 'pending', 'publish')`;
  await tx`UPDATE agent_run SET state = 'running' WHERE id = ${runId}`;
}

async function succeed(tx: Db, runId: string, ticketKey: string, outcome: 'merged' | 'awaiting_external_merge' | 'no_repo' | 'reviewed', reviewedUrl?: string): Promise<void> {
  const [{ cost }] = await tx`SELECT coalesce(sum(cost_usd), 0) AS cost FROM run_task WHERE run_id = ${runId}`;
  const [cr] = await tx`SELECT change_request_url AS url FROM agent_run WHERE id = ${runId}`;
  await tx`UPDATE agent_run SET delivery_outcome = ${outcome} WHERE id = ${runId}`;
  await setRunState(tx, runId, 'succeeded');
  await appendEventTx(tx, { runId, taskId: null, kind: 'run:succeeded', source: 'orchestrator', payload: { costUsd: Number(cost), deliveryOutcome: outcome } });
  const costStr = `$${Number(cost).toFixed(2)}`;
  const actions = [{ label: 'Open run', url: runLink(runId) }];
  if (cr?.url) actions.push({ label: 'Open merge request', url: String(cr.url) });
  if (reviewedUrl) actions.push({ label: 'Open pull request', url: reviewedUrl });
  const body = outcome === 'reviewed'
    ? `The review is ready in ASF (${costStr}): ${reviewedUrl ?? 'the pull request'}.`
    : outcome === 'awaiting_external_merge'
    ? `Delivery complete (${costStr}). The merge request is ready for review — a human review and merge is needed to land it.`
    : outcome === 'merged'
      ? `The run completed and the change was merged (${costStr}).`
      : `The run completed successfully (${costStr}).`;
  await recordNotification(tx, { runId, kind: 'finished', title: `${ticketKey}: run finished`, body, actions });
}
