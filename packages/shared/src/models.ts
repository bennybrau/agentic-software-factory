import { z } from 'zod';
import type { Role } from './team.js';
import type { ModelRate } from './pricing.js';
import { PROVIDER_KINDS, type ProviderKind } from './context.js';

/**
 * The models an operator can pick per role at dispatch. Ids are exactly what
 * `claude --model <id>` accepts (verified in the worker container) and what the
 * result envelope reports under `modelUsage`, so a run's `task.model` matches
 * its usage line. Always pass the explicit id: the bare aliases (`opus`,
 * `sonnet`) resolve to whatever the CLI considers current — `opus` is Opus 5,
 * not the 4.8 chosen as the default Opus.
 */
export const MODEL_TIERS = ['fast', 'balanced', 'max'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Who serves a model (M8 §2.3). A runtime drives models; a provider hosts them. */
export interface ModelProvider {
  id: string;
  kind: ProviderKind;
  baseUrl?: string;
  /** The setting key holding this provider's secret (never the secret itself). */
  credentialKey?: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  tier: ModelTier;
  providerId: string;
  /** The runtimes that can drive this model (`claude-code`, `codex`, …). */
  runtimes: string[];
  /** USD per 1M tokens. Absent = unpriced unless a legacy prefix in pricing.ts matches. */
  rate?: ModelRate;
}

/** Ollama Cloud's API origin (M11). OLLAMA_API_KEY is only ever sent here. */
export const OLLAMA_CLOUD_URL = 'https://ollama.com';

export const PROVIDERS: ModelProvider[] = [
  { id: 'anthropic', kind: 'anthropic' },
  { id: 'openai', kind: 'openai', credentialKey: 'OPENAI_API_KEY' },
  // M11: no built-in models. An operator adds `ollama:<name>` / `ollama-cloud:<name>`
  // entries (rate 0) via MODEL_CATALOG_EXTRA. The local server's URL is OLLAMA_BASE_URL.
  { id: 'ollama', kind: 'ollama' },
  { id: 'ollama-cloud', kind: 'ollama', baseUrl: OLLAMA_CLOUD_URL, credentialKey: 'OLLAMA_API_KEY' },
];

/** True when `baseUrl` is Ollama Cloud (the only place an Ollama key may go). */
export function isOllamaCloud(baseUrl: string | undefined): boolean {
  try { return !!baseUrl && new URL(baseUrl).origin === OLLAMA_CLOUD_URL; } catch { return false; }
}

/**
 * The id a runtime passes as --model. Ollama model ids are namespaced by provider
 * (`ollama:gpt-oss:20b`, `ollama-cloud:glm-5.3`) so they can never collide with a
 * hosted id; the prefix is split on the FIRST `:` only, since Ollama names contain
 * `:` themselves. Every other id is passed through unchanged.
 */
export function nativeModelId(id: string, provider: Pick<ModelProvider, 'id' | 'kind'> | undefined): string {
  if (provider?.kind !== 'ollama') return id;
  return id.startsWith(`${provider.id}:`) ? id.slice(provider.id.length + 1) : id;
}

/** The provider serving catalogue model `id`, or undefined for an unknown id. */
export function providerOfModel(cat: ModelCatalogue, id: string | null | undefined): ModelProvider | undefined {
  const info = id ? cat.models.find((m) => m.id === id) : undefined;
  return info ? cat.providers.find((p) => p.id === info.providerId) : undefined;
}

// List prices; cache read = 10% of input, cache write = 125%.
const OPUS_RATE: ModelRate = { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 };

// OpenCode drives every built-in (anthropic/openai are its built-in providers). Copilot
// serves a model under GitHub's plan: it always authenticates to the github provider,
// reports no usage, and so is unpriced whatever the rate here says (M8 WP H).
export const MODELS: ModelInfo[] = [
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — fast, cheapest', tier: 'fast', providerId: 'anthropic', runtimes: ['claude-code', 'opencode'], rate: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 } },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — balanced', tier: 'balanced', providerId: 'anthropic', runtimes: ['claude-code', 'opencode', 'copilot'], rate: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 } },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 — strongest, ~5× Sonnet', tier: 'max', providerId: 'anthropic', runtimes: ['claude-code', 'opencode'], rate: OPUS_RATE },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — latest Opus, ~5× Sonnet', tier: 'max', providerId: 'anthropic', runtimes: ['claude-code', 'opencode'], rate: OPUS_RATE },
  // OpenAI, driven by the Codex CLI. Standard short-context (<272K) list prices from
  // developers.openai.com/api/docs/pricing (checked 2026-09-29); ids verified against
  // GET /v1/models. On a ChatGPT plan these are billed to the plan, not per token.
  { id: 'gpt-6-luna', label: 'GPT-6 Luna — fast, cheapest', tier: 'fast', providerId: 'openai', runtimes: ['codex', 'opencode'], rate: { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125 } },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol — balanced, built for coding', tier: 'balanced', providerId: 'openai', runtimes: ['codex', 'opencode', 'copilot'], rate: { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 } },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra — strongest, ~5× Sol', tier: 'max', providerId: 'openai', runtimes: ['codex', 'opencode'], rate: { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5 } },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 — most capable, premium', tier: 'max', providerId: 'anthropic', runtimes: ['claude-code', 'opencode'], rate: { inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, cacheWritePerM: 12.5 } },
];

const rateSchema = z.object({
  inputPerM: z.number().nonnegative(),
  outputPerM: z.number().nonnegative(),
  cacheReadPerM: z.number().nonnegative().optional(),
  cacheWritePerM: z.number().nonnegative().optional(),
});

