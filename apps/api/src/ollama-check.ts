import {
  maxContextOf, ollamaContextFix, ollamaModelId, ollamaSourceUrl, ollamaTier, ollamaVersionAtLeast, parseParamsB,
  OLLAMA_MIN_CONTEXT, OLLAMA_MIN_VERSION, type OllamaModel, type OllamaSource,
  type OllamaFailCode, type OllamaModelsResult, type OllamaCheck,
} from '@asf/shared';
import { computeRunAuth } from './agent-auth.js';

/**
 * Ollama discovery and "check it works" (M11 WP3). Both talk to the server from
 * the api process: for the bundled container stack that is the same network the
 * container worker uses, so "the api can't reach it" == "the worker can't". A
 * host worker's own reachability is its preflight's job (WP4).
 *
 * The Cloud key is only ever sent to https://ollama.com (ollamaSourceUrl pins it).
 */

export interface OllamaTarget { source: OllamaSource; url: string | null; key: string | null }

/** The server + key for a source, from settings (or overrides, for tests / the setup form). */
export async function ollamaTarget(source: OllamaSource, o: { baseUrl?: string; key?: string } = {}): Promise<OllamaTarget> {
  const auth = o.baseUrl === undefined || o.key === undefined ? await computeRunAuth('ollama') : null;
  const url = ollamaSourceUrl(source, o.baseUrl ?? auth?.baseUrl);
  const key = source === 'cloud' ? ((o.key ?? auth?.credential ?? '').trim() || null) : null;
  return { source, url, key };
}

export type { OllamaFailCode, OllamaModelsResult, OllamaCheck } from '@asf/shared';

type Fetch = typeof fetch;
const TIMEOUT_MS = 15_000;
const CHAT_TIMEOUT_MS = 120_000; // a cold local model can take a minute to load

function headers(t: OllamaTarget): Record<string, string> {
  return { 'content-type': 'application/json', ...(t.key ? { authorization: `Bearer ${t.key}` } : {}) };
}

/** Plain-language "can't reach it", with the usual container fixes for a local URL. */
export function unreachableReason(t: OllamaTarget): string {
  if (t.source === 'cloud') return 'Couldn’t reach https://ollama.com from this server. Check its internet connection and try again.';
  let host = '';
  try { host = new URL(t.url ?? '').hostname; } catch { /* shown as-is below */ }
  const base = `Couldn’t reach the Ollama server at ${t.url} from the ASF server.`;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return `${base} Inside a container, localhost is the container itself: if Ollama runs on the host, use http://host.docker.internal:11434.`;
  }
  if (host === 'host.docker.internal') {
    return `${base} Make sure Ollama is running on the host and listening on all interfaces (OLLAMA_HOST=0.0.0.0, then restart Ollama). On Linux, the stack also needs host.docker.internal mapped to the host gateway (docs/OLLAMA.md).`;
  }
  return `${base} Make sure Ollama is running there, listening on all interfaces (OLLAMA_HOST=0.0.0.0), and that no firewall blocks port 11434.`;
}

function notConfigured(source: OllamaSource): string {
  return source === 'cloud'
    ? 'No Ollama Cloud key is saved yet. Create one at ollama.com/settings/keys and save it as OLLAMA_API_KEY.'
    : 'No local Ollama server is set. Set OLLAMA_BASE_URL, e.g. http://host.docker.internal:11434.';
}

async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try { return String((JSON.parse(body) as { error?: unknown }).error ?? body); } catch { return body; }
}

/** Map a non-2xx Ollama answer to a code + a plain-language fix. */
async function failure(res: Response, t: OllamaTarget, model: string): Promise<{ code: OllamaFailCode; reason: string }> {
  const msg = await errorText(res);
  if (res.status === 401 || res.status === 403) return { code: 'invalid_key', reason: 'Ollama Cloud didn’t accept the key. Create a new one at ollama.com/settings/keys and save it as OLLAMA_API_KEY.' };
  if (res.status === 402) return { code: 'not_in_plan', reason: `${model} isn’t in your Ollama Cloud plan. Pick a model your plan includes, or upgrade at ollama.com/upgrade. Ollama said: ${msg}` };
  if (res.status === 404) {
    return { code: 'model_missing', reason: t.source === 'local'
      ? `The Ollama server doesn’t have ${model}. Download it on that machine with \`ollama pull ${model}\`, then check again.`
      : `Ollama Cloud has no model called ${model}. Ollama said: ${msg}` };
  }
  if (res.status === 429) return { code: 'rate_limited', reason: 'Ollama is rate-limiting this key right now (Cloud plans have hourly and weekly limits). Wait and check again.' };
  return { code: 'other', reason: `Ollama answered ${res.status}: ${msg || 'unknown error'}` };
}

interface ShowBody { capabilities?: string[]; model_info?: unknown; details?: { parameter_size?: string } }

function toModel(source: OllamaSource, name: string, sizeBytes: number | null, show: ShowBody | null, tagDetails?: { parameter_size?: string }, tagCaps?: string[]): OllamaModel {
  const paramsB = parseParamsB(show?.details?.parameter_size || tagDetails?.parameter_size);
  const capabilities = show?.capabilities ?? tagCaps ?? [];
  return {
    id: ollamaModelId(source, name), name, source, sizeBytes, paramsB,
    maxContext: maxContextOf(show?.model_info), capabilities, tools: capabilities.includes('tools'), tier: ollamaTier(paramsB),
  };
}

