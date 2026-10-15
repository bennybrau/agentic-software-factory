# Core Implementation Plan

> **Goal:** the shortest path from this skeleton to a working loop — pick a ticket, a planner/implementer/tester/reviewer team runs it in an isolated worktree, humans answer the gates they chose, a PR opens — then real trackers plug in behind the interfaces.

**Architecture:** four processes (`api`, `registry`, `worker`, `web`) + Postgres, as in `docs/plan.md` §4. The registry is the only DB client and runs the deterministic orchestrator; the worker executes one role task per process; the api owns every external credential behind `TicketProvider` / `ScmProvider` / `NotificationSink`.

**Tech stack:** TypeScript (Node 22, pnpm, ESM), Fastify 5, Zod, `postgres` (porsager), Vite + React 18 + TanStack Query, `node:test` + `tsx`, Claude Code CLI (headless) as the first `AgentRuntime`.

**Ordering principle — loop first, integrations second.** Mocks already satisfy both provider interfaces, so the risky part (durable multi-role runs under a real coding agent, with gates) is built and proven on mocks before any tracker is wired. GitHub is the first real provider for both tickets and SCM because one token covers both and the whole loop can run against a real repo in this org.

**Working agreement:** one milestone = one or more PRs, each PR = one work package (WP) on its own branch off `main`. Every WP has an executable *done-when*. TDD where the logic is pure (schemas, orchestrator, prompt rendering, claim query); integration-tested where it is not (registry against a real Postgres in CI, runtime against the real `claude` binary in `WORKER_DRY_RUN=1`).

---

## Milestone map

| # | Milestone | Proves | WPs | Est. |
|---|---|---|---|---|
| M1 | Registry core | Runs/tasks/events are durable; one live run per ticket; a task can be claimed exactly once; state fans out over SSE | 1.1–1.5 | 3–4 d |
| M2 | Worker + `ClaudeCodeRuntime` | A real Claude Code process does one role in an isolated worktree, is observed by hooks, cannot escape or push, and its outcome lands in the registry | 2.1–2.5 | 3–4 d |
| M3 | Team orchestration + gates + Run UI | Planner→implementer→tester→reviewer runs end to end on mocks; gates stop/notify/skip as configured; a human approves/edits/rejects in the browser | 3.1–3.6 | 4–5 d |
| M4 | GitHub providers | The same loop against a real GitHub issue and repo: branch pushed, draft PR opened, `before_merge` gate honoured | 4.1–4.4 | 3 d |
| M5 | Jira provider | Same loop on a Jira ticket (ADF↔Markdown, JQL scope, transitions) | 5.1–5.3 | 2–3 d |
| M6 | Queue, Today view, notifications | Batch N tickets serial/parallel; the daily landing page; needs-human inbox + one external sink | 6.1–6.4 | 3 d |
| M8 | Pluggable role executors *(deferred)* | Any headless coding agent (Codex, Hermes, OpenCode, Copilot) and any model provider incl. OSS via OpenAI-compatible endpoints can run a role, selectable per role from the UI, with scope/cancel/no-push enforced by the worker not by Claude hooks. Design: `docs/M8_PLUGGABLE_ROLE_EXECUTORS.md`; GitHub milestone M8, issues #63–#70 | A–H | 8–10 d |
| M9 | Vertex AI at work | ASF as the daily harness on a corporate Mac: Claude Code on Vertex via Google ADC (host-provided, never in the secret sink), Jira + GitLab. `vertex` mode already passes the env through; this closes the gaps — org-editable model catalogue/allowlist (Vertex ids like `claude-haiku-4-5@20251001`), ADC-expiry detection + notification, `docs/VERTEX.md`, proxy/CA in the api fetch layer, Jira DC provider if not Cloud. GitHub milestone M9, issues #72–#77 | 1–6 | 4–6 d |
| M10 | One-command install | Clone → `./scripts/setup.sh` → browser, on any Mac/Linux box: prereq checks, generated `.env` (fixes the shipped `***` password + blank `RUN_EVENT_SECRET` traps), compose up + health wait, `asf` CLI (`doctor/update/backup/restore`), prebuilt GHCR images, host-worker mode with launchd/systemd, `/setup` first-run checklist in the UI, `docs/INSTALL.md` + `curl \| bash`, and a fresh-Ubuntu CI job that runs setup + m3-smoke. GitHub milestone M10, issues #78–#85 | 1–8 | 6–8 d |
| M11 | Ollama models | Any role runs on an Ollama model, local/LAN server or Ollama Cloud, mixed per role with Claude/GPT in one team; $0 runs capped by turns and wall clock. Design [`M11_OLLAMA.md`](M11_OLLAMA.md); GitHub milestone M11, issues #20–#27 | 1–8 | 6–9 d |

