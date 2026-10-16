# Ticket providers

The factory reads its backlog and moves tickets through a **provider-neutral**
interface, so the work tracker is a choice, not an assumption. Three trackers
ship today — **Jira**, **GitHub Issues**, **Trello** — plus a **mock** provider
for trying the UI with no credentials. The provider (and its configuration and
credentials) is chosen entirely in the web UI and takes effect **live, without a
restart**. That is what makes the factory a white-label product: ship it with
`TICKET_PROVIDER=mock`, hand it to an operator, and let them point it at their
own tracker on first run.

> Source control (the SCM provider that holds repos and receives the pull/merge
> request) is a **separate**, still deploy-time choice (`SCM_PROVIDER`). Only the
> **ticket** provider is UI-configurable today; the same pattern applies when SCM
> white-labeling is picked up.

## Choosing a provider in the UI

Open **Settings** in the nav and answer **Where do your tickets live?** (`/settings#tickets`)
(or **Where does your code live?** for source control). Pick the tracker; only the
fields it needs appear below it. Enter the details and credentials, then click
**Save and check it works**, a live
preflight that shows the resolved identity on success or the exact failure
reason. The change is applied on the next request: the api rebuilds the provider
from the new configuration, no redeploy.

The UI asks only the essentials per tracker (address, account, token, which
projects/repos/boards). Advanced scoping (`JIRA_BOARDS`, `JIRA_TEAMS`,
`JIRA_JQL_TEMPLATE`, the `*_BUCKET_MAP` rules, `GITHUB_API_URL` for GitHub
Enterprise) is set in `.env`; hover the ⓘ next to the question to see the names.

### How a UI-entered secret is stored

A credential you type in the UI is never echoed back and never sits in cleartext
in the settings table:

1. The bytes go to a **write-only** `org_secret` sink in Postgres (keyed by the
   setting name), **encrypted at rest** with AES-256-GCM under `ASF_SECRET_KEY`
   (see [Encryption at rest](#encryption-at-rest) below).
2. The `org_setting` row for that key holds only the **pointer** string
   `secret://org/<KEY>` — not the token.
3. At provider-build time the api resolves that pointer back to the live token
   via an internal, `X-Run-Secret`-guarded RPC. The value never reaches any
   `/api/*` browser route.

So the browser only ever learns whether a secret is **set** or **not set**; the
"Test connection" button proves it works without displaying it.

### Encryption at rest

The registry encrypts every `org_secret` value with **AES-256-GCM** under
`ASF_SECRET_KEY`, a 32-byte key that lives only in the registry's environment —
never in Postgres. So a `pg_dump`, a copied volume or a leaked backup holds
ciphertext only.

- **Format.** `enc:v1:<keyId>:<iv>:<tag>:<ciphertext>`: a random IV per write, the row
  name bound as authenticated data (an envelope copied onto another row fails), and
  `keyId` an 8-hex fingerprint of the key (not the key) so the registry and
  `asf doctor` can tell which key a row needs.
- **Setup.** `setup.sh` generates the key. On an older install, `asf secret-key`
  (or re-running `setup.sh`) adds it; the registry then encrypts the existing
  plaintext rows at its next boot, keeping each token's saved date.
- **No key.** Everything still works, in plaintext, and `asf doctor` warns.
- **Wrong or missing key** (e.g. a restore onto a fresh `.env`). The registry keeps
  serving runs; `asf doctor` shows ✗ with both key ids, and a provider that needs an
  affected token fails with that message. It is never silently treated as "not set".
  Rows that can't be opened are never rewritten or deleted.
- **Rotation.** `asf secret-key --rotate` moves the current key to
  `ASF_SECRET_KEY_PREVIOUS`, writes a fresh key, lets the registry re-encrypt every row,
  proves they all open with the new key alone, then drops the old one. With more than
  one registry instance (a cloud deploy), give **every** instance the new key and keep
  `ASF_SECRET_KEY_PREVIOUS` until all of them run it: a registry still on the old key
  would write tokens only the old key can open.
- **From a secret manager.** Like any env setting, `ASF_SECRET_KEY` may be a
  `secret://…` pointer resolved through `SECRETS_SOURCE` at registry boot.
- **Back the key up separately from the database.** A database backup without its key
  loses every saved token (re-enter them in Settings); a key stored next to the
  backups protects nothing.
- **Scope.** This protects data at rest. Anyone who controls the running registry (its
  environment or its process) can still read the tokens; the api and worker drop
  `ASF_SECRET_KEY` at boot, so agents never inherit it.

A hardened deployment can bypass the UI sink entirely: set
`SECRETS_SOURCE=gcp`/`aws`/`file` and provide the provider tokens at the **env**
tier (env always wins over org), keeping secrets in a managed store.

## The `TicketProvider` contract

Defined in `packages/shared/src/ticket.ts`. Every provider maps its native
object to the neutral `Ticket` and back; rich text is **Markdown** at this seam.

| Member | Purpose |
|---|---|
| `kind` | The provider id (`'jira' \| 'github' \| 'trello' \| …`). |
| `preflight()` | Cheap liveness + identity check. Use a `/myself`-style endpoint, **never a search** (a dead token can still 200 on some search endpoints). Returns `{ok, identity}` or `{ok:false, reason}`. |
| `capabilities()` | Which optional features the tracker supports: `subtasks`, `priority`, `links`, `transitions`, `assignable`. Callers guard on these before using them. |
| `list(query)` | The backlog, scoped + bucket-filtered + searched, sorted by recency, cursor-paged. |
| `get(id)` | One ticket by native id. |
| `update(id, patch)` | Title / body / priority / labels. Unsupported fields are no-ops. |
| `createSubtask(parentId, input)` | Optional; `throw` when `capabilities().subtasks` is false. |
| `addLink` / `comment` / `listComments` | Attach a URL, post a comment, read comments. |
| `transitions(id)` / `transition(id, transitionId)` | The available status moves and how to apply one. |
| `assign(id, assignee\|null)` | Assign to the factory's own identity; `null` unassigns. **Best-effort:** a tracker may accept an assign to an ineligible account and silently not apply it — assignment is a hint, not a guarantee. |
| `suggestedRepo?(ticket)` | Optional. When the tracker co-locates issues with code (a GitHub issue lives in a repo), the repo path to default the dispatch picker to. |

### The neutral bucket

Every raw status is mapped to one of six buckets — `backlog`, `ready`,
`inflight`, `review`, `blocked`, `done` — so the Today/Backlog views are the same
across trackers. Each provider decides the mapping from its own config
(`*_BUCKET_MAP` rules first, then a sensible fallback).

## How the three shipped providers map

| | Jira | GitHub Issues | Trello |
|---|---|---|---|
| Native unit | issue | issue | card |
| `id` / `key` | issue id / `KEY-123` | `owner/repo#123` / same | card id / `#<idShort>` |
| Auth | Basic (email + API token) | Bearer token | `?key=&token=` query params |
| Status source | issue status | open/closed + labels | **the list the card is in** |
| Bucket | `JIRA_BUCKET_MAP` else statusCategory | `GITHUB_BUCKET_MAP` else open→backlog/closed→done | `TRELLO_LIST_BUCKET_MAP` else position (first→backlog, last→done, else inflight) |
| Priority | issue priority | `priority:N`/`pN` label | none (null) |
| Subtasks | yes | task-list checkboxes | no (checklists ≈ subtasks, out of scope) |
| Transitions | live workflow transitions | open/close + label moves | **move to another list** |

## Adding a new tracker

The seam is deliberately small. A new provider is:

1. **One implementation file** under `apps/api/src/providers/tickets/<kind>/` (or
   a single `.ts`) implementing `TicketProvider`. Talk to the REST API over
   `fetch` — no CLI dependency, so it runs unchanged in a container. Mirror an
   existing provider (`github.ts` is the simplest; `trello/trello.ts` shows a
   non-issue tracker).
2. **One factory case** in `apps/api/src/providers/tickets/index.ts` that reads
   its config via `cfg(...)` and resolves any secret with
   `resolveProviderSecret(...)`.
3. **Settings keys** in `packages/shared/src/settings.ts` at the `env,org` tier,
   group `Providers` (mark tokens `secret:true`). `.env.example` and
   `CONFIGURATION.md` regenerate from the catalogue (`pnpm gen:config`).
4. **Provider-panel fields** in `apps/web/src/views/Providers.tsx`: add the key
   list to `FIELDS[<kind>]` and remove the kind from the `COMING_SOON` set.
5. **Tests** over a stubbed `global.fetch` (see `trello/trello.test.ts`):
   preflight ok/empty, list→bucket mapping, transitions, assign, capabilities.

No call site outside `providers/tickets/` may import a provider directly — the
factory and the hot-swap registry are the only way the rest of the api obtains
one.

## Ollama setup

Ollama models (a server on your computer or network, or Ollama Cloud) are the `ollama` provider.
They run under `claude-code` and are free in ASF's spend. Server setup, the Settings
question, `asf doctor`, and the models to pick are in [`OLLAMA.md`](OLLAMA.md).

## Codex setup

The `codex` agent runtime drives the OpenAI Codex CLI (`codex exec --json`). It
talks to OpenAI, or to any OpenAI-compatible endpoint, depending on which
provider serves the model a role runs with.

1. **Install Codex on the worker host**: `npm install -g @openai/codex`, then
   run `codex --version` to check it. If `codex` is not on the worker's `PATH`,
   set `CODEX_BIN`.
2. **Log in to OpenAI.** Pick one of these:
   - **api-key** (metered, the default for `AGENT_AUTH_OPENAI_MODE`): enter an
     `OPENAI_API_KEY` in Settings. It is delivered to each run, so the worker
     needs no login.
   - **chatgpt** (billed to your ChatGPT plan): run `codex login` once on the
     worker host as the worker's user. The login is saved in `~/.codex` (or
     `$CODEX_HOME`). Each task runs with its own fresh `CODEX_HOME` under the
     run dir, and the worker links that login into it.
3. **Offer the runtime**: set `AGENT_RUNTIMES=claude-code,codex` (a comma list;
   `AGENT_RUNTIME` still works as a deprecated single-value alias). At boot the
   worker probes each runtime (`codex --version`) and preflights its auth with a
   one-line "pong" prompt. It advertises only the runtimes that pass, and exits
   only if none do.
4. **Add the models** to `MODEL_CATALOG_EXTRA` (an org setting; enter it in the
   UI). No OpenAI model is built in, and neither is any price. The rates below
   are **placeholders**: copy the current per-1M-token prices from
   <https://openai.com/api/pricing/> and <https://api-docs.deepseek.com/quick_start/pricing>.
   Codex reports tokens but not dollars, so a model with no `rate` runs unpriced.

   ```json
   {
     "providers": [
       { "id": "openai", "kind": "openai" },
       { "id": "deepseek", "kind": "openai-compatible", "baseUrl": "https://api.deepseek.com/v1" }
     ],
     "models": [
       { "id": "gpt-5.5", "label": "GPT-5.5 (Codex)", "tier": "max", "providerId": "openai", "runtimes": ["codex"],
         "rate": { "inputPerM": 0, "outputPerM": 0, "cacheReadPerM": 0 } },
       { "id": "deepseek-chat", "label": "DeepSeek Chat (Codex)", "tier": "balanced", "providerId": "deepseek", "runtimes": ["codex"],
         "rate": { "inputPerM": 0, "outputPerM": 0, "cacheReadPerM": 0 } }
     ]
   }
   ```

5. **Set up the provider for an OpenAI-compatible model.** Codex talks to an
   `openai-compatible` provider through a generated `asf` model provider
   (`-c model_providers.asf.*`), so the worker needs no `config.toml`.
   - **Key:** `OPENAI_COMPAT_API_KEY`, or set `AGENT_AUTH_OPENAI_COMPAT_MODE=none`
     for a keyless local server.
   - **Endpoint:** the provider's `baseUrl` in the catalogue. If the provider
     entry has none, `OPENAI_COMPAT_BASE_URL` is used instead.
   - **Wire API:** current Codex releases only speak OpenAI's **Responses**
     API, so the endpoint must serve `/responses`. If it only serves
     `/chat/completions`, put a translating proxy (for example LiteLLM) in
     front of it.

What to expect from a Codex run:
- **Sandbox:** every role runs in Codex's `workspace-write` sandbox, scoped to
  the worktree plus the run dir.
- **Read-only roles:** a read-only role can still write its `plan.md` or
  `review.md`. The worker's post-run audit reverts any change it makes to
  source and fails the task.
- **Sandbox refusals** are recorded as `tool:denied` events. They never change
  the outcome; the agent decides for itself whether to reply `NEEDS_HUMAN:`.
- **Boot preflight:** the worker checks the runtime's default provider
  (`openai`) at boot. A fleet that only uses an OpenAI-compatible endpoint
  still needs that check to pass before the worker offers `codex`.
