import { mkdir, writeFile, readFile, rename, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import type { AdhocTask, AgentOutcome, AgentSpawn, ClaimResponse, CreateAdhocInput, EventSink, Run, RunContext, RunTask, RuntimeCapabilities, TeamTemplate, ToolPolicy } from '@asf/shared';
import { priceUsage, mergeCatalogue, CONFLICT_QUEUED_BY, isGoogleLoginFailure, googleLoginFix } from '@asf/shared';
import { config } from './config.js';
import { api } from './api.js';
import { ensureWorkspace, commitPending, diffStat, wipAtHead, startConflictMerge, filesWithConflictMarkers, type Workspace } from './git.js';
import { renderPrompt, renderChatTurn, loadPriorArtifacts, readArtifact, attachmentsDir, type ChatTurn } from './prompt.js';
import { loadRuntime } from './runtimes/index.js';
import { authForTask, checkAuthConfig, taskModel } from './auth/index.js';
import { auditWorktree, watchCancel } from './guard.js';
import { skillsForRole, installNativeSkills, writeFallbackSkills, type FallbackSkill } from './skills.js';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../hooks');

export function roleWrites(team: TeamTemplate, role: string): boolean {
  return team.roles.find((r) => r.role === role)?.writes ?? false;
}

/**
 * The composed skill guidance for a role: the org-tier ROLE_SKILL_<ROLE> blob
 * (delivered on the RunContext) followed by any per-dispatch addition persisted
 * on the team role. Both optional; returns undefined when neither is set so the
 * prompt emits no ROLE SKILL section. Org first, per-run addition second.
 */
export function roleSkillFor(team: TeamTemplate, ctx: RunContext, role: string): string | undefined {
  const org = (ctx.roleSkills?.[role] ?? '').trim();
  const perRun = (team.roles.find((r) => r.role === role)?.skill ?? '').trim();
  const composed = [org, perRun].filter(Boolean).join('\n\n');
  return composed || undefined;
}

/**
 * The turn ceiling for a role: the api-resolved MAX_TURNS_<ROLE> when set, else the
 * WORKER_MAX_TURNS default from the api, else the local env > default fallback.
 */
export function maxTurnsFor(ctx: RunContext, role: string, fallback: number): number {
  return ctx.workerSettings?.maxTurnsByRole?.[role] ?? ctx.workerSettings?.maxTurns ?? fallback;
}

/**
 * The neutral tool policy for a role (M8 WP B). Every role may write its own
 * artifact (plan.md, review.md, ...) under the run dir; only writing roles may
 * also edit source under the worktree. Every role may run shell commands (the
 * tester/reviewer run the suite) and reach the web; none may push — the worker
 * pushes. Each runtime adapter translates this into its own tool flags.
 */
export function policyFor(writes: boolean): ToolPolicy {
  return { fileWrite: writes ? 'worktree' : 'run-dir-only', shell: true, network: true, gitPush: false };
}

/** A runtime with neither tool hooks nor an event stream is silent while it works; the
 * worker posts a liveness heartbeat for it so the registry's STALE_AFTER_MIN sweep
 * does not mark a busy run stale. */
export function needsHeartbeat(caps: RuntimeCapabilities): boolean {
  return !caps.toolHooks && !caps.eventStream;
}
export const HEARTBEAT_MS = 60_000;

/**
 * Put an ad-hoc task's files (#179) where the prompt says they are:
 * <runDir>/attachments/<name>. A file already there at the right size is kept, so
 * each later role of the run does not download it again. Names were sanitised by
 * the api on upload; the basename check here is belt and braces.
 */
export async function downloadAttachments(runDir: string, runId: string, ctx: RunContext,
  fetchOne: (runId: string, name: string) => Promise<Buffer> = (r, n) => api.attachment(r, n)): Promise<void> {
  const files = ctx.ticket.attachments ?? [];
  if (!files.length) return;
  const dir = attachmentsDir(runDir);
  await mkdir(dir, { recursive: true });
  for (const f of files) {
    if (f.name !== basename(f.name) || f.name.startsWith('.')) throw new Error(`refusing attachment name "${f.name}"`);
    const path = join(dir, f.name);
    if ((await stat(path).catch(() => null))?.size === f.size) continue;
    await writeFile(path, await fetchOne(runId, f.name));
  }
}

/** Which prior artifacts each role reads, by convention. */
const PRIOR_ARTIFACTS: Record<string, string[]> = {
  planner: [],
  implementer: ['plan.md'],
  tester: ['plan.md'],
  reviewer: ['plan.md', 'test-report.md'],
};

/**
 * M9 #2: asks the worker's login watch whether the Google login is really gone
 * (index.ts wires it; until then, and in tests, nothing is confirmed).
 */
export const googleLogin: { confirm: () => Promise<boolean> } = { confirm: async () => false };

export interface SegmentResult {
  outcome: 'done' | 'failed' | 'needs_human' | 'timeout';
  reason: string | null;
  costUsd: number;
  outputRef: string | null;
  worktreePath: string | null;
  branchName: string | null;
  /** M9 #2: the agent failed because the worker's Google login is gone (vertex mode). */
  googleLoginFailed?: boolean;
}

/**
 * Run one role task to completion: workspace, prompt, per-run settings, spawn,
 * commit whatever it wrote, report the outcome. The worker calls this after a
 * claim; it does not decide run state — the registry does, from the outcome.
 */
/** The git author/committer every agent commits as, whatever its runtime. */
export const AGENT_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'asf-bot', GIT_AUTHOR_EMAIL: 'factory@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'asf-bot', GIT_COMMITTER_EMAIL: 'factory@users.noreply.github.com',
} as const;

