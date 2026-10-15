/**
 * Which runtimes this worker offers, kept live (#163).
 *
 * Every runtime the image ships is probed once at boot (is the CLI installed?).
 * A probed runtime is offered only while its provider's auth preflight passes.
 * One whose preflight fails stays *pending* and is re-checked:
 *   - as soon as the api's view of that provider changes (a key entered or
 *     removed in Settings, a mode switched), and
 *   - every `recheckMs` regardless, which covers fixes made outside ASF (billing
 *     topped up, model access granted on the provider's side).
 * So entering an OpenAI key in the UI makes Codex available on the next
 * heartbeat, with no worker restart. A preflight is one tiny model call, so an
 * unchanged pending runtime is not re-tried more often than `recheckMs`.
 *
 * `status` is what the worker reports to the fleet about every configured
 * runtime (#69), including one that is not installed, so the Workers page can
 * say why it is not offered.
 */
import type { AgentRuntime, ProviderKind, RunAuth, RuntimeCapabilities, RuntimeStatus } from '@asf/shared';

export interface ProviderAuthView { mode: string; credentialPresent: boolean; vertex?: RunAuth['vertex']; baseUrl?: string }

/**
 * The one rule for every runtime (#70): an agent runs only where something blocks
 * out-of-scope writes up front — its own hooks or OS sandbox (confinesWrites), or the
 * worker container. Returns why a runtime may not be offered here, or null.
 */
export function containerRefusal(caps: RuntimeCapabilities, inContainer: boolean): string | null {
  return caps.confinesWrites || inContainer ? null : 'needs the containerised worker';
}
export type Preflight = (runtime: AgentRuntime, auth: RunAuth, opts: { credentialPresent: boolean }) => Promise<{ ok: boolean; reason?: string; detail?: string }>;

interface Candidate {
  runtime: AgentRuntime;
  provider: ProviderKind;
  version?: string;
  offered: boolean;
  mode: string;
  /** The provider view last preflighted against, and when. */
  checkedSig: string | null;
  checkedAt: number;
  /** Why the last preflight failed. */
  reason?: string;
  /** Held back by the login watch (M9 #2): not offered, and not re-preflighted, until resumed. */
  suspended?: boolean;
}

const sigOf = (v: ProviderAuthView | null): string => (v ? `${v.mode}|${v.credentialPresent ? 1 : 0}${v.vertex ? `|${JSON.stringify(v.vertex)}` : ''}${v.baseUrl ? `|${v.baseUrl}` : ''}` : 'none');

/** The auth a preflight checks, from the api's view of a provider. */
const authOf = (provider: ProviderKind, mode: string, view: ProviderAuthView | null): RunAuth =>
  ({ providerKind: provider, mode, ...(view?.vertex ? { vertex: view.vertex } : {}), ...(view?.baseUrl ? { baseUrl: view.baseUrl } : {}) } as RunAuth);

export class RuntimeOffer {
  private readonly candidates: Candidate[];
  private readonly missing: RuntimeStatus[] = [];

