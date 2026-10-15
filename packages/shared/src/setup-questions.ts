import type { PipelineStage, PipelineStagesConfig, StageConfig } from './pipeline.js';
import { PIPELINE_STAGES, DEFAULT_STAGE_GATES } from './pipeline.js';
import type { GateMode } from './team.js';
import { substituteModel, type ModelInfo } from './models.js';

/**
 * The web UI's settings model: plain-language QUESTIONS, not a table of keys.
 *
 * The UI is for non-engineers. Each question covers one or more catalogue keys
 * (shown to engineers only in the question's ⓘ tooltip); engineers configure the
 * same keys in `.env`, and a non-empty env value pins the question read-only
 * (env > org). Keys that are org-settable but deliberately NOT asked in the UI
 * are listed in UI_ENV_ONLY with the reason, and a test guarantees every
 * org-settable key is in exactly one of the two — so a new setting can't
 * silently become un-editable or double-edited.
 */

export type QuestionTier = 'essentials' | 'later';

export interface QuestionDef {
  id: string;
  tier: QuestionTier;
  /** Every catalogue key this question reads or writes. */
  keys: readonly string[];
}

export const QUESTIONS: readonly QuestionDef[] = [
  { id: 'tickets', tier: 'essentials', keys: ['TICKET_PROVIDER', 'JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECTS', 'GITHUB_REPOS', 'GITHUB_TOKEN', 'TRELLO_KEY', 'TRELLO_TOKEN', 'TRELLO_BOARDS'] },
  { id: 'code', tier: 'essentials', keys: ['SCM_PROVIDER', 'GITLAB_BASE_URL', 'GITLAB_TOKEN', 'GITLAB_REPOS'] },
  { id: 'ai', tier: 'essentials', keys: ['AGENT_AUTH_MODE', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'AGENT_AUTH_OPENAI_MODE', 'OPENAI_API_KEY',
    'RUNTIME_DEFAULT_PLANNER', 'RUNTIME_DEFAULT_IMPLEMENTER', 'RUNTIME_DEFAULT_TESTER', 'RUNTIME_DEFAULT_REVIEWER'] },
  { id: 'approvals', tier: 'essentials', keys: ['PIPELINE_STAGES'] },
  { id: 'spending', tier: 'essentials', keys: ['ORG_MAX_COST_USD', 'ORG_MONTHLY_BUDGET_USD'] },
  { id: 'models', tier: 'later', keys: ['MODEL_DEFAULT_PLANNER', 'MODEL_DEFAULT_IMPLEMENTER', 'MODEL_DEFAULT_TESTER', 'MODEL_DEFAULT_REVIEWER', 'EFFORT_DEFAULT_PLANNER', 'EFFORT_DEFAULT_IMPLEMENTER', 'EFFORT_DEFAULT_TESTER', 'EFFORT_DEFAULT_REVIEWER'] },
  { id: 'board', tier: 'later', keys: ['TICKET_STATUS_INPROGRESS', 'TICKET_STATUS_INREVIEW', 'TICKET_STATUS_DONE', 'TICKET_ASSIGNEE'] },
  { id: 'guidance', tier: 'later', keys: ['ROLE_SKILL_PLANNER', 'ROLE_SKILL_IMPLEMENTER', 'ROLE_SKILL_TESTER', 'ROLE_SKILL_REVIEWER'] },
  { id: 'alerts', tier: 'later', keys: ['NOTIFY_SINKS', 'TELEGRAM_CHAT_ID', 'WEB_BASE_URL'] },
  { id: 'look', tier: 'later', keys: ['THEME'] },
];

