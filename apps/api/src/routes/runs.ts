import type { FastifyInstance } from 'fastify';
import { appendEventInputSchema, runContextSchema, ROLE_SKILL_ORG_SETTING_KEYS, MAX_TURNS_ORG_SETTING_KEYS, isAdhocId } from '@asf/shared';
import type { RunContext, ScmProvider, TicketProvider, WorkerSettings } from '@asf/shared';
import { config } from '../config.js';
import { registry } from '../registry/client.js';
import { computeRunAuth, computeRunAuths, describeAgentAuth } from '../agent-auth.js';
import { cfg } from '../settings.js';
import { ticketsFor } from '../tickets/route.js';
import { adhocTickets } from '../providers/tickets/index.js';
import { startReadiness } from '../start-readiness.js';

/**
 * Every repository source control can reach, for the planner's split hand-offs. Paths and
 * default branches only (no clone URL). A failed lookup leaves the field out: the run still
 * starts, and the planner is told it doesn't know which other repositories exist.
 */
export async function computeConnectedRepos(scm: ScmProvider): Promise<RunContext['connectedRepos']> {
  const ready = await startReadiness(scm).catch(() => null);
  if (!ready?.ok) return undefined;
  return ready.repos.map((r) => ({ id: r.id, path: r.path, defaultBranch: r.defaultBranch }));
}

/** Org-tier worker knobs, resolved NOW (env > org > default) so a /admin change reaches the next task. */
export function computeWorkerSettings(): WorkerSettings {
  // MAX_TURNS_<ROLE> keyed by lowercase role; 0/blank is left out so the worker falls back to maxTurns.
  const maxTurnsByRole: Record<string, number> = {};
  for (const key of MAX_TURNS_ORG_SETTING_KEYS) {
    const n = Number(cfg(key));
    if (Number.isInteger(n) && n > 0) maxTurnsByRole[key.replace(/^MAX_TURNS_/, '').toLowerCase()] = n;
  }
  return { maxTurns: cfg('WORKER_MAX_TURNS'), segmentTimeoutMs: cfg('SEGMENT_TIMEOUT_MS'), maxTurnsByRole, modelCatalogExtra: cfg('MODEL_CATALOG_EXTRA') };
}

/**
 * The org-tier per-role skill blobs (ROLE_SKILL_<ROLE>), resolved NOW so a
 * /admin edit reaches the next task with no restart. Keyed by role name (lower
 * of the suffix). Only non-empty blobs are included, keeping the delivered map
 * small; the worker treats a missing role as no org skill. The per-dispatch
 * addition rides separately on the run's team (teamRoleSchema.skill).
 */
export function computeRoleSkills(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ROLE_SKILL_ORG_SETTING_KEYS) {
    const role = key.replace(/^ROLE_SKILL_/, '').toLowerCase();
    const blob = (cfg(key) as string ?? '').trim();
    if (blob) out[role] = blob;
  }
  return out;
}

/**
 * The half of the worker's world that needs a credential. The worker claims a
 * task from the registry, then asks the api for context (this file) — the
 * registry holds no ticket or SCM credential, so the ticket snapshot and the
 * clone credential can only come from here. Hook telemetry also lands here and
 * is forwarded to the registry, so the shared secret is checked once at ingest.
 */
