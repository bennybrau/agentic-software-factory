import { connectionKind, formatRef, parseRef, scmProviderKindSchema } from '@asf/shared';
import type { ChangeRequest, Repo, ScmProvider, ScmProviderKind } from '@asf/shared';
import { cfg } from '../../settings.js';
import { ScmProviderRegistry } from './registry.js';

/**
 * The SCM provider with qualified repository ids at the seam (M12, see refs.ts).
 * `getRepo` accepts a bare (pre-M12) or qualified id or a path; every Repo handed
 * back carries its connection and a qualified id, and every Repo handed in is
 * passed on with its native id, so the provider never sees a prefix. `kind` is
 * read through on every access, so this wraps a registry's `live` proxy safely.
 */
export function qualifyScm(provider: ScmProvider): ScmProvider {
  const kind = () => provider.kind;
  const native = (ref: string) => parseRef(ref, kind()).native;
  const qualify = (r: Repo): Repo => ({ ...r, connection: kind(), id: formatRef(kind(), r.id) });
  const unqualify = (r: Repo): Repo => ({ ...r, id: native(r.id) });
  const qualifyCr = <T extends ChangeRequest>(cr: T): T => ({ ...cr, repoId: formatRef(kind(), cr.repoId) });
  const wrapped: Omit<ScmProvider, 'kind'> = {
    preflight: () => provider.preflight(),
    searchRepos: async (q) => (await provider.searchRepos(q)).map(qualify),
    getRepo: async (idOrPath) => qualify(await provider.getRepo(native(idOrPath))),
    cloneCredential: (repo) => provider.cloneCredential(unqualify(repo)),
    openChangeRequest: async (repo, input) => qualifyCr(await provider.openChangeRequest(unqualify(repo), input)),
    listChangeRequests: async (repo, q) => (await provider.listChangeRequests(unqualify(repo), q)).map(qualifyCr),
    getChangeRequest: async (repo, number) => qualifyCr(await provider.getChangeRequest(unqualify(repo), number)),
    listReviewComments: (repo, number) => provider.listReviewComments(unqualify(repo), number),
    replyToThread: (repo, number, threadId, body) => provider.replyToThread(unqualify(repo), number, threadId, body),
    comment: (repo, number, body, anchor) => provider.comment(unqualify(repo), number, body, anchor),
    markReady: (repo, number) => provider.markReady(unqualify(repo), number),
    merge: (repo, number, opts) => provider.merge(unqualify(repo), number, opts),
    ...(provider.changedFiles ? { changedFiles: (repo: Repo, number: number, limit: number) => provider.changedFiles!(unqualify(repo), number, limit) } : {}),
  };
  Object.defineProperty(wrapped, 'kind', { get: kind, enumerable: true });
  return wrapped as ScmProvider;
}

/**
 * The code connections in use (M12 WP2): SCM_PROVIDERS split, trimmed and
 * deduped, keeping only known SCM kinds. Empty falls back to SCM_PROVIDER, so
 * an existing install needs no settings change. The first is the default
 * connection for bare repository ids.
 */
export function scmConnections(connectionsOf: (key: 'SCM_PROVIDERS' | 'SCM_PROVIDER') => unknown = cfg): string[] {
  const known = new Set<string>(scmProviderKindSchema.options);
  const list = [...new Set(String(connectionsOf('SCM_PROVIDERS') ?? '').split(',').map((s) => s.trim()).filter((s) => known.has(s)))];
  return list.length ? list : [String(connectionsOf('SCM_PROVIDER'))];
}

/** One code host's state, as the start check reports it. */
export interface ScmHostState { connection: string; ok: boolean; reason?: string }
export interface ScmSetReadiness { hosts: ScmHostState[]; repos: Repo[] }
/** The set's `live` facade: a ScmProvider that routes to the right host, plus the all-hosts start check. */
export type ScmSetLive = ScmProvider & { readiness(): Promise<ScmSetReadiness> };

/**
 * Several code hosts at once (M12 WP2). One hot-swappable registry per
 * connection, each wrapped by qualifyScm, rebuilt when the connection list
 * changes. `scmFor` returns the provider that owns a repository; `live` is a
 * stable ScmProvider that routes every repository action by the repo's
 * connection (or its id's prefix; bare ids belong to the default connection)
 * and lists the repositories of every host that answers.
 */
export class ScmSet {
  private hosts = new Map<string, { registry: ScmProviderRegistry; scm: ScmProvider }>();
  private listKey = '';
  readonly live: ScmSetLive;

