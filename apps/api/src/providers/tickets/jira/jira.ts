import { ticketMatches } from '@asf/shared';
import type {
  Preflight, Ticket, TicketBucket, TicketComment, TicketLink, TicketListQuery,
  TicketProvider, TicketProviderCapabilities, TicketScope, TicketSprint, TicketTransition,
} from '@asf/shared';
import { adfToMarkdown, markdownToAdf, adfToReadable, adfToText } from './adf.js';
import { preflightFailure } from '../../rejected.js';

/**
 * Jira Cloud as a TicketProvider. Talks to the REST v3 API directly over fetch
 * (no SDK), so it runs unchanged in a container; the api is the only process
 * that holds the credential and agents never see it.
 *
 * Rich text is ADF on Jira's side and Markdown at this seam. The codec in
 * adf.ts does the mapping with an all-or-nothing-per-block guarantee: on a
 * write we re-read the issue, so a block the Markdown grammar cannot represent
 * (a table, a panel) round-trips verbatim and a concurrent edit is detected
 * (an unresolved placeholder) and the write refused rather than corrupting the
 * description.
 *
 * Identity mapping:
 *   id = key = the Jira issue key ("SWL-139"); the human handle IS the id.
 *   url = <baseUrl>/browse/<key>   — the one URL Jira guarantees.
 * Bucket:  JIRA_BUCKET_MAP status rules first, else the statusCategory
 *          (new→backlog, indeterminate→inflight, done→done).
 * Priority: Jira's priority field name mapped to 1..5 (1 = highest).
 */

export interface JiraTicketConfig {
  baseUrl: string;          // https://<org>.atlassian.net
  email: string;
  apiToken: string;
  projects: string[];       // ["SWL", "OO", ...]
  boards: string[];         // Agile board ids scoping the backlog; empty = project-JQL fallback
  teams: Array<{ team: string; boards: string[] }>; // named groups of board ids (UI grouping only)
  jqlTemplate: string;      // "project in ({{projects}}) ORDER BY updated DESC"
  bucketMap: Array<{ status: string; bucket: TicketBucket }>;
}

const PAGE_SIZE = 50;
const MAX_PAGES = 20;       // bounds a single walk (opaque continuation tokens, no total)

// Jira's five default priorities, highest first. A site with custom priorities
// falls through to null, which the neutral ticket treats as "unset".
const PRIORITY_RANK: Record<string, number> = {
  highest: 1, high: 2, medium: 3, low: 4, lowest: 5,
};

interface JiraUser { displayName?: string | null; emailAddress?: string | null }
interface JiraStatusCategory { key?: string }
interface JiraStatus { name: string; statusCategory?: JiraStatusCategory | null }
interface JiraPriority { name?: string | null }
interface JiraIssueFields {
  summary?: string | null;
  description?: unknown;          // ADF, or null, or (old sites) a bare string
  updated?: string | null;
  labels?: string[] | null;
  status?: JiraStatus | null;
  priority?: JiraPriority | null;
  assignee?: JiraUser | null;
  parent?: { key?: string } | null;
  subtasks?: Array<{ key?: string }> | null;
  project?: { key?: string; name?: string | null } | null;
}
interface JiraIssue { id: string; key: string; fields: JiraIssueFields }
interface JiraSearchResponse { issues?: JiraIssue[]; nextPageToken?: string | null; isLast?: boolean | null }
// The Agile board endpoints paginate with startAt/total, not an opaque token.
interface JiraBoardIssuesResponse { issues?: JiraIssue[]; startAt?: number | null; total?: number | null }
interface JiraBoard { id: number; name: string; type?: string | null }
interface JiraSprint { id: number; name: string; state?: string | null; originBoardId?: number | null }
// The Agile /board and /sprint listings paginate with startAt/total/isLast and wrap rows in `values`.
interface JiraAgilePage<T> { values?: T[]; startAt?: number | null; total?: number | null; isLast?: boolean | null }
interface JiraProject { key: string; name?: string | null }
interface JiraStatusEntry { name?: string | null }
interface JiraComment { id: string; author?: JiraUser | null; body?: unknown; created?: string | null }