export async function runSegment(claim: ClaimResponse & object, ctx: RunContext, log: (m: string) => void): Promise<SegmentResult> {
  const { run, task, team } = claim;
  const runDir = join(config.runDataRoot, run.id);
  await mkdir(runDir, { recursive: true });
  await downloadAttachments(runDir, run.id, ctx);
  const writes = roleWrites(team, String(task.role));

  // A writing/publishing role needs a checkout; a pure planner/reviewer can run without one,
  // but our repos are bound at dispatch, so we make a worktree whenever a repo is present.
  let ws: Workspace | null = null;
  if (ctx.repo && ctx.cloneCredential) {
    ws = await ensureWorkspace(run, ctx.repo, ctx.cloneCredential, log);
  } else if (writes) {
    return { outcome: 'failed', reason: 'a writing role has no repository bound to push to', costUsd: 0, outputRef: null, worktreePath: null, branchName: null };
  }

  // Handed back to resolve a merge conflict at publish (registry conflict.ts): merge the
  // CURRENT base into the branch now and leave git's markers for the implementer. If it
  // merges cleanly this time there is nothing to resolve and the role just re-checks.
  const resolvingConflict = task.queuedBy === CONFLICT_QUEUED_BY && String(task.role) === 'implementer' && ws !== null;
  let conflictFiles: string[] = [];
  if (resolvingConflict && ws && ctx.cloneCredential) {
    conflictFiles = await startConflictMerge(ws, ctx.cloneCredential, log);
    await api.event(run.id, 'conflict:merging', { base: ws.baseBranch, files: conflictFiles }, task.id);
  }

  const cwd = ws?.worktreePath ?? runDir;
  const prior = await loadPriorArtifacts(runDir, PRIOR_ARTIFACTS[String(task.role)] ?? [], ws?.worktreePath);
  // A role re-run after a human answered its needs_human question sees that answer
  // as {{prior.humanReply}} (empty when there is none, so a template may always
  // reference it). The reply is a run artifact saved by the api, so read it from
  // the registry rather than the local disk (a fresh worker has no run dir yet).
  const dbArtifacts = await api.listArtifacts(run.id).catch(() => ({} as Record<string, string>));
  prior.humanReply = dbArtifacts['human-reply.md'] ?? '';
  // A re-running reviewer sees its OWN previous review as {{prior.previousReview}}
  // so it can notice it is repeating itself and ESCALATE instead of looping (M11 WP4).
  if (String(task.role) === 'reviewer') {
    const reviews = (await api.listArtifactVersions(run.id).catch(() => [])).filter((v) => v.name === 'review.md');
    // The newest is the one THIS run will overwrite; index 0 is the last review written.
    prior.previousReview = reviews[0]?.content ?? '';
  }
  // A role re-queued by a rejected gate carries the human's note in task.reason as
  // `revise: <note>` (see registry requeueTask). Surface it so the agent actually revises.
  // A planner re-queued by a chat reply (`chat: …`) is NOT a rejection — it gets the
  // conversation instead (below), never the REVISION banner.
  const isChatTurn = /^chat:/i.test(task.reason ?? '');
  const revision = isChatTurn || resolvingConflict ? undefined : ((task.reason ?? '').replace(/^revise:\s*/i, '').trim() || undefined);
  // The planner chat: the thread so far, and the session to resume if the runtime can.
  const isPlanner = String(task.role) === 'planner';
  const thread = isPlanner ? await api.listMessages(run.id).catch(() => []) : [];
  const conversation: ChatTurn[] = thread.map((m) => ({ author: m.author, body: m.body, by: m.by }));
  const lastHuman = [...thread].reverse().find((m) => m.author === 'human');
  const lastSession = [...thread].reverse().find((m) => m.author === 'agent' && m.sessionId)?.sessionId ?? null;
  // A previous attempt at this role that was cut short (failed/timeout) left its partial
  // work as a wip commit at HEAD (commitWipIfCutShort). Tell the re-run to continue from it.
  const wip = writes && ws ? ((await wipAtHead(ws, String(task.role)).catch(() => null)) ?? undefined) : undefined;
  const skill = roleSkillFor(team, ctx, String(task.role));
  // The factory's shared ad-hoc list, injected into every role's prompt. A transport error
  // or an older registry becomes the 'unavailable' sentinel rather than hiding the section.
  const todos = await api.listAdhoc()
    .then((ts) => ts.map((t) => ({ key: t.key, title: t.title })))
    .catch(() => 'unavailable' as const);
  const prNote = prFeedbackNote(task, run);
  const budget = {
    implementerTurns: maxTurnsFor(ctx, 'implementer', config.maxTurns),
    timeoutMinutes: Math.round((ctx.workerSettings?.segmentTimeoutMs ?? config.segmentTimeoutMs) / 60_000),
  };
  // Claude Code learns its hooks from a per-task settings file; other runtimes
  // will carry telemetry differently. Only write it for the runtime that reads it.
  const runtimeKind = task.runtime ?? config.runtimes[0];
  let settingsPath: string | undefined;
  if (runtimeKind === 'claude-code') {
    settingsPath = join(runDir, `settings-${task.id}.json`);
    await writeFile(settingsPath, JSON.stringify(claudeHooksSettings(), null, 2), 'utf8');
  }

  // The task carries which runtime it needs (per-role in the team template); the worker
  // only claims tasks whose runtime it advertises. segment.ts never names a concrete one.
  const runtime = loadRuntime(runtimeKind, { settingsPath, logPath: join(runDir, `${task.role}.log`) });

  // Third-party skills given to this role: as skill folders in the checkout for a runtime
  // that finds them itself, otherwise as files in the run dir described in the prompt.
  const roleSkills = skillsForRole(ctx, String(task.role));
  let thirdPartySkills: FallbackSkill[] | undefined;
  if (runtime.capabilities.loadsSkillFiles) {
    const { installed, skipped } = await installNativeSkills(cwd, roleSkills, ws !== null);
    if (roleSkills.length) await api.event(run.id, 'skills:delivered', { ids: installed, mode: 'native', skipped }, task.id);
  } else if (roleSkills.length) {
    thirdPartySkills = await writeFallbackSkills(runDir, roleSkills);
    await api.event(run.id, 'skills:delivered', { ids: roleSkills.map((s) => s.id), mode: 'prompt', skipped: [] }, task.id);
  }

  const prompt = prNote + await renderPrompt(String(task.role), run.id, {
    ticket: ctx.ticket, cwd, branch: ws?.branchName ?? '(none)', artifacts: runDir, prior, revision, wip, skill, conversation, todos, budget, thirdPartySkills,
    conflict: resolvingConflict ? { base: ws?.baseBranch ?? 'main', files: conflictFiles } : undefined,
    review: run.team.reviewTarget ?? undefined,
  });
  await writeFile(join(runDir, `${task.role}.prompt.md`), prompt, 'utf8');
  // Mirror the exact rendered prompt (with any REVISION / humanReply banner) to
  // the registry as a versioned artifact so the RunView can show what this task
  // was ASKED, per attempt — not just what it produced (M11 WP2).
  await api.saveArtifact(run.id, `${task.role}.prompt.md`, prompt, { taskId: task.id, source: 'prompt' }).catch(() => {});

  // Org-tier worker knobs come from the api per task (RunContext.workerSettings) so a
  // /settings change applies to the next task with no restart; the local env > default
  // resolution is only the fallback for an older api that does not send them.
  const maxTurns = maxTurnsFor(ctx, String(task.role), config.maxTurns);
  const timeoutMs = ctx.workerSettings?.segmentTimeoutMs ?? config.segmentTimeoutMs;
  const tm = taskModel(ctx, task.model);
  const spawnReq: AgentSpawn = {
    role: task.role,
    prompt,
    cwd,
    model: tm.cliModel,
    // Effort is a vendor feature (claude --effort, codex reasoning effort); Ollama models take none.
    effort: tm.ollama ? undefined : task.effort ?? undefined,
    maxTurns,
    maxCostUsd: run.maxCostUsd,
    policy: policyFor(writes),
    timeoutMs,
    // The hooks read run context from the environment, so the shared secret lives only for the child's lifetime.
    env: {
      ASF_RUN_ID: run.id, ASF_TASK_ID: task.id, ASF_ROLE: String(task.role),
      ASF_API_URL: config.bffUrl, ASF_RUN_SECRET: config.runEventSecret,
      ASF_RUN_DIR: runDir, ASF_SCOPE_ROOT: cwd, ASF_WRITES: writes ? '1' : '0',
      // The agent commits as it goes (implementer.md), and the image has no git identity:
      // without one Codex's `git commit` fails and it parks needs_human. Same bot identity
      // the worker's own commits use (git.ts).
      ...AGENT_GIT_IDENTITY,
    },
    // Effective agent auth for this run and the provider serving THIS task's model, resolved by the
    // api. Applied per spawn so a mode switch takes effect on the next task, no restart.
    auth: authForTask(ctx, runtimeKind, task.model),
  };

  const sink: EventSink = { emit: (e) => { void api.event(run.id, e.kind, e.payload, task.id); } };
  // A chat turn continues the planner's last session when the runtime can: the agent
  // already holds the ticket + its repo reading, so the new prompt is just the reply.
  const resume = isChatTurn && lastHuman && lastSession && runtime.capabilities.resumesSessions
    ? { sessionId: lastSession, prompt: prNote + renderChatTurn(lastHuman.body, lastHuman.by, runDir) } : null;
  // What this task was actually ASKED: on a resumed turn that's the short reply, not the full template.
  if (resume) await api.saveArtifact(run.id, `${task.role}.prompt.md`, `(resumed session ${resume.sessionId})\n\n${resume.prompt}`, { taskId: task.id, source: 'prompt' }).catch(() => {});

  await api.event(run.id, 'segment:started', { role: task.role, writes, dryRun: config.dryRun, maxTurns, timeoutMs }, task.id);
  // Cancel by signal, not by hook (M8 WP A): poll the api while the agent runs and
  // abort the runtime when the operator cancels, so a runtime with no tool hooks
  // still stops. (Dry run still runs the agent; only publishing is suppressed — M3.)
  const cancel = watchCancel(() => api.cancelRequested(run.id), config.cancelPollMs);
  const beat = needsHeartbeat(runtime.capabilities)
    ? setInterval(() => sink.emit({ kind: 'segment:heartbeat', payload: { role: task.role, runtime: runtime.kind } }), HEARTBEAT_MS)
    : null;
  // An Ollama task with no server URL (or a Cloud key bound for a non-Cloud URL) would
  // otherwise reach api.anthropic.com with a placeholder token: fail it with the fix.
  const authCheck = tm.ollama ? checkAuthConfig(spawnReq.auth, process.env, false) : null;
  let outcome: AgentOutcome;
  try {
    if (authCheck && !authCheck.ok) {
      outcome = { outcome: 'failed', text: authCheck.reason, usage: null, costUsd: 0, terminalReason: 'auth_config' };
    } else if (resume) {
      outcome = await runtime.run({ ...spawnReq, prompt: resume.prompt, resumeSessionId: resume.sessionId }, sink, { signal: cancel.signal });
      // The session is gone (a fresh worker container, a cleared ~/.claude): start over
      // with the whole thread in the prompt instead. Costs a full turn, loses nothing.
      if (outcome.outcome === 'failed' && isMissingSession(outcome.text)) {
        log(`planner session ${resume.sessionId} not found; re-running fresh with the conversation`);
        await api.event(run.id, 'chat:resume_fallback', { sessionId: resume.sessionId }, task.id);
        outcome = await runtime.run(spawnReq, sink, { signal: cancel.signal });
      }
    } else {
      outcome = await runtime.run(spawnReq, sink, { signal: cancel.signal });
    }
  } finally {
    cancel.stop();
    if (beat) clearInterval(beat);
  }

  // Post-hoc scope audit (M8 WP A): a read-only role must leave the worktree as it
  // found it, whatever runtime ran it. The Claude hook prevents this up front; for a
  // hookless runtime this is the enforcement. Tracked changes are a violation — the
  // task fails; untracked leftovers (test caches) are swept silently.
  if (ws && !writes) {
    // An agent may have written its artifact (review.md) into the worktree via a relative
    // path — readArtifact tolerates that. Rescue it to the run dir BEFORE the sweep removes it.
    if (task.outputRef) {
      const body = await readArtifact(runDir, task.outputRef, ws.worktreePath);
      if (body !== null) await writeFile(join(runDir, task.outputRef), body, 'utf8').catch(() => {});
    }
    const audit = await auditWorktree(ws, writes).catch((e) => { log(`scope audit failed: ${e}`); return null; });
    if (audit?.violated) {
      const reason = `read-only role ${task.role} modified source files it may not touch (reverted): ${audit.paths.slice(0, 20).join(', ')}`;
      await api.event(run.id, 'scope:violation', { source: 'audit', paths: audit.paths, reason }, task.id);
      outcome = { ...outcome, outcome: 'failed' as const, text: reason };
    } else if (audit?.untracked.length) {
      log(`swept ${audit.untracked.length} untracked file(s) a read-only role left behind`);
    }
  }

  // M9 #2: a Vertex run that failed on the Google login says so in plain words, as an
  // event the run page can show and as the task's reason, instead of a raw auth error.
  // Only when a real token refresh confirms it (googleLogin.confirm), so a role that
  // merely mentions such an error keeps its own reason. Confirming also stops this
  // worker claiming more Claude tasks at once.
  let googleLoginFailed = false;
  if ((outcome.outcome === 'failed' || outcome.outcome === 'timeout') && spawnReq.auth?.mode === 'vertex'
    && isGoogleLoginFailure(outcome.text) && await googleLogin.confirm().catch(() => false)) {
    googleLoginFailed = true;
    const reason = `The Google login on worker ${config.id} has expired, so Claude couldn't run. ${googleLoginFix(config.id)} Then press Retry role.`;
    await api.event(run.id, 'auth:expired', { role: task.role, worker: config.id, provider: 'vertex', reason }, task.id);
    outcome = { ...outcome, outcome: 'failed' as const, text: reason };
  }

  // What the role SAID: its final result text (capped) + turns/cost, so the UI can
  // show it without shelling into the worker's <role>.log (M11 WP2).
  await api.event(run.id, 'segment:result', {
    role: task.role, outcome: outcome.outcome,
    text: (outcome.text ?? '').slice(0, 8192),
    turns: outcome.turns ?? null, terminalReason: outcome.terminalReason ?? null,
    usage: outcome.usage ?? null, costUsd: tm.ollama ? 0 : outcome.costUsd ?? null,
  }, task.id);

  // A conflict resolution is only done when no file still carries git's markers;
  // committing them would push a broken branch that the tester might not catch.
  if (resolvingConflict && ws && outcome.outcome === 'done' && conflictFiles.length) {
    const left = await filesWithConflictMarkers(ws, conflictFiles).catch(() => []);
    if (left.length) {
      outcome = { ...outcome, outcome: 'failed' as const, text: `merge conflict not fully resolved: markers remain in ${left.join(', ')}` };
    } else {
      await api.event(run.id, 'conflict:resolved', { base: ws.baseBranch, files: conflictFiles }, task.id);
    }
  }

  // Commit whatever a writing role produced, so the next role and a resume can see it.
  if (ws && writes && outcome.outcome === 'done') {
    const sha = await commitPending(ws, run, String(task.role), `${task.role}: ${ctx.ticket.key}`, log).catch((e) => { log(`commit failed: ${e}`); return null; });
    // What the role CHANGED: per-file +/- and the full patch (both capped). The
    // patch goes to a versioned artifact (large); the stat rides an event.
    if (sha) {
      const stat = await diffStat(ws, sha).catch(() => null);
      if (stat) {
        await api.event(run.id, 'segment:diff', { role: task.role, commit: sha,
          filesChanged: stat.filesChanged, insertions: stat.insertions, deletions: stat.deletions,
          files: stat.files }, task.id);
        await api.saveArtifact(run.id, `${task.role}.patch`, stat.patch, { taskId: task.id, source: 'patch' }).catch(() => {});
      }
    }
  }
  // A writing role cut short (failed/timeout) with a dirty tree: preserve its partial
  // work as a WIP commit so a retry of this role continues from it instead of starting
  // over. Never on done/needs_human; never pushed (the worker only pushes on publish).
  if (ws && writes) {
    await commitWipIfCutShort(ws, run, String(task.role), outcome.outcome, outcome.text ?? null,
      (kind, payload) => { void api.event(run.id, kind, payload, task.id); }, log);
  }

  // An Ollama task is $0: drop the runtime's figure (Claude Code prices it as Claude) and
  // use the catalogue rate, which is zero or absent. Its token usage is still recorded.
  const costUsd = tm.ollama ? 0 : outcome.costUsd ?? priceUsage(task.model, outcome.usage, mergeCatalogue(ctx.workerSettings?.modelCatalogExtra).models) ?? 0;
  const outputRef = task.outputRef; // the artifact the role was asked to write (plan.md, test-report.md, ...)
  // Mirror the artifact to the registry so the UI and the gate can read it without touching this disk.
  // The agent may have written it to the run dir or, using a relative path, into the worktree — look in both.
  if (outputRef && outcome.outcome === 'done') {
    const art = await resolveOutputArtifact(runDir, outputRef, ws?.worktreePath, outcome.text);
    if (art.source === 'missing') {
      // #41: never finish `done` with no artifact — the gate would open on nothing and
      // the next role would get no plan/report/review.
      const reason = `${task.role} finished without writing ${outputRef}, and its reply was empty, so there is nothing to use instead. Retry the role.`;
      await api.event(run.id, 'artifact:missing', { role: task.role, name: outputRef, reason }, task.id);
      outcome = { ...outcome, outcome: 'failed' as const, text: reason };
    } else {
      if (art.source === 'reply') {
        // #41: some models (seen with Ollama Cloud gpt-oss:120b as planner) put the
        // artifact in their reply instead of the file. Use the reply, and say so.
        log(`${task.role} wrote no ${outputRef}; using its final reply (${art.body.length} chars) instead`);
        await api.event(run.id, 'artifact:from_reply', { role: task.role, name: outputRef, chars: art.body.length }, task.id);
      }
      // Land it in the run dir so later roles' loadPriorArtifacts finds it there.
      if (ws?.worktreePath || art.source === 'reply') await writeFile(join(runDir, outputRef), art.body, 'utf8').catch(() => {});
      await api.saveArtifact(run.id, outputRef, art.body, { taskId: task.id });
    }
  }
  // The planner's side of the chat: its questions, or (with the plan written) its
  // short note to the person. The session id rides along so the next turn resumes.
  if (isPlanner && (outcome.outcome === 'needs_human' || outcome.outcome === 'done')) {
    const body = outcome.outcome === 'needs_human' ? (outcome.text ?? '') : plannerNote(outcome.text ?? '');
    await api.appendMessage({ runId: run.id, taskId: task.id, role: 'planner', author: 'agent',
      kind: outcome.outcome === 'needs_human' ? 'question' : 'plan', body, sessionId: outcome.sessionId ?? null });
  }
  // Turn whatever this role proposed in its run-dir outbox into ad-hoc tasks. The file
  // lives in the run dir, so a read-only role that never wrote one simply no-ops here.
  await drainTodosOutbox(runDir, String(task.role), (input) => api.createAdhoc(input));
  await api.event(run.id, 'segment:finished', { role: task.role, outcome: outcome.outcome, costUsd }, task.id);
  return {
    outcome: outcome.outcome,
    reason: outcome.outcome === 'done' ? null : outcome.text,
    costUsd,
    outputRef,
    worktreePath: ws?.worktreePath ?? null,
    branchName: ws?.branchName ?? null,
    ...(googleLoginFailed ? { googleLoginFailed } : {}),
  };
}

