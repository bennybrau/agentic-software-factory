import { AUTH_MODES, PROVIDER_KINDS, type ProviderKind, type RunAuth } from '@asf/shared';
import { SavedSecretUnreadable } from './registry/client.js';
import { cfg } from './settings.js';
import { catalogue } from './models.js';
import { parseModelAllowlist } from '@asf/shared';
import { resolveProviderSecret } from './providers/secrets.js';

/**
 * Compute the effective agent auth for a run, resolved at context time so the
 * worker applies the CURRENT mode with no restart. Mirrors how the SCM clone
 * credential is minted: the api holds the secret, resolves it per run, and hands
 * the worker only the resolved value.
 *
 * One auth per model provider (M8 WP C). The mode comes from the resolver
 * (env > org > default); exactly one credential goes on the wire, matching it:
 *   anthropic          oauth-token  CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`)
 *                      api-key      ANTHROPIC_API_KEY (metered)
 *                      vertex/bedrock  nothing (their own env flags)
 *   openai             api-key      OPENAI_API_KEY   (+ OPENAI_BASE_URL if set)
 *                      chatgpt      nothing (a plan login in the runtime's home)
 *   openai-compatible  api-key      OPENAI_COMPAT_API_KEY (+ OPENAI_COMPAT_BASE_URL)
 *                      none         nothing (a keyless local server)
 *   github             gh-token     GITHUB_COPILOT_TOKEN
 *   ollama             none         nothing; baseUrl = OLLAMA_BASE_URL (the local server)
 *                      api-key      OLLAMA_API_KEY (Ollama Cloud) — the mode is not a setting:
 *                      it is api-key whenever a Cloud key is set. The worker picks, per
 *                      task, the catalogue provider's mode and sends the key only to
 *                      https://ollama.com (auth/ollama.ts).
 * Credentials are org-stored as `secret://org/...` pointers resolved to the live
 * value here. A blank credential returns the bare mode; the worker fails that run
 * with a clear reason rather than the api silently falling back to another mode.
 */
interface ProviderAuthDef {
  /** The mode setting; null = the mode is derived (ollama: api-key iff a Cloud key is set). */
  modeKey: 'AGENT_AUTH_MODE' | 'AGENT_AUTH_OPENAI_MODE' | 'AGENT_AUTH_OPENAI_COMPAT_MODE' | 'AGENT_AUTH_GITHUB_MODE' | null;
  credentialKey: Partial<Record<string, CredentialKey>>;
  baseUrlKey?: 'OPENAI_BASE_URL' | 'OPENAI_COMPAT_BASE_URL' | 'OLLAMA_BASE_URL';
}
type CredentialKey = 'ANTHROPIC_API_KEY' | 'CLAUDE_CODE_OAUTH_TOKEN' | 'OPENAI_API_KEY' | 'OPENAI_COMPAT_API_KEY' | 'GITHUB_COPILOT_TOKEN' | 'OLLAMA_API_KEY';

export const PROVIDER_AUTH: Record<ProviderKind, ProviderAuthDef> = {
  anthropic: { modeKey: 'AGENT_AUTH_MODE', credentialKey: { 'api-key': 'ANTHROPIC_API_KEY', 'oauth-token': 'CLAUDE_CODE_OAUTH_TOKEN' } },
  openai: { modeKey: 'AGENT_AUTH_OPENAI_MODE', credentialKey: { 'api-key': 'OPENAI_API_KEY' }, baseUrlKey: 'OPENAI_BASE_URL' },
  'openai-compatible': { modeKey: 'AGENT_AUTH_OPENAI_COMPAT_MODE', credentialKey: { 'api-key': 'OPENAI_COMPAT_API_KEY' }, baseUrlKey: 'OPENAI_COMPAT_BASE_URL' },
  github: { modeKey: 'AGENT_AUTH_GITHUB_MODE', credentialKey: { 'gh-token': 'GITHUB_COPILOT_TOKEN' } },
  ollama: { modeKey: null, credentialKey: { 'api-key': 'OLLAMA_API_KEY' }, baseUrlKey: 'OLLAMA_BASE_URL' },
};

/** A provider's current mode: its setting, or (ollama) api-key when a Cloud key is set. */
async function modeOf(providerKind: ProviderKind): Promise<string> {
  const def = PROVIDER_AUTH[providerKind];
  if (def.modeKey) return String(cfg(def.modeKey));
  return String(cfg('OLLAMA_API_KEY') ?? '').trim() ? 'api-key' : 'none';
}

export async function computeRunAuth(providerKind: ProviderKind = 'anthropic'): Promise<RunAuth> {
  const def = PROVIDER_AUTH[providerKind];
  const mode = await modeOf(providerKind);
  const out: RunAuth = { providerKind, mode };
  const baseUrl = def.baseUrlKey ? String(cfg(def.baseUrlKey) ?? '').trim() : '';
  if (baseUrl) out.baseUrl = baseUrl;
  if (providerKind === 'anthropic' && mode === 'vertex') out.vertex = vertexAuth();
  const key = def.credentialKey[mode];
  if (key) {
    const credential = await resolveCredential(key);
    if (credential) {
      out.credential = credential;
      // v1 shim (one release): a previous-release worker reads these off `auth`.
      if (providerKind === 'anthropic') out[mode === 'api-key' ? 'apiKey' : 'oauthToken'] = credential;
    }
  }
  return out;
}

