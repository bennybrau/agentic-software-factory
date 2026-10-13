# Agentic Software Factory — Architecture & Extraction Plan

*Derived from an audit of an earlier in-house prototype (≈92k lines TS; board / BFF / registry / worker / desktop + Postgres) against the MVP vision on the parent page. Written 2026-09-13.*

## 1. Verdict in one paragraph

The existing repo is a well-engineered **single-agent Jira→GitLab delivery pipeline** for one enterprise. Its run registry, worker isolation, telemetry hooks, gate mechanics and safety rails are worth keeping almost verbatim. Its ticketing layer, SCM layer, agent runtime and UI vocabulary are all hardwired (Jira / GitLab / Claude Code), and it has no concept of a multi-role team. **Recommendation: extract the runtime core into a new repo and build the provider seams and team layer fresh, rather than refactor in place.**

## 2. Vision → what exists today

| Vision requirement | Status | Notes |
|---|---|---|
| Pluggable work tracker (Jira, Trello, Monday, Todoist, GitHub/GitLab Issues) | ❌ Missing | Jira in shared schemas + ~60 UI files. No provider interface. `BoardTicket` core (key, summary, status, bucket, assignee, updatedAt) is reusable. |
| Edit requirements / priority / subtasks / attach URLs & Figma | ❌ Missing | Read-only by design; only writes are comment + transition (`apps/bff/src/clients/jira-write.ts`). |
| Start work on a ticket | ✅ Exists | Dispatch, repo binding, per-ticket DB lock, run registry, git worktree per run. |
| Multi-agent team: planner → implementer → tester → reviewer/QA | ❌ Missing | One Claude Code session per run. `review` is a separate run kind against an open MR, not a teammate. "Subagents" = names listed in the prompt (`apps/worker/src/segment.ts:253`). |
| Human in the loop at configurable gates (plan, MR, merge); otherwise auto | ⚠️ Partial | One fixed gate exists, *before* implementation (plan approval, `hooks/plan-gate.mjs`, 12h wait). MR opens as draft with no further gate; merge is impossible by rule. Gate mechanics (`awaiting_checkpoint`, `checkpoint:*` events, editable plan) are reusable; they need to become a generic, configurable gate primitive (§6). |
| Permission requests surfaced as notifications | ❌ Missing | `--permission-mode acceptEdits` + allow-list; disallowed tools silently never run. `notifyChannel` column exists on profiles/runs but nothing delivers. |
| Web UI: today's work, backlog, queue N tickets (in order / parallel) | ⚠️ Partial | Board, drawer, live run panel, event log, cost panel exist and are good. No ordered queue or batch dispatch; parallelism = `WORKER_MAX_CONCURRENT`. `queue` executor records intent and runs nothing. |
| MR *or* PR depending on SCM | ❌ Missing | GitLab only, including agent-side MCP tool names (`REVIEW_GITLAB_TOOLS` in `segment.ts`). |
| Integration / release later | — | Drop `releases/`, Port.io/TPS (~2k lines) for MVP. |

## 3. Keep / Drop / Rewrite

**Keep (extract nearly as-is)**
- `apps/registry` — run/event/worker state machine, `FOR UPDATE SKIP LOCKED` claim, LISTEN/NOTIFY → SSE, stale sweeper, profiles, migrations `db/init/`. Rename Jira-flavoured columns (`ticket_key` → `ticket_id` + `provider`).
- `apps/worker/src/git.ts` — worktrees, trailered commits, forbidden-branch refusal.
- `apps/worker/hooks/*` — PreToolUse scope guard + telemetry, PostToolUse, plan-gate wait loop (becomes a generic "wait at gate" primitive).
- `packages/shared/src/runs.ts` (run, event, state enums), `event-log.config.ts`, `pricing.config.ts`, `dispatch.ts` (`dispatchability()` refuse-with-reason pattern).
- `apps/board/src/components/ui/*`, `AgentRunPanel`, `EventLogPanel`, `PlanCard`, `CostBreakdownPanel`, `FailurePanel`, `styles/tokens.css`, `hooks/useRunStream.ts`, `api/realtime.ts` (`RealtimeSource`), `app/runtime.tsx` (DI seam).
- Design rules: no credential in the browser; orchestrator is deterministic TS; one segment = one process; refuse rather than guess; no merge to `main` without a human unless a project explicitly opts out; append-only events.

