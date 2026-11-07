import type {
  ChangeRequest, Preflight, Repo, ReviewComment, ScmProvider,
} from '@asf/shared';
import { credentialRejected } from '../rejected.js';

/**
 * GitHub as an ScmProvider. Shares GITHUB_TOKEN with the ticket provider (one
 * token, repo scope covers both). REST for repos / PRs / comments / merge;
 * GraphQL only for markPullRequestReadyForReview (no REST equivalent).
 *
 * The clone credential is a tokenized HTTPS URL
 *   https://x-access-token:<TOKEN>@github.com/owner/repo.git
 * handed to the worker and NEVER logged (the worker logs branch names only).
 * Agents never receive it — it flows api → worker over the run-secret channel.
 */

export interface GithubScmConfig {
  token: string;
  repos: string[];          // ["owner/repo", ...] the picker covers
  apiUrl: string;           // https://api.github.com
  graphqlUrl: string;       // https://api.github.com/graphql
  host: string;             // github.com (clone host; GHES differs)
}

interface GhRepo {
  full_name: string; html_url: string; default_branch: string;
  clone_url: string; id: number;
}
interface GhPull {
  number: number; html_url: string; title: string; draft: boolean;
  state: 'open' | 'closed'; merged_at: string | null; merged?: boolean;
  head: { ref: string; sha: string }; base: { ref: string; sha: string };
  updated_at: string; node_id: string;
}
interface GhReview { state: string }
interface GhReviewComment {
  id: number; user: { login: string } | null; body: string;
  path: string | null; line: number | null; created_at: string;
}

function mapState(pr: Pick<GhPull, 'state' | 'merged_at' | 'merged'>): ChangeRequest['state'] {
  if (pr.merged_at || pr.merged) return 'merged';
  return pr.state === 'closed' ? 'closed' : 'open';
}

export class GithubScmProvider implements ScmProvider {
  readonly kind = 'github' as const;
  private readonly cfg: GithubScmConfig;
  private readonly nodeIds = new Map<string, string>(); // repoId#number → PR node_id (for GraphQL)

  constructor(cfg: GithubScmConfig) {
    this.cfg = cfg;
  }

