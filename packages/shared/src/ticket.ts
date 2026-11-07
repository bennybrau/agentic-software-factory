import { z } from 'zod';

/**
 * The provider-neutral ticket. Every TicketProvider maps its native object to
 * this and back. Rich text is Markdown at this seam; ADF/HTML codecs live
 * inside the provider that needs them.
 */
export const ticketBucketSchema = z.enum(['backlog', 'ready', 'inflight', 'review', 'blocked', 'done']);
export type TicketBucket = z.infer<typeof ticketBucketSchema>;

export const ticketLinkSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  kind: z.enum(['figma', 'doc', 'design', 'other']).default('other'),
});
export type TicketLink = z.infer<typeof ticketLinkSchema>;

export const ticketSchema = z.object({
  id: z.string(),            // provider-native id, opaque
  key: z.string(),           // human handle: "SWL-139", "#42", a Trello short link
  url: z.string(),           // the provider's own web URL, copied never constructed
  title: z.string(),
  body: z.string().default(''),          // Markdown
  status: z.string(),                    // raw provider status name
  bucket: ticketBucketSchema,            // derived by provider config
  priority: z.number().int().min(1).max(5).nullable(), // 1 = highest
  assignee: z.string().nullable(),
  labels: z.array(z.string()).default([]),
  links: z.array(ticketLinkSchema).default([]),
  parentId: z.string().nullable(),
  children: z.array(z.string()).default([]),
  updatedAt: z.string(),                 // ISO
  /** Ad-hoc tickets only: the recurring task (#188) that created it, and its title (null once the schedule is deleted). */
  recurringId: z.string().nullable().optional(),
  recurringTitle: z.string().nullable().optional(),
  /** Ad-hoc tickets only: the repository the run that added this to-do was working in. */
  sourceRepoId: z.string().nullable().optional(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const ticketCommentSchema = z.object({
  id: z.string(),
  author: z.string(),
  markdown: z.string(),
  createdAt: z.string(),
});
export type TicketComment = z.infer<typeof ticketCommentSchema>;

export const ticketTransitionSchema = z.object({ id: z.string(), name: z.string(), toStatus: z.string() });
export type TicketTransition = z.infer<typeof ticketTransitionSchema>;

export const ticketProviderKindSchema = z.enum(['mock', 'jira', 'github', 'gitlab', 'trello', 'monday', 'linear', 'todoist', 'adhoc']);
export type TicketProviderKind = z.infer<typeof ticketProviderKindSchema>;

/**
 * A selectable backlog scope the credentials can see. Board and project are the
 * two kinds ASF scopes on; `boardType` and `team` are optional annotations a
 * board-based tracker (Jira) fills in so the UI can gate the sprint control on
 * Scrum boards and group boards under a named team. The neutral Ticket never
 * carries any of this — it stays a provider-side, discovery-only concept.
 */
export const ticketScopeSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['board', 'project']),
  boardType: z.enum(['scrum', 'kanban']).optional(),
  team: z.string().optional(),
});
export type TicketScope = z.infer<typeof ticketScopeSchema>;

/** A sprint on a Scrum board. Meaningless without its board, so it carries boardId. */
export const ticketSprintSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(['active', 'future', 'closed']),
  boardId: z.string(),
});
export type TicketSprint = z.infer<typeof ticketSprintSchema>;

export interface TicketListQuery {
  scope: string[];
  bucket?: TicketBucket[];
  /** Provider-specific sprint selection (Scrum boards): sprint ids, or the sentinels 'active'/'backlog'. */
  sprint?: string[];
  /** Raw provider status names to filter on, pushed down to the tracker where possible. */
  status?: string[];
  /** Exclude finished work (the `done` bucket) so the backlog doesn't pay to fetch it. Pushed down where possible. */
  excludeDone?: boolean;
  /** Only issues updated within the last N days. Pushed down where possible; used for the recent-Done view. */
  updatedWithinDays?: number;
  search?: string;
  cursor?: string;
  limit: number;
}

export interface TicketProviderCapabilities {
  subtasks: boolean;
  priority: boolean;
  links: boolean;
  transitions: boolean;
  /** The tracker supports programmatic assignment (assign()). */
  assignable: boolean;
  /** The tracker exposes board-scoped discovery via listScopes(). */
  boards: boolean;
  /** The tracker exposes sprints on a (Scrum) board via listSprints(). */
  sprints: boolean;
  /** The tracker exposes its status names via listStatuses(). */
  statuses: boolean;
}

/**
 * A provider's live connection check. `credentialRejected`: the service answered
 * 401 to the saved token (revoked, expired, mistyped) — the one failure whose fix
 * is always "paste a new token", so the UI can say exactly that.
 */
export type Preflight = { ok: true; identity: string } | { ok: false; reason: string; credentialRejected?: boolean };

export interface TicketProvider {
  readonly kind: TicketProviderKind;
  preflight(): Promise<Preflight>;
  capabilities(): TicketProviderCapabilities;
  list(q: TicketListQuery): Promise<{ tickets: Ticket[]; next?: string }>;
  get(id: string): Promise<Ticket>;
  update(id: string, patch: Partial<Pick<Ticket, 'title' | 'body' | 'priority' | 'labels'>>): Promise<Ticket>;
  createSubtask(parentId: string, input: { title: string; body?: string }): Promise<Ticket>;
  addLink(id: string, link: TicketLink): Promise<void>;
  comment(id: string, markdown: string): Promise<{ commentId: string; url?: string }>;
  listComments(id: string): Promise<TicketComment[]>;
  transitions(id: string): Promise<TicketTransition[]>;
  transition(id: string, transitionId: string): Promise<void>;
  /**
   * Assign the ticket to a provider-native identity — the factory's own
   * bot/service account. Jira: an accountId. GitHub: a user login. `null`
   * unassigns. A tracker that cannot assign throws; callers treat this as
   * best-effort (see assignTicketTo). A tracker may accept an assign to an
   * ineligible account and silently not apply it — assignment is a hint here,
   * not a guarantee.
   */
  assign(id: string, assignee: string | null): Promise<void>;
  /**
   * Discovery for backlog scoping (all capability-gated — a tracker whose
   * corresponding capability is false throws, like createSubtask). The api
   * exposes these so the UI can offer scope/sprint/status controls; the neutral
   * Ticket is unchanged and board/sprint stay provider-side concepts.
   */
  /** The boards/projects the credentials can see. Gated by capabilities().boards. */
  listScopes(): Promise<TicketScope[]>;
  /** The sprints on a Scrum board. Gated by capabilities().sprints. */
  listSprints(scopeId: string): Promise<TicketSprint[]>;
  /** The status names available (optionally within a scope). Gated by capabilities().statuses. */
  listStatuses(scopeId?: string): Promise<string[]>;
  /**
   * Optional. When the tracker co-locates issues with code (a GitHub issue
   * lives in a repo), return the SCM repo path this ticket belongs to so the
   * dispatch UI can default the repo picker to it. Return null when there is no
   * natural repo (e.g. a Jira ticket that spans many).
   */
  suggestedRepo?(ticket: Ticket): string | null;
}
