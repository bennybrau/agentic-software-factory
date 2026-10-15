import { isOllamaCloud, type RunAuth } from '@asf/shared';
import type { AuthTranslator } from './types.js';

/**
 * Ollama (M11): a local/LAN server (mode `none`) or Ollama Cloud (mode `api-key`,
 * OLLAMA_API_KEY, sent only to https://ollama.com). Two runtimes drive it (spike:
 * docs/OLLAMA_SPIKE.md):
 *
 *  - claude-code, over Ollama's Anthropic-compatible API: ANTHROPIC_BASE_URL is the
 *    server (no /v1) and ANTHROPIC_AUTH_TOKEN the key, or a placeholder for a keyless
 *    server (Claude Code wants some token). Every model Claude Code picks by itself
 *    (its default, haiku/sonnet/opus aliases for background and sub-agent calls) is
 *    pinned to the task's model, else it asks the server for Claude ids it lacks.
 *  - codex, over the OpenAI Responses API: a generated `asf_ollama` provider
 *    (codexOllamaArgs). `ollama` itself is a reserved provider id in Codex config.
 *
 * Every Anthropic credential and routing flag in the worker env is stripped, so a
 * stray ANTHROPIC_API_KEY / Vertex profile can never send an Ollama task to Claude.
 */
export const OLLAMA_KEYLESS_TOKEN = 'ollama';

const PINNED_MODEL_ENV = [
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;

export const ollama: AuthTranslator = {
  kind: 'ollama',
  credentialEnv: ['OLLAMA_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  // ANTHROPIC_AUTH_TOKEN is routing here, not a credential slot: it is removed BEFORE
  // modeEnv sets the keyless placeholder (or applyAuth sets the Cloud key into it).
  routingEnv: [
    'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', ...PINNED_MODEL_ENV,
  ],
  modeEnv(auth: RunAuth): Record<string, string> {
    const env: Record<string, string> = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    if (auth.baseUrl) env.ANTHROPIC_BASE_URL = auth.baseUrl.replace(/\/+$/, '');
    if (auth.mode === 'none') env.ANTHROPIC_AUTH_TOKEN = OLLAMA_KEYLESS_TOKEN;
    if (auth.model) for (const k of PINNED_MODEL_ENV) env[k] = auth.model;
    return env;
  },
  credentialTarget: (auth) => (auth.mode === 'api-key' ? 'OLLAMA_API_KEY' : null),
  credentialSetting: (mode) => (mode === 'api-key' ? 'OLLAMA_API_KEY' : null),
  configProblem(auth) {
    if (!auth.baseUrl) return 'an Ollama model needs a server: set OLLAMA_BASE_URL (e.g. http://host.docker.internal:11434)';
    if (auth.mode === 'api-key' && !isOllamaCloud(auth.baseUrl)) return `the Ollama key is only sent to https://ollama.com, not ${auth.baseUrl}`;
    return null;
  },
};

/** applyAuth sets the Cloud key into these too: Claude Code reads it as its bearer token. */
export const OLLAMA_ALSO_SET: Record<string, string[]> = { OLLAMA_API_KEY: ['ANTHROPIC_AUTH_TOKEN'] };

/**
 * The auth for one task on an Ollama catalogue provider, from the api's `ollama`
 * auth: the provider's own baseUrl (ollama-cloud) wins over OLLAMA_BASE_URL; the
 * mode follows the URL, so the Cloud key travels ONLY to https://ollama.com and a
 * local task never carries it.
 */
export function ollamaTaskAuth(apiAuth: RunAuth | undefined, providerBaseUrl: string | undefined, nativeModel: string): RunAuth {
  const baseUrl = providerBaseUrl || apiAuth?.baseUrl;
  const cloud = isOllamaCloud(baseUrl);
  return {
    providerKind: 'ollama',
    mode: cloud ? 'api-key' : 'none',
    model: nativeModel,
    ...(baseUrl ? { baseUrl } : {}),
    ...(cloud && apiAuth?.credential ? { credential: apiAuth.credential } : {}),
  };
}

/** Codex's `-c` overrides for an Ollama task (verified in the spike). No effort flag: that is a vendor feature. */
export function codexOllamaArgs(auth: RunAuth): string[] {
  const base = (auth.baseUrl ?? '').replace(/\/+$/, '');
  const kv = [
    'model_providers.asf_ollama.name="Ollama"',
    `model_providers.asf_ollama.base_url="${base}/v1"`,
    'model_providers.asf_ollama.wire_api="responses"',
    ...(auth.mode === 'api-key' ? ['model_providers.asf_ollama.env_key="OLLAMA_API_KEY"'] : []),
    'model_provider="asf_ollama"',
    'web_search="disabled"',
  ];
  return kv.flatMap((c) => ['-c', c]);
}
