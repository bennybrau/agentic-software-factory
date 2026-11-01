# Self-hosting reference — Docker Compose

Run the whole system on one machine you own — a Mac Studio, a mini-PC, a spare Linux
box — with Docker Compose. This is the cheapest way to put the factory into daily use
(≈ $15/month in power and offsite backup; see `HOSTING.md` §9).

> **New here? Start with [`INSTALL.md`](INSTALL.md).** It walks the whole path — clone,
> `./scripts/setup.sh`, finish in the browser — and covers agent auth, the modes, and
> reaching the box from other devices (Tailscale). This page is the **compose
> reference** behind that: what the containers, volumes and ports actually are, for when
> you need to reason about the stack directly.

Every decision is a setting; this page only names the ones a self-host cares about. The
full list, with defaults and precedence, is in [`CONFIGURATION.md`](CONFIGURATION.md)
(generated from the code).

## Requirements

- A host that **never sleeps** and stays on your network: a desktop/server power
  profile, or `sudo pmset -a sleep 0 disksleep 0` on a Mac.
- Docker (Rancher Desktop / Docker Desktop / Docker Engine) with the Compose v2 plugin
  and ~10 GB free for images and worktrees.
- Not a daily-driver laptop. The worker runs arbitrary repo code and holds tracker/SCM
  tokens; give it a dedicated machine or at least a dedicated user.
- macOS: keep `WORKTREE_ROOT`/`RUN_DATA_ROOT` out of TCC-protected folders
  (`~/Documents`, `~/Desktop`, `~/Downloads`). The compose file uses named volumes,
  which avoids this.

## The compose files