export function registerRunRoutes(app: FastifyInstance, deps: { tickets: TicketProvider; scm: ScmProvider }): void {
  // Guard ONLY the worker/hook paths (context + event ingest). The browser's
  // read routes (GET /api/runs, GET /api/runs/:id, cancel/resume) live in
  // browser.ts and are not secret-guarded in the single-operator MVP.
  app.addHook('onRequest', async (req, reply) => {
    const isWorkerPath = /^\/api\/runs\/[^/]+\/(context|events|cancel-requested)/.test(req.url) || req.url.startsWith('/api/agent-auth');
    if (!isWorkerPath) return;
    if (req.headers['x-run-secret'] !== config.runEventSecret) {
      reply.code(401).send({ error: 'unauthorized', reason: 'missing or wrong X-Run-Secret' });
    }
  });

  // The worker polls this on heartbeat to notice an org-side auth-mode change and
  // re-register with the new mode — without a restart. Returns the mode + whether a
  // key is resolvable, never the key itself.
  app.get('/api/agent-auth', async () => describeAgentAuth());

  app.get<{ Params: { id: string } }>('/api/runs/:id/context', async (req, reply) => {
    const got = await registry.getRun(req.params.id);
    if (!got) return reply.code(404).send({ error: 'not_found', reason: `no run ${req.params.id}` });
    const { run } = got;

    const ticket = await ticketsFor(deps.tickets, run.ticketId).get(run.ticketId);
    // An ad-hoc task's files (#179): the worker downloads each from /api/runs/:id/attachments/:name.
    const attachments = isAdhocId(run.ticketId) ? await adhocTickets.attachments(run.ticketId) : undefined;
    let repo: RunContext['repo'] = null;
    let cloneCredential: RunContext['cloneCredential'] = null;
    if (run.repoId) {
      repo = await deps.scm.getRepo(run.repoId);
      cloneCredential = await deps.scm.cloneCredential(repo);
    }
    const context: RunContext = {
      runId: run.id,
      ticket: { id: ticket.id, key: ticket.key, title: ticket.title, body: ticket.body, url: ticket.url,
        links: ticket.links.map((l) => ({ title: l.title, url: l.url, kind: l.kind })),
        ...(attachments?.length ? { attachments } : {}) },
      repo,
      cloneCredential,
      // An unreadable saved token (#9) fails only the runs that need it (the worker
      // reports the missing credential), not every run's context.
      auth: await computeRunAuth('anthropic').catch((err) => {
        req.log.warn({ reason: (err as Error).message }, 'anthropic auth unresolved');
        return { providerKind: 'anthropic' as const, mode: String(cfg('AGENT_AUTH_MODE')) };
      }),
      auths: await computeRunAuths(),
      workerSettings: computeWorkerSettings(),
      roleSkills: computeRoleSkills(),
      // An older registry has no listSkills: run without skills rather than fail the claim.
      thirdPartySkills: await registry.listSkills()
        .then((r) => r.skills.filter((s) => s.enabled))
        .catch((e) => { req.log.warn({ err: e }, 'listSkills failed; delivering no third-party skills'); return []; }),
    };
    const connectedRepos = await computeConnectedRepos(deps.scm);
    if (connectedRepos) context.connectedRepos = connectedRepos;
    else req.log.warn({ runId: run.id }, 'could not list the connected repositories; the planner gets no list');
    return runContextSchema.parse(context);
  });

  // Hook ingest. The producer is a hook script with no session; it keeps posting
  // after whoever dispatched closed the tab. Forwarded verbatim to the registry.
  app.post<{ Params: { id: string } }>('/api/runs/:id/events', async (req, reply) => {
    const parsed = appendEventInputSchema.safeParse({ ...(req.body as object), runId: req.params.id });
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const { event } = await registry.appendEvent(parsed.data);
    // The ack carries whether a cancel has been requested, so the PreToolUse hook can stop the agent.
    const run = await registry.getRun(req.params.id);
    return { ok: true, seq: event.seq, cancelRequested: Boolean(run?.run.cancelRequestedAt) };
  });

  // Cancel without hooks (M8 WP A). The PreToolUse hook learns of a cancel from the
  // event ack, but a runtime with no hooks never posts one — so the worker polls this
  // while the agent runs and aborts it itself. An unknown run reads as not-cancelled.
  app.get<{ Params: { id: string } }>('/api/runs/:id/cancel-requested', async (req) => {
    const run = await registry.getRun(req.params.id);
    return { cancelRequested: Boolean(run?.run.cancelRequestedAt) };
  });
}
