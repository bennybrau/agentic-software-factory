import type { FastifyInstance } from 'fastify';
import { STANDARD_TEAM, GatePolicyError, resolvePipeline, skipRoles, disabledRoles, reviewOnlyStages, parseReviewRequest, PipelineConfigError } from '@asf/shared';
import type { GateConfig, Repo, ScmProvider, TeamTemplate, TicketProvider } from '@asf/shared';
import { registry, RunConflict } from '../registry/client.js';
import type { RunWithTasks } from '@asf/shared';
import { cfg, orgValues } from '../settings.js';
import { resolveIdentity } from '../identity.js';
import { transitionTicketTo, parsePreferredStatuses } from '../tickets/transition.js';
import { assignTicketTo } from '../tickets/assign.js';
import { ticketsFor } from '../tickets/route.js';
import { computeRoleSkills } from './runs.js';
import { EFFORT_LEVELS } from '@asf/shared';
import type { Role } from '@asf/shared';
import { startReadiness, pickRepo, type RepoBlocker } from '../start-readiness.js';
import { resolveRoleModels, applyRoleSkills, defaultRoleModels, catalogue, BadModelError, BadEffortError, type OrgRoleModels, type OrgRoleEfforts, type OrgRoleRuntimes } from '../models.js';

/** A dispatch that a caller can act on: `ok` runs are created; the rest carry a machine reason. */
type DispatchFailure = RepoBlocker | 'not_found' | 'ticket_done' | 'bad_model' | 'bad_effort' | 'cost_cap' | 'over_budget' | 'gate_policy' | 'pipeline_config' | 'run_conflict' | 'no_worker_for_runtime' | 'bad_review_target';
export type DispatchResult =
  | { ok: true; runId: string; run: RunWithTasks }
  | { ok: false; code: DispatchFailure; reason: string; existingRunId?: string; link?: string };

export interface DispatchInput {
  ticketId: string;
  repoId?: string | null;
  teamName?: string | null;      // one seeded team in M3; kept for the queue's per-entry field
  maxCostUsd?: number | null;
  by?: string | null;
  gateOverrides?: Record<string, GateConfig>;
  modelOverrides?: Partial<Record<Role, string>>;  // per-role model for this run; unknown ids are refused
  effortOverrides?: Partial<Record<Role, string>>; // per-role reasoning effort for this run; unknown levels are refused
  runtimeOverrides?: Partial<Record<Role, string>>; // per-role runtime for this run; the model must list it and a live worker must offer it
  skillOverrides?: Partial<Record<Role, string>>;  // per-role extra guidance for THIS run, appended after the org ROLE_SKILL_<ROLE> blob
  skipRoles?: Role[];  // roles switched off for THIS run only, on top of the org's disabled stages
  reviewOf?: string;   // "review <PR/MR URL>": a review-only run of that change request instead of writing one
}

type ReviewTarget = NonNullable<TeamTemplate['reviewTarget']>;

/**
 * The repository and change request a review-only run reviews, from the text that
 * names it. The PR's own repository is the run's repository (no pickRepo). The
 * ref the worker fetches follows the URL's shape: GitLab's `/-/merge_requests/`,
 * otherwise GitHub's `refs/pull/N/head` (the mock too).
 */
async function resolveReviewTarget(scm: ScmProvider, text: string): Promise<{ ok: true; repo: Repo; target: ReviewTarget } | { ok: false; reason: string }> {
  const parsed = parseReviewRequest(text);
  if (!parsed) return { ok: false, reason: 'a review-only run needs the word "review" and a GitHub pull request or GitLab merge request URL.' };
  const repo = await scm.getRepo(parsed.repoPath).catch(() => null);
  if (!repo) return { ok: false, reason: `source control can't reach the repository ${parsed.repoPath} for ${parsed.url}.` };
  const cr = await scm.getChangeRequest(repo, parsed.number).catch(() => null);
  if (!cr) return { ok: false, reason: `source control can't find change request #${parsed.number} in ${parsed.repoPath} (${parsed.url}).` };
  const fetchRef = parsed.url.includes('/-/merge_requests/') ? `refs/merge-requests/${parsed.number}/head` : `refs/pull/${parsed.number}/head`;
  return { ok: true, repo, target: { url: parsed.url, number: parsed.number, headBranch: cr.headBranch, baseBranch: cr.baseBranch, fetchRef } };
}

