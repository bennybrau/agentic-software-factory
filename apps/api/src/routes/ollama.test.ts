import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { registerOllamaRoutes } from './ollama.js';

// M11 WP3: discovery / check / catalogue routes against a stub Ollama server (a real
// HTTP server speaking /api/{version,tags,show,chat,ps}). Cloud requests are pointed at
// the same stub by a fetch that rewrites https://ollama.com — the code itself never
// lets a Cloud call go anywhere else.

interface StubModel { name: string; size: number; params: string; ctx: number; caps: string[]; loadedCtx: number }
const LOCAL: StubModel[] = [
  { name: 'qwen3-coder:latest', size: 18_000_000_000, params: '30.5B', ctx: 262144, caps: ['completion', 'tools'], loadedCtx: 65536 },
  { name: 'tiny-ctx', size: 2_000_000_000, params: '3.2B', ctx: 131072, caps: ['completion', 'tools'], loadedCtx: 4096 },
  { name: 'gemma-notools', size: 5_000_000_000, params: '9B', ctx: 8192, caps: ['completion'], loadedCtx: 8192 },
];
const CLOUD: StubModel[] = [
  { name: 'gpt-oss:120b', size: 65_000_000_000, params: '116829156672', ctx: 131072, caps: ['completion', 'tools', 'thinking'], loadedCtx: 131072 },
  { name: 'kimi-k2.7-code', size: 600_000_000_000, params: '', ctx: 262144, caps: ['completion', 'tools'], loadedCtx: 262144 },
];
const KEY = 'oll-test-key';
let server: Server;
let base: string;
let version = '0.40.4';
const seen: Array<{ path: string; auth: string | undefined; cloud: boolean }> = [];
let loaded: StubModel | null = null;

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const cloud = req.headers['x-stub-cloud'] === '1';
      seen.push({ path: req.url ?? '', auth: req.headers.authorization, cloud });
      const list = cloud ? CLOUD : LOCAL;
      const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (cloud && req.headers.authorization !== `Bearer ${KEY}` && req.url !== '/api/version') return send(401, { error: 'Unauthorized' });
      const name = body ? String((JSON.parse(body) as { model?: string }).model ?? '') : '';
      const find = () => list.find((m) => m.name === name || m.name === `${name}:latest`);
      switch (req.url) {
        case '/api/version': return send(200, { version: cloud ? '0.0.0' : version });
        case '/api/tags': return send(200, { models: list.map((m) => ({ name: m.name, model: m.name, size: m.size, details: { parameter_size: m.params } })) });
        case '/api/show': {
          const m = find();
          return m ? send(200, { capabilities: m.caps, details: { parameter_size: m.params }, model_info: { 'arch.context_length': m.ctx, 'arch.embedding_length': 4096 } }) : send(404, { error: `model '${name}' not found` });
        }
        case '/api/chat': {
          if (cloud && name === 'kimi-k2.7-code') return send(402, { error: 'This model is not in the Free plan.' });
          const m = find();
          if (!m) return send(404, { error: `model '${name}' not found` });
          loaded = m;
          return send(200, { message: { role: 'assistant', content: 'ok' }, done: true });
        }
        case '/api/ps': return send(200, { models: loaded ? [{ name: loaded.name, model: loaded.name, context_length: loaded.loadedCtx }] : [] });
        default: return send(404, { error: 'no route' });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });
afterEach(() => { delete process.env.OLLAMA_BASE_URL; delete process.env.OLLAMA_API_KEY; seen.length = 0; loaded = null; version = '0.40.4'; });

/** Rewrites Cloud calls onto the stub (marked) and records where each call was really bound. */
const bound: string[] = [];
const stubFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  bound.push(url);
  if (url.startsWith('https://ollama.com/')) {
    return fetch(url.replace('https://ollama.com', base), { ...init, headers: { ...(init?.headers as Record<string, string>), 'x-stub-cloud': '1' } });
  }
  return fetch(url, init);
}) as typeof fetch;

