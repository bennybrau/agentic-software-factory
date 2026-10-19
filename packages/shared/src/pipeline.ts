import { z } from 'zod';
import type { GateConfig, GateMode, Role, TeamTemplate } from './team.js';
import { gateModeSchema } from './team.js';
import { resolveGates, GateOverrides, gateAfterRole } from './gates.js';

/**
 * The pipeline as an ordered checklist of stages the operator configures in the
 * UI: which stages ASF performs (`enabled`) and whether a human approves each
 * (`gate`). This is a thin projection over the existing machinery — roles in the
 * team template and named gates — NOT a parallel system.
 *
 *   stage        ASF action            gate name (existing)
 *   plan         planner role          after_plan
 *   implement    implementer role      after_role:implementer
 *   test         tester role           after_role:tester
 *   review       reviewer role         after_role:reviewer
 *   create_mr    publish:push_open     before_change_request
 *   merge        publish:merge         before_merge
 *
 * Invariants (a config that looks live is one the server accepts):
 *  - `before_merge` may still be relaxed ONLY at the org tier (resolveGates
 *    enforces it); PIPELINE_STAGES setting `merge.gate` maps to before_merge and
 *    is applied as a PROJECT override (org tier), which is allowed — but a
 *    dispatch cannot relax it (that goes through `request`).
 *  - `create_mr` cannot be disabled while `merge` is enabled (can't merge what
 *    was never opened).
 */

