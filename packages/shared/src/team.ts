import { z } from 'zod';

export const roleSchema = z.enum(['planner', 'implementer', 'tester', 'reviewer']).or(z.string().min(1));
export type Role = z.infer<typeof roleSchema>;

/** How a gate behaves when the orchestrator reaches it. */
export const gateModeSchema = z.enum(['required', 'notify', 'auto']);
export type GateMode = z.infer<typeof gateModeSchema>;

export const gateConfigSchema = z.object({
  mode: gateModeSchema,
  timeoutHours: z.number().positive().optional(),
});
export type GateConfig = z.infer<typeof gateConfigSchema>;

/**
 * Named points where a person may be asked. `before_merge` defaults to
 * `required` and may only be relaxed by an explicit project-level setting —
 * never from a dispatch alone. See docs/plan.md §6.
 */
export const GATE_NAMES = ['after_plan', 'before_change_request', 'before_merge'] as const;
export type GateName = (typeof GATE_NAMES)[number] | `after_role:${string}`;

export const gatesSchema = z.record(z.string(), gateConfigSchema);

export const DEFAULT_GATES: Record<string, GateConfig> = {
  after_plan: { mode: 'required', timeoutHours: 12 },
  before_change_request: { mode: 'required' },
  before_merge: { mode: 'required' },
};

export const teamRoleSchema = z.object({
  role: roleSchema,
  runtime: z.string().default('claude-code'),
  model: z.string().nullable().default(null),
  /** Reasoning effort for this role (claude -p --effort); null = the CLI default. */
  effort: z.string().nullable().default(null),
  writes: z.boolean().default(false),
  input: z.string().nullable().default(null),   // artifact consumed, e.g. plan.md
  output: z.string().nullable().default(null),  // artifact produced
  /** Per-dispatch standing guidance appended to this role's prompt for THIS run, on top of the org ROLE_SKILL_<ROLE> blob. Null = none. */
  skill: z.string().nullable().default(null),
  maxCostUsd: z.number().nonnegative().nullable().default(null),
});
export type TeamRole = z.infer<typeof teamRoleSchema>;

export const teamTemplateSchema = z.object({
  name: z.string(),
  roles: z.array(teamRoleSchema).min(1),
  loop: z.object({ onReviewFail: roleSchema, maxIterations: z.number().int().nonnegative() }).nullable().default(null),
  gates: gatesSchema.default(DEFAULT_GATES),
  maxCostUsd: z.number().nonnegative().default(15),
  /**
   * Whether ASF merges the change request itself. Default true (open + merge).
   * When false the publish phase opens the MR/PR, marks it ready for review, and
   * the run ends succeeded (awaiting external merge) — a human reviews + merges
   * in the SCM system. This is a stage toggle, NOT a gate relaxation, so the
   * before_merge policy invariant is untouched (it only applies when merge runs).
   */
  mergeEnabled: z.boolean().default(true),
  /**
   * A review-only run: the team reviews an existing PR/MR instead of writing a
   * change. The worker checks out `fetchRef` (the PR head) on the run branch,
   * which is never pushed, and the run ends `reviewed` with no publish phase.
   * Null/absent = an ordinary run.
   */
  reviewTarget: z.object({
    url: z.string(),
    number: z.number().int(),
    headBranch: z.string(),
    baseBranch: z.string(),
    fetchRef: z.string(),   // refs/pull/N/head (GitHub) or refs/merge-requests/N/head (GitLab)
  }).nullable().optional(),
});
export type TeamTemplate = z.infer<typeof teamTemplateSchema>;

export const STANDARD_TEAM: TeamTemplate = teamTemplateSchema.parse({
  name: 'standard',
  // Per-role model + effort mirror DEFAULT_ROLE_MODELS / DEFAULT_ROLE_EFFORT in
  // models.ts (kept literal here to avoid an import cycle; models.test.ts asserts
  // they agree). Overridable at dispatch and per org.
  roles: [
    { role: 'planner', writes: false, output: 'plan.md', model: 'claude-opus-4-8', effort: 'high' },
    { role: 'implementer', writes: true, input: 'plan.md', model: 'claude-opus-4-8', effort: 'high' },
    { role: 'tester', writes: true, output: 'test-report.md', model: 'claude-sonnet-5', effort: 'low' },
    { role: 'reviewer', writes: false, output: 'review.md', model: 'claude-sonnet-5', effort: 'medium' },
  ],
  loop: { onReviewFail: 'implementer', maxIterations: 2 },
});
