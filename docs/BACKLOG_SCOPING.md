# Backlog scoping — boards, sprints, status

> **Status: design.** This describes a feature not yet built. It sets the model
> and the seams so the implementation lands in the right places. See
> `docs/PROVIDERS.md` for the ticket-provider contract this extends.

## The problem

The factory points at a work tracker and shows its backlog. On a small project
that is the whole story. On a **large** one it isn't: a company-wide Jira project (say `PROJ`)
spans many teams and repos, so "show me PROJ" means loading thousands of issues
the operator will never act on. Today the Jira provider runs
`project in (PROJ) ORDER BY updated DESC` against the platform search API, walks up
to ~1000 issues, and filters **client-side** by bucket and title
(`apps/api/src/providers/tickets/jira/jira.ts`, `list()`). That is both slow and a
poor UX: there is no way to say "just my team's current sprint."

We need to **scope the backlog** to a meaningful slice of a big project, and let a
person narrow it further at a glance.

## The decision: scope by Board

Jira gives several axes to slice on — Team, Sprint, Status, Component, Board. We
scope on **Board**, and treat Sprint and Status as filters *within* a board.
Team is a **named group of boards**, not a query. The reasoning follows the Jira
model directly:

- **A board *is* a saved JQL filter.** Selecting a board adopts that team's own
  definition of their work — whatever mix of component, label, or custom field
  they use — without ASF reverse-engineering it. This is the single most
  load-bearing fact.
- **"Team" is not a reliable field in Jira.** Depending on configuration it is an
  Advanced Roadmaps team custom field, a component, a label, or simply "what's on
  our board." Filtering `PROJ` by a Team field is brittle and varies per project.
  Since **a team has one or more boards**, a team is naturally a *set of boards* —
  a configuration concept, not a JQL clause.
- **Sprints only exist on Scrum boards and are queried per board**
  (`/rest/agile/1.0/board/{id}/sprint`). A sprint is meaningless without a board
  context, so it is inherently a sub-filter of a board, never a peer.
- **Status is orthogonal** and already modelled (each raw status maps to a
  neutral bucket). It layers on top of any board/sprint selection.

So the filter hierarchy is:

```
Team (a named group of boards)
  └─ Board
       └─ Sprint   (Scrum boards only)
            └─ Status
```

Each level is optional and narrows the last.

### The performance win

Scoping by board lets the Jira provider switch from the whole-project platform
search to the **Agile API**, which is already scoped to a board's filter and
paginated:

- `GET /rest/agile/1.0/board/{id}/backlog` — the board's backlog, or
- `GET /rest/agile/1.0/board/{id}/sprint/{sprintId}/issue` — one sprint, and
- a pushed-down `jql=` parameter on those endpoints carries the **status** filter.

Filtering happens **in Jira**, not in the browser. We stop pulling all of `PROJ`.

## Two levers, kept separate

Scoping has a coarse, deploy-time part and a fine, runtime part. Do not conflate
them.

1. **Operator scope (config, coarse).** Which boards make up the ASF backlog at
   all. New `JIRA_BOARDS` setting, alongside the existing `JIRA_PROJECTS`. This
   alone solves "don't load all of PROJ." (Today the list route even hardcodes
   `scope: []`, so nothing is selectable — that goes away.)
2. **User filters (UI, fine).** Within the configured scope, a person narrows by
   team → board → sprint → status without a redeploy. Selection persists so a
   team's default sticks between sessions.

## Mixed Scrum / Kanban

`PROJ` teams are mixed: some run Scrum boards (with sprints), some Kanban (without).
The provider reports each board's **type** on discovery, and the UI shows the
sprint control **only** when the selected board is Scrum. Kanban boards ignore the
sprint axis entirely and filter on board + status alone.

### Sprint semantics (Scrum boards)

| Selection | Meaning | Source |
|---|---|---|
| `active` (default) | the board's currently open sprint(s) | `/board/{id}/sprint?state=active` |
| a specific sprint id | that sprint | `/board/{id}/sprint/{id}/issue` |
| `backlog` | issues on the board not assigned to any sprint | `/board/{id}/backlog` |

## Configuration

New keys in `packages/shared/src/settings.ts`, group **Providers**, tier
`env,org` (UI-settable, hot-swappable), regenerated into `.env.example` and
`docs/CONFIGURATION.md` with `pnpm gen:config`:

| Key | Purpose |
|---|---|
| `JIRA_BOARDS` | Comma-separated board ids that make up the backlog scope. When set, the provider uses the Agile board endpoints; when empty, it falls back to the `JIRA_PROJECTS` / `JIRA_JQL_TEMPLATE` path. |
| `JIRA_TEAMS` | Optional. Named board groups, e.g. `payments=42,43; identity=51`. Drives the Team shortcut in the UI. Purely a grouping — no Jira Team field is read. |