/** The org-tier per-role model defaults (MODEL_DEFAULT_<ROLE>), resolved env > org > default. */
function orgRoleModels(): OrgRoleModels {
  // Only values someone actually SET (env or org). An unset MODEL_DEFAULT_<ROLE> is
  // left to the team template, which may substitute an allowed model when
  // MODEL_ALLOWLIST hides it; the setting's default equals the template anyway.
  const set = (k: 'MODEL_DEFAULT_PLANNER' | 'MODEL_DEFAULT_IMPLEMENTER' | 'MODEL_DEFAULT_TESTER' | 'MODEL_DEFAULT_REVIEWER') =>
    (process.env[k] ?? '') !== '' || (orgValues()[k] !== undefined && orgValues()[k] !== null) ? cfg(k) : undefined;
  return {
    planner: set('MODEL_DEFAULT_PLANNER'), implementer: set('MODEL_DEFAULT_IMPLEMENTER'),
    tester: set('MODEL_DEFAULT_TESTER'), reviewer: set('MODEL_DEFAULT_REVIEWER'),
  };
}

/** The org-tier per-role effort defaults (EFFORT_DEFAULT_<ROLE>), resolved env > org > default. */
function orgRoleEfforts(): OrgRoleEfforts {
  return {
    planner: cfg('EFFORT_DEFAULT_PLANNER'), implementer: cfg('EFFORT_DEFAULT_IMPLEMENTER'),
    tester: cfg('EFFORT_DEFAULT_TESTER'), reviewer: cfg('EFFORT_DEFAULT_REVIEWER'),
  };
}

/** The org-tier per-role runtime defaults (RUNTIME_DEFAULT_<ROLE>), resolved env > org > default. */
function orgRoleRuntimes(): OrgRoleRuntimes {
  return {
    planner: cfg('RUNTIME_DEFAULT_PLANNER'), implementer: cfg('RUNTIME_DEFAULT_IMPLEMENTER'),
    tester: cfg('RUNTIME_DEFAULT_TESTER'), reviewer: cfg('RUNTIME_DEFAULT_REVIEWER'),
  };
}

/**
 * The runtimes the live fleet offers, or null when there is no live worker (or
 * the registry can't say). Null means "don't filter, don't refuse": a dispatch
 * with no worker up still queues and waits for one, as it always has.
 */
async function fleetRuntimes(): Promise<Set<string> | null> {
  const fleet = await registry.listFleet().catch(() => null);
  const workers = fleet?.workers ?? [];
  if (workers.length === 0) return null;
  return new Set(workers.flatMap((w) => w.runtimes));
}

/**
 * Turn a ticket into a run. The single place dispatch policy lives — cost caps,
 * gate resolution (before_merge can only be relaxed at the org tier via the
 * /pipeline merge-stage gate, never a request override), the run-conflict guard, and the ticket-side side effects
 * (comment, →In Progress, assign). Both the HTTP route and the queue scheduler
 * call this, so a queued run and a hand-dispatched run are identical.
 */
