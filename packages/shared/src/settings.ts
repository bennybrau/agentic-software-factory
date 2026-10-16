/**
 * The settings catalogue — the single source of truth for every decision an
 * operator or a third-party organisation makes about this system.
 *
 * Each setting declares its type, default, which tiers may set it, whether it
 * is a secret, and a description. `.env.example` and docs/CONFIGURATION.md are
 * GENERATED from this file (scripts/gen-config-docs.mjs), so they cannot drift.
 *
 * Resolution order, always:   environment variable  >  org_setting table  >  default
 *
 * Tiers:
 *   env  — deploy-time facts an operator owns: URLs, ports, provider kinds, secrets.
 *   org  — policy an org admin changes from the UI without a redeploy: default
 *          team, gate policy, cost caps. A key that allows only `org` cannot be
 *          set from the environment at all (this is how "before_merge can only
 *          be relaxed at the org level" is enforced by the catalogue, not by a comment).
 */

import { modelCatalogExtraSchema } from './models.js';

export type SettingType = 'string' | 'number' | 'boolean' | 'enum' | 'json';
export type Tier = 'env' | 'org';

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface SettingDef<T = unknown> {
  type: SettingType;
  default: T;
  tiers: Tier[];
  group: string;
  description: string;
  secret?: boolean;
  /** For type 'enum'. */
  values?: readonly string[];
  /** A long free-text value the settings UI should render as a textarea, not a one-line input (type stays 'string'). */
  multiline?: boolean;
  /** For type 'json': a shape check; returns the problem, or null when the value is fine. */
  validate?: (value: unknown) => string | null;
  /** Which service(s) read it — for the docs. */
  readBy: Array<'registry' | 'api' | 'worker' | 'web'>;
}

const S = <T>(d: SettingDef<T>): SettingDef<T> => d;