`JIRA_PROJECTS`, `JIRA_JQL_TEMPLATE`, and `JIRA_BUCKET_MAP` are unchanged and
remain the fallback for deployments that don't use boards.

## The contract changes

Extends the neutral `TicketProvider` seam in `packages/shared/src/ticket.ts`.
Board and sprint stay **Jira-specific inside the provider**; the seam stays
generic so other trackers can reuse it (Trello already has boards).

- **`TicketListQuery`** gains `sprint?: string[]` and `status?: string[]`
  (raw provider status names). `scope: string[]` already exists and carries the
  selected board/project ids.
- **`capabilities()`** gains `boards`, `sprints`, `statuses` booleans so the UI
  renders only the controls a tracker supports. Callers guard on these, as they
  already do for `subtasks`/`transitions`.
- **Discovery methods** (capability-gated; `throw` when unsupported, like
  `createSubtask`):
  - `listScopes(): Promise<TicketScope[]>` — the boards/projects the credentials
    can see. `TicketScope = { id, name, kind: 'board'|'project', boardType?: 'scrum'|'kanban', team?: string }`.
  - `listSprints(scopeId): Promise<TicketSprint[]>` — `{ id, name, state: 'active'|'future'|'closed', boardId }` for a Scrum board.
  - `listStatuses(scopeId?): Promise<string[]>` — the statuses available in scope,
    for the status multi-select.

The neutral `Ticket` shape is **unchanged** — no board/sprint fields leak onto it.

## How the pieces fit

| Layer | Change |
|---|---|
| `packages/shared/src/ticket.ts` | `TicketListQuery.sprint`/`.status`; `capabilities()` flags; `listScopes`/`listSprints`/`listStatuses`. |
| `packages/shared/src/settings.ts` | `JIRA_BOARDS`, `JIRA_TEAMS`; `pnpm gen:config`. |
| `apps/api/src/providers/tickets/jira/jira.ts` | Agile-API path when boards are scoped; push `status` into `jql=`; implement the three discovery methods; keep project-JQL fallback. |
| `apps/api/src/index.ts` | Thread `scope`/`sprint`/`status` through `/api/tickets` (drop the `scope: []` hardcode); add routes exposing `listScopes`/`listSprints`/`listStatuses`. |
| `apps/web/src/views/Backlog.tsx`, `api.ts` | Team/board selector → sprint selector (shown only for Scrum boards) → status multi-select, beside the existing bucket/search; persist the selection. |

## Build sequence

Each phase is independently shippable.

**Phase 1 — scope config.** `JIRA_BOARDS`/`JIRA_TEAMS`; Agile-API path in the
provider; thread `scope` through the route. *Result: the backlog loads only the
configured boards. No UI change yet — the largest performance win for the least
code.*

**Phase 2 — contract + discovery.** Extend `TicketListQuery` and
`capabilities()`; add and implement `listScopes`/`listSprints`/`listStatuses`;
expose them over the api.

**Phase 3 — runtime UI.** The team/board/sprint/status controls in the Backlog
view; push status/sprint server-side; drop the client-side over-fetch.

## Invariants

- **Board and sprint are Jira concepts and stay inside the provider.** The neutral
  `Ticket` never carries them; `TicketListQuery` additions are generic.
- **No credential leaves its tier.** New config follows the existing
  `secret://org/<KEY>` pointer pattern; board/sprint discovery runs in the api,
  never the browser or an agent.
- **Provider changes are hot-swappable.** New keys are `env,org`; a config change
  invalidates the provider registry with no redeploy, as today.
- **`pnpm gen:config` after any settings edit.** CI fails on `.env.example` /
  `CONFIGURATION.md` drift.
- **The project-JQL path remains the fallback.** A deployment with no boards
  configured behaves exactly as it does today.

## Open questions

- **Board enumeration cost.** `listScopes()` over a large instance can return many
  boards. Do we cache the board list (and for how long), and/or restrict discovery
  to the configured `JIRA_BOARDS` plus their teams?
- **Cross-project boards.** A board's filter may span projects beyond `PROJ`.
  That is a feature (adopt the team's real scope) but worth confirming it doesn't
  surprise operators who expect PROJ-only issues.
- **Other trackers.** GitHub has no boards (Projects v2 is a possible later map);
  Trello has boards but no sprints. Capabilities gate the UI so this degrades
  cleanly, but the Trello board mapping should be revisited when Phase 2 lands.