/** Org-settable keys the UI deliberately does not ask about — set them in `.env`. */
export const UI_ENV_ONLY: Readonly<Record<string, string>> = {
  // Per-provider agent auth (WP C). OpenAI (API key) is asked by the AI question (#162).
  OPENAI_BASE_URL: 'a proxy / Azure-style endpoint in front of OpenAI (operator)',
  AGENT_AUTH_OPENAI_COMPAT_MODE: 'operator: set in .env',
  OPENAI_COMPAT_API_KEY: 'operator: set in .env',
  OPENAI_COMPAT_BASE_URL: 'operator: set in .env',
  OLLAMA_BASE_URL: 'operator: set in .env (the Ollama question is M11 WP5)',
  OLLAMA_API_KEY: 'operator: set in .env (the Ollama question is M11 WP5)',
  AGENT_AUTH_GITHUB_MODE: 'operator: set in .env',
  GITHUB_COPILOT_TOKEN: 'operator: set in .env',
  // Model catalogue as data (M8 WP D). The AI question sets the per-role runtime as a whole team (#162); a per-role picker is #69.
  MODEL_CATALOG_EXTRA: 'advanced model catalogue (JSON, Admin)',
  MODEL_ALLOWLIST: 'which models the factory may run (Admin); the Claude on Google Cloud answer sets it to the models its check found',
  STALE_AFTER_MIN: 'operator tuning',
  WORKER_TTL_SECONDS: 'operator tuning',
  EVENT_RETENTION_DAYS: 'operator tuning',
  QUEUE_ENABLED: 'operator switch',
  MERGE_WATCH_ENABLED: 'operator switch',
  UPDATE_CHECK_ENABLED: 'operator switch (a Settings section comes with the updates UI, ADHOC-CDBC5883)',
  SEGMENT_TIMEOUT_MS: 'operator tuning',
  WORKER_MAX_TURNS: 'operator tuning',
  MAX_TURNS_PLANNER: 'operator tuning',
  MAX_TURNS_IMPLEMENTER: 'operator tuning',
  MAX_TURNS_TESTER: 'operator tuning',
  MAX_TURNS_REVIEWER: 'operator tuning',
  MOCK_REPO_PATH: 'sample-mode internals',
  JIRA_JQL_TEMPLATE: 'advanced tracker scoping',
  JIRA_BUCKET_MAP: 'advanced tracker scoping',
  JIRA_BOARDS: 'advanced tracker scoping',
  JIRA_TEAMS: 'advanced tracker scoping',
  GITHUB_BUCKET_MAP: 'advanced tracker scoping',
  GITHUB_API_URL: 'GitHub Enterprise only',
  TRELLO_LIST_BUCKET_MAP: 'advanced tracker scoping',
};

export function questionFor(key: string): QuestionDef | undefined {
  return QUESTIONS.find((q) => q.keys.includes(key));
}

// ── Approvals: three named presets over PIPELINE_STAGES ────────────────────────

export type ApprovalPreset = 'every-step' | 'start-and-end' | 'end-only';

/** Gate per stage for each preset. The "end" is the merge gate (or, with merge off, the human merge itself). */
export const APPROVAL_PRESETS: Readonly<Record<ApprovalPreset, Readonly<Record<PipelineStage, GateMode>>>> = {
  'every-step': { plan: 'required', implement: 'required', test: 'required', review: 'required', create_mr: 'required', merge: 'required' },
  'start-and-end': { plan: 'required', implement: 'auto', test: 'auto', review: 'auto', create_mr: 'notify', merge: 'required' },
  'end-only': { plan: 'auto', implement: 'auto', test: 'auto', review: 'auto', create_mr: 'auto', merge: 'required' },
};

/** The effective per-stage config (missing stages = enabled + DEFAULT_STAGE_GATES, as resolvePipeline does). */
export function effectiveStages(stages: PipelineStagesConfig | null | undefined): Record<PipelineStage, StageConfig> {
  const s = (stages ?? {}) as Partial<Record<PipelineStage, Partial<StageConfig>>>;
  return Object.fromEntries(PIPELINE_STAGES.map((k) => [k, { enabled: s[k]?.enabled ?? true, gate: s[k]?.gate ?? DEFAULT_STAGE_GATES[k] }])) as Record<PipelineStage, StageConfig>;
}

/**
 * Which preset the stored config matches, or 'custom'. Only ENABLED stages are
 * compared (a skipped stage's gate is irrelevant), so "merge off" still reads as
 * a preset — the merge question is separate.
 */
export function detectApprovalPreset(stages: PipelineStagesConfig | null | undefined): ApprovalPreset | 'custom' {
  const eff = effectiveStages(stages);
  for (const [name, gates] of Object.entries(APPROVAL_PRESETS) as [ApprovalPreset, Record<PipelineStage, GateMode>][]) {
    if (PIPELINE_STAGES.every((k) => !eff[k].enabled || eff[k].gate === gates[k])) return name;
  }
  return 'custom';
}

