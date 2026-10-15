import type { FastifyInstance } from 'fastify';
import { registry } from '../registry/client.js';
import { describe, cfg } from '../settings.js';
import { detectTeamAi, subscriptionSharingWarning } from '@asf/shared';
import { describeAgentAuth } from '../agent-auth.js';
import { resolveIdentity } from '../identity.js';
import { providerPreflights, resetPreflightCache, type Pf } from '../provider-preflights.js';
import type { TicketProviderRegistry } from '../providers/tickets/registry.js';
import type { ScmProviderRegistry } from '../providers/scm/registry.js';

/**
 * The first-run checklist (#83). One aggregated read the /setup view polls to
 * guide the operator through post-`setup.sh` steps until the first run succeeds:
 * pick a real work tracker + SCM, wire agent auth, get a worker online, and
 * dispatch a run. Every item is a link to the panel that resolves it — no
 * auto-fix here, just "what's left and where to do it".
 *
 * Identity-gated like the admin surface (same trusted browser bind in the MVP).
 * The two provider preflights hit Jira/GitLab/GitHub, so they are cached ~30s
 * (provider-preflights.ts) — a 10s poll must not hammer the trackers.
 */

/** One checklist row. `done` drives the ✓/○; `optional` items never block completion. */
export interface SetupItem {
  id: string;
  title: string;
  done: boolean;
  /** Optional items are informational and do not gate the "all set" state. */
  optional?: boolean;
  /** One-line explanation of the current state (what's set, or what's missing). */
  reason?: string;
  /** The resolved provider identity, when the item connected successfully. */
  identity?: string;
  /** A problem that doesn't block setup but should be fixed (shown as ⚠ in the UI and `asf doctor`). */
  warning?: string;
  /** True when a non-empty env var pins the underlying key, so the UI can't change it. */
  envPinned?: boolean;
  /** Deep link to the panel that resolves this item. */
  link: string;
  /**
   * Why a CONFIGURED item is failing (not merely unconfigured): 'credential-rejected'
   * = the service refused the saved token; 'connection-failed' = any other failed
   * check. Lets the setup notice name the actual problem.
   */
  problem?: 'credential-rejected' | 'connection-failed';
}

export interface SetupStatus {
  items: SetupItem[];
  /** True once every non-optional item is done — the /setup view stops being the default. */
  complete: boolean;
}

/** Test hook: drop the module-level preflight cache so each test starts cold. */
export function __resetSetupCaches(): void { resetPreflightCache(); }

/** A provider row (work tracker / source control): done = a real provider whose live preflight passes. */
function providerItem(opts: {
  id: string; title: string; key: 'TICKET_PROVIDER' | 'SCM_PROVIDER'; kind: string; pf: Pf; envPinned: boolean; link: string; mockNote: string;
}): SetupItem {
  const { id, title, key, kind, pf, envPinned, link, mockNote } = opts;
  const isMock = kind === 'mock';
  const done = !isMock && pf.ok;
  let reason: string;
  if (done) reason = pf.identity ? `Connected as ${pf.identity}` : 'Connected';
  else if (envPinned && isMock) reason = `Pinned to mock by the environment — unset ${key} in the deployment and restart to choose a real provider in Settings.`;
  else if (isMock) reason = mockNote;
  else reason = pf.reason ?? 'Connection test failed — check the details in Settings.';
  const problem = !isMock && !pf.ok ? (pf.credentialRejected ? 'credential-rejected' as const : 'connection-failed' as const) : undefined;
  return { id, title, done, reason, identity: done ? pf.identity : undefined, envPinned, link, ...(problem ? { problem } : {}) };
}

