import { mergeCatalogue, nativeModelId, providerOfModel, type ProviderKind, type RunAuth, type RunContext } from '@asf/shared';
import type { AuthTranslator } from './types.js';
import { anthropic } from './anthropic.js';
import { openai, OPENAI_ALSO_SET, linkChatgptLogin } from './openai.js';
import { openaiCompatible, codexCompatArgs, opencodeCompatProvider } from './openai-compatible.js';
import { github } from './github.js';
import { ollama, OLLAMA_ALSO_SET, ollamaTaskAuth, codexOllamaArgs } from './ollama.js';

export type { AuthTranslator } from './types.js';

/** The per-provider auth translators (M8 WP C). hermes.ts joins in WP F. */
export const TRANSLATORS: Record<ProviderKind, AuthTranslator> = {
  anthropic, openai, 'openai-compatible': openaiCompatible, github, ollama,
};

/** Which provider a runtime talks to by default. A runtime that can use several
 * (codex: openai | openai-compatible) is resolved per task by the team (WP D). */
export const RUNTIME_PROVIDER: Record<string, ProviderKind> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  opencode: 'openai',
  copilot: 'github',
};
export function providerFor(runtime: string): ProviderKind {
  return RUNTIME_PROVIDER[runtime] ?? 'anthropic';
}

const ALSO_SET: Record<string, string[]> = { ...OPENAI_ALSO_SET, ...OLLAMA_ALSO_SET };

/**
 * Build the full environment for a spawned agent from a base env and the run's
 * effective auth for ONE provider: add the mode's env, STRIP every credential the
 * worker env could carry for that provider, then set exactly the mode's one from
 * the context. A mode whose credential is missing from the context sets nothing,
 * so the agent fails clearly instead of using a stray.
 */
export function applyAuth(base: NodeJS.ProcessEnv, auth: RunAuth): NodeJS.ProcessEnv {
  const t = TRANSLATORS[auth.providerKind];
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of t.routingEnv ?? []) delete env[k];
  Object.assign(env, t.modeEnv(auth));
  for (const k of t.credentialEnv) delete env[k];
  const target = t.credentialTarget(auth);
  const cred = auth.credential ?? legacyCredential(auth);
  if (target && cred) for (const k of [target, ...(ALSO_SET[target] ?? [])]) env[k] = cred;
  return env;
}

/** v1-shim read: an anthropic auth from a previous-release api carries apiKey/oauthToken. */
function legacyCredential(auth: RunAuth): string | undefined {
  if (auth.providerKind !== 'anthropic') return undefined;
  return auth.mode === 'oauth-token' ? auth.oauthToken : auth.mode === 'api-key' ? auth.apiKey : undefined;
}

/** The auth a task's runtime uses, from the run context: the per-provider map if the
 * api sent one (M8+), else the single anthropic `auth` (a previous-release api). */
export function authForRuntime(ctx: Pick<RunContext, 'auth' | 'auths'>, runtime: string): RunAuth {
  const kind = providerFor(runtime);
  return ctx.auths?.[kind] ?? (kind === 'anthropic' ? ctx.auth : { providerKind: kind, mode: 'unset' } as RunAuth);
}

/** Runtimes that can talk to more than one provider, chosen per task by the model (M8 WP E). */
const RUNTIME_PROVIDERS: Record<string, ProviderKind[]> = {
  // M11 spike (docs/OLLAMA_SPIKE.md): claude-code is the default for Ollama models
  // (its hooks keep scope/cancel/telemetry); codex is the opt-in alternative.
  'claude-code': ['ollama'],
  codex: ['openai', 'openai-compatible', 'ollama'],
  opencode: ['anthropic', 'openai', 'openai-compatible'],
};

/**
 * The providers besides its default a runtime is checked and offered for (M11 WP4):
 * Ollama, for the runtimes that can drive it. An Ollama-only worker then offers
 * claude-code@ollama even though its Claude check fails. (openai-compatible stays
 * routed per task under codex's openai offer, as before.)
 */
export function extraProviders(runtime: string): ProviderKind[] {
  return (RUNTIME_PROVIDERS[runtime] ?? []).filter((p) => p === 'ollama' && p !== providerFor(runtime));
}

/**
 * The auth for one task: the provider that serves the task's MODEL (from the merged
 * catalogue) when the runtime can talk to it — codex + a DeepSeek model ->
 * openai-compatible — else the runtime's default provider (authForRuntime). A
 * catalogue provider's own baseUrl wins over the org-wide one.
 */
