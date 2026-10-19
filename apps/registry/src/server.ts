import Fastify from 'fastify';
import { config, resolveSecret } from './config.js';
import { sql, ping, probe, closePool } from './db/pool.js';
import { migrate, MIGRATIONS_DIR } from './db/migrate.js';
import { installAuth } from './auth.js';
import { registerRpc } from './routes/rpc.js';
import { registerWorkerRoutes } from './routes/workers.js';
import { registerStream } from './routes/stream.js';
import { startSweeper } from './runs/sweeper.js';
import { startRecurringTicker } from './runs/recurring-store.js';
import { activeKeyring, reconcileOrgSecrets, orgSecretStatus } from './settings/secret-store.js';

export async function buildServer(opts: { secret?: string; migrate?: boolean; sweeper?: boolean; recurring?: boolean; databaseUrl?: string; schema?: string } = {}) {
  // forceCloseConnections: the SSE route holds a request open forever by
  // design; close() must not wait for it.
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, forceCloseConnections: true });
  const db = sql({ url: opts.databaseUrl, schema: opts.schema });

  const problem = await probe();
  if (problem) {
    app.log.error({ databaseUrl: redactUrl(config.databaseUrl), code: problem.code, error: problem.message, hint: problem.hint }, 'database unreachable');
    throw new Error(
      `database unreachable: ${problem.message}${problem.code ? ` (${problem.code})` : ''}` +
      (problem.hint ? `\n  ${problem.hint}` : '') +
      '\n  (a registry with no database would accept a dispatch and lose it, so it stops here)',
    );
  }
  let migrations = 0;
  if (opts.migrate ?? config.migrate) {
    const r = await migrate(db, MIGRATIONS_DIR);
    migrations = r.total;
    app.log.info({ applied: r.applied, total: r.total }, 'migrations');
  }

  // Saved tokens at rest (#9). A malformed ASF_SECRET_KEY stops the boot here
  // (like a bad DATABASE_URL); a missing or WRONG key does not — the registry
  // still serves runs, doctor shows ✗, and reading an affected token fails loudly.
  const ring = activeKeyring();
  try {
    const r = await reconcileOrgSecrets(db, ring);
    if (r.encrypted.length || r.reencrypted.length) app.log.info({ encrypted: r.encrypted, reencrypted: r.reencrypted, keyId: ring.current?.id }, 'saved tokens encrypted at rest');
    if (r.plaintext.length) app.log.warn({ plaintext: r.plaintext.length }, 'ASF_SECRET_KEY is not set: tokens saved in Settings are stored in PLAINTEXT. Run `asf secret-key` (or set ASF_SECRET_KEY) and restart the registry');
    if (r.undecryptable.length) app.log.error({ undecryptable: r.undecryptable, keyId: ring.current?.id ?? null }, 'saved tokens cannot be decrypted with ASF_SECRET_KEY: restore the key they were saved with (or set it as ASF_SECRET_KEY_PREVIOUS), or save them again in Settings');
  } catch (err) {
    app.log.error({ err }, 'could not check saved tokens at boot');
  }

  const { secret, generated } = opts.secret ? { secret: opts.secret, generated: false } : resolveSecret();
  if (generated) app.log.warn({ RUN_EVENT_SECRET: secret }, 'RUN_EVENT_SECRET was blank; generated one for this process (set it in .env for workers on other hosts)');
  installAuth(app, secret);

  // `secrets` = counts + key fingerprint only (never names or values): what
  // `asf doctor` and `asf restore` check. Unauthenticated like the rest of /health.
  // Healthchecks poll /health every few seconds; the status decrypts every row,
  // so cache it briefly. A key change means a registry restart anyway.
  let statusCache: { at: number; ring: ReturnType<typeof activeKeyring>; value: Awaited<ReturnType<typeof orgSecretStatus>> | null } | null = null;
  const secretsStatusCached = async () => {
    const r = activeKeyring();
    if (!statusCache || statusCache.ring !== r || Date.now() - statusCache.at > 5000) {
      statusCache = { at: Date.now(), ring: r, value: await orgSecretStatus(db, r).catch(() => null) };
    }
    return statusCache.value;
  };
  app.get('/health', async () => ({
    ok: true, db: await ping(), migrations,
    secrets: await secretsStatusCached(),
  }));
  registerRpc(app, db);
  registerWorkerRoutes(app, db);
  const closeStream = await registerStream(app, db);
  const stopSweeper = (opts.sweeper ?? true) ? startSweeper(db, app.log) : () => {};
  const stopRecurring = (opts.recurring ?? true) ? startRecurringTicker(db, app.log, config.reconcileIntervalMs) : () => {};

  app.addHook('onClose', async () => { stopSweeper(); stopRecurring(); await closeStream(); await closePool(); });
  return { app, secret };
}

/** DATABASE_URL with the password hidden (user:***@host). */
export function redactUrl(url: string): string {
  return url.replace(/(:\/\/[^:/@]*):.*@/, '$1:***@');
}