/** status=bucket,status=bucket → rules. Mirrors parseBucketMap for GitHub. */
export function parseJiraBucketMap(raw: string): JiraTicketConfig['bucketMap'] {
  const valid: TicketBucket[] = ['backlog', 'ready', 'inflight', 'review', 'blocked', 'done'];
  const out: JiraTicketConfig['bucketMap'] = [];
  for (const pair of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.lastIndexOf('=');
    if (eq < 0) continue;
    const status = pair.slice(0, eq).trim();
    const bucket = pair.slice(eq + 1).trim() as TicketBucket;
    if (status && valid.includes(bucket)) out.push({ status, bucket });
  }
  return out;
}

/**
 * Parse "payments=42,43; identity=51" into named board groups (the Team
 * shortcut). Purely a grouping of board ids — no Jira Team field is read.
 * Groups are separated by ';', a group is "name=id,id"; blank/invalid parts drop.
 */
export function parseJiraTeams(raw: string): JiraTicketConfig['teams'] {
  const out: JiraTicketConfig['teams'] = [];
  for (const group of raw.split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = group.indexOf('=');
    if (eq < 0) continue;
    const team = group.slice(0, eq).trim();
    const boards = group.slice(eq + 1).split(',').map((s) => s.trim()).filter(Boolean);
    if (team && boards.length) out.push({ team, boards });
  }
  return out;
}

/** Jira sprint state is 'active'|'future'|'closed'; anything else is treated as closed. */
function sprintState(raw: string | null | undefined): TicketSprint['state'] {
  const s = (raw ?? '').toLowerCase();
  return s === 'active' || s === 'future' ? s : 'closed';
}

/** Quotes a value for JQL — backslashes and quotes both escape. */
export function jqlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Expand {{projects}} in the JQL template to the quoted, comma-joined keys.
 * The template must stay bounded either way — Jira rejects an unrestricted
 * query — so a caller who omits {{projects}} owns writing their own filter.
 */
export function renderJql(template: string, projects: readonly string[]): string {
  const list = projects.map(jqlQuote).join(', ');
  return template.replace(/\{\{\s*projects\s*\}\}/g, list);
}

export function bucketOf(
  status: JiraStatus | null | undefined,
  map: JiraTicketConfig['bucketMap'],
): TicketBucket {
  const name = (status?.name ?? '').toLowerCase();
  for (const rule of map) if (rule.status.toLowerCase() === name) return rule.bucket;
  switch (status?.statusCategory?.key) {
    case 'new': return 'backlog';
    case 'indeterminate': return 'inflight';
    case 'done': return 'done';
    default: return 'backlog';
  }
}

export function priorityOf(priority: JiraPriority | null | undefined): number | null {
  const name = (priority?.name ?? '').toLowerCase();
  return PRIORITY_RANK[name] ?? null;
}

export class JiraTicketProvider implements TicketProvider {
  readonly kind = 'jira' as const;
  private readonly cfg: JiraTicketConfig;

  constructor(cfg: JiraTicketConfig) {
    this.cfg = cfg;
  }

  private authHeader(): string {
    const basic = Buffer.from(`${this.cfg.email}:${this.cfg.apiToken}`).toString('base64');
    return `Basic ${basic}`;
  }