/** Apply a preset's gates, preserving which stages are on/off. */
export function applyApprovalPreset(stages: PipelineStagesConfig | null | undefined, preset: ApprovalPreset): Record<PipelineStage, StageConfig> {
  const eff = effectiveStages(stages);
  return Object.fromEntries(PIPELINE_STAGES.map((k) => [k, { enabled: eff[k].enabled, gate: APPROVAL_PRESETS[preset][k] }])) as Record<PipelineStage, StageConfig>;
}

/** Turn the factory's own merge step on/off (off = a person merges in GitHub/GitLab). Keeps create_mr on so the invariant holds. */
export function setFactoryMerges(stages: PipelineStagesConfig | null | undefined, on: boolean): Record<PipelineStage, StageConfig> {
  const eff = effectiveStages(stages);
  const next = { ...eff, merge: { ...eff.merge, enabled: on } };
  if (on) next.create_mr = { ...eff.create_mr, enabled: true };
  if (next.create_mr.enabled) next.implement = { ...eff.implement, enabled: true };
  return next;
}

// ── Spending presets ───────────────────────────────────────────────────────────

export type BudgetPreset = 'small' | 'standard';
export const BUDGET_PRESETS: Readonly<Record<BudgetPreset, { perTicket: number; monthly: number }>> = {
  small: { perTicket: 10, monthly: 200 },
  standard: { perTicket: 25, monthly: 500 },
};

export function detectBudgetPreset(perTicket: unknown, monthly: unknown): BudgetPreset | 'custom' {
  for (const [name, p] of Object.entries(BUDGET_PRESETS) as [BudgetPreset, { perTicket: number; monthly: number }][]) {
    if (Number(perTicket) === p.perTicket && Number(monthly) === p.monthly) return name;
  }
  return 'custom';
}

/**
 * "Which AI should do the work?" as one choice for the whole team (#162): the
 * per-role runtime plus a matching model for each role. Mirrors the Claude
 * defaults by tier: the strongest model plans and writes code, the balanced one
 * tests and reviews. A per-role mix stays possible per dispatch (and #69).
 */
export type TeamAi = 'claude' | 'openai';
export const TEAM_AI_RUNTIME: Record<TeamAi, string> = { claude: 'claude-code', openai: 'codex' };
export const TEAM_AI_MODELS: Record<TeamAi, Record<'PLANNER' | 'IMPLEMENTER' | 'TESTER' | 'REVIEWER', string>> = {
  claude: { PLANNER: 'claude-opus-4-8', IMPLEMENTER: 'claude-opus-4-8', TESTER: 'claude-sonnet-5', REVIEWER: 'claude-sonnet-5' },
  openai: { PLANNER: 'gpt-6-astra', IMPLEMENTER: 'gpt-6-astra', TESTER: 'gpt-6-sol', REVIEWER: 'gpt-6-sol' },
};
const TEAM_ROLES = ['PLANNER', 'IMPLEMENTER', 'TESTER', 'REVIEWER'] as const;

/** The AI the team runs on, read from the implementer's runtime (the role that writes the code). */
export function detectTeamAi(get: (key: string) => unknown): TeamAi {
  return String(get('RUNTIME_DEFAULT_IMPLEMENTER') ?? '') === 'codex' ? 'openai' : 'claude';
}

/**
 * The writes that move the whole team onto `ai`: every role's runtime, and each
 * role's model reset to that AI's default when the current model can't run there
 * (a model the operator already picked for that AI is kept).
 */
export function teamAiWrites(ai: TeamAi, get: (key: string) => unknown, models: ReadonlyArray<{ id: string; runtimes: string[]; tier?: string }>): Array<[string, string]> {
  const runtime = TEAM_AI_RUNTIME[ai];
  const out: Array<[string, string]> = [];
  for (const r of TEAM_ROLES) {
    if (String(get(`RUNTIME_DEFAULT_${r}`) ?? '') !== runtime) out.push([`RUNTIME_DEFAULT_${r}`, runtime]);
    const cur = String(get(`MODEL_DEFAULT_${r}`) ?? '');
    const fits = models.find((m) => m.id === cur)?.runtimes.includes(runtime);
    if (!fits) {
      // The AI's default for the role, or (under MODEL_ALLOWLIST) an allowed model of the same tier.
      const target = substituteModel(TEAM_AI_MODELS[ai][r], runtime, models as ModelInfo[]);
      if (target && target !== cur) out.push([`MODEL_DEFAULT_${r}`, target]);
    }
  }
  return out;
}