async function app(writes: Array<[string, unknown]> = [], extra: unknown = {}) {
  const a = Fastify();
  registerOllamaRoutes(a, { fetchImpl: stubFetch, putSetting: async (k, v) => { writes.push([k, v]); }, readCatalogExtra: () => extra });
  await a.ready();
  return a;
}

test('GET models (local): every model with size, params, max context, tools and tier', async () => {
  process.env.OLLAMA_BASE_URL = `${base}/`;
  const a = await app();
  const r = (await a.inject({ url: '/api/providers/ollama/models?source=local' })).json();
  assert.equal(r.ok, true);
  assert.deepEqual(r.models.map((m: { id: string }) => m.id), ['ollama:gemma-notools', 'ollama:qwen3-coder', 'ollama:tiny-ctx']);
  const q = r.models.find((m: { name: string }) => m.name === 'qwen3-coder');
  assert.deepEqual(q, { id: 'ollama:qwen3-coder', name: 'qwen3-coder', source: 'local', sizeBytes: 18_000_000_000, paramsB: 30.5, maxContext: 262144, capabilities: ['completion', 'tools'], tools: true, tier: 'balanced' });
  assert.equal(r.models.find((m: { name: string }) => m.name === 'gemma-notools').tools, false);
  assert.ok(seen.every((s) => s.auth === undefined), 'no key is ever sent to a local server');
  await a.close();
});

test('GET models (cloud): uses the key, lists Cloud models, never calls anywhere but ollama.com', async () => {
  process.env.OLLAMA_API_KEY = KEY;
  process.env.OLLAMA_BASE_URL = base;
  bound.length = 0;
  const a = await app();
  const r = (await a.inject({ url: '/api/providers/ollama/models?source=cloud' })).json();
  assert.equal(r.ok, true);
  assert.deepEqual(r.models.map((m: { id: string; tier: string; paramsB: number | null }) => [m.id, m.tier, m.paramsB]),
    [['ollama-cloud:gpt-oss:120b', 'max', 116.8], ['ollama-cloud:kimi-k2.7-code', 'balanced', null]]);
  assert.ok(bound.length > 0 && bound.every((u) => u.startsWith('https://ollama.com/')), 'Cloud discovery only talks to ollama.com');
  assert.ok(seen.every((s) => s.auth === `Bearer ${KEY}`));
  await a.close();
});

test('GET models: not configured / unreachable / bad source are plain answers', async () => {
  const a = await app();
  assert.deepEqual((await a.inject({ url: '/api/providers/ollama/models?source=local' })).json().code, 'not_configured');
  assert.deepEqual((await a.inject({ url: '/api/providers/ollama/models?source=cloud' })).json().code, 'not_configured');
  process.env.OLLAMA_BASE_URL = 'http://localhost:1';
  const un = (await a.inject({ url: '/api/providers/ollama/models' })).json();
  assert.equal(un.code, 'unreachable');
  assert.match(un.reason, /host\.docker\.internal/, 'localhost-in-a-container hint');
  assert.equal((await a.inject({ url: '/api/providers/ollama/models?source=mars' })).statusCode, 400);
  await a.close();
});

test('POST check (local): a 64k model passes; a 4k context is flagged with the fix', async () => {
  process.env.OLLAMA_BASE_URL = base;
  const a = await app();
  const ok = (await a.inject({ method: 'POST', url: '/api/providers/ollama/check', payload: { source: 'local', model: 'ollama:qwen3-coder' } })).json();
  assert.deepEqual(ok, { ok: true, source: 'local', model: 'qwen3-coder', version: '0.40.4', effectiveContext: 65536, maxContext: 262144, reply: 'ok' });
  const small = (await a.inject({ method: 'POST', url: '/api/providers/ollama/check', payload: { source: 'local', model: 'tiny-ctx' } })).json();
  assert.equal(small.ok, false);
  assert.equal(small.code, 'context_too_small');
  assert.equal(small.effectiveContext, 4096);
  assert.match(small.reason, /4k context.*OLLAMA_CONTEXT_LENGTH=65536/s);
  await a.close();
});

