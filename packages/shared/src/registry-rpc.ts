import { z } from 'zod';
import { runSchema, runTaskSchema, runEventSchema, runStateSchema } from './run.js';
import { teamTemplateSchema, gatesSchema } from './team.js';
import { createAdhocInputSchema } from './adhoc.js';
import type { AdhocTask, AdhocAttachmentWire } from './adhoc.js';
import type { SplitFamilyWire } from './split.js';
import { createRecurringTaskInputSchema, updateRecurringTaskInputSchema } from './recurring.js';
import type { RecurringTask } from './recurring.js';
import { avatarInputSchema, AVATAR_ROLES } from './avatars.js';
import type { AvatarMetaWire, AvatarWire } from './avatars.js';
import { themeImageInputSchema, themeManifestSchema, THEME_IMAGE_SLOTS, THEME_ID_RE, THEME_IMAGE_STATES, THEME_MAX_PICTURES } from './theme.js';
import type { ThemeImageMetaWire, ThemeImageWire, ThemeRecordWire } from './theme.js';
import { skillInputSchema, skillRolesSchema, SKILL_ID_RE } from './skills.js';
import type { ThirdPartySkill } from './skills.js';
import { workQueueEntrySchema, enqueueItemSchema, queueModeSchema, queueEntryStateSchema } from './work-queue.js';

/**
 * The api <-> registry contract. One endpoint, POST /internal/rpc, dispatching
 * on `op`. Adding a call = adding a member here; a missing case in the
 * registry's switch is a type error, not a 404.
 */
export const createRunInputSchema = z.object({
  ticketId: z.string().min(1),
  ticketKey: z.string().min(1),
  ticketProvider: z.string().min(1),
  team: teamTemplateSchema,
  gates: gatesSchema,
  repoId: z.string().nullable().default(null),
  maxCostUsd: z.number().nonnegative(),
  dispatchedBy: z.string().nullable().default(null),
});
export type CreateRunInput = z.infer<typeof createRunInputSchema>;

export const appendEventInputSchema = z.object({
  runId: z.string(),
  taskId: z.string().nullable().default(null),
  kind: z.string().min(1).max(64),
  source: runEventSchema.shape.source,
  payload: z.record(z.unknown()).default({}),
});
export type AppendEventInput = z.infer<typeof appendEventInputSchema>;

/** One turn of a role conversation (the planner chat). author agent|human. */
export const runMessageInputSchema = z.object({
  runId: z.string(),
  taskId: z.string().nullable().default(null),
  role: z.string().min(1),
  author: z.enum(['agent', 'human']),
  /** agent: question | plan | reply. human: message. */
  kind: z.enum(['question', 'plan', 'reply', 'message']),
  body: z.string(),
  by: z.string().nullable().default(null),
  sessionId: z.string().nullable().default(null),
});
export type RunMessageInput = z.infer<typeof runMessageInputSchema>;
export interface RunMessageWire {
  id: string; runId: string; taskId: string | null; role: string;
  author: 'agent' | 'human'; kind: 'question' | 'plan' | 'reply' | 'message';
  body: string; by: string | null; sessionId: string | null; createdAt: string;
}