/** Every provider's auth, for RunContext.auths. The worker uses only the one its
 * task's runtime talks to. A provider that fails to resolve is left out (that run
 * then fails clearly in the worker) rather than failing every run's context. */
export async function computeRunAuths(): Promise<Partial<Record<ProviderKind, RunAuth>>> {
  const entries = await Promise.all(PROVIDER_KINDS.map(async (k) => [k, await computeRunAuth(k).catch((err) => {
    console.warn(JSON.stringify({ level: 'warn', msg: 'agent auth unresolved; leaving provider out of the run context', providerKind: k, reason: (err as Error).message }));
    return null;
  })] as const));
  return Object.fromEntries(entries.filter(([, v]) => v !== null));
}

/**
 * Vertex settings for the worker (no secret: the Google login stays on the worker
 * host). defaultModel/fastModel are what Claude Code falls back to when ASF passes
 * no --model (its auth check) and for its own background calls; on Vertex they
 * must be ids the project has enabled, so they come from the allowed catalogue.
 */
export function vertexAuth(): NonNullable<RunAuth['vertex']> {
  const models = catalogue().models.filter((m) => m.providerId === 'anthropic' && m.runtimes.includes('claude-code'));
  const pick = (tier: string) => models.find((m) => m.tier === tier)?.id;
  const out: NonNullable<RunAuth['vertex']> = {};
  const projectId = String(cfg('ANTHROPIC_VERTEX_PROJECT_ID') ?? '').trim();
  const region = String(cfg('CLOUD_ML_REGION') ?? '').trim();
  const defaultModel = pick('balanced') ?? models[0]?.id;
  const fastModel = pick('fast') ?? defaultModel;
  const maxModel = pick('max') ?? defaultModel;
  if (projectId) out.projectId = projectId;
  if (region) out.region = region;
  // Only when the org narrowed the list: otherwise Claude Code's own defaults stand.
  if (parseModelAllowlist(cfg('MODEL_ALLOWLIST'))) {
    if (defaultModel) out.defaultModel = defaultModel;
    if (fastModel) out.fastModel = fastModel;
    if (maxModel) out.maxModel = maxModel;
  }
  return out;
}

export interface ProviderAuthStatus {
  mode: string;
  credentialPresent: boolean;
  /** anthropic vertex mode: what the worker needs to check and run it (never a secret). */
  vertex?: RunAuth['vertex'];
  /** Set when a credential IS saved but can't be read (#9: ASF_SECRET_KEY missing/wrong). */
  error?: string;
}

/**
 * The current auth mode per provider + whether the credential each mode needs is
 * resolvable, WITHOUT the credentials. The worker polls this at boot and on
 * heartbeat to register (or re-register) in the right mode; the real credential
 * test happens on the first spawn, which gets the resolved value via the run
 * context. The top-level mode/credentialPresent are anthropic's, unchanged, so a
 * previous-release worker keeps reading them.
 */
export async function describeAgentAuth(): Promise<ProviderAuthStatus & { providers: Record<ProviderKind, ProviderAuthStatus> }> {
  const providers = Object.fromEntries(await Promise.all(PROVIDER_KINDS.map(async (k) => [k, await describeOne(k)] as const))) as Record<ProviderKind, ProviderAuthStatus>;
  return { ...providers.anthropic, providers };
}

async function describeOne(providerKind: ProviderKind): Promise<ProviderAuthStatus> {
  const def = PROVIDER_AUTH[providerKind];
  const mode = await modeOf(providerKind);
  // vertex: "present" = a project is set; the Google login itself is checked on the worker.
  if (providerKind === 'anthropic' && mode === 'vertex') {
    const vertex = vertexAuth();
    return { mode, credentialPresent: !!vertex.projectId, vertex };
  }
  const key = def.credentialKey[mode];
  if (!key) return { mode, credentialPresent: true }; // bedrock/chatgpt/none carry no credential here
  try {
    return { mode, credentialPresent: (await resolveCredential(key)).length > 0 };
  } catch (err) {
    // A saved-but-undecryptable token is NOT "not set": say why, so nobody pastes
    // a new token over one that only needs its key back.
    if (isSavedSecretUnreadable(err)) return { mode, credentialPresent: false, error: (err as Error).message };
    return { mode, credentialPresent: false };
  }
}

function isSavedSecretUnreadable(err: unknown): boolean {
  for (let e = err as { name?: string; cause?: unknown } | undefined, i = 0; e && i < 5; e = e.cause as typeof e, i++) {
    if (e instanceof SavedSecretUnreadable || e.name === 'SavedSecretUnreadable') return true;
  }
  return false;
}

async function resolveCredential(key: CredentialKey): Promise<string> {
  return (await resolveProviderSecret(String(cfg(key) ?? ''))).trim();
}

// Keep the api's table and the shared mode list in lockstep (agent-auth.test.ts asserts it).
export const _AUTH_MODES = AUTH_MODES;