  private async jira<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader(),
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Jira ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return (res.status === 204 ? (undefined as T) : ((await res.json()) as T));
  }

  private issueUrl(key: string): string {
    return `${this.cfg.baseUrl}/browse/${encodeURIComponent(key)}`;
  }

  private toTicket(issue: JiraIssue): Ticket {
    const f = issue.fields ?? {};
    return {
      id: issue.key,
      key: issue.key,
      url: this.issueUrl(issue.key),
      title: f.summary ?? '',
      // Readable: blocks the editing grammar can't spell exactly (a coloured
      // word, a table, a panel) are rendered as plain markdown, not as
      // ⟦jira-block-N⟧ tokens, so the board and the agent can read them.
      // update() never trusts this text for those blocks: it re-reads the
      // description from Jira and resolves tokens against that.
      body: adfToReadable(f.description ?? null),
      status: f.status?.name ?? 'Unknown',
      bucket: bucketOf(f.status, this.cfg.bucketMap),
      priority: priorityOf(f.priority),
      assignee: f.assignee?.displayName ?? f.assignee?.emailAddress ?? null,
      labels: f.labels ?? [],
      links: [],
      parentId: f.parent?.key ?? null,
      children: (f.subtasks ?? []).map((s) => s.key).filter((k): k is string => Boolean(k)),
      updatedAt: f.updated ?? new Date().toISOString(),
    };
  }

  /**
   * The fields a single ticket (get/update) is built from — includes the ADF
   * description. A tight list is fewer of the strictly-sequential pages the
   * platform-search endpoint forces (opaque continuation tokens).
   */
  private static readonly FIELDS = [
    'summary', 'description', 'status', 'priority', 'assignee',
    'labels', 'updated', 'parent', 'subtasks', 'project',
  ].join(',');

  /**
   * The fields the backlog LIST needs — deliberately WITHOUT `description`. The
   * list table never renders the body, and a board's descriptions are both the
   * bulk of the payload and an ADF→Markdown parse per issue; omitting them here
   * is the single biggest list-load win. get() still fetches the full FIELDS.
   */
  private static readonly LIST_FIELDS = [
    'summary', 'status', 'priority', 'assignee',
    'labels', 'updated', 'parent', 'subtasks', 'project',
  ].join(',');

  /**
   * Build the jql= filter ANDed onto an Agile endpoint (which already applies the
   * board's saved filter): status names, exclude-done, and an updated-within
   * window. `extra` carries a caller clause such as `sprint in openSprints()`.
   */
  private jqlFor(q: TicketListQuery, extra: string[] = []): string | undefined {
    const clauses = [...extra];
    if (q.status?.length) clauses.push(`status in (${q.status.map(jqlQuote).join(', ')})`);
    if (q.excludeDone) clauses.push('statusCategory != Done');
    if (q.updatedWithinDays && q.updatedWithinDays > 0) clauses.push(`updated >= -${Math.floor(q.updatedWithinDays)}d`);
    return clauses.length ? clauses.join(' AND ') : undefined;
  }

  async preflight(): Promise<Preflight> {
    if (!this.cfg.baseUrl) return { ok: false, reason: 'JIRA_BASE_URL is empty' };
    if (!this.cfg.email || !this.cfg.apiToken) return { ok: false, reason: 'JIRA_EMAIL / JIRA_API_TOKEN is empty' };
    try {
      // /myself, NOT search: the search endpoint answers 200 with an empty
      // result to a dead credential (it treats the caller as anonymous), so it
      // cannot tell a bad token from a project with no issues. /myself answers
      // 401. This is the documented trap the plan calls out.
      const me = await this.jira<{ accountId: string; displayName?: string; emailAddress?: string }>('GET', '/rest/api/3/myself');
      return { ok: true, identity: me.displayName ?? me.emailAddress ?? me.accountId };
    } catch (e) {
      return preflightFailure('Jira', e);
    }
  }

  capabilities(): TicketProviderCapabilities {
    return { subtasks: true, priority: true, links: false, transitions: true, assignable: true, boards: true, sprints: true, statuses: true };
  }

  /** A Jira ticket spans no natural repo — the picker has nothing to default to. */
  suggestedRepo(): string | null {
    return null;
  }

  async list(q: TicketListQuery): Promise<{ tickets: Ticket[]; next?: string }> {
    // Boards scope, when configured, adopts each board's own saved filter and is
    // read + paginated in Jira over the Agile API — the way to avoid pulling a
    // whole large project. q.scope may narrow the configured boards to a subset,
    // but only ever to configured boards: an id outside the set (e.g. a stale
    // project key persisted in the UI from before boards were configured) is
    // ignored rather than sent to /board/<id>/issue, which would 500. When q.scope
    // names none of the configured boards, fall back to all of them. With no
    // boards configured at all, use the project-JQL path unchanged.
    const requested = q.scope.filter((s) => this.cfg.boards.includes(s));
    const boards = this.cfg.boards.length ? (requested.length ? requested : this.cfg.boards) : [];
    // Status/exclude-done/updated-window are pushed down to Jira (the Agile
    // endpoints take a jql= that ANDs with the board's saved filter), so the work
    // of filtering — and NOT fetching finished issues — happens in Jira.
    const jql = this.jqlFor(q);
    // Sprint is per-board and only applies when exactly one board is scoped;
    // across a team's boards (or in the project fallback) it is ignored.
    const sprint = boards.length === 1 ? q.sprint?.[0] : undefined;
    const issues = !boards.length
      ? await this.listByJql(q)
      : sprint
        ? await this.listSprintIssues(boards[0], sprint, q)
        : await this.listBoardIssues(boards, jql);

    let out = issues.map((i) => this.toTicket(i));
    // The project-JQL path cannot push these down (the template owns the query),
    // so filter those results here; the Agile path already filtered in Jira.
    if (!boards.length) {
      if (q.status?.length) out = out.filter((t) => q.status!.includes(t.status));
      if (q.updatedWithinDays && q.updatedWithinDays > 0) {
        const cutoff = Date.now() - q.updatedWithinDays * 86_400_000;
        out = out.filter((t) => Date.parse(t.updatedAt) >= cutoff);
      }
    }
    // Exclude-done is enforced on the exact bucket everywhere (belt-and-suspenders
    // over the statusCategory push-down, and the only enforcement on the project path).
    if (q.excludeDone) out = out.filter((t) => t.bucket !== 'done');
    if (q.bucket?.length) out = out.filter((t) => q.bucket!.includes(t.bucket));
    if (q.search) out = out.filter((t) => ticketMatches(t, q.search!));
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { tickets: out.slice(0, q.limit) };
  }

  /** The project-JQL path: whole-project platform search, walked by opaque token. */
  private async listByJql(q: TicketListQuery): Promise<JiraIssue[]> {
    // q.scope overrides the configured projects; the template still frames it.
    const projects = q.scope.length ? q.scope : this.cfg.projects;
    const jql = renderJql(this.cfg.jqlTemplate, projects);

    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    let page = 0;
    do {
      page += 1;
      const params = new URLSearchParams({ jql, maxResults: String(PAGE_SIZE), fields: JiraTicketProvider.LIST_FIELDS });
      if (nextPageToken) params.set('nextPageToken', nextPageToken);
      const res = await this.jira<JiraSearchResponse>('GET', `/rest/api/3/search/jql?${params.toString()}`);
      issues.push(...(res.issues ?? []));
      // Absent (not null) on the last page; isLast is advisory, the token is
      // authoritative, so key the loop off the token.
      nextPageToken = res.nextPageToken ?? undefined;
      if (res.isLast === true) nextPageToken = undefined;
    } while (nextPageToken && page < MAX_PAGES);
    return issues;
  }

  /** Page any Agile issues endpoint (board/backlog/sprint), which all use startAt/total and an optional jql= filter. */
  private async agileIssues(path: string, jql?: string): Promise<JiraIssue[]> {
    const out: JiraIssue[] = [];
    let startAt = 0;
    let page = 0;
    for (;;) {
      page += 1;
      const params = new URLSearchParams({ startAt: String(startAt), maxResults: String(PAGE_SIZE), fields: JiraTicketProvider.LIST_FIELDS });
      if (jql) params.set('jql', jql);
      const res = await this.jira<JiraBoardIssuesResponse>('GET', `${path}?${params.toString()}`);
      const batch = res.issues ?? [];
      out.push(...batch);
      startAt += batch.length;
      const total = res.total ?? startAt;
      if (batch.length === 0 || startAt >= total || page >= MAX_PAGES) break;
    }
    return out;
  }

  /**
   * The Agile-API path: every issue on each scoped board (its saved filter).
   * Boards may overlap or share issues, so dedupe by key. A board id Jira
   * rejects surfaces as an error, not a silent empty.
   */
  private async listBoardIssues(boards: readonly string[], jql?: string): Promise<JiraIssue[]> {
    const byKey = new Map<string, JiraIssue>();
    for (const boardId of boards) {
      for (const issue of await this.agileIssues(`/rest/agile/1.0/board/${encodeURIComponent(boardId)}/issue`, jql)) {
        byKey.set(issue.key, issue);
      }
    }
    return [...byKey.values()];
  }

  /**
   * Issues for a sprint selection on one board (docs/BACKLOG_SCOPING.md sprint
   * semantics): 'active' = the board's open sprint(s), 'backlog' = issues on the
   * board not in any sprint, else a specific sprint id. The status/exclude-done/
   * updated-window filters AND in.
   */
  private async listSprintIssues(boardId: string, sprint: string, q: TicketListQuery): Promise<JiraIssue[]> {
    const base = `/rest/agile/1.0/board/${encodeURIComponent(boardId)}`;
    if (sprint === 'backlog') return this.agileIssues(`${base}/backlog`, this.jqlFor(q));
    if (sprint === 'active') return this.agileIssues(`${base}/issue`, this.jqlFor(q, ['sprint in openSprints()']));
    return this.agileIssues(`${base}/sprint/${encodeURIComponent(sprint)}/issue`, this.jqlFor(q));
  }

  async get(id: string): Promise<Ticket> {
    const issue = await this.jira<JiraIssue>('GET', `/rest/api/3/issue/${encodeURIComponent(id)}?fields=${JiraTicketProvider.FIELDS}`);
    return this.toTicket(issue);
  }

  async update(id: string, patch: Partial<Pick<Ticket, 'title' | 'body' | 'priority' | 'labels'>>): Promise<Ticket> {
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.summary = patch.title;
    if (patch.body !== undefined) {
      // Re-read the description so preserved blocks (tables, panels) resolve and
      // a concurrent Jira edit is caught: an unresolved placeholder means the
      // description changed under us, and the only safe answer is to refuse.
      const current = await this.jira<JiraIssue>('GET', `/rest/api/3/issue/${encodeURIComponent(id)}?fields=description`);
      const { preserved } = adfToMarkdown(current.fields?.description ?? null);
      const { doc, unresolved } = markdownToAdf(patch.body, preserved);
      if (unresolved.length > 0) {
        throw new Error(`jira: refusing to save ${id} — the description changed in Jira (unresolved ${unresolved.join(', ')}); reload and retry`);
      }
      fields.description = doc;
    }
    if (patch.labels !== undefined) fields.labels = patch.labels;
    if (patch.priority !== undefined && patch.priority !== null) {
      // Map 1..5 back to Jira's default priority names. A site with custom
      // priorities would need its own map; the neutral seam only knows 1..5.
      const byRank = Object.entries(PRIORITY_RANK).find(([, rank]) => rank === patch.priority);
      if (byRank) fields.priority = { name: byRank[0].charAt(0).toUpperCase() + byRank[0].slice(1) };
    }
    if (Object.keys(fields).length > 0) {
      await this.jira('PUT', `/rest/api/3/issue/${encodeURIComponent(id)}?notifyUsers=false`, { fields });
    }
    return this.get(id);
  }

  async createSubtask(parentId: string, input: { title: string; body?: string }): Promise<Ticket> {
    // A subtask's project is the parent's; read it to fill the required field.
    const parent = await this.jira<JiraIssue>('GET', `/rest/api/3/issue/${encodeURIComponent(parentId)}?fields=project`);
    const projectKey = parent.fields?.project?.key;
    if (!projectKey) throw new Error(`jira: cannot create subtask — no project on ${parentId}`);
    const body = {
      fields: {
        project: { key: projectKey },
        parent: { key: parentId },
        summary: input.title,
        issuetype: { name: 'Subtask' },
        ...(input.body ? { description: markdownToAdf(input.body).doc } : {}),
      },
    };
    const created = await this.jira<{ key: string }>('POST', '/rest/api/3/issue', body);
    return this.get(created.key);
  }

  async addLink(id: string, link: TicketLink): Promise<void> {
    // Jira has no free-form links field on an issue; append the link to the
    // description as a paragraph, preserving everything else via the codec.
    const current = await this.jira<JiraIssue>('GET', `/rest/api/3/issue/${encodeURIComponent(id)}?fields=description`);
    const { text, preserved } = adfToMarkdown(current.fields?.description ?? null);
    const next = `${text}\n\n[${link.title}](${link.url})`.trim();
    const { doc, unresolved } = markdownToAdf(next, preserved);
    if (unresolved.length > 0) {
      throw new Error(`jira: refusing to add link to ${id} — the description changed in Jira; reload and retry`);
    }
    await this.jira('PUT', `/rest/api/3/issue/${encodeURIComponent(id)}?notifyUsers=false`, { fields: { description: doc } });
  }

  async comment(id: string, markdown: string): Promise<{ commentId: string; url?: string }> {
    const c = await this.jira<{ id: string }>(
      'POST', `/rest/api/3/issue/${encodeURIComponent(id)}/comment`,
      { body: markdownToAdf(markdown).doc },
    );
    return { commentId: c.id, url: `${this.issueUrl(id)}?focusedCommentId=${c.id}` };
  }

  async listComments(id: string): Promise<TicketComment[]> {
    const res = await this.jira<{ comments?: JiraComment[] }>('GET', `/rest/api/3/issue/${encodeURIComponent(id)}/comment`);
    return (res.comments ?? []).map((c) => ({
      id: c.id,
      author: c.author?.displayName ?? c.author?.emailAddress ?? 'unknown',
      markdown: adfToText(c.body ?? null),
      createdAt: c.created ?? new Date().toISOString(),
    }));
  }

  async transitions(id: string): Promise<TicketTransition[]> {
    // Read, never configured: a transition id is per-workflow and a status name
    // is per-project. Hardcoding "31" works until the second project.
    const res = await this.jira<{ transitions?: Array<{ id: string; name: string; to?: { name?: string } | null }> }>(
      'GET', `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`,
    );
    return (res.transitions ?? []).map((t) => ({ id: t.id, name: t.name, toStatus: t.to?.name ?? t.name }));
  }

  async transition(id: string, transitionId: string): Promise<void> {
    await this.jira('POST', `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`, { transition: { id: transitionId } });
  }

  async assign(id: string, assignee: string | null): Promise<void> {
    // Jira Cloud assigns by accountId (never display name or email). accountId
    // null explicitly unassigns; the string "-1" would set the project default.
    // A PUT succeeds (204) even when the account lacks the "Assignable User"
    // permission in the project — Jira silently drops the assignee in that case.
    await this.jira('PUT', `/rest/api/3/issue/${encodeURIComponent(id)}/assignee`, { accountId: assignee });
  }

  /** The team a board id belongs to, if any (first matching JIRA_TEAMS group). */
  private teamOf(boardId: string): string | undefined {
    return this.cfg.teams.find((t) => t.boards.includes(boardId))?.team;
  }

  private boardScope(b: JiraBoard): TicketScope {
    const id = String(b.id);
    const team = this.teamOf(id);
    return {
      id, name: b.name, kind: 'board',
      boardType: b.type === 'scrum' ? 'scrum' : 'kanban',
      ...(team ? { team } : {}),
    };
  }

  /**
   * The selectable backlog scopes. Bounded to the operator's configured scope
   * (the enumeration-cost open question in docs/BACKLOG_SCOPING.md): the
   * configured boards when JIRA_BOARDS is set — each fetched for its name/type so
   * the UI can gate the sprint control and group by team — otherwise the
   * configured projects, since that is what the project-JQL fallback selects on.
   */
  async listScopes(): Promise<TicketScope[]> {
    if (this.cfg.boards.length) {
      const scopes: TicketScope[] = [];
      for (const id of this.cfg.boards) {
        const b = await this.jira<JiraBoard>('GET', `/rest/agile/1.0/board/${encodeURIComponent(id)}`);
        scopes.push(this.boardScope(b));
      }
      return scopes;
    }
    const scopes: TicketScope[] = [];
    for (const key of this.cfg.projects) {
      const p = await this.jira<JiraProject>('GET', `/rest/api/3/project/${encodeURIComponent(key)}`);
      scopes.push({ id: p.key, name: p.name ?? p.key, kind: 'project' });
    }
    return scopes;
  }

  /** Sprints on a Scrum board, paginated by startAt/total. A Kanban board has none (Jira 400s → caller gates on boardType). */
  async listSprints(scopeId: string): Promise<TicketSprint[]> {
    const out: TicketSprint[] = [];
    let startAt = 0;
    let page = 0;
    for (;;) {
      page += 1;
      const params = new URLSearchParams({ startAt: String(startAt), maxResults: String(PAGE_SIZE) });
      const res = await this.jira<JiraAgilePage<JiraSprint>>('GET', `/rest/agile/1.0/board/${encodeURIComponent(scopeId)}/sprint?${params.toString()}`);
      const batch = res.values ?? [];
      for (const s of batch) out.push({ id: String(s.id), name: s.name, state: sprintState(s.state), boardId: scopeId });
      startAt += batch.length;
      if (batch.length === 0 || res.isLast === true || startAt >= (res.total ?? startAt) || page >= MAX_PAGES) break;
    }
    return out;
  }

  /**
   * The status names for the status multi-select. Jira has no board-scoped status
   * endpoint, so this returns the instance's status names (deduped, sorted);
   * scopeId is accepted for the seam but not used here.
   */
  async listStatuses(): Promise<string[]> {
    const all = await this.jira<JiraStatusEntry[]>('GET', '/rest/api/3/status');
    const names = new Set<string>();
    for (const s of all) if (s.name) names.add(s.name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }
}
