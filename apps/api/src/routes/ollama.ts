import type { FastifyInstance } from 'fastify';
import { ollamaCatalogueExtra, ollamaCatalogueRequestSchema, ollamaCheckRequestSchema, ollamaSourceSchema, SettingError } from '@asf/shared';
import { cfg, putSetting } from '../settings.js';
import { resolveIdentity } from '../identity.js';
import { checkOllama, listOllamaModels } from '../ollama-check.js';

/**
 * Ollama discovery, check and catalogue writer (M11 WP3; docs/M11_OLLAMA.md §Discovery).
 *
 *   GET  /api/providers/ollama/models?source=local|cloud   every model + context/size/tools
 *   POST /api/providers/ollama/check   { source, model }   version, model, tools, one tiny
 *                                                         completion, effective context >= 64k
 *   POST /api/providers/ollama/catalogue { models: [{ id, tier? }] }
 *        adds the picked `ollama:` / `ollama-cloud:` ids to MODEL_CATALOG_EXTRA (rate 0),
 *        keeping every existing entry. WP5's Settings picker calls this.
 *
 * Same trust as the other /api/providers/* routes (the api's bind; a proxy in front
 * in a real deployment). `fetchImpl` is for tests (a stub Ollama server).
 */
export function registerOllamaRoutes(app: FastifyInstance, o: {
  fetchImpl?: typeof fetch;
  /** Tests: the settings write + read, without a registry. */
  putSetting?: typeof putSetting;
  readCatalogExtra?: () => unknown;
} = {}): void {
  const write = o.putSetting ?? putSetting;
  const readExtra = o.readCatalogExtra ?? (() => cfg('MODEL_CATALOG_EXTRA'));
  const opts = o.fetchImpl ? { fetchImpl: o.fetchImpl } : {};

  app.get<{ Querystring: { source?: string } }>('/api/providers/ollama/models', async (req, reply) => {
    const s = ollamaSourceSchema.safeParse(req.query.source ?? 'local');
    if (!s.success) return reply.code(400).send({ error: 'bad_request', reason: 'source is local or cloud' });
    return listOllamaModels(s.data, opts);
  });

  app.post('/api/providers/ollama/check', async (req, reply) => {
    const p = ollamaCheckRequestSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', reason: 'Send { source: "local" | "cloud", model }.' });
    return checkOllama(p.data.source, p.data.model, opts);
  });

  app.post('/api/providers/ollama/catalogue', async (req, reply) => {
    const p = ollamaCatalogueRequestSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', reason: p.error.issues[0]?.message ?? 'bad body' });
    const next = ollamaCatalogueExtra(p.data.models, readExtra());
    try {
      await write('MODEL_CATALOG_EXTRA', next, resolveIdentity(req).user || null);
    } catch (e) {
      if (e instanceof SettingError) return reply.code(400).send({ error: 'bad_setting', reason: e.message });
      throw e;
    }
    return { ok: true, models: next.models.filter((m) => /^ollama(-cloud)?:/.test(m.id)).map((m) => m.id) };
  });
}