export const rpcRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('createRun'), input: createRunInputSchema }),
  z.object({ op: z.literal('getRun'), id: z.string() }),
  z.object({ op: z.literal('getSplitFamily'), runId: z.string() }),
  z.object({ op: z.literal('resolveConflict'), runId: z.string(), by: z.string().nullable() }),
  z.object({ op: z.literal('listRuns'), ticketId: z.string().optional(), state: runStateSchema.optional(),
    teamName: z.string().optional(), deliveryOutcome: z.enum(['merged', 'awaiting_external_merge', 'no_repo', 'split']).optional(),
    search: z.string().optional(), since: z.string().optional(),
    limit: z.number().int().positive().max(500).default(50), offset: z.number().int().nonnegative().default(0) }),
  z.object({ op: z.literal('getTasks'), runId: z.string() }),
  z.object({ op: z.literal('getEvents'), runId: z.string(), afterSeq: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(1000).default(200) }),
  z.object({ op: z.literal('appendEvent'), input: appendEventInputSchema }),
  z.object({ op: z.literal('cancelRun'), id: z.string(), by: z.string().nullable().default(null) }),
  z.object({ op: z.literal('resumeRun'), id: z.string(), by: z.string().nullable().default(null) }),
  z.object({ op: z.literal('listGates'), runId: z.string() }),
  z.object({ op: z.literal('listArtifacts'), runId: z.string() }),
  z.object({ op: z.literal('listArtifactVersions'), runId: z.string() }),
  z.object({ op: z.literal('taskProgress'), taskIds: z.array(z.string()).max(50) }),
  z.object({ op: z.literal('saveArtifact'), runId: z.string(), name: z.string(), content: z.string(),
    taskId: z.string().nullable().default(null), source: z.string().default('agent') }),
  z.object({ op: z.literal('getOrgSettings') }),
  z.object({ op: z.literal('putOrgSetting'), key: z.string(), value: z.unknown(), by: z.string().nullable().default(null) }),
  z.object({ op: z.literal('deleteOrgSetting'), key: z.string() }),
  // --- DB-backed secret sink (white-label WP B): write-only + existence-only read.
  // getOrgSecret returns the value and is internal-RPC-only; it is NOT exposed on any /api/* route.
  z.object({ op: z.literal('putOrgSecret'), name: z.string().min(1), value: z.string(), by: z.string().nullable().default(null) }),
  z.object({ op: z.literal('deleteOrgSecret'), name: z.string().min(1) }),
  z.object({ op: z.literal('getOrgSecret'), name: z.string().min(1) }),
  z.object({ op: z.literal('listOrgSecretNames') }),
  // Credential health (#139): the api records each live check; the first failure of a streak records one notification.
  z.object({ op: z.literal('recordCredentialHealth'), key: z.string().min(1), ok: z.boolean(), reason: z.string().nullable().default(null),
    label: z.string().min(1), link: z.string().default('/settings'),
    /** What to do about it, when not "save a new one in Settings" (M9 #2: a worker's Google login). */
    fix: z.string().optional() }),
  z.object({ op: z.literal('listFleet') }),
  z.object({ op: z.literal('monthCost') }),
  z.object({ op: z.literal('monthUnpricedRuns') }),
  // --- work queue (M6 WP6.1) ---
  z.object({ op: z.literal('enqueue'),
    items: z.array(enqueueItemSchema).min(1).max(100),
    mode: queueModeSchema.default('parallel'),
    by: z.string().nullable().default(null) }),
  z.object({ op: z.literal('listQueue'), state: queueEntryStateSchema.optional(), limit: z.number().int().positive().max(500).default(200) }),
  z.object({ op: z.literal('reorderQueue'), id: z.string(), beforeId: z.string().nullable().default(null) }),
  z.object({ op: z.literal('removeQueueEntry'), id: z.string(), by: z.string().nullable().default(null) }),
  // scheduler-facing: claim the next entries the api may dispatch this tick, and report the outcome.
  z.object({ op: z.literal('readyQueueEntries'), limit: z.number().int().positive().max(50).default(20) }),
  z.object({ op: z.literal('markQueueEntry'), id: z.string(),
    state: z.enum(['dispatched', 'failed']), runId: z.string().nullable().default(null), reason: z.string().nullable().default(null) }),
  // merge-watcher: runs that finished awaiting an external merge, to poll the SCM for.
  z.object({ op: z.literal('runsAwaitingExternalMerge'), limit: z.number().int().positive().max(100).default(50) }),
  // Today view (M6 WP6.2): the four landing-page buckets in one aggregate.
  z.object({ op: z.literal('today'), since: z.string() }),
  // Notifications (M6 WP6.3): the web inbox + the external-sink delivery cursor.
  z.object({ op: z.literal('listNotifications'), unreadOnly: z.boolean().default(false), limit: z.number().int().positive().max(200).default(50) }),
  z.object({ op: z.literal('markNotificationRead'), id: z.string().nullable().default(null) }),
  z.object({ op: z.literal('clearNotifications') }),
  z.object({ op: z.literal('undeliveredNotifications'), limit: z.number().int().positive().max(50).default(20) }),
  z.object({ op: z.literal('markNotificationDelivered'), id: z.string() }),
  // Needs-human inbox (M6 WP6.4): answer re-queues the parked role with the reply; skip moves on.
  z.object({ op: z.literal('answerNeedsHuman'), runId: z.string(), reply: z.string().min(1), by: z.string().nullable().default(null) }),
  z.object({ op: z.literal('skipNeedsHuman'), runId: z.string(), by: z.string().nullable().default(null) }),
  z.object({ op: z.literal('resolveGate'), gateId: z.string(),
    decision: z.enum(['approve', 'reject']), by: z.string().nullable().default(null),
    note: z.string().nullable().default(null), editedArtifact: z.string().nullable().default(null) }),
  // Retry a failed run: re-queue the failed role task so the run runs again from it.
  // Planner chat: one row per turn of the conversation on a run's plan stage.
  z.object({ op: z.literal('appendMessage'), input: runMessageInputSchema }),
  z.object({ op: z.literal('listMessages'), runId: z.string() }),
  z.object({ op: z.literal('sendChatMessage'), runId: z.string(), body: z.string().min(1), by: z.string().nullable().default(null) }),
  // Request changes after the MR/PR is open: reopen the run with the feedback as a planner turn.
  z.object({ op: z.literal('requestChanges'), runId: z.string(), body: z.string().min(1), by: z.string().nullable().default(null) }),
  z.object({ op: z.literal('retryFailedTask'), runId: z.string(),
    note: z.string().nullable().default(null), by: z.string().nullable().default(null) }),
  // Ad-hoc tasks (#179): a ticket stored here instead of in a tracker. Ids are `adhoc:<id>`.
  z.object({ op: z.literal('createAdhoc'), input: createAdhocInputSchema }),
  z.object({ op: z.literal('getAdhoc'), id: z.string() }),
  z.object({ op: z.literal('listAdhoc') }),
  z.object({ op: z.literal('deleteAdhoc'), id: z.string() }),
  z.object({ op: z.literal('getAdhocAttachment'), id: z.string(), name: z.string() }),
  // Recurring tasks (#188): an ad-hoc task the registry creates on a schedule.
  z.object({ op: z.literal('listRecurring') }),
  z.object({ op: z.literal('getRecurring'), id: z.string() }),
  z.object({ op: z.literal('createRecurring'), input: createRecurringTaskInputSchema, by: z.string().nullable().default(null) }),
  z.object({ op: z.literal('updateRecurring'), id: z.string(), patch: updateRecurringTaskInputSchema }),
  z.object({ op: z.literal('setRecurringPaused'), id: z.string(), paused: z.boolean() }),
  z.object({ op: z.literal('deleteRecurring'), id: z.string() }),
  z.object({ op: z.literal('upcomingRecurring'), withinHours: z.number().positive().max(24 * 31).default(24) }),
  // Agent avatars: one image per role, org-wide. setAvatars replaces only the roles it carries.
  z.object({ op: z.literal('setAvatars'), avatars: z.array(avatarInputSchema).min(1).max(AVATAR_ROLES.length), by: z.string().nullable().default(null) }),
  z.object({ op: z.literal('listAvatars') }),
  z.object({ op: z.literal('getAvatar'), role: z.enum(AVATAR_ROLES) }),
  z.object({ op: z.literal('deleteAvatar'), role: z.enum(AVATAR_ROLES) }),
  // Themes (M12): custom manifests + pictures for any theme (built-ins live in code).
  z.object({ op: z.literal('listThemes') }),
  z.object({ op: z.literal('getTheme'), id: z.string().regex(THEME_ID_RE) }),
  z.object({ op: z.literal('putTheme'), manifest: themeManifestSchema, images: z.array(themeImageInputSchema).max(THEME_MAX_PICTURES).default([]), by: z.string().nullable().default(null) }),
  z.object({ op: z.literal('deleteTheme'), id: z.string().regex(THEME_ID_RE) }),
  z.object({ op: z.literal('setThemeImages'), themeId: z.string().regex(THEME_ID_RE), images: z.array(themeImageInputSchema).min(1).max(THEME_MAX_PICTURES), by: z.string().nullable().default(null) }),
  z.object({ op: z.literal('listThemeImages'), themeId: z.string().regex(THEME_ID_RE).nullable().default(null) }),
  z.object({ op: z.literal('getThemeImage'), themeId: z.string().regex(THEME_ID_RE), slot: z.enum(THEME_IMAGE_SLOTS), state: z.enum(THEME_IMAGE_STATES).optional() }),
  // No state: every picture the member has.
  z.object({ op: z.literal('deleteThemeImage'), themeId: z.string().regex(THEME_ID_RE), slot: z.enum(THEME_IMAGE_SLOTS), state: z.enum(THEME_IMAGE_STATES).optional() }),
  // Third-party skills: SKILL.md bundles, off until enabled. setSkillState without roles keeps the ones it has.
  z.object({ op: z.literal('listSkills') }),
  z.object({ op: z.literal('getSkill'), id: z.string().regex(SKILL_ID_RE) }),
  z.object({ op: z.literal('putSkill'), skill: skillInputSchema }),
  z.object({ op: z.literal('setSkillState'), id: z.string().regex(SKILL_ID_RE), enabled: z.boolean(), roles: skillRolesSchema.optional() }),
  z.object({ op: z.literal('deleteSkill'), id: z.string().regex(SKILL_ID_RE) }),
]);
export type RpcRequest = z.infer<typeof rpcRequestSchema>;

