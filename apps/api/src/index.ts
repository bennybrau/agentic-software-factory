/**
 * apps/api — the only process that holds a ticketing or SCM credential.
 *
 * Owns: TicketProvider, ScmProvider, NotificationSink instances; the routes the
 * web UI calls; the run-context and hook-event routes the worker calls. Never
 * opens a database connection — run state lives in the registry, reached over
 * HTTP through registry/client.ts.
 */
import './boot-secrets.js';
import Fastify from 'fastify';
import { config } from './config.js';
import { ticketSet } from './providers/tickets/index.js';
import { scmSet } from './providers/scm/index.js';
import { registry } from './registry/client.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerScmRoutes } from './routes/scm.js';
import { registerDispatchRoutes } from './routes/dispatch.js';
import { registerQueueRoutes } from './routes/queue.js';
import { startScheduler } from './scheduler.js';
import { startMergeWatch } from './merge-watcher.js';
import { startHiveHook } from './hive.js';
import { startNotifier } from './notifications/sinks.js';
import { startCredentialChecks } from './credential-health.js';
import { registerBrowserRoutes } from './routes/browser.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerVertexRoutes } from './routes/vertex.js';
import { registerOllamaRoutes } from './routes/ollama.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerWorkerRoutes } from './routes/workers.js';
import { cfg, loadOrgSettings, loadOrgSettingsWithRetry } from './settings.js';
import { healthBody } from './provider-preflights.js';
import { assertIdentityConfig } from './identity.js';
import { registerAdhocRoutes } from './routes/adhoc.js';
import { registerTicketRoutes } from './routes/tickets.js';
import { registerAvatarRoutes } from './routes/avatars.js';
import { registerThemeRoutes } from './routes/themes.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerRecurringRoutes } from './routes/recurring.js';
import { registerUpdateRoutes } from './routes/updates.js';
import { startUpdateChecks } from './updates.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

// Fail fast on an unsafe identity config (header mode on a public bind).
assertIdentityConfig();

// M12 WP1: qualify stored repo ids with the configured code host. Only once the
// org tier is loaded, so it never runs with the default `mock`. A refusal is
// logged and the api keeps booting: nothing reads the qualified form yet.
function qualifyStoredRefs(): void {
  registry.qualifyStoredRefs(scmSet.defaultConnection, String(cfg('TICKET_PROVIDER'))).then(
    (counts) => app.log.info({ counts }, 'stored refs qualified'),
    (err: Error) => app.log.warn({ err: err.message }, 'stored refs not qualified'),
  );
}

// Load org-tier settings from the registry before serving. At boot the registry
// may not be listening yet (compose starts them together); a failed one-shot load
// would leave the api serving env+defaults with an EMPTY org tier — providers,
// gates and the agent credential all silently absent, and the worker crash-looping
// on "no credential". So: try once and start serving immediately (a registry that
// is down must not take the api down), but keep retrying in the background until
// the org tier is loaded; each attempt is logged.
try { await loadOrgSettings(); app.log.info('org settings loaded'); qualifyStoredRefs(); }
catch (e) {
  app.log.warn({ err: (e as Error).message }, 'org settings not loaded yet; serving env + defaults and retrying');
  void loadOrgSettingsWithRetry({
    onRetry: (attempt, err, nextDelayMs) => app.log.warn({ attempt, err: err.message, nextDelayMs }, 'org settings load failed; will retry'),
  }).then(() => {
    // The provider registries were built from the empty org tier (mock/mock);
    // invalidate so the next request rebuilds them from the real config — same
    // as a settings write does.
    ticketSet.invalidate(); scmSet.invalidate();
    app.log.info('org settings loaded (after retry); providers reloaded');
    qualifyStoredRefs();
  });
}

// The ticket AND SCM providers are hot-swappable (white-label WP A/B): routes and
// the scheduler get the registries' live proxies, which always forward to the
// currently-configured provider. A settings write in the /providers UI invalidates
// both registries so the next request rebuilds — no restart. Both are wrapped so
// ticket and repository ids leave the api qualified with their connection (M12).
// `tickets` routes each ticket to its own tracker (M12 WP3) and `scm` each
// repository to its own code host (M12 WP2).
const tickets = ticketSet.live;
const scm = scmSet.live;
// Admin, setup, credential checks and /health check every tracker and code host (M12 WP4).
const preflightSets = { tickets: ticketSet, scm: scmSet };

