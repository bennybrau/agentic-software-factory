# M12: Several ticket trackers and code hosts at once

Status: PLANNED. Milestone and issues: see the links added when the milestone is created.

## The need

ASF connects to exactly one ticket tracker (`TICKET_PROVIDER`) and one code host
(`SCM_PROVIDER`). A team often has more than one of each: tickets in Jira **and** GitHub
Issues, code on GitLab **and** GitHub. Today they have to pick one, or run two factories.

An agent picks the right CLI for the job from the prompt. ASF should work the same way: connect
every tracker and every code host the team uses, show all their work in one place, and send each
action (comment, status move, clone, merge request, merge) to the system that owns the ticket or
the repository. That includes a Jira ticket that runs in a GitHub repository, and a split whose
parts land on different hosts.

## Decisions (Jon, 2026-11-09)

1. **Different kinds now, the same kind later.** M12 lets you connect one of each kind at the same
   time (for example Jira + GitHub Issues, GitLab + GitHub). Two of the same kind (two GitLab
   hosts, two Jira sites) is out of scope. But every id M12 introduces must already leave room for
   it, so adding it later needs no second migration.
2. **One Planned tasks list.** Tickets from every connected tracker are shown in one list, with a
   source filter and a badge on each row. There is no tab per tracker.
3. **Design doc first**, then a milestone with one issue per work package (as for M10).

This lifts the M10 out-of-scope line "several ticket sources or several GitLab hosts at once" for
different kinds of source and code host. Two hosts of the same kind stays out of scope.

## What already works (no change needed)

- **Each kind has its own credentials.** `JIRA_*`, `GITHUB_*`, `GITLAB_*` and `TRELLO_*` are
  separate settings, so Jira, GitHub and GitLab credentials can already be stored together. What
  stops ASF from using them together is only the single `TICKET_PROVIDER` / `SCM_PROVIDER` choice.
- **Sending each ticket to the source that owns it already exists, for two sources.**
  `ticketsFor(tracker, id)` (`apps/api/src/tickets/route.ts`) sends an `adhoc:` id to the ad-hoc
  store and everything else to the tracker. Every place that comments on, moves or reads a run's
  ticket already goes through it (dispatch, run context, change-request events, the merge watcher,
  Hive, the browser review route). M12 generalises that function. The calls to it stay as they are.
- **Runs record their ticket's source.** `agent_run.ticket_provider` and
  `work_queue.ticket_provider` exist, and the live-run uniqueness is
  `(ticket_provider, ticket_id)`.
- **Hot-swapping one provider without a restart already works.** `TicketProviderRegistry` and
  `ScmProviderRegistry` rebuild when settings change. M12 keeps one of these per connection.