export const runWithTasksSchema = z.object({ run: runSchema, tasks: z.array(runTaskSchema) });
export type RunWithTasks = z.infer<typeof runWithTasksSchema>;

export interface RpcResults {
  createRun: RunWithTasks;
  getRun: RunWithTasks | null;
  getSplitFamily: SplitFamilyWire | null;
  resolveConflict: { ok: true };
  listRuns: { runs: z.infer<typeof runSchema>[]; total: number };
  getTasks: { tasks: z.infer<typeof runTaskSchema>[] };
  getEvents: { events: z.infer<typeof runEventSchema>[] };
  appendEvent: { event: z.infer<typeof runEventSchema> };
  cancelRun: RunWithTasks;
  resumeRun: RunWithTasks;
  listGates: { gates: GateWire[] };
  listArtifacts: { artifacts: ArtifactWire[] };
  listArtifactVersions: { versions: ArtifactVersionWire[] };
  taskProgress: { progress: Record<string, TaskProgressWire> };
  saveArtifact: { ok: true };
  resolveGate: { ok: true };
  getOrgSettings: { settings: Record<string, unknown> };
  putOrgSetting: { ok: true };
  deleteOrgSetting: { ok: true };
  putOrgSecret: { ok: true };
  deleteOrgSecret: { ok: true };
  getOrgSecret: { value: string | null };
  listOrgSecretNames: { names: string[]; secrets: { name: string; updatedAt: string }[] };
  recordCredentialHealth: { health: CredentialHealthWire };
  listFleet: FleetWire;
  monthCost: { totalUsd: number };
  monthUnpricedRuns: { count: number };
  enqueue: { entries: z.infer<typeof workQueueEntrySchema>[] };
  listQueue: { entries: z.infer<typeof workQueueEntrySchema>[] };
  reorderQueue: { ok: true };
  removeQueueEntry: { ok: true };
  readyQueueEntries: { entries: z.infer<typeof workQueueEntrySchema>[] };
  runsAwaitingExternalMerge: { runs: z.infer<typeof runSchema>[] };
  markQueueEntry: { ok: true };
  today: TodayWire;
  listNotifications: { notifications: NotificationWire[]; unread: number };
  markNotificationRead: { ok: true };
  clearNotifications: { ok: true };
  undeliveredNotifications: { notifications: NotificationWire[] };
  markNotificationDelivered: { ok: true };
  answerNeedsHuman: { ok: true };
  skipNeedsHuman: { ok: true };
  retryFailedTask: { ok: true };
  appendMessage: { message: RunMessageWire };
  listMessages: { messages: RunMessageWire[] };
  sendChatMessage: { message: RunMessageWire };
  requestChanges: { message: RunMessageWire };
  createAdhoc: { task: AdhocTask };
  getAdhoc: { task: AdhocTask | null };
  listAdhoc: { tasks: AdhocTask[] };
  deleteAdhoc: { ok: boolean };
  getAdhocAttachment: { attachment: AdhocAttachmentWire | null };
  listRecurring: { tasks: RecurringTask[] };
  getRecurring: { task: RecurringTask | null };
  createRecurring: { task: RecurringTask };
  updateRecurring: { task: RecurringTask };
  setRecurringPaused: { task: RecurringTask };
  deleteRecurring: { deleted: boolean };
  upcomingRecurring: { tasks: RecurringTask[] };
  setAvatars: { avatars: AvatarMetaWire[] };
  listAvatars: { avatars: AvatarMetaWire[] };
  getAvatar: { avatar: AvatarWire | null };
  deleteAvatar: { deleted: boolean };
  listThemes: { themes: ThemeRecordWire[] };
  getTheme: { theme: ThemeRecordWire | null };
  putTheme: { theme: ThemeRecordWire };
  deleteTheme: { deleted: boolean };
  setThemeImages: { images: ThemeImageMetaWire[] };
  listThemeImages: { images: ThemeImageMetaWire[] };
  getThemeImage: { image: ThemeImageWire | null };
  deleteThemeImage: { deleted: number };
  listSkills: { skills: ThirdPartySkill[] };
  getSkill: { skill: ThirdPartySkill | null };
  putSkill: { skill: ThirdPartySkill };
  setSkillState: { skill: ThirdPartySkill };
  deleteSkill: { deleted: boolean };
}

