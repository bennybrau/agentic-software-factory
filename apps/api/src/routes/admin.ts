import type { FastifyInstance } from 'fastify';
import { SettingError, connectionKind } from '@asf/shared';
import { registry } from '../registry/client.js';
import { cfg, describe, putSetting, deleteSetting } from '../settings.js';
import { resolveIdentity } from '../identity.js';
import { checkCredentials, forgetCredentialHealth, lastCredentialHealth, withHealth } from '../credential-health.js';
import { onePreflight, resetPreflightCache, type PreflightDeps, type Side } from '../provider-preflights.js';
import { checkOpenAiKey } from '../openai-check.js';
import { catalogue } from '../models.js';
import type { TicketSet } from '../providers/tickets/set.js';
import type { ScmSet } from '../providers/scm/set.js';

type Sets = {
  ticketSet: Pick<TicketSet, 'connections' | 'defaultConnection' | 'registryFor' | 'invalidate'>;
  scmSet: Pick<ScmSet, 'connections' | 'defaultConnection' | 'registryFor' | 'invalidate'>;
};

/**
 * The /admin surface (WP 7.4) and identity (WP 7.3). Org-tier settings (team,
 * gate policy, cost caps), the fleet panel, and who-am-I. Read+write are trusted
 * on the api's bind in the single-operator MVP, same as the other browser routes;
 * a real deployment puts a proxy in front (AUTH_MODE=header).
 *
 * Also owns the white-label provider surface: after any settings write BOTH the
 * ticket- and SCM-provider registries are invalidated so the next request
 * rebuilds from the new config (hot-swap, no restart), and
 * GET /api/providers/{ticket,scm}/preflight?connection= power the "Test
 * connection" buttons (the default connection when none is named).
 */
export function registerAdminRoutes(app: FastifyInstance, sets: Sets): void {
  const deps: PreflightDeps = { tickets: sets.ticketSet, scm: sets.scmSet };
  // Who is the caller — the web drops its hardcoded 'operator' in favour of this.
  app.get('/api/me', async (req) => resolveIdentity(req));

  // The whole catalogue with current values (secrets redacted) for the /admin UI, plus
  // credential health (#139). A health check that cannot run never blocks Settings.
  app.get('/api/settings', async (req) => {
    const health = await checkCredentials(deps).catch((e) => { req.log.warn({ err: (e as Error).message }, 'credential check failed'); return lastCredentialHealth(); });
    return { settings: withHealth(describe(), health) };
  });

  // Set one org-tier setting. Refuses deploy-time keys and bad values with a reason.
  app.put<{ Params: { key: string }; Body: { value: unknown } }>('/api/settings/:key', async (req, reply) => {
    const by = resolveIdentity(req).user;
    try {
      await putSetting(req.params.key, (req.body ?? {}).value, by);
    } catch (e) {
      if (e instanceof SettingError) return reply.code(400).send({ error: 'setting_error', reason: e.message });
      throw e;
    }
    sets.ticketSet.invalidate(); sets.scmSet.invalidate(); // a provider-config change takes effect on the next request
    resetPreflightCache(); forgetCredentialHealth(req.params.key); // and is re-checked on the next Settings load
    return { ok: true, settings: withHealth(describe(), lastCredentialHealth()) };
  });

  // Clear an org-tier setting (revert to env/default).
  app.delete<{ Params: { key: string } }>('/api/settings/:key', async (req) => {
    await deleteSetting(req.params.key);
    sets.ticketSet.invalidate(); sets.scmSet.invalidate();
    resetPreflightCache(); forgetCredentialHealth(req.params.key);
    return { ok: true, settings: withHealth(describe(), lastCredentialHealth()) };
  });

  // Test one connection live (?connection=, else the default). A failing preflight,
  // or a connection that is not set up, is a report (200 with ok:false + reason),
  // not a 500 — the UI shows the reason.
  const preflight = async (side: Side, set: Sets['ticketSet'] | Sets['scmSet'], asked?: string) => {
    const connection = asked || set.defaultConnection;
    if (!set.connections.includes(connection)) {
      return { connection, ok: false as const, reason: `"${connection}" is not one of the connections in use (${set.connections.join(', ')}).` };
    }
    return { connection, kind: connectionKind(connection), ...await onePreflight(deps, side, connection) };
  };
  app.get<{ Querystring: { connection?: string } }>('/api/providers/ticket/preflight', async (req) => preflight('tickets', sets.ticketSet, req.query.connection));
  app.get<{ Querystring: { connection?: string } }>('/api/providers/scm/preflight', async (req) => preflight('scm', sets.scmSet, req.query.connection));

  // The models this factory can run: the built-ins merged with MODEL_CATALOG_EXTRA and
  // narrowed to MODEL_ALLOWLIST. The Settings model pickers read this, not the built-in
  // list, so a Vertex/Bedrock org only sees the ids enabled on its cloud project.
  app.get('/api/models', async () => {
    return { models: catalogue().models };
  });

  // "Save and check it works" for the OpenAI key (#162): one tiny real request, a plain answer.
  app.get('/api/providers/openai/check', async () => checkOpenAiKey());

  // The fleet: live workers, their runtimes + agent auth mode, capacity, and
  // this month's summed run cost — the "why is my run queued / what will it cost" panel —
  // and how many of this month's runs that sum cannot include (unpriced, M8 WP H).
  app.get('/api/fleet', async () => {
    const [fleet, month, unpriced] = await Promise.all([registry.listFleet(), registry.monthCost(),
      registry.monthUnpricedRuns().catch(() => ({ count: 0 }))]);
    return { ...fleet, monthCostUsd: month.totalUsd, monthUnpricedRuns: unpriced.count, monthlyBudgetUsd: cfg('ORG_MONTHLY_BUDGET_USD') };
  });
}