test('POST check (local): old server, missing model, no tool support', async () => {
  process.env.OLLAMA_BASE_URL = base;
  const a = await app();
  const post = async (model: string) => (await a.inject({ method: 'POST', url: '/api/providers/ollama/check', payload: { source: 'local', model } })).json();
  version = '0.13.5';
  const old = await post('qwen3-coder');
  assert.equal(old.code, 'old_server');
  assert.match(old.reason, /0\.13\.5.*0\.14\.0/);
  version = '0.40.4';
  const missing = await post('llama9');
  assert.equal(missing.code, 'model_missing');
  assert.match(missing.reason, /ollama pull llama9/);
  const notools = await post('gemma-notools');
  assert.equal(notools.code, 'no_tools');
  assert.equal((await a.inject({ method: 'POST', url: '/api/providers/ollama/check', payload: { source: 'local' } })).statusCode, 400);
  await a.close();
});

test('POST check (cloud): free model ok (its full context); a plan-gated model is not_in_plan; a bad key is invalid_key', async () => {
  process.env.OLLAMA_API_KEY = KEY;
  const a = await app();
  const post = async (model: string) => (await a.inject({ method: 'POST', url: '/api/providers/ollama/check', payload: { source: 'cloud', model } })).json();
  const ok = await post('ollama-cloud:gpt-oss:120b');
  assert.deepEqual(ok, { ok: true, source: 'cloud', model: 'gpt-oss:120b', version: '0.0.0', effectiveContext: 131072, maxContext: 131072, reply: 'ok' });
  const gated = await post('kimi-k2.7-code');
  assert.equal(gated.code, 'not_in_plan');
  assert.match(gated.reason, /ollama\.com\/upgrade/);
  process.env.OLLAMA_API_KEY = 'wrong';
  assert.equal((await post('gpt-oss:120b')).code, 'invalid_key');
  await a.close();
});

test('POST catalogue: adds picked ids at rate 0 with claude-code first; keeps existing entries; rejects non-Ollama ids', async () => {
  const writes: Array<[string, unknown]> = [];
  const existing = { models: [{ id: 'claude-haiku-4-5@20251001', tier: 'fast', providerId: 'anthropic', runtimes: ['claude-code'] }, { id: 'ollama:qwen3-coder', tier: 'max', providerId: 'ollama', runtimes: ['codex'] }] };
  const a = await app(writes, existing);
  const r = await a.inject({ method: 'POST', url: '/api/providers/ollama/catalogue', payload: { models: [{ id: 'ollama:qwen3-coder' }, { id: 'ollama-cloud:gpt-oss:120b', tier: 'max' }, { id: 'ollama:gpt-oss:20b' }] } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, models: ['ollama:qwen3-coder', 'ollama-cloud:gpt-oss:120b', 'ollama:gpt-oss:20b'] });
  assert.equal(writes.length, 1);
  const [key, value] = writes[0]!;
  assert.equal(key, 'MODEL_CATALOG_EXTRA');
  const models = (value as { models: Array<Record<string, unknown>> }).models;
  assert.deepEqual(models[0], existing.models[0], 'a Vertex entry is untouched');
  assert.deepEqual(models[1], existing.models[1], 'an operator-defined Ollama entry is untouched');
  assert.deepEqual(models[2], { id: 'ollama-cloud:gpt-oss:120b', label: 'gpt-oss:120b (Ollama Cloud)', tier: 'max', providerId: 'ollama-cloud', runtimes: ['claude-code', 'codex'], rate: { inputPerM: 0, outputPerM: 0 } });
  assert.deepEqual(models[3], { id: 'ollama:gpt-oss:20b', label: 'gpt-oss:20b (Ollama, local)', tier: 'balanced', providerId: 'ollama', runtimes: ['claude-code', 'codex'], rate: { inputPerM: 0, outputPerM: 0 } });
  const bad = await a.inject({ method: 'POST', url: '/api/providers/ollama/catalogue', payload: { models: [{ id: 'claude-sonnet-5' }] } });
  assert.equal(bad.statusCode, 400);
  assert.equal(writes.length, 1, 'nothing written for a bad body');
  await a.close();
});