/** One credential's last live check (#139). failingSince/alertedAt are null while it works. */
export interface CredentialHealthWire {
  key: string; ok: boolean; reason: string | null;
  failingSince: string | null; alertedAt: string | null; checkedAt: string;
}

export interface NotificationWire {
  /** null for an org-level notification that belongs to no run (a failing credential). */
  id: string; runId: string | null; gateId: string | null; kind: string;
  title: string; body: string; actions: { label: string; url: string }[];
  createdAt: string; readAt: string | null; deliveredAt: string | null;
}

export interface WaitingRunWire {
  run: z.infer<typeof runSchema>;
  reason: 'gate' | 'needs_human';
  gateId: string | null;
  gateName: string | null;
  artifact: string | null;
}
/**
 * A running run on the Today view, with who is working on it (M12 WP5): the role
 * of its running task (null between tasks), each role's latest task state, and
 * when the running task started (for the mini-Hive's handoff moment).
 */
export type RunningRunWire = z.infer<typeof runSchema> & {
  activeRole: string | null;
  activeSince: string | null;
  roleStates: Record<string, string>;
};
export interface TodayWire {
  waitingOnYou: WaitingRunWire[];
  running: RunningRunWire[];
  queued: z.infer<typeof workQueueEntrySchema>[];
  doneToday: z.infer<typeof runSchema>[];
  /** Unpaused recurring tasks due in the next 24h, soonest first. */
  comingUp: { id: string; title: string; nextRunAt: string; scheduleText: string }[];
}