  constructor(
    runtimes: Array<{ runtime: AgentRuntime; provider: ProviderKind; version?: string }>,
    private readonly preflight: Preflight,
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void,
    private readonly recheckMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {
    this.candidates = runtimes.map((r) => ({ ...r, offered: false, mode: 'unset', checkedSig: null, checkedAt: 0 }));
  }

  /** The runtime kinds currently offered (under any provider), in configured order. */
  get kinds(): string[] { return [...new Set(this.candidates.filter((c) => c.offered).map((c) => c.runtime.kind))]; }
  /** Every offered `<runtime>@<provider>` pair (M11 WP4): what the registry routes tasks by. */
  get capabilities(): string[] { return this.candidates.filter((c) => c.offered).map((c) => `${c.runtime.kind}@${c.provider}`); }
  get offered(): Array<{ runtime: AgentRuntime; provider: ProviderKind; mode: string }> { return this.candidates.filter((c) => c.offered); }
  get pending(): string[] { const on = new Set(this.kinds); return [...new Set(this.candidates.filter((c) => !c.offered && !on.has(c.runtime.kind)).map((c) => c.runtime.kind))]; }

  /**
   * The provider's login stopped working (M9 #2: a Google login past its session
   * limit). Stop offering its runtimes and hold them, so the timed re-check doesn't
   * spend a model call on a login known to be dead. Returns true if the offered set changed.
   */
  suspend(provider: ProviderKind, reason: string): boolean {
    let changed = false;
    for (const c of this.candidates) {
      if (c.provider !== provider) continue;
      if (c.offered) changed = true;
      c.offered = false; c.suspended = true; c.reason = reason; c.checkedAt = this.now();
    }
    return changed;
  }

  /** The login works again: re-check the held runtimes on the next refresh (a real preflight decides). */
  resume(provider: ProviderKind): void {
    for (const c of this.candidates) {
      if (c.provider !== provider || !c.suspended) continue;
      c.suspended = false; c.checkedSig = null;
    }
  }

  /** A configured runtime that did not probe (CLI missing or failed to load): reported, never offered. */
  notInstalled(kind: string, reason: string): void {
    this.missing.push({ kind, installed: false, ok: false, reason, checkedAt: new Date(this.now()).toISOString() });
  }

  /** The latest probe + preflight result for every configured runtime. */
  get status(): RuntimeStatus[] {
    return [
      ...this.candidates.map((c): RuntimeStatus => ({
        kind: c.runtime.kind, provider: c.provider, installed: true,
        ...(c.version ? { version: c.version } : {}),
        ok: c.offered,
        ...(c.offered ? {} : { reason: c.reason ?? 'not checked yet' }),
        checkedAt: new Date(c.checkedAt || this.now()).toISOString(),
      })),
      ...this.missing,
    ];
  }

  /**
   * Preflight every pending runtime that is due (never checked, its provider's view
   * changed, or `recheckMs` elapsed). An offered runtime is re-checked only when its
   * provider's view changed (a switch to Vertex, a new project or region: the old
   * check says nothing about the new setup); if that fails it goes back to pending.
   * Otherwise a later credential failure surfaces on the run, as before. Returns
   * true if the offered set changed.
   */
  async refresh(viewFor: (p: ProviderKind) => ProviderAuthView | null, fallbackMode: (p: ProviderKind) => string): Promise<boolean> {
    let changed = false;
    for (const c of this.candidates) {
      const view = viewFor(c.provider);
      const sig = sigOf(view);
      if (c.offered) {
        // Same view as when it was offered (or no view: api briefly unreachable): leave it.
        if (!view || c.checkedSig === null || sig === c.checkedSig) continue;
        c.checkedSig = sig; c.checkedAt = this.now();
        const res = await this.preflight(c.runtime, authOf(c.provider, view.mode, view), { credentialPresent: view.credentialPresent });
        if (res.ok || c.suspended) { if (res.ok) c.mode = view.mode; continue; }
        c.offered = false; c.reason = res.reason ?? 'auth check failed'; changed = true;
        this.log(`agent auth changed and the new setup failed its check for ${c.runtime.kind} (${c.provider} ${view.mode}): ${res.reason}; no longer offering it`);
        continue;
      }
      if (c.suspended) continue;
      const due = c.checkedSig === null || sig !== c.checkedSig || this.now() - c.checkedAt >= this.recheckMs;
      if (!due) continue;
      const mode = view?.mode ?? fallbackMode(c.provider);
      const first = c.checkedSig === null;
      const viewChanged = !first && sig !== c.checkedSig;
      c.checkedSig = sig; c.checkedAt = this.now();
      const res = await this.preflight(c.runtime, authOf(c.provider, mode, view), { credentialPresent: view?.credentialPresent ?? false });
      if (c.suspended) continue; // the login watch held it while this preflight ran: it wins
      if (!res.ok) {
        c.reason = res.reason ?? 'auth check failed';
        // Log the first failure and any failure after a change; a timed re-try that fails the same way stays quiet.
        if (first || viewChanged) this.log(`agent auth preflight failed for ${c.runtime.kind} (${c.provider} ${mode}): ${res.reason}; not offering it${first ? '' : ' yet'}`);
        continue;
      }
      this.log(first ? 'agent auth ok' : 'agent auth ok; now offering', { runtime: c.runtime.kind, provider: c.provider, mode, detail: res.detail });
      c.offered = true; c.mode = mode; c.reason = undefined; changed = true;
    }
    return changed;
  }
}