Total ≈ 18–22 working days to a usable MVP. M1–M3 are the core; M4 makes it real; M5/M6 make it the product in the vision.

---

## M1 — Registry core

### WP 1.1 Postgres pool + migration runner

**Files:** `apps/registry/src/db/pool.ts`, `apps/registry/src/db/migrate.ts`, `apps/registry/src/db/migrate.test.ts`, modify `apps/registry/src/index.ts`.

- `pool.ts`: one `postgres(DATABASE_URL)` instance; `ping()` returns `true` on `select 1`.
- `migrate.ts`: reads `db/migrations/*.sql` sorted by filename, applies each inside a transaction, records it in `schema_migration(name text primary key, applied_at)`. Idempotent. Refuses to start on a checksum mismatch of an already-applied file (additive-only rule, enforced).
- `/health` returns `{ ok, db: true|false, migrations: n }`. **Boot fails (exit 1) if the DB is unreachable** — a registry listening with no database accepts a dispatch and loses it.

**Tests:** `migrate.test.ts` against `DATABASE_URL` (CI service container, see WP 1.5): applies twice → second run applies 0; tampering a file → throws naming the file.

**Done when:** `pnpm db:up && pnpm dev:registry` logs `migrations applied: 1` and `curl :8788/health` returns `db: true`.

### WP 1.2 Run store: create, read, events

**Files:** `apps/registry/src/runs/store.ts`, `apps/registry/src/runs/store.test.ts`, `packages/shared/src/registry-rpc.ts` (new; the typed RPC union), modify `packages/shared/src/index.ts`.

- `createRun(input: { ticket: Pick<Ticket,'id'|'key'>, provider, team: TeamTemplate, gates, repoId, dispatchedBy, maxCostUsd })` → inserts `agent_run` (state `queued`) **and** one `run_task` per template role (`seq` = index, state `pending` for seq 0, `pending` for the rest but only claimable when predecessors are `done` — see 1.3). Throws `RunConflictError` when the partial unique index fires; the API turns that into a 409 carrying the existing run id.
- `getRun(id)`, `listRuns({ ticketId?, state?, limit })`, `getTasks(runId)`.
- `appendEvent(runId, kind, payload, { taskId?, source })` → next `seq` per run (`SELECT coalesce(max(seq),0)+1 … FOR UPDATE` on the run row), inserts, updates `agent_run.last_event_at`, then `NOTIFY run_events, '<runId>:<seq>'`.
- RPC contract in `registry-rpc.ts`: a discriminated union `{ op: 'createRun', input } | { op: 'getRun', id } | { op: 'appendEvent', … } | …` with Zod schemas for input and result; one route `POST /internal/rpc` dispatches on `op`. Adding a call = adding a union member; a missing case is a type error.

**Tests (pure + DB):** create → tasks exist with the right seq/state; second create for the same live ticket → `RunConflictError`; create after the first is `succeeded` → ok; `appendEvent` seq is monotonic under 20 concurrent appends (`Promise.all`).

### WP 1.3 Claim, heartbeat, worker registry

**Files:** `apps/registry/src/runs/claim.ts`, `apps/registry/src/runs/claim.test.ts`, `apps/registry/src/routes/workers.ts`.