export const SETTINGS = {
  // ---------------------------------------------------------------- registry
  DATABASE_URL: S({ type: 'string', default: 'postgres://asf:asf@localhost:5432/asf', tiers: ['env'], group: 'Registry',
    readBy: ['registry'], description: 'Postgres connection. ONLY the registry has this; the api and worker never do. The default is the local docker-compose dev database; in a real deployment point it at a managed instance (or secret://).' }),
  DATABASE_SCHEMA: S({ type: 'string', default: '', tiers: ['env'], group: 'Registry', readBy: ['registry'],
    description: 'Optional search_path. Tests use it to isolate a schema per run.' }),
  DATABASE_MIGRATE: S({ type: 'boolean', default: true, tiers: ['env'], group: 'Registry', readBy: ['registry'],
    description: 'Apply db/migrations/*.sql at boot (additive-only, checksummed).' }),
  DATABASE_TEST_URL: S({ type: 'string', default: 'postgres://asf:asf@localhost:5432/asf_test', tiers: ['env'], group: 'Registry',
    readBy: ['registry'], description: 'Registry tests; each test file uses its own schema.' }),
  REGISTRY_PORT: S({ type: 'number', default: 8788, tiers: ['env'], group: 'Registry', readBy: ['registry'], description: 'Port the registry binds. PORT (Cloud Run) overrides.' }),
  REGISTRY_HOST: S({ type: 'string', default: '127.0.0.1', tiers: ['env'], group: 'Registry', readBy: ['registry'],
    description: 'Bind address. 127.0.0.1 locally; 0.0.0.0 in a container (set automatically when PORT is present).' }),
  REGISTRY_URL: S({ type: 'string', default: 'http://127.0.0.1:8788', tiers: ['env'], group: 'Registry', readBy: ['api', 'worker'],
    description: 'Where the api and worker reach the registry. The ONE value a shared deployment changes.' }),
  RUN_EVENT_SECRET: S({ type: 'string', default: '', tiers: ['env'], secret: true, group: 'Registry', readBy: ['registry', 'api', 'worker'],
    description: 'Shared machine secret (X-Run-Secret) between registry, api and worker. Must be identical on all three. Generated at boot when blank — fine on one machine, useless across hosts.' }),
  ASF_SECRET_KEY: S({ type: 'string', default: '', tiers: ['env'], secret: true, group: 'Registry', readBy: ['registry'],
    description: 'Encrypts tokens saved through Settings (the org_secret table) at rest with AES-256-GCM: 32 random bytes as 64 hex characters (`openssl rand -hex 32`; setup.sh and `asf secret-key` generate it). Registry only — never give it to the api or worker. Back it up separately from the database: a restore without it loses every saved token. Blank = tokens stay plaintext and doctor warns.' }),
  ASF_SECRET_KEY_PREVIOUS: S({ type: 'string', default: '', tiers: ['env'], secret: true, group: 'Registry', readBy: ['registry'],
    description: 'Key rotation: the OLD ASF_SECRET_KEY. At boot the registry re-encrypts every saved token from this key to ASF_SECRET_KEY; remove it once doctor shows all tokens on the new key.' }),
  STALE_AFTER_MIN: S({ type: 'number', default: 15, tiers: ['env', 'org'], group: 'Registry', readBy: ['registry'], description: 'Minutes of silence before a running run is marked stale (resumable).' }),
  WORKER_TTL_SECONDS: S({ type: 'number', default: 90, tiers: ['env', 'org'], group: 'Registry', readBy: ['registry'], description: 'Seconds since last heartbeat before a worker is forgotten and its runs staled.' }),
  RECONCILE_INTERVAL_MS: S({ type: 'number', default: 60_000, tiers: ['env'], group: 'Registry', readBy: ['registry'], description: 'How often the sweeper looks.' }),
  EVENT_RETENTION_DAYS: S({ type: 'number', default: 90, tiers: ['env', 'org'], group: 'Registry', readBy: ['registry'], description: 'run_events older than this are pruned. agent_run is kept forever by design.' }),

  // --------------------------------------------------------------------- api
  API_PORT: S({ type: 'number', default: 8787, tiers: ['env'], group: 'API', readBy: ['api'], description: 'Port the api binds. PORT (Cloud Run) overrides.' }),
  API_HOST: S({ type: 'string', default: '127.0.0.1', tiers: ['env'], group: 'API', readBy: ['api'], description: 'Bind address; 0.0.0.0 in a container (automatic when PORT is present).' }),
  API_URL: S({ type: 'string', default: 'http://127.0.0.1:8787', tiers: ['env'], group: 'API', readBy: ['worker'], description: 'Where the worker reaches the api (alias BFF_URL).' }),
  BFF_URL: S({ type: 'string', default: '', tiers: ['env'], group: 'API', readBy: ['worker'], description: 'Alias of API_URL (takes precedence when set).' }),
  WEB_DIST: S({ type: 'string', default: '', tiers: ['env'], group: 'API', readBy: ['api'],
    description: 'Serve the built web bundle from this directory at /. Blank = the Vite dev server serves it (pnpm dev).' }),
  QUEUE_ENABLED: S({ type: 'boolean', default: true, tiers: ['env', 'org'], group: 'API', readBy: ['api'],
    description: 'Whether the api runs the work-queue scheduler that turns queued tickets into runs. Off = the queue only records intent.' }),
  QUEUE_TICK_MS: S({ type: 'number', default: 5_000, tiers: ['env'], group: 'API', readBy: ['api'],
    description: 'How often the work-queue scheduler looks for entries ready to dispatch.' }),
  MERGE_WATCH_ENABLED: S({ type: 'boolean', default: true, tiers: ['env', 'org'], group: 'API', readBy: ['api'],
    description: 'Whether the api watches runs that finished awaiting an external merge (merge stage off) and, when a human merges or closes the pull/merge request in the SCM, updates the run and moves the ticket to Done. Off = the run stays "awaiting external merge" until updated by hand.' }),
  MERGE_WATCH_POLL_MS: S({ type: 'number', default: 60_000, tiers: ['env'], group: 'API', readBy: ['api'],
    description: 'How often the api polls the SCM for the state of change requests that runs are awaiting an external merge on.' }),
  CREDENTIAL_CHECK_MS: S({ type: 'number', default: 21_600_000, tiers: ['env'], group: 'API', readBy: ['api'],
    description: 'How often the api re-tests the tracker and source-control credentials and checks the age of a UI-saved Claude subscription token, so Settings warns before a run fails. Loading Settings also re-checks, at most every 30s.' }),
  ADHOC_MAX_ATTACHMENTS: S({ type: 'number', default: 10, tiers: ['env'], group: 'API', readBy: ['api', 'registry'],
    description: 'Most files one ad-hoc task (New task, no tracker ticket) may carry. Images, plain text and PDF only.' }),
  ADHOC_MAX_ATTACHMENT_MB: S({ type: 'number', default: 10, tiers: ['env'], group: 'API', readBy: ['api', 'registry'],
    description: 'Largest single ad-hoc task attachment, in MB. With ADHOC_MAX_ATTACHMENTS it also sizes the request body limit on the upload route and the registry RPC.' }),
  AVATAR_MAX_MB: S({ type: 'number', default: 5, tiers: ['env'], group: 'API', readBy: ['api', 'registry'],
    description: 'Largest single crew picture, in MB. Pictures (PNG, JPEG, GIF or WebP, one per crew member) are uploaded in Settings → Crew pictures, alone or as a theme pack zip; see docs/THEMES.md. Also sizes the request body limit on the upload routes and the registry RPC.' }),
  THEME: S({ type: 'string', default: 'classic', tiers: ['env', 'org'], group: 'Appearance', readBy: ['api'],
    description: 'How the agent crew looks and talks on the run page: a built-in theme (classic, hive) or the id of an uploaded one. Picked in Settings ("How should the factory look?"). An id that does not exist falls back to classic.' }),
  ASF_LOCAL_SUPERVISOR: S({ type: 'boolean', default: false, tiers: ['env'], group: 'API', readBy: ['api'],
    description: 'Self-host only: a supervisor sidecar holding the Docker socket can start (or restart) the stopped compose worker container, so /setup and /workers offer a "Start a worker" button. Set by docker-compose.self-host.yml; off everywhere else.' }),
  SUPERVISOR_URL: S({ type: 'string', default: 'http://supervisor:8791', tiers: ['env'], group: 'API', readBy: ['api'],
    description: 'Where the api reaches the supervisor sidecar (only used when ASF_LOCAL_SUPERVISOR is on). Never published outside the compose network.' }),
  UPDATE_CHECK_ENABLED: S({ type: 'boolean', default: true, tiers: ['env', 'org'], group: 'Updates', readBy: ['api'],
    description: 'Check once a day whether a newer ASF release (a vX.Y.Z image tag) is published. Anonymous and read-only: it only lists the tags of UPDATE_IMAGE_REPO. Nothing is installed; see docs/UPGRADING.md.' }),
  UPDATE_IMAGE_REPO: S({ type: 'string', default: 'ghcr.io/bennybrau/asf-api', tiers: ['env'], group: 'Updates', readBy: ['api'],
    description: 'The image whose tags the update check reads (registry host / name). Point it at your own mirror if you publish ASF images elsewhere.' }),
  TICKET_PROVIDER: S({ type: 'enum', values: ['mock', 'jira', 'github', 'gitlab', 'trello', 'monday', 'linear', 'todoist'], default: 'mock', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'],
    description: 'Which work tracker the backlog comes from. One implementation file per value under apps/api/src/providers/tickets/. Org-settable so the operator picks the tracker in Settings ("Where do your tickets live?") and it hot-swaps without a restart.' }),
  SCM_PROVIDER: S({ type: 'enum', values: ['mock', 'github', 'gitlab'], default: 'mock', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'],
    description: 'Which source-control system holds the repos and receives the pull/merge request. One implementation file per value under apps/api/src/providers/scm/. Org-settable so the operator picks it in Settings ("Where does your code live?") and it hot-swaps without a restart.' }),
  MOCK_REPO_PATH: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'], description: 'mock SCM only (development and tests): a local git repo the worker clones. Blank = no repository, so nothing can start until real source control is connected.' }),
  // The per-provider config keys below are org-settable (env,org) so the operator
  // configures the chosen tracker in /settings and it hot-swaps live.
  // SECRET-TIER INDIRECTION: a secret:true org key (JIRA_API_TOKEN, GITHUB_TOKEN,
  // TRELLO_TOKEN…) must NOT store the raw token as the org_setting jsonb value
  // (that would sit cleartext in org_setting and get read into the api cache).
  // Instead putSetting (apps/api/src/settings.ts) stores the org_setting VALUE as
  // the pointer string `secret://org/<KEY>` and writes the actual bytes to the
  // org_secret table (WP B); provider-build resolves the pointer via orgLookup.
  // describeSettings already redacts secrets, so the browser only sees set/unset.
  JIRA_BASE_URL: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'], description: 'Jira: https://<org>.atlassian.net' }),
  JIRA_EMAIL: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'], description: 'Jira: the account the API token belongs to.' }),
  JIRA_API_TOKEN: S({ type: 'string', default: '', tiers: ['env', 'org'], secret: true, group: 'Providers', readBy: ['api'], description: 'Jira: API token (id.atlassian.com → Security → API tokens).' }),
  JIRA_PROJECTS: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'], description: 'Jira: comma-separated project keys the backlog shows.' }),
  JIRA_JQL_TEMPLATE: S({ type: 'string', default: 'project in ({{projects}}) ORDER BY updated DESC', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'],
    description: 'Jira: JQL that scopes the backlog. {{projects}} expands to the quoted JIRA_PROJECTS keys. Must be bounded — Jira rejects an unrestricted query. Omit {{projects}} to write your own filter.' }),
  JIRA_BUCKET_MAP: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'],
    description: 'Jira: comma-separated status=bucket rules mapping a raw status name to a bucket (e.g. "In Progress=inflight,In Review=review"). First matching rule wins; unmatched statuses fall back to the issue statusCategory (new→backlog, indeterminate→inflight, done→done).' }),
  JIRA_BOARDS: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'],
    description: 'Jira: comma-separated Agile board ids that make up the backlog scope. When set, the provider reads the boards\' issues over the Agile API (scoped to each board\'s saved filter and paginated in Jira) instead of pulling a whole project — the way to avoid loading all of a large project. When empty, it falls back to the JIRA_PROJECTS / JIRA_JQL_TEMPLATE path.' }),
  JIRA_TEAMS: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'],
    description: 'Jira: optional named groups of boards for the Team shortcut in the backlog UI, e.g. "payments=42,43; identity=51". Purely a grouping of JIRA_BOARDS ids — no Jira Team field is read.' }),
  GITHUB_TOKEN: S({ type: 'string', default: '', tiers: ['env', 'org'], secret: true, group: 'Providers', readBy: ['api'], description: 'GitHub: fine-grained PAT or App token; repo + issues scopes.' }),
  GITHUB_REPOS: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'], description: 'GitHub: comma-separated owner/repo the backlog and repo picker cover.' }),
  GITHUB_BUCKET_MAP: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'],
    description: 'GitHub: comma-separated label=bucket rules mapping issue labels to a bucket (e.g. "status:in progress=inflight,status:review=review"). First matching rule wins; unmatched open issues fall to backlog, closed to done.' }),
  GITHUB_API_URL: S({ type: 'string', default: 'https://api.github.com', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'], description: 'GitHub REST/GraphQL API base (change for GitHub Enterprise Server).' }),
  TRELLO_KEY: S({ type: 'string', default: '', tiers: ['env', 'org'], secret: true, group: 'Providers', readBy: ['api'], description: 'Trello: API key (trello.com/app-key). Paired with TRELLO_TOKEN as ?key=&token= query auth.' }),
  TRELLO_TOKEN: S({ type: 'string', default: '', tiers: ['env', 'org'], secret: true, group: 'Providers', readBy: ['api'], description: 'Trello: API token generated against the key (trello.com/app-key → Token).' }),
  TRELLO_BOARDS: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'], description: 'Trello: comma-separated board ids the backlog covers.' }),
  TRELLO_LIST_BUCKET_MAP: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'],
    description: 'Trello: comma-separated listName=bucket rules mapping a card\'s list to a bucket (e.g. "Doing=inflight,Review=review"). First matching rule wins; unmatched cards fall back to a position heuristic (first list→backlog, last→done, else inflight).' }),
  GITLAB_BASE_URL: S({ type: 'string', default: 'https://gitlab.com', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'], description: 'GitLab instance base URL (self-managed or gitlab.com).' }),
  GITLAB_TOKEN: S({ type: 'string', default: '', tiers: ['env', 'org'], secret: true, group: 'Providers', readBy: ['api'], description: 'GitLab: PAT with api scope (Developer+ on the target projects).' }),
  GITLAB_REPOS: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Providers', readBy: ['api'], description: 'GitLab: comma-separated group/repo (path_with_namespace) the backlog and repo picker cover.' }),

  // ------------------------------------------------- ticket workflow (status transitions)
  TICKET_STATUS_INPROGRESS: S({ type: 'string', default: 'In Progress,In Development,Doing,inflight', tiers: ['env', 'org'], group: 'Ticket workflow', readBy: ['api'],
    description: 'Comma-separated status/transition names (synonyms) the ticket moves to when a run is dispatched. Matched case-insensitively against the tracker\'s live transitions by name or destination status; first match wins. No match = the ticket is left where it is (not an error). Blank = disable this move.' }),
  TICKET_STATUS_INREVIEW: S({ type: 'string', default: 'In Review,Code Review,Review,review', tiers: ['env', 'org'], group: 'Ticket workflow', readBy: ['api'],
    description: 'Comma-separated status/transition names the ticket moves to when the pull/merge request opens. Same matching rule as TICKET_STATUS_INPROGRESS. Blank = disable.' }),
  TICKET_STATUS_DONE: S({ type: 'string', default: 'Done,Closed,Resolved,Complete,done', tiers: ['env', 'org'], group: 'Ticket workflow', readBy: ['api'],
    description: 'Comma-separated status/transition names the ticket moves to when the change request merges. Same matching rule as TICKET_STATUS_INPROGRESS. Blank = disable.' }),
  TICKET_ASSIGNEE: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Ticket workflow', readBy: ['api'],
    description: 'The identity the factory assigns a ticket to on dispatch — its own bot/service account, so the board shows the factory owns the work. Jira: the accountId (id.atlassian.com → the account\'s profile; NOT the display name or email). GitHub: the bot account login. Blank = leave the assignee unchanged.' }),

  // ------------------------------------------------- notifications (M6 WP6.3)
  NOTIFY_SINKS: S({ type: 'string', default: 'web', tiers: ['env', 'org'], group: 'Notifications', readBy: ['api'],
    description: 'Comma-separated notification sinks. "web" (the in-app inbox) is always on. Add "telegram" to also push gate/needs-human/finished/failed notifications to a Telegram chat.' }),
  WEB_BASE_URL: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Notifications', readBy: ['api'],
    description: 'Public base URL of the web UI (e.g. https://asf.example.com). Prepended to a notification\'s in-app deep link so an external sink like Telegram can link straight to the run/gate. Blank = links are sent as relative #/ fragments.' }),
  TELEGRAM_BOT_TOKEN: S({ type: 'string', default: '', tiers: ['env'], secret: true, group: 'Notifications', readBy: ['api'],
    description: 'Telegram Bot API token (from @BotFather) for the telegram sink. Required when NOTIFY_SINKS includes telegram.' }),
  TELEGRAM_CHAT_ID: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Notifications', readBy: ['api'],
    description: 'Telegram chat id the bot posts notifications to (a user, group, or channel id). Required when NOTIFY_SINKS includes telegram.' }),
  NOTIFY_POLL_MS: S({ type: 'number', default: 5_000, tiers: ['env'], group: 'Notifications', readBy: ['api'],
    description: 'How often the api looks for undelivered notifications to push to external sinks.' }),

  // ---------------------------------------------------------- identity/auth
  AUTH_MODE: S({ type: 'enum', values: ['none', 'header'], default: 'none', tiers: ['env'], group: 'Identity', readBy: ['api'],
    description: 'Who the operator is. none = single operator, a name box, badge says unverified. header = trust an upstream proxy (IAP, Tailscale, your SSO) that sets AUTH_HEADER; honoured only when the api is not reachable directly.' }),
  AUTH_HEADER: S({ type: 'string', default: 'X-Goog-Authenticated-User-Email', tiers: ['env'], group: 'Identity', readBy: ['api'],
    description: 'header mode: the request header carrying the user identity (IAP: X-Goog-Authenticated-User-Email; Tailscale: Tailscale-User-Login).' }),
  SECRETS_SOURCE: S({ type: 'enum', values: ['env', 'file', 'gcp', 'aws'], default: 'env', tiers: ['env'], group: 'Identity', readBy: ['registry', 'api', 'worker'],
    description: 'Where secret:// values in settings are resolved from. env = the value is literal; file = SECRETS_DIR/<name>; gcp = Secret Manager; aws = Secrets Manager.' }),
  SECRETS_DIR: S({ type: 'string', default: '/run/secrets', tiers: ['env'], group: 'Identity', readBy: ['registry', 'api', 'worker'], description: 'file mode: directory of one-file-per-secret (Docker/K8s secrets).' }),

  // ------------------------------------------------------------------ worker
  AGENT_RUNTIMES: S({ type: 'string', default: 'claude-code,codex', tiers: ['env'], group: 'Worker', readBy: ['worker'],
    description: 'The headless coding agents this worker offers, comma-separated (claude-code, codex, opencode, copilot). claude-code and codex ship in the worker image; opencode and copilot are offered only when installed AND the worker is a container, since neither blocks out-of-scope writes by itself (docs/RUNTIMES.md). Each is probed and auth-preflighted; the worker advertises the ones that pass (so an AI nobody has connected yet simply isn\'t offered) and re-checks the rest, so one connected later in Settings comes online without a restart. A worker only claims tasks whose runtime it offers.' }),
  AGENT_PROVIDERS: S({ type: 'string', default: '', tiers: ['env'], group: 'Worker', readBy: ['worker'],
    description: 'Blank (the default) = this worker offers its runtimes under every provider they can serve that passes its check: claude-code for Claude and, once OLLAMA_BASE_URL or OLLAMA_API_KEY is set, for Ollama too. A comma list (anthropic, openai, openai-compatible, github, ollama) limits it, e.g. AGENT_PROVIDERS=ollama dedicates a GPU box to Ollama tasks only. Tasks are routed by the provider of their model: a task on an Ollama model goes only to a worker offering Ollama, any other only to one offering its runtime under another provider (M11, docs/OLLAMA.md).' }),
  AGENT_RUNTIME: S({ type: 'string', default: '', tiers: ['env'], group: 'Worker', readBy: ['worker'],
    description: 'Deprecated; leave blank. Older installs have AGENT_RUNTIME=claude-code in .env. It no longer restricts the worker: it only puts that agent first, and the other agents in the image are still offered once connected. To restrict a worker, set AGENT_RUNTIMES.' }),
  AGENT_AUTH_MODE: S({ type: 'enum', values: ['oauth-token', 'api-key', 'vertex', 'bedrock'], default: 'oauth-token', tiers: ['env', 'org'], group: 'Worker', readBy: ['worker', 'api'],
    description: 'How the agent authenticates. api-key (recommended) = ANTHROPIC_API_KEY (metered; real cost per run; fine for a shared factory). oauth-token (the default, kept for upgrades and host `claude login` workers) = a long-lived Claude subscription token from `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN; billed to the plan, no per-run cost figure) — for the subscription owner\'s own, single-operator use only; Anthropic\'s terms do not allow one subscription to serve several people (see docs/CLAUDE_USAGE.md). vertex = Claude on Google Cloud (Vertex AI) with the worker host’s Google login (Application Default Credentials; docs/VERTEX.md). bedrock = AWS Bedrock with IAM. Org-settable so it can be switched from the UI without a worker restart (an env value still pins it); the api resolves the effective mode + credential per run and the worker applies it on the next task.' }),
  CLAUDE_CODE_OAUTH_TOKEN: S({ type: 'string', default: '', tiers: ['env', 'org'], secret: true, group: 'Worker', readBy: ['worker', 'api'], description: 'oauth-token mode. Generate once with `claude setup-token` on any machine with a browser (valid about a year) and enter it here; org-settable (write-only) so it is delivered to the worker per run via the resolved run context, never persisted in the worker.' }),
  ANTHROPIC_API_KEY: S({ type: 'string', default: '', tiers: ['env', 'org'], secret: true, group: 'Worker', readBy: ['worker', 'api'], description: 'api-key mode. Org-settable (write-only) so it can be entered in the UI and delivered to the worker per run via the resolved run context, never persisted in the worker.' }),
  // ---- other model providers (M8 WP C). A runtime authenticates to ONE provider
  // (claude-code -> anthropic via AGENT_AUTH_MODE above; codex -> openai or
  // openai-compatible; copilot -> github). Like the anthropic keys these are org-tier
  // and delivered per run via the resolved run context (RunContext.auths), so the
  // worker env never needs them; readBy api because only the api resolves them.
  AGENT_AUTH_OPENAI_MODE: S({ type: 'enum', values: ['api-key', 'chatgpt'], default: 'api-key', tiers: ['env', 'org'], group: 'Agent providers', readBy: ['api'],
    description: 'How an OpenAI-backed runtime (Codex) authenticates. api-key = OPENAI_API_KEY (metered). chatgpt = a ChatGPT-plan login already present in the runtime\'s own home on the worker (no credential travels).' }),
  OPENAI_API_KEY: S({ type: 'string', default: '', tiers: ['env', 'org'], secret: true, group: 'Agent providers', readBy: ['api'],
    description: 'OpenAI api-key mode. Write-only; delivered to the worker per run, never persisted there.' }),
  OPENAI_BASE_URL: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Agent providers', readBy: ['api'],
    description: 'Optional OpenAI endpoint override (e.g. an Azure OpenAI or proxy URL). Blank = the runtime default.' }),
  AGENT_AUTH_OPENAI_COMPAT_MODE: S({ type: 'enum', values: ['api-key', 'none'], default: 'api-key', tiers: ['env', 'org'], group: 'Agent providers', readBy: ['api'],
    description: 'How a runtime authenticates to an OpenAI-compatible endpoint (DeepSeek, Qwen, GLM, a local vLLM/llama.cpp server). none = the endpoint takes no key (local servers).' }),
  OPENAI_COMPAT_API_KEY: S({ type: 'string', default: '', tiers: ['env', 'org'], secret: true, group: 'Agent providers', readBy: ['api'],
    description: 'OpenAI-compatible api-key mode. Write-only; delivered to the worker per run.' }),
  OPENAI_COMPAT_BASE_URL: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Agent providers', readBy: ['api'],
    description: 'The OpenAI-compatible endpoint, e.g. https://api.deepseek.com/v1 or http://host.docker.internal:8080/v1. Required for that provider.' }),
  // M11: Ollama. No mode setting: a model on the `ollama` provider talks to the local
  // server keyless, one on `ollama-cloud` sends OLLAMA_API_KEY to https://ollama.com only.
  OLLAMA_BASE_URL: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Agent providers', readBy: ['api'],
    description: 'The local or LAN Ollama server for models on the `ollama` provider, e.g. http://host.docker.internal:11434 (container worker) or http://localhost:11434 (host worker). No /v1. Blank = no local server. The server needs a context of at least 64k (OLLAMA_CONTEXT_LENGTH).' }),
  OLLAMA_API_KEY: S({ type: 'string', default: '', tiers: ['env', 'org'], secret: true, group: 'Agent providers', readBy: ['api'],
    description: 'Ollama Cloud key (ollama.com/settings/keys) for models on the `ollama-cloud` provider. Sent only to https://ollama.com, never to a local server. Write-only; delivered to the worker per run.' }),
  AGENT_AUTH_GITHUB_MODE: S({ type: 'enum', values: ['gh-token'], default: 'gh-token', tiers: ['env', 'org'], group: 'Agent providers', readBy: ['api'],
    description: 'How a GitHub-backed runtime (Copilot CLI) authenticates. gh-token = GITHUB_COPILOT_TOKEN, a token with Copilot access.' }),
  GITHUB_COPILOT_TOKEN: S({ type: 'string', default: '', tiers: ['env', 'org'], secret: true, group: 'Agent providers', readBy: ['api'],
    description: 'GitHub token with Copilot access for gh-token mode. Separate from the SCM token on purpose (different scope, different owner). Write-only; delivered per run.' }),
  ANTHROPIC_VERTEX_PROJECT_ID: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Worker', readBy: ['api', 'worker'], description: 'vertex mode: the Google Cloud project id with the Claude models enabled (Settings → Which AI should do the work? → Claude on Google Cloud). Reaches the worker with each task and on its auth check, so a change applies with no restart; a value in the worker\'s own env is the fallback.' }),
  CLOUD_ML_REGION: S({ type: 'string', default: 'global', tiers: ['env', 'org'], group: 'Worker', readBy: ['api', 'worker'], description: 'vertex mode: the Vertex AI region, `global` (recommended) or one such as us-east5 where your Claude models are enabled.' }),
  AWS_REGION: S({ type: 'string', default: 'us-east-1', tiers: ['env'], group: 'Worker', readBy: ['worker'], description: 'bedrock mode: region.' }),
  CLAUDE_BIN: S({ type: 'string', default: 'claude', tiers: ['env'], group: 'Worker', readBy: ['worker'], description: 'Path to the Claude Code binary.' }),
  CLAUDE_EXTRA_ARGS: S({ type: 'string', default: '', tiers: ['env'], group: 'Worker', readBy: ['worker'], description: 'Extra CLI args appended to every spawn (space-separated).' }),
  CODEX_BIN: S({ type: 'string', default: 'codex', tiers: ['env'], group: 'Worker', readBy: ['worker'], description: 'Path to the OpenAI Codex CLI binary (runtime `codex`).' }),
  OPENCODE_BIN: S({ type: 'string', default: 'opencode', tiers: ['env'], group: 'Worker', readBy: ['worker'], description: 'Path to the OpenCode binary (runtime `opencode`). Offered only by a containerised worker (docs/RUNTIMES.md).' }),
  COPILOT_BIN: S({ type: 'string', default: 'copilot', tiers: ['env'], group: 'Worker', readBy: ['worker'], description: 'Path to the GitHub Copilot CLI binary (runtime `copilot`). Offered only by a containerised worker (docs/RUNTIMES.md).' }),
  CODEX_SANDBOX: S({ type: 'enum', values: ['auto', 'workspace-write', 'off'], default: 'auto', tiers: ['env'], group: 'Worker', readBy: ['worker'],
    description: 'Codex\'s own command sandbox. workspace-write = Codex confines commands to the worktree + run dir (macOS seatbelt / Linux bubblewrap). off = no nested sandbox (--dangerously-bypass-approvals-and-sandbox), for a worker that is already sandboxed: bubblewrap cannot create namespaces under Docker\'s default seccomp profile. Scope is still enforced by the container, the per-task worktree and the post-run guard audit. auto = off inside a container (/.dockerenv or ASF_IN_CONTAINER=1), workspace-write elsewhere.' }),
  CODEX_EXTRA_ARGS: S({ type: 'string', default: '', tiers: ['env'], group: 'Worker', readBy: ['worker'], description: 'Extra `codex exec` args appended to every Codex spawn (space-separated), after ASF\'s own flags and before the stdin prompt marker.' }),
  WORKER_ID: S({ type: 'string', default: '', tiers: ['env'], group: 'Worker', readBy: ['worker'], description: 'Stable worker id. Blank = worker-<host>-<pid>.' }),
  WORKER_MAX_CONCURRENT: S({ type: 'number', default: 2, tiers: ['env'], group: 'Worker', readBy: ['worker'], description: 'This worker’s contribution to fleet capacity.' }),
  AGENT_AUTH_RECHECK_MS: S({ type: 'number', default: 300_000, tiers: ['env'], group: 'Worker', readBy: ['worker'], description: 'Claude on Google Cloud: how often a worker re-checks its Google login (free; no model call). An expired login stops the worker taking Claude tasks and sends one notification; it resumes on its own once the login works again. Not used for Bedrock or other modes.' }),
  WORKER_POLL_INTERVAL_MS: S({ type: 'number', default: 3000, tiers: ['env'], group: 'Worker', readBy: ['worker'], description: 'Claim poll interval.' }),
  WORKER_HEARTBEAT_INTERVAL_MS: S({ type: 'number', default: 30_000, tiers: ['env'], group: 'Worker', readBy: ['worker'], description: 'Heartbeat interval; must be well under WORKER_TTL_SECONDS.' }),
  SEGMENT_TIMEOUT_MS: S({ type: 'number', default: 45 * 60_000, tiers: ['env', 'org'], group: 'Worker', readBy: ['worker'], description: 'A role still running after this is stuck, not thorough: SIGTERM then SIGKILL.' }),
  WORKER_MAX_TURNS: S({ type: 'number', default: 40, tiers: ['env', 'org'], group: 'Worker', readBy: ['worker'], description: 'Global default and backstop turn ceiling (--max-turns) so a wedged agent cannot loop until the timeout; a MAX_TURNS_<ROLE> overrides it for that role. 0 = no ceiling. Generous by design; the role prompts do the real trimming.' }),
  MAX_TURNS_PLANNER: S({ type: 'number', default: 40, tiers: ['env', 'org'], group: 'Worker', readBy: ['api'], description: 'Turn ceiling (--max-turns) for the planner. 0 = use WORKER_MAX_TURNS.' }),
  MAX_TURNS_IMPLEMENTER: S({ type: 'number', default: 150, tiers: ['env', 'org'], group: 'Worker', readBy: ['api'], description: 'Turn ceiling (--max-turns) for the implementer. 0 = use WORKER_MAX_TURNS.' }),
  MAX_TURNS_TESTER: S({ type: 'number', default: 80, tiers: ['env', 'org'], group: 'Worker', readBy: ['api'], description: 'Turn ceiling (--max-turns) for the tester. 0 = use WORKER_MAX_TURNS.' }),
  MAX_TURNS_REVIEWER: S({ type: 'number', default: 40, tiers: ['env', 'org'], group: 'Worker', readBy: ['api'], description: 'Turn ceiling (--max-turns) for the reviewer. 0 = use WORKER_MAX_TURNS.' }),
  WORKER_DRY_RUN: S({ type: 'boolean', default: false, tiers: ['env'], group: 'Worker', readBy: ['worker'], description: 'Run everything, publish nothing: no push, no PR. How to try a run the first time.' }),
  WORKTREE_ROOT: S({ type: 'string', default: '', tiers: ['env'], group: 'Worker', readBy: ['worker'], description: 'Where repos are cloned and worktrees live. Blank = <tmpdir>/asf-worktrees. Must NOT be a macOS TCC-protected folder for an unattended host.' }),
  RUN_DATA_ROOT: S({ type: 'string', default: '', tiers: ['env'], group: 'Worker', readBy: ['worker'], description: 'Per-run dir: prompts, transcripts, artifacts. Blank = <tmpdir>/asf-runs.' }),

  // ------------------------------------------------------ models & budget
  // Per-role model defaults. A dispatch may still override each role; the values come from the shared model catalogue (models.ts).
  MODEL_DEFAULT_PLANNER: S({ type: 'string', default: 'claude-opus-4-8', tiers: ['env', 'org'], group: 'Models & budget', readBy: ['api'], description: 'Model the planner runs with unless the dispatch overrides it. Must be a model id in the catalogue (built-in or MODEL_CATALOG_EXTRA), on MODEL_ALLOWLIST when one is set, that its runtime can drive; checked at dispatch.' }),
  MODEL_DEFAULT_IMPLEMENTER: S({ type: 'string', default: 'claude-opus-4-8', tiers: ['env', 'org'], group: 'Models & budget', readBy: ['api'], description: 'Model the implementer runs with unless the dispatch overrides it. Must be a model id in the catalogue (built-in or MODEL_CATALOG_EXTRA), on MODEL_ALLOWLIST when one is set, that its runtime can drive; checked at dispatch.' }),
  MODEL_DEFAULT_TESTER: S({ type: 'string', default: 'claude-sonnet-5', tiers: ['env', 'org'], group: 'Models & budget', readBy: ['api'], description: 'Model the tester runs with unless the dispatch overrides it. Must be a model id in the catalogue (built-in or MODEL_CATALOG_EXTRA), on MODEL_ALLOWLIST when one is set, that its runtime can drive; checked at dispatch.' }),
  MODEL_DEFAULT_REVIEWER: S({ type: 'string', default: 'claude-sonnet-5', tiers: ['env', 'org'], group: 'Models & budget', readBy: ['api'], description: 'Model the reviewer runs with unless the dispatch overrides it. Must be a model id in the catalogue (built-in or MODEL_CATALOG_EXTRA), on MODEL_ALLOWLIST when one is set, that its runtime can drive; checked at dispatch.' }),
  // Per-role runtime (which agent CLI drives the role). A dispatch may override each role; it must be offered by a live worker.
  RUNTIME_DEFAULT_PLANNER: S({ type: 'string', default: 'claude-code', tiers: ['env', 'org'], group: 'Models & budget', readBy: ['api'], description: 'Agent runtime the planner runs on unless the dispatch overrides it (claude-code, codex, …).' }),
  RUNTIME_DEFAULT_IMPLEMENTER: S({ type: 'string', default: 'claude-code', tiers: ['env', 'org'], group: 'Models & budget', readBy: ['api'], description: 'Agent runtime the implementer runs on unless the dispatch overrides it (claude-code, codex, …).' }),
  RUNTIME_DEFAULT_TESTER: S({ type: 'string', default: 'claude-code', tiers: ['env', 'org'], group: 'Models & budget', readBy: ['api'], description: 'Agent runtime the tester runs on unless the dispatch overrides it (claude-code, codex, …).' }),
  RUNTIME_DEFAULT_REVIEWER: S({ type: 'string', default: 'claude-code', tiers: ['env', 'org'], group: 'Models & budget', readBy: ['api'], description: 'Agent runtime the reviewer runs on unless the dispatch overrides it (claude-code, codex, …).' }),
  MODEL_ALLOWLIST: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Models & budget', readBy: ['api'], description: 'Comma-separated model ids this factory may run (blank = every catalogue model). On Vertex AI or Bedrock, list only the models enabled on your cloud project so a dispatch never offers one that would fail. Add provider-specific ids (claude-haiku-4-5@20251001, claude-sonnet-5[1m]) to MODEL_CATALOG_EXTRA first; an id in neither the built-ins nor MODEL_CATALOG_EXTRA is ignored. A role whose default model is hidden falls back to an allowed model of the same tier. [1m] ids price at the base rate (the long-context premium above 200K input tokens is not counted). Applies on the next dispatch, no restart.' }),
  MODEL_CATALOG_EXTRA: S({ type: 'json', default: {}, tiers: ['org'], group: 'Models & budget', readBy: ['api', 'worker'],
    validate: (v) => { const r = modelCatalogExtraSchema.safeParse(v); return r.success ? null : r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '); },
    description: 'Models and providers added to the built-in catalogue, without a code change. Shape {"providers":[{"id","kind","baseUrl?","credentialKey?"}],"models":[{"id","label?","tier":"fast|balanced|max","providerId","runtimes":["codex",…],"rate?":{"inputPerM","outputPerM","cacheReadPerM?","cacheWritePerM?"}}]}. An entry with a built-in id replaces it. Applies on the next dispatch, no restart.' }),
  // Per-role reasoning effort (claude -p --effort). Blank = the CLI default. A dispatch may override each role.
  EFFORT_DEFAULT_PLANNER: S({ type: 'enum', values: EFFORT_LEVELS, default: 'high', tiers: ['env', 'org'], group: 'Models & budget', readBy: ['api'], description: 'Reasoning effort the planner runs with unless the dispatch overrides it.' }),
  EFFORT_DEFAULT_IMPLEMENTER: S({ type: 'enum', values: EFFORT_LEVELS, default: 'high', tiers: ['env', 'org'], group: 'Models & budget', readBy: ['api'], description: 'Reasoning effort the implementer runs with unless the dispatch overrides it.' }),
  EFFORT_DEFAULT_TESTER: S({ type: 'enum', values: EFFORT_LEVELS, default: 'low', tiers: ['env', 'org'], group: 'Models & budget', readBy: ['api'], description: 'Reasoning effort the tester runs with unless the dispatch overrides it.' }),
  EFFORT_DEFAULT_REVIEWER: S({ type: 'enum', values: EFFORT_LEVELS, default: 'medium', tiers: ['env', 'org'], group: 'Models & budget', readBy: ['api'], description: 'Reasoning effort the reviewer runs with unless the dispatch overrides it.' }),

  // ------------------------------------------------------------- role skills
  // Free-form standing guidance appended to a role's prompt on every dispatch —
  // conventions, house style, gotchas that shouldn't live in the shipped role
  // template. Resolved by the api and delivered to the worker via RunContext
  // (readBy:['api']); the worker never reads the org table. A dispatch may append
  // extra per-run guidance on top (see teamRoleSchema.skill).
  ROLE_SKILL_PLANNER: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Role skills', readBy: ['api'], multiline: true, description: 'Standing guidance appended to the planner’s prompt on every dispatch. Blank = none. Appended below the shipped role template; the ticket and approved plan still take precedence.' }),
  ROLE_SKILL_IMPLEMENTER: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Role skills', readBy: ['api'], multiline: true, description: 'Standing guidance appended to the implementer’s prompt on every dispatch. Blank = none. Appended below the shipped role template; the ticket and approved plan still take precedence.' }),
  ROLE_SKILL_TESTER: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Role skills', readBy: ['api'], multiline: true, description: 'Standing guidance appended to the tester’s prompt on every dispatch. Blank = none. Appended below the shipped role template; the ticket and approved plan still take precedence.' }),
  ROLE_SKILL_REVIEWER: S({ type: 'string', default: '', tiers: ['env', 'org'], group: 'Role skills', readBy: ['api'], multiline: true, description: 'Standing guidance appended to the reviewer’s prompt on every dispatch. Blank = none. Appended below the shipped role template; the ticket and approved plan still take precedence.' }),

  PIPELINE_STAGES: S({ type: 'json', default: {}, tiers: ['org'], group: 'Policy', readBy: ['api'],
    description: 'Per-stage pipeline config set in Settings ("When should it check with you?"): which stages ASF performs and whether a human approves each. Shape {"<stage>":{"enabled":bool,"gate":"required|notify|auto"}} for stages plan, implement, test, review, create_mr, merge. Empty = the standard team with all gates required. The merge stage gate (before_merge) may be relaxed here (org tier) but never from a dispatch; create_mr cannot be off while merge is on.' }),
  RUN_MAX_MINUTES: S({ type: 'number', default: 0, tiers: ['env', 'org'], group: 'Models & budget', readBy: ['registry'],
    description: 'Cancel a run once its agents have worked this many minutes in total (0 = no limit). Time spent waiting for a person (a gate, a question) does not count. Suggested: 180 when any job runs on Ollama, whose local models can grind slowly for hours; MAX_TURNS_* and SEGMENT_TIMEOUT_MS still bound each task (M11).' }),
  ORG_MAX_COST_USD: S({ type: 'number', default: 25, tiers: ['env', 'org'], group: 'Models & budget', readBy: ['api'], description: 'Hard per-run cap. A dispatch asking for more is refused with a reason.' }),
  ORG_MONTHLY_BUDGET_USD: S({ type: 'number', default: 0, tiers: ['env', 'org'], group: 'Models & budget', readBy: ['api'], description: 'Dispatch refuses once this calendar month’s summed run cost passes it. 0 = no budget.' }),
  LOOP_REPEAT_DETECT: S({ type: 'boolean', default: true, tiers: ['env'], group: 'Policy', readBy: ['registry'],
    description: 'When on (default), the orchestrator stops the reviewer↔implementer loop early if a review repeats the previous review’s blocking findings and the changes did not resolve them, parking at a needs-human checkpoint instead of burning another cycle.' }),

  // -------------------------------------------------------------------- misc
  LOG_LEVEL: S({ type: 'enum', values: ['trace', 'debug', 'info', 'warn', 'error'], default: 'info', tiers: ['env'], group: 'Misc', readBy: ['registry', 'api', 'worker'], description: 'pino log level.' }),
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;

export class SettingError extends Error {}

/** Values the org tier has stored, injected by the service that has DB access (via the registry RPC for the api). */
export type OrgValues = Partial<Record<SettingKey, unknown>>;

function coerce(key: string, def: SettingDef, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return def.default;
  switch (def.type) {
    case 'string': return String(raw);
    case 'number': { const n = Number(raw); if (Number.isNaN(n)) throw new SettingError(`${key}: expected a number, got "${raw}"`); return n; }
    case 'boolean': { const s = String(raw).toLowerCase(); if (['1', 'true', 'yes', 'on'].includes(s)) return true; if (['0', 'false', 'no', 'off'].includes(s)) return false; throw new SettingError(`${key}: expected a boolean, got "${raw}"`); }
    case 'enum': { const s = String(raw); if (!def.values!.includes(s)) throw new SettingError(`${key}: "${s}" is not one of ${def.values!.join(' | ')}`); return s; }
    case 'json': {
      let v: unknown;
      if (typeof raw === 'object') v = raw;
      else { try { v = JSON.parse(String(raw)); } catch { throw new SettingError(`${key}: expected JSON`); } }
      const problem = def.validate?.(v);
      if (problem) throw new SettingError(`${key}: ${problem}`);
      return v;
    }
  }
}

/**
 * Resolve one setting: env > org > default. A value present at a tier the key
 * does not allow is refused by name — so an operator cannot, for example, put
 * PIPELINE_STAGES in .env to bypass the org-level rule.
 */
export function resolve<K extends SettingKey>(key: K, env: NodeJS.ProcessEnv = process.env, org: OrgValues = {}): (typeof SETTINGS)[K]['default'] {
  const def = SETTINGS[key] as SettingDef;
  const fromEnv = env[key];
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!def.tiers.includes('env')) throw new SettingError(`${key} cannot be set from the environment; it is an org-level setting (edit it in the UI)`);
    return coerce(key, def, fromEnv) as never;
  }
  const fromOrg = org[key];
  if (fromOrg !== undefined && fromOrg !== null) {
    if (!def.tiers.includes('org')) throw new SettingError(`${key} cannot be set at the org level; it is deploy-time configuration`);
    return coerce(key, def, fromOrg) as never;
  }
  return def.default as never;
}