export const PIPELINE_STAGES = ['plan', 'implement', 'test', 'review', 'create_mr', 'merge'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const stageConfigSchema = z.object({
  enabled: z.boolean().default(true),
  gate: gateModeSchema.default('required'),
});
export type StageConfig = z.infer<typeof stageConfigSchema>;

export const pipelineStagesSchema = z.record(z.enum(PIPELINE_STAGES), stageConfigSchema).default({});
export type PipelineStagesConfig = z.infer<typeof pipelineStagesSchema>;

export class PipelineConfigError extends Error {}

/** The role a role-stage runs (plan→planner, etc.); null for the publish stages. */
const STAGE_ROLE: Partial<Record<PipelineStage, Role>> = {
  plan: 'planner', implement: 'implementer', test: 'tester', review: 'reviewer',
};
/** The gate each stage answers to. */
const STAGE_GATE: Record<PipelineStage, string> = {
  plan: gateAfterRole('planner'), implement: gateAfterRole('implementer'),
  test: gateAfterRole('tester'), review: gateAfterRole('reviewer'),
  create_mr: 'before_change_request', merge: 'before_merge',
};

/**
 * A dispatch switching roles off for one run: each role's stage is marked
 * `enabled:false`, keeping its gate. Can only switch off, never back on. An
 * unknown role is refused; resolvePipeline still enforces the rest (implementer
 * kept while a PR is opened, at least one role left).
 */
export function skipRoles(stages: PipelineStagesConfig, roles: Role[]): PipelineStagesConfig {
  const cfg = pipelineStagesSchema.parse(stages ?? {});
  const out: PipelineStagesConfig = { ...cfg };
  for (const role of roles) {
    const stage = (Object.keys(STAGE_ROLE) as PipelineStage[]).find((s) => STAGE_ROLE[s] === role);
    if (!stage) throw new PipelineConfigError(`unknown role "${role}" — only planner, implementer, tester and reviewer can be skipped.`);
    out[stage] = { enabled: false, gate: cfg[stage]?.gate ?? defaultGate(stage) };
  }
  return out;
}

/**
 * A review-only run: only the review stage runs, keeping the org's review gate.
 * Plan, implement, test, create_mr and merge are off. Refused when the org has
 * switched review off — there would be nothing left to do.
 */
export function reviewOnlyStages(stages: PipelineStagesConfig): PipelineStagesConfig {
  const cfg = pipelineStagesSchema.parse(stages ?? {});
  if (cfg.review?.enabled === false) {
    throw new PipelineConfigError('the review stage is switched off for this org, so a review-only run has nothing to do. Turn review on in /pipeline.');
  }
  const out: PipelineStagesConfig = {};
  for (const s of PIPELINE_STAGES) out[s] = { enabled: s === 'review', gate: cfg[s]?.gate ?? defaultGate(s) };
  return out;
}

/** The roles whose stage the org switched off (a dispatch can't switch them back on). */
export function disabledRoles(stages: PipelineStagesConfig): Role[] {
  const cfg = pipelineStagesSchema.parse(stages ?? {});
  return (Object.entries(STAGE_ROLE) as [PipelineStage, Role][])
    .filter(([s]) => cfg[s]?.enabled === false)
    .map(([, role]) => role);
}

export interface ResolvedPipeline {
  team: TeamTemplate;              // roles filtered to enabled stages + mergeEnabled set
  gates: Record<string, GateConfig>;
  disabledStages: PipelineStage[];
}

/**
 * Fold the per-stage config into the concrete team + gates the orchestrator
 * consumes. `stages` is the org PIPELINE_STAGES setting. `gatePolicy` is an
 * optional extra project-tier gate seed (may relax before_merge — org tier);
 * `request` is a per-dispatch gate override (may relax anything EXCEPT
 * before_merge). In normal operation the merge gate is set via `stages.merge.gate`
 * and no separate gatePolicy is passed.
 */
export function resolvePipeline(
  base: TeamTemplate,
  stages: PipelineStagesConfig,
  opts: { gatePolicy?: Record<string, GateConfig>; request?: Record<string, GateConfig> } = {},
): ResolvedPipeline {
  const cfg = pipelineStagesSchema.parse(stages ?? {});
  const stageOf = (s: PipelineStage): StageConfig => cfg[s] ?? { enabled: true, gate: defaultGate(s) };

  const mergeEnabled = stageOf('merge').enabled;
  const createMrEnabled = stageOf('create_mr').enabled;
  if (mergeEnabled && !createMrEnabled) {
    throw new PipelineConfigError('merge cannot be enabled while create_mr is disabled — there is nothing to merge if no MR/PR is opened.');
  }

  // Roles: drop a role whose stage is disabled. implement can't be dropped while
  // create_mr is on (nothing to deliver otherwise).
  const disabledStages: PipelineStage[] = PIPELINE_STAGES.filter((s) => !stageOf(s).enabled);
  const disabledRoles = new Set(
    (Object.entries(STAGE_ROLE) as [PipelineStage, Role][])
      .filter(([s]) => !stageOf(s).enabled)
      .map(([, role]) => role),
  );
  if (createMrEnabled && disabledRoles.has('implementer' as Role)) {
    throw new PipelineConfigError('implement cannot be disabled while create_mr is enabled — there would be no change to open.');
  }
  const roles = base.roles.filter((r) => !disabledRoles.has(r.role));
  if (roles.length === 0) throw new PipelineConfigError('at least one role stage (plan/implement/test/review) must be enabled.');

  // Gates: map each enabled stage's `gate` onto its gate name. merge.gate is an
  // ORG-tier (project) override so before_merge may be relaxed here; every other
  // stage's gate is a plain project override too. resolveGates still refuses a
  // before_merge relaxation coming from `request`.
  const project: Record<string, GateConfig> = { ...(opts.gatePolicy ?? {}) };
  for (const s of PIPELINE_STAGES) {
    if (!stageOf(s).enabled) continue;
    project[STAGE_GATE[s]] = { mode: stageOf(s).gate as GateMode };
  }
  const gates = resolveGates({ ...base, mergeEnabled }, { project, request: opts.request } as GateOverrides);

  return { team: { ...base, roles, mergeEnabled }, gates, disabledStages };
}

/**
 * A fresh install's gate for a stage the operator hasn't configured: talk the plan
 * through and approve it, let the team build/test/review on its own, tell you when
 * the change request opens, and wait for you before merging.
 */
export const DEFAULT_STAGE_GATES: Readonly<Record<PipelineStage, GateMode>> = {
  plan: 'required', implement: 'auto', test: 'auto', review: 'auto', create_mr: 'notify', merge: 'required',
};
function defaultGate(s: PipelineStage): GateMode {
  return DEFAULT_STAGE_GATES[s];
}
