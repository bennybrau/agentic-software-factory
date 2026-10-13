# Configuration

*Generated from `packages/shared/src/settings.ts` — do not edit by hand; run `pnpm gen:config`.*

Every decision is a named setting resolved **environment variable > org setting (UI) > default**. A key that lists only `org` cannot be set from the environment; a key that lists only `env` is deploy-time and has no UI.

## Registry

| Key | Type | Default | Set from | Read by | Description |
|---|---|---|---|---|---|
| `DATABASE_URL` | string | `postgres://asf:asf@localhost:5432/asf` | env | registry | Postgres connection. ONLY the registry has this; the api and worker never do. The default is the local docker-compose dev database; in a real deployment point it at a managed instance (or secret://). |
| `DATABASE_SCHEMA` | string | *(blank)* | env | registry | Optional search_path. Tests use it to isolate a schema per run. |
| `DATABASE_MIGRATE` | boolean | `true` | env | registry | Apply db/migrations/*.sql at boot (additive-only, checksummed). |
| `DATABASE_TEST_URL` | string | `postgres://asf:asf@localhost:5432/asf_test` | env | registry | Registry tests; each test file uses its own schema. |
| `REGISTRY_PORT` | number | `8788` | env | registry | Port the registry binds. PORT (Cloud Run) overrides. |
| `REGISTRY_HOST` | string | `127.0.0.1` | env | registry | Bind address. 127.0.0.1 locally; 0.0.0.0 in a container (set automatically when PORT is present). |
| `REGISTRY_URL` | string | `http://127.0.0.1:8788` | env | api, worker | Where the api and worker reach the registry. The ONE value a shared deployment changes. |
| `RUN_EVENT_SECRET` | string | *(secret)* | env | registry, api, worker | Shared machine secret (X-Run-Secret) between registry, api and worker. Must be identical on all three. Generated at boot when blank — fine on one machine, useless across hosts. |
| `ASF_SECRET_KEY` | string | *(secret)* | env | registry | Encrypts tokens saved through Settings (the org_secret table) at rest with AES-256-GCM: 32 random bytes as 64 hex characters (`openssl rand -hex 32`; setup.sh and `asf secret-key` generate it). Registry only — never give it to the api or worker. Back it up separately from the database: a restore without it loses every saved token. Blank = tokens stay plaintext and doctor warns. |
| `ASF_SECRET_KEY_PREVIOUS` | string | *(secret)* | env | registry | Key rotation: the OLD ASF_SECRET_KEY. At boot the registry re-encrypts every saved token from this key to ASF_SECRET_KEY; remove it once doctor shows all tokens on the new key. |
| `STALE_AFTER_MIN` | number | `15` | env, org | registry | Minutes of silence before a running run is marked stale (resumable). |
| `WORKER_TTL_SECONDS` | number | `90` | env, org | registry | Seconds since last heartbeat before a worker is forgotten and its runs staled. |
| `RECONCILE_INTERVAL_MS` | number | `60000` | env | registry | How often the sweeper looks. |
| `EVENT_RETENTION_DAYS` | number | `90` | env, org | registry | run_events older than this are pruned. agent_run is kept forever by design. |

## API

| Key | Type | Default | Set from | Read by | Description |
|---|---|---|---|---|---|
| `API_PORT` | number | `8787` | env | api | Port the api binds. PORT (Cloud Run) overrides. |
| `API_HOST` | string | `127.0.0.1` | env | api | Bind address; 0.0.0.0 in a container (automatic when PORT is present). |
| `API_URL` | string | `http://127.0.0.1:8787` | env | worker | Where the worker reaches the api (alias BFF_URL). |
| `BFF_URL` | string | *(blank)* | env | worker | Alias of API_URL (takes precedence when set). |
| `WEB_DIST` | string | *(blank)* | env | api | Serve the built web bundle from this directory at /. Blank = the Vite dev server serves it (pnpm dev). |
| `QUEUE_ENABLED` | boolean | `true` | env, org | api | Whether the api runs the work-queue scheduler that turns queued tickets into runs. Off = the queue only records intent. |
| `QUEUE_TICK_MS` | number | `5000` | env | api | How often the work-queue scheduler looks for entries ready to dispatch. |
| `MERGE_WATCH_ENABLED` | boolean | `true` | env, org | api | Whether the api watches runs that finished awaiting an external merge (merge stage off) and, when a human merges or closes the pull/merge request in the SCM, updates the run and moves the ticket to Done. Off = the run stays "awaiting external merge" until updated by hand. |
| `MERGE_WATCH_POLL_MS` | number | `60000` | env | api | How often the api polls the SCM for the state of change requests that runs are awaiting an external merge on. |
| `CREDENTIAL_CHECK_MS` | number | `21600000` | env | api | How often the api re-tests the tracker and source-control credentials and checks the age of a UI-saved Claude subscription token, so Settings warns before a run fails. Loading Settings also re-checks, at most every 30s. |
| `ADHOC_MAX_ATTACHMENTS` | number | `10` | env | api, registry | Most files one ad-hoc task (New task, no tracker ticket) may carry. Images, plain text and PDF only. |
| `ADHOC_MAX_ATTACHMENT_MB` | number | `10` | env | api, registry | Largest single ad-hoc task attachment, in MB. With ADHOC_MAX_ATTACHMENTS it also sizes the request body limit on the upload route and the registry RPC. |
| `AVATAR_MAX_MB` | number | `5` | env | api, registry | Largest single crew picture, in MB. Pictures (PNG, JPEG, GIF or WebP, one per crew member) are uploaded in Settings → Crew pictures, alone or as a theme pack zip; see docs/THEMES.md. Also sizes the request body limit on the upload routes and the registry RPC. |
| `ASF_LOCAL_SUPERVISOR` | boolean | `false` | env | api | Self-host only: a supervisor sidecar holding the Docker socket can start (or restart) the stopped compose worker container, so /setup and /workers offer a "Start a worker" button. Set by docker-compose.self-host.yml; off everywhere else. |
| `SUPERVISOR_URL` | string | `http://supervisor:8791` | env | api | Where the api reaches the supervisor sidecar (only used when ASF_LOCAL_SUPERVISOR is on). Never published outside the compose network. |

## Appearance

| Key | Type | Default | Set from | Read by | Description |
|---|---|---|---|---|---|
| `THEME` | string | `classic` | env, org | api | How the agent crew looks and talks on the run page: a built-in theme (classic, hive) or the id of an uploaded one. Picked in Settings ("How should the factory look?"). An id that does not exist falls back to classic. |

## Updates

| Key | Type | Default | Set from | Read by | Description |
|---|---|---|---|---|---|
| `UPDATE_CHECK_ENABLED` | boolean | `true` | env, org | api | Check once a day whether a newer ASF release (a vX.Y.Z image tag) is published. Anonymous and read-only: it only lists the tags of UPDATE_IMAGE_REPO. Nothing is installed; see docs/UPGRADING.md. |
| `UPDATE_IMAGE_REPO` | string | `ghcr.io/bennybrau/asf-api` | env | api | The image whose tags the update check reads (registry host / name). Point it at your own mirror if you publish ASF images elsewhere. |

## Providers

| Key | Type | Default | Set from | Read by | Description |
|---|---|---|---|---|---|
| `TICKET_PROVIDER` | mock \| jira \| github \| gitlab \| trello \| monday \| linear \| todoist | `mock` | env, org | api | Which work tracker the backlog comes from. One implementation file per value under apps/api/src/providers/tickets/. Org-settable so the operator picks the tracker in Settings ("Where do your tickets live?") and it hot-swaps without a restart. |
| `SCM_PROVIDER` | mock \| github \| gitlab | `mock` | env, org | api | Which source-control system holds the repos and receives the pull/merge request. One implementation file per value under apps/api/src/providers/scm/. Org-settable so the operator picks it in Settings ("Where does your code live?") and it hot-swaps without a restart. |
| `MOCK_REPO_PATH` | string | *(blank)* | env, org | api | mock SCM only (development and tests): a local git repo the worker clones. Blank = no repository, so nothing can start until real source control is connected. |
| `JIRA_BASE_URL` | string | *(blank)* | env, org | api | Jira: https://<org>.atlassian.net |
| `JIRA_EMAIL` | string | *(blank)* | env, org | api | Jira: the account the API token belongs to. |
| `JIRA_API_TOKEN` | string | *(secret)* | env, org | api | Jira: API token (id.atlassian.com → Security → API tokens). |
| `JIRA_PROJECTS` | string | *(blank)* | env, org | api | Jira: comma-separated project keys the backlog shows. |
| `JIRA_JQL_TEMPLATE` | string | `project in ({{projects}}) ORDER BY updated DESC` | env, org | api | Jira: JQL that scopes the backlog. {{projects}} expands to the quoted JIRA_PROJECTS keys. Must be bounded — Jira rejects an unrestricted query. Omit {{projects}} to write your own filter. |
| `JIRA_BUCKET_MAP` | string | *(blank)* | env, org | api | Jira: comma-separated status=bucket rules mapping a raw status name to a bucket (e.g. "In Progress=inflight,In Review=review"). First matching rule wins; unmatched statuses fall back to the issue statusCategory (new→backlog, indeterminate→inflight, done→done). |
| `JIRA_BOARDS` | string | *(blank)* | env, org | api | Jira: comma-separated Agile board ids that make up the backlog scope. When set, the provider reads the boards' issues over the Agile API (scoped to each board's saved filter and paginated in Jira) instead of pulling a whole project — the way to avoid loading all of a large project. When empty, it falls back to the JIRA_PROJECTS / JIRA_JQL_TEMPLATE path. |
| `JIRA_TEAMS` | string | *(blank)* | env, org | api | Jira: optional named groups of boards for the Team shortcut in the backlog UI, e.g. "payments=42,43; identity=51". Purely a grouping of JIRA_BOARDS ids — no Jira Team field is read. |
| `GITHUB_TOKEN` | string | *(secret)* | env, org | api | GitHub: fine-grained PAT or App token; repo + issues scopes. |
| `GITHUB_REPOS` | string | *(blank)* | env, org | api | GitHub: comma-separated owner/repo the backlog and repo picker cover. |
| `GITHUB_BUCKET_MAP` | string | *(blank)* | env, org | api | GitHub: comma-separated label=bucket rules mapping issue labels to a bucket (e.g. "status:in progress=inflight,status:review=review"). First matching rule wins; unmatched open issues fall to backlog, closed to done. |
| `GITHUB_API_URL` | string | `https://api.github.com` | env, org | api | GitHub REST/GraphQL API base (change for GitHub Enterprise Server). |
| `TRELLO_KEY` | string | *(secret)* | env, org | api | Trello: API key (trello.com/app-key). Paired with TRELLO_TOKEN as ?key=&token= query auth. |
| `TRELLO_TOKEN` | string | *(secret)* | env, org | api | Trello: API token generated against the key (trello.com/app-key → Token). |
| `TRELLO_BOARDS` | string | *(blank)* | env, org | api | Trello: comma-separated board ids the backlog covers. |
| `TRELLO_LIST_BUCKET_MAP` | string | *(blank)* | env, org | api | Trello: comma-separated listName=bucket rules mapping a card's list to a bucket (e.g. "Doing=inflight,Review=review"). First matching rule wins; unmatched cards fall back to a position heuristic (first list→backlog, last→done, else inflight). |
| `GITLAB_BASE_URL` | string | `https://gitlab.com` | env, org | api | GitLab instance base URL (self-managed or gitlab.com). |
| `GITLAB_TOKEN` | string | *(secret)* | env, org | api | GitLab: PAT with api scope (Developer+ on the target projects). |
| `GITLAB_REPOS` | string | *(blank)* | env, org | api | GitLab: comma-separated group/repo (path_with_namespace) the backlog and repo picker cover. |

## Ticket workflow

| Key | Type | Default | Set from | Read by | Description |
|---|---|---|---|---|---|
| `TICKET_STATUS_INPROGRESS` | string | `In Progress,In Development,Doing,inflight` | env, org | api | Comma-separated status/transition names (synonyms) the ticket moves to when a run is dispatched. Matched case-insensitively against the tracker's live transitions by name or destination status; first match wins. No match = the ticket is left where it is (not an error). Blank = disable this move. |
| `TICKET_STATUS_INREVIEW` | string | `In Review,Code Review,Review,review` | env, org | api | Comma-separated status/transition names the ticket moves to when the pull/merge request opens. Same matching rule as TICKET_STATUS_INPROGRESS. Blank = disable. |
| `TICKET_STATUS_DONE` | string | `Done,Closed,Resolved,Complete,done` | env, org | api | Comma-separated status/transition names the ticket moves to when the change request merges. Same matching rule as TICKET_STATUS_INPROGRESS. Blank = disable. |
| `TICKET_ASSIGNEE` | string | *(blank)* | env, org | api | The identity the factory assigns a ticket to on dispatch — its own bot/service account, so the board shows the factory owns the work. Jira: the accountId (id.atlassian.com → the account's profile; NOT the display name or email). GitHub: the bot account login. Blank = leave the assignee unchanged. |

## Notifications

| Key | Type | Default | Set from | Read by | Description |
|---|---|---|---|---|---|
| `NOTIFY_SINKS` | string | `web` | env, org | api | Comma-separated notification sinks. "web" (the in-app inbox) is always on. Add "telegram" to also push gate/needs-human/finished/failed notifications to a Telegram chat. |
| `WEB_BASE_URL` | string | *(blank)* | env, org | api | Public base URL of the web UI (e.g. https://asf.example.com). Prepended to a notification's in-app deep link so an external sink like Telegram can link straight to the run/gate. Blank = links are sent as relative #/ fragments. |
| `TELEGRAM_BOT_TOKEN` | string | *(secret)* | env | api | Telegram Bot API token (from @BotFather) for the telegram sink. Required when NOTIFY_SINKS includes telegram. |
| `TELEGRAM_CHAT_ID` | string | *(blank)* | env, org | api | Telegram chat id the bot posts notifications to (a user, group, or channel id). Required when NOTIFY_SINKS includes telegram. |
| `NOTIFY_POLL_MS` | number | `5000` | env | api | How often the api looks for undelivered notifications to push to external sinks. |

## Identity

| Key | Type | Default | Set from | Read by | Description |
|---|---|---|---|---|---|
| `AUTH_MODE` | none \| header | `none` | env | api | Who the operator is. none = single operator, a name box, badge says unverified. header = trust an upstream proxy (IAP, Tailscale, your SSO) that sets AUTH_HEADER; honoured only when the api is not reachable directly. |
| `AUTH_HEADER` | string | `X-Goog-Authenticated-User-Email` | env | api | header mode: the request header carrying the user identity (IAP: X-Goog-Authenticated-User-Email; Tailscale: Tailscale-User-Login). |
| `SECRETS_SOURCE` | env \| file \| gcp \| aws | `env` | env | registry, api, worker | Where secret:// values in settings are resolved from. env = the value is literal; file = SECRETS_DIR/<name>; gcp = Secret Manager; aws = Secrets Manager. |
| `SECRETS_DIR` | string | `/run/secrets` | env | registry, api, worker | file mode: directory of one-file-per-secret (Docker/K8s secrets). |

## Worker

| Key | Type | Default | Set from | Read by | Description |
|---|---|---|---|---|---|
| `AGENT_RUNTIMES` | string | `claude-code,codex` | env | worker | The headless coding agents this worker offers, comma-separated (claude-code, codex, opencode, copilot). claude-code and codex ship in the worker image; opencode and copilot are offered only when installed AND the worker is a container, since neither blocks out-of-scope writes by itself (docs/RUNTIMES.md). Each is probed and auth-preflighted; the worker advertises the ones that pass (so an AI nobody has connected yet simply isn't offered) and re-checks the rest, so one connected later in Settings comes online without a restart. A worker only claims tasks whose runtime it offers. |
| `AGENT_RUNTIME` | string | *(blank)* | env | worker | Deprecated; leave blank. Older installs have AGENT_RUNTIME=claude-code in .env. It no longer restricts the worker: it only puts that agent first, and the other agents in the image are still offered once connected. To restrict a worker, set AGENT_RUNTIMES. |
| `AGENT_AUTH_MODE` | oauth-token \| api-key \| vertex \| bedrock | `oauth-token` | env, org | worker, api | How the agent authenticates. api-key (recommended) = ANTHROPIC_API_KEY (metered; real cost per run; fine for a shared factory). oauth-token (the default, kept for upgrades and host `claude login` workers) = a long-lived Claude subscription token from `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN; billed to the plan, no per-run cost figure) — for the subscription owner's own, single-operator use only; Anthropic's terms do not allow one subscription to serve several people (see docs/CLAUDE_USAGE.md). vertex = Claude on Google Cloud (Vertex AI) with the worker host’s Google login (Application Default Credentials; docs/VERTEX.md). bedrock = AWS Bedrock with IAM. Org-settable so it can be switched from the UI without a worker restart (an env value still pins it); the api resolves the effective mode + credential per run and the worker applies it on the next task. |
| `CLAUDE_CODE_OAUTH_TOKEN` | string | *(secret)* | env, org | worker, api | oauth-token mode. Generate once with `claude setup-token` on any machine with a browser (valid about a year) and enter it here; org-settable (write-only) so it is delivered to the worker per run via the resolved run context, never persisted in the worker. |
| `ANTHROPIC_API_KEY` | string | *(secret)* | env, org | worker, api | api-key mode. Org-settable (write-only) so it can be entered in the UI and delivered to the worker per run via the resolved run context, never persisted in the worker. |
| `ANTHROPIC_VERTEX_PROJECT_ID` | string | *(blank)* | env, org | api, worker | vertex mode: the Google Cloud project id with the Claude models enabled (Settings → Which AI should do the work? → Claude on Google Cloud). Reaches the worker with each task and on its auth check, so a change applies with no restart; a value in the worker's own env is the fallback. |
| `CLOUD_ML_REGION` | string | `global` | env, org | api, worker | vertex mode: the Vertex AI region, `global` (recommended) or one such as us-east5 where your Claude models are enabled. |
| `AWS_REGION` | string | `us-east-1` | env | worker | bedrock mode: region. |
| `CLAUDE_BIN` | string | `claude` | env | worker | Path to the Claude Code binary. |
| `CLAUDE_EXTRA_ARGS` | string | *(blank)* | env | worker | Extra CLI args appended to every spawn (space-separated). |
| `CODEX_BIN` | string | `codex` | env | worker | Path to the OpenAI Codex CLI binary (runtime `codex`). |
| `OPENCODE_BIN` | string | `opencode` | env | worker | Path to the OpenCode binary (runtime `opencode`). Offered only by a containerised worker (docs/RUNTIMES.md). |
| `COPILOT_BIN` | string | `copilot` | env | worker | Path to the GitHub Copilot CLI binary (runtime `copilot`). Offered only by a containerised worker (docs/RUNTIMES.md). |
| `CODEX_SANDBOX` | auto \| workspace-write \| off | `auto` | env | worker | Codex's own command sandbox. workspace-write = Codex confines commands to the worktree + run dir (macOS seatbelt / Linux bubblewrap). off = no nested sandbox (--dangerously-bypass-approvals-and-sandbox), for a worker that is already sandboxed: bubblewrap cannot create namespaces under Docker's default seccomp profile. Scope is still enforced by the container, the per-task worktree and the post-run guard audit. auto = off inside a container (/.dockerenv or ASF_IN_CONTAINER=1), workspace-write elsewhere. |
| `CODEX_EXTRA_ARGS` | string | *(blank)* | env | worker | Extra `codex exec` args appended to every Codex spawn (space-separated), after ASF's own flags and before the stdin prompt marker. |
| `WORKER_ID` | string | *(blank)* | env | worker | Stable worker id. Blank = worker-<host>-<pid>. |
| `WORKER_MAX_CONCURRENT` | number | `2` | env | worker | This worker’s contribution to fleet capacity. |
| `AGENT_AUTH_RECHECK_MS` | number | `300000` | env | worker | Claude on Google Cloud: how often a worker re-checks its Google login (free; no model call). An expired login stops the worker taking Claude tasks and sends one notification; it resumes on its own once the login works again. Not used for Bedrock or other modes. |
| `WORKER_POLL_INTERVAL_MS` | number | `3000` | env | worker | Claim poll interval. |
| `WORKER_HEARTBEAT_INTERVAL_MS` | number | `30000` | env | worker | Heartbeat interval; must be well under WORKER_TTL_SECONDS. |
| `SEGMENT_TIMEOUT_MS` | number | `2700000` | env, org | worker | A role still running after this is stuck, not thorough: SIGTERM then SIGKILL. |
| `WORKER_MAX_TURNS` | number | `40` | env, org | worker | Global default and backstop turn ceiling (--max-turns) so a wedged agent cannot loop until the timeout; a MAX_TURNS_<ROLE> overrides it for that role. 0 = no ceiling. Generous by design; the role prompts do the real trimming. |
| `MAX_TURNS_PLANNER` | number | `40` | env, org | api | Turn ceiling (--max-turns) for the planner. 0 = use WORKER_MAX_TURNS. |
| `MAX_TURNS_IMPLEMENTER` | number | `150` | env, org | api | Turn ceiling (--max-turns) for the implementer. 0 = use WORKER_MAX_TURNS. |
| `MAX_TURNS_TESTER` | number | `80` | env, org | api | Turn ceiling (--max-turns) for the tester. 0 = use WORKER_MAX_TURNS. |
| `MAX_TURNS_REVIEWER` | number | `40` | env, org | api | Turn ceiling (--max-turns) for the reviewer. 0 = use WORKER_MAX_TURNS. |
| `WORKER_DRY_RUN` | boolean | `false` | env | worker | Run everything, publish nothing: no push, no PR. How to try a run the first time. |
| `WORKTREE_ROOT` | string | *(blank)* | env | worker | Where repos are cloned and worktrees live. Blank = <tmpdir>/asf-worktrees. Must NOT be a macOS TCC-protected folder for an unattended host. |
| `RUN_DATA_ROOT` | string | *(blank)* | env | worker | Per-run dir: prompts, transcripts, artifacts. Blank = <tmpdir>/asf-runs. |

## Agent providers

| Key | Type | Default | Set from | Read by | Description |
|---|---|---|---|---|---|
| `AGENT_AUTH_OPENAI_MODE` | api-key \| chatgpt | `api-key` | env, org | api | How an OpenAI-backed runtime (Codex) authenticates. api-key = OPENAI_API_KEY (metered). chatgpt = a ChatGPT-plan login already present in the runtime's own home on the worker (no credential travels). |
| `OPENAI_API_KEY` | string | *(secret)* | env, org | api | OpenAI api-key mode. Write-only; delivered to the worker per run, never persisted there. |
| `OPENAI_BASE_URL` | string | *(blank)* | env, org | api | Optional OpenAI endpoint override (e.g. an Azure OpenAI or proxy URL). Blank = the runtime default. |
| `AGENT_AUTH_OPENAI_COMPAT_MODE` | api-key \| none | `api-key` | env, org | api | How a runtime authenticates to an OpenAI-compatible endpoint (DeepSeek, Qwen, GLM, a local vLLM/llama.cpp server). none = the endpoint takes no key (local servers). |
| `OPENAI_COMPAT_API_KEY` | string | *(secret)* | env, org | api | OpenAI-compatible api-key mode. Write-only; delivered to the worker per run. |
| `OPENAI_COMPAT_BASE_URL` | string | *(blank)* | env, org | api | The OpenAI-compatible endpoint, e.g. https://api.deepseek.com/v1 or http://host.docker.internal:8080/v1. Required for that provider. |
| `AGENT_AUTH_GITHUB_MODE` | gh-token | `gh-token` | env, org | api | How a GitHub-backed runtime (Copilot CLI) authenticates. gh-token = GITHUB_COPILOT_TOKEN, a token with Copilot access. |
| `GITHUB_COPILOT_TOKEN` | string | *(secret)* | env, org | api | GitHub token with Copilot access for gh-token mode. Separate from the SCM token on purpose (different scope, different owner). Write-only; delivered per run. |

## Models & budget

| Key | Type | Default | Set from | Read by | Description |
|---|---|---|---|---|---|
| `MODEL_DEFAULT_PLANNER` | string | `claude-opus-4-8` | env, org | api | Model the planner runs with unless the dispatch overrides it. Must be a model id in the catalogue (built-in or MODEL_CATALOG_EXTRA), on MODEL_ALLOWLIST when one is set, that its runtime can drive; checked at dispatch. |
| `MODEL_DEFAULT_IMPLEMENTER` | string | `claude-opus-4-8` | env, org | api | Model the implementer runs with unless the dispatch overrides it. Must be a model id in the catalogue (built-in or MODEL_CATALOG_EXTRA), on MODEL_ALLOWLIST when one is set, that its runtime can drive; checked at dispatch. |
| `MODEL_DEFAULT_TESTER` | string | `claude-sonnet-5` | env, org | api | Model the tester runs with unless the dispatch overrides it. Must be a model id in the catalogue (built-in or MODEL_CATALOG_EXTRA), on MODEL_ALLOWLIST when one is set, that its runtime can drive; checked at dispatch. |
| `MODEL_DEFAULT_REVIEWER` | string | `claude-sonnet-5` | env, org | api | Model the reviewer runs with unless the dispatch overrides it. Must be a model id in the catalogue (built-in or MODEL_CATALOG_EXTRA), on MODEL_ALLOWLIST when one is set, that its runtime can drive; checked at dispatch. |
| `RUNTIME_DEFAULT_PLANNER` | string | `claude-code` | env, org | api | Agent runtime the planner runs on unless the dispatch overrides it (claude-code, codex, …). |
| `RUNTIME_DEFAULT_IMPLEMENTER` | string | `claude-code` | env, org | api | Agent runtime the implementer runs on unless the dispatch overrides it (claude-code, codex, …). |
| `RUNTIME_DEFAULT_TESTER` | string | `claude-code` | env, org | api | Agent runtime the tester runs on unless the dispatch overrides it (claude-code, codex, …). |
| `RUNTIME_DEFAULT_REVIEWER` | string | `claude-code` | env, org | api | Agent runtime the reviewer runs on unless the dispatch overrides it (claude-code, codex, …). |
| `MODEL_ALLOWLIST` | string | *(blank)* | env, org | api | Comma-separated model ids this factory may run (blank = every catalogue model). On Vertex AI or Bedrock, list only the models enabled on your cloud project so a dispatch never offers one that would fail. Add provider-specific ids (claude-haiku-4-5@20251001, claude-sonnet-5[1m]) to MODEL_CATALOG_EXTRA first; an id in neither the built-ins nor MODEL_CATALOG_EXTRA is ignored. A role whose default model is hidden falls back to an allowed model of the same tier. [1m] ids price at the base rate (the long-context premium above 200K input tokens is not counted). Applies on the next dispatch, no restart. |
| `MODEL_CATALOG_EXTRA` | json | `{}` | org | api, worker | Models and providers added to the built-in catalogue, without a code change. Shape {"providers":[{"id","kind","baseUrl?","credentialKey?"}],"models":[{"id","label?","tier":"fast\|balanced\|max","providerId","runtimes":["codex",…],"rate?":{"inputPerM","outputPerM","cacheReadPerM?","cacheWritePerM?"}}]}. An entry with a built-in id replaces it. Applies on the next dispatch, no restart. |
| `EFFORT_DEFAULT_PLANNER` | low \| medium \| high \| xhigh \| max | `high` | env, org | api | Reasoning effort the planner runs with unless the dispatch overrides it. |
| `EFFORT_DEFAULT_IMPLEMENTER` | low \| medium \| high \| xhigh \| max | `high` | env, org | api | Reasoning effort the implementer runs with unless the dispatch overrides it. |
| `EFFORT_DEFAULT_TESTER` | low \| medium \| high \| xhigh \| max | `low` | env, org | api | Reasoning effort the tester runs with unless the dispatch overrides it. |
| `EFFORT_DEFAULT_REVIEWER` | low \| medium \| high \| xhigh \| max | `medium` | env, org | api | Reasoning effort the reviewer runs with unless the dispatch overrides it. |
| `ORG_MAX_COST_USD` | number | `25` | env, org | api | Hard per-run cap. A dispatch asking for more is refused with a reason. |
| `ORG_MONTHLY_BUDGET_USD` | number | `0` | env, org | api | Dispatch refuses once this calendar month’s summed run cost passes it. 0 = no budget. |

## Role skills

| Key | Type | Default | Set from | Read by | Description |
|---|---|---|---|---|---|
| `ROLE_SKILL_PLANNER` | string | *(blank)* | env, org | api | Standing guidance appended to the planner’s prompt on every dispatch. Blank = none. Appended below the shipped role template; the ticket and approved plan still take precedence. |
| `ROLE_SKILL_IMPLEMENTER` | string | *(blank)* | env, org | api | Standing guidance appended to the implementer’s prompt on every dispatch. Blank = none. Appended below the shipped role template; the ticket and approved plan still take precedence. |
| `ROLE_SKILL_TESTER` | string | *(blank)* | env, org | api | Standing guidance appended to the tester’s prompt on every dispatch. Blank = none. Appended below the shipped role template; the ticket and approved plan still take precedence. |
| `ROLE_SKILL_REVIEWER` | string | *(blank)* | env, org | api | Standing guidance appended to the reviewer’s prompt on every dispatch. Blank = none. Appended below the shipped role template; the ticket and approved plan still take precedence. |

## Policy

| Key | Type | Default | Set from | Read by | Description |
|---|---|---|---|---|---|
| `PIPELINE_STAGES` | json | `{}` | org | api | Per-stage pipeline config set in Settings ("When should it check with you?"): which stages ASF performs and whether a human approves each. Shape {"<stage>":{"enabled":bool,"gate":"required\|notify\|auto"}} for stages plan, implement, test, review, create_mr, merge. Empty = the standard team with all gates required. The merge stage gate (before_merge) may be relaxed here (org tier) but never from a dispatch; create_mr cannot be off while merge is on. |
| `LOOP_REPEAT_DETECT` | boolean | `true` | env | registry | When on (default), the orchestrator stops the reviewer↔implementer loop early if a review repeats the previous review’s blocking findings and the changes did not resolve them, parking at a needs-human checkpoint instead of burning another cycle. |

## Misc

| Key | Type | Default | Set from | Read by | Description |
|---|---|---|---|---|---|
| `LOG_LEVEL` | trace \| debug \| info \| warn \| error | `info` | env | registry, api, worker | pino log level. |