/** Resolve every key at once; throws the first problem, naming the key. */
export function resolveAll(env: NodeJS.ProcessEnv = process.env, org: OrgValues = {}): { [K in SettingKey]: (typeof SETTINGS)[K]['default'] } {
  const out = {} as { [K in SettingKey]: (typeof SETTINGS)[K]['default'] };
  for (const key of Object.keys(SETTINGS) as SettingKey[]) (out as Record<string, unknown>)[key] = resolve(key, env, org);
  return out;
}

/** Keys the org tier may set — what the settings UI may write. */
export function orgSettableKeys(): SettingKey[] {
  return (Object.keys(SETTINGS) as SettingKey[]).filter((k) => (SETTINGS[k] as SettingDef).tiers.includes('org'));
}

/** One key's catalogue metadata for the UI, with its resolved value (secrets redacted). */
export interface SettingView {
  key: string; type: SettingType; group: string; description: string;
  tiers: Tier[]; secret: boolean; values?: readonly string[];
  /** Render this string value as a textarea in the settings UI (long free text). */
  multiline?: boolean;
  orgSettable: boolean; default: unknown;
  /** The org-tier stored value, if any (secrets redacted to null). */
  orgValue: unknown;
  /** The effective resolved value (secrets redacted to null). */
  value: unknown;
  /** True when a non-empty environment variable pins this key, so env wins and the org/UI value is ignored (env > org). */
  envPinned: boolean;
  /**
   * Credential health (#139), for a secret the api checks: `ok` = the last live
   * check passed, `since` = when it started failing, `expiresAt` = set only when a
   * UI-saved token is within 30 days of (or past) its expiry.
   */
  health?: { ok: boolean; reason: string | null; since: string | null; expiresAt?: string };
}

