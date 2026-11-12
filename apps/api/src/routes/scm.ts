import type { FastifyInstance } from 'fastify';
import type { RunEvent, ScmProvider, TicketProvider } from '@asf/shared';
import { config } from '../config.js';
import { registry } from '../registry/client.js';
import { cfg } from '../settings.js';
import { transitionTicketTo, parsePreferredStatuses } from '../tickets/transition.js';
import { ticketsFor } from '../tickets/route.js';

/**
 * The publish surface. The worker pushes the branch itself (it holds the clone
 * credential), then calls these to open and merge the change request through
 * the ScmProvider — the SCM credential lives here, never on the worker's agent.
 *
 * These are also the two points where the ticket moves along its board: the
 * change request opening is "in review", the merge is "done". The ticket id is
 * read from the run (it carries ticketId), so a Jira ticket driving a GitHub
 * PR is transitioned on the Jira side here. Best-effort — a status move never
 * fails the publish (see transitionTicketTo).
 */
export function registerScmRoutes(app: FastifyInstance, deps: { scm: ScmProvider; tickets: TicketProvider }): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/scm/')) return;
    if (req.headers['x-run-secret'] !== config.runEventSecret) reply.code(401).send({ error: 'unauthorized' });
  });

  // Open a draft change request for a run's branch, and write the body from its artifacts.
  app.post<{ Body: { runId: string; head: string; base: string; title: string; body: string; draft: boolean } }>(
    '/api/scm/change-request', async (req, reply) => {
      const { runId, head, base, title, body, draft } = req.body;
      const got = await registry.getRun(runId);
      if (!got?.run.repoId) return reply.code(400).send({ error: 'no_repo' });
      const repo = await deps.scm.getRepo(got.run.repoId);
      const cr = await deps.scm.openChangeRequest(repo, { head, base, title, body, draft });
      // The PR is open → move the ticket into review.
      await transitionTicketTo(ticketsFor(deps.tickets, got.run.ticketId), got.run.ticketId, parsePreferredStatuses(cfg('TICKET_STATUS_INREVIEW')));
      return { changeRequest: cr };
    });

  app.post<{ Body: { runId: string; number: number; method: 'merge' | 'squash' | 'rebase' } }>(
    '/api/scm/merge', async (req, reply) => {
      const { runId, number, method } = req.body;
      const got = await registry.getRun(runId);
      if (!got?.run.repoId) return reply.code(400).send({ error: 'no_repo' });
      const repo = await deps.scm.getRepo(got.run.repoId);
      await deps.scm.markReady(repo, number).catch(() => {});
      await deps.scm.merge(repo, number, { method });
      // Merged → the work is done; close the ticket out.
      await transitionTicketTo(ticketsFor(deps.tickets, got.run.ticketId), got.run.ticketId, parsePreferredStatuses(cfg('TICKET_STATUS_DONE')));
      return { ok: true };
    });

  // Merge OFF path: mark the draft CR ready for review (ASF does not merge). The
  // ticket moves to "in review" — a human reviews + merges in the SCM.
  app.post<{ Body: { runId: string; number: number } }>(
    '/api/scm/mark-ready', async (req, reply) => {
      const { runId, number } = req.body;
      const got = await registry.getRun(runId);
      if (!got?.run.repoId) return reply.code(400).send({ error: 'no_repo' });
      const repo = await deps.scm.getRepo(got.run.repoId);
      await deps.scm.markReady(repo, number);
      await transitionTicketTo(ticketsFor(deps.tickets, got.run.ticketId), got.run.ticketId, parsePreferredStatuses(cfg('TICKET_STATUS_INREVIEW')));
      return { ok: true };
    });

  // After the push that addressed review threads (#109): reply under each thread that
  // was sent and that the implementer wrote a reply for. Once per sent batch. Never
  // resolves a thread, approves or merges.
  app.post<{ Body: { runId: string; number: number } }>(
    '/api/scm/thread-replies', async (req, reply) => {
      const { runId, number } = req.body;
      const out = { replied: [] as string[], failed: [] as Array<{ thread: string; reason: string }> };
      const latest = (await allEvents(runId)).sort((a, b) => b.seq - a.seq)
        .find((e) => e.kind === 'review_threads:sent' || e.kind === 'review_threads:replied');
      if (latest?.kind !== 'review_threads:sent' || Number(latest.payload.number) !== number) return out;
      const sent = new Set((Array.isArray(latest.payload.threadIds) ? latest.payload.threadIds : []).map(String));
      const { versions } = await registry.listArtifactVersions(runId);
      const art = versions.filter((v) => v.name === THREAD_REPLIES)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      const fresh = art && Date.parse(art.createdAt) > Date.parse(latest.at) ? art : null;
      const replies = threadReplies(fresh?.content).filter((r) => sent.has(r.thread));
      const got = await registry.getRun(runId);
      if (!got?.run.repoId) return reply.code(400).send({ error: 'no_repo' });
      const repo = replies.length ? await deps.scm.getRepo(got.run.repoId) : null;
      for (const r of replies) {
        try {
          await deps.scm.replyToThread(repo!, number, r.thread, `${capReply(r.reply)}\n\n— ASF run ${runId}`);
          out.replied.push(r.thread);
        } catch (e) {
          out.failed.push({ thread: r.thread, reason: (e as Error).message });
        }
      }
      await registry.appendEvent({ runId, taskId: null, kind: 'review_threads:replied', source: 'worker',
        payload: { number, replied: out.replied, failed: out.failed } });
      return out;
    });
}

const THREAD_REPLIES = 'thread-replies.json';
const REPLY_MAX_CHARS = 600;
const EVENTS_PAGE = 1000;

/** Every event of a run, oldest first: tool events alone can run past one page. */
async function allEvents(runId: string): Promise<RunEvent[]> {
  const all: RunEvent[] = [];
  for (let after = 0; ;) {
    const { events } = await registry.getEvents(runId, after, EVENTS_PAGE);
    all.push(...events);
    if (events.length < EVENTS_PAGE) return all;
    after = Math.max(...events.map((e) => e.seq));
  }
}

/** The implementer's `[{ thread, reply }]`, read leniently: bad JSON or a bad entry counts as no entry. Later entries for a thread win. */
export function threadReplies(content: string | undefined): Array<{ thread: string; reply: string }> {
  let parsed: unknown;
  try { parsed = JSON.parse(content ?? ''); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const byThread = new Map<string, string>();
  for (const e of parsed as Array<{ thread?: unknown; reply?: unknown }>) {
    if (typeof e?.thread !== 'string' || !e.thread || typeof e.reply !== 'string' || !e.reply.trim()) continue;
    byThread.set(e.thread, e.reply);
  }
  return [...byThread].map(([thread, reply]) => ({ thread, reply }));
}

/** Trimmed, and cut at REPLY_MAX_CHARS with an ellipsis. */
function capReply(text: string): string {
  const t = text.trim();
  return t.length > REPLY_MAX_CHARS ? `${t.slice(0, REPLY_MAX_CHARS - 1).trimEnd()}…` : t;
}