export interface FleetWorkerWire {
  id: string; host: string; runtimes: string[]; authMode: string | null;
  maxConcurrent: number; running: number; lastHeartbeat: string;
  /** One entry per runtime the worker is configured for, offered or not (#69). */
  preflight: RuntimeStatus[];
}
export interface FleetWire { workers: FleetWorkerWire[]; capacity: number; running: number; }

export interface GateWire {
  id: string; runId: string; gateName: string; mode: string; state: string;
  afterTask: string | null; artifact: string | null; decidedBy: string | null;
  note: string | null; editedArtifact: string | null; createdAt: string; decidedAt: string | null;
}
export interface ArtifactWire { name: string; content: string; updatedAt: string; }
/** One stored version of an artifact, tied to the task that produced it (M11 WP1). */
export interface ArtifactVersionWire { name: string; content: string; taskId: string | null; attempt: number | null; source: string; createdAt: string; }
/** Live progress for a running task (M11 WP5). */
export interface TaskProgressWire { taskId: string; toolCalls: number; lastTool: string | null; lastToolAt: string | null; startedAt: string | null; maxTurns: number | null; timeoutMs: number | null; }

/** The registry answers 409 with this body when a live run already exists for the ticket. */
export const runConflictSchema = z.object({ error: z.literal('run_conflict'), reason: z.string(), existingRunId: z.string() });
export type RunConflict = z.infer<typeof runConflictSchema>;

