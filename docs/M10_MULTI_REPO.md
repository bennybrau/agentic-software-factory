# M10: One ticket source, many repositories

Status: PLANNED. Milestone https://github.com/RAG-Against-the-Machine/agentic-software-factory/milestone/2, issues #45 (WP1) to #51 (WP7).

## The need

In a large organization, one Jira project (say **PROJ**) can cover code in **many GitLab repositories**
under a group tree several levels deep (for example `acme/platform/web/...`). Each PROJ ticket
must run in the right repo. Today ASF assumes a short hand-typed repo list, and for Jira it
quietly preselects the **first** repo.

Decisions (Jon, 2026-10-12):

1. **The AI suggests the repo** from the ticket, and a person confirms or changes it before
   the run starts. No hand-maintained component→repo rules.
2. **One repo per run.** A ticket that rarely needs two repos is started once per repo (or
   split). There are no multi-repo runs.
3. **One Jira project for now.** Several ticket sources at once (several trackers, or Jira
   plus GitLab issues) is a separate axis, out of scope.
4. **Which repos:** every project under a GitLab group, including all subgroups (for PROJ,
   e.g. `acme/platform/web`), minus an optional exclude list. Explicit `GITLAB_REPOS`
   stay supported for single repos outside the group.

## What already works (no change needed)

- Jira tickets with GitLab merge requests: ticket transitions on MR open and merge.
- Nested paths for repos that are listed explicitly: `encodeURIComponent(path_with_namespace)`
  in every GitLab call (`apps/api/src/providers/scm/gitlab.ts:112`), the clone URL, and the
  bare-clone cache `repos/<a/b/c/d>.git` (`apps/worker/src/git.ts:86`; nested parents are
  created). Branch names use the ticket key and run id, never the repo path.
- One run is bound to one repo end to end: `agent_run.repo_id`, the worktree, the MR, and the
  merge watcher.

## Coupling audit (what blocks the need)

| Where | Today | Problem for PROJ |
|---|---|---|
| `packages/shared/src/settings.ts:142`, `gitlab.ts:173-179` | `GITLAB_REPOS` explicit comma list; `searchRepos` filters it, then one GET per repo | No group discovery, no subgroups, no pagination; N+1 calls each time the dispatch page opens |
| `gitlab.ts:156-169` | Preflight GETs every configured project | Scales with the number of repos; runs on every scheduler tick (`start-readiness.ts:25-37`) |
| `apps/api/src/providers/tickets/jira/jira.ts:258-260` | `suggestedRepo()` returns null | No routing at all for Jira |
| `jira.ts:60-63` | Fields fetched omit `components` | Useful routing signal never reaches ASF |
| `apps/web/src/views/Dispatch.tsx:59,118-125` | Flat `<select>`; default `suggestedRepoId ?? repos[0]`; hint text is GitHub-specific | Silent wrong repo; unusable with hundreds of repos |
| `apps/web/src/views/Backlog.tsx:157`, `apps/api/src/scheduler.ts:31-44` | Queueing a ticket sends no repo | Queued Jira tickets fail with `repo_ambiguous` once there is more than one repo |
| `packages/shared/src/scm.ts:4-11` | `Repo` has no description | Neither the person nor the AI can tell what a repo is for |
| `prompts/roles/planner.md:12` | Planner may stop with NEEDS_HUMAN when the repo looks wrong | The only way out is cancel and start again |
| `db/migrations/001_schema.sql:23-25`, `004_work_queue.sql:29-30` | One live run / queue entry per ticket | Can't start the same ticket in a second repo while the first runs |
| `gitlab.ts:213` | MR lookup by ticket-key substring | `PROJ-12` matches `PROJ-123` |
| `questions.tsx:223,251`, `CONFIGURATION.md` | Setup asks for `group/project` list only | No way to say "this group and everything under it" |

## Design

### Where the AI runs

