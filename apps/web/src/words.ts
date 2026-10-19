/**
 * Plain-English words for the things the factory tracks, in one place so every
 * view says the same thing. The data keeps its engineering names (run states,
 * buckets, gates); only what a person reads goes through here.
 *
 *   backlog → "Planned tasks"   runs → "Activity"  dispatch → "Start"
 *   queue   → "Up next"        gate → a check-in that waits for you
 */
export const PAGE = {
  todo: 'Planned tasks',
  activity: 'Activity',
  upNext: 'Up next',
} as const;

/** Anything not listed falls back to the raw value with underscores as spaces. */
const label = (map: Record<string, string>) => (v: string | null | undefined): string =>
  v == null ? '—' : map[v] ?? v.replace(/_/g, ' ');

/** Where a ticket is on the board (the provider's bucket). */
export const BUCKET_LABEL: Record<string, string> = {
  backlog: 'Not started',
  inflight: 'In progress',
  review: 'In review',
  done: 'Done',
};
export const bucketLabel = label(BUCKET_LABEL);

/** A job's overall status (run state). */
export const RUN_STATE_LABEL: Record<string, string> = {
  queued: 'Waiting to start',
  running: 'Working',
  awaiting_checkpoint: 'Waiting on you',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  stale: 'Interrupted',          // its worker went away; it can be resumed
  halted: 'Hit a limit',         // spending limit reached, or a check-in went unanswered too long
};
export const runStateLabel = label(RUN_STATE_LABEL);

/** One step's status (task state). */
export const TASK_STATE_LABEL: Record<string, string> = {
  pending: 'Not started',
  running: 'Working',
  awaiting_gate: 'Waiting on you',
  done: 'Done',
  failed: 'Failed',
  needs_human: 'Has a question',
  skipped: 'Skipped',
};
export const taskStateLabel = label(TASK_STATE_LABEL);

/** A job's stages (team roles), as the job page lists them. */
export const STAGE_LABEL: Record<string, string> = {
  planner: 'Plan',
  implementer: 'Write code',
  tester: 'Test',
  reviewer: 'Review',
};
export const stageLabel = label(STAGE_LABEL);

/** How a finished job's change landed (delivery outcome). */
export const OUTCOME_LABEL: Record<string, string> = {
  merged: 'Merged',
  awaiting_external_merge: 'Ready for someone to merge',
  no_repo: 'No repository',
  split: 'Split into smaller tasks',
  reviewed: 'Reviewed',
};
export const outcomeLabel = label(OUTCOME_LABEL);

/** The check-ins a job can stop at (gates), phrased as what you're asked. */
export const GATE_TITLE: Record<string, string> = {
  after_plan: 'Approve the plan',
  before_change_request: 'Open the pull request?',
  before_merge: 'Merge to the default branch?',
};
export const gateTitle = label(GATE_TITLE);

/** How a check-in behaves; matches Settings → "When should it check with you?". */
export const GATE_MODE_LABEL: Record<string, string> = {
  required: 'Wait for me',
  notify: 'Tell me',
  auto: 'Just go',
};

/** How a batch from Planned tasks is started. */
export const QUEUE_MODE_LABEL: Record<string, string> = {
  serial: 'one at a time',
  parallel: 'all at once',
};
export const queueModeLabel = label(QUEUE_MODE_LABEL);

/** The agent runtime (the CLI that does the work), as Dispatch names it. */
export const RUNTIME_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  copilot: 'Copilot',
};
export const runtimeLabel = label(RUNTIME_LABEL);