export function registerSetupRoutes(app: FastifyInstance, deps: { tickets: TicketProviderRegistry; scm: ScmProviderRegistry }): void {
  app.get('/api/setup/status', async (req): Promise<SetupStatus> => {
    resolveIdentity(req); // identity-gated like the admin surface

    const views = describe();
    const pinned = (key: string) => views.find((v) => v.key === key)?.envPinned ?? false;

    const [{ ticket, scm }, auth, fleet, succeeded] = await Promise.all([
      providerPreflights(deps),
      describeAgentAuth(),
      registry.listFleet().catch(() => ({ workers: [], capacity: 0, running: 0 })),
      registry.listRuns({ state: 'succeeded', limit: 1 }).catch(() => ({ runs: [], total: 0 })),
    ]);

    const items: SetupItem[] = [];

    // 1 — work tracker
    items.push(providerItem({
      id: 'ticket', title: 'Connect a work tracker', key: 'TICKET_PROVIDER',
      kind: cfg('TICKET_PROVIDER') as string, pf: ticket, envPinned: pinned('TICKET_PROVIDER'), link: '/settings#tickets',
      mockNote: 'Using sample tickets. Pick your real work tracker (Jira, GitHub, …) in Settings.',
    }));

    // 2 — source control
    items.push(providerItem({
      id: 'scm', title: 'Connect source control', key: 'SCM_PROVIDER',
      kind: cfg('SCM_PROVIDER') as string, pf: scm, envPinned: pinned('SCM_PROVIDER'), link: '/settings#code',
      mockNote: 'No repository connected, so nothing can start yet. Pick GitHub or GitLab in Settings and name the repository the work goes into.',
    }));

    // 3 — agent authentication for the AI the team runs on (#162): Claude (anthropic)
    // or ChatGPT/OpenAI (Codex). A credential the current mode can resolve.
    const teamAi = detectTeamAi(cfg as never);
    const aiAuth = teamAi === 'openai' ? auth.providers.openai : auth;
    const aiName = teamAi === 'openai' ? 'OpenAI' : 'Claude';
    items.push({
      id: 'agent-auth', title: 'Connect your AI',
      done: aiAuth.credentialPresent,
      reason: aiAuth.credentialPresent
        ? `Ready (${aiName}, ${aiAuth.mode === 'vertex' ? `Google Cloud project ${aiAuth.vertex?.projectId ?? ''}` : aiAuth.mode})`
        : aiAuth.mode === 'vertex' && teamAi !== 'openai'
          ? 'Claude on Google Cloud is chosen but no project is set. Finish it in Settings → Which AI should do the work?'
        : aiAuth.error
          ? `Your saved ${aiName} credential can't be read: ${aiAuth.error}`
          : `No ${aiName} ${teamAi === 'openai' ? 'API key' : 'credential'} saved yet. Add one in Settings → Which AI should do the work?`,
      envPinned: teamAi === 'openai' ? pinned('OPENAI_API_KEY') : pinned('AGENT_AUTH_MODE'),
      // One Claude subscription serving several proxy-authenticated operators is outside
      // Anthropic's terms (docs/CLAUDE_USAGE.md): flag it, never block on it.
      warning: (teamAi === 'openai' ? null : subscriptionSharingWarning(auth.mode, cfg('AUTH_MODE'))) ?? undefined,
      link: '/settings#ai',
    });

    // 4 — a worker online that offers the team's AI. Claude workers are matched on
    // their registered auth mode (as before); for OpenAI, on offering the codex runtime,
    // which a worker does only once its OpenAI preflight passed (#163).
    // A worker still registered but whose Claude check now fails (M9 #2: its Google login
    // expired) takes no tasks: it is not "ready", and its own reason says why.
    // M11 WP4: a runtime has one status per provider it can serve; only the team AI's counts here.
    const teamProvider = teamAi === 'openai' ? 'openai' : 'anthropic';
    const statusDown = (w: (typeof fleet.workers)[number], kind: string) => (w.preflight ?? []).find((s) => s.kind === kind && (!s.provider || s.provider === teamProvider) && !s.ok);
    const claudeDown = (w: (typeof fleet.workers)[number]) => statusDown(w, 'claude-code');
    const matching = teamAi === 'openai'
      ? fleet.workers.find((w) => (w.runtimes ?? []).includes('codex') && !statusDown(w, 'codex'))
      : fleet.workers.find((w) => w.authMode === auth.mode && !claudeDown(w));
    const down = teamAi === 'openai' ? undefined : fleet.workers.find((w) => w.authMode === auth.mode && claudeDown(w));
    let workerReason: string;
    if (matching) workerReason = `Worker online (${matching.id}), ready to run ${aiName}.`;
    else if (down) workerReason = `Worker ${down.id} is connected but can't run ${aiName} right now: ${claudeDown(down)!.reason ?? 'its check failed'}`;
    else if (fleet.workers.length > 0) {
      workerReason = teamAi === 'openai'
        ? `A worker is connected but can't use OpenAI yet (it offers ${[...new Set(fleet.workers.flatMap((w) => w.runtimes ?? []))].join(', ') || 'nothing'}). Use “Save and check it works” in Settings → Which AI should do the work? to see why; once the key works, the worker picks it up within a minute.`
        : `A worker is connected but authenticating as ${[...new Set(fleet.workers.map((w) => w.authMode ?? 'unknown'))].join(', ')}, not ${auth.mode} — check agent auth.`;
    } else workerReason = 'No worker connected yet — start one and it will register here.';

    items.push({
      id: 'worker', title: 'Bring a worker online', done: Boolean(matching), reason: workerReason, link: '/workers',
    });

    // 5 — review the pipeline & gates (optional; the web auto-✓s this once the approvals
    // question is saved or a run is dispatched, via a localStorage flag).
    items.push({
      id: 'pipeline', title: 'Review your pipeline & gates', done: false, optional: true,
      reason: 'Optional — choose when the AI stops and checks with you before you start any work.',
      link: '/settings#approvals',
    });

    // 6 — the first successful run
    const firstRunDone = succeeded.runs.length > 0;
    items.push({
      id: 'first-run', title: 'Finish your first ticket', done: firstRunDone,
      reason: firstRunDone ? 'Your first ticket is done 🎉' : 'Pick a ticket in Things to do, press Start, and let it finish.',
      link: firstRunDone ? '/' : '/backlog',
    });

    const complete = items.filter((i) => !i.optional).every((i) => i.done);
    return { items, complete };
  });
}
