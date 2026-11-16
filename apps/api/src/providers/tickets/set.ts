import { connectionKind, connectionList, formatRef, parseRef, ticketProviderKindSchema } from '@asf/shared';
import type { Ticket, TicketListQuery, TicketProvider, TicketProviderKind } from '@asf/shared';
import { cfg } from '../../settings.js';
import { TicketProviderRegistry } from './registry.js';

/**
 * The ticket provider with qualified ids at the seam (M12, see refs.ts). Every id
 * going in is stripped to the provider's native id (a bare pre-M12 id passes
 * through), and every ticket coming out carries its connection and a qualified id,
 * so the provider itself never sees a prefix. `kind` is read through on every
 * access, so this wraps a registry's hot-swapping `live` proxy safely.
 */
export function qualifyTickets(provider: TicketProvider): TicketProvider {
  const kind = () => provider.kind;
  const native = (ref: string) => parseRef(ref, kind()).native;
  const qualify = (t: Ticket): Ticket => {
    const c = kind();
    return {
      ...t, connection: c, id: formatRef(c, t.id),
      parentId: t.parentId == null ? t.parentId : formatRef(c, t.parentId),
      children: t.children?.map((id) => formatRef(c, id)),
    };
  };
  const wrapped: Omit<TicketProvider, 'kind'> = {
    preflight: () => provider.preflight(),
    capabilities: () => provider.capabilities(),
    list: async (q) => {
      const r = await provider.list(q);
      return { ...r, tickets: r.tickets.map(qualify) };
    },
    get: async (id) => qualify(await provider.get(native(id))),
    update: async (id, patch) => qualify(await provider.update(native(id), patch)),
    createSubtask: async (parentId, input) => qualify(await provider.createSubtask(native(parentId), input)),
    addLink: (id, link) => provider.addLink(native(id), link),
    comment: (id, markdown) => provider.comment(native(id), markdown),
    listComments: (id) => provider.listComments(native(id)),
    transitions: (id) => provider.transitions(native(id)),
    transition: (id, transitionId) => provider.transition(native(id), transitionId),
    assign: (id, assignee) => provider.assign(native(id), assignee),
    listScopes: () => provider.listScopes(),
    listSprints: (scopeId) => provider.listSprints(scopeId),
    listStatuses: (scopeId) => provider.listStatuses(scopeId),
    // The provider reads its own ids (the GitHub tracker parses `acme/web#42`), so it gets the native one back.
    ...(provider.suggestedRepo ? { suggestedRepo: (t: Ticket) => provider.suggestedRepo?.({ ...t, id: native(t.id) }) ?? null } : {}),
  };
  Object.defineProperty(wrapped, 'kind', { get: kind, enumerable: true });
  return wrapped as TicketProvider;
}

/**
 * The ticket connections in use (M12 WP3): TICKET_PROVIDERS split, trimmed and
 * deduped, keeping only known tracker kinds. Empty falls back to TICKET_PROVIDER,
 * so an existing install needs no settings change. The first is the default
 * connection for bare ticket ids.
 */
export function ticketConnections(connectionsOf: (key: 'TICKET_PROVIDERS' | 'TICKET_PROVIDER') => unknown = cfg): string[] {
  return connectionList(connectionsOf('TICKET_PROVIDERS'), connectionsOf('TICKET_PROVIDER'), ticketProviderKindSchema.options);
}

/** One tracker's part of a merged list: whether it answered, and why not. */
export interface TicketSource { connection: string; ok: boolean; reason?: string }
/** The set's `live` facade: a TicketProvider that routes each id to its tracker, plus the merged list. */
export type TicketSetLive = TicketProvider & {
  listAll(q: TicketListQuery, connections?: string[]): Promise<{ tickets: Ticket[]; sources: TicketSource[] }>;
  ticketsFor(ref: string | Ticket): TicketProvider;
};

/**
 * Several trackers at once (M12 WP3). One hot-swappable registry per
 * connection, each wrapped by qualifyTickets, rebuilt when the connection list
 * changes. `ticketsFor` returns the tracker that owns a ticket; `live` is a
 * stable TicketProvider that routes every per-ticket call by the id's prefix
 * (bare ids belong to the default connection), and lists every tracker with
 * `listAll`. Ad-hoc ids are not routed here: tickets/route.ts sends them to the
 * ad-hoc store first.
 */
export class TicketSet {
  private trackers = new Map<string, { registry: TicketProviderRegistry; tickets: TicketProvider }>();
  private listKey = '';
  readonly live: TicketSetLive;