/**
 * The org-tier MODEL_CATALOG_EXTRA shape: providers and models added to (or,
 * by id, replacing) the built-in catalogue — how an operator adds a model on a
 * vLLM box without a code change. A model's label defaults to its id.
 */
export const modelCatalogExtraSchema = z.object({
  providers: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(PROVIDER_KINDS),
    baseUrl: z.string().optional(),
    credentialKey: z.string().optional(),
  })).optional(),
  models: z.array(z.object({
    id: z.string().min(1),
    label: z.string().optional(),
    tier: z.enum(MODEL_TIERS),
    providerId: z.string().min(1),
    runtimes: z.array(z.string().min(1)).min(1),
    rate: rateSchema.optional(),
  })).optional(),
});
export type ModelCatalogExtra = z.infer<typeof modelCatalogExtraSchema>;

export interface ModelCatalogue { providers: ModelProvider[]; models: ModelInfo[] }

/** The built-in catalogue with `extra` merged over it: an extra entry with the same id replaces the built-in one. */
export function mergeCatalogue(extra: unknown): ModelCatalogue {
  const parsed = modelCatalogExtraSchema.parse(extra ?? {});
  const byId = <T extends { id: string }>(base: T[], add: T[]): T[] => {
    const out = new Map(base.map((x) => [x.id, x]));
    for (const x of add) out.set(x.id, x);
    return [...out.values()];
  };
  return {
    providers: byId(PROVIDERS, parsed.providers ?? []),
    models: byId(MODELS, (parsed.models ?? []).map((m) => ({ ...m, label: m.label ?? m.id }))),
  };
}

/**
 * MODEL_ALLOWLIST as a set of ids: comma/whitespace separated, blank = no list
 * (every catalogue model is allowed). Returns null for "no list".
 */
export function parseModelAllowlist(raw: unknown): Set<string> | null {
  const ids = String(raw ?? '').split(/[\s,]+/).map((s) => s.trim().replace(/^["']+|["']+$/g, '')).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

/**
 * The catalogue an org can actually run: built-ins merged with MODEL_CATALOG_EXTRA,
 * narrowed to MODEL_ALLOWLIST when one is set. On Vertex AI or Bedrock an org can
 * call only the models enabled on its cloud project, often under provider-specific
 * ids (`claude-haiku-4-5@20251001`), so the extra catalogue adds those ids and the
 * allowlist hides the rest — a dispatch then never offers a model that would 404.
 * Providers are not filtered: a provider with no allowed model is simply unused.
 */
export function effectiveCatalogue(extra: unknown, allowlist: unknown): ModelCatalogue {
  const merged = mergeCatalogue(extra);
  const allowed = parseModelAllowlist(allowlist);
  return allowed ? { ...merged, models: merged.models.filter((m) => allowed.has(m.id)) } : merged;
}

/**
 * The model to use in place of `wanted` when the allowlist hides it: the first
 * runnable model (its runtimes include `runtime`) of the same tier, else of the
 * nearest tier (max -> balanced -> fast, fast -> balanced -> max). `wanted`
 * itself when it is runnable; null when nothing in `models` can run there.
 * The tier comes from `all` (the unfiltered catalogue) since `wanted` may be
 * hidden from `models`; an unknown id counts as balanced.
 */
export function substituteModel(wanted: string, runtime: string, models: ModelInfo[], all: ModelInfo[] = MODELS): string | null {
  const runnable = models.filter((m) => m.runtimes.includes(runtime));
  if (runnable.some((m) => m.id === wanted)) return wanted;
  const tier = all.find((m) => m.id === wanted)?.tier ?? 'balanced';
  const order: Record<ModelTier, ModelTier[]> = { max: ['max', 'balanced', 'fast'], balanced: ['balanced', 'max', 'fast'], fast: ['fast', 'balanced', 'max'] };
  for (const t of order[tier]) {
    const hit = runnable.find((m) => m.tier === t);
    if (hit) return hit.id;
  }
  return null;
}

export function modelIds(catalogue: ModelInfo[]): string[] {
  return catalogue.map((m) => m.id);
}

export function isKnownModel(id: string | null | undefined, catalogue: ModelInfo[]): boolean {
  return !!id && catalogue.some((m) => m.id === id);
}

/**
 * Reasoning-effort levels the headless `claude -p --effort <level>` accepts
 * (verified on the CLI in the worker container). Composes with --model. Higher
 * effort = more thinking budget = better judgment and more cost.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export function isKnownEffort(e: string | null | undefined): e is EffortLevel {
  return !!e && (EFFORT_LEVELS as readonly string[]).includes(e);
}

/**
 * Opus for the roles that decide and build (planner, implementer); Sonnet for
 * the roles that check (tester, reviewer). Reviewer is Sonnet not Haiku on
 * purpose: it is the only quality gate before the PR and reviewing strong code
 * is a judgment task — a too-weak reviewer both misses real bugs and nitpicks
 * into loops (the $5 runaway). Overridable per dispatch and per org.
 */
export const DEFAULT_ROLE_MODELS: Record<Role, string> = {
  planner: 'claude-opus-4-8',
  implementer: 'claude-opus-4-8',
  tester: 'claude-sonnet-5',
  reviewer: 'claude-sonnet-5',
};

/**
 * Effort mirrors the model logic: high where judgment compounds (plan/build),
 * low for mechanical testing, medium for review (reason about correctness
 * without burning budget). Overridable per dispatch and per org.
 */
export const DEFAULT_ROLE_EFFORT: Record<Role, EffortLevel> = {
  planner: 'high',
  implementer: 'high',
  tester: 'low',
  reviewer: 'medium',
};
