import type {
  ChangeRequest, Preflight, Repo, ReviewComment, ScmProvider,
} from '@asf/shared';
import { credentialRejected } from '../rejected.js';

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
}

interface GlProject {
  id: number;
  path_with_namespace: string;
  web_url: string;
  default_branch: string | null;
  http_url_to_repo: string;
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

/** GitLab MR access levels: Developer(30)+ can push/merge; below that is read-only. */
const DEVELOPER = 30;

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
    return { ok: true, identity: me.username };
  }

  async searchRepos(q: string): Promise<Repo[]> {
    // Scope to the configured projects; match by substring. Fetch each once.
    const matches = this.cfg.repos.filter((rp) => rp.toLowerCase().includes(q.toLowerCase()));
    const out: Repo[] = [];
    for (const rp of matches) out.push(this.toRepo(await this.gl<GlProject>('GET', `/projects/${this.pid(rp)}`)));
    return out;
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
      // Match by ticket key appearing in title or source branch (agent branches embed the key).
      filtered = filtered.filter((m) =>
        q.ticketKeys!.some((k) => m.title.includes(k) || m.source_branch.includes(k.replace(/[^\w-]/g, '-'))),
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

  async listReviewComments(repo: Repo, number: number): Promise<ReviewComment[]> {
    const notes = await this.gl<GlNote[]>('GET', `/projects/${this.pid(repo.path)}/merge_requests/${number}/notes?per_page=100&sort=asc`);
    // Drop GitLab's system notes (status changes etc.) — only human/agent notes are review comments.
    return notes.filter((n) => !n.system).map((n) => ({
      id: String(n.id), author: n.author?.username ?? 'unknown', body: n.body,
      path: n.position?.new_path ?? null, line: n.position?.new_line ?? null,
      resolved: n.resolvable ? (n.resolved ?? false) : null, createdAt: n.created_at,
    }));
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

  async comment(repo: Repo, number: number, body: string, anchor?: { path: string; line: number }): Promise<void> {
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
