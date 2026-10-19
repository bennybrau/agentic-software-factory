import type { FastifyInstance } from 'fastify';
import type { ScmProvider, TicketProvider, RunReportInput } from '@asf/shared';
import { isAdhocId, runReportMarkdown } from '@asf/shared';
import { config } from '../config.js';
import { registry } from '../registry/client.js';
import { ticketsFor } from '../tickets/route.js';
import { withoutRepoList } from './adhoc.js';

/** Assemble the report input for a run from the registry (tasks + events + artifact versions). */
async function buildReportInput(runId: string): Promise<RunReportInput | null> {
  const run = await registry.getRun(runId);
  if (!run) return null;
  const [events, versions] = await Promise.all([
    registry.getEvents(runId, 0, 1000),
    registry.listArtifactVersions(runId),
  ]);
  return {
    run: run.run, tasks: run.tasks, events: events.events,
    artifacts: versions.versions.map((v) => ({ name: v.name, taskId: v.taskId, attempt: v.attempt, source: v.source, content: v.content })),
  };
}

/**
 * The browser-facing read + control surface. No X-Run-Secret here (that guards
 * worker/hook traffic); in the single-operator MVP the browser is trusted on
 * loopback. Everything the UI needs to render a run and answer its gates.
 */
export function registerBrowserRoutes(app: FastifyInstance, deps: { tickets: TicketProvider; scm: ScmProvider }): void {
  app.get('/api/runs', async (req) => {
    const q = req.query as { ticketId?: string; state?: string; teamName?: string; deliveryOutcome?: string; search?: string; since?: string; limit?: string; offset?: string };
    return registry.listRuns({
      ticketId: q.ticketId,
      state: (q.state as never) || undefined,
      teamName: q.teamName || undefined,
      deliveryOutcome: (q.deliveryOutcome as never) || undefined,
      search: q.search || undefined,
      since: q.since || undefined,
      limit: Number(q.limit ?? 25),
      offset: Number(q.offset ?? 0),
    });
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const run = await registry.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    const ticketId = run.run.ticketId;
    const [gates, artifacts, versions, chat, split, adhocTicket] = await Promise.all([
      registry.listGates(req.params.id),
      registry.listArtifacts(req.params.id),
      registry.listArtifactVersions(req.params.id),
      // Older registries have no chat op — a run view must still load.
      registry.listMessages(req.params.id).catch(() => ({ messages: [] })),
      // The split this run is part of (or was split into); older registries lack the op.
      registry.getSplitFamily(req.params.id).catch(() => null),
      // An ad-hoc task a schedule created says which schedule (#188); a missing task must not break the view.
      isAdhocId(ticketId) ? ticketsFor(deps.tickets, ticketId).get(ticketId).catch(() => null) : null,
    ]);
    const recurring = adhocTicket?.recurringId ? { id: adhocTicket.recurringId, title: adhocTicket.recurringTitle ?? null } : null;
    // What was asked, as the chat's first message: the ad-hoc body as typed, without the repository list.
    const request = adhocTicket ? withoutRepoList(adhocTicket.body) || null : null;
    // The flat "Stage output" list is the role deliverables (plan.md, review.md, …).
    // Prompt mirrors and patches (M11 WP2) are large and per-task — keep them out of
    // that list; they ride in artifactVersions for the task panel to fetch on demand.
    const stageArtifacts = artifacts.artifacts.filter((a) => !/\.(prompt\.md|patch)$/.test(a.name));
    // Live progress for any running task (M11 WP5): tool-call count + last tool + ceiling.
    const runningIds = run.tasks.filter((t) => t.state === 'running').map((t) => t.id);
    const progress = runningIds.length ? (await registry.taskProgress(runningIds)).progress : {};
    return { ...run, gates: gates.gates, artifacts: stageArtifacts, artifactVersions: versions.versions, taskProgress: progress, messages: chat.messages, split, recurring, request };
  });

  // The story of a run in one place (M11 WP6): JSON for the UI Report tab, Markdown
  // for pasting into a ticket or feeding an agent. Tolerant of pre-M11 runs.
  app.get<{ Params: { id: string } }>('/api/runs/:id/report', async (req, reply) => {
    const input = await buildReportInput(req.params.id);
    if (!input) return reply.code(404).send({ error: 'not_found' });
    return { markdown: runReportMarkdown(input) };
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/report.md', async (req, reply) => {
    const input = await buildReportInput(req.params.id);
    if (!input) return reply.code(404).send({ error: 'not_found' });
    reply.header('content-type', 'text/markdown; charset=utf-8');
    return runReportMarkdown(input);
  });

  // The Today landing page: the four buckets in one call. `since` is the
  // browser's own local midnight (ISO) so "done today" matches the operator's
  // day, not the server's; it falls back to the server's local midnight.
  app.get('/api/today', async (req) => {
    const q = req.query as { since?: string };
    let since = q.since;
    if (!since || Number.isNaN(Date.parse(since))) {
      const d = new Date(); d.setHours(0, 0, 0, 0); since = d.toISOString();
    }
    return registry.today(since);
  });

  app.post<{ Params: { id: string }; Body: { by?: string } }>('/api/runs/:id/cancel', async (req) =>
    registry.cancelRun(req.params.id, (req.body ?? {}).by ?? null));

  // Notification inbox (M6 WP6.3). The web sink IS this list — the browser reads
  // it and marks rows read. External sinks (Telegram) deliver the same rows.
  app.get('/api/notifications', async (req) => {
    const q = req.query as { unreadOnly?: string; limit?: string };
    return registry.listNotifications({ unreadOnly: q.unreadOnly === 'true', limit: Number(q.limit ?? 50) });
  });
  app.post<{ Body: { id?: string | null } }>('/api/notifications/read', async (req) => {
    await registry.markNotificationRead((req.body ?? {}).id ?? null);
    return { ok: true };
  });
  app.post('/api/notifications/clear', async () => {
    await registry.clearNotifications();
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { by?: string } }>('/api/runs/:id/resume', async (req) =>
    registry.resumeRun(req.params.id, (req.body ?? {}).by ?? null));

  // Retry a failed run: re-run the failed role from where it stopped (a WIP commit
  // preserves its partial work). 409 unless the run is failed with a failed role task.
  app.post<{ Params: { id: string }; Body: { note?: string; by?: string } }>('/api/runs/:id/retry', async (req, reply) => {
    const detail = await registry.getRun(req.params.id);
    if (!detail) return reply.code(404).send({ error: 'not_found' });
    const retryable = detail.run.state === 'failed' && detail.tasks.some((t) => t.runtime !== 'publish' && t.state === 'failed');
    if (!retryable) return reply.code(409).send({ error: 'not_retryable', reason: 'retry needs a failed run with a failed role task' });
    const b = req.body ?? {};
    await registry.retryFailedTask(req.params.id, b.note ?? null, b.by ?? null);
    return { ok: true };
  });

  // A run that failed because its branch no longer merges into the base (other work
  // landed on the same lines): hand the conflict back to the implementer, then re-test,
  // re-review and push again. 409 with the reason when the run didn't fail that way.
  app.post<{ Params: { id: string }; Body: { by?: string } }>('/api/runs/:id/resolve-conflict', async (req, reply) => {
    try {
      await registry.resolveConflict(req.params.id, (req.body ?? {}).by ?? null);
      return { ok: true };
    } catch (e) {
      const m = /registry rpc resolveConflict failed: 409 (.*)$/.exec((e as Error).message);
      if (m) return reply.code(409).send({ error: 'not_resolvable', reason: m[1] });
      throw e;
    }
  });

  // Answer / skip a task parked at needs_human (M6 WP6.4). Answering re-runs the
  // role with the reply available as {{prior.humanReply}}; skipping moves on.
  app.post<{ Params: { id: string }; Body: { reply?: string; by?: string } }>('/api/runs/:id/answer', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.reply || !b.reply.trim()) return reply.code(400).send({ error: 'bad_request', reason: 'reply is required' });
    await registry.answerNeedsHuman(req.params.id, b.reply, b.by ?? null);
    return { ok: true };
  });
  // Planner chat: reply to the planner while it waits on you (its questions, or its
  // plan at the plan gate). Re-runs the planner with the conversation. 409 when the
  // planner isn't waiting (the reason says so) so the UI can show it.
  app.post<{ Params: { id: string }; Body: { message?: string; by?: string } }>('/api/runs/:id/chat', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.message || !b.message.trim()) return reply.code(400).send({ error: 'bad_request', reason: 'message is required' });
    try {
      const { message } = await registry.sendChatMessage(req.params.id, b.message, b.by ?? null);
      return { ok: true, message };
    } catch (e) {
      const m = /registry rpc sendChatMessage failed: 409 (.*)$/.exec((e as Error).message);
      if (m) return reply.code(409).send({ error: 'chat_error', reason: m[1].trim() || 'the planner is not waiting for a reply' });
      throw e;
    }
  });
  // Request changes after the MR/PR is open: the same run re-plans with the feedback
  // as a planner chat turn, re-runs and pushes onto the same PR. 409 with the reason
  // when it can't (merged, closed, still running, no PR).
  app.post<{ Params: { id: string }; Body: { message?: string; by?: string } }>('/api/runs/:id/request-changes', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.message || !b.message.trim()) return reply.code(400).send({ error: 'bad_request', reason: 'message is required' });
    try {
      const { message } = await registry.requestChanges(req.params.id, b.message, b.by ?? null);
      return { ok: true, message };
    } catch (e) {
      const m = /registry rpc requestChanges failed: 409 (.*)$/.exec((e as Error).message);
      if (m) return reply.code(409).send({ error: 'request_changes_refused', reason: m[1].trim() || 'changes cannot be requested on this run right now' });
      throw e;
    }
  });
  app.post<{ Params: { id: string }; Body: { by?: string } }>('/api/runs/:id/skip', async (req) => {
    await registry.skipNeedsHuman(req.params.id, (req.body ?? {}).by ?? null);
    return { ok: true };
  });

  // Answer a gate: approve/reject, with an optional edited artifact (e.g. an edited plan).
  app.post<{ Params: { gateId: string }; Body: { decision: 'approve' | 'reject'; by?: string; note?: string; editedArtifact?: string } }>(
    '/api/gates/:gateId', async (req, reply) => {
      const b = req.body ?? ({} as { decision: 'approve' | 'reject' });
      if (b.decision !== 'approve' && b.decision !== 'reject') return reply.code(400).send({ error: 'bad_decision' });
      try {
        await registry.resolveGate({ op: 'resolveGate', gateId: req.params.gateId, decision: b.decision, by: b.by ?? null, note: b.note ?? null, editedArtifact: b.editedArtifact ?? null });
      } catch (e) {
        // A refused gate decision (gate already decided, a plan's split can't be carried
        // out) is the person's to fix: say why, don't 500.
        const m = /failed: 409 (.*)$/s.exec((e as Error).message);
        if (m) return reply.code(409).send({ error: 'gate_refused', reason: m[1].trim() });
        throw e;
      }
      return { ok: true };
    });

  // SSE proxy: forward the registry's run-event stream to the browser.
  app.get('/api/events', async (_req, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    reply.raw.write('event: hello\ndata: {}\n\n');
    const upstream = await fetch(`${config.registryUrl}/internal/events/runs`, { headers: { 'x-run-secret': config.runEventSecret } });
    const reader = upstream.body!.getReader();
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    const pump = async () => {
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; reply.raw.write(Buffer.from(value)); } } catch { /* client or upstream gone */ }
    };
    void pump();
    reply.raw.on('close', () => { clearInterval(ping); reader.cancel().catch(() => {}); });
    await new Promise<void>((resolve) => reply.raw.on('close', resolve));
  });
}

