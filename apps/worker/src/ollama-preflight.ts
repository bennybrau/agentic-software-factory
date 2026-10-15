import { isOllamaCloud, ollamaVersionAtLeast, OLLAMA_MIN_VERSION, type PreflightResult, type RunAuth } from '@asf/shared';

/**
 * The worker-side check for offering a runtime under Ollama (M11 WP4). A runtime's own
 * preflight() can't be used: it asks for the runtime's default model, which an Ollama
 * server doesn't have. Instead, from THIS worker (a host worker's network is not the
 * api's):
 *   - local: OLLAMA_BASE_URL answers /api/version with 0.14.0 or newer;
 *   - Cloud: a key is saved at the api (the key itself reaches the worker only in a
 *     run context, so it is verified on the first Cloud task, like other deferred keys).
 * Offered if either works: a worker with only Cloud, or only a local server, serves Ollama.
 * The per-model check (tools, plan, 64k context) is the api's /api/providers/ollama/check.
 */
export async function preflightOllama(
  auth: Pick<RunAuth, 'mode' | 'baseUrl'>,
  opts: { credentialPresent: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<PreflightResult> {
  const ok: string[] = [];
  const problems: string[] = [];
  const base = (auth.baseUrl ?? '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  if (base && !isOllamaCloud(base)) {
    try {
      const res = await fetchImpl(`${base}/api/version`, { signal: AbortSignal.timeout(5_000) });
      const version = res.ok ? String(((await res.json()) as { version?: unknown }).version ?? '') : '';
      if (!res.ok) problems.push(`the Ollama server at ${base} answered ${res.status}`);
      else if (version && !ollamaVersionAtLeast(version)) problems.push(`the Ollama server at ${base} is ${version}; ASF needs ${OLLAMA_MIN_VERSION} or newer`);
      else ok.push(`local Ollama ${version || '(version unknown)'} at ${base}`);
    } catch (e) {
      problems.push(`can't reach the Ollama server at ${base} from this worker (${(e as Error).message}); `
        + 'is Ollama running and listening on all interfaces (OLLAMA_HOST=0.0.0.0)? From a container, use http://host.docker.internal:11434');
    }
  }
  if (auth.mode === 'api-key' && opts.credentialPresent) ok.push('Ollama Cloud key present at the api; verified on first run');
  if (ok.length) return { ok: true, detail: ok.join('; ') };
  if (!base && auth.mode !== 'api-key') problems.push('no Ollama server or Cloud key set (OLLAMA_BASE_URL or OLLAMA_API_KEY)');
  return { ok: false, reason: problems.join('; ') || 'no usable Ollama server or Cloud key' };
}
