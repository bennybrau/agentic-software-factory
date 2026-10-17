import type { CreateRecurringTaskInput, RecurringTask, UpdateRecurringTaskInput, SplitFamilyWire, AdhocLimits, AdhocTask, AdhocFileInput, ActiveThemeWire, ThemeSummaryWire, ThemeImageRef, ArtifactWire, ArtifactVersionWire, TaskProgressWire, GateWire, RunMessageWire, Run, RunTask, RunEvent, SettingView, FleetWire, TodayWire, WorkQueueEntry, NotificationWire, TicketScope, TicketSprint, LocalWorkerStatus, UpdateStatus, ThirdPartySkill, SkillRole, VertexCheckState, OllamaSource, OllamaModelsResult, OllamaCheck } from '@asf/shared';

export interface TicketRow { id: string; key: string; title: string; bucket: string; priority: number | null; status: string; url: string; body: string; }
export interface RunDetail { run: Run; tasks: RunTask[]; gates: GateWire[]; artifacts: ArtifactWire[]; artifactVersions?: ArtifactVersionWire[]; taskProgress?: Record<string, TaskProgressWire>; messages?: RunMessageWire[]; split?: SplitFamilyWire | null;
  /** The schedule that created this run's ad-hoc task (#188); title is null once the schedule is deleted. */
  recurring?: { id: string; title: string | null } | null; }
export interface RunsQuery { state?: string; teamName?: string; deliveryOutcome?: string; search?: string; since?: string; limit?: number; offset?: number }
export interface Identity { user: string; verified: boolean; mode: string }
export interface Fleet extends FleetWire { monthCostUsd: number; monthUnpricedRuns?: number }
// Mirrors SetupItem/SetupStatus in apps/api/src/routes/setup.ts (the first-run checklist, #83).
export interface SetupItem { id: string; title: string; done: boolean; optional?: boolean; reason?: string; warning?: string; identity?: string; envPinned?: boolean; link: string; problem?: 'credential-rejected' | 'connection-failed' }
export interface SetupStatus { items: SetupItem[]; complete: boolean }
// Mirrors apps/api/src/routes/skills.ts: the list sends file sizes, not contents.
export type SkillSummary = Omit<ThirdPartySkill, 'files'> & { files: { path: string; size: number }[] };
export interface SkippedFile { path: string; reason: string }
/** What adding a link would store. Nothing is saved yet, so there's no id, enabled or roles. */
export type SkillPreview = Pick<ThirdPartySkill, 'name' | 'description' | 'sourceUrl' | 'sourceRef' | 'commitSha' | 'files'>;

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

/** A JSON request whose refusals carry a reason the UI shows as-is. Never throws on a 4xx. */
async function sendJson<T>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T & { reason?: string } }> {
  const r = await fetch(url, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as T & { reason?: string } };
}

// Ticket ids are provider-shaped and can carry both '/' and '#'
// (GitHub: `owner/repo#123`). The `/dispatch/*` splat route keeps slashes as
// path structure, so encode everything EXCEPT '/' when building the URL, then
// decode once on the way out. `#` MUST be encoded or the browser eats it as a
// fragment; React Router does not decode `%23` for us (only `%2F`), so we keep
// the id fully url-encoded apart from the slashes the splat expects.
export const encodeTicketId = (id: string) => encodeURIComponent(id).replace(/%2F/gi, '/');
export const decodeTicketId = (splat: string) => decodeURIComponent(splat);