- `POST /workers/register { id, host, runtimes[], maxConcurrent, inFlightTaskIds[] }` — upserts `worker`; every task assigned to this worker id that is **not** in `inFlightTaskIds` is marked `failed` with reason `worker restarted` and its run goes `stale` (a registration is a truthful statement of what this process holds; anything else was held by a process that no longer exists).
- `POST /workers/:id/heartbeat`, `POST /workers/:id/deregister` (marks its running tasks `failed`/run `stale` immediately, reason naming the worker).
- `POST /workers/:id/claim { runtimes[] }` — one transaction:

  ```sql
  SELECT t.* FROM run_task t
    JOIN agent_run r ON r.id = t.run_id
   WHERE t.state = 'pending'
     AND r.state IN ('queued','running')
     AND r.cancel_requested_at IS NULL
     AND t.runtime = ANY($1::text[])
     AND NOT EXISTS (SELECT 1 FROM run_task p WHERE p.run_id = t.run_id AND p.seq < t.seq AND p.state <> 'done' AND p.state <> 'skipped')
   ORDER BY r.created_at, t.seq
   FOR UPDATE OF t SKIP LOCKED
   LIMIT 1;
  ```

  then `UPDATE run_task SET state='running', worker_id=$2, started_at=now()`, `UPDATE agent_run SET state='running', started_at=coalesce(started_at,now())`, `appendEvent('task:started')`. Returns `{ run, task, team }` or `null`.
- `POST /tasks/:id/finish { outcome: 'done'|'failed'|'needs_human', outputRef?, costUsd, usage, reason? }` — records, appends `task:finished`, then calls `orchestrate.advance(runId)` (a no-op stub until WP 3.1; in M1 it just marks the run `succeeded` when every task is `done`).

**Tests:** two concurrent claims on one pending task → exactly one wins; a task whose predecessor is `running` is not claimable; register with an empty in-flight list stales a run the worker previously held.

### WP 1.4 Sweeper + cancellation

**Files:** `apps/registry/src/runs/sweeper.ts`, `apps/registry/src/runs/sweeper.test.ts`.

