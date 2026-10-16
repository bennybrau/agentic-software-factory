# M11: Run agent roles on Ollama models (local and Ollama Cloud)

Status: WP1–WP7 DONE (user guide: [`OLLAMA.md`](OLLAMA.md)); WP8 next. Milestone https://github.com/bennybrau/agentic-software-factory/milestone/3, issues #20 (WP1) to #27 (WP8).

## The need

Some people want the agent team on models they run themselves: no per-token bill, and code
that never leaves the machine. Others want large open models without buying a GPU. Ollama
covers both: a **local Ollama server** (this machine or one on the LAN) and **Ollama Cloud**
(`https://ollama.com`, API key). ASF should be able to run any role on an Ollama model,
next to Claude and GPT roles in the same team.

Decisions (Jon, 2026-10-14):

1. **Both setups in v1**: a local or LAN Ollama server, and Ollama Cloud direct.
2. **Per role**: one team can mix providers (for example Claude plans and reviews, a local
   model implements and tests). Not a whole-team switch only.
3. **Agent CLI: spike first.** Try both Claude Code and Codex against Ollama and pick per
   evidence (WP1). **Spike done ([`OLLAMA_SPIKE.md`](OLLAMA_SPIKE.md)): `claude-code` is the
   default runtime for Ollama models** (ASF's hooks keep working: scope, cancel, telemetry);
   `codex` is an opt-in alternative on containerised workers.
4. **Cost: Ollama runs count as $0**, local and Cloud alike (Cloud is a subscription with
   credits). Runaway protection comes from turn ceilings and time limits, not dollars.

## What Ollama offers (verified 2026-10-14)

Sources are the Ollama docs and server source; latest release v0.40.4.

- **Anthropic-compatible API**: `POST /v1/messages` since v0.14.0, with streaming, tools,
  tool results and thinking. Not supported: `tool_choice`, prompt caching,
  `count_tokens`. Usage tokens are approximate.
  https://docs.ollama.com/api/anthropic-compatibility
- **Claude Code against Ollama** is documented:
  `ANTHROPIC_BASE_URL=http://localhost:11434 ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY="" claude --model qwen3-coder`.
  For Cloud direct, use `ANTHROPIC_BASE_URL=https://ollama.com` and `ANTHROPIC_AUTH_TOKEN=$OLLAMA_API_KEY`.
  https://docs.ollama.com/integrations/claude-code
  Anthropic does not support non-Claude models behind a gateway, so there is no vendor
  support path. https://code.claude.com/docs/en/llm-gateway
- **OpenAI-compatible API**: `/v1/chat/completions` and `/v1/responses`. `/v1/responses`
  arrived in v0.13.3, is non-stateful, and needs v0.13.4+ for current Codex.
  Codex only speaks `wire_api = "responses"`; its built-in provider ids are `ollama` and
  `lmstudio` (`codex --oss --local-provider ollama`).
  https://docs.ollama.com/api/openai-compatibility, https://docs.ollama.com/integrations/codex
- **Ollama Cloud**: native API at `https://ollama.com/api`, OpenAI API at `https://ollama.com/v1`,
  Anthropic base URL `https://ollama.com`. Auth is `Authorization: Bearer <key>`, with keys
  from https://ollama.com/settings/keys. A local server signed in with `ollama signin` also
  proxies cloud models named `<model>:cloud` / `-cloud`. Cloud is billed as credits within a
  plan, and `GET https://ollama.com/api/usage` reports spend.
  https://docs.ollama.com/cloud, https://docs.ollama.com/api/cloud-usage
- **Discovery and health**: `GET /api/tags` (installed or cloud models), `POST /api/show`
  (capabilities, `<arch>.context_length`), `GET /api/version`, and `GET /` (`Ollama is running`).
- **Context length is the big trap.** The default `num_ctx` depends on VRAM and can be as
  small as 4k. Agents need **at least 64k** (`OLLAMA_CONTEXT_LENGTH=64000` on the *server*).
  Smaller silently truncates and the agent "forgets the task".
  https://docs.ollama.com/context-length
- **Model quality varies.** Tool-call reliability differs by model. Starting candidates:
  - local: `qwen3-coder` (30B), `gpt-oss:20b`, `gpt-oss:120b`
  - Cloud: `glm-5.3-flash`, `kimi-k2.7-code`, `minimax-m3`, `gpt-oss:120b`

## What already works (no change needed)

- **Per-role, per-model provider routing.** Each `run_task` carries its own runtime and
  model. `authForTask` (`apps/worker/src/auth/index.ts:73-80`) picks auth from the
  model's catalogue `providerId`, so a mixed team is already a data question, not new
  plumbing.
- **The catalogue**: `MODEL_CATALOG_EXTRA` + `MODEL_ALLOWLIST` + `GET /api/models` + the
  per-role model picker, with the Vertex precedent (`vertexCatalogueExtra`, `vertex.ts:105-113`)
  of a setup step writing ids into the catalogue.
- **The `openai-compatible` provider** (codex `-c model_providers.asf.*`, keyless `none`
  mode, opencode). An operator can already point codex at Ollama's `/v1` by hand through
  `.env` and `MODEL_CATALOG_EXTRA`. It is env-only, unverified, and has no UI.
- **$0 accounting**: an explicit `rate: {0,0,…}` prices a model at $0 honestly, and runs
  with unpriced tasks are counted (`monthUnpricedRuns`) and shown.
- **Host-worker mode** reaches a local Ollama at `http://localhost:11434` with no network
  setup.
- **Turn ceilings** `MAX_TURNS_<ROLE>` and the per-role wall clock `SEGMENT_TIMEOUT_MS`.

## Where the code assumes Claude or OpenAI (audit, main @ a06ec2c)

| file:line | assumption | change in this milestone |
|---|---|---|
| `packages/shared/src/context.ts:26,34` | Closed `PROVIDER_KINDS` enum; no Ollama | Add `ollama` with modes `none` (local) and `api-key` (Cloud) (WP2) |
| `apps/worker/src/auth/anthropic.ts:18,27,43-52` | claude-code env is key, OAuth, Vertex or Bedrock only; `ANTHROPIC_BASE_URL` is never set | Ollama translator for claude-code: base URL, bearer token, model pins (WP2) |
| `apps/worker/src/auth/index.ts:17-22,62-65` | `RUNTIME_PROVIDERS` does not let claude-code use any non-Anthropic provider | Allow `ollama` for the runtimes the spike approves (WP2) |
| `apps/worker/src/runtimes/claude-code.ts:162-187` | Cost comes from the CLI's `total_cost_usd`, priced as Claude | Ignore the CLI cost for Ollama models; price from the catalogue rate (0) (WP2) |
| `apps/worker/src/segment.ts:362` | `outcome.costUsd ?? priceUsage(...)`, so a reported number wins | Same as above (WP2) |
| `apps/worker/src/auth/openai-compatible.ts:27-36` | codex compat provider is generic `asf` | Ollama-specific codex provider args if the spike keeps codex (WP2) |
| `apps/worker/src/index.ts:96` | Boot preflight checks each runtime against its *default* provider only | Preflight against every provider the worker can serve, so an Ollama-only worker is offered (WP4) |
| `packages/shared/src/models.ts:37-60,164,177` | Built-in models and effort levels are Claude/GPT | Ollama models enter via the catalogue; no effort flag for Ollama models (WP3) |
| `apps/api/src/openai-check.ts`, `routes/admin.ts:89` | Provider checks exist for OpenAI only | `GET /api/providers/ollama/models`, `POST /api/providers/ollama/check` (WP3) |
| `packages/shared/src/setup-questions.ts:44-51,145-177` | Compat keys are `UI_ENV_ONLY`; `TeamAi = claude \| openai`, detected from the implementer runtime | Ollama question; the summary copes with a mixed team (WP5) |
| `apps/web/src/components/q/questions.tsx:268-390,560-606` | AI question has four fixed choices; the model picker does not group by provider | Ollama question and grouped picker (WP5) |
| `apps/api/src/routes/setup.ts:105-135` | Setup status knows Claude/OpenAI only | Ollama item (WP5) |
| `apps/registry/.../orchestrate.ts:41`, `dispatch.ts:113-117` | Caps are dollars only | Run wall-clock cap for $0 runs (WP6) |
| `docker-compose.self-host.yml:92-148` | No `extra_hosts`, so a container worker on Linux cannot reach host Ollama | `host.docker.internal:host-gateway` on Linux only; it breaks Rancher Desktop (WP7) |

## Design

### Provider: a dedicated `ollama` kind

Add the provider kind `ollama` rather than reusing `openai-compatible`:

- It needs **two wire formats** (Anthropic for Claude Code, OpenAI Responses for Codex).
- It has its own discovery and health API.
- It must not collide with another OpenAI-compatible endpoint an org already uses.

**Settings** (`packages/shared/src/settings.ts`, group "Agent providers"):

- `OLLAMA_BASE_URL`: the local or LAN server.
  - The default is empty, meaning "no local server".
  - The UI suggests `http://host.docker.internal:11434` for a container worker and
    `http://localhost:11434` for a host worker.
- `OLLAMA_API_KEY` (secret): the Ollama Cloud key.
  - Empty means Cloud is off.
  - Sent only to `https://ollama.com`, never to a local server.

**Catalogue providers.** Two entries are written into `MODEL_CATALOG_EXTRA.providers`, both
of kind `ollama`:

- `ollama` (base URL `OLLAMA_BASE_URL`, mode `none`)
- `ollama-cloud` (base URL `https://ollama.com`, mode `api-key`)

**Models.** Each enabled model is a catalogue entry:

- `providerId`: `ollama` or `ollama-cloud`.
- `rate`: zero.
- `tier`: set by the admin, defaulting to `balanced`.
- `runtimes`: whatever the spike approved.
- Ids are namespaced `ollama:<name>` and `ollama-cloud:<name>`, so `gpt-oss:20b` can never
  collide with a hosted id. The worker strips the prefix before passing `--model`.

`ollama` names already contain `:`, so the prefix is split on the first `:` only, and the
model ID schema must allow both.

**Worker translators** (`apps/worker/src/auth/ollama.ts`, new):

- **claude-code** (if the spike approves it):
  - Set `ANTHROPIC_BASE_URL=<base>`, `ANTHROPIC_AUTH_TOKEN=<key or "ollama">` and `ANTHROPIC_API_KEY=""`.
  - Pin `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` and
    `CLAUDE_CODE_SUBAGENT_MODEL` to the task model. Otherwise background and subagent calls
    ask for Claude ids the server does not have.
  - Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
  - Strip every other Anthropic credential, as the Vertex path does.
- **codex** (if the spike approves it): `-c model_providers.asf_ollama.{name,base_url=<base>/v1,wire_api=responses,env_key}`
  and `-c model_provider=asf_ollama`, plus `OLLAMA_API_KEY` in env for Cloud. Use a custom
  id, because `ollama` is reserved in Codex config.
- No effort flag for Ollama models (`--effort` and `model_reasoning_effort` are vendor
  features).
- **Cost**: when the task model's provider kind is `ollama`, the runtime's reported
  `costUsd` is dropped and the catalogue rate (0) is used. Token counts are kept.

### Discovery and checks (api)

**`GET /api/providers/ollama/models?source=local|cloud`** (admin-only):
- Calls `<base>/api/tags` or `https://ollama.com/api/tags`.
- For each model, calls `POST /api/show` and returns name, size, context length,
  capabilities, and whether `tools` is listed.
- Runs api-side because the api holds the key. A local URL must be reachable from the api
  container as well as the worker. The check reports which side failed.

**`POST /api/providers/ollama/check`**:
- `GET /api/version` (requires v0.14.0 or later for `/v1/messages`).
- One tiny tool-free completion on the chosen model.
- Warns when the model's loaded context is under 64k. `/api/show` gives the model maximum;
  the server setting is only visible via `ollama ps` after load, so the check sends a
  long-ish prompt and compares `prompt_eval_count`. If that proves unreliable, it warns
  with the fix instead.

### Worker offering

Today the worker preflights each runtime only against its default provider. Change it to
preflight each `(runtime, provider)` pair the worker can serve and offer the runtime when
**any** passes. The fleet then reports provider coverage, and dispatch routes a task to a
worker whose offer covers the task's provider. A Mac with only Ollama installed and no
Claude or OpenAI keys becomes a valid worker.

### Settings UI

- A new **"Ollama"** question (tier `later`, next to `models`) with:
  - local server URL, Check button, list of installed models with tick-to-enable;
  - Cloud key, Check button, list of cloud models with tick-to-enable;
  - a context-length warning with the one-line fix.
  It writes the two providers and the ticked models into `MODEL_CATALOG_EXTRA` and adds them
  to `MODEL_ALLOWLIST` if an allowlist is in use.
- The per-role **model picker** groups models by provider (Claude, OpenAI, Ollama local,
  Ollama Cloud). Picking an Ollama model sets that role's runtime to the approved runtime.
  This is how a mixed team is built; the existing AI question stays a whole-team shortcut.
- `detectTeamAi` gains a `'mixed'` reading, so the summary says "Mixed: Claude + Ollama"
  instead of lying.

### Cost and limits

- Ollama tasks are priced $0 (catalogue rate zero), and the run view shows "free (Ollama)"
  rather than "unpriced".
- A new **`RUN_MAX_MINUTES`** org setting (default 0 = off; suggested 180 when any role
  uses Ollama) cancels a run whose agents' summed working time exceeds it. Time at a gate or
  a question is a person's and doesn't count. As built (WP6), the sweeper enforces it
  (`runs/time-limit.ts`), since a long task never reaches `advance()`. Per-role `MAX_TURNS_*` and `SEGMENT_TIMEOUT_MS` keep doing their
  job.
- Ollama Cloud spend is not tracked in ASF dollars. The Ollama question links to the
  account usage page, and the check route can show `api/usage` for 24h.

### Networking and packaging

- **Linux only**: `extra_hosts: ["host.docker.internal:host-gateway"]` on `api` and `worker`, in
  `docker-compose.host-gateway.yml`, which `asf`/`setup.sh` layer on Linux (`ASF_HOST_GATEWAY`
  overrides; as built in WP7). Not in the default compose: on Rancher Desktop it
  remaps `host.docker.internal` to 172.17.0.1 and breaks the connection (spike finding 7).
- Document the server side:
  - `OLLAMA_HOST=0.0.0.0` so containers and LAN machines can reach it;
  - `OLLAMA_CONTEXT_LENGTH=64000`, set on the server process (`launchctl setenv` on macOS,
    `systemctl edit ollama` on Linux);
  - Ollama v0.14.0 or later.
- `asf doctor`: when `OLLAMA_BASE_URL` is set, check reachability from the host and from
  the worker container.
- If the spike keeps codex, nothing new is installed in the worker image; Claude Code
  already ships there.

## Work packages (one issue each)

- **WP1: Spike (throwaway): which CLI drives Ollama models.** Against a local Ollama
  (`qwen3-coder`, `gpt-oss:20b`, context 64k) and Ollama Cloud (`glm-5.3-flash`,
  `kimi-k2.7-code`), run one real ASF implementer task end to end with each of Claude Code
  and Codex, using the exact argv and env ASF would use. Record:
  - tool-call success;
  - whether claude-code hooks fire (scope block, telemetry, cancel);
  - whether the result envelope or JSONL parses;
  - what cost and usage the CLI reports;
  - whether model names need aliasing;
  - turn count and wall time against the same task on Claude Sonnet.

  **Done when:** `docs/OLLAMA_SPIKE.md` holds the results table and names the runtime per
  setup. The rest of the milestone cites it.

- **WP2: `ollama` provider kind and worker translators.**
  - Add the kind and its modes.
  - Add the settings `OLLAMA_BASE_URL` and `OLLAMA_API_KEY`, plus api `computeRunAuth` support.
  - Write `auth/ollama.ts` translators for the runtimes WP1 approved.
  - Handle the `ollama:` / `ollama-cloud:` id prefix.
  - Drop CLI cost for Ollama models.
  - Unit tests for argv and env.

  **Done when:** with `MODEL_CATALOG_EXTRA` written by hand, a dispatched run uses a local
  Ollama model for the implementer and Claude for the others. This is usable by hand.

- **WP3: Discovery and check routes, plus the catalogue writer.** Add
  `GET /api/providers/ollama/models` and `POST /api/providers/ollama/check`, and a shared
  `ollamaCatalogueExtra()` (Vertex pattern) with tests against a stub server.

  **Done when:** `curl` against both routes lists the local and Cloud models and flags a
  4k context.

- **WP4: Worker preflight per provider and provider-aware dispatch.** A worker with only
  Ollama configured is offered and claims Ollama tasks. A Claude-only worker never claims
  them.

  **Done when:** there is a test for each, and a live Ollama-only host worker completes a
  task.

- **WP5: Settings UI.** Add the Ollama question, the grouped per-role model picker, the
  `'mixed'` team reading, the setup-status item, and the `setup-questions` coverage test
  updated.

  **Done when:** a new user goes from nothing to a mixed team in the UI alone.

- **WP6: Cost display and the run wall-clock cap.** Show "free (Ollama)" in the run view
  and fleet, add `RUN_MAX_MINUTES` enforced in the orchestrator, and link Cloud usage.

  **Done when:** there are tests for the cap, and a $0 run shows as free, not unpriced.

- **WP7: Networking, doctor, and docs.** Add the compose `extra_hosts`, the `asf doctor`
  Ollama check, `docs/OLLAMA.md` (server setup, context length, model suggestions, Cloud
  key, mixed teams), and links from `PROVIDERS.md`, `RUNTIMES.md` and `INSTALL.md`.

  **Done when:** a fresh Linux box follows `docs/OLLAMA.md` and `asf doctor` goes green.

- **WP8: Live end-to-end on real tickets.**
  - Run one real ticket with Claude planning and reviewing and a local Ollama model
    implementing and testing.
  - Run one ticket fully on Ollama Cloud.
  - Record outcome, turns, wall time and failures in `docs/OLLAMA_SPIKE.md`.
  - Adjust the recommended models and default turn limits.

  **Done when:** both runs reach a draft PR, or the failure is written up with a fix filed.

## Order

WP1 first: it decides the runtime and can kill a path cheaply. WP2 makes the feature
usable by hand, and WP3 makes it discoverable. WP4, WP6 and WP7 are independent of each
other once WP2 lands. WP5 needs WP3. WP8 is last.

## Risks

- **Weak local models** may not follow the agent protocol (artifact files, `NEEDS_HUMAN`).
  WP1 and WP8 measure this; the docs will recommend models by evidence.
- **Context truncation** is silent. The check route and doctor warn, but cannot fully see
  the server setting.
- **Claude Code against non-Claude models is unsupported by Anthropic.** A CLI update can
  break it, so the worker preflight must catch it.
- **Cost caps do not protect $0 runs.** The wall-clock cap and turn ceilings are the
  backstop. Cloud credit exhaustion shows up as provider errors, not ASF budget stops.
