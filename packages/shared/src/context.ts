import { z } from 'zod';
import { repoSchema } from './scm.js';
import { attachmentSchema } from './adhoc.js';
import { thirdPartySkillSchema } from './skills.js';

/**
 * What a worker needs to run a task, assembled by the api at claim time: the
 * ticket as Markdown (the api holds the ticket credential), and — for a role
 * that writes or publishes — the repo plus a short-lived clone credential (the
 * api holds the SCM credential). The registry has neither, which is why this
 * comes from the api and not the claim.
 *
 * The credential is minted per run and never persisted on the run row.
 */
export const cloneCredentialSchema = z.object({
  url: z.string(),                 // https URL with the token embedded, or a bare path for mock/local
  header: z.string().optional(),   // alternatively an Authorization header value
});
export type CloneCredential = z.infer<typeof cloneCredentialSchema>;

/**
 * Which model provider an agent authenticates to (M8 WP C). A runtime talks to one
 * provider per run: claude-code -> anthropic, codex -> openai or an
 * openai-compatible endpoint (DeepSeek/Qwen/GLM/local vLLM), copilot -> github.
 */
export const PROVIDER_KINDS = ['anthropic', 'openai', 'openai-compatible', 'github', 'ollama'] as const;
export const providerKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof providerKindSchema>;

/** Auth modes per provider. anthropic keeps the four it always had. */
export const AUTH_MODES = {
  anthropic: ['oauth-token', 'api-key', 'vertex', 'bedrock'],
  openai: ['api-key', 'chatgpt'],
  'openai-compatible': ['api-key', 'none'],
  github: ['gh-token'],
  // M11: a local/LAN Ollama server takes no key; Ollama Cloud (https://ollama.com) takes OLLAMA_API_KEY.
  ollama: ['none', 'api-key'],
} as const satisfies Record<ProviderKind, readonly string[]>;
export type AnthropicAuthMode = (typeof AUTH_MODES)['anthropic'][number];

/**
 * Effective agent auth for a run and ONE provider, resolved by the api per run so
 * the worker applies the CURRENT mode with no restart (mirrors cloneCredential: the
 * api holds the secret, the worker gets the resolved value just-in-time and discards
 * it). Exactly one `credential` travels, matching the mode (e.g. anthropic
 * oauth-token = a `claude setup-token` token; api-key = the metered key); modes like
 * vertex/bedrock/chatgpt/none carry none. `baseUrl` is the endpoint for providers
 * that take one (openai, openai-compatible). Never persisted or logged; the worker's
 * auth translator (apps/worker/src/auth/) strips every inherited credential for the
 * provider and sets only this one.
 *
 * v1 SHIM (M8 WP C, remove after one release): the pre-M8 wire shape was
 * `{ mode, apiKey? , oauthToken? }` with no providerKind (anthropic only). A payload
 * without providerKind is read as anthropic with credential = oauthToken ?? apiKey,
 * and the api still ALSO sends apiKey/oauthToken on the anthropic auth so a worker
 * from the previous release (which strips unknown keys) keeps working mid-upgrade.
 */
const runAuthObject = z.object({
  providerKind: providerKindSchema,
  mode: z.string().min(1),
  credential: z.string().optional(),
  baseUrl: z.string().optional(),
  /** anthropic `vertex` mode (M9): the project and region from settings, and the
   * models Claude Code should fall back to (its default + its small/fast model,
   * which on Vertex must be ids the project has enabled). The worker's own env
   * fills any that are absent. */
  vertex: z.object({
    projectId: z.string().optional(),
    region: z.string().optional(),
    defaultModel: z.string().optional(),
    fastModel: z.string().optional(),
    maxModel: z.string().optional(),
  }).optional(),
  /** ollama (M11): the provider-native model id the runtime must pin for EVERY call it
   * makes (Claude Code's background/sub-agent models too), set by the worker per task. */
  model: z.string().optional(),
  /** @deprecated v1 shim — read `credential`. */
  apiKey: z.string().optional(),
  /** @deprecated v1 shim — read `credential`. */
  oauthToken: z.string().optional(),
}).superRefine((a, ctx) => {
  const modes = AUTH_MODES[a.providerKind] as readonly string[];
  if (!modes.includes(a.mode)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mode'], message: `${a.providerKind} auth mode must be one of ${modes.join(' | ')}, got ${a.mode}` });
});
export const runAuthSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object' || 'providerKind' in raw) return raw;
  const v1 = raw as { mode?: string; apiKey?: string; oauthToken?: string };
  const credential = v1.mode === 'oauth-token' ? v1.oauthToken : v1.mode === 'api-key' ? v1.apiKey : undefined;
  return { ...v1, providerKind: 'anthropic', ...(credential ? { credential } : {}) };
}, runAuthObject);
export type RunAuth = z.infer<typeof runAuthObject>;