// Never waits on a tracker: each connection's last preflight, refreshed in the background.
app.get('/health', async () => healthBody(preflightSets));

registerTicketRoutes(app, { set: ticketSet });
registerRunRoutes(app, { tickets, scm });
registerScmRoutes(app, { scm, tickets });
registerDispatchRoutes(app, { tickets, scm });
registerQueueRoutes(app, { tickets, scm });
registerBrowserRoutes(app, { tickets, scm });
registerAdminRoutes(app, { ticketSet, scmSet });
registerSetupRoutes(app, preflightSets);
registerVertexRoutes(app);
registerOllamaRoutes(app);
registerWorkerRoutes(app);
registerAdhocRoutes(app);
registerAvatarRoutes(app);
registerThemeRoutes(app);
registerSkillRoutes(app);
registerRecurringRoutes(app, { scm });
registerUpdateRoutes(app);

// Serve the built web bundle when WEB_DIST is set (self-host / cloud). In `pnpm dev`
// Vite serves it and proxies /api here instead.
if (config.webDist) {
  const { default: fastifyStatic } = await import('@fastify/static');
  const { resolve: resolvePath } = await import('node:path');
  await app.register(fastifyStatic, { root: resolvePath(config.webDist), prefix: '/', wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
    return reply.sendFile('index.html'); // SPA fallback for client-side (BrowserRouter) routes
  });
  app.log.info({ webDist: config.webDist }, 'serving web bundle');
}

// Both provider preflights are ADVISORY now (white-label WP B): a box may boot
// with the SCM (or ticket) provider unconfigured and be configured later in the
// UI, so a failing preflight is logged, not fatal. The /providers "Test
// connection" buttons (registerAdminRoutes) are how the operator confirms each
// live. Wrapped in try/catch because an unconfigured provider's build can throw.
for (const connection of scmSet.connections) {
  try {
    const pf = await (await scmSet.registryFor(connection).current()).preflight();
    if (pf.ok) app.log.info({ provider: connection, identity: pf.identity }, 'SCM preflight ok');
    else app.log.warn({ provider: connection, reason: pf.reason }, 'SCM preflight failed — configure the provider in the UI (/providers)');
  } catch (e) {
    app.log.warn({ provider: connection, err: (e as Error).message }, 'SCM preflight threw — provider likely unconfigured; configure it in the UI (/providers)');
  }
}
for (const connection of ticketSet.connections) {
  try {
    const pf = await (await ticketSet.registryFor(connection).current()).preflight();
    if (pf.ok) app.log.info({ provider: connection, identity: pf.identity }, 'ticket preflight ok');
    else app.log.warn({ provider: connection, reason: pf.reason }, 'ticket preflight failed — configure the provider in the UI (/providers)');
  } catch (e) {
    app.log.warn({ provider: connection, err: (e as Error).message }, 'ticket preflight threw — provider likely unconfigured; configure it in the UI (/providers)');
  }
}
await app.listen({ port: config.port, host: config.host });
// The work-queue scheduler turns queued tickets into runs (M6 WP6.1).
const stopScheduler = startScheduler({ tickets, scm }, app.log);
// The notifier delivers undelivered notifications to external sinks (M6 WP6.3).
const stopNotifier = startNotifier(app.log);
// The merge-watcher lands runs left awaiting an external merge once a human merges/closes the MR/PR.
const stopMergeWatch = startMergeWatch({ tickets, scm }, app.log);
// The Hive hook sends each merged run to Hive (#76, #78); off while HIVE_URL is blank.
const stopHiveHook = startHiveHook({ tickets, scm }, app.log);
// Credential health (#139): re-test the tracker/SCM tokens and the subscription token's age.
const stopCredentialChecks = startCredentialChecks(preflightSets, app.log);
// Update check: is a newer ASF release published? At boot, then daily while UPDATE_CHECK_ENABLED.
const stopUpdateChecks = startUpdateChecks(app.log);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => { stopScheduler(); stopNotifier(); stopMergeWatch(); stopHiveHook(); stopCredentialChecks(); stopUpdateChecks(); await app.close(); process.exit(0); });