  constructor(
    private readonly build: (kind: string) => Promise<TicketProvider>,
    private readonly connectionsOf: () => string[] = () => ticketConnections(),
  ) {
    // Async, so a connection that is not set up rejects like any tracker error rather than throwing.
    const via = async (id: string) => this.ticketsFor(id);
    const byDefault = () => this.tracker(this.defaultConnection).tickets;
    const live: Omit<TicketSetLive, 'kind'> = {
      preflight: () => byDefault().preflight(),
      capabilities: () => byDefault().capabilities(),
      list: (q) => byDefault().list(q),
      listAll: (q, connections) => this.listAll(q, connections),
      ticketsFor: (ref) => this.ticketsFor(ref),
      get: async (id) => (await via(id)).get(id),
      update: async (id, patch) => (await via(id)).update(id, patch),
      createSubtask: async (parentId, input) => (await via(parentId)).createSubtask(parentId, input),
      addLink: async (id, link) => (await via(id)).addLink(id, link),
      comment: async (id, markdown) => (await via(id)).comment(id, markdown),
      listComments: async (id) => (await via(id)).listComments(id),
      transitions: async (id) => (await via(id)).transitions(id),
      transition: async (id, transitionId) => (await via(id)).transition(id, transitionId),
      assign: async (id, assignee) => (await via(id)).assign(id, assignee),
      listScopes: () => byDefault().listScopes(),
      listSprints: (scopeId) => byDefault().listSprints(scopeId),
      listStatuses: (scopeId) => byDefault().listStatuses(scopeId),
      suggestedRepo: (t) => {
        try { return this.ticketsFor(t).suggestedRepo?.(t) ?? null; } catch { return null; }
      },
    };
    Object.defineProperty(live, 'kind', { get: () => connectionKind(this.defaultConnection) as TicketProviderKind, enumerable: true });
    this.live = live as TicketSetLive;
  }

  /** Add registries for new connections and drop removed ones; kept ones keep their built provider. */
  private sync(): Map<string, { registry: TicketProviderRegistry; tickets: TicketProvider }> {
    const list = this.connectionsOf();
    const key = list.join(',');
    if (key === this.listKey) return this.trackers;
    const next = new Map<string, { registry: TicketProviderRegistry; tickets: TicketProvider }>();
    for (const c of list) {
      const kept = this.trackers.get(c);
      if (kept) { next.set(c, kept); continue; }
      const registry = new TicketProviderRegistry(this.build, () => connectionKind(c));
      next.set(c, { registry, tickets: qualifyTickets(registry.live) });
    }
    this.trackers = next;
    this.listKey = key;
    return next;
  }

  /** Every connection, in order. */
  get connections(): string[] {
    return [...this.sync().keys()];
  }

  /** The connection a bare ticket id belongs to: the first one. */
  get defaultConnection(): string {
    return this.connections[0];
  }

  /** Mark every tracker stale; the next call on each rebuilds from the current config. */
  invalidate(): void {
    for (const t of this.sync().values()) t.registry.invalidate();
  }

  private tracker(connection: string) {
    const t = this.sync().get(connection);
    if (!t) throw new Error(`Ticket connection "${connection}" is not set up`);
    return t;
  }

  /** The hot-swappable registry of one connection (admin, setup, credential checks and capability flags). */
  registryFor(connection: string): TicketProviderRegistry {
    return this.tracker(connection).registry;
  }

  /** The tracker that owns a ticket: the Ticket's connection, else its id's prefix, else the default. */
  ticketsFor(ref: string | Ticket): TicketProvider {
    const connection = typeof ref === 'string'
      ? parseRef(ref, this.defaultConnection).connection
      : ref.connection ?? parseRef(ref.id, this.defaultConnection).connection;
    return this.tracker(connection).tickets;
  }

  /**
   * The tickets of every selected tracker (all of them by default), in
   * connection order. A tracker that errors drops out with its reason and the
   * others still list. There is no paging cursor across trackers.
   */
  async listAll(q: TicketListQuery, connections: string[] = this.connections): Promise<{ tickets: Ticket[]; sources: TicketSource[] }> {
    const got = await Promise.allSettled(connections.map(async (c) => this.tracker(c).tickets.list(q)));
    const sources: TicketSource[] = got.map((r, i) => r.status === 'fulfilled'
      ? { connection: connections[i], ok: true }
      : { connection: connections[i], ok: false, reason: (r.reason as Error)?.message ?? String(r.reason) });
    return { tickets: got.flatMap((r) => (r.status === 'fulfilled' ? r.value.tickets : [])), sources };
  }
}
