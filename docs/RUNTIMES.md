# Agent runtimes

A **runtime** is the headless coding agent that runs one role on the worker (Claude
Code, Codex, OpenCode, Copilot CLI). A **provider** is who hosts the model (Anthropic,
OpenAI, an OpenAI-compatible endpoint, GitHub). One worker can offer several runtimes
(`AGENT_RUNTIMES`), and each role in a team says which one runs it.

| runtime | CLI | providers | installed in the worker image |
| --- | --- | --- | --- |
| `claude-code` | `claude -p … --output-format json` | anthropic, ollama ([`OLLAMA.md`](OLLAMA.md)) | yes |
| `codex` | `codex exec --json` | openai, openai-compatible | yes |
| `opencode` | `opencode run --format json` | anthropic, openai, openai-compatible | no; install it and set `OPENCODE_BIN` |
| `copilot` | `copilot -p … --silent` | github | no; install it and set `COPILOT_BIN` |

## The container rule

An agent may run only where something blocks out-of-scope writes **before they happen**.
There are three ways to get that:

- its own hooks (Claude Code: the PreToolUse hook refuses a write outside the worktree
  or run dir),
- its own OS sandbox (Codex with `CODEX_SANDBOX=workspace-write`), or
- the worker container.

Each adapter says which of these it has in `capabilities.confinesWrites`. A worker that
is not a container (`/.dockerenv` absent and `ASF_IN_CONTAINER` not `1`) does not offer
a runtime that has `confinesWrites: false`. The Workers page lists that runtime with the
reason **"needs the containerised worker"**. So:

- OpenCode and Copilot run only on a containerised worker.
- Codex on a bare host runs only while its sandbox is on. A host with `CODEX_SANDBOX=off`
  no longer offers Codex.
- Claude Code runs anywhere.

After-the-fact checks cannot undo a write outside the worktree (a file in `~`, a
changed dotfile). They can only undo edits inside the worktree. That is why the rule is
strict.

## The guard contract

The worker enforces these checks around **every** runtime, whether or not the agent
cooperates (`apps/worker/src/guard.ts`, `segment.ts`):

- **No push.** The worktree's `origin` has no credential; the worker pushes at publish.
- **Read-only roles stay read-only.** After a read-only role finishes, `auditWorktree`
  reverts any change to tracked files and fails the task (`scope:violation`).
- **Cancel.** `watchCancel` polls the api and aborts the `RunControl` signal. The adapter
  must kill the agent's whole process group (`killTree`) and resolve `failed`.
- **Liveness.** A runtime with neither tool hooks nor an event stream gets a
  `segment:heartbeat` every minute, so the sweeper does not mark a busy run stale.
- **Cost.** The registry enforces the run budget on `finish`. A runtime that reports
  no dollars is priced from its token usage and the catalogue rate. A runtime that
  reports no usage records $0, and its run counts as **unpriced** (shown on the Workers
  page next to "Spent this month").
- **Credentials.** The run's auth is applied by `auth/*` (`applyAuth`), which strips
  every credential the worker env could leak for that provider. Code under
  `runtimes/` never names a credential variable; CI greps for this.

## Hard vs advisory, per runtime

"Hard" means the runtime blocks the action before it happens. "Advisory" means it asks
the agent not to, and the guard layer or the container catches the result.

| invariant | claude-code | codex (sandbox on) | codex (sandbox off) | opencode | copilot |
| --- | --- | --- | --- | --- | --- |
| no write outside worktree + run dir | hard (hook) | hard (OS sandbox) | container | container | container |
| read-only role leaves worktree untouched | hard (hook) + audit | audit | audit | permission map (advisory) + audit | audit |
| no `git push` | hard (hook) + no credential | no credential | no credential | permission map + no credential | `--deny-tool` + no credential |
| cancel | signal | signal | signal | signal | signal |
| liveness | hooks | JSONL stream | JSONL stream | JSON stream | heartbeat |
| cost | reported | priced from usage | priced from usage | priced from usage | unpriced |
| where it may run | anywhere | anywhere | container only | container only | container only |

OpenCode's plugin hooks (`tool.execute.before`) may not fire under `opencode run`
(anomalyco/opencode#41422), so ASF treats it as hookless. Its generated permission map
uses only `allow`/`deny`, never `ask`, because nobody can answer a prompt in a headless
run.

## Adding a runtime

1. **Adapter.** Add `apps/worker/src/runtimes/<kind>.ts` implementing `AgentRuntime`
   (`packages/shared/src/runtime.ts`):
   - `capabilities`: set each field honestly, especially `confinesWrites`;
   - `probe()`: `--version`, so a worker without the CLI doesn't offer it;
   - `preflight(auth)`: one trivial prompt through the real binary with this auth;
   - `run()`: translate `spawn.policy` into the CLI's own flags, spawn `detached: true`,
     honour the timeout and `ctl.signal` with `killTree`, map the output to an
     `AgentOutcome` with `outcomeFromText` (the NEEDS_HUMAN / DISPUTE protocol), and
     emit `tool:post` / `tool:denied` events if the CLI streams them.
   Keep argv building and output parsing as exported pure functions, and golden-test
   them against fixture output.
2. **Factory.** Add a case in `runtimes/index.ts`. Nothing else imports the adapter.
3. **Auth.** Add the runtime to `RUNTIME_PROVIDER` (and to `RUNTIME_PROVIDERS` if it
   can use more than one provider) in `auth/index.ts`. If it needs a provider this repo
   doesn't have yet, add a translator beside `auth/anthropic.ts`. Anything that names a
   credential variable goes under `auth/`, never under `runtimes/`.
4. **Catalogue.** Tag the models it can drive with its kind in `models.ts`
   (`runtimes: [...]`).
5. **Settings.** Add a `<KIND>_BIN` setting in `settings.ts`, mention the runtime in
   `AGENT_RUNTIMES`, and run `pnpm gen:config`.
6. **Label.** Add a display name in `apps/web/src/words.ts` (`RUNTIME_LABEL`).
7. **Evidence.** Record a live end-to-end run in `docs/runs/`.