export async function dispatchTicket(given: { tickets: TicketProvider; scm: ScmProvider }, input: DispatchInput): Promise<DispatchResult> {
  // An ad-hoc task (#179) is served by its own provider; everything below is unchanged.
  const deps = { ...given, tickets: ticketsFor(given.tickets, input.ticketId) };
  const ticket = await deps.tickets.get(input.ticketId).catch(() => null);
  if (!ticket) return { ok: false, code: 'not_found', reason: `no ticket ${input.ticketId}` };
  // A done ticket has nothing to work on; refuse rather than spin up a run against completed work.
  if (ticket.bucket === 'done') return { ok: false, code: 'ticket_done', reason: `ticket ${ticket.key} is already done; re-open it to dispatch.` };
  // Nowhere to put code, nothing to start: a run is always bound to one reachable repository.
  const ready = await startReadiness(deps.scm);
  if (!ready.ok) return { ok: false, code: ready.code, reason: ready.reason, link: ready.link };
  // A review-only run works in the PR's own repository; anything else picks one.
  let repo: Repo;
  let reviewTarget: ReviewTarget | null = null;
  if (input.reviewOf != null) {
    const review = await resolveReviewTarget(deps.scm, input.reviewOf);
    if (!review.ok) return { ok: false, code: 'bad_review_target', reason: review.reason };
    repo = review.repo;
    reviewTarget = review.target;
  } else {
    const picked = await pickRepo(deps, ticket, ready.repos, input.repoId);
    if (!picked.ok) return { ok: false, code: picked.code, reason: picked.reason, link: picked.link };
    repo = picked.repo;
  }
  // Which model each role runs with: dispatch override > org default > template. Refused
  // before any cost check so a typo never creates a run.
  let team: typeof STANDARD_TEAM;
  try {
    team = resolveRoleModels(STANDARD_TEAM, orgRoleModels(), input.modelOverrides, orgRoleEfforts(), input.effortOverrides, { org: orgRoleRuntimes(), request: input.runtimeOverrides });
  } catch (e) {
    if (e instanceof BadModelError) return { ok: false, code: 'bad_model', reason: e.message };
    if (e instanceof BadEffortError) return { ok: false, code: 'bad_effort', reason: e.message };
    throw e;
  }

  const requestedCost = input.maxCostUsd ?? team.maxCostUsd;
  const maxCost = cfg('ORG_MAX_COST_USD');
  if (requestedCost > maxCost) {
    return { ok: false, code: 'cost_cap', reason: `maxCostUsd ${requestedCost} exceeds the org limit ORG_MAX_COST_USD=${maxCost}.` };
  }
  const monthlyBudget = cfg('ORG_MONTHLY_BUDGET_USD');
  if (monthlyBudget > 0) {
    const { totalUsd } = await registry.monthCost().catch(() => ({ totalUsd: 0 }));
    if (totalUsd >= monthlyBudget) {
      return { ok: false, code: 'over_budget', reason: `this month's run cost $${totalUsd.toFixed(2)} has reached ORG_MONTHLY_BUDGET_USD=$${monthlyBudget}. Raise the budget in /admin or wait for the next month.` };
    }
  }

  const orgStages = cfg('PIPELINE_STAGES') as Record<string, { enabled?: boolean; gate?: string }>;
  let gates: Record<string, GateConfig>;
  try {
    // Fold the per-stage config (which stages run + each stage's gate) onto the
    // team+gates the orchestrator consumes: disabled role-stages are dropped,
    // merge on/off is set, gate modes are applied. The merge stage gate
    // (before_merge) can be relaxed here (org tier, via /pipeline) but never by a
    // dispatch (resolveGates enforces it).
    // A dispatch may switch more roles off for this run (never back on).
    // A review-only run runs the reviewer alone and publishes nothing.
    const stages = reviewTarget ? reviewOnlyStages(orgStages)
      : input.skipRoles?.length ? skipRoles(orgStages, input.skipRoles) : orgStages;
    const resolved = resolvePipeline(team, stages, { request: input.gateOverrides });
    // No implementer to loop back to: REQUEST_CHANGES is the review's answer, not a retry.
    team = reviewTarget ? { ...resolved.team, loop: null, reviewTarget } : resolved.team;
    gates = resolved.gates;
  } catch (e) {
    if (e instanceof GatePolicyError) return { ok: false, code: 'gate_policy', reason: e.message };
    if (e instanceof PipelineConfigError) return { ok: false, code: 'pipeline_config', reason: e.message };
    throw e;
  }

  // Every role that will run needs a live worker offering its runtime; refuse rather than
  // queue a task no worker can claim. With no live worker at all, keep today's behaviour.
  const offered = await fleetRuntimes();
  if (offered) {
    const stranded = team.roles.find((r) => !offered.has(r.runtime));
    if (stranded) return { ok: false, code: 'no_worker_for_runtime', reason: `no live worker offers runtime "${stranded.runtime}" for ${stranded.role}; the fleet offers ${[...offered].join(', ') || 'none'}.` };
  }

  // Per-dispatch extra role guidance, folded onto the (possibly stage-trimmed) team so it
  // is persisted on the run and the worker appends it after the org ROLE_SKILL_<ROLE> blob.
  team = applyRoleSkills(team, input.skillOverrides);

  try {
    const created = await registry.createRun({
      ticketId: ticket.id, ticketKey: ticket.key, ticketProvider: deps.tickets.kind,
      team, gates, repoId: repo.id, maxCostUsd: requestedCost, dispatchedBy: input.by ?? null,
    });
    await deps.tickets.comment(ticket.id, `Agentic Software Factory: run ${created.run.id} started (team ${team.name}).`).catch(() => {});
    await transitionTicketTo(deps.tickets, ticket.id, parsePreferredStatuses(cfg('TICKET_STATUS_INPROGRESS')));
    await assignTicketTo(deps.tickets, ticket.id, cfg('TICKET_ASSIGNEE'));
    return { ok: true, runId: created.run.id, run: created };
  } catch (e) {
    if (e instanceof RunConflict) return { ok: false, code: 'run_conflict', reason: e.message, existingRunId: e.existingRunId };
    throw e;
  }
}