- **The worker clones each run's repository from its own credential.** The run context carries
  `repo` + `cloneCredential`, and read-only copies carry their own (`referenceRepos`, #89). The
  worker never asks which host a repository is on.
- **Hive already tells hosts apart** with `gh/` and `gl/` repository keys.
- **Skills already fetch from GitHub or GitLab** whatever the code host
  (`apps/api/src/skills/fetch.ts`).

## Coupling audit (what blocks the need)

| Where | Today | Problem |
|---|---|---|
| `settings.ts` `TICKET_PROVIDER`, `SCM_PROVIDER` | One enum value each | Can't connect two |
| `providers/{tickets,scm}/index.ts` | One registry each, built from that value | Every route gets "the" provider |
| `routes/dispatch.ts:188`, `routes/queue.ts:30` | `ticketProvider: deps.tickets.kind` | Records the configured kind, not the ticket's own source |
| `agent_run.repo_id`, `work_queue.repo_id`, `recurring_task.repo_id` | A bare path (`acme/web`) | The same path on GitHub and GitLab can't be told apart |
| `apps/worker/src/git.ts` bare-clone cache `repos/<repo.id>.git` | Keyed by path | Two hosts with the same path would share one clone |
| `merge-watcher.ts`, `routes/scm.ts`, `routes/browser.ts`, `hive.ts`, `routes/runs.ts` | `deps.scm.getRepo(run.repoId)` | Must use the run's repository's host |
| `start-readiness.ts` | One preflight, one `searchRepos('')` | Needs every host's repositories, and a down host must not block the others |
| `hive.ts:45` `repoKey` | `gl/` or `gh/` from `SCM_PROVIDER` | Must come from the repository's host |
| `credential-health.ts`, `routes/setup.ts`, `index.ts` startup preflight | One tracker, one code host | Must check each connection |
| `index.ts:105` | `tickets.kind === 'jira'` for the configured projects | Becomes "the Jira connection, if any" |
| Planned tasks (`Backlog.tsx`) and `/api/tickets*` | One tracker's list, scopes, sprints and statuses | Merge every tracker; board, sprint and status filters belong to one tracker |
| Settings → Tickets / Code (`setup-questions.ts`, `questions.tsx`) | Pick one kind | Choose several, each with its own form and health check |
| `GET /health` | `tickets: kind, scm: kind` | Report every connection |

## Design

### Connections

A **connection** is one tracker or code host ASF talks to. It has an id:

- **M12:** the id is the kind: `jira`, `github`, `gitlab`, `trello`, `mock` (and the built-in
  `adhoc`). Only one connection of each kind exists, so the kind is unique.
- **Later (two of the same kind):** `gitlab:work`, `gitlab:oss`. Nothing in M12 may parse the
  kind out of an id except through one helper, `connectionKind(id)`, so this needs no migration.

GitHub can be both a tracker and a code host. These are two connections that share one
`GITHUB_TOKEN`, with the same id `github` in two namespaces (tickets and code).

### Qualified references

Every ticket id and repository id that leaves a provider carries its connection, in the form
ad-hoc tasks already use:

- tickets: `jira:PROJ-12`, `github:acme/web#42`, `adhoc:ce17…` (unchanged)
- repositories: `gitlab:acme/platform/web/shared-ui`, `github:acme/web`

One shared module (`packages/shared/src/refs.ts`) parses and formats these. The connection is the
part before the first `:`, and it only counts if it is a known connection id. Native ids may hold
`/`, `#` and `-`, but never start with `<connection>:`.

**Older ids keep working.** An id without a known prefix belongs to the **default connection** of
its namespace. That is the first connection listed, which after the upgrade is the one connection
the install had before M12. Existing runs, queue entries, recurring tasks, URLs
(`/dispatch/PROJ-12`), saved filters and Hive keys therefore all keep working. The migration
(WP1) rewrites stored ids in the qualified form anyway, so that only URLs and old browser state
rely on the fallback.

**Providers only ever see native ids.** `TicketSet` and `ScmSet` strip the prefix before calling a
provider and add it back to everything the provider returns. So the GitHub provider's
`parseTicketId('acme/web#42')` and every other provider's id handling stay as they are.

`Repo` and `Ticket` gain a `connection` field, so code that needs the host never re-parses ids.

### Several code hosts

- `SCM_PROVIDERS`: a comma list of code connections (`gitlab,github`). `SCM_PROVIDER` stays as a
  fallback when the new key is empty, so existing installs need no settings change.
- `ScmSet` holds one hot-swappable registry per connection. `scmFor(repoRef)` returns the
  provider that owns a repository.
- **Repository list:** all connections' lists combined, each `Repo` with its connection. A host
  that fails its preflight drops out of the list with its reason. The others still work. Start is
  only blocked when **no** host is ready.
- **Every repository action goes through `scmFor`:** clone credentials (run context, reference
  copies), opening and updating change requests, the merge watcher, review comments, Hive and
  recurring tasks.
- **Worker cache:** bare clones move to `repos/<connection>/<path>.git`. Clones that already exist
  belong to the default connection and are moved there once, at startup. It is a cache, so a
  failed move just means one fresh clone.
- **Repository mentions (#88):** a GitHub or GitLab URL in a ticket pins the host as well as the
  path. If the same path exists on two hosts, a bare path is ambiguous and is treated the same way
  as two repositories that share a last segment.

### Several trackers

- `TICKET_PROVIDERS`: a comma list (`jira,github`). `TICKET_PROVIDER` stays as a fallback.
- `TicketSet` holds one registry per connection. `ticketsFor(id)` returns the ad-hoc store, the
  connection named in the id, or the default tracker.
- **Listing:** `/api/tickets` queries each selected tracker in parallel and merges the results.
  Each ticket carries its connection. A tracker that errors is reported in the response, e.g.
  `{ tickets, sources: [{ connection, ok, reason? }] }`. Its tickets are missing, but the list
  still loads. `/api/tickets/find` (look up a ticket number not in the list) asks every tracker,
  or only the one whose key format matches when that can be told (`PROJ-12` vs `acme/web#42`).
- **Board, sprint and status filters belong to one tracker** (only Jira has boards and sprints
  today). `/api/tickets/scopes|sprints|statuses` take a `connection` parameter. The page shows
  those controls when the source filter is a single tracker that supports them, and the existing
  capability flags hide what a tracker can't do.
- **A run's tracker is its ticket's tracker.** Dispatch and the queue record the ticket's
  connection, not `deps.tickets.kind`. Status moves on change-request open and merge, comments and
  the Done transition all go back to that tracker. A Jira ticket worked in a GitHub repository
  moves on Jira when the GitHub pull request merges.
- **Tracker-specific settings stay per kind** (`JIRA_*`, `GITHUB_BUCKET_MAP`, …).
  `TICKET_STATUS_*` (preferred status names) stay global, and each tracker uses the names it has.

### Settings, setup and health

- Settings → **Tickets** and **Code** each let you choose several kinds. Each chosen kind shows
  its existing form and its own health check (preflight). The first one chosen is the default.
- The setup checklist, credential health, the startup preflight logs and `GET /health` report
  each connection: `tickets: [{ connection, ok }]`, `scm: [...]`.
- The registry gets no new tables. The connection lists are ordinary org settings, so
  `PUT /api/settings/TICKET_PROVIDERS` hot-swaps like any other provider key.

### Web

- **Planned tasks:** a source filter (All, or one tracker) and a small badge on each row
  (`Jira`, `GitHub`). The source filter is saved with the other filters (`backlog-filters.ts`). It
  is hidden when only one tracker is connected, so the page looks the same as today.
- **Start page:** repository picker grouped by host, with a host badge. The suggestion reason
  names the host when two are connected.
- **Run view and Activity:** a source badge next to the ticket key and the change-request link.

### Hive

`repoKey` comes from the repository's connection (`gl/…`, `gh/…`), no longer from
`SCM_PROVIDER`. Two hosts of the same kind would need the host in the key too
(`gl/<host>/<path>`). That belongs to the later same-kind work and is noted there.

## Work packages, in order

1. **WP1: Connection ids and qualified references.** `refs.ts` (parse, format, default-connection
   fallback), `connection` on `Repo` and `Ticket`, and `connectionKind()`. A migration adds
   `repo_connection` to `agent_run`, `work_queue` and `recurring_task`, and rewrites
   `ticket_provider` / `repo_id` into the qualified form from the current settings. No behaviour
   change: there is still one connection of each.
2. **WP2: Several code hosts.** `SCM_PROVIDERS` + fallback, `ScmSet`, `scmFor`, the combined
   repository list with per-host readiness, every repository action routed by host, the worker
   cache namespaced by connection, host-aware repository mentions, and Hive keys from the
   repository's host.
3. **WP3: Several trackers.** `TICKET_PROVIDERS` + fallback, `TicketSet`, `ticketsFor`
   generalised, the merged list with per-source errors, per-connection
   scopes/sprints/statuses, and dispatch and queue recording the ticket's connection.
4. **WP4: Settings, setup and health for each connection.** Multi-choice Tickets and Code
   sections, a preflight per connection, credential health, the setup checklist, `/health`, and
   `gen:config`. Existing installs show the single connection they already had.
5. **WP5: Web.** Planned tasks source filter and badges (saved), board/sprint/status controls for
   the chosen tracker, a Start page picker grouped by host, and source badges in the run view and
   Activity.
6. **WP6: Docs and live check.** CONFIGURATION, PROVIDERS, PIPELINE, and an UPGRADING note on the
   new keys and the fallback. A recorded check in `docs/runs/`: Jira + GitHub Issues listed
   together, one Jira ticket delivered to a GitHub repository (with the Jira status moving on
   merge), and one split with parts on GitLab and GitHub.
7. **WP7 (optional): carried over from M10.** GitLab group discovery as a setting on the GitLab
   connection (#12), and moving a run to another repository (#16).

WP2 and WP3 depend only on WP1 and can run in parallel. WP4 and WP5 need both. WP1 alone ships
nothing visible, but it makes the rest a set of reviewable PRs instead of one large change.

## Risks

- **Migrating stored ids** is the one step that can't simply be reverted with an image rollback.
  WP1's migration only adds columns and rewrites values into the qualified form. Older ids still
  parse (default-connection fallback), so an older image keeps working on unprefixed URLs.
  Rewritten ids are qualified, though, so a rollback past WP1 needs the reverse migration, shipped
  with WP1 and tested.
- **The merged list is as slow as the slowest tracker.** Jira across all boards already takes 5–25s.
  Fetching in parallel helps. Each source's state (loading, failed) is shown so a slow tracker
  doesn't look empty.
- **More API calls per run.** Each run already fetches its own repository's provider. Only listing
  pages fan out to every connection.

## Out of scope

Two connections of the same kind (designed for, not built), with namespaced settings and Hive
keys that carry the host. Notification sinks and agent runtimes are not providers in this sense
and stay as they are. There is no cross-host atomic change across repositories: cross-repository
work stays a split, with one change request per repository (see M10).