The api holds no model credentials. On Vertex only the **worker** has the Google login. So
the repo suggestion is a small **worker task**, like the Vertex model check from M9: the api
posts it, a worker answers with a cheap model call, and the page polls. When no worker is
free, the page still works and shows the non-AI ranking.

### Suggesting a repo

1. **Repo catalog** (registry table `repo_profile`): path, description, topics, main
   languages, last activity, and a short README excerpt (first ~1,500 characters). Built from
   the group listing and refreshed daily, or on demand when stale. Metadata only: no code is
   cloned to build it.
2. **Shortlist without AI (api, instant):** score every repo against the ticket's title,
   body, components, labels and epic, plus **history**: the repo chosen for earlier tickets in
   the same epic or component, and for similar past tickets (`ticket_repo_choice`, written at
   each dispatch). Keep the top ~25.
3. **AI ranking (worker):** the shortlist's profiles plus the ticket go to the cheapest
   allowed model. It returns up to 3 repos with a one-line reason and a confidence. Results
   are cached per ticket and content hash.
4. **The person decides:** the dispatch page preselects the top suggestion only when
   confidence is high, otherwise it leaves the choice empty. Start stays disabled until a
   repo is chosen, and the reason is shown. Every choice, including overrides, is recorded
   and improves step 2.

### Discovering repos

`GITLAB_GROUPS` (comma list) lists
`/groups/:path/projects?include_subgroups=true&archived=false&with_shared=false`, paginated,
keeping projects where the token has Developer access or higher. `GITLAB_REPOS` still adds
single repos, and `GITLAB_REPO_EXCLUDE` (glob patterns) removes some. Results are cached
with a TTL and refreshed when settings change. Preflight checks the token and group access
instead of every project.

### Wrong repo after starting

When the planner reports NEEDS_HUMAN because the repo looks wrong, or a person notices, the
run page offers **Move to another repo**: it rebinds `repo_id`, discards the worktree, and
restarts from the planner. The choice is recorded as a correction.

### Rare two-repo tickets

The live-run uniqueness becomes (ticket, repo). The same PROJ ticket can be started once per
repo, giving one MR each. The Jira ticket moves to Done only when **all** of its runs have
merged. A real multi-repo run (N worktrees, linked MRs) is out of scope.

## Work packages, in order

1. **WP1: GitLab group discovery.** `GITLAB_GROUPS`, `GITLAB_REPO_EXCLUDE`, paginated
   listing, Developer+ filter, cache, group-level preflight, description on `Repo`, nested
   path tests, fix the `PROJ-12` / `PROJ-123` match. Behaviour is unchanged when only
   `GITLAB_REPOS` is set.
2. **WP2: Dispatch page for many repos.** Searchable picker grouped by subgroup, with
   descriptions; no silent first-repo default; queued tickets carry a repo or ask for one.
3. **WP3: Repo catalog and choice history.** `repo_profile` (with README excerpt) and
   `ticket_repo_choice`; Jira fetches `components`; the non-AI shortlist.
4. **WP4: AI repo suggestion.** Worker task, cache, top-3 with reasons, confidence-gated
   preselect, works without a worker.
5. **WP5: Move a run to another repo.** Planner NEEDS_HUMAN wrong-repo path and a run-page
   action.
6. **WP6: Same ticket in a second repo.** (ticket, repo) uniqueness, Jira Done when every run
   has merged.
7. **WP7: Setup, docs and live check on a large project.** Setup question "Which GitLab group?",
   CONFIGURATION/INSTALL docs, and a recorded run in `docs/runs/` with 10 real tickets,
   noting how often the top suggestion was right.

WP1 and WP2 alone make such a project usable by hand. WP3 and WP4 add the suggestion. WP5 and WP6 are
independent and can come later.

## Out of scope

Several ticket sources or several GitLab hosts at once (provider instances, namespaced ticket
and repo ids); one run that changes several repos.