const HTTP_STATUS: Record<DispatchFailure, number> = {
  scm_not_connected: 409, no_repos: 409, repo_not_found: 400, repo_ambiguous: 400,
  not_found: 404, ticket_done: 409, bad_model: 400, bad_effort: 400, cost_cap: 400, over_budget: 400, gate_policy: 400, pipeline_config: 400, run_conflict: 409, no_worker_for_runtime: 400, bad_review_target: 400,
};

/**
 * Dispatch: turn a ticket into a run. Refuses rather than guessing — a repo
 * must be bound, and the gate policy is enforced (before_merge cannot be
 * relaxed by a dispatch). The preview (GET) tells the UI what will happen and
 * why the button might be disabled; the POST does it.
 */
export function registerDispatchRoutes(app: FastifyInstance, deps: { tickets: TicketProvider; scm: ScmProvider }): void {
  // Can work start at all? The Backlog asks once so its Start buttons are off (with the
  // reason and where to fix it) until a repository is connected.
  app.get('/api/start-readiness', async () => {
    const ready = await startReadiness(deps.scm);
    return ready.ok ? { ok: true, repos: ready.repos.map((r) => ({ id: r.id, path: r.path })) } : ready;
  });

  app.get<{ Params: { id: string } }>('/api/tickets/:id/dispatch', async (req, reply) => {
    const tickets = ticketsFor(deps.tickets, req.params.id);
    const ticket = await tickets.get(req.params.id).catch(() => null);
    if (!ticket) return reply.code(404).send({ error: 'not_found' });
    // Can anything start at all? Without a reachable repository the Start button stays off
    // and says why (with a link to fix it), the same check the POST enforces.
    const ready = await startReadiness(deps.scm);
    const repos = ready.ok ? ready.repos : [];
    const blocker = ready.ok ? null : { code: ready.code, reason: ready.reason, link: ready.link };
    const whyNot: string[] = [];
    if (blocker) whyNot.push(blocker.reason);
    if (ticket.bucket === 'done') whyNot.push('This ticket is already done. Re-open it to dispatch.');

    let suggestedRepoId: string | null = null;
    const wanted = tickets.suggestedRepo?.(ticket) ?? null;
    if (wanted) {
      const match = repos.find((r) => r.path === wanted || r.id === wanted);
      if (match) suggestedRepoId = match.id;
      else suggestedRepoId = await deps.scm.getRepo(wanted).then((r) => r.id).catch(() => null);
    }

    // The merged catalogue, narrowed to what the live fleet can run (all of it when no worker is up).
    const offered = await fleetRuntimes();
    const models = catalogue().models.filter((m) => !offered || m.runtimes.some((r) => offered.has(r)));
    let defaults: ReturnType<typeof defaultRoleModels>;
    try {
      defaults = defaultRoleModels(STANDARD_TEAM, orgRoleModels(), orgRoleEfforts(), { org: orgRoleRuntimes() });
    } catch (e) {
      // A MODEL_DEFAULT_<ROLE> that no longer fits the catalogue: say why, pre-select the template.
      if (!(e instanceof BadModelError || e instanceof BadEffortError)) throw e;
      whyNot.push(e.message);
      try {
        defaults = defaultRoleModels(STANDARD_TEAM, {}, {});
      } catch (e2) {
        // Even the template can't run under this MODEL_ALLOWLIST: no pre-selection; whyNot says why.
        if (!(e2 instanceof BadModelError)) throw e2;
        if (e2.message !== e.message) whyNot.push(e2.message);
        defaults = { models: {}, efforts: {}, runtimes: {} };
      }
    }

    return {
      ticket: { id: ticket.id, key: ticket.key, title: ticket.title },
      team: STANDARD_TEAM,
      gates: STANDARD_TEAM.gates,
      repos: repos.map((r) => ({ id: r.id, path: r.path })),
      suggestedRepoId,
      whyNot,
      blocker,
      // What the modal pre-selects per role, and what it may switch each role to.
      models,
      runtimes: offered ? [...offered] : [],
      efforts: EFFORT_LEVELS,
      // The org-tier standing skill per role (ROLE_SKILL_<ROLE>), so the modal can show what
      // guidance each role already carries; a dispatch adds per-run text on top (skillOverrides).
      orgRoleSkills: computeRoleSkills(),
      defaultModels: defaults.models, defaultEfforts: defaults.efforts, defaultRuntimes: defaults.runtimes,
      // Roles the org switched off for every run: the page shows them off and locked.
      orgDisabledRoles: disabledRoles(cfg('PIPELINE_STAGES') as Record<string, { enabled?: boolean; gate?: string }>),
    };
  });

  app.post<{ Params: { id: string }; Body: { repoId?: string; teamName?: string; maxCostUsd?: number; by?: string; gateOverrides?: Record<string, GateConfig>; modelOverrides?: Partial<Record<Role, string>>; effortOverrides?: Partial<Record<Role, string>>; runtimeOverrides?: Partial<Record<Role, string>>; skillOverrides?: Partial<Record<Role, string>>; skipRoles?: Role[]; reviewOf?: string } }>(
    '/api/tickets/:id/dispatch', async (req, reply) => {
      const body = req.body ?? {};
      const by = body.by ?? resolveIdentity(req).user;
      const result = await dispatchTicket(deps, {
        ticketId: req.params.id, repoId: body.repoId, teamName: body.teamName,
        maxCostUsd: body.maxCostUsd, by, gateOverrides: body.gateOverrides, modelOverrides: body.modelOverrides, effortOverrides: body.effortOverrides, runtimeOverrides: body.runtimeOverrides, skillOverrides: body.skillOverrides, skipRoles: body.skipRoles, reviewOf: body.reviewOf,
      });
      if (result.ok) {
        return reply.code(201).send(result.run);
      }
      const status = HTTP_STATUS[result.code];
      return reply.code(status).send({ error: result.code, reason: result.reason, existingRunId: result.existingRunId, link: result.link });
    });
}
