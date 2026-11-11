import type { FastifyInstance } from 'fastify';
import { rpcRequestSchema, adhocBodyLimitBytes, avatarBodyLimitBytes, themeBodyLimitBytes, skillBodyLimitBytes, resolve } from '@asf/shared';
import type { RpcRequest, RpcResults } from '@asf/shared';
import type { Sql } from '../db/pool.js';
import * as store from '../runs/store.js';
import * as gatesStore from '../runs/gates-store.js';
import { resolveGate, retryFailedTask } from '../runs/gates.js';
import { getOrgSettings, putOrgSetting, deleteOrgSetting } from '../settings/store.js';
import { putOrgSecret, deleteOrgSecret, getOrgSecret, listOrgSecrets, SecretKeyError } from '../settings/secret-store.js';
import { recordCredentialHealth, resetCredentialHealth } from '../settings/credential-health.js';
import { listFleet, monthCostUsd, monthUnpricedRuns } from '../runs/workers.js';
import * as queue from '../runs/queue-store.js';
import { today } from '../runs/today-store.js';
import * as notifications from '../runs/notification-store.js';
import { answerNeedsHuman, skipNeedsHuman, NeedsHumanError } from '../runs/needs-human.js';
import { appendMessage, listMessages, sendChatMessage, requestChanges, ChatError } from '../runs/chat.js';
import * as adhoc from '../runs/adhoc-store.js';
import { hiveDialog } from '../runs/hive-dialog.js';
import { getSplitFamily } from '../runs/split.js';
import { resolveConflict, ConflictError } from '../runs/conflict.js';
import { advance } from '../runs/orchestrate.js';
import * as avatars from '../runs/avatar-store.js';
import * as themes from '../runs/theme-store.js';
import * as skills from '../runs/skill-store.js';
import * as recurring from '../runs/recurring-store.js';
import { qualifyStoredRefs, RefsBackfillError } from '../runs/refs-backfill.js';
import { config } from '../config.js';

type Handler = { [K in RpcRequest['op']]: (req: Extract<RpcRequest, { op: K }>) => Promise<RpcResults[K]> };

