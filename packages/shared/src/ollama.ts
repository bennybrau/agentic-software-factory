import { z } from 'zod';
import { mergeCatalogue, MODELS, OLLAMA_CLOUD_URL, type ModelInfo, type ModelTier } from './models.js';

/**
 * Ollama discovery + check (M11 WP3; docs/M11_OLLAMA.md §Discovery). Pure helpers
 * shared by the api routes and (WP5) the Settings UI.
 */

/** Ollama's Anthropic-compatible API (what claude-code talks to) arrived in 0.14.0. */
export const OLLAMA_MIN_VERSION = '0.14.0';
/** Below this the agent's system prompt + tools + repo context get truncated mid-task. */
export const OLLAMA_MIN_CONTEXT = 64_000;

export const OLLAMA_SOURCES = ['local', 'cloud'] as const;
export type OllamaSource = typeof OLLAMA_SOURCES[number];

/** The catalogue provider id a source's models live under (built in: models.ts PROVIDERS). */
export const ollamaProviderId = (source: OllamaSource): 'ollama' | 'ollama-cloud' => (source === 'cloud' ? 'ollama-cloud' : 'ollama');

/** `qwen3-coder` from the local server -> `ollama:qwen3-coder`; from Cloud -> `ollama-cloud:qwen3-coder`. */
export const ollamaModelId = (source: OllamaSource, name: string): string => `${ollamaProviderId(source)}:${name}`;

/** One model as discovery reports it. */
export interface OllamaModel {
  /** The catalogue id to pick (`ollama:<name>` / `ollama-cloud:<name>`). */
  id: string;
  /** The name the server knows it by. */
  name: string;
  source: OllamaSource;
  /** Bytes on disk (local); Cloud reports the upstream weights' size. */
  sizeBytes: number | null;
  /** Parameters in billions, when the server says. */
  paramsB: number | null;
  /** The model's maximum context (model_info.*.context_length), not the server's effective one. */
  maxContext: number | null;
  capabilities: string[];
  /** ASF's agents work only through tool calls: a model without `tools` cannot drive a role. */
  tools: boolean;
  tier: ModelTier;
}

/** What the api's discovery and check routes answer (apps/api/src/ollama-check.ts). */
export type OllamaFailCode =
  | 'not_configured' | 'unreachable' | 'old_server' | 'invalid_key' | 'not_in_plan'
  | 'model_missing' | 'no_tools' | 'context_too_small' | 'rate_limited' | 'other';

export type OllamaModelsResult =
  | { ok: true; source: OllamaSource; url: string; models: OllamaModel[] }
  | { ok: false; source: OllamaSource; code: OllamaFailCode; reason: string };

export type OllamaCheck =
  | { ok: true; source: OllamaSource; model: string; version: string | null; effectiveContext: number | null; maxContext: number | null; reply: string }
  | { ok: false; source: OllamaSource; model: string; code: OllamaFailCode; reason: string; version?: string | null; effectiveContext?: number | null };

/** `30.5B` / `116829156672` / `` -> billions, or null. */
export function parseParamsB(s: unknown): number | null {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const m = /^([\d.]+)\s*([KMBT])?$/i.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? '').toUpperCase();
  const b = unit === 'T' ? n * 1000 : unit === 'B' ? n : unit === 'M' ? n / 1000 : unit === 'K' ? n / 1e6 : n / 1e9;
  return Math.round(b * 10) / 10;
}

/** A rough tier by size: <20B fast, <100B balanced, else max; unknown = balanced. */
export function ollamaTier(paramsB: number | null): ModelTier {
  if (paramsB == null) return 'balanced';
  return paramsB < 20 ? 'fast' : paramsB < 100 ? 'balanced' : 'max';
}

/** The context length out of an /api/show model_info map (`<arch>.context_length`). */
export function maxContextOf(modelInfo: unknown): number | null {
  if (!modelInfo || typeof modelInfo !== 'object') return null;
  for (const [k, v] of Object.entries(modelInfo as Record<string, unknown>)) {
    if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) return v;
  }
  return null;
}

