import type { AvatarInput, AvatarRole, SkillInput, SkillRole, ThemeImageInput, ThemeImageSlot, ThemeImageState, ThemeManifest, CreateRecurringTaskInput, RpcRequest, RpcResults, RunContext, RunState, UpdateRecurringTaskInput } from '@asf/shared';
import { config } from '../config.js';

/**
 * The api's client for the registry. One typed method per RPC op; the registry
 * owns run state and the api never touches Postgres. A 409 from createRun is
 * surfaced as RunConflict so a dispatch route can turn it into an HTTP 409.
 */
export class RunConflict extends Error {
  constructor(public readonly existingRunId: string, reason: string) { super(reason); }
}

/**
 * A saved token exists but the registry can't decrypt it (#9): ASF_SECRET_KEY is
 * missing or is not the key it was saved with. Distinct from "not set" — the fix
 * is restoring the key, not pasting a new token over a good one.
 */
export class SavedSecretUnreadable extends Error {
  constructor(reason: string) { super(reason); this.name = 'SavedSecretUnreadable'; }
}

async function rpc<K extends RpcRequest['op']>(body: Extract<RpcRequest, { op: K }>): Promise<RpcResults[K]> {
  const res = await fetch(`${config.registryUrl}/internal/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-run-secret': config.runEventSecret },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok?: boolean; result?: unknown; error?: string; reason?: string; existingRunId?: string };
  if (res.status === 409 && json.error === 'secret_key_error') throw new SavedSecretUnreadable(json.reason ?? 'saved token cannot be decrypted (ASF_SECRET_KEY)');
  if (res.status === 409 && json.error === 'run_conflict') throw new RunConflict(json.existingRunId ?? 'unknown', json.reason ?? 'run conflict');
  // A 401 means the shared X-Run-Secret does not match between the api and the registry.
  const hint = res.status === 401 ? ' — RUN_EVENT_SECRET mismatch: set the same value in .env for registry, api and worker and restart all three' : '';
  if (!res.ok || !json.ok) throw new Error(`registry rpc ${body.op} failed: ${res.status} ${json.reason ?? json.error ?? ''}${hint}`);
  return json.result as RpcResults[K];
}

export const registry = {
  createRun: (input: Extract<RpcRequest, { op: 'createRun' }>['input']) => rpc({ op: 'createRun', input }),
  getRun: (id: string) => rpc({ op: 'getRun', id }),
  getSplitFamily: (runId: string) => rpc({ op: 'getSplitFamily', runId }),
  resolveConflict: (runId: string, by: string | null) => rpc({ op: 'resolveConflict', runId, by }),
  getEvents: (runId: string, afterSeq = 0, limit = 1000) => rpc({ op: 'getEvents', runId, afterSeq, limit }),
  getTaskEvents: (runId: string, taskId: string, q: { kinds: string[]; beforeSeq?: number; afterSeq?: number; limit: number }) =>
    rpc({ op: 'getTaskEvents', runId, taskId, kinds: q.kinds, beforeSeq: q.beforeSeq, afterSeq: q.afterSeq, limit: q.limit }),
  appendEvent: (input: Extract<RpcRequest, { op: 'appendEvent' }>['input']) => rpc({ op: 'appendEvent', input }),
  listRuns: (q: { ticketId?: string; state?: RunState; teamName?: string; deliveryOutcome?: 'merged' | 'awaiting_external_merge' | 'no_repo' | 'split'; search?: string; since?: string; limit?: number; offset?: number }) =>
    rpc({ op: 'listRuns', ticketId: q.ticketId, state: q.state, teamName: q.teamName, deliveryOutcome: q.deliveryOutcome, search: q.search, since: q.since, limit: q.limit ?? 50, offset: q.offset ?? 0 }),
  listGates: (runId: string) => rpc({ op: 'listGates', runId }),
  listArtifacts: (runId: string) => rpc({ op: 'listArtifacts', runId }),
  listArtifactVersions: (runId: string) => rpc({ op: 'listArtifactVersions', runId }),
  taskProgress: (taskIds: string[]) => rpc({ op: 'taskProgress', taskIds }),
  saveArtifact: (runId: string, name: string, content: string, opts: { taskId?: string | null; source?: string } = {}) =>
    rpc({ op: 'saveArtifact', runId, name, content, taskId: opts.taskId ?? null, source: opts.source ?? 'agent' }),
  resolveGate: (input: Extract<RpcRequest, { op: 'resolveGate' }>) => rpc(input),
  cancelRun: (id: string, by: string | null) => rpc({ op: 'cancelRun', id, by }),
  resumeRun: (id: string, by: string | null) => rpc({ op: 'resumeRun', id, by }),
  getOrgSettings: () => rpc({ op: 'getOrgSettings' }),
  putOrgSetting: (key: string, value: unknown, by: string | null) => rpc({ op: 'putOrgSetting', key, value, by }),
  deleteOrgSetting: (key: string) => rpc({ op: 'deleteOrgSetting', key }),
  putOrgSecret: (name: string, value: string, by: string | null) => rpc({ op: 'putOrgSecret', name, value, by }),
  deleteOrgSecret: (name: string) => rpc({ op: 'deleteOrgSecret', name }),
  getOrgSecret: (name: string) => rpc({ op: 'getOrgSecret', name }),
  listOrgSecretNames: () => rpc({ op: 'listOrgSecretNames' }),
  recordCredentialHealth: (h: Omit<Extract<RpcRequest, { op: 'recordCredentialHealth' }>, 'op'>) => rpc({ op: 'recordCredentialHealth', ...h }),
  listFleet: () => rpc({ op: 'listFleet' }),
  monthCost: () => rpc({ op: 'monthCost' }),
  monthUnpricedRuns: () => rpc({ op: 'monthUnpricedRuns' }),
  enqueue: (input: Omit<Extract<RpcRequest, { op: 'enqueue' }>, 'op'>) => rpc({ op: 'enqueue', ...input }),
  listQueue: (q: { state?: Extract<RpcRequest, { op: 'listQueue' }>['state']; limit?: number } = {}) => rpc({ op: 'listQueue', state: q.state, limit: q.limit ?? 200 }),
  reorderQueue: (id: string, beforeId: string | null) => rpc({ op: 'reorderQueue', id, beforeId }),
  removeQueueEntry: (id: string, by: string | null) => rpc({ op: 'removeQueueEntry', id, by }),
  readyQueueEntries: (limit?: number) => rpc({ op: 'readyQueueEntries', limit: limit ?? 20 }),
  runsAwaitingExternalMerge: (limit?: number) => rpc({ op: 'runsAwaitingExternalMerge', limit: limit ?? 50 }),
  hiveMergedRuns: (q: { since?: string; limit?: number; offset?: number } = {}) =>
    rpc({ op: 'hiveMergedRuns', since: q.since, limit: q.limit ?? 500, offset: q.offset ?? 0 }),
  hiveDialog: (q: { since?: string; limit?: number; offset?: number } = {}) =>
    rpc({ op: 'hiveDialog', since: q.since, limit: q.limit ?? 500, offset: q.offset ?? 0 }),
  markHiveSent: (kind: 'gate' | 'msg', id: string) => rpc({ op: 'markHiveSent', kind, id }),
  markQueueEntry: (id: string, state: 'dispatched' | 'failed', runId: string | null, reason: string | null, code: string | null = null) =>
    rpc({ op: 'markQueueEntry', id, state, runId, reason, code }),
  retryQueueEntry: (id: string, by: string | null) => rpc({ op: 'retryQueueEntry', id, by }),
  today: (since: string) => rpc({ op: 'today', since }),
  listNotifications: (q: { unreadOnly?: boolean; limit?: number } = {}) => rpc({ op: 'listNotifications', unreadOnly: q.unreadOnly ?? false, limit: q.limit ?? 50 }),
  markNotificationRead: (id: string | null) => rpc({ op: 'markNotificationRead', id }),
  clearNotifications: () => rpc({ op: 'clearNotifications' }),
  undeliveredNotifications: (limit?: number) => rpc({ op: 'undeliveredNotifications', limit: limit ?? 20 }),
  markNotificationDelivered: (id: string) => rpc({ op: 'markNotificationDelivered', id }),
  answerNeedsHuman: (runId: string, reply: string, by: string | null) => rpc({ op: 'answerNeedsHuman', runId, reply, by }),
  skipNeedsHuman: (runId: string, by: string | null) => rpc({ op: 'skipNeedsHuman', runId, by }),
  retryFailedTask: (runId: string, note: string | null, by: string | null) => rpc({ op: 'retryFailedTask', runId, note, by }),
  listMessages: (runId: string) => rpc({ op: 'listMessages', runId }),
  sendChatMessage: (runId: string, body: string, by: string | null) => rpc({ op: 'sendChatMessage', runId, body, by }),
  requestChanges: (runId: string, body: string, by: string | null) => rpc({ op: 'requestChanges', runId, body, by }),
  createAdhoc: (input: Extract<RpcRequest, { op: 'createAdhoc' }>['input']) => rpc({ op: 'createAdhoc', input }),
  getAdhoc: (id: string) => rpc({ op: 'getAdhoc', id }),
  listAdhoc: () => rpc({ op: 'listAdhoc' }),
  deleteAdhoc: (id: string) => rpc({ op: 'deleteAdhoc', id }),
  getAdhocAttachment: (id: string, name: string) => rpc({ op: 'getAdhocAttachment', id, name }),
  listRecurring: () => rpc({ op: 'listRecurring' }),
  getRecurring: (id: string) => rpc({ op: 'getRecurring', id }),
  createRecurring: (input: CreateRecurringTaskInput, by: string | null) => rpc({ op: 'createRecurring', input, by }),
  updateRecurring: (id: string, patch: UpdateRecurringTaskInput) => rpc({ op: 'updateRecurring', id, patch }),
  setRecurringPaused: (id: string, paused: boolean) => rpc({ op: 'setRecurringPaused', id, paused }),
  deleteRecurring: (id: string) => rpc({ op: 'deleteRecurring', id }),
  upcomingRecurring: (withinHours: number) => rpc({ op: 'upcomingRecurring', withinHours }),
  setAvatars: (avatars: AvatarInput[], by: string | null) => rpc({ op: 'setAvatars', avatars, by }),
  listAvatars: () => rpc({ op: 'listAvatars' }),
  getAvatar: (role: AvatarRole) => rpc({ op: 'getAvatar', role }),
  deleteAvatar: (role: AvatarRole) => rpc({ op: 'deleteAvatar', role }),
  listThemes: () => rpc({ op: 'listThemes' }),
  getTheme: (id: string) => rpc({ op: 'getTheme', id }),
  putTheme: (manifest: ThemeManifest, images: ThemeImageInput[], by: string | null) => rpc({ op: 'putTheme', manifest, images, by }),
  deleteTheme: (id: string) => rpc({ op: 'deleteTheme', id }),
  setThemeImages: (themeId: string, images: ThemeImageInput[], by: string | null) => rpc({ op: 'setThemeImages', themeId, images, by }),
  listThemeImages: (themeId: string | null) => rpc({ op: 'listThemeImages', themeId }),
  getThemeImage: (themeId: string, slot: ThemeImageSlot, state: ThemeImageState = 'any') => rpc({ op: 'getThemeImage', themeId, slot, state }),
  /** No `state`: delete every picture the member has. */
  deleteThemeImage: (themeId: string, slot: ThemeImageSlot, state?: ThemeImageState) => rpc({ op: 'deleteThemeImage', themeId, slot, ...(state ? { state } : {}) }),
  listSkills: () => rpc({ op: 'listSkills' }),
  getSkill: (id: string) => rpc({ op: 'getSkill', id }),
  putSkill: (skill: SkillInput) => rpc({ op: 'putSkill', skill }),
  /** No `roles`: keep the ones the skill has. */
  setSkillState: (id: string, enabled: boolean, roles?: SkillRole[]) => rpc({ op: 'setSkillState', id, enabled, ...(roles ? { roles } : {}) }),
  deleteSkill: (id: string) => rpc({ op: 'deleteSkill', id }),
  qualifyStoredRefs: (scm: string, tickets: string) => rpc({ op: 'qualifyStoredRefs', scm, tickets }),
};

export type { RunContext };