**Drop**
- `apps/bff/src/releases/*`, `clients/portio*.ts`, board `features/release/*` (Port.io / TPS).
- `apps/desktop` (Electron) for MVP.
- Module Federation / EPMS host wiring, yarn-in-pnpm split (make `board` a normal workspace package), stub-login banner.
- `mr/dev-status.ts`, `mr/gitlab-index.ts` (GitLab-specific MR join — replaced by `ScmProvider.listChangeRequests`).

**Rewrite behind interfaces**
- Ticketing (`apps/bff/src/clients/jira*.ts`, `jira/*`, `board/service.ts`, board `Jira*.tsx`).
- SCM (`clients/gitlab.ts`, `repos/*`, worker `gitlab.ts`).
- Agent runtime (`apps/worker/src/segment.ts`, `discovery.ts`, `mcp.ts`, `permissions.ts`).
- Prompts: the `/work`, `/work-pickup`, `/work-handoff` commands were **never in the repo** (discovered from the original developer's `~/.claude/commands`); `.env.example` is also absent from this copy. Role prompts must live in the repo.

## 4. Target architecture

```
┌────────────┐  HTTP/SSE  ┌────────────────┐        ┌──────────────────────┐
│  web UI    │◀──────────▶│   api (BFF)    │───────▶│ TicketProvider       │ jira | github | trello | monday | linear
│ Today/Queue│            │ providers +    │───────▶│ ScmProvider          │ gitlab | github
│ Run/Team   │            │ notifications  │───────▶│ NotificationSink     │ web | slack | telegram | email
└────────────┘            └───────┬────────┘        └──────────────────────┘
                                  │ RPC/SSE
                          ┌───────┴────────┐        ┌──────────────────────┐
                          │   registry     │◀───────│  worker (N)          │
                          │ runs, tasks,   │  claim │  claims a TASK,      │
                          │ team orchestr. │        │  runs one role via   │
                          │ Postgres       │        │  AgentRuntime, exits │
                          └────────────────┘        └──────────┬───────────┘
                                                               │
                                                    ┌──────────┴───────────┐
                                                    │ AgentRuntime         │ claude-code | codex | opencode | hermes
                                                    └──────────────────────┘
```

Same three processes as today (api, registry, worker) + Postgres; the change is four seams and one new layer (team orchestration in the registry).

## 5. Provider interfaces (minimal MVP surface)

### 5.1 `TicketProvider`

```ts
interface Ticket {
  id: string;            // provider-native id, opaque
  key: string;           // human handle: "PROJ-139", "#42", card short-link
  url: string;           // provider's own web URL, copied never constructed
  title: string;
  body: string;          // Markdown. Providers convert (ADF/HTML → md) at the edge
  status: string;        // raw provider status name
  bucket: 'backlog' | 'ready' | 'inflight' | 'review' | 'blocked' | 'done'; // derived by provider config
  priority: number | null;   // normalised 1(high)..5(low)
  assignee: string | null;
  labels: string[];
  links: { title: string; url: string; kind?: 'figma' | 'doc' | 'design' | 'other' }[];
  parentId: string | null;
  children: string[];    // subtask ids
  updatedAt: string;
}

interface TicketProvider {
  readonly kind: 'jira' | 'github' | 'gitlab' | 'trello' | 'monday' | 'linear' | 'todoist' | 'mock';
  preflight(): Promise<{ ok: true; identity: string } | { ok: false; reason: string }>;
  list(q: { scope: string[]; bucket?: string[]; search?: string; cursor?: string; limit: number }): Promise<{ tickets: Ticket[]; next?: string }>;
  get(id: string): Promise<Ticket>;
  update(id: string, patch: Partial<Pick<Ticket, 'title' | 'body' | 'priority' | 'labels'>>): Promise<Ticket>;
  createSubtask(parentId: string, input: { title: string; body?: string }): Promise<Ticket>;
  addLink(id: string, link: Ticket['links'][number]): Promise<void>;
  comment(id: string, markdown: string): Promise<{ commentId: string; url?: string }>;
  listComments(id: string): Promise<{ id: string; author: string; markdown: string; createdAt: string }[]>;
  transitions(id: string): Promise<{ id: string; name: string; toStatus: string }[]>;
  transition(id: string, transitionId: string): Promise<void>;
  capabilities(): { subtasks: boolean; priority: boolean; links: boolean; transitions: boolean };
}
```

Provider config: per-provider status→bucket map (today's `BUCKET_MAP`), scope expression (Jira JQL / GitHub repo list / Trello board id). Rich text is **Markdown at the seam**; `jira/adf.ts` becomes the Jira provider's private codec.

### 5.2 `ScmProvider`

```ts
interface Repo { id: string; path: string; url: string; defaultBranch: string; cloneUrl: string }
interface ChangeRequest {
  id: string; number: number; repoId: string; url: string; title: string;
  state: 'open' | 'merged' | 'closed'; draft: boolean; headBranch: string; baseBranch: string;
  reviewState: 'pending' | 'approved' | 'changes_requested' | null;
  ciState: 'success' | 'failed' | 'running' | 'pending' | null;
  updatedAt: string;
}
interface ScmProvider {
  readonly kind: 'gitlab' | 'github';
  preflight(): Promise<...>;
  searchRepos(q: string): Promise<Repo[]>;
  getRepo(idOrPath: string): Promise<Repo>;
  cloneCredential(repo: Repo): Promise<{ url: string; header?: string }>;   // worker uses this to clone/push
  openChangeRequest(repo: Repo, input: { head: string; base: string; title: string; body: string; draft: true }): Promise<ChangeRequest>;
  listChangeRequests(repo: Repo, q: { ticketKeys?: string[]; since?: string }): Promise<ChangeRequest[]>;
  getChangeRequest(repo: Repo, number: number): Promise<ChangeRequest & { diffRefs: unknown }>;
  listReviewComments(repo: Repo, number: number): Promise<ReviewComment[]>;
  comment(repo: Repo, number: number, body: string, anchor?: { path: string; line: number }): Promise<void>;
  markReady(repo: Repo, number: number): Promise<void>;    // only after the `before_change_request`/`before_merge` gate
  merge(repo: Repo, number: number, opts: { method: 'merge' | 'squash' | 'rebase' }): Promise<void>; // only after `before_merge` gate
}
```

Key change from today: **the worker pushes and opens the change request through `ScmProvider`**, not the agent through a GitLab MCP server. Removes the "operator must configure `mcp__gitlab` in Claude Code" setup step and the tool deny-list gymnastics.

### 5.3 `AgentRuntime`

```ts
interface AgentSpawn {
  role: Role; prompt: string; cwd: string; model?: string; maxCostUsd: number;
  policy: ToolPolicy;   // neutral { fileWrite, shell, network, gitPush:false }; adapters translate (M8 WP B)
  env: Record<string, string>; timeoutMs: number;
}
interface AgentRuntime {
  readonly kind: 'claude-code' | 'codex' | 'opencode' | 'hermes';
  readonly capabilities: RuntimeCapabilities;   // { toolHooks, eventStream, reportsCost, listsModels }
  probe(): Promise<{ ok: boolean; version: string; models: string[] }>;
  run(spawn: AgentSpawn, sink: EventSink, ctl?: RunControl): Promise<{ outcome: 'done' | 'failed' | 'needs_human' | 'timeout'; text: string; usage: Usage | null; costUsd: number | null }>;
}   // cancel = ctl.signal (worker polls the api), not a runtime method (M8 WP A)
interface EventSink { emit(e: { kind: string; payload: unknown }): void }
```

`ClaudeCodeRuntime` = today's `segment.ts` spawn (`-p`, `--output-format json`, `--settings`, hooks) + `parseResult`/`parseUsage`. Hooks post to the worker's local sink instead of directly to the API. Other runtimes implement the same surface via their own headless modes.

### 5.4 `NotificationSink`

```ts
interface Notification { runId; taskId?; kind: 'needs_human' | 'gate' | 'finished' | 'failed'; title; body; actions?: { label; url }[] }
interface NotificationSink { readonly kind: 'web' | 'slack' | 'telegram' | 'email'; send(n: Notification): Promise<void> }
```

`web` (in-app inbox via SSE) is mandatory; others are optional and fan out from the API.

## 6. Team / run model

A **run** is still the unit tied to one ticket and one worktree. New: a run owns an ordered set of **tasks**, one per role, driven by a **team template**.

```sql
CREATE TABLE run_task (
  id            text PRIMARY KEY,
  run_id        text NOT NULL REFERENCES agent_run(id),
  role          text NOT NULL,          -- planner | implementer | tester | reviewer | (custom)
  seq           int  NOT NULL,          -- order within the run
  state         text NOT NULL,          -- pending | running | done | failed | needs_human | skipped
  attempt       int  NOT NULL DEFAULT 1,
  input_ref     text,                   -- artifact this role consumes (e.g. plan.md, test-report.json)
  output_ref    text,                   -- artifact it produces
  worker_id     text, runtime text, model text,
  cost_usd      numeric DEFAULT 0, started_at timestamptz, finished_at timestamptz, reason text
);
```

**Team template** (JSON in `dispatch_profile`, replacing `command/skills/subagents`):

```json
{
  "name": "standard",
  "roles": [
    { "role": "planner",     "runtime": "claude-code", "model": "claude-sonnet-4-6", "writes": false, "output": "plan.md" },
    { "role": "implementer", "runtime": "claude-code", "model": "claude-sonnet-4-6", "writes": true,  "input": "plan.md" },
    { "role": "tester",      "runtime": "claude-code", "model": "claude-haiku",      "writes": true,  "output": "test-report.md" },
    { "role": "reviewer",    "runtime": "claude-code", "model": "claude-sonnet-4-6", "writes": false, "output": "review.md" }
  ],
  "loop": { "onReviewFail": "implementer", "maxIterations": 2 },
  "gates": {
    "after_plan":            { "mode": "required", "timeoutHours": 12 },
    "before_change_request": { "mode": "required" },
    "before_merge":          { "mode": "required" }
  },
  "maxCostUsd": 15
}
```

### Human gates are configurable, with safe defaults

A gate is a named point where the orchestrator may stop and wait for a person. Every gate has a `mode`:

| mode | Behaviour |
|---|---|
| `required` | Run stops in `awaiting_checkpoint`; a human approves / edits / rejects in the UI (or via a notification action). |
| `notify` | Run does not stop; the human is notified with a link and can intervene (cancel, redirect) while it continues. |
| `auto` | Skipped entirely; only an event row is written. |

Gate points in the standard template, in order:

| Gate | Fires when | Default | What approval means |
|---|---|---|---|
| `after_plan` | planner writes `plan.md` | `required` | The plan (editable in the UI, as in the original `PlanCard`) is the contract the implementer builds to. Reject sends it back to the planner with a note. |
| `after_role:<role>` | any named role finishes | `auto` | Optional per-role checkpoint (e.g. look at `test-report.md` before review). |
| `before_change_request` | all roles done, branch pushed | `required` | Open the draft PR/MR. |
| `before_merge` | change request approved in the SCM | `required` | Undraft / merge. |

Resolution order: team template → project override → run-level override chosen in the dispatch modal. **`before_merge` can only be relaxed from `required` by an explicit project-level setting** that is surfaced in the UI (a visible badge on every run under it), never from the dispatch modal alone — committing to `main` without a person is the one default the system should make hard to change by accident. Everything else the operator may relax to `notify` or `auto` per run. `hooks/plan-gate.mjs` wait loop and the `checkpoint:*` events generalise to any gate; timeouts (`gate:abandoned`) apply per gate.

`run_task.state` gains `awaiting_gate`; `agent_run.gates` (JSONB) records the resolved config so a run's audit trail shows exactly which gates were required at the time it ran.

**Orchestrator** = deterministic TS in the registry (`runs/orchestrate.ts`), the same "orchestrator is not an agent" rule as today:

1. `dispatch` → create run + tasks from template → task[0] `pending`.
2. Worker claims the next `pending` task whose predecessors are `done` (`FOR UPDATE SKIP LOCKED`, same query pattern as `claimRun`).
3. Worker resolves the role prompt (repo `prompts/roles/<role>.md` + ticket + prior artifacts from the run dir) and calls `AgentRuntime.run`.
4. On `done`: orchestrator checks for a gate at this point (`after_plan`, `after_role:<role>`) and applies its mode — `required` parks the run in `awaiting_checkpoint` and notifies; `notify` notifies and continues; `auto` continues. Then it advances `seq`. On reviewer/tester `failed` with `loop` configured: re-enqueue the target role (bounded). On `needs_human` from a runtime: task → `needs_human`, run → `awaiting_checkpoint`, `NotificationSink.send`.
5. After the last role: worker commits and pushes via `ScmProvider`; `before_change_request` gate; opens the change request (draft unless the gate is `auto`); `before_merge` gate once the SCM reports approval; on approval the worker calls `ScmProvider.merge` → run `succeeded`. With the defaults, a human clicks through both of the last two gates; with `before_merge: auto` at project level the run merges itself.

Artifacts live in the run directory (`plan.md`, `test-report.md`, `review.md`) and are posted to the ticket as comments via `TicketProvider.comment`, which is how a later task on another machine reconstitutes context — same durability rule as today.

Role prompts ship in the repo under `prompts/roles/*.md` with a small variable set (ticket, repo, branch, prior artifacts). Skills/commands discovery from `~/.claude` becomes optional extra context, not a requirement.

## 7. Queue & "today" model

- `work_queue` table: `(ticket_id, provider, position, mode: 'serial' | 'parallel', added_by, added_at)`.
- API: `POST /queue` (batch of tickets + mode), `PATCH /queue/reorder`, `DELETE /queue/:id`.
- Registry scheduler: dispatches queue head(s) when fleet capacity (`sum(maxConcurrent) − running`) allows; serial mode waits for the previous run to reach the MR gate.
- UI **Today** view: queued → running → waiting on you (gates + needs_human) → done today. Backlog view is the provider-scoped ticket list with drag-to-queue.

## 8. Phased plan

| Phase | Deliverable | Reuses | Rough size |
|---|---|---|---|
| 0 | New repo scaffold: `packages/shared`, `apps/api`, `apps/registry`, `apps/worker`, `apps/web` (Vite, single package manager). Copy registry + worker git/hooks + shared run schemas. `.env.example` restored. | registry, worker core | 1–2 days |
| 1 | `TicketProvider` + Jira (port `clients/jira*.ts`, ADF→md) + GitHub Issues + mock. Backlog UI on the neutral `Ticket`. Ticket edit/subtask/link writes. | board table, drawer | 3–5 days |
| 2 | `AgentRuntime` + `ClaudeCodeRuntime` (port `segment.ts` spawn/parse/hooks). Single-role run end to end against a real ticket, `WORKER_DRY_RUN` first. | segment.ts, hooks | 2–3 days |
| 3 | `ScmProvider` + GitLab + GitHub; worker does push + draft CR; repo binding UI. MR-side gate. | git.ts, repos/, RepoContextDialog | 3–4 days |
| 4 | Team layer: `run_task`, templates, orchestrator, role prompts, review→implementer loop, `needs_human` → web inbox + one external sink. | plan-gate loop, event log UI | 4–6 days |
| 5 | Queue + Today view, parallel/serial scheduling, cost/usage dashboards. | KpiStrip, CostBreakdownPanel | 2–3 days |
| later | Trello / Monday / Linear providers; Codex/OpenCode/Hermes runtimes; release/integration flow. | | |

## 9. Risks & open decisions

- **Claude Code headless behaviour** is the load-bearing assumption of phase 2 (hooks JSON, `--output-format json`, `--settings`). Pin the CLI version; wrap all flag construction in `ClaudeCodeRuntime` only.
- **Role hand-off fidelity**: agents lose context between segments; artifacts + ticket comments are the memory. Keep artifacts terse and structured (front-matter + sections) so the next role can parse them.
- **Cost**: four roles ≈ 3–4× today's single-session cost per ticket. Enforce `maxCostUsd` at the run level and per task; tester/reviewer on cheaper models by default.
- **Where do workers run?** Same open question as in the prototype. Design stays executor-agnostic (`local` now, `remote` = same worker in a container later).
- **Gate relaxation is a policy surface.** `before_merge: auto` is the only setting that lets an agent land code on `main` unattended; it is project-scoped, badge-visible, and logged on every run. Worth an explicit review before it is ever set.
- **Auth**: single-operator MVP; keep `dispatched_by` / `authorized_by` columns so real auth can attach later.
- **Missing originals**: `/work*` command prompts and `.env.example` are not in the copied repo. If recoverable from the original developer they are useful reference for the planner/implementer prompts; not blocking.