/** Semver-ish compare for Ollama versions (`0.40.4` >= `0.14.0`). Cloud reports `0.0.0`. */
export function ollamaVersionAtLeast(v: string, min: string = OLLAMA_MIN_VERSION): boolean {
  const p = (s: string) => s.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const a = p(v), b = p(min);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

/** The fix for a too-small effective context, worded for whoever runs the server. */
export function ollamaContextFix(effective: number): string {
  return `The Ollama server runs this model with a ${Math.round(effective / 1000)}k context; ASF's agents need at least ${OLLAMA_MIN_CONTEXT / 1000}k `
    + `or they lose the task mid-run. Start the server with OLLAMA_CONTEXT_LENGTH=65536 (e.g. \`OLLAMA_CONTEXT_LENGTH=65536 ollama serve\`, `
    + `or in the Ollama app: Settings → Context length → 64k; a model built with a smaller PARAMETER num_ctx needs that raised too), then check again.`;
}

/**
 * MODEL_CATALOG_EXTRA after adding the chosen Ollama models (Vertex pattern:
 * vertexCatalogueExtra). Existing entries are kept as the operator defined them;
 * new ones get rate 0 (Ollama runs count as $0), both runtimes with claude-code
 * first (the default; docs/OLLAMA_SPIKE.md), and the discovered tier/label.
 */
export function ollamaCatalogueExtra(
  selected: ReadonlyArray<Pick<OllamaModel, 'id'> & Partial<Pick<OllamaModel, 'tier' | 'name' | 'source' | 'maxContext'>>>,
  existing: unknown,
  builtIns: ReadonlyArray<Pick<ModelInfo, 'id'>> = MODELS,
): { models: Array<Partial<ModelInfo> & { id: string }>; providers?: unknown } {
  const base = (existing && typeof existing === 'object' ? existing : {}) as { models?: unknown; providers?: unknown };
  const models = (Array.isArray(base.models) ? base.models : []).filter((m): m is Partial<ModelInfo> & { id: string } => !!m && typeof (m as { id?: unknown }).id === 'string');
  for (const s of selected) {
    const providerId = s.id.startsWith('ollama-cloud:') ? 'ollama-cloud' : s.id.startsWith('ollama:') ? 'ollama' : null;
    if (!providerId) continue; // not an Ollama id: never written by this helper
    if (builtIns.some((m) => m.id === s.id) || models.some((m) => m.id === s.id)) continue;
    const name = s.name ?? s.id.slice(providerId.length + 1);
    models.push({
      id: s.id, label: `${name} (${providerId === 'ollama-cloud' ? 'Ollama Cloud' : 'Ollama, local'})`,
      tier: s.tier ?? 'balanced', providerId, runtimes: ['claude-code', 'codex'], rate: { inputPerM: 0, outputPerM: 0 },
    });
  }
  return { ...(base.providers !== undefined ? { providers: base.providers } : {}), models };
}

/** The server a source talks to: Cloud is fixed; local is OLLAMA_BASE_URL (no /v1). */
export function ollamaSourceUrl(source: OllamaSource, localBaseUrl: string | undefined): string | null {
  if (source === 'cloud') return OLLAMA_CLOUD_URL;
  const u = (localBaseUrl ?? '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  return u || null;
}

/** Request bodies for the api routes (apps/api/src/routes/ollama.ts) and WP5's UI. */
export const ollamaSourceSchema = z.enum(OLLAMA_SOURCES);
export const ollamaCheckRequestSchema = z.object({ source: ollamaSourceSchema, model: z.string().trim().min(1).max(200) });
export const ollamaCatalogueRequestSchema = z.object({
  models: z.array(z.object({
    id: z.string().regex(/^ollama(-cloud)?:\S+$/, 'each id is ollama:<name> or ollama-cloud:<name>'),
    tier: z.enum(['fast', 'balanced', 'max']).optional(),
  })).min(1).max(100),
});

/** True for an `ollama:` / `ollama-cloud:` catalogue id. */
export function isOllamaModelId(id: string | null | undefined): boolean {
  return !!id && /^ollama(-cloud)?:/.test(id);
}

/**
 * The catalogue ids served by Ollama (M11 WP4 routing): every model whose provider is
 * of kind `ollama` in the merged catalogue, plus any `ollama:` / `ollama-cloud:` id
 * (the registry also matches the prefix in SQL, so a model since removed from the
 * catalogue still never reaches a worker without Ollama). A catalogue that fails to
 * parse yields [] and the prefix rule alone applies.
 */
export function ollamaModelIds(catalogExtra: unknown): string[] {
  try {
    const cat = mergeCatalogue(catalogExtra);
    const kinds = new Map(cat.providers.map((p) => [p.id, p.kind]));
    return cat.models.filter((m) => kinds.get(m.providerId) === 'ollama' || isOllamaModelId(m.id)).map((m) => m.id);
  } catch {
    return [];
  }
}