/**
 * The artifact a role that finished `done` was asked to write (#41): the file from the
 * run dir or worktree; failing that, the role's final reply (a model that "answered"
 * with its plan instead of saving it); failing that, missing. Whitespace-only counts
 * as absent for both.
 */
export async function resolveOutputArtifact(
  runDir: string, name: string, worktree: string | undefined, reply: string | null | undefined,
): Promise<{ source: 'file' | 'reply'; body: string } | { source: 'missing' }> {
  const file = await readArtifact(runDir, name, worktree);
  if (file !== null && file.trim()) return { source: 'file', body: file };
  const text = (reply ?? '').trim();
  if (text) return { source: 'reply', body: text + '\n' };
  return { source: 'missing' };
}

/**
 * A writing role that ended in `failed` or `timeout` with uncommitted changes: commit
 * them as `wip(<role>): <KEY> — outcome: <reason>` so the work survives and a retry of
 * this role can continue from it (wipAtHead surfaces it into the re-run's prompt). No-op
 * on any other outcome or a clean tree. Emits `segment:wip_committed` with the diff stat.
 * Never pushes — publishing is the worker's job, and WIP is never published.
 */
export async function commitWipIfCutShort(
  ws: Workspace, run: Run, role: string, outcome: SegmentResult['outcome'], reason: string | null,
  emit: (kind: string, payload: Record<string, unknown>) => void, log: (m: string) => void,
): Promise<void> {
  if (outcome !== 'failed' && outcome !== 'timeout') return;
  const oneLine = (reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || outcome;
  const message = `wip(${role}): ${run.ticketKey} — outcome: ${oneLine}`;
  const sha = await commitPending(ws, run, role, message, log).catch((e) => { log(`wip commit failed: ${e}`); return null; });
  if (!sha) return;
  const stat = await diffStat(ws, sha).catch(() => null);
  emit('segment:wip_committed', { role, commit: sha,
    files: stat?.filesChanged ?? 0, insertions: stat?.insertions ?? 0, deletions: stat?.deletions ?? 0 });
}

/** How many items one drain may create, and the per-field caps on each, so a runaway agent can't flood the backlog. */
const TODOS_OUTBOX = { maxItems: 20, maxTitle: 200, maxBody: 100_000 } as const;

/**
 * Turn a role's append-only outbox (`<runDir>/todos.outbox.jsonl`) into ad-hoc tasks.
 * Absent file → no-op. Each line is one JSON object with at least a `title`; lines that
 * don't parse or lack a non-empty title are skipped. Title/body are capped and at most
 * `maxItems` are created. The file is in the run dir (not the worktree), so a read-only
 * role that never wrote one stays clean.
 *
 * The run dir is shared by every role, so the file is moved aside before it is read:
 * the next role starts with no outbox and can't file the same items again.
 */
export async function drainTodosOutbox(
  runDir: string, role: string,
  create: (input: CreateAdhocInput) => Promise<AdhocTask | null>,
): Promise<void> {
  const outbox = join(runDir, 'todos.outbox.jsonl');
  const drained = join(runDir, `todos.outbox.${role}.${Date.now()}.drained.jsonl`);
  // Claim it first: if the move fails there is nothing (new) to drain.
  if (!(await rename(outbox, drained).then(() => true, () => false))) return;
  const raw = await readFile(drained, 'utf8').catch(() => null);
  if (raw === null) return;
  let made = 0;
  for (const line of raw.split('\n')) {
    if (made >= TODOS_OUTBOX.maxItems) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    const obj = parsed as { title?: unknown; body?: unknown };
    if (typeof obj?.title !== 'string' || !obj.title.trim()) continue;
    const title = obj.title.trim().slice(0, TODOS_OUTBOX.maxTitle);
    const body = typeof obj.body === 'string' ? obj.body.slice(0, TODOS_OUTBOX.maxBody) : '';
    await create({ title, body, createdBy: `agent:${role}`, attachments: [] });
    made++;
  }
}

/** A planner turn queued by changes requested on the open PR says where that PR is; empty otherwise. */
export function prFeedbackNote(task: Pick<RunTask, 'role' | 'queuedBy'>, run: Pick<Run, 'changeRequestUrl'>): string {
  if (String(task.role) !== 'planner' || task.queuedBy !== 'pr_feedback') return '';
  return `The PR is open at ${run.changeRequestUrl ?? '(unknown url)'}; plan the revision on top of it.\n\n`;
}

/** The CLI's reply when --resume names a session it no longer has. */
export function isMissingSession(text: string | null | undefined): boolean {
  return /no conversation found|session .*not found/i.test(text ?? '');
}

/** The planner's closing words to the person after writing plan.md (its final result text), trimmed for the chat. */
export function plannerNote(text: string): string {
  const t = text.trim();
  if (!t) return 'I wrote the plan. Take a look and approve it, or reply to change it.';
  return t.length > 1500 ? `${t.slice(0, 1500)}…` : t;
}

/** Claude Code's per-task hooks settings, absolute hook paths so they run anywhere Node does. */
function claudeHooksSettings() {
  const hook = (file: string) => ({ matcher: '*', hooks: [{ type: 'command', command: `node ${join(HOOKS_DIR, file)}`, timeout: 10 }] });
  return { hooks: { PreToolUse: [hook('pre-tool-use.mjs')], PostToolUse: [hook('post-tool-use.mjs')], Stop: [hook('stop.mjs')] } };
}