export function authForTask(ctx: Pick<RunContext, 'auth' | 'auths' | 'workerSettings'>, runtime: string, model: string | null | undefined): RunAuth {
  const cat = mergeCatalogue(ctx.workerSettings?.modelCatalogExtra);
  const provider = providerOfModel(cat, model);
  if (!provider || !RUNTIME_PROVIDERS[runtime]?.includes(provider.kind)) return authForRuntime(ctx, runtime);
  if (provider.kind === 'ollama') return ollamaTaskAuth(ctx.auths?.ollama, provider.baseUrl, nativeModelId(model!, provider));
  const auth = ctx.auths?.[provider.kind] ?? ({ providerKind: provider.kind, mode: 'unset' } as RunAuth);
  return provider.baseUrl ? { ...auth, baseUrl: provider.baseUrl } : auth;
}

/**
 * How a task's catalogue model is passed to its runtime (M11): the provider-native
 * id for --model (`ollama:gpt-oss:20b` -> `gpt-oss:20b`), and whether it is served
 * by Ollama — then the task sends no effort flag (a vendor feature) and is priced
 * from the catalogue rate (0), never from the runtime's own cost figure (Claude Code
 * prices every model as Claude).
 */
export function taskModel(ctx: Pick<RunContext, 'workerSettings'>, model: string | null | undefined): { cliModel: string | undefined; ollama: boolean } {
  if (!model) return { cliModel: undefined, ollama: false };
  const provider = providerOfModel(mergeCatalogue(ctx.workerSettings?.modelCatalogExtra), model);
  return { cliModel: nativeModelId(model, provider), ollama: provider?.kind === 'ollama' };
}

/** Codex's per-provider CLI args (the credential itself travels in the env via applyAuth). */
export function codexAuthArgs(auth: RunAuth): string[] {
  if (auth.providerKind === 'ollama') return codexOllamaArgs(auth);
  return auth.providerKind === 'openai-compatible' ? codexCompatArgs(auth) : [];
}

/**
 * OpenCode's provider for this auth (M8 WP H): the id that prefixes `-m <provider/model>`
 * and the `provider` block for its generated config. anthropic and openai are OpenCode
 * built-ins reading the env applyAuth set; openai-compatible is a generated `asf` provider.
 */
export function opencodeAuthConfig(auth: RunAuth, model: string | undefined): { id: string; provider: Record<string, unknown> } {
  switch (auth.providerKind) {
    case 'openai-compatible': return { id: 'asf', provider: { asf: opencodeCompatProvider(auth, model) } };
    case 'openai': return { id: 'openai', provider: auth.baseUrl ? { openai: { options: { baseURL: auth.baseUrl } } } : {} };
    case 'github': return { id: 'github-copilot', provider: {} };
    default: return { id: 'anthropic', provider: {} };
  }
}

/** Prepare a runtime's per-task home for this auth (codex chatgpt: link the plan login). */
export async function prepareAuthHome(auth: RunAuth, home: string): Promise<void> {
  await linkChatgptLogin(auth, home);
}

/**
 * The non-network part of preflight, shared by every runtime: static config
 * problems, and "the mode needs a credential and none is available" — with the
 * setting name an operator must fill in. A runtime's own preflight() then does
 * the live check (a real call through its binary).
 */
export function checkAuthConfig(
  auth: RunAuth, env: NodeJS.ProcessEnv, credentialPresent: boolean,
): { ok: true; deferred: boolean } | { ok: false; reason: string } {
  const t = TRANSLATORS[auth.providerKind];
  if (!t) return { ok: false, reason: `unknown agent provider ${auth.providerKind}` };
  const problem = t.configProblem?.(auth, env);
  if (problem) return { ok: false, reason: problem };
  const setting = t.credentialSetting(auth.mode);
  if (!setting) return { ok: true, deferred: false };
  if (auth.credential ?? legacyCredential(auth)) return { ok: true, deferred: false };
  // No literal credential on the health path: trust the api's presence signal and
  // let the first spawn (which gets the resolved value via the run context) test it.
  if (credentialPresent) return { ok: true, deferred: true };
  return { ok: false, reason: `${auth.mode} mode but no ${setting} is set (enter one in Settings → Which AI should do the work?)` };
}