| File | What it is |
|---|---|
| `docker-compose.self-host.yml` | The whole stack as containers: `postgres`, `registry`, `api`, `worker`, `backup`. `scripts/setup.sh` and `scripts/asf` drive it (compose project `asf`). |
| `docker-compose.host-worker.yml` | An overlay for **host-worker mode** — publishes the registry on `127.0.0.1:8788` and moves the container worker behind a profile so it doesn't start. |
| `docker-compose.host-gateway.yml` | Maps `host.docker.internal` to the host on native Linux Docker, so the api and worker can reach a server there (Ollama, [`OLLAMA.md`](OLLAMA.md#linux)). Layered on Linux; `ASF_HOST_GATEWAY` overrides. |
| `docker-compose.testdb.yml` | A scratch Postgres for the agents' tests ([below](#a-test-database-for-the-agents)). Layered when `.env` has `ASF_TEST_DB=1`. |

`scripts/asf` is the day-2 wrapper over the first file, so you never type a compose
command (`asf up|down|logs|status|doctor|update|backup|restore|reset|uninstall`). See
[`INSTALL.md`](INSTALL.md#day-2--the-asf-cli).

## Services, ports and volumes

| Service | Port | Notes |
|---|---|---|
| `postgres` | not published | `pgdata` volume. The only thing the registry connects to. |
| `registry` | `expose: 8788` (never published in mode 1) | Runs, tasks, gates, orchestrator, sweeper, SSE. Binds `0.0.0.0` inside the network; unreachable from the host by design. |
| `api` | `127.0.0.1:${ASF_PORT:-8787}` → `8787` | Serves the web bundle + the API on one loopback origin. Put Tailscale/Caddy in front to reach it from elsewhere ([`INSTALL.md`](INSTALL.md#reach-it-from-other-devices--tailscale)). |
| `worker` | internal `8790` | `worktrees` + `runs` volumes. Mounts the host's `~/.config/gcloud` read-only at `/etc/asf/gcloud` for Vertex ADC. Agents run as their own user (see below). `deploy.resources.limits.memory: 8g`. |
| `backup` | — | Nightly `pg_dump` into the `backups` volume, 14-day retention. |
| `testdb` | not published | Only with `ASF_TEST_DB=1`. Scratch Postgres for the agents' tests, in memory. |

**Volumes:** `pgdata`, `worktrees`, `runs`, `backups` — all named, so state survives
`down` and lives outside any TCC-protected path. Only `reset` (`down -v`) and
`uninstall` ([`INSTALL.md`](INSTALL.md#uninstall)) remove them.

## Agents run as their own user

In the worker container, the worker runs as `node` (uid 1000) and every agent it starts runs
as `agent` (uid 1001). Linux lets a process signal only processes of its own user, so an agent
command that kills by name or pattern (`pkill -f dist/index.js`, a loop over `/proc`) can't stop
the worker. Before, one did: the worker went down mid-run and the run went `stale`.

- **Files.** Both users are in the group `asfwork` (gid 1500). The worktrees and run dirs
  belong to that group, and the worker runs with umask 002, so each user can write what the
  other made. A volume from an older image is converted on the worker's first start (the log
  says `sharing worker dirs with the agent user (one-time)`). On a large volume this takes a
  few seconds, once.
- **Switching user.** The worker uses a copy of `setpriv` at
  `/usr/local/libexec/asf/as-agent` that holds the setuid/setgid capabilities. Only `node`
  can run it, and the agent starts with no capabilities, so it can't switch back.
  Cancel and timeout kill the agent's process group through the same helper.
- **The agent can't read the worker's environment** (`/proc/<worker>/environ`), so it can't
  read the worker's secrets. It gets its own credential per run, as before.
- **Vertex.** The Google login is mounted at `/etc/asf/gcloud`, and the agent reads it. With
  Docker Desktop (Mac, Windows) that works as is. On a Linux host, the file
  `gcloud auth application-default login` writes is `0600` and owned by you, so give uid 1001
  read access: `setfacl -m u:1001:r ~/.config/gcloud/application_default_credentials.json`.
- **Codex `chatgpt` mode** links the worker's `~/.codex/auth.json` into each task. Under the
  agent user, that file must be readable and writable by group `asfwork`. API-key mode is
  unaffected.
- **Check it:** `docker compose -f docker-compose.self-host.yml exec -T worker node --input-type=module - < scripts/agent-isolation-smoke.mjs`
  has an agent try those kills and prints one line per check.

A worker on the host (hybrid mode, below) doesn't set `ASF_AGENT_USER`, so its agents still
run as the worker's user.

## The settings a self-host sets

`setup.sh` generates most of these; edit `.env` to change them (`chmod 600 .env`).

| Decision | Setting | Notes |
|---|---|---|
| Shared machine secret | `RUN_EVENT_SECRET=$(openssl rand -hex 32)` | Required across containers (blank only works for a single process on one host). `setup.sh` generates it. |
| Postgres password | `POSTGRES_PASSWORD=…` | Compose wires the registry's `DATABASE_URL` from it. `setup.sh` generates it. |
| Work tracker / source control | `TICKET_PROVIDER`, `SCM_PROVIDER` | Left **blank** by `setup.sh` so the **Settings** UI owns them (chosen live, no restart). Pre-seed from the env instead if you prefer: `TICKET_PROVIDER=github` (+ `GITHUB_TOKEN`, `GITHUB_REPOS`), `jira`, or `trello`. See [`PROVIDERS.md`](PROVIDERS.md). |
| Agent auth | `AGENT_AUTH_MODE` (+ credential) | Left blank so **Settings → Which AI should do the work?** owns it (API key, subscription token, or Claude on Google Cloud). Export a mode + credential in the launching shell to hard-pin the fleet (env wins over the UI). Vertex: [`VERTEX.md`](VERTEX.md). |
| Who is the operator | `AUTH_MODE`, `AUTH_HEADER` | `none` for one person; `header` + `AUTH_HEADER=Tailscale-User-Login` when serving through Tailscale so runs record who dispatched them. |
| Cost guardrails | `ORG_MAX_COST_USD`, `ORG_MONTHLY_BUDGET_USD` | Also editable later in the UI. |

Everything else has a working default. Full list: [`CONFIGURATION.md`](CONFIGURATION.md).

### Secrets from the shell, not `.env`

Secrets do not have to be in `.env` at all: `scripts/asf up` (compose) passes
`GITHUB_TOKEN` (from `gh auth token`), `JIRA_API_TOKEN` and `ANTHROPIC_API_KEY` from
the shell that runs it (e.g. exported in `~/.zshrc`) straight into the containers. A
blank value in `.env` falls through to the shell's. Two `.env` gotchas: compose does
not strip inline `# comments` (`WORKTREE_ROOT=  # default` becomes a literal value),
and `chmod 600 .env`.

A hardened deploy can instead keep `SECRETS_SOURCE=file` (Docker secrets) and set the
tokens at the env tier; env wins over the UI-set org tier.

### White-label: configure the tracker in the UI

For a packaged deploy, ship with `TICKET_PROVIDER` blank/`mock` and configure the real
tracker after boot, in the browser: open **Settings**, pick Jira / GitHub / Trello,
enter its config and credentials, and click **Test connection**. The credential is
stored write-only (a `secret://org/<KEY>` pointer in `org_setting`, the bytes in a
separate `org_secret` sink, encrypted at rest with `ASF_SECRET_KEY`) and never echoed back; the switch takes effect on the next
request with no restart. Full mechanics and the `TicketProvider` contract are in
[`PROVIDERS.md`](PROVIDERS.md).

## A test database for the agents

If your repository has tests that need Postgres, they can't run inside the worker as
shipped: there is no database there, so they skip. A skipped test proves nothing. The
tester says so in its report (`Verified: no — …`), and the reviewer escalates to you
instead of approving. Give the agents a database to make those tests run:

1. Add `ASF_TEST_DB=1` to `.env`.
2. Run `asf up`.

That starts `testdb` (`docker-compose.testdb.yml`), a Postgres 16 with the pgvector
extension available (`create extension vector`) on the compose network, and gives the worker its URL as `TEST_DATABASE_URL` and `DATABASE_TEST_URL`.
`asf doctor` lists it under Containers.

- **It's scratch.** The data lives in memory and is gone when the container restarts.
  Every run shares it, so suites should make their own schema or database (most do).
- **Only the containers can reach it.** It isn't published to the host, so in host-worker
  mode (`ASF_MODE=2`) `ASF_TEST_DB` is ignored. Give that worker a database of your own:
  set `DATABASE_TEST_URL` (or `TEST_DATABASE_URL`) and `ASF_TEST_DB_ACTIVE=1` in its
  environment so the agents are told it's there.
- **Another variable name?** If your tests read a different variable, add it under
  `worker.environment` in a compose override of your own.

`setup.sh --force` keeps the setting. To turn it off, set `ASF_TEST_DB=0`, then `asf down`
and `asf up`.

## Verifying a running stack

What "healthy" looks like in the logs:
- registry: `migrations … total: N`, `Server listening`
- api: `preflight ok` for the ticket and SCM providers (a bad token **fails the
  container**, on purpose)
- worker: `agent auth ok { … }` then `registered; polling for tasks`

Acceptance test — the same script used in development, against the running stack:

```bash
docker run --rm --network asf_default -v "$PWD/scripts:/s:ro" \
  -e RUN_EVENT_SECRET=<your secret> -e API_URL=http://api:8787 -e REGISTRY_URL=http://registry:8788 \
  node:22-slim node /s/m3-smoke.mjs
```

It runs inside the compose network (the registry is deliberately not published to the
host) and drives a full run — dispatch, plan gate, approve with an edit, publish, merge
gate — ending in `FINAL: state=succeeded`. Stop the real worker first
(`docker compose -f docker-compose.self-host.yml stop worker`) so it doesn't claim the
smoke's tasks.

## Running the worker on the host (hybrid mode)

By default every service, the worker included, runs in a container. **Host-worker
(hybrid) mode** keeps Postgres, the registry and the api in containers but runs the
*worker on this machine*, supervised across reboots. Reach for it when the agent needs
a credential that only exists on the host:

- **Interactive Claude login.** `claude login` (or `claude setup-token`) writes
  credentials into the host's home directory. A container worker can't do that browser
  flow; a host worker inherits the login you already did on this machine — no token to
  paste into Settings.
- **Company-managed Claude Code settings or host tools.** A host worker runs under the
  Mac's own Claude Code policy and tools. (Google ADC for Vertex does *not* need this
  mode: the container worker reads `~/.config/gcloud` through a read-only mount (at `/etc/asf/gcloud`).
  See [`VERTEX.md`](VERTEX.md).)

Everything else — cost halts, gates, the pipeline — is identical to the all-container
path.

### Enable it

```bash
scripts/setup.sh --mode 2
```

Mode 2:
- brings up Postgres/registry/api with `docker-compose.host-worker.yml` layered on,
  which **publishes the registry on `127.0.0.1:8788`** (loopback only — the registry
  has no auth of its own) so the host worker can reach it, and **disables the container
  worker** (moved behind a compose profile);
- writes `~/.asf/worker.env` (the worker's `PATH`, `WORKTREE_ROOT=~/.asf/worktrees`,
  `RUN_DATA_ROOT=~/.asf/runs`) — this is the *only* file the worker sources, never your
  `~/.zshrc`;
- installs and loads a supervisor: a launchd LaunchAgent
  (`~/Library/LaunchAgents/com.asf.worker.plist`) on macOS, or a systemd `--user`
  service (`~/.config/systemd/user/asf-worker.service`, with `enable-linger` so it
  survives logout) on Linux. Both `RunAtLoad`/`Restart=always` and log to
  `~/.asf/logs/worker.log`.

The worker's agent auth is now host-side: run `claude login` (or `claude setup-token`),
or sign in to Google for Vertex (`gcloud auth application-default login`; the project and
models are still chosen in Settings → Which AI should do the work?). You do **not** paste
a Claude credential in Settings for this mode. A host `claude login` is your own subscription: keep it to
your own use, and switch to an API key or Vertex if other people use the factory
([`CLAUDE_USAGE.md`](CLAUDE_USAGE.md)).

> **Login, not boot.** The launch agent starts at **login**, not at boot: after a
> reboot, log in once (or enable auto-login) for the worker to come back. On a Mac, keep
> it awake so runs aren't missed: `sudo pmset -a sleep 0`.

### Manage it

```bash
scripts/host-worker.sh up | down | status | logs [-f]   # the supervisor directly
scripts/asf up | down | logs worker | status worker      # routed to it in mode 2
scripts/asf doctor                                        # checks the launch agent is loaded + the worker registered
```

## Keep it alive

| Concern | What to do |
|---|---|
| Restarts | Every service is `restart: unless-stopped`; Docker starts them on boot. Make Docker itself start at login/boot. |
| Backups | The `backup` container writes a nightly `pg_dump` to the `backups` volume (14-day retention). Sync it offsite: `docker run --rm -v asf_backups:/b -v ~/.config/rclone:/config/rclone rclone/rclone sync /b b2:asf-backups` from cron. **Test a restore once** (`asf restore`). See [`UPGRADING.md`](UPGRADING.md). |
| Updates | `scripts/asf update` (pull pinned images) or `asf update --from-source`. Migrations are additive and apply at registry boot. On the compose stack a newer release can also be applied from the UI: the `supervisor` sidecar, which holds the Docker socket to start a stopped worker, also runs a one-off `docker:cli` updater that pins `ASF_VERSION` in `.env` and runs `compose pull && up -d`. It is refused while a task is running. See [`UPGRADING.md`](UPGRADING.md#applying-an-update-from-the-ui). |
| Disk | Worktrees accumulate in the `worktrees` volume (they are the evidence for failed runs). Prune terminal runs older than a week: `docker compose exec worker sh -c 'find /data/worktrees/runs -maxdepth 1 -mtime +7 -exec rm -rf {} +'`. |
| A run stuck `queued` | The worker is not registered: `asf logs worker`. Almost always the agent auth preflight (no credential in Settings → "Which AI should do the work?", an expired/revoked subscription token, or a bad key) or the host went to sleep. |
| Secrets | `.env` is the secret store. `chmod 600 .env`, never commit it. For a machine several people administer, use `SECRETS_SOURCE=file` with Docker secrets instead. |

## Moving to the cloud later

Nothing changes in the application: the same images, the same settings. `HOSTING.md` is
the GCP runbook; the self-host `.env` maps 1:1 onto Secret Manager entries and Cloud Run
env vars. A hybrid — managed registry/api/Postgres in the cloud, the worker on this box
over Tailscale — is also just `REGISTRY_URL`/`BFF_URL` pointing at the cloud.