export function rpcHandlers(sql: Sql): Handler {
  return {
    createRun: (r) => store.createRun(sql, r.input),
    getRun: (r) => store.getRun(sql, r.id),
    getSplitFamily: (r) => getSplitFamily(sql, r.runId),
    resolveConflict: async (r) => { await resolveConflict(sql, r.runId, r.by); await advance(sql, r.runId); return { ok: true as const }; },
    listRuns: async (r) => {
      const { runs, total } = await store.listRuns(sql, {
        ticketId: r.ticketId, state: r.state, teamName: r.teamName, deliveryOutcome: r.deliveryOutcome,
        search: r.search, since: r.since, limit: r.limit, offset: r.offset,
      });
      return { runs, total };
    },
    getTasks: async (r) => ({ tasks: await store.getTasks(sql, r.runId) }),
    getEvents: async (r) => ({ events: await store.getEvents(sql, r.runId, r.afterSeq, r.limit) }),
    appendEvent: async (r) => ({ event: await store.appendEvent(sql, r.input) }),
    cancelRun: (r) => store.requestCancel(sql, r.id, r.by),
    resumeRun: (r) => store.resumeRun(sql, r.id, r.by),
    listGates: async (r) => ({ gates: await gatesStore.listGates(sql, r.runId) }),
    listArtifacts: async (r) => ({ artifacts: await gatesStore.listArtifacts(sql, r.runId) }),
    listArtifactVersions: async (r) => ({ versions: await gatesStore.listArtifactVersions(sql, r.runId) }),
    taskProgress: async (r) => ({ progress: await store.taskProgress(sql, r.taskIds) }),
    saveArtifact: async (r) => { await gatesStore.saveArtifact(sql, r.runId, r.name, r.content, { taskId: r.taskId, source: r.source }); return { ok: true as const }; },
    getOrgSettings: async () => ({ settings: (await getOrgSettings(sql)) as Record<string, unknown> }),
    putOrgSetting: async (r) => { await putOrgSetting(sql, r.key, r.value, r.by); return { ok: true as const }; },
    deleteOrgSetting: async (r) => { await deleteOrgSetting(sql, r.key); return { ok: true as const }; },
    // Re-saving or clearing a secret resets its health, so a later failure alerts again.
    putOrgSecret: async (r) => { await putOrgSecret(sql, r.name, r.value, r.by); await resetCredentialHealth(sql, r.name); return { ok: true as const }; },
    deleteOrgSecret: async (r) => { await deleteOrgSecret(sql, r.name); await resetCredentialHealth(sql, r.name); return { ok: true as const }; },
    getOrgSecret: async (r) => ({ value: await getOrgSecret(sql, r.name) }),
    listOrgSecretNames: async () => { const secrets = await listOrgSecrets(sql); return { names: secrets.map((s) => s.name), secrets }; },
    recordCredentialHealth: async (r) => ({ health: await recordCredentialHealth(sql, r) }),
    listFleet: async () => listFleet(sql, config.workerTtlSeconds),
    monthCost: async () => ({ totalUsd: await monthCostUsd(sql) }),
    monthUnpricedRuns: async () => ({ count: await monthUnpricedRuns(sql) }),
    enqueue: async (r) => ({ entries: await queue.enqueue(sql, r.items, r.mode, r.by) }),
    listQueue: async (r) => ({ entries: await queue.listQueue(sql, { state: r.state, limit: r.limit }) }),
    reorderQueue: async (r) => { await queue.reorderQueue(sql, r.id, r.beforeId); return { ok: true as const }; },
    removeQueueEntry: async (r) => { await queue.removeQueueEntry(sql, r.id, r.by); return { ok: true as const }; },
    readyQueueEntries: async (r) => ({ entries: await queue.readyQueueEntries(sql, r.limit) }),
    runsAwaitingExternalMerge: async (r) => ({ runs: await store.runsAwaitingExternalMerge(sql, r.limit) }),
    hiveMergedRuns: async (r) => ({ runs: await store.hiveMergedRuns(sql, { since: r.since, limit: r.limit, offset: r.offset }) }),
    hiveDialog: async (r) => ({ items: await hiveDialog(sql, { since: r.since, limit: r.limit, offset: r.offset }) }),
    markQueueEntry: async (r) => { await queue.markQueueEntry(sql, r.id, r.state, r.runId, r.reason); return { ok: true as const }; },
    today: async (r) => today(sql, new Date(r.since)),
    listNotifications: async (r) => notifications.listNotifications(sql, { unreadOnly: r.unreadOnly, limit: r.limit }),
    markNotificationRead: async (r) => { await notifications.markNotificationRead(sql, r.id); return { ok: true as const }; },
    clearNotifications: async () => { await notifications.clearNotifications(sql); return { ok: true as const }; },
    undeliveredNotifications: async (r) => ({ notifications: await notifications.undeliveredNotifications(sql, r.limit) }),
    markNotificationDelivered: async (r) => { await notifications.markNotificationDelivered(sql, r.id); return { ok: true as const }; },
    answerNeedsHuman: async (r) => { await answerNeedsHuman(sql, r.runId, r.reply, r.by); return { ok: true as const }; },
    skipNeedsHuman: async (r) => { await skipNeedsHuman(sql, r.runId, r.by); return { ok: true as const }; },
    resolveGate: async (r) => { await resolveGate(sql, r.gateId, { decision: r.decision, by: r.by, note: r.note, editedArtifact: r.editedArtifact }); return { ok: true as const }; },
    retryFailedTask: async (r) => { await retryFailedTask(sql, r.runId, r.note, r.by); return { ok: true as const }; },
    appendMessage: async (r) => ({ message: await appendMessage(sql, r.input) }),
    listMessages: async (r) => ({ messages: await listMessages(sql, r.runId) }),
    sendChatMessage: async (r) => ({ message: await sendChatMessage(sql, r.runId, r.body, r.by) }),
    requestChanges: async (r) => ({ message: await requestChanges(sql, r.runId, r.body, r.by) }),
    createAdhoc: async (r) => ({ task: await adhoc.createAdhoc(sql, r.input) }),
    getAdhoc: async (r) => ({ task: await adhoc.getAdhoc(sql, r.id) }),
    listAdhoc: async () => ({ tasks: await adhoc.listAdhoc(sql) }),
    deleteAdhoc: async (r) => ({ ok: await adhoc.deleteAdhoc(sql, r.id) }),
    getAdhocAttachment: async (r) => ({ attachment: await adhoc.getAdhocAttachment(sql, r.id, r.name) }),
    listRecurring: async () => ({ tasks: await recurring.listRecurring(sql) }),
    getRecurring: async (r) => ({ task: await recurring.getRecurring(sql, r.id) }),
    createRecurring: async (r) => ({ task: await recurring.createRecurring(sql, r.input, r.by) }),
    updateRecurring: async (r) => ({ task: await recurring.updateRecurring(sql, r.id, r.patch) }),
    setRecurringPaused: async (r) => ({ task: await recurring.setRecurringPaused(sql, r.id, r.paused) }),
    deleteRecurring: async (r) => ({ deleted: await recurring.deleteRecurring(sql, r.id) }),
    upcomingRecurring: async (r) => ({ tasks: await recurring.upcomingRecurring(sql, r.withinHours) }),
    setAvatars: async (r) => ({ avatars: await avatars.setAvatars(sql, r.avatars, r.by) }),
    listAvatars: async () => ({ avatars: await avatars.listAvatars(sql) }),
    getAvatar: async (r) => ({ avatar: await avatars.getAvatar(sql, r.role) }),
    deleteAvatar: async (r) => ({ deleted: await avatars.deleteAvatar(sql, r.role) }),
    listThemes: async () => ({ themes: await themes.listThemes(sql) }),
    getTheme: async (r) => ({ theme: await themes.getTheme(sql, r.id) }),
    putTheme: async (r) => ({ theme: await themes.putTheme(sql, r.manifest, r.images, r.by) }),
    deleteTheme: async (r) => ({ deleted: await themes.deleteTheme(sql, r.id) }),
    setThemeImages: async (r) => ({ images: await themes.setThemeImages(sql, r.themeId, r.images, r.by) }),
    listThemeImages: async (r) => ({ images: await themes.listThemeImages(sql, r.themeId) }),
    getThemeImage: async (r) => ({ image: await themes.getThemeImage(sql, r.themeId, r.slot, r.state) }),
    deleteThemeImage: async (r) => ({ deleted: await themes.deleteThemeImage(sql, r.themeId, r.slot, r.state ?? null) }),
    listSkills: async () => ({ skills: await skills.listSkills(sql) }),
    getSkill: async (r) => ({ skill: await skills.getSkill(sql, r.id) }),
    putSkill: async (r) => ({ skill: await skills.putSkill(sql, r.skill) }),
    setSkillState: async (r) => ({ skill: await skills.setSkillState(sql, r.id, r.enabled, r.roles) }),
    deleteSkill: async (r) => ({ deleted: await skills.deleteSkill(sql, r.id) }),
    qualifyStoredRefs: (r) => qualifyStoredRefs(sql, { scm: r.scm, tickets: r.tickets }),
  };
}

