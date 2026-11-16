import {
  isFactoryComment, markFactoryComment,
  type ChangeRequest, type Preflight, type Repo, type ReviewThread, type ScmProvider,
} from '@asf/shared';
import { credentialRejected } from '../rejected.js';
import { changeRequestMentionsKey } from './ticket-key.js';

/**
 * GitLab as an ScmProvider, purpose-built to the neutral interface (mirrors
 * github.ts — NOT ported from any board-specific client). GitLab's "merge
 * request" is our ChangeRequest; the neutral `number` is the MR `iid` (unique
 * per project, which is what every MR endpoint takes), NOT the global `id`.
 *
 * REST v4 only: {baseUrl}/api/v4. The project id in every path is the
 * URL-encoded "group/repo" path (GitLab accepts the encoded path in place of a
 * numeric id).
 *
 * The clone credential is a tokenized HTTPS URL
 *   https://oauth2:<TOKEN>@host/group/repo.git
 * handed to the worker and NEVER logged. Agents never receive it — it flows
 * api → worker over the run-secret channel.
 */

export interface GitlabScmConfig {
  baseUrl: string;          // https://gitlab.com  (no trailing slash; api/v4 appended)
  token: string;            // PAT with api scope
  repos: string[];          // ["group/repo", "group/sub/repo", ...] the picker covers
  groups?: string[];        // ["acme", "acme/platform"]: every Developer+ project in them (and subgroups)
  exclude?: string[];       // globs over group-discovered paths; never applied to `repos`
}

interface GlProject {
  id: number;
  path_with_namespace: string;
  web_url: string;
  default_branch: string | null;
  http_url_to_repo: string;
  description?: string | null;
  permissions?: {
    project_access?: { access_level: number } | null;
    group_access?: { access_level: number } | null;
  };
}
interface GlPipeline { status: string }
interface GlMergeRequest {
  iid: number;
  web_url: string;
  title: string;
  state: 'opened' | 'closed' | 'locked' | 'merged';
  draft: boolean;
  work_in_progress?: boolean;
  source_branch: string;
  target_branch: string;
  updated_at: string;
  sha: string | null;
  diff_refs?: { base_sha: string | null; head_sha: string | null; start_sha: string | null } | null;
  pipeline?: GlPipeline | null;
  head_pipeline?: GlPipeline | null;
}
interface GlApprovals { approved: boolean; approvals_left?: number }
interface GlNote {
  id: number;
  author: { username: string } | null;
  body: string;
  created_at: string;
  system: boolean;
  position?: { new_path?: string | null; new_line?: number | null } | null;
  resolvable?: boolean;
  resolved?: boolean;
}
interface GlDiscussion { id: string; notes: GlNote[] }

/** GitLab MR access levels: Developer(30)+ can push/merge; below that is read-only. */
const DEVELOPER = 30;

/** How long the discovered project list is reused before GitLab is asked again. */
const LIST_TTL_MS = 5 * 60_000;
/** Page cap per group (100 × 100 projects) so a runaway listing can't loop forever. */
const MAX_PAGES = 100;

/**
 * A path glob: `*` matches within one segment, `**` across segments (zero or
 * more), and the whole path must match. Case-insensitive, like GitLab paths.
 */
