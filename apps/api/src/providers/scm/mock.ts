import type { ChangeRequest, Repo, ScmProvider } from '@asf/shared';

export class MockScmProvider implements ScmProvider {
  readonly kind = 'mock' as const;
  private repos: Repo[];
  /**
   * `repoPath` is the git repo the worker clones. The factory passes MOCK_REPO_PATH,
   * which is blank unless someone set up a local repo (dev, smoke tests): then there
   * is no repository, preflight fails, and nothing can start. Omitted entirely
   * (unit tests), it falls back to the old fixture path.
   */
  constructor(repoPath?: string) {
    const path = repoPath === undefined ? (process.env.MOCK_REPO_PATH || '/tmp/example-app.git') : repoPath.trim();
    this.repos = path ? [{ id: '1', path: 'example/app', url: 'mock://repos/example/app', defaultBranch: 'main', cloneUrl: path }] : [];
  }
  private crs: ChangeRequest[] = [];
  async preflight() {
    return this.repos.length
      ? { ok: true as const, identity: 'mock' }
      : { ok: false as const, reason: 'no repository is connected. Choose GitHub or GitLab under “Where does your code live?”' };
  }
  async searchRepos(q: string) { return this.repos.filter((r) => r.path.includes(q)); }
  async getRepo(idOrPath: string) { const r = this.repos.find((x) => x.id === idOrPath || x.path === idOrPath); if (!r) throw new Error('no repo'); return r; }
  async cloneCredential(repo: Repo) { return { url: repo.cloneUrl }; }
  async openChangeRequest(repo: Repo, input: { head: string; base: string; title: string; body: string; draft: boolean }) {
    const cr: ChangeRequest = { id: String(this.crs.length + 1), number: this.crs.length + 1, repoId: repo.id, url: `${repo.url}/pulls/${this.crs.length + 1}`,
      title: input.title, state: 'open', draft: input.draft, headBranch: input.head, baseBranch: input.base, reviewState: 'pending', ciState: null, updatedAt: new Date().toISOString() };
    this.crs.push(cr); return cr;
  }
  async listChangeRequests() { return this.crs; }
  async getChangeRequest(_repo: Repo, number: number) { const cr = this.crs.find((c) => c.number === number); if (!cr) throw new Error('no cr'); return { ...cr, diffRefs: null }; }
  async listReviewComments() { return []; }
  async comment(_repo: Repo, _number: number, _body: string, _anchor?: { path: string; line: number }) {}
  async markReady(_repo: Repo, number: number) { const cr = await this.getChangeRequest(_repo, number); cr.draft = false; }
  async merge(_repo: Repo, number: number) { const cr = await this.getChangeRequest(_repo, number); cr.state = 'merged'; }
}