  constructor(
    private readonly build: (kind: string) => Promise<ScmProvider>,
    private readonly connectionsOf: () => string[] = () => scmConnections(),
  ) {
    const via = (repo: Repo) => this.scmFor(repo);
    const live: Omit<ScmSetLive, 'kind'> = {
      preflight: () => this.host(this.defaultConnection).scm.preflight(),
      readiness: () => this.readiness(),
      searchRepos: async (q) => {
        const got = await Promise.allSettled(this.connections.map((c) => this.host(c).scm.searchRepos(q)));
        return got.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      },
      getRepo: (idOrPath) => this.scmFor(idOrPath).getRepo(idOrPath),
      cloneCredential: (repo) => via(repo).cloneCredential(repo),
      openChangeRequest: (repo, input) => via(repo).openChangeRequest(repo, input),
      listChangeRequests: (repo, q) => via(repo).listChangeRequests(repo, q),
      getChangeRequest: (repo, number) => via(repo).getChangeRequest(repo, number),
      listReviewComments: (repo, number) => via(repo).listReviewComments(repo, number),
      replyToThread: (repo, number, threadId, body) => via(repo).replyToThread(repo, number, threadId, body),
      comment: (repo, number, body, anchor) => via(repo).comment(repo, number, body, anchor),
      markReady: (repo, number) => via(repo).markReady(repo, number),
      merge: (repo, number, opts) => via(repo).merge(repo, number, opts),
      changedFiles: async (repo, number, limit) => {
        const p = via(repo);
        if (!p.changedFiles) throw new Error(`${p.kind} cannot list changed files`);
        return p.changedFiles(repo, number, limit);
      },
    };
    Object.defineProperty(live, 'kind', { get: () => connectionKind(this.defaultConnection) as ScmProviderKind, enumerable: true });
    this.live = live as ScmSetLive;
  }

  /** Add registries for new connections and drop removed ones; kept ones keep their built provider. */
  private sync(): Map<string, { registry: ScmProviderRegistry; scm: ScmProvider }> {
    const list = this.connectionsOf();
    const key = list.join(',');
    if (key === this.listKey) return this.hosts;
    const next = new Map<string, { registry: ScmProviderRegistry; scm: ScmProvider }>();
    for (const c of list) {
      const kept = this.hosts.get(c);
      if (kept) { next.set(c, kept); continue; }
      const registry = new ScmProviderRegistry(this.build, () => connectionKind(c));
      next.set(c, { registry, scm: qualifyScm(registry.live) });
    }
    this.hosts = next;
    this.listKey = key;
    return next;
  }

  /** Every connection, in order. */
  get connections(): string[] {
    return [...this.sync().keys()];
  }

  /** The connection a bare repository id belongs to: the first one. */
  get defaultConnection(): string {
    return this.connections[0];
  }

  /** Mark every host stale; the next call on each rebuilds from the current config. */
  invalidate(): void {
    for (const h of this.sync().values()) h.registry.invalidate();
  }

  private host(connection: string) {
    const h = this.sync().get(connection);
    if (!h) throw new Error(`Code connection "${connection}" is not set up`);
    return h;
  }

  /** The hot-swappable registry of one connection (admin, setup and credential checks). */
  registryFor(connection: string): ScmProviderRegistry {
    return this.host(connection).registry;
  }

  /** The provider that owns a repository: the Repo's connection, else its id's prefix, else the default. */
  scmFor(ref: string | Repo): ScmProvider {
    const connection = typeof ref === 'string'
      ? parseRef(ref, this.defaultConnection).connection
      : ref.connection ?? parseRef(ref.id, this.defaultConnection).connection;
    return this.host(connection).scm;
  }

  /**
   * Every host's preflight, and the repositories of the ones that pass. A
   * preflight that throws counts as down; a host that is down drops out of the
   * list with its reason and the others still work.
   */
  async readiness(): Promise<ScmSetReadiness> {
    const conns = this.connections;
    const checked = await Promise.allSettled(conns.map((c) => this.host(c).scm.preflight()));
    const hosts: ScmHostState[] = checked.map((r, i) => {
      if (r.status === 'rejected') return { connection: conns[i], ok: false, reason: (r.reason as Error)?.message ?? String(r.reason) };
      return r.value.ok ? { connection: conns[i], ok: true } : { connection: conns[i], ok: false, reason: r.value.reason };
    });
    const lists = await Promise.all(hosts.map((h) => (h.ok ? this.host(h.connection).scm.searchRepos('').catch(() => [] as Repo[]) : [])));
    return { hosts, repos: lists.flat() };
  }
}
