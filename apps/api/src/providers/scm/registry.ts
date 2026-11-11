import type {
  ChangeRequest, Preflight, Repo, ReviewThread, ScmProvider, ScmProviderKind,
} from '@asf/shared';

/**
 * Hot-swappable SCM-provider resolution (white-label WP B) — the SCM twin of
 * TicketProviderRegistry.
 *
 * The api used to build ONE ScmProvider at boot from SCM_PROVIDER and inject
 * that fixed instance into every route + the scheduler, making the SCM a
 * deploy-time choice. For a white-label product the operator picks the provider
 * (and enters its config/credentials) in the /providers UI and expects it to
 * take effect live.
 *
 *  - `build(kind)` constructs a provider from the CURRENT resolved config. It is
 *    async because a UI-entered credential may be a `secret://org/...` pointer
 *    fetched at build time.
 *  - `current()` returns the cached instance, rebuilding once whenever the config
 *    changed since the last build (`invalidate()` sets a dirty flag; the admin
 *    route calls it after any settings write). Concurrent callers during a
 *    rebuild share a single in-flight build promise.
 *  - `live` is a stable proxy implementing ScmProvider whose every method
 *    forwards to `current()`. Routes and the scheduler are injected this proxy
 *    and never learn the underlying instance can change.
 *
 * `kind` is always read off the built instance, never cached independently.
 */
export class ScmProviderRegistry {
  private instance: ScmProvider | null = null;
  private dirty = true;
  private building: Promise<ScmProvider> | null = null;

  /**
   * A stable ScmProvider that always forwards to the current instance, so it can
   * be injected once and survive every hot-swap. `kind` reflects the instance
   * last resolved by `current()`; every method awaits `current()` so it operates
   * on the live instance (rebuilding if dirty).
   */
  readonly live: ScmProvider;

  constructor(private readonly build: (kind: string) => Promise<ScmProvider>, private readonly kindOf: () => string) {
    const live: Omit<ScmProvider, 'kind'> = {
      preflight: (): Promise<Preflight> => this.current().then((p) => p.preflight()),
      searchRepos: (q: string): Promise<Repo[]> => this.current().then((p) => p.searchRepos(q)),
      getRepo: (idOrPath: string): Promise<Repo> => this.current().then((p) => p.getRepo(idOrPath)),
      cloneCredential: (repo: Repo) => this.current().then((p) => p.cloneCredential(repo)),
      openChangeRequest: (repo: Repo, input: { head: string; base: string; title: string; body: string; draft: boolean }) =>
        this.current().then((p) => p.openChangeRequest(repo, input)),
      listChangeRequests: (repo: Repo, q: { ticketKeys?: string[]; since?: string }): Promise<ChangeRequest[]> =>
        this.current().then((p) => p.listChangeRequests(repo, q)),
      getChangeRequest: (repo: Repo, number: number) => this.current().then((p) => p.getChangeRequest(repo, number)),
      listReviewComments: (repo: Repo, number: number): Promise<ReviewThread[]> =>
        this.current().then((p) => p.listReviewComments(repo, number)),
      replyToThread: (repo: Repo, number: number, threadId: string, body: string) =>
        this.current().then((p) => p.replyToThread(repo, number, threadId, body)),
      comment: (repo: Repo, number: number, body: string, anchor?: { path: string; line: number }) =>
        this.current().then((p) => p.comment(repo, number, body, anchor)),
      markReady: (repo: Repo, number: number) => this.current().then((p) => p.markReady(repo, number)),
      merge: (repo: Repo, number: number, opts: { method: 'merge' | 'squash' | 'rebase' }) =>
        this.current().then((p) => p.merge(repo, number, opts)),
      // Optional on providers; the live wrapper throws when the current one lacks it (callers fall back).
      changedFiles: (repo: Repo, number: number, limit: number): Promise<string[]> => this.current().then((p) => {
        if (!p.changedFiles) throw new Error(`${p.kind} cannot list changed files`);
        return p.changedFiles(repo, number, limit);
      }),
    };
    // `kind` stays a live getter (it follows hot-swaps); an arrow keeps `this` = the registry.
    Object.defineProperty(live, 'kind', { get: () => (this.instance?.kind ?? 'mock') as ScmProviderKind, enumerable: true });
    this.live = live as ScmProvider;
  }

  /** Mark the current instance stale; the next `current()` rebuilds. Cheap; safe to call often. */
  invalidate(): void {
    this.dirty = true;
  }

  /** The live provider, rebuilding at most once per config change. Concurrent callers share one build. */
  async current(): Promise<ScmProvider> {
    if (this.instance && !this.dirty) return this.instance;
    if (this.building) return this.building;
    // Snapshot dirty->clean BEFORE awaiting so an invalidate() that arrives
    // mid-build re-dirties us and forces another rebuild afterwards.
    this.dirty = false;
    this.building = this.build(this.kindOf())
      .then((p) => { this.instance = p; return p; })
      .catch((e) => { this.dirty = true; throw e; })
      .finally(() => { this.building = null; });
    return this.building;
  }
}