  private async gh<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return (res.status === 204 ? (undefined as T) : ((await res.json()) as T));
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.cfg.graphqlUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (!res.ok || json.errors?.length) {
      throw new Error(`GitHub GraphQL error: ${json.errors?.map((e) => e.message).join('; ') ?? res.status}`);
    }
    return json.data as T;
  }

  private toRepo(r: GhRepo): Repo {
    return { id: r.full_name, path: r.full_name, url: r.html_url, defaultBranch: r.default_branch, cloneUrl: r.clone_url };
  }

  private async toChangeRequest(repo: Repo, pr: GhPull): Promise<ChangeRequest> {
    this.nodeIds.set(`${repo.id}#${pr.number}`, pr.node_id);
    // Review state: latest review verdict wins (GitHub returns them chronologically).
    let reviewState: ChangeRequest['reviewState'] = 'pending';
    try {
      const reviews = await this.gh<GhReview[]>('GET', `/repos/${repo.path}/pulls/${pr.number}/reviews?per_page=100`);
      const decisive = [...reviews].reverse().find((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED');
      if (decisive) reviewState = decisive.state === 'APPROVED' ? 'approved' : 'changes_requested';
    } catch { /* reviews are best-effort context, not required */ }
    return {
      id: String(pr.number), number: pr.number, repoId: repo.id, url: pr.html_url,
      title: pr.title, state: mapState(pr), draft: pr.draft,
      headBranch: pr.head.ref, baseBranch: pr.base.ref, reviewState, ciState: null,
      updatedAt: pr.updated_at,
    };
  }

  private async nodeId(repo: Repo, number: number): Promise<string> {
    const cached = this.nodeIds.get(`${repo.id}#${number}`);
    if (cached) return cached;
    const pr = await this.gh<GhPull>('GET', `/repos/${repo.path}/pulls/${number}`);
    this.nodeIds.set(`${repo.id}#${number}`, pr.node_id);
    return pr.node_id;
  }

  async preflight(): Promise<Preflight> {
    if (!this.cfg.token) return { ok: false, reason: 'GITHUB_TOKEN is empty' };
    // Plain answers for the two failures a person can fix; anything else keeps the raw detail.
    const status = (e: unknown) => Number(/→ (\d{3}):/.exec((e as Error).message)?.[1] ?? 0);
    let me: { login: string };
    try {
      me = await this.gh<{ login: string }>('GET', '/user');
    } catch (e) {
      if (status(e) === 401) return credentialRejected('GitHub');
      return { ok: false, reason: (e as Error).message };
    }
    // Verify push access to each configured repo — a read-only token would open a PR then fail to merge.
    for (const rp of this.cfg.repos) {
      try {
        const r = await this.gh<GhRepo & { permissions?: { push?: boolean } }>('GET', `/repos/${rp}`);
        if (r.permissions && r.permissions.push === false) {
          return { ok: false, reason: `token lacks push access to ${rp}` };
        }
      } catch (e) {
        // GitHub answers 404 both for a repo that doesn't exist and one the token can't see.
        if (status(e) === 404) return { ok: false, reason: `GitHub can’t find the repository ${rp}. Check the spelling (owner/name), or that ${me.login} has access to it.` };
        return { ok: false, reason: (e as Error).message };
      }
    }
    return { ok: true, identity: me.login };
  }

  async searchRepos(q: string): Promise<Repo[]> {
    // Scope to the configured repos; match by substring. Fetch each once.
    const matches = this.cfg.repos.filter((rp) => rp.toLowerCase().includes(q.toLowerCase()));
    const out: Repo[] = [];
    for (const rp of matches) out.push(this.toRepo(await this.gh<GhRepo>('GET', `/repos/${rp}`)));
    return out;
  }

  async getRepo(idOrPath: string): Promise<Repo> {
    return this.toRepo(await this.gh<GhRepo>('GET', `/repos/${idOrPath}`));
  }

  async cloneCredential(repo: Repo): Promise<{ url: string; header?: string }> {
    // Tokenized HTTPS URL the worker uses for clone + push. Never logged.
    const url = `https://x-access-token:${this.cfg.token}@${this.cfg.host}/${repo.path}.git`;
    return { url };
  }

  async openChangeRequest(
    repo: Repo,
    input: { head: string; base: string; title: string; body: string; draft: boolean },
  ): Promise<ChangeRequest> {
    const pr = await this.gh<GhPull>('POST', `/repos/${repo.path}/pulls`, {
      title: input.title, body: input.body, head: input.head, base: input.base, draft: input.draft,
    });
    return this.toChangeRequest(repo, pr);
  }

  async listChangeRequests(repo: Repo, q: { ticketKeys?: string[]; since?: string }): Promise<ChangeRequest[]> {
    const pulls = await this.gh<GhPull[]>('GET', `/repos/${repo.path}/pulls?state=all&per_page=100&sort=updated&direction=desc`);
    let filtered = pulls;
    if (q.since) filtered = filtered.filter((p) => p.updated_at >= q.since!);
    if (q.ticketKeys?.length) {
      // Match by ticket key appearing in title or head branch (agent branches embed the key).
      filtered = filtered.filter((p) =>
        q.ticketKeys!.some((k) => p.title.includes(k) || p.head.ref.includes(k.replace(/[^\w-]/g, '-'))),
      );
    }
    return Promise.all(filtered.map((p) => this.toChangeRequest(repo, p)));
  }

  async getChangeRequest(repo: Repo, number: number): Promise<ChangeRequest & { diffRefs: unknown }> {
    let pr = await this.gh<GhPull>('GET', `/repos/${repo.path}/pulls/${number}`);
    // Right after a merge GitHub can briefly report the PR closed with merged_at still
    // null (PR #231 was read that way 1s after its merge and recorded "closed without
    // merging"). Before calling a PR closed, ask the merge endpoint, which answers
    // 204 when it was merged and 404 when it wasn't.
    if (pr.state === 'closed' && !pr.merged_at && !pr.merged && await this.wasMerged(repo, number)) {
      pr = { ...pr, merged: true };
    }
    const cr = await this.toChangeRequest(repo, pr);
    return { ...cr, diffRefs: { headSha: pr.head.sha, baseSha: pr.base.sha } };
  }

  /** GET /pulls/:n/merge: 204 = merged, 404 = not merged. Anything else throws (retry later). */
  private async wasMerged(repo: Repo, number: number): Promise<boolean> {
    try {
      await this.gh<void>('GET', `/repos/${repo.path}/pulls/${number}/merge`);
      return true;
    } catch (err) {
      if (/→ 404:/.test((err as Error).message)) return false;
      throw err;
    }
  }

  async listReviewComments(repo: Repo, number: number): Promise<ReviewComment[]> {
    const cs = await this.gh<GhReviewComment[]>('GET', `/repos/${repo.path}/pulls/${number}/comments?per_page=100`);
    return cs.map((c) => ({
      id: String(c.id), author: c.user?.login ?? 'unknown', body: c.body,
      path: c.path, line: c.line, resolved: null, createdAt: c.created_at,
    }));
  }

  async changedFiles(repo: Repo, number: number, limit: number): Promise<string[]> {
    const max = Math.min(limit, 500);
    const out: string[] = [];
    for (let page = 1; out.length < max; page++) {
      const files = await this.gh<{ filename: string }[]>('GET', `/repos/${repo.path}/pulls/${number}/files?per_page=100&page=${page}`);
      out.push(...files.map((f) => f.filename));
      if (files.length < 100) break;
    }
    return out.slice(0, max);
  }

  async comment(repo: Repo, number: number, body: string, anchor?: { path: string; line: number }): Promise<void> {
    if (anchor) {
      // A line comment needs the head sha to anchor against.
      const pr = await this.gh<GhPull>('GET', `/repos/${repo.path}/pulls/${number}`);
      await this.gh('POST', `/repos/${repo.path}/pulls/${number}/comments`, {
        body, commit_id: pr.head.sha, path: anchor.path, line: anchor.line, side: 'RIGHT',
      });
    } else {
      // A plain PR comment is an issue comment on the PR number.
      await this.gh('POST', `/repos/${repo.path}/issues/${number}/comments`, { body });
    }
  }

  async markReady(repo: Repo, number: number): Promise<void> {
    const id = await this.nodeId(repo, number);
    await this.graphql<{ markPullRequestReadyForReview: { pullRequest: { isDraft: boolean } } }>(
      `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
      { id },
    );
  }

  async merge(repo: Repo, number: number, opts: { method: 'merge' | 'squash' | 'rebase' }): Promise<void> {
    await this.gh('PUT', `/repos/${repo.path}/pulls/${number}/merge`, { merge_method: opts.method });
  }
}