/**
 * Org-tier worker settings, delivered per task. The worker has no org-settings
 * cache of its own (only the api reads the org_setting table), so an org-settable
 * key with readBy:['worker'] MUST travel here or the /admin value is silently
 * ignored and the worker runs on env > default (WORKER_MAX_TURNS=150 in the UI,
 * `--max-turns 40` on the wire — that is the bug this fixes). Resolved by the api
 * per context call, so a UI change applies to the NEXT task with no restart —
 * the same pattern as `auth`. Optional on the wire so an older api still works.
 */
export const WORKER_ORG_SETTING_KEYS = ['WORKER_MAX_TURNS', 'SEGMENT_TIMEOUT_MS', 'MODEL_CATALOG_EXTRA'] as const;
export const workerSettingsSchema = z.object({
  maxTurns: z.number().int().nonnegative(),
  segmentTimeoutMs: z.number().int().positive(),
  /** Per-role turn ceilings from MAX_TURNS_<ROLE>, keyed by lowercase role; a role absent
   * here falls back to maxTurns. Optional so an older api still works. */
  maxTurnsByRole: z.record(z.string(), z.number().int().positive()).optional(),
  /** MODEL_CATALOG_EXTRA, so the worker prices an extra model's usage (priceUsage). Validated on
   * write (models.ts modelCatalogExtraSchema); mergeCatalogue re-parses it. */
  modelCatalogExtra: z.record(z.string(), z.unknown()).optional(),
});
export type WorkerSettings = z.infer<typeof workerSettingsSchema>;

/**
 * Per-role standing guidance ("skills"), resolved by the api from the
 * ROLE_SKILL_<ROLE> org settings and delivered per task. Like workerSettings,
 * the worker has no org-settings cache of its own, so an org-settable key that
 * the prompt needs MUST travel here (readBy:['api']). A role with no skill is
 * simply absent from the map; the worker treats a missing entry as empty. A
 * dispatch may append extra per-run guidance on top via teamRoleSchema.skill.
 */
export const ROLE_SKILL_ORG_SETTING_KEYS = [
  'ROLE_SKILL_PLANNER', 'ROLE_SKILL_IMPLEMENTER', 'ROLE_SKILL_TESTER', 'ROLE_SKILL_REVIEWER',
] as const;

/** Per-role turn ceilings (MAX_TURNS_<ROLE>), org-settable but readBy:['api'] — resolved
 * by the api into workerSettings.maxTurnsByRole. 0 = fall back to WORKER_MAX_TURNS. */
export const MAX_TURNS_ORG_SETTING_KEYS = [
  'MAX_TURNS_PLANNER', 'MAX_TURNS_IMPLEMENTER', 'MAX_TURNS_TESTER', 'MAX_TURNS_REVIEWER',
] as const;

export const runContextSchema = z.object({
  runId: z.string(),
  ticket: z.object({
    id: z.string(),
    key: z.string(),
    title: z.string(),
    body: z.string(),              // Markdown
    url: z.string(),
    links: z.array(z.object({ title: z.string(), url: z.string(), kind: z.string() })).default([]),
    /** Files attached to an ad-hoc task (#179); the worker fetches each from
     * GET /api/runs/:id/attachments/:name. Optional so an older api still parses. */
    attachments: z.array(attachmentSchema).optional(),
  }),
  repo: repoSchema.nullable(),
  cloneCredential: cloneCredentialSchema.nullable(),
  /** The anthropic auth (claude-code). Kept as its own field so a previous-release worker still finds it. */
  auth: runAuthSchema,
  /** Per-provider auth for every provider (M8 WP C); the worker picks the one its runtime talks to.
   * Defaults to {} so a previous-release api still parses; the worker then falls back to `auth`. */
  auths: z.record(providerKindSchema, runAuthSchema).default({}),
  workerSettings: workerSettingsSchema.optional(),
  /** role -> org-tier skill blob. Absent role = no org skill. Optional on the wire so an older api still parses. */
  roleSkills: z.record(z.string(), z.string()).default({}),
  /** The enabled third-party skills; the worker picks the ones given to its role. Defaults to []
   * so an older api still parses. */
  thirdPartySkills: z.array(thirdPartySkillSchema).default([]),
});
export type RunContext = z.infer<typeof runContextSchema>;