- Every `RECONCILE_INTERVAL_MS` (60 s): runs in `running` with `last_event_at` older than `STALE_AFTER_MIN` (15) → `stale` + `run:stale` event carrying last event kind/age and whether the worker is alive. Workers with no heartbeat for `WORKER_TTL_SECONDS` (90) → deleted, their running tasks failed. `run_events` older than 90 days pruned.
- `POST /runs/:id/cancel` sets `cancel_requested_at` and appends `run:cancelled { immediate:false }`; the run becomes `cancelled` only when its running task finishes (cooperative — the worker's hook reads the flag).
- `stale` runs are re-claimable: `POST /runs/:id/resume` resets the running task to `pending` (attempt+1) and the run to `queued`.

**Tests:** fake clock; stale after 15 min of silence and not before; resume makes the task claimable again.

### WP 1.5 SSE fan-out + CI with Postgres

**Files:** `apps/registry/src/db/notify.ts`, `apps/registry/src/routes/stream.ts`, modify `.github/workflows/ci.yml`.

- One `LISTEN run_events` connection; each notification is looked up and re-broadcast as `event: run:event\ndata: {runId, seq, kind, payload}` to every `GET /internal/events/runs` subscriber. Clients send `Last-Event-ID`; on reconnect the route replays events with `seq > id` for the runs they name.
- CI: add a `postgres:16` service container, set `DATABASE_URL`, run `pnpm test`. Every DB test above runs in CI from this WP on.

**Done when (M1):** a script `scripts/m1-smoke.mjs` creates a run over RPC, claims its first task with a fake worker, finishes it, and the SSE stream shows `run:queued → task:started → task:finished → run:succeeded`. CI green with Postgres.

---

## M2 — Worker + `ClaudeCodeRuntime`

### WP 2.1 Worker loop

**Files:** `apps/worker/src/index.ts` (replace stub), `apps/worker/src/api.ts` (client for registry + api with `X-Run-Secret`), `apps/worker/src/config.ts`.

- `main()`: probe runtime → register (`inFlightTaskIds: []`) → heartbeat every 30 s → poll `claim` every 3 s while `running < WORKER_MAX_CONCURRENT` → `executeTask(claim)` → repeat. SIGINT/SIGTERM: deregister first, then kill children, then exit.
- `executeTask` (this WP): fetch `GET /api/runs/:id/context` from the **api** (ticket snapshot as Markdown, repo + clone credential, team template) — the registry holds none of those; write `<RUN_DATA_ROOT>/<runId>/context.json`; call runtime; `finish` with the outcome. On any thrown error → `finish({ outcome:'failed', reason })`, never a silent exit.

### WP 2.2 Worktree isolation

**Files:** `apps/worker/src/worktree.ts`, `apps/worker/src/worktree.test.ts` (uses a temp bare repo created in the test).

- `ensureWorkspace(run, repo, cred)`: bare clone cached under `WORKTREE_ROOT/repos/<repoId>.git` (fetch if present), then `git worktree add WORKTREE_ROOT/runs/<runId> -b agent/<ticketKey>-<runId8>` from `defaultBranch`. Refuses if the branch name `isForbiddenBranch`. Reuses an existing worktree on resume (`resumed: true`).
- `commitPending(worktree, message, trailers)`: `git add -A && git commit` with trailers `Ticket:`, `Run-Id:`, `Role:`, `Co-Authored-By: Agentic Software Factory <factory@noreply>`; no-op when clean.
- `push(worktree, cred)`: **only** callable by the worker after M3 gates; refuses forbidden branches again; the credential is injected via `GIT_ASKPASS`/header and never written into the worktree's config.
- Worktrees are never deleted automatically; `scripts/gc-worktrees.mjs` removes those whose run is terminal and older than 7 days.

**Tests:** worktree created on the right branch; `main` refused; second call on same run reuses; commit trailers present in `git log -1 --format=%B`.

### WP 2.3 `ClaudeCodeRuntime.run` + hooks

**Files:** `apps/worker/src/runtimes/claude-code.ts` (fill in), `apps/worker/src/runtimes/claude-code.test.ts`, `apps/worker/hooks/lib.mjs`, `apps/worker/hooks/pre-tool-use.mjs`, `apps/worker/hooks/post-tool-use.mjs`, `apps/worker/hooks/stop.mjs`.

- Per task, write `<runDir>/settings-<taskId>.json`:

  ```json
  { "hooks": {
      "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <abs>/hooks/pre-tool-use.mjs", "timeout": 10 }] }],
      "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <abs>/hooks/post-tool-use.mjs", "timeout": 10 }] }],
      "Stop":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <abs>/hooks/stop.mjs", "timeout": 10 }] }] } }
  ```

  Spawn: `claude -p <prompt> --output-format json --settings <file> --permission-mode acceptEdits --allowedTools <list> [--disallowedTools <list>] [--model <m>]`, `cwd` = worktree, env = process env **minus** every `*_TOKEN` / `*_SECRET` plus `ASF_RUN_ID, ASF_TASK_ID, ASF_ROLE, ASF_API_URL, ASF_RUN_SECRET, ASF_RUN_DIR, ASF_SCOPE_ROOT, ASF_WRITES (0|1)`. Stdout streamed to `<runDir>/<role>.log`, redacted. SIGTERM at `timeoutMs`, SIGKILL 10 s later.
- Hooks (dependency-free ESM, exit 0 with nothing set so they are inert elsewhere):
  - `pre-tool-use.mjs`: (1) **scope** — any `Write/Edit/MultiEdit/NotebookEdit` path outside `ASF_SCOPE_ROOT` → block (`{"decision":"block","reason":…}`), and *any* write when `ASF_WRITES=0`; `Bash` commands matching `git push|git remote|curl .*token` → block; (2) **telemetry** — `POST $ASF_API_URL/api/runs/:id/events {kind:'tool:pre', taskId, payload:{tool, summary}}`; (3) **cancel** — the ack carries `cancelRequested`; if true → block with "cancelled by operator". Steps 2–3 fail open on network error.
  - `post-tool-use.mjs`: `tool:post` with `{tool, ok, ms}`.
  - `stop.mjs`: `agent:stopped`.
- `parseResult(stdout)`: last JSON object with `type:'result'` → `{ text: result, costUsd: total_cost_usd, usage }`; a `result` text that starts with `NEEDS_HUMAN:` → outcome `needs_human` with the rest as reason (the prompts in `prompts/roles` are told to use that exact form). Non-zero exit or no result object → `failed`.

**Tests:** `parseResult` fixtures (success, needs_human, malformed); hook scope logic tested by invoking the script with a fake stdin JSON and env, asserting the decision (no network: `ASF_API_URL` unset).

**Done when:** `AGENT_RUNTIME=claude-code WORKER_DRY_RUN=1 pnpm dev:worker` against M1's smoke run executes a `planner` task on the mock repo, `plan.md` appears in the run dir, and the event log shows `tool:pre/post` rows from the hooks.

### WP 2.4 Prompt rendering

**Files:** `apps/worker/src/prompt.ts`, `apps/worker/src/prompt.test.ts`, `prompts/roles/*.md` (adjust wording as needed).

- `renderPrompt(role, ctx)` = the role file with `{{ticket.key}}`, `{{ticket.title}}`, `{{ticket.body}}`, `{{ticket.links}}`, `{{cwd}}`, `{{branch}}`, `{{artifacts}}`, `{{prior.<artifact>}}` substituted, plus a fixed trailer: the run id, the "check this is the right repository first" paragraph, and the `NEEDS_HUMAN:` protocol. Unknown variables throw (a silent blank is how a prompt becomes wrong).
- Prior artifacts are read from the run dir (`plan.md`, `test-report.md`, `review.md`) — the memory between roles.

**Tests:** every role file renders with a full context and contains no `{{`; a missing variable throws naming it.

### WP 2.5 Cost + usage

**Files:** `packages/shared/src/pricing.ts`, `packages/shared/src/pricing.test.ts`, registry `finish` handler.

- Per-task `costUsd` from the runtime's own figure when present, else from `usage × pricing[model]`. Run total = Σ tasks. `finish` refuses to advance and marks the run `halted` with reason `cost ceiling` when `run.costUsd ≥ run.maxCostUsd`.

---

## M3 — Team orchestration, gates, Run UI

### WP 3.1 Orchestrator `advance()`

**Files:** `apps/registry/src/runs/orchestrate.ts`, `apps/registry/src/runs/orchestrate.test.ts`, `apps/registry/src/runs/gates.ts`.

Deterministic, idempotent, called after every `finish` and every gate resolution:

```ts
export async function advance(runId: string): Promise<void> {
  const { run, tasks, team } = await load(runId);
  if (isTerminal(run.state) || run.cancelRequestedAt) return settle(run);
  const last = tasks.filter(t => t.state === 'done').at(-1);
  const next = tasks.find(t => t.state === 'pending');

  if (last && !last.gateChecked) {                       // gate after the task that just finished
    const gate = gateAfter(last.role, team, run.gates);  // after_plan | after_role:<role> | null
    if (gate?.mode === 'required') return park(run, last, gate);
    if (gate?.mode === 'notify')   await notify(run, last, gate);
    await markGateChecked(last);
  }
  const failedReview = tasks.find(t => t.role === 'reviewer' && t.state === 'done' && verdictOf(t) === 'REQUEST_CHANGES');
  if (failedReview && team.loop && iterations(run) < team.loop.maxIterations) return requeueFrom(run, team.loop.onReviewFail);
  if (next) return;                                      // a worker will claim it
  if (tasks.every(t => t.state === 'done' || t.state === 'skipped')) return publish(run); // WP 3.3
}
```

`park` = task `awaiting_gate`, run `awaiting_checkpoint`, `gate:reached` event, `NotificationSink.send({kind:'gate'})`. `requeueFrom(role)` clones the tasks from that role onward as new rows with `attempt+1` and marks the old ones `skipped`.

**Tests (pure, DB-backed fixtures):** required gate parks; notify gate continues; auto gate is invisible; REQUEST_CHANGES loops exactly `maxIterations` times then continues to publish; a cancel mid-run settles as `cancelled`.

### WP 3.2 Gate resolution API + plan editing

**Files:** `apps/registry/src/routes/gates.ts`, `apps/api/src/routes/runs.ts`.

- `POST /runs/:id/gates/:gate { decision: 'approve'|'reject', note?, editedArtifact? }` → `gate:resolved` event with actor; approve → `advance()`; reject → the gate's producing role is re-queued with the note appended to its prompt (`{{prior.rejection}}`); an edited `plan.md` is written to the run dir and `plan:edited` recorded so the implementer builds from the human's version.
- Gate timeout: sweeper marks `gate:abandoned` after `timeoutHours` and halts the run.
- `agent_run.gates` is written at dispatch from `resolveGates(team, projectOverride, requestOverride)` in `packages/shared/src/team.ts`: **`before_merge` can only be relaxed by `projectOverride`**, never by the request; a request trying to is a 400 naming the rule. Unit-test that rule explicitly.

### WP 3.3 Publish: push + draft change request + `before_merge`

**Files:** `apps/worker/src/publish.ts`, `apps/api/src/routes/scm.ts`, registry `orchestrate.ts` (`publish`).

- `publish(run)` = one more claimable task with role `publisher` (runtime `none`, handled by the worker without an agent): commit pending, `before_change_request` gate (required → park before push), push, `POST /api/runs/:id/change-request` → api calls `ScmProvider.openChangeRequest({ draft: true })` with a body rendered from `plan.md` + `test-report.md` + `review.md` + the ticket link → `change_request:opened` → run `awaiting_checkpoint` at `before_merge` (or `succeeded` if that gate is `auto`/`notify` **and** the project opted out). Approve at `before_merge` → api `markReady` then `merge` → `change_request:merged` → `succeeded`. Ticket gets a comment with the CR link at open and at merge.

### WP 3.4 Dispatch route + api run proxy

**Files:** `apps/api/src/routes/dispatch.ts`, `apps/api/src/registry/client.ts`, `apps/api/src/routes/events.ts`.

- `GET /api/tickets/:id/dispatch` → preview `{ team, gates, repo, whyNot[] }`; `POST` → validates (repo bound, no live run, worker with the runtimes the template names is alive — each a 409 with a sentence), snapshots the ticket as Markdown into the run's context, `createRun`, comments on the ticket ("Run <id> started; team <name>; gates …").
- `GET /api/events` — SSE to the browser: re-broadcast of the registry stream plus `board:changed` nudges. `GET /api/runs/:id?events=1`.

### WP 3.5 Web: Run view

**Files:** `apps/web/src/views/RunView.tsx`, `apps/web/src/components/TeamTimeline.tsx`, `GateCard.tsx`, `EventLog.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/hooks/useRunStream.ts`.

- Team timeline: one lane per role with state/attempt/cost; the active gate as a card (artifact rendered as Markdown, editable for `plan.md`, Approve / Reject-with-note); event log with filter chips (`tool`, `gate`, `git`, `agent`); cost meter vs ceiling; cancel button that shows "cancellation requested" until the run actually settles.
- All run state arrives over SSE; the view never polls.

### WP 3.6 Web: Backlog + dispatch modal

**Files:** `apps/web/src/views/Backlog.tsx`, `apps/web/src/components/DispatchModal.tsx`, `RepoPicker.tsx`.

- Backlog table over `/api/tickets` with bucket chips and search; drawer with the ticket body (Markdown), links, edit title/priority, add subtask, add link (`TicketProvider` writes).
- Dispatch modal: repo (searchable, remembered per ticket/project in the registry `repo_binding` table — migration `002_repo_binding.sql`), team template, per-gate mode selectors (with `before_merge` shown locked unless the project override exists), cost ceiling, optional free-text instructions. Disabled state always carries the `whyNot` sentence.

**Done when (M3):** with mock providers and the real `claude` binary in dry-run, a 4-role run completes in the browser end to end: plan gate approved (after editing the plan), review loop triggers once on a seeded REQUEST_CHANGES fixture, `before_change_request` approved, mock PR "opened", `before_merge` approved, run `succeeded`. Recorded as `scripts/m3-demo.md`.

---

## M4 — GitHub providers (first real integration)

### WP 4.1 `GithubTicketProvider`
`apps/api/src/providers/tickets/github.ts` + tests with recorded fixtures. Issues across `GITHUB_REPOS`; `key` = `owner/repo#n`; labels→bucket via `GITHUB_BUCKET_MAP` (default: `status:*` labels, else open→`backlog`, closed→`done`); priority from `priority:*` labels; subtasks via task-list checkboxes + sub-issues API where available; links appended to the body under a `## Links` heading; transitions = open/close + label moves.

### WP 4.2 `GithubScmProvider`
`apps/api/src/providers/scm/github.ts`. Repos, clone credential (`x-access-token:<token>` URL, never logged), draft PRs, review comments, `markReady` (`graphql markPullRequestReadyForReview`), `merge` (squash default). `preflight` checks the token's scopes.

### WP 4.3 Repo binding UX
Suggest the repo when the ticket provider *is* the repo (GitHub issue → same repo) so the common case is one click.

### WP 4.4 Real E2E
Run the M3 demo against a scratch issue in a scratch repo under `RAG-Against-the-Machine`, `WORKER_DRY_RUN=0`. Record cost, wall time, and the PR link in `docs/runs/`. **This is the acceptance test for the MVP core.**

---

## M5 — Jira provider

- **5.1** `JiraTicketProvider` — port the REST client from the original (`/rest/api/3/search/jql` paging, `/issue/{key}`, comments, transitions); `JIRA_JQL_TEMPLATE` scope; `BUCKET_MAP`/`BUCKET_MAP_<PROJECT>`; preflight via `/myself` (the search endpoint returns 200 + empty on a dead token — documented trap).
- **5.2** ADF ↔ Markdown codec, ported from `jira/adf.ts` into `providers/tickets/jira/adf.ts`, with the original's fixtures as tests. Attachments render as links.
- **5.3** Same E2E as 4.4 on a Jira ticket with GitHub SCM.

---

## M6 — Queue, Today view, notifications

- **6.1** `work_queue` API (`POST /api/queue` batch + mode, reorder, remove) and registry scheduler: dispatch queue heads while `running < Σ maxConcurrent`; `serial` waits for the previous run to reach its first gate or finish.
- **6.2** Today view: *Waiting on you* (gates + needs_human, newest first) · *Running* · *Queued* · *Done today*. This is the landing page.
- **6.3** `NotificationSink`s: `web` (inbox backed by an `notification` table + SSE) mandatory; `telegram` or `slack` as the first external sink, with approve/reject action links that deep-link to the gate.
- **6.4** Needs-human inbox: every `needs_human` task shows the agent's question, a reply box that re-queues the task with `{{prior.humanReply}}`, and a "skip role" option.

---

## Hosting (addendum)

`docs/HOSTING.md` specifies running the system entirely on GCP (Cloud Run + Cloud SQL, IAP, Vertex-backed Claude Code; the api serves the web bundle) and lists the small code changes it needs first — **WP H.0–H.6**: honor `PORT`/`0.0.0.0`, a worker `/health` listener, api serves the web bundle, push after every writing role (durable progress on ephemeral disks), record the IAP identity, Dockerfiles, deploy workflow. It also compares monthly cost across GCP, AWS and self-hosting (HOSTING §9): token spend dominates (~$1.5–3.5k/mo at 20 runs/day), own hardware is ~$15/mo, GCP ~$285/mo with a VM worker, AWS equivalent. **WP H.8** (a self-host Docker Compose + Tailscale recipe) is the cheapest path to daily use and should ship first; schedule H.0–H.6 after M4 when a team needs managed uptime.

## Cross-cutting

- **Secrets:** api holds tracker/SCM tokens; registry holds `DATABASE_URL` + `RUN_EVENT_SECRET`; worker holds `RUN_EVENT_SECRET` and receives a *per-run* clone credential from the api. Agents receive none. CI greps `apps/worker/src/runtimes` for `TOKEN` and fails on a match.
- **Observability:** every process logs JSON via Fastify/pino; run dir keeps `context.json`, `<role>.prompt.md`, `<role>.log`, artifacts. `scripts/run-dump.mjs <runId>` prints the whole story of a run.
- **Tests in CI:** shared (pure), registry (Postgres service), worker (temp git repos + hook scripts; runtime tests skipped when `claude` is absent), api (mock providers), web (vitest + RTL from WP 3.5).
- **Docs to keep current:** `README.md` quickstart, `.env.example` (every key, every default), `docs/plan.md` when a decision changes.

## Open decisions (decide before the WP that needs them)

| Decision | Needed by | Default if undecided |
|---|---|---|
| Reviewer verdict format (`APPROVE` / `REQUEST_CHANGES` first line of `review.md`) | 3.1 | as stated |
| Where workers run (laptop vs container) | 4.4 | laptop; the worker is already a leaf process |
| Merge method default (squash / merge / rebase) | 3.3 | squash |
| First external notification sink (Telegram vs Slack) | 6.3 | Telegram (the maintainer's daily channel) |
| Auth for the web UI (single operator now) | M6+ | none; `dispatched_by` from a name box, badge says unverified |
