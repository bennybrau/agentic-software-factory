# Install ASF

[![install-e2e](https://github.com/bennybrau/agentic-software-factory/actions/workflows/install-e2e.yml/badge.svg)](https://github.com/bennybrau/agentic-software-factory/actions/workflows/install-e2e.yml)

The single "how do I run this" page. Clone, run one script, open a URL — the script
generates `.env`, brings the stack up, and hands you off to an in-browser checklist
for the parts a script can't do (choosing your real tracker and pasting an agent
credential).

For the compose internals (volumes, ports, backups) see [`SELF_HOSTING.md`](SELF_HOSTING.md);
for the GCP runbook see [`HOSTING.md`](HOSTING.md).

## Requirements

- A host that **stays on** and on your network — a desktop/server, a mini-PC, or a
  Mac kept awake (`sudo pmset -a sleep 0`). **Not a daily-driver laptop**: the worker
  runs arbitrary repo code and holds tracker/SCM tokens; give it a dedicated machine
  or at least a dedicated user.
- **Docker** (Docker Desktop / Rancher Desktop / Docker Engine) with the Compose v2
  plugin (`docker compose`, not `docker-compose`) and ~10 GB free for images and
  worktrees.
- **git**.
- Starting from a brand-new Mac (no Homebrew, Docker or git yet)? [`VERTEX.md` step 1](VERTEX.md#1-install-the-tools-once-per-mac)
  lists the exact install commands; skip the Google Cloud CLI if you won't use Vertex.
- macOS only: keep the checkout out of privacy-protected folders (`~/Documents`,
  `~/Desktop`, `~/Downloads`) — Docker can be denied file access there. `~/asf` or
  `~/src/` is fine. (The stack uses named volumes, so this only affects the checkout.)
- Modes 2 and 3 (below) also need **Node ≥ 22** and **pnpm** on the host.

## Install in 3 commands

```bash
git clone https://github.com/bennybrau/agentic-software-factory.git
cd agentic-software-factory
./scripts/setup.sh          # preflight → generate .env → build & start → print the URL
```

Then open the URL it prints (**http://localhost:8787** by default) and follow the
first-run checklist at **/setup**.

Or, from nothing, in one line — clones into `~/asf` and runs `setup.sh`:

```bash
curl -fsSL https://raw.githubusercontent.com/bennybrau/agentic-software-factory/main/scripts/install.sh | bash
```

`install.sh` only checks `git`, clones (or fast-forwards) the repo into
`${ASF_HOME:-$HOME/asf}` at `${ASF_VERSION:-main}`, prints the path, and execs
`scripts/setup.sh` — pass setup flags straight through:
`… | bash -s -- --mode 2`.

## What setup asks, and why

`setup.sh` is idempotent (re-run it to reconcile) and never clobbers an existing
`.env` without `--force`. It:

- **Preflights** git, Docker + the daemon, Compose v2, ≥ 10 GB free disk, and a way to
  generate secrets — and stops with a fix if any fails, before touching anything.
- **Asks which mode** (1 / 2 / 3, below). Non-interactive: `ASF_MODE=1 ./scripts/setup.sh --non-interactive`.
- **Generates `.env`** (`chmod 600`): a random `RUN_EVENT_SECRET` (the shared
  cross-container secret), `POSTGRES_PASSWORD`, and `ASF_SECRET_KEY` (encrypts the
  tokens you save in Settings; back `.env` up apart from database backups), `AUTH_MODE=none`, and the port. It
  leaves `TICKET_PROVIDER`, `SCM_PROVIDER` and `AGENT_AUTH_MODE` **blank on purpose**
  so the UI owns them — you pick your real tracker and paste an agent credential in the
  browser, no restart.
- **Builds and starts** the stack, waits for each service to become healthy, and
  prints the URL.

Flags worth knowing: `--no-up` (generate `.env` + preflight, start nothing),
`--force` (regenerate `.env`), `--mode N`. Full list: `./scripts/setup.sh --help`.

## First run — finish in the browser

Open the web UI. A fresh factory lands on **/setup**, a short questionnaire (one
question per screen, plain language, no setting names):

1. **Where do your tickets live?** GitHub, Jira, Trello, or sample tickets. Enter the
   connection details and **Save and check it works** (a live test that shows who you
   connected as). GitHub tickets also set GitHub as your code host; otherwise you're
   asked **Where does your code live?** (GitHub or GitLab). See [`PROVIDERS.md`](PROVIDERS.md).
2. **Which AI should do the work?**
   - **Claude API key** (recommended): paste an Anthropic API key. Metered, with a real
     cost figure per run, and fine for a factory several people use.
   - **Claude subscription**: your **own** Pro/Max plan, for your personal use. On any
     machine with a browser run `claude setup-token`, approve, and paste the token.
     Billed to your plan, no per-run cost figure, valid ~a year, and **no Claude login
     needed on the worker host**. Anthropic's terms don't allow one subscription to be
     shared by several people. See [`CLAUDE_USAGE.md`](CLAUDE_USAGE.md).
     ```bash
     claude setup-token
     ```
   - **Claude on Google Cloud** (Vertex AI): your company's Google Cloud project, billed
     to Google Cloud. Sign in once on the host with `gcloud auth application-default login`,
     type the project id, and press **Check which Claude models work**; a worker tries each
     model and you keep the ones that answer. Works in mode 1. Fresh-Mac walkthrough:
     [`VERTEX.md`](VERTEX.md).
   - **Bedrock**: set in `.env` only.
   - **Free models with Ollama** (later, in **Settings**): a model on your own machine or on
     Ollama Cloud, for any job in the team, next to Claude. See [`OLLAMA.md`](OLLAMA.md).
3. **When should it check with you?** Three presets, or step by step. See [`PIPELINE.md`](PIPELINE.md).
4. **How much can it spend?** A per-ticket and monthly limit.

The last screen waits for a **worker** to come online (mode 1 starts one for you), then
sends you to **Things to do** to start work on your first ticket. Every answer can be changed
later in **Settings**; each question's ⓘ shows the `.env` names it maps to, and a
value set in `.env` wins over the UI (the question then shows as set by your admin).

Setup has no nav item. If you leave it early (**I’ll do this later**), Today and Settings
show a **Setup isn’t finished** notice that names what’s missing, with a **Continue setup**
button. To walk through it again any time, use **Settings → Guided setup**. It starts
from your current answers.

## Day 2 — the `asf` CLI

`scripts/asf` wraps the compose stack so you never type a compose command:

```bash
scripts/asf status        # what's running
scripts/asf doctor        # read-only health table (✓/✗/⚠) — start here when something's off
scripts/asf logs -f       # follow logs (or: asf logs worker)
scripts/asf update        # pull pinned images and restart, wait healthy (--from-source to rebuild)
scripts/asf backup        # immediate pg_dump into the backups volume and ./backups
scripts/asf secret-key    # older installs: encrypt saved tokens (--rotate for a new key)
scripts/asf open          # open the UI in a browser
```

More in [`UPGRADING.md`](UPGRADING.md) (updates, backups, restore) and
[`SELF_HOSTING.md`](SELF_HOSTING.md).

## Modes — which to pick

`setup.sh --mode N` (default 1):

| Mode | What runs where | Pick it when |
|---|---|---|
| **1 — containers** | Everything (Postgres, registry, api, worker) in Docker. | The default. You want the whole factory in containers and agent auth via the UI (API key, subscription token, or Claude on Google Cloud: the host's `~/.config/gcloud` is mounted read-only into the worker). |
| **2 — host-worker** | Postgres/registry/api in containers; the **worker on this machine**, supervised across reboots (launchd / systemd `--user`). | The agent needs something only the host has: an interactive `claude login`, the host's own tools, or company-managed Claude Code settings ([`VERTEX.md`](VERTEX.md#company-managed-claude-code-settings)). |
| **3 — dev** | Postgres in Docker; the apps on the host via `pnpm dev`. | You're developing ASF itself. Needs Node ≥ 22 + pnpm. |

## Reach it from other devices — Tailscale

The api binds `127.0.0.1` only. To use it from your laptop, phone, or a teammate's
machine without opening a router port:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

If something already owns `:443` (a k3s/Traefik forward, say), pick another:
`--https=8443` gives `https://<host>.<tailnet>.ts.net:8443`. HTTPS certificates must be
enabled once in the Tailscale admin console (DNS → HTTPS Certificates), or `serve`
hangs waiting for a cert. The config persists across reboots.

Now `https://<host>.<tailnet>.ts.net` is the factory, with TLS, reachable only from
your tailnet. `tailscale serve` also forwards the caller's identity in the
`Tailscale-User-Login` header — set `AUTH_MODE=header` + `AUTH_HEADER=Tailscale-User-Login`
in `.env` to record who dispatched each run.

Without Tailscale: Caddy on the host with `reverse_proxy 127.0.0.1:8787` and a real
domain, with basic auth or an OAuth proxy in front — nothing in the app authenticates
by itself.

## Uninstall

```bash
scripts/asf reset --yes     # DESTROYS all data: pgdata, worktrees, runs, backups (double-confirmed)
```

Then remove the checkout. Mode 2 also wrote a supervisor unit
(`~/Library/LaunchAgents/com.asf.worker.plist` on macOS, or
`~/.config/systemd/user/asf-worker.service` on Linux) and `~/.asf/` — remove those to
fully clean up the host worker.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `setup.sh` stops in preflight | Docker daemon down, no Compose v2, < 10 GB disk, or no git | Read the ✗ line — it names the fix. Start Docker / install the Compose v2 plugin / free space, then re-run. |
| Port already in use | Another process (or an existing ASF) holds `ASF_PORT` | Pick another port when prompted, or set `ASF_PORT` in `.env` and `asf restart`. |
| UI loads but a run stays `queued` | No worker registered | `asf logs worker` — usually agent auth isn't set (paste a credential in **Settings → Which AI should do the work?**) or the host slept. |
| "No worker connected" / auth-mode mismatch | Worker up but authenticating as a different mode than the org setting | `asf doctor` shows the modes; align **Settings → Which AI should do the work?** with the worker. |
| "Google login on worker … stopped working" | Host ADC expired (Claude on Google Cloud) | Re-run `gcloud auth application-default login` on the host; the worker resumes by itself within ~5 minutes. See [`VERTEX.md`](VERTEX.md#when-the-google-login-expires). |
| A bad tracker/SCM token fails the api container | Preflight rejects the credential on purpose | Fix the credential in **Settings** and **Save and check it works**; the api restarts clean. |
| Everything looks wrong and you're not sure where | — | `asf doctor` — a read-only ✓/✗/⚠ table across host, `.env`, containers, providers, fleet, and storage. |