// --- worker <-> registry ---
/** What a worker last learned about one runtime: is the CLI installed, and did its auth preflight pass? (#69) */
export const runtimeStatusSchema = z.object({
  kind: z.string().min(1),
  /** The provider this status is for (M11 WP4: a runtime is checked once per provider it can serve). */
  provider: z.string().optional(),
  installed: z.boolean(),
  version: z.string().optional(),
  ok: z.boolean(),
  reason: z.string().optional(),
  checkedAt: z.string(),
});
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;

export const workerRegisterSchema = z.object({
  id: z.string().min(1),
  host: z.string().min(1),
  runtimes: z.array(z.string()).min(1),
  maxConcurrent: z.number().int().positive(),
  inFlightTaskIds: z.array(z.string()).default([]),
  authMode: z.string().optional(),
  preflight: z.array(runtimeStatusSchema).optional(),
});
export type WorkerRegister = z.infer<typeof workerRegisterSchema>;

/** A heartbeat may carry the latest runtime status; an empty body just says "alive". */
export const workerHeartbeatSchema = z.object({ preflight: z.array(runtimeStatusSchema).optional() });
export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;

/**
 * `capabilities` (M11 WP4): every `<runtime>@<providerKind>` pair this worker passed a
 * check for (`claude-code@anthropic`, `claude-code@ollama`). With it the registry hands
 * an Ollama-model task only to a worker offering `<runtime>@ollama`, and any other task
 * only to one offering the runtime under a non-Ollama provider. Absent (a pre-WP4
 * worker): runtime-only matching, as before.
 */
export const claimInputSchema = z.object({ runtimes: z.array(z.string()).min(1), capabilities: z.array(z.string()).optional() });
export const claimResponseSchema = z.object({ run: runSchema, task: runTaskSchema, team: teamTemplateSchema }).nullable();
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

export const finishTaskInputSchema = z.object({
  outcome: z.enum(['done', 'failed', 'needs_human']),
  outputRef: z.string().nullable().default(null),
  costUsd: z.number().nonnegative().default(0),
  reason: z.string().nullable().default(null),
});
export type FinishTaskInput = z.infer<typeof finishTaskInputSchema>;
