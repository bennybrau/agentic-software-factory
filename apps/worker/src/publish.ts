import { join } from 'node:path';
import type { ClaimResponse, RunContext } from '@asf/shared';
import { config } from './config.js';
import { api } from './api.js';
import { ensureWorkspace, commitPending, pushBranch, changedFileCount, bootstrapBaseBranch, rebaseOntoBase } from './git.js';
import { rm } from 'node:fs/promises';
import { changeType } from './commit-type.js';

/** Role artifacts belong in the run dir, not the delivered repo. An agent that wrote one
 *  with a relative path lands it in the worktree; drop those before the publish commit. */
const ARTIFACT_FILES = ['plan.md', 'test-report.md', 'review.md', 'human-reply.md', 'thread-replies.json'];
async function dropStrayArtifacts(worktree: string): Promise<void> {
  await Promise.all(ARTIFACT_FILES.map((f) => rm(join(worktree, f), { force: true }).catch(() => {})));
}

/**
 * The publish phase, performed by the worker (it holds the clone credential;
 * opening/merging the change request goes through the api -> ScmProvider). Two
 * step kinds, sequenced by the orchestrator with gates between them:
 *   publish:push_open  commit anything pending, push the branch, open a draft CR
 *   publish:merge      mark ready + merge the CR
 */
export interface PublishResult { outcome: 'done' | 'failed'; reason: string | null; costUsd: number; }

export async function runPublish(claim: ClaimResponse & object, ctx: RunContext, log: (m: string) => void): Promise<PublishResult> {
  const { run, task } = claim;
  if (!ctx.repo || !ctx.cloneCredential) return { outcome: 'failed', reason: 'publish needs a bound repo', costUsd: 0 };
  const ws = await ensureWorkspace(run, ctx.repo, ctx.cloneCredential, log);

  if (String(task.role) === 'publish:push_open') {
    // Agent-written role artifacts (review.md, test-report.md, …) can land in the worktree
    // via a relative path; they must not be committed into the delivery.
    await dropStrayArtifacts(ws.worktreePath);
    await commitPending(ws, run, 'factory', `chore: ${run.ticketKey} — agent delivery`, log).catch(() => {});
    const changes = await changedFileCount(ws).catch(() => 0);
    if (changes === 0) return { outcome: 'failed', reason: 'nothing to publish: the branch has no changes over its base', costUsd: 0 };
    // First delivery into an empty repo: create the default branch on the remote and
    // re-parent the work branch onto it, so the PR has a valid, mergeable base.
    await bootstrapBaseBranch(ws, ctx.cloneCredential, log);
    // The Conventional Commits type (from review.md, then plan.md) leads the squashed
    // commit and the PR title, so images.yml can pick the semver bump from main's history.
    const arts = await fetchArtifacts(run.id);
    const type = changeType(arts['review.md'], arts['plan.md']);
    // Born repo: rebase+squash onto the CURRENT default branch so the PR is never stale
    // (a base that moved since the clone would otherwise conflict) and has clean history.
    await rebaseOntoBase(ws, run, ctx.cloneCredential, log, { type, title: ctx.ticket.title });
    await pushBranch(ws, ctx.cloneCredential, log);
    await api.event(run.id, 'branch:pushed', { branch: ws.branchName, changedFiles: changes }, task.id);

    // Changes requested on a PR this run already opened: the push updated it. Never open a second one.
    if (run.changeRequestNumber != null) {
      await api.event(run.id, 'change_request:updated', { number: run.changeRequestNumber, url: run.changeRequestUrl }, task.id);
      // Answer the review threads this round addressed (#109). A failed reply never fails the push.
      try {
        await api.replyToThreads(run.id, run.changeRequestNumber);
      } catch (e) {
        const reason = (e as Error).message;
        log(`replying on review threads failed: ${reason}`);
        await api.event(run.id, 'review_threads:reply_failed', { reason }, task.id);
      }
      return { outcome: 'done', reason: null, costUsd: 0 };
    }

    const body = buildBody(run.id, ctx, arts);
    const cr = await api.openChangeRequest(run.id, { head: ws.branchName, base: ws.baseBranch, title: `${type}: ${ctx.ticket.key}: ${ctx.ticket.title}`, body, draft: true });
    await api.event(run.id, 'change_request:opened', { number: cr.number, url: cr.url, draft: true }, task.id);
    // Comment the CR link back on the ticket via the api's ticket provider is a fast-follow;
    // the run row carries changeRequestUrl through the event for now.
    return { outcome: 'done', reason: null, costUsd: 0 };
  }

  if (String(task.role) === 'publish:mark_ready') {
    // Merge OFF path: the MR was opened as a draft; mark it ready for review so a
    // human can review + merge it in the SCM. ASF does not merge.
    const number = await lastChangeRequestNumber(run.id).catch(() => null);
    if (number == null) return { outcome: 'failed', reason: 'no change request to mark ready', costUsd: 0 };
    // Already ready from an earlier round (changes were requested on it): nothing to flip.
    if (run.changeRequestState !== 'ready') await api.markReadyChangeRequest(run.id, number);
    await api.event(run.id, 'change_request:ready', { number }, task.id);
    return { outcome: 'done', reason: null, costUsd: 0 };
  }

  if (String(task.role) === 'publish:merge') {
    // The CR number came from the push_open event; the api re-resolves it by run when merging.
    // For the mock/GitHub providers the most recent CR for the run's branch is the one to merge.
    const number = await lastChangeRequestNumber(run.id).catch(() => null);
    if (number == null) return { outcome: 'failed', reason: 'no change request to merge', costUsd: 0 };
    await api.mergeChangeRequest(run.id, number, 'squash');
    await api.event(run.id, 'change_request:merged', { number, method: 'squash' }, task.id);
    return { outcome: 'done', reason: null, costUsd: 0 };
  }

  return { outcome: 'failed', reason: `unknown publish step ${task.role}`, costUsd: 0 };
}

function buildBody(runId: string, ctx: RunContext, arts: Record<string, string>): string {
  const section = (name: string, title: string) => (arts[name] ? `## ${title}\n\n${arts[name]}\n` : '');
  return [
    `Automated delivery for **${ctx.ticket.key}: ${ctx.ticket.title}**.`,
    ctx.ticket.url ? `\nTicket: ${ctx.ticket.url}` : '',
    '\n' + section('plan.md', 'Plan'),
    section('test-report.md', 'Test report'),
    section('review.md', 'Review'),
    `\n---\n_Opened by the Agentic Software Factory (run ${runId})._`,
  ].join('\n');
}

async function fetchArtifacts(runId: string): Promise<Record<string, string>> {
  const res = await fetch(`${config.registryUrl}/internal/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-run-secret': config.runEventSecret },
    body: JSON.stringify({ op: 'listArtifacts', runId }),
  });
  const j = await res.json().catch(() => ({ result: { artifacts: [] } }));
  const out: Record<string, string> = {};
  for (const a of j.result?.artifacts ?? []) out[a.name] = a.content;
  return out;
}

async function lastChangeRequestNumber(runId: string): Promise<number | null> {
  const res = await fetch(`${config.registryUrl}/internal/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-run-secret': config.runEventSecret },
    body: JSON.stringify({ op: 'getEvents', runId, afterSeq: 0, limit: 1000 }),
  });
  const j = await res.json().catch(() => ({ result: { events: [] } }));
  const opened = [...(j.result?.events ?? [])].reverse().find((e: { kind: string }) => e.kind === 'change_request:opened');
  return opened ? Number(opened.payload.number) : null;
}
