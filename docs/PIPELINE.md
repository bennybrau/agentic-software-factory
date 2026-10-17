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

If the worker's checkout is gone, it is rebuilt from the pushed run branch. The request is refused, with the reason, when the MR/PR is already merged or closed, when the run is still working, when it has no MR/PR, or when another run for the same ticket is live. The run's cost ceiling is not reset: the second round spends from the same budget. SCM review comments are not imported. Put what you want changed in the box.

## Splits and hand-offs

A planner can end its plan with an `asf-split` block: 2–8 parts, each a `title`, a `body` and the earlier parts it waits on (`dependsOn`). When you approve the plan, each part becomes its own ad-hoc task in Up next, and the parent run finishes as *split*.

A part may also set `repo` to the path of another connected repository. That part is queued for that repository; a part without `repo` goes into the parent run's repository. A single part is allowed only when it sets `repo`, which hands the work off to another repository. The repository is not checked when you approve: if the queue can't reach it, the entry fails with the reason when it is dispatched. A task created from the chat lists the connected repositories at the end of its body, so the planner knows which paths it can use. A part of a split can't be split or handed off again.

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