/**
 * The catalogue rendered for the settings UI: every key, its metadata, and its
 * current org + effective value. Secret values are never sent to the browser —
 * a secret shows only whether it is set. Org-settable keys are grouped first in
 * their group so the editable surface is obvious.
 */
export function describeSettings(env: NodeJS.ProcessEnv = process.env, org: OrgValues = {}): SettingView[] {
  return (Object.keys(SETTINGS) as SettingKey[]).map((key) => {
    const d = SETTINGS[key] as SettingDef;
    const orgSettable = d.tiers.includes('org');
    let value: unknown;
    try { value = resolve(key, env, org); } catch { value = d.default; }
    const orgValue = org[key];
    // env pins the key when a non-empty env var is present (mirrors resolve()'s precedence).
    const envPinned = d.tiers.includes('env') && env[key] !== undefined && env[key] !== '';
    return {
      key, type: d.type, group: d.group, description: d.description,
      tiers: d.tiers, secret: Boolean(d.secret), values: d.values,
      multiline: d.multiline,
      orgSettable, default: d.secret ? null : d.default,
      orgValue: d.secret ? (orgValue == null ? null : '***') : orgValue ?? null,
      value: d.secret ? (value ? '***' : null) : value,
      envPinned,
    };
  });
}

/** Render .env.example from the catalogue. Deterministic; scripts/gen-config-docs.mjs writes it. */
export function renderEnvExample(): string {
  const groups = new Map<string, SettingKey[]>();
  for (const key of Object.keys(SETTINGS) as SettingKey[]) {
    const d = SETTINGS[key] as SettingDef;
    if (!d.tiers.includes('env')) continue;
    groups.set(d.group, [...(groups.get(d.group) ?? []), key]);
  }
  const lines: string[] = [
    '# Generated from packages/shared/src/settings.ts — edit that file, then `pnpm gen:config`.',
    '# Precedence: environment > org settings (UI) > default. Blank means default.',
    '#',
    '# Most keys are optional: the defaults below let the stack boot. Your tracker,',
    '# SCM and agent-auth credentials are set in the UI (Admin), not here.',
    '# For self-hosting, four values matter:',
    '#   RUN_EVENT_SECRET  — shared machine secret; must be identical in registry, api and worker (below)',
    '#   POSTGRES_PASSWORD — database password (docker-compose.self-host.yml var; defaults to asf)',
    '#   ASF_PORT          — host port the UI binds (docker-compose.self-host.yml var; defaults to 8787)',
    '#   AUTH_MODE         — who the operator is: none (single user) or header (behind Tailscale/IAP, records who dispatched)',
    '',
  ];
  for (const [group, keys] of groups) {
    lines.push(`# --- ${group} ---`);
    for (const key of keys) {
      const d = SETTINGS[key] as SettingDef;
      const dflt = d.type === 'json' ? JSON.stringify(d.default) : String(d.default);
      lines.push(`# ${d.description}${d.type === 'enum' ? ` [${d.values!.join(' | ')}]` : ''}${d.tiers.includes('org') ? ' (also editable in the UI)' : ''}`);
      lines.push(`${key}=${d.secret ? '' : dflt}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Render docs/CONFIGURATION.md from the catalogue. */
export function renderConfigDoc(): string {
  const lines: string[] = ['# Configuration', '', '*Generated from `packages/shared/src/settings.ts` — do not edit by hand; run `pnpm gen:config`.*', '',
    'Every decision is a named setting resolved **environment variable > org setting (UI) > default**. A key that lists only `org` cannot be set from the environment; a key that lists only `env` is deploy-time and has no UI.', ''];
  const groups = new Map<string, SettingKey[]>();
  for (const key of Object.keys(SETTINGS) as SettingKey[]) { const d = SETTINGS[key] as SettingDef; groups.set(d.group, [...(groups.get(d.group) ?? []), key]); }
  for (const [group, keys] of groups) {
    lines.push(`## ${group}`, '', '| Key | Type | Default | Set from | Read by | Description |', '|---|---|---|---|---|---|');
    for (const key of keys) {
      const d = SETTINGS[key] as SettingDef;
      const type = d.type === 'enum' ? d.values!.join(' \\| ') : d.type;
      const dflt = d.secret ? '*(secret)*' : d.type === 'json' ? '`' + JSON.stringify(d.default) + '`' : d.default === '' ? '*(blank)*' : '`' + String(d.default) + '`';
      lines.push(`| \`${key}\` | ${type} | ${dflt} | ${d.tiers.join(', ')} | ${d.readBy.join(', ')} | ${d.description.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Keys only the registry may hold (#9): the key that decrypts saved tokens. The
 * api and worker load the same .env in some setups (compose env_file, a host
 * worker's --env-file), so they drop these at boot — an agent spawned by the
 * worker inherits its environment and must never see them.
 */
export const REGISTRY_ONLY_ENV = ['ASF_SECRET_KEY', 'ASF_SECRET_KEY_PREVIOUS'] as const;
export function dropRegistryOnlyEnv(env: NodeJS.ProcessEnv): void {
  for (const k of REGISTRY_ONLY_ENV) delete env[k];
}