export function pathGlob(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function mapState(mr: Pick<GlMergeRequest, 'state'>): ChangeRequest['state'] {
  if (mr.state === 'merged') return 'merged';
  return mr.state === 'opened' ? 'open' : 'closed';
}

/** GitLab pipeline status → neutral ciState. Unknown/absent → null. */
function mapCiState(status: string | undefined): ChangeRequest['ciState'] {
  switch (status) {
    case 'success': return 'success';
    case 'failed': case 'canceled': return 'failed';
    case 'running': return 'running';
    case 'pending': case 'created': case 'scheduled': case 'waiting_for_resource': case 'preparing': case 'manual': return 'pending';
    default: return null;
  }
}

export class GitlabScmProvider implements ScmProvider {
  readonly kind = 'gitlab' as const;
  private readonly cfg: GitlabScmConfig;
  private me: string | null = null; // the token's username, from GET /user
  // The discovered repo list. A settings write rebuilds the provider, which drops this.
  private listed: { at: number; repos: Repo[] } | null = null;

  constructor(cfg: GitlabScmConfig) {
    this.cfg = { ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, '') };
  }

  private async gl<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}/api/v4${path}`, {
      method,
      headers: {
        'PRIVATE-TOKEN': this.cfg.token,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitLab ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return (res.status === 204 ? (undefined as T) : ((await res.json()) as T));
  }

  /** The token's username, cached (preflight fills the same cache). */
  private async username(): Promise<string> {
    this.me ??= (await this.gl<{ username: string }>('GET', '/user')).username;
    return this.me;
  }

  /** URL-encode "group/repo" for use as :id in a project path. */
  private pid(pathOrId: string): string {
    return encodeURIComponent(pathOrId);
  }

  private toRepo(p: GlProject): Repo {
    return {
      id: p.path_with_namespace,
      path: p.path_with_namespace,
      url: p.web_url,
      defaultBranch: p.default_branch ?? 'main',
      cloneUrl: p.http_url_to_repo,
      description: p.description ?? null,
    };
  }

  private async toChangeRequest(repo: Repo, mr: GlMergeRequest): Promise<ChangeRequest> {
    // Approval verdict: GitLab exposes it via /approvals (approved=true) or an
    // unresolved changes request is inferred from approvals_left. Best-effort.
    let reviewState: ChangeRequest['reviewState'] = 'pending';
    try {
      const ap = await this.gl<GlApprovals>('GET', `/projects/${this.pid(repo.path)}/merge_requests/${mr.iid}/approvals`);
      if (ap.approved) reviewState = 'approved';
    } catch { /* approvals are best-effort context, not required */ }
    const ci = mapCiState((mr.head_pipeline ?? mr.pipeline)?.status);
    return {
      id: String(mr.iid), number: mr.iid, repoId: repo.id, url: mr.web_url,
      title: mr.title, state: mapState(mr), draft: mr.draft || mr.work_in_progress === true,
      headBranch: mr.source_branch, baseBranch: mr.target_branch, reviewState, ciState: ci,
      updatedAt: mr.updated_at,
    };
  }

  async preflight(): Promise<Preflight> {
    if (!this.cfg.token) return { ok: false, reason: 'GITLAB_TOKEN is empty' };
    const status = (e: unknown) => Number(/→ (\d{3}):/.exec((e as Error).message)?.[1] ?? 0);
    let me: { username: string };
    try {
      // /user (not a search) so a dead token fails outright rather than 200-empty.
      me = await this.gl<{ username: string }>('GET', '/user');
      this.me = me.username;
    } catch (e) {
      if (status(e) === 401) return credentialRejected('GitLab');
      return { ok: false, reason: (e as Error).message };
    }
    // Verify Developer+ (push/merge) on each configured project — a read-only
    // token would open an MR then fail to merge.
    for (const rp of this.cfg.repos) {
      let p: GlProject;
      try {
        p = await this.gl<GlProject>('GET', `/projects/${this.pid(rp)}`);
      } catch (e) {
        if (status(e) === 404) return { ok: false, reason: `GitLab can’t find the project ${rp}. Check the spelling (group/project), or that ${me.username} has access to it.` };
        return { ok: false, reason: (e as Error).message };
      }
      const level = Math.max(
        p.permissions?.project_access?.access_level ?? 0,
        p.permissions?.group_access?.access_level ?? 0,
      );
      if (level < DEVELOPER) return { ok: false, reason: `token lacks push access to ${rp}` };
    }
    for (const g of this.cfg.groups ?? []) {
      try {
        await this.gl('GET', `/groups/${this.pid(g)}`);
      } catch (e) {
        if (status(e) === 404 || status(e) === 403) return { ok: false, reason: `GitLab can’t find the group ${g}, or ${me.username} can’t see it. Check the spelling (group or group/subgroup) and that ${me.username} is a member.` };
        return { ok: false, reason: (e as Error).message };
      }
    }
    return { ok: true, identity: me.username };
  }

  async searchRepos(q: string): Promise<Repo[]> {
    const needle = q.toLowerCase();
    if (!this.cfg.groups?.length) {
      // Scope to the configured projects; match by substring. Fetch each once.
      const matches = this.cfg.repos.filter((rp) => rp.toLowerCase().includes(needle));
      const out: Repo[] = [];
      for (const rp of matches) out.push(this.toRepo(await this.gl<GlProject>('GET', `/projects/${this.pid(rp)}`)));
      return out;
    }
    return (await this.listAll()).filter((r) => r.path.toLowerCase().includes(needle));
  }

  /** Every project in the configured groups (minus excludes) plus the explicit repos, cached. */
  private async listAll(): Promise<Repo[]> {
    if (this.listed && Date.now() - this.listed.at < LIST_TTL_MS) return this.listed.repos;
    const exclude = (this.cfg.exclude ?? []).map(pathGlob);
    const byPath = new Map<string, Repo>();
    for (const g of this.cfg.groups ?? []) {
      // The list items carry everything toRepo needs, so no per-project GET.
      for (let page = 1; page <= MAX_PAGES; page++) {
        const params = new URLSearchParams({
          include_subgroups: 'true', archived: 'false', with_shared: 'false',
          min_access_level: String(DEVELOPER), per_page: '100', page: String(page),
        });
        const ps = await this.gl<GlProject[]>('GET', `/groups/${this.pid(g)}/projects?${params}`);
        for (const p of ps) {
          if (exclude.some((re) => re.test(p.path_with_namespace))) continue;
          byPath.set(p.path_with_namespace, this.toRepo(p));
        }
        if (ps.length < 100) break;
      }
    }
    // An explicit GITLAB_REPOS entry always wins over an exclude.
    for (const rp of this.cfg.repos) {
      const r = this.toRepo(await this.gl<GlProject>('GET', `/projects/${this.pid(rp)}`));
      byPath.set(r.path, r);
    }
    const repos = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    this.listed = { at: Date.now(), repos };
    return repos;
  }

  async getRepo(idOrPath: string): Promise<Repo> {
    return this.toRepo(await this.gl<GlProject>('GET', `/projects/${this.pid(idOrPath)}`));
  }

  async cloneCredential(repo: Repo): Promise<{ url: string; header?: string }> {
    // Tokenized HTTPS URL the worker uses for clone + push. Never logged.
    const u = new URL(repo.cloneUrl);
    u.username = 'oauth2';
    u.password = this.cfg.token;
    return { url: u.toString() };
  }

  async openChangeRequest(
    repo: Repo,
    input: { head: string; base: string; title: string; body: string; draft: boolean },
  ): Promise<ChangeRequest> {
    // GitLab marks an MR as draft by a "Draft:" title prefix (no boolean field on create).
    const title = input.draft && !/^draft:/i.test(input.title) ? `Draft: ${input.title}` : input.title;
    const mr = await this.gl<GlMergeRequest>('POST', `/projects/${this.pid(repo.path)}/merge_requests`, {
      source_branch: input.head, target_branch: input.base, title, description: input.body,
    });
    return this.toChangeRequest(repo, mr);
  }

  async listChangeRequests(repo: Repo, q: { ticketKeys?: string[]; since?: string }): Promise<ChangeRequest[]> {
    const params = new URLSearchParams({ state: 'all', per_page: '100', order_by: 'updated_at', sort: 'desc' });
    if (q.since) params.set('updated_after', q.since);
    const mrs = await this.gl<GlMergeRequest[]>('GET', `/projects/${this.pid(repo.path)}/merge_requests?${params}`);
    let filtered = mrs;
    if (q.ticketKeys?.length) {
      // Match by ticket key appearing in title or source branch (agent branches embed the key),
      // as a whole key so PROJ-12 doesn't pick up PROJ-123's merge request.
      filtered = filtered.filter((m) =>
        q.ticketKeys!.some((k) => changeRequestMentionsKey({ title: m.title, branch: m.source_branch }, k)),
      );
    }
    return Promise.all(filtered.map((m) => this.toChangeRequest(repo, m)));
  }

  async getChangeRequest(repo: Repo, number: number): Promise<ChangeRequest & { diffRefs: unknown }> {
    const mr = await this.gl<GlMergeRequest>('GET', `/projects/${this.pid(repo.path)}/merge_requests/${number}`);
    const cr = await this.toChangeRequest(repo, mr);
    const refs = mr.diff_refs ?? null;
    return { ...cr, diffRefs: refs ? { headSha: refs.head_sha, baseSha: refs.base_sha, startSha: refs.start_sha } : { headSha: mr.sha, baseSha: null } };
  }

  async listReviewComments(repo: Repo, number: number): Promise<ReviewThread[]> {
    const username = await this.username();
    const out: ReviewThread[] = [];
    // gl() hands back only the body, so page until a short page rather than reading x-next-page.
    for (let page = 1; ; page++) {
      const ds = await this.gl<GlDiscussion[]>('GET', `/projects/${this.pid(repo.path)}/merge_requests/${number}/discussions?per_page=100&page=${page}`);
      for (const d of ds) {
        const [first, ...rest] = d.notes;
        // Only resolvable, non-system discussions are review threads (not status changes or plain MR notes).
        if (!first || !first.resolvable || first.system) continue;
        const author = first.author?.username ?? 'unknown';
        out.push({
          id: d.id, resolved: first.resolved ?? false,
          path: first.position?.new_path ?? null, line: first.position?.new_line ?? null,
          author, authorIsTokenAccount: author === username, own: isFactoryComment(first.body),
          body: first.body, createdAt: first.created_at,
          replies: rest.map((n) => ({
            id: String(n.id), author: n.author?.username ?? 'unknown',
            own: isFactoryComment(n.body), body: n.body, createdAt: n.created_at,
          })),
        });
      }
      if (ds.length < 100) break;
    }
    return out;
  }

  async replyToThread(repo: Repo, number: number, threadId: string, body: string): Promise<void> {
    await this.gl('POST', `/projects/${this.pid(repo.path)}/merge_requests/${number}/discussions/${encodeURIComponent(threadId)}/notes`,
      { body: markFactoryComment(body) });
  }

  async changedFiles(repo: Repo, number: number, limit: number): Promise<string[]> {
    const max = Math.min(limit, 500);
    const out: string[] = [];
    for (let page = 1; out.length < max; page++) {
      const diffs = await this.gl<{ new_path: string }[]>('GET', `/projects/${this.pid(repo.path)}/merge_requests/${number}/diffs?per_page=100&page=${page}`);
      out.push(...diffs.map((d) => d.new_path));
      if (diffs.length < 100) break;
    }
    return out.slice(0, max);
  }

  async comment(repo: Repo, number: number, text: string, anchor?: { path: string; line: number }): Promise<void> {
    const body = markFactoryComment(text);
    if (anchor) {
      // A positioned discussion needs the MR's diff refs to anchor against.
      const mr = await this.gl<GlMergeRequest>('GET', `/projects/${this.pid(repo.path)}/merge_requests/${number}`);
      const refs = mr.diff_refs;
      await this.gl('POST', `/projects/${this.pid(repo.path)}/merge_requests/${number}/discussions`, {
        body,
        position: {
          position_type: 'text',
          new_path: anchor.path,
          old_path: anchor.path,
          new_line: anchor.line,
          base_sha: refs?.base_sha,
          head_sha: refs?.head_sha,
          start_sha: refs?.start_sha,
        },
      });
    } else {
      await this.gl('POST', `/projects/${this.pid(repo.path)}/merge_requests/${number}/notes`, { body });
    }
  }

  async markReady(repo: Repo, number: number): Promise<void> {
    // Clearing draft = removing the "Draft:" title prefix.
    const mr = await this.gl<GlMergeRequest>('GET', `/projects/${this.pid(repo.path)}/merge_requests/${number}`);
    const stripped = mr.title.replace(/^\s*(draft|wip):\s*/i, '');
    if (stripped !== mr.title) {
      await this.gl('PUT', `/projects/${this.pid(repo.path)}/merge_requests/${number}`, { title: stripped });
    }
  }

  async merge(repo: Repo, number: number, opts: { method: 'merge' | 'squash' | 'rebase' }): Promise<void> {
    // GitLab has no "rebase then merge" merge verb; the neutral 'rebase' maps to
    // squash=false (a rebase merge strategy is a project setting, not per-request).
    const squash = opts.method === 'squash';
    await this.gl('PUT', `/projects/${this.pid(repo.path)}/merge_requests/${number}/merge`, { squash });
  }
}
