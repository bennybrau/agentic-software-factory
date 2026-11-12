# Pipeline stages & human gates

The factory runs a ticket through an ordered checklist of **stages**. For each stage you choose, in **Settings → When should it check with you?** (org tier, setting `PIPELINE_STAGES`; pick a preset, or "Let me choose step by step"):

- **whether ASF performs it** (enabled), and
- **whether a human approves it** (the gate mode).

Changes apply to the next dispatch — no redeploy.

## The stages

| Stage | ASF action | Gate | Produces |
|---|---|---|---|
| Plan | planner drafts the approach | `after_plan` | `plan.md` |
| Implement | implementer writes the code | `after_role:implementer` | the change |
| Test | tester writes/runs tests | `after_role:tester` | `test-report.md` |
| Review | reviewer checks the change | `after_role:reviewer` | `review.md` |
| Create MR/PR | open the change request in the SCM | `before_change_request` | the MR/PR link |
| Merge | merge to the default branch | `before_merge` | merged commit |

Each stage's output is visible on the run (the **Stage output** card); the created MR/PR and its state show in the **Delivery** card.

With Hive on, the reviewer gets the ticket's team-memory briefing too: a change that contradicts a remembered decision is a finding citing its `[hive:<id8>]`, unless the plan's `## Team memory` section overrode that fact with a reason. See [HIVE.md](HIVE.md#what-the-planner-reads).

## What the run page shows

- **The team.** One lane per role with its state and cost. A running task shows who is on it and how long it has been going (Advanced → *Show agent commands* swaps in the tool-call count and last tool).
- **Activity strip.** Under a running task, one line per tool call: its kind (read, edit, search, command, other), its target with paths relative to the worktree, how long it took, and a mark for failed (`✕ failed`), denied (`⊘ denied`) or still-running (`…`) calls. It loads the latest page, then follows the live event stream; after a reconnect it fetches what it missed. *Show earlier* pages back. It follows the tail only while you are scrolled to the bottom.
- **Per-try panel.** Click a stage, then a try: *Asked* (the exact prompt), *Said* (the result), *Changed* (files and patch), *Cost*, and *Activity*, the same strip for a finished try, loaded when you open the tab. A call that never finished reads *did not finish*.
- A runtime that reports no tool events (Copilot), or a finished try with none, shows *This runtime does not report activity.* What each runtime reports is in [RUNTIMES.md](RUNTIMES.md#hard-vs-advisory-per-runtime).

## Gate modes

- **Human approves** (`required`) — the run pauses; a person approves or rejects (a reject sends the work back with a note).
- **Notify, continue** (`notify`) — a notification is sent, the run continues.
- **Automatic** (`auto`) — no gate.

## Merge off — "ready for review"

Turn **Merge** off when ASF should *not* land the change itself. The factory then opens the MR/PR, marks it **ready for review**, and the run ends `succeeded` with delivery outcome **awaiting external merge**. A human reviews and merges it in the SCM. The run view shows a green "Ready for review" callout with the link.

Once a human acts on that MR/PR in the SCM, ASF notices without any further action: the **merge-watcher** (in the api) polls the change request and, when it flips to merged or closed, updates the run and tells you.

- **merged** → the run's change-request state becomes `merged`, the ticket moves to **Done** (`TICKET_STATUS_DONE`), the run view switches to a "✅ Merged" callout, and you get a "merged externally" notification.
- **closed** without merging → the run's state becomes `closed` and you get a notification; the ticket is left where it is (a human deliberately rejected the work).

The watcher is on by default; turn it off with `MERGE_WATCH_ENABLED=false`, and tune the poll interval with `MERGE_WATCH_POLL_MS` (default 60s). It only ever watches runs left `awaiting external merge`, and stops polling a run the moment its change request resolves.

## Request changes after the MR/PR is open

When the MR/PR is **ready for review** (merge off) or the run waits at the **Merge** gate, the Delivery card has a **Request changes** box. Sending it reopens the **same run** — same branch, same MR/PR, same planner conversation:

1. Your feedback becomes a planner chat turn (the task shows *via pr_feedback*). A waiting Merge gate is closed as rejected, and the publish steps are reset so they run again.
2. The planner revises the plan on top of the open MR/PR. Once a run has an MR/PR, the plan gate always waits for you, whatever its mode, so you can talk the revision through in the chat before approving.
3. The implementer, tester and reviewer run again, and the review-loop count starts over.
4. The publish phase pushes onto the existing branch (`change_request:updated`) and does not open a second MR/PR. The run then ends **awaiting external merge** again, or stops at the Merge gate again.

If the worker's checkout is gone, it is rebuilt from the pushed run branch. The request is refused, with the reason, when the MR/PR is already merged or closed, when the run is still working, when it has no MR/PR, or when another run for the same ticket is live. The run's cost ceiling is not reset: the second round spends from the same budget.

### Address review comments

Review threads left on the MR/PR can be sent back to the team instead of retyping them. The **Address review comments** button on the Delivery card (coming in #109 part 4) lists the open threads not already answered by the factory. You pick the ones to send, and they become the request-changes message, quoted as data under a note that the ticket and the approved plan outrank them (`review_threads:sent`). At most 20 threads go in one round.

1. The planner lists each thread id in the revised plan, with what will be done about it or why not.
2. The implementer writes `thread-replies.json` in the run dir: `[{ "thread": "<id>", "reply": "…" }]`. A thread with no entry gets no reply.
3. After the update push (`change_request:updated`), the factory replies under each thread that was sent and has an entry. Each reply is trimmed, capped at 600 characters, and signed `— ASF run <id>` (`review_threads:replied`, which lists the threads that failed and why). Replies go out once per round, on the update push, even when the run then stops at the Merge gate. A reply that fails never fails the push (`review_threads:reply_failed`).

The factory never resolves a thread, approves or merges because of a review comment; resolving stays with the reviewer.

## Splits and hand-offs

A planner can end its plan with an `asf-split` block: 2–8 parts, each a `title`, a `body` and the earlier parts it waits on (`dependsOn`). When you approve the plan, each part becomes its own ad-hoc task in Up next, and the parent run finishes as *split*.

A part may also set `repo` to the path of another connected repository. That part is queued for that repository; a part without `repo` goes into the parent run's repository. A single part is allowed only when it sets `repo`, which hands the work off to another repository. The repository is not checked when you approve: if the queue can't reach it, the entry fails with the reason when it is dispatched. Every planner's prompt lists the connected repositories, with the run's own marked, whatever the ticket came from (a Jira or GitHub ticket, the chat, an ad-hoc task), so it knows which paths it can use. The api sends the list with the run context (`connectedRepos`); with only one repository connected the prompt says so, and if the list can't be fetched the planner is told to keep every part in its own repository. A part of a split can't be split or handed off again.

**A library and the repositories that use it.** For work that changes a shared library and an app that consumes it, the planner is told to split it, library first: one part with `repo` set to the library, then one part per consuming repository that `dependsOn` it, so each consumer is planned and built against the merged library. It reads how the consumer gets the library first. With a pinned, published version (an npm package from a registry, say) the consumer only sees the change once the library **releases** a new version, which can be a few minutes after its PR merges. So the library part says how it releases and is delivered as `feat` or `fix` (which drives the version bump), and the consumer part bumps the dependency, checks that version is published before building on it, and asks with `NEEDS_HUMAN` if it isn't yet, instead of pointing at a branch or a local path. The queue only waits for the library PR to **merge**, not for the release; if a consumer part asks because the version isn't out yet, answer it once it is, and it continues. Each part's planner gets a read-only copy of the other repositories its ticket names (below), so the library's real code is in front of it.

## Which repository a run works in

Every run works in one repository, chosen on the Start page (`/dispatch/<ticket>`). The page preselects one, and you confirm or change it before you press **Start work**:

1. **The tracker's own repository**, when it has one (`suggestedRepo` in [PROVIDERS.md](PROVIDERS.md)): a GitHub issue's repository, or the repository an agent to-do's run was working in.
2. Otherwise, **a connected repository the ticket names** in its title or description: its full path (`acme/platform/web/shared-ui`, also inside a URL or backticks) or its last segment (`shared-ui`). Matching is plain text, not AI: case-insensitive and whole names only (`shared-ui` doesn't match `shared-ui-themes`). A last segment two repositories share, or one shorter than 4 characters, only counts as the full path. A title mention beats a description mention; then the earliest wins. The list of connected repositories a chat task carries at the end of its body is ignored.
3. Otherwise, the first connected repository.

Under the select, the page says why the repository was preselected (for example "The ticket title mentions shared-ui.") and names any other repositories the ticket mentions. A chat message that names a repository starts in it. The preview (`GET /api/tickets/:id/dispatch`) returns this as `suggestedRepoId`, `suggestedRepoReason` and `mentionedRepoIds`.

### Queued tickets

A queued ticket starts unattended, so it never takes a guess. When you start several tickets from **Planned tasks** with more than one repository connected, a panel lists each ticket with the repository it will start in and why, before anything is queued. Change any of them, or use one repository for all. **Start** stays off until every ticket has a repository. With one repository connected there is no panel. The panel asks `POST /api/tickets/repo-preview` (`{ids}` → each ticket's `repoId`, or null with the reason) and queues each ticket with its chosen `repoId`.

A queued entry with no repository (one queued through the API, for example) is placed the same way when it starts: the tracker's own repository, else the one repository the ticket names (exactly one named anywhere, or exactly one in the title), else the only one connected. If several are named and none of them is settled, the entry fails with `repo_ambiguous`, and the reason lists the repositories the ticket mentions.

### Read-only copies of the other repositories a ticket names

A run still works in one repository, but its roles can read the others the ticket names. When the ticket's title or description names other connected repositories (matched the same way as above, never the run's own, at most 3), the api sends them with the run context (`referenceRepos`, each with its own short-lived clone credential). Before each step the worker checks out each one's default branch tip, detached, under `<WORKTREE_ROOT>/refs/<run>/<task>/<name>`, outside the run's worktree and run dir, from the same cached bare clone a run in that repository would use (fetched first). The planner, implementer and reviewer prompts list the copies with where they are and the commit, so a planner in an app can read the library it uses before it plans a split, and the implementer and reviewer can check the real names and types. The copies are removed when the step ends, however it ends, so an edit there never persists; Claude Code's hook also refuses writes there, and OpenCode's permission map denies them. A repository that can't be cloned or fetched in time (3 minutes) is skipped and reported in the `refs:ready` event; the step goes on without it.

## Invariants (the server enforces these; the UI mirrors them)

- **`before_merge` (the Merge gate) can only be relaxed from "Human approves" at the org tier** — here in Settings (the Merge step's choice), never from a per-dispatch request. Landing on the default branch without a person is a project policy, not a per-run choice.
- **Create MR/PR cannot be off while Merge is on** — there is nothing to merge if no MR/PR was opened.
- **Implement cannot be off while Create MR/PR is on** — there is no change to open.

An illegal combination is rejected at dispatch (`400 pipeline_config`) with a reason; the Settings question only offers valid combinations.

## Example: propose-only pipeline

Plan + Implement + Test + Review + Create MR/PR **on**, Merge **off**, each gate on "Human approves":
the factory plans, implements, tests, reviews, opens the MR, and stops with it ready for a human to review and merge in the SCM.

## Role skills — standing per-role guidance

Each role runs from a fixed prompt template that ships in the repo
(`prompts/roles/<role>.md`). On top of that template you can give a role a
**skill**: free-form standing guidance — house conventions, style, recurring
gotchas — that is appended to that role's prompt on **every** dispatch, without
editing the shipped template or re-typing it per ticket.

- **Where to set it:** Settings → **Anything your AI team should always know?**
  (`ROLE_SKILL_PLANNER`, `ROLE_SKILL_IMPLEMENTER`, `ROLE_SKILL_TESTER`,
  `ROLE_SKILL_REVIEWER`). Org-tier, so a change takes effect on the next task with
  no restart and nothing committed to a repo.
- **Per-run additions:** a dispatch may append extra guidance for that one run on
  top of the org blob (org text first, the per-run addition second).
- **Precedence:** a skill is *appended, never a replacement*. It is subordinate to
  the ticket and the approved plan — the prompt tells the role to follow the skill
  "unless the ticket or the approved plan explicitly overrides it", and the
  right-repo / `NEEDS_HUMAN` / `DISPUTE` protocol still comes last. A bad skill
  can't silently derail a run.
- Leave a role's skill blank to append nothing (the prompt is byte-identical to
  the shipped template).