async function show(t: OllamaTarget, name: string, f: Fetch): Promise<ShowBody | null> {
  try {
    const res = await f(`${t.url}/api/show`, { method: 'POST', headers: headers(t), body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? ((await res.json()) as ShowBody) : null;
  } catch { return null; }
}

/** GET /api/providers/ollama/models: every model on the server, with context, size and tool support. */
export async function listOllamaModels(source: OllamaSource, o: { baseUrl?: string; key?: string; fetchImpl?: Fetch } = {}): Promise<OllamaModelsResult> {
  const t = await ollamaTarget(source, o);
  const f = o.fetchImpl ?? fetch;
  if (!t.url || (source === 'cloud' && !t.key)) return { ok: false, source, code: 'not_configured', reason: notConfigured(source) };
  let res: Response;
  try {
    res = await f(`${t.url}/api/tags`, { headers: headers(t), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { ok: false, source, code: 'unreachable', reason: unreachableReason(t) };
  }
  if (!res.ok) return { ok: false, source, ...(await failure(res, t, '')) };
  const tags = ((await res.json().catch(() => ({}))) as { models?: Array<{ name?: string; model?: string; size?: number; details?: { parameter_size?: string }; capabilities?: string[] }> }).models ?? [];
  // `qwen3-coder:latest` is listed as `qwen3-coder`: the id people type and Ollama resolves.
  const named = tags.map((m) => ({ ...m, name: String(m.name ?? m.model ?? '').replace(/:latest$/, '') })).filter((m) => m.name);
  // /api/show per model, four at a time: context length and capabilities live only there.
  const out: OllamaModel[] = new Array(named.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, named.length) }, async () => {
    while (next < named.length) {
      const i = next++;
      const m = named[i]!;
      out[i] = toModel(source, m.name, typeof m.size === 'number' ? m.size : null, await show(t, m.name, f), m.details, m.capabilities);
    }
  }));
  return { ok: true, source, url: t.url, models: out.sort((a, b) => a.name.localeCompare(b.name)) };
}

/**
 * POST /api/providers/ollama/check: the server is new enough, the model exists and
 * can call tools, one tiny real completion works (Cloud: the key and the plan), and
 * the context the server actually loaded it with is at least 64k (local; read from
 * /api/ps right after the completion, which is when Ollama has it loaded).
 */
export async function checkOllama(source: OllamaSource, model: string, o: { baseUrl?: string; key?: string; fetchImpl?: Fetch } = {}): Promise<OllamaCheck> {
  const t = await ollamaTarget(source, o);
  const f = o.fetchImpl ?? fetch;
  const name = model.replace(/^ollama(-cloud)?:/, '');
  const fail = (code: OllamaFailCode, reason: string, extra: { version?: string | null; effectiveContext?: number | null } = {}): OllamaCheck => ({ ok: false, source, model: name, code, reason, ...extra });
  if (!t.url || (source === 'cloud' && !t.key)) return fail('not_configured', notConfigured(source));
  if (!name) return fail('model_missing', 'Pick a model to check.');

  let version: string | null = null;
  try {
    const res = await f(`${t.url}/api/version`, { headers: headers(t), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) version = String(((await res.json()) as { version?: unknown }).version ?? '') || null;
  } catch {
    return fail('unreachable', unreachableReason(t));
  }
  // Cloud reports 0.0.0; only a local server's version means anything.
  if (source === 'local' && version && !ollamaVersionAtLeast(version)) {
    return fail('old_server', `This Ollama server is ${version}; ASF needs ${OLLAMA_MIN_VERSION} or newer (its Anthropic-compatible API). Update Ollama on that machine, then check again.`, { version });
  }

  const info = await show(t, name, f);
  if (info && !(info.capabilities ?? []).includes('tools')) {
    return fail('no_tools', `${name} can’t call tools, and ASF’s agents work only through tool calls. Pick a model whose capabilities include “tools” (e.g. qwen3-coder or gpt-oss).`, { version });
  }

  let reply = '';
  try {
    const res = await f(`${t.url}/api/chat`, {
      method: 'POST', headers: headers(t),
      body: JSON.stringify({ model: name, stream: false, messages: [{ role: 'user', content: 'Reply with: ok' }], options: { num_predict: 16 } }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    if (!res.ok) { const e = await failure(res, t, name); return fail(e.code, e.reason, { version }); }
    const body = (await res.json()) as { message?: { content?: string; thinking?: string } };
    reply = String(body.message?.content || body.message?.thinking || '').trim().slice(0, 80);
  } catch {
    return fail('unreachable', unreachableReason(t), { version });
  }

  const maxContext = maxContextOf(info?.model_info);
  let effectiveContext: number | null = source === 'cloud' ? maxContext : null;
  if (source === 'local') {
    try {
      const res = await f(`${t.url}/api/ps`, { headers: headers(t), signal: AbortSignal.timeout(TIMEOUT_MS) });
      const ps = ((await res.json()) as { models?: Array<{ name?: string; model?: string; context_length?: number }> }).models ?? [];
      const hit = ps.find((m) => m.name === name || m.model === name || m.name === `${name}:latest`);
      if (typeof hit?.context_length === 'number') effectiveContext = hit.context_length;
    } catch { /* older servers: no context_length; reported as unknown */ }
  }
  if (effectiveContext !== null && effectiveContext < OLLAMA_MIN_CONTEXT) {
    return fail('context_too_small', ollamaContextFix(effectiveContext), { version, effectiveContext });
  }
  return { ok: true, source, model: name, version, effectiveContext, maxContext, reply };
}
