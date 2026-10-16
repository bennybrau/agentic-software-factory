import { z } from 'zod';
import { gatesSchema, roleSchema, teamTemplateSchema } from './team.js';

export const runStateSchema = z.enum([
  'queued', 'running', 'awaiting_checkpoint', 'succeeded', 'failed', 'cancelled', 'stale', 'halted',
]);
export type RunState = z.infer<typeof runStateSchema>;
export const TERMINAL_RUN_STATES: readonly RunState[] = ['succeeded', 'failed', 'cancelled', 'halted'];
export function isTerminal(state: RunState): boolean { return TERMINAL_RUN_STATES.includes(state); }

export const taskStateSchema = z.enum(['pending', 'running', 'awaiting_gate', 'done', 'failed', 'needs_human', 'skipped']);
export type TaskState = z.infer<typeof taskStateSchema>;

export const runTaskSchema = z.object({
  id: z.string(),
  runId: z.string(),
  role: roleSchema,
  seq: z.number().int().nonnegative(),
  state: taskStateSchema,
  attempt: z.number().int().positive().default(1),
  inputRef: z.string().nullable(),
  outputRef: z.string().nullable(),
  workerId: z.string().nullable(),
  runtime: z.string().nullable(),
  model: z.string().nullable(),
  /** Reasoning effort this task ran at (claude --effort); null = CLI default. */
  effort: z.string().nullable().default(null),
  costUsd: z.number().nonnegative().default(0),
  /** Set once the orchestrator has evaluated the gate that follows this task. */
  gateChecked: z.boolean().default(false),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  reason: z.string().nullable(),
  /** How this task came to exist (M11 WP3): plan | loop_back | gate_reject | needs_human_answer | retry | chat | pr_feedback. */
  queuedBy: z.string().default('plan'),
  /** The note / verdict line / question that caused the re-queue, if any. */
  queuedReason: z.string().nullable().default(null),
});
export type RunTask = z.infer<typeof runTaskSchema>;

export const runSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  ticketKey: z.string(),
  ticketProvider: z.string(),
  state: runStateSchema,
  teamName: z.string(),
  /** The template as dispatched — the orchestrator reads roles/loop from here, never from a mutable global. */
  team: teamTemplateSchema,
  gates: gatesSchema,               // resolved at dispatch; the audit trail of what was required
  repoId: z.string().nullable(),
  worktreePath: z.string().nullable(),
  branchName: z.string().nullable(),
  changeRequestUrl: z.string().nullable(),
  changeRequestNumber: z.number().int().nullable().default(null),
  changeRequestState: z.enum(['open', 'ready', 'merged', 'closed']).nullable().default(null),
  /** How delivery concluded: merged by ASF, awaiting an external human merge, no repo bound, or split into queued sub-tasks. Null until the run succeeds. */
  deliveryOutcome: z.enum(['merged', 'awaiting_external_merge', 'no_repo', 'split']).nullable().default(null),
  costUsd: z.number().nonnegative().default(0),
  maxCostUsd: z.number().nonnegative(),
  reviewIterations: z.number().int().nonnegative().default(0),
  dispatchedBy: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  lastEventAt: z.string().nullable(),
  cancelRequestedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type Run = z.infer<typeof runSchema>;

export const runEventSchema = z.object({
  id: z.number().int(),
  runId: z.string(),
  taskId: z.string().nullable(),
  seq: z.number().int(),
  kind: z.string().min(1).max(64),   // open string; RUN_EVENT_KINDS are the ones the UI renders specially
  source: z.enum(['orchestrator', 'agent', 'worker', 'human', 'ci', 'connector']),
  payload: z.record(z.unknown()).default({}),
  at: z.string(),
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const RUN_EVENT_KINDS = [
  'run:queued', 'run:claimed', 'task:started', 'task:finished',
  'tool:pre', 'tool:post',
  'gate:reached', 'gate:resolved', 'gate:waiting', 'gate:abandoned',
  'needs_human', 'plan:ready', 'plan:edited', 'chat:message', 'chat:reply',
  'review:loop', 'loop:exhausted', 'loop:disputed',
  'segment:result', 'segment:diff',
  'branch:created', 'commit:created', 'branch:pushed',
  'change_request:opened', 'change_request:updated', 'change_request:feedback', 'change_request:ready', 'change_request:merged', 'change_request:closed',
  'run:stale', 'run:cancelled', 'run:failed', 'run:succeeded', 'run:split', 'run:time_limit',
  'publish:conflict', 'conflict:merging', 'conflict:resolved',
  'auth:expired',
] as const;
