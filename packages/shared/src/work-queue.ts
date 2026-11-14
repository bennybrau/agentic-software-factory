import { z } from 'zod';

/**
 * The work queue: tickets someone asked the factory to work, not yet runs.
 *
 * A `parallel` entry is dispatched by the scheduler as soon as it ticks — the
 * fleet's own capacity (Σ maxConcurrent) is the backpressure, so ten parallel
 * entries with a two-slot fleet simply produce ten queued runs that drain two
 * at a time. A `serial` entry waits: it is dispatched only once the previous
 * entry in its batch has reached its first gate (awaiting_checkpoint) or a
 * terminal state, so "do these five one after another" means exactly that.
 */
export const queueModeSchema = z.enum(['serial', 'parallel']);
export type QueueMode = z.infer<typeof queueModeSchema>;

export const queueEntryStateSchema = z.enum(['queued', 'dispatched', 'failed', 'cancelled']);
export type QueueEntryState = z.infer<typeof queueEntryStateSchema>;

export const workQueueEntrySchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  ticketProvider: z.string(),
  ticketKey: z.string(),
  repoId: z.string().nullable(),
  teamName: z.string().nullable(),
  maxCostUsd: z.number().nullable(),
  mode: queueModeSchema,
  position: z.number(),
  batchId: z.string(),
  state: queueEntryStateSchema,
  runId: z.string().nullable(),
  reason: z.string().nullable(),
  addedBy: z.string().nullable(),
  addedAt: z.string(),
  dispatchedAt: z.string().nullable(),
  /** Ticket ids whose pull requests must be merged before this entry may start (a planner split). */
  dependsOn: z.array(z.string()).default([]),
  /** When the scheduler refused to start it (state failed). null for anything else, and for refusals before #138. */
  refusedAt: z.string().nullable().default(null),
  /** The refusal's code (e.g. over_budget, repo_missing), beside the human `reason`. */
  reasonCode: z.string().nullable().default(null),
});
export type WorkQueueEntry = z.infer<typeof workQueueEntrySchema>;

/** One ticket in an enqueue request. repoId/teamName/maxCostUsd fall back to dispatch defaults. */
export const enqueueItemSchema = z.object({
  ticketId: z.string().min(1),
  ticketKey: z.string().min(1),
  ticketProvider: z.string().min(1),
  repoId: z.string().nullable().default(null),
  teamName: z.string().nullable().default(null),
  maxCostUsd: z.number().nonnegative().nullable().default(null),
});
export type EnqueueItem = z.infer<typeof enqueueItemSchema>;