export function registerRpc(app: FastifyInstance, sql: Sql): void {
  const handlers = rpcHandlers(sql);
  // createAdhoc, setAvatars, putTheme, setThemeImages and putSkill carry files inline, so the RPC body may be as big as
  // the api's upload routes allow; every other op stays far below it.
  const bodyLimit = Math.max(
    adhocBodyLimitBytes({ maxFiles: resolve('ADHOC_MAX_ATTACHMENTS'), maxFileMb: resolve('ADHOC_MAX_ATTACHMENT_MB') }),
    avatarBodyLimitBytes(resolve('AVATAR_MAX_MB')),
    themeBodyLimitBytes(resolve('AVATAR_MAX_MB')),
    skillBodyLimitBytes(),
  );
  app.post('/internal/rpc', { bodyLimit }, async (req, reply) => {
    const parsed = rpcRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const r = parsed.data;
    try {
      // The cast is the one place the union is erased; `Handler` keeps every op typed.
      const result = await (handlers[r.op] as (x: RpcRequest) => Promise<unknown>)(r);
      return { ok: true, result };
    } catch (err) {
      if (err instanceof store.RunConflictError) {
        return reply.code(409).send({ error: 'run_conflict', reason: err.message, existingRunId: err.existingRunId });
      }
      if (err instanceof store.NotFoundError) return reply.code(404).send({ error: 'not_found', reason: err.message });
      if ((err as Error).name === 'GateError') return reply.code(409).send({ error: 'gate_error', reason: (err as Error).message });
      if (err instanceof NeedsHumanError) return reply.code(409).send({ error: 'needs_human_error', reason: err.message });
      if (err instanceof ChatError) return reply.code(409).send({ error: 'chat_error', reason: err.message });
      if (err instanceof themes.ThemeError) return reply.code(409).send({ error: 'theme_error', reason: err.message });
      if (err instanceof skills.SkillError) return reply.code(409).send({ error: 'skill_error', reason: err.message });
      if (err instanceof ConflictError) return reply.code(409).send({ error: 'conflict_error', reason: err.message });
      if (err instanceof RefsBackfillError) return reply.code(409).send({ error: 'refs_backfill_error', reason: err.message });
      if (err instanceof SecretKeyError) return reply.code(409).send({ error: 'secret_key_error', reason: err.message });
      if ((err as Error).name === 'SettingError') return reply.code(400).send({ error: 'setting_error', reason: (err as Error).message });
      throw err;
    }
  });
}