export const api = {
  me: () => fetch('/api/me').then(j<Identity>),
  tickets: (q: { scope?: string[]; search?: string; bucket?: string[]; sprint?: string[]; status?: string[]; excludeDone?: boolean; updatedWithinDays?: number; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.scope?.length) p.set('scope', q.scope.join(','));
    if (q.search) p.set('search', q.search);
    if (q.bucket?.length) p.set('bucket', q.bucket.join(','));
    if (q.sprint?.length) p.set('sprint', q.sprint.join(','));
    if (q.status?.length) p.set('status', q.status.join(','));
    if (q.excludeDone) p.set('excludeDone', 'true');
    if (q.updatedWithinDays) p.set('updatedWithinDays', String(q.updatedWithinDays));
    if (q.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return fetch(`/api/tickets${qs ? `?${qs}` : ''}`).then(j<{ tickets: TicketRow[] }>);
  },
  findTickets: (q: string, prefixes: string[]) => fetch(`/api/tickets/find?q=${encodeURIComponent(q)}&prefixes=${encodeURIComponent(prefixes.join(','))}`).then(j<{ tickets: TicketRow[] }>),
  ticket: (id: string) => fetch(`/api/tickets/${encodeURIComponent(id)}`).then(j<TicketRow>),
  ticketScopes: () => fetch('/api/tickets/scopes').then(j<TicketScope[]>),
  ticketSprints: (scopeId: string) => fetch(`/api/tickets/scopes/${encodeURIComponent(scopeId)}/sprints`).then(j<TicketSprint[]>),
  ticketStatuses: (scope?: string) => fetch(`/api/tickets/statuses${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`).then(j<string[]>),
  dispatchPreview: (id: string) => fetch(`/api/tickets/${encodeURIComponent(id)}/dispatch`).then(j<{ ticket: { id: string; key: string; title: string }; team: unknown; gates: Record<string, { mode: string }>; repos: { id: string; path: string }[]; suggestedRepoId: string | null; whyNot: string[]; blocker: { code: string; reason: string; link: string } | null; models: { id: string; label: string; tier: string; runtimes: string[] }[]; runtimes: string[]; defaultModels: Record<string, string>; defaultRuntimes: Record<string, string>; efforts: string[]; defaultEfforts: Record<string, string | null>; orgDisabledRoles?: string[] }>),
  adhocLimits: () => fetch('/api/adhoc/limits').then(j<AdhocLimits>),
  createAdhoc: (body: { title: string; body: string; files: AdhocFileInput[]; chat?: boolean }) =>
    fetch('/api/adhoc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as { task?: AdhocTask; reason?: string } })),
  listAdhoc: () => fetch('/api/adhoc').then(j<{ tasks: AdhocTask[] }>),
  deleteAdhoc: (id: string) => fetch(`/api/adhoc/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(async (r) => ({ status: r.status })),
  listRecurring: () => fetch('/api/recurring').then(j<{ tasks: RecurringTask[] }>),
  createRecurring: (body: CreateRecurringTaskInput) =>
    fetch('/api/recurring', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as { task?: RecurringTask; reason?: string } })),
  updateRecurring: (id: string, patch: UpdateRecurringTaskInput) =>
    fetch(`/api/recurring/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as { task?: RecurringTask; reason?: string } })),
  setRecurringPaused: (id: string, paused: boolean) =>
    fetch(`/api/recurring/${encodeURIComponent(id)}/${paused ? 'pause' : 'resume'}`, { method: 'POST' }).then(j<{ task: RecurringTask }>),
  deleteRecurring: (id: string) => fetch(`/api/recurring/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(async (r) => ({ status: r.status })),
  theme: () => fetch('/api/theme').then(j<ActiveThemeWire>),
  themes: () => fetch('/api/themes').then(j<{ themes: ThemeSummaryWire[]; slots: string[]; maxMb: number; envPinned: boolean }>),
  setTheme: (id: string) => sendJson<ActiveThemeWire>('PUT', '/api/theme', { id }),
  addTheme: (zipBase64: string) => sendJson<{ theme?: { manifest: { id: string; name: string } }; pictures?: string[] }>('POST', '/api/themes', { zipBase64 }),
  deleteTheme: (id: string) => sendJson<{ ok?: true }>('DELETE', `/api/themes/${encodeURIComponent(id)}`),
  uploadThemePictures: (id: string, zipBase64: string) =>
    sendJson<{ images?: Record<string, ThemeImageRef>; replaced?: string[] }>('POST', `/api/themes/${encodeURIComponent(id)}/images`, { zipBase64 }),
  /** Without a state: every picture the member has. With one: just that picture. */
  deleteThemePicture: (id: string, slot: string, state?: string) =>
    sendJson<{ ok?: true; deleted?: number }>('DELETE', `/api/themes/${encodeURIComponent(id)}/images/${encodeURIComponent(slot)}${state ? `/${encodeURIComponent(state)}` : ''}`),
  startReadiness: () => fetch('/api/start-readiness').then(j<{ ok: true; repos: { id: string; path: string }[] } | { ok: false; code: string; reason: string; link: string }>),
  dispatch: (id: string, body: { repoId?: string; maxCostUsd?: number; by?: string; gateOverrides?: Record<string, { mode: string }>; modelOverrides?: Record<string, string>; effortOverrides?: Record<string, string>; runtimeOverrides?: Record<string, string>; skipRoles?: string[] }) =>
    fetch(`/api/tickets/${encodeURIComponent(id)}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() })),
  runs: (q: RunsQuery = {}) => {
    const p = new URLSearchParams();
    if (q.state) p.set('state', q.state);
    if (q.teamName) p.set('teamName', q.teamName);
    if (q.deliveryOutcome) p.set('deliveryOutcome', q.deliveryOutcome);
    if (q.search) p.set('search', q.search);
    if (q.since) p.set('since', q.since);
    p.set('limit', String(q.limit ?? 25));
    p.set('offset', String(q.offset ?? 0));
    return fetch(`/api/runs?${p.toString()}`).then(j<{ runs: Run[]; total: number }>);
  },
  run: (id: string) => fetch(`/api/runs/${encodeURIComponent(id)}`).then(j<RunDetail>),
  runReport: (id: string) => fetch(`/api/runs/${encodeURIComponent(id)}/report`).then(j<{ markdown: string }>),
  cancel: (id: string, by?: string | null) => fetch(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(by ? { by } : {}) }).then(j),
  resume: (id: string) => fetch(`/api/runs/${encodeURIComponent(id)}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(j),
  resolveConflict: (id: string) =>
    fetch(`/api/runs/${encodeURIComponent(id)}/resolve-conflict`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).reason ?? `resolve failed: ${r.status}`); }),
  retry: (id: string, note?: string) =>
    fetch(`/api/runs/${encodeURIComponent(id)}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) })
      .then(async (r) => ({ status: r.status, body: await r.json() as { ok?: boolean; reason?: string } })),
  answer: (id: string, reply: string, by: string) =>
    fetch(`/api/runs/${encodeURIComponent(id)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply, by }) })
      .then(async (r) => ({ status: r.status, body: await r.json() as { ok?: boolean; reason?: string } })),
  chat: (id: string, message: string, by: string) =>
    fetch(`/api/runs/${encodeURIComponent(id)}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, by }) })
      .then(async (r) => ({ status: r.status, body: await r.json() as { ok?: boolean; reason?: string } })),
  requestChanges: (id: string, message: string, by: string) =>
    fetch(`/api/runs/${encodeURIComponent(id)}/request-changes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, by }) })
      .then(async (r) => ({ status: r.status, body: await r.json() as { ok?: boolean; reason?: string } })),
  skipRole: (id: string, by: string) =>
    fetch(`/api/runs/${encodeURIComponent(id)}/skip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by }) })
      .then(async (r) => ({ status: r.status, body: await r.json() as { ok?: boolean; reason?: string } })),
  resolveGate: (gateId: string, decision: 'approve' | 'reject', by: string, note?: string, editedArtifact?: string) =>
    fetch(`/api/gates/${encodeURIComponent(gateId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, by, note, editedArtifact }) }).then(j),
  settings: () => fetch('/api/settings').then(j<{ settings: SettingView[] }>),
  putSetting: (key: string, value: unknown) =>
    fetch(`/api/settings/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) })
      .then(async (r) => ({ status: r.status, body: await r.json() as { settings?: SettingView[]; reason?: string } })),
  deleteSetting: (key: string) => fetch(`/api/settings/${encodeURIComponent(key)}`, { method: 'DELETE' }).then(j<{ settings: SettingView[] }>),
  ticketPreflight: () => fetch('/api/providers/ticket/preflight').then(j<{ kind?: string; ok: boolean; identity?: string; reason?: string }>),
  scmPreflight: () => fetch('/api/providers/scm/preflight').then(j<{ kind?: string; ok: boolean; identity?: string; reason?: string }>),
  models: () => fetch('/api/models').then(j<{ models: { id: string; label: string; tier: string; providerId: string; runtimes: string[] }[] }>),
  vertexCheckStart: (req: { projectId: string; region: string; models: string[] }) => sendJson<{ id: string }>('POST', '/api/providers/vertex/check', req),
  vertexCheck: (id: string) => fetch(`/api/providers/vertex/check/${encodeURIComponent(id)}`).then(j<VertexCheckState>),
  ollamaModels: (source: OllamaSource) => fetch(`/api/providers/ollama/models?source=${source}`).then(j<OllamaModelsResult>),
  ollamaCheck: (source: OllamaSource, model: string) => sendJson<OllamaCheck>('POST', '/api/providers/ollama/check', { source, model }),
  ollamaCatalogue: (models: { id: string; tier?: string }[]) => sendJson<{ ok?: boolean; models?: string[]; reason?: string }>('POST', '/api/providers/ollama/catalogue', { models }),
  openaiCheck: () => fetch('/api/providers/openai/check').then(j<{ ok: boolean; identity?: string; reason?: string; code?: string }>),
  fleet: () => fetch('/api/fleet').then(j<Fleet>),
  setupStatus: () => fetch('/api/setup/status').then(j<SetupStatus>),
  localWorker: () => fetch('/api/workers/local').then(j<LocalWorkerStatus>),
  startLocalWorker: () => fetch('/api/workers/local/start', { method: 'POST' }).then(j<LocalWorkerStatus>),
  today: () => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return fetch(`/api/today?since=${encodeURIComponent(d.toISOString())}`).then(j<TodayWire>);
  },
  queue: () => fetch('/api/queue').then(j<{ entries: WorkQueueEntry[] }>),
  enqueue: (items: { ticketId: string; ticketKey: string; ticketProvider: string; repoId?: string | null; maxCostUsd?: number | null }[], mode: 'serial' | 'parallel') =>
    fetch('/api/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items, mode }) })
      .then(async (r) => ({ status: r.status, body: await r.json() as { added?: number; skipped?: number; reason?: string } })),
  reorderQueue: (id: string, beforeId: string | null) =>
    fetch(`/api/queue/${encodeURIComponent(id)}/reorder`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ beforeId }) }).then(j),
  removeQueueEntry: (id: string) => fetch(`/api/queue/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(j),
  notifications: (unreadOnly = false) => fetch(`/api/notifications${unreadOnly ? '?unreadOnly=true' : ''}`).then(j<{ notifications: NotificationWire[]; unread: number }>),
  markNotificationsRead: (id: string | null) => fetch('/api/notifications/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).then(j),
  clearNotifications: () => fetch('/api/notifications/clear', { method: 'POST' }).then(j),
  updates: () => fetch('/api/updates').then(j<UpdateStatus>),
  checkUpdates: () => fetch('/api/updates/check', { method: 'POST' }).then(j<UpdateStatus>),
  /** 409 = refused, 502 = the supervisor failed; both carry a `reason` to show as-is. */
  applyUpdate: () => sendJson<{ started?: boolean; version?: string }>('POST', '/api/updates/apply'),
  skills: () => fetch('/api/skills').then(j<{ skills: SkillSummary[] }>),
  previewSkill: (url: string) => sendJson<{ skill?: SkillPreview; skipped?: SkippedFile[] }>('POST', '/api/skills/preview', { url }),
  addSkill: (url: string, id?: string) => sendJson<{ skill?: SkillSummary; skipped?: SkippedFile[] }>('POST', '/api/skills', id ? { url, id } : { url }),
  setSkillState: (id: string, state: { enabled?: boolean; roles?: SkillRole[] }) =>
    sendJson<{ skill?: SkillSummary }>('PATCH', `/api/skills/${encodeURIComponent(id)}`, state),
  refreshSkill: (id: string) => sendJson<{ skill?: SkillSummary; skipped?: SkippedFile[] }>('POST', `/api/skills/${encodeURIComponent(id)}/refresh`),
  deleteSkill: (id: string) => sendJson<{ ok?: true }>('DELETE', `/api/skills/${encodeURIComponent(id)}`),
  health: () => fetch('/health').then(j<{ ok: boolean }>),
};

/** Subscribe to the run event stream. Calls back on every run:event frame. */
export function subscribeEvents(onEvent: (e: RunEvent) => void): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('run:event', (ev) => { try { onEvent(JSON.parse((ev as MessageEvent).data)); } catch { /* ignore */ } });
  return () => es.close();
}
