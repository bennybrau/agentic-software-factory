import type { VertexCheckRequest, VertexCheckResult } from '@asf/shared';
import { googleLoginHealthKey } from '@asf/shared';
import type { AdhocTask, ClaimResponse, CreateAdhocInput, FinishTaskInput, RunContext, RunMessageInput, RunMessageWire, RuntimeStatus, WorkerRegister } from '@asf/shared';
import { claimResponseSchema, runContextSchema } from '@asf/shared';
import { config } from './config.js';

/**
 * The client for both hosts. The registry for the fleet (register, heartbeat,
 * claim, deregister); the api for the work (run context, which needs a
 * credential the registry does not hold). Every call carries X-Run-Secret.
 */
const headers = () => ({ 'content-type': 'application/json', 'x-run-secret': config.runEventSecret });

/** A 401 from any host means the shared X-Run-Secret does not match; point at the fix. */
const authHint = (status: number) =>
  status === 401 ? ' — RUN_EVENT_SECRET mismatch: set the same value in .env for registry, api and worker and restart all three' : '';

async function post(base: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body ?? {}) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${JSON.stringify(json)}${authHint(res.status)}`);
  return json;
}

/** GET /api/agent-auth: anthropic's status at the top level (pre-M8 shape) plus, from
 * an M8 api, one status per provider. Never carries a credential. */
export interface AgentAuthStatus {
  mode: string; credentialPresent: boolean;
  providers?: Partial<Record<string, { mode: string; credentialPresent: boolean; baseUrl?: string }>>;
}

export const api = {
  async register(reg: Omit<WorkerRegister, 'id' | 'host'>): Promise<{ staled: string[] }> {
    return post(config.registryUrl, '/workers/register', { id: config.id, host: config.host, ...reg }) as Promise<{ staled: string[] }>;
  },
  /** Alive, plus the latest status of every configured runtime (#69). */
  /** 'unknown' = the registry has no record of this worker (404): register again. */
  async heartbeat(preflight?: RuntimeStatus[]): Promise<'ok' | 'unknown' | 'error'> {
    const res = await fetch(`${config.registryUrl}/workers/${config.id}/heartbeat`, { method: 'POST', headers: headers(), body: JSON.stringify(preflight ? { preflight } : {}) }).catch(() => null);
    return !res ? 'error' : res.ok ? 'ok' : res.status === 404 ? 'unknown' : 'error';
  },
  /** The api's current effective auth mode (+ whether its credential is present, never
   * the credential). Used at boot and to notice an org-side mode change and re-register
   * without a restart. */
  async agentAuth(): Promise<AgentAuthStatus | null> {
    const res = await fetch(`${config.bffUrl}/api/agent-auth`, { headers: headers() }).catch(() => null);
    if (!res || !res.ok) return null;
    return res.json().catch(() => null) as Promise<AgentAuthStatus | null>;
  },
  /** Take the oldest queued Vertex check (M9); null when none waits or the api is unreachable. */
  async vertexCheckNext(): Promise<{ id: string; request: VertexCheckRequest } | null> {
    const res = await fetch(`${config.bffUrl}/api/agent-checks/vertex/next`, { method: 'POST', headers: headers(), body: JSON.stringify({ worker: config.id }) }).catch(() => null);
    if (!res || !res.ok) return null;
    const j = await res.json().catch(() => ({})) as { check?: { id: string; request: VertexCheckRequest } | null };
    return j.check ?? null;
  },
  async vertexCheckResult(id: string, result: VertexCheckResult): Promise<void> {
    await post(config.bffUrl, `/api/agent-checks/vertex/${encodeURIComponent(id)}`, { worker: config.id, result });
  },
  /** M9 #2: this worker's Google login health; the first failure of a streak notifies once. */
  async recordLoginHealth(h: { ok: boolean; reason: string | null; fix?: string }): Promise<void> {
    await post(config.registryUrl, '/internal/rpc', {
      op: 'recordCredentialHealth', key: googleLoginHealthKey(config.id), ok: h.ok, reason: h.reason,
      label: `Google login on worker ${config.id}`, link: '/setup', ...(h.fix ? { fix: h.fix } : {}),
    });
  },
  async deregister(): Promise<void> {
    await fetch(`${config.registryUrl}/workers/${config.id}/deregister`, { method: 'POST', headers: headers(), body: '{}' }).catch(() => {});
  },
  /** `capabilities`: the offered `<runtime>@<provider>` pairs (M11 WP4); the registry routes by them. */
  async claim(runtimes: string[], capabilities?: string[]): Promise<ClaimResponse> {
    const json = (await post(config.registryUrl, `/workers/${config.id}/claim`, { runtimes, ...(capabilities ? { capabilities } : {}) })) as { claim: unknown };
    return claimResponseSchema.parse(json.claim);
  },
  async finish(taskId: string, input: FinishTaskInput): Promise<void> {
    await post(config.registryUrl, `/tasks/${taskId}/finish`, input);
  },
  async context(runId: string): Promise<RunContext> {
    const res = await fetch(`${config.bffUrl}/api/runs/${runId}/context`, { headers: headers() });
    if (!res.ok) throw new Error(`context ${runId} -> ${res.status}${authHint(res.status)}`);
    return runContextSchema.parse(await res.json());
  },
  /** One file attached to the run's ad-hoc task (#179), as raw bytes. */
  async attachment(runId: string, name: string): Promise<Buffer> {
    const res = await fetch(`${config.bffUrl}/api/runs/${runId}/attachments/${encodeURIComponent(name)}`, { headers: headers() });
    if (!res.ok) throw new Error(`attachment ${name} of ${runId} -> ${res.status}${authHint(res.status)}`);
    return Buffer.from(await res.arrayBuffer());
  },
  /** Whether the operator has asked to cancel this run. Throws on a transport/HTTP
   * error so the caller (guard.watchCancel) can fail open rather than read it as 'no'. */
  async cancelRequested(runId: string): Promise<boolean> {
    const res = await fetch(`${config.bffUrl}/api/runs/${runId}/cancel-requested`, { headers: headers() });
    if (!res.ok) throw new Error(`cancel-requested ${runId} -> ${res.status}${authHint(res.status)}`);
    const j = (await res.json()) as { cancelRequested?: boolean };
    return j.cancelRequested === true;
  },
  /** Events posted from the worker process itself (not the hooks, which post directly). */
  async event(runId: string, kind: string, payload: Record<string, unknown>, taskId: string | null = null): Promise<void> {
    await fetch(`${config.bffUrl}/api/runs/${runId}/events`, { method: 'POST', headers: headers(),
      body: JSON.stringify({ taskId, kind, source: 'worker', payload }) }).catch(() => {});
  },
  async saveArtifact(runId: string, name: string, content: string, opts: { taskId?: string | null; source?: string } = {}): Promise<void> {
    await post(config.registryUrl, `/internal/rpc`, { op: 'saveArtifact', runId, name, content, taskId: opts.taskId ?? null, source: opts.source ?? 'agent' }).catch(() => {});
  },
  /** All persisted artifacts for a run (name -> content), from the registry DB. */
  async listArtifacts(runId: string): Promise<Record<string, string>> {
    const j = (await post(config.registryUrl, `/internal/rpc`, { op: 'listArtifacts', runId }).catch(() => null)) as { result?: { artifacts?: { name: string; content: string }[] } } | null;
    const out: Record<string, string> = {};
    for (const a of j?.result?.artifacts ?? []) out[a.name] = a.content;
    return out;
  },
  /** Every stored version of every artifact, newest first (M11 WP1) — used to give a re-run reviewer its previous review. */
  async listArtifactVersions(runId: string): Promise<Array<{ name: string; content: string; taskId: string | null; attempt: number | null }>> {
    const j = (await post(config.registryUrl, `/internal/rpc`, { op: 'listArtifactVersions', runId }).catch(() => null)) as { result?: { versions?: Array<{ name: string; content: string; taskId: string | null; attempt: number | null }> } } | null;
    return j?.result?.versions ?? [];
  },
  /** The planner chat thread for a run, oldest first. Empty on an older registry. */
  async listMessages(runId: string): Promise<RunMessageWire[]> {
    const j = (await post(config.registryUrl, `/internal/rpc`, { op: 'listMessages', runId }).catch(() => null)) as { result?: { messages?: RunMessageWire[] } } | null;
    return j?.result?.messages ?? [];
  },
  /** Record one agent turn in the chat (its questions or its plan), with the session id to resume next time. */
  async appendMessage(input: Omit<RunMessageInput, 'by'> & { by?: string | null }): Promise<void> {
    await post(config.registryUrl, `/internal/rpc`, { op: 'appendMessage', input: { by: null, ...input } }).catch(() => {});
  },
  /** The factory's ad-hoc (Things-to-do) list, for a role's prompt. Empty on an older registry or a transport error. */
  async listAdhoc(): Promise<AdhocTask[]> {
    const j = (await post(config.registryUrl, `/internal/rpc`, { op: 'listAdhoc' }).catch(() => null)) as { result?: { tasks?: AdhocTask[] } } | null;
    return j?.result?.tasks ?? [];
  },
  /** Create one ad-hoc task a role proposed via its outbox; null on an older registry or a transport error. */
  async createAdhoc(input: CreateAdhocInput): Promise<AdhocTask | null> {
    const j = (await post(config.registryUrl, `/internal/rpc`, { op: 'createAdhoc', input }).catch(() => null)) as { result?: { task?: AdhocTask } } | null;
    return j?.result?.task ?? null;
  },
  async openChangeRequest(runId: string, input: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<{ number: number; url: string }> {
    const j = (await post(config.bffUrl, '/api/scm/change-request', { runId, ...input })) as { changeRequest: { number: number; url: string } };
    return j.changeRequest;
  },
  async mergeChangeRequest(runId: string, number: number, method: 'merge' | 'squash' | 'rebase'): Promise<void> {
    await post(config.bffUrl, '/api/scm/merge', { runId, number, method });
  },
  async markReadyChangeRequest(runId: string, number: number): Promise<void> {
    await post(config.bffUrl, '/api/scm/mark-ready', { runId, number });
  },
};
