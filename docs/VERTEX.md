# Claude on Google Cloud (Vertex AI)

Run the agents on **Claude models in your company's Google Cloud project** instead of
an Anthropic API key. Billing lands on the Google Cloud project, there is no Anthropic
key to rotate, and authentication is the Google login of the computer running the
factory (**Application Default Credentials**, "ADC"). That login is never typed into
the web page or stored by ASF.

This page takes you from a **brand-new Mac** to a factory whose first ticket runs on
Vertex. You don't need any company setup script: the steps below are everything.

> For the all-cloud GCP deployment (a worker on Cloud Run with a service account), see
> [`HOSTING.md`](HOSTING.md) instead.

## Before you start: ask your Google Cloud admin

Three things only an admin can give you. Get them first; everything else you can do
yourself.

1. **The project id** of the Google Cloud project to use (the id, like `acme-ai-prod`,
   not its display name).
2. **Claude turned on** in that project: *Vertex AI → Model Garden* → each Claude model
   you want (Opus, Sonnet, Haiku) → **Enable**. The Vertex AI API must be on too
   (`aiplatform.googleapis.com`).
3. **The "Vertex AI User" role** (`roles/aiplatform.user`) for your Google account on
   that project.

Not sure which region? Use **`global`**. It's the default, and it serves the Claude
models enabled in the project. Only pick a specific region (such as `us-east5`) if your
admin says so.

## 1. Install the tools (once per Mac)

Open **Terminal** and run these one at a time. Anything you already have is fine to skip.

```bash
# git (Apple's command line tools; a window pops up, click Install)
xcode-select --install

# Homebrew, the Mac package manager: https://brew.sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Docker Desktop and the Google Cloud CLI
brew install --cask docker-desktop gcloud-cli
```

Then **open Docker Desktop** once from Applications, accept its terms, and wait until
it says it's running.

> **If you use Rancher Desktop** instead of Docker Desktop, install it with
> `brew install --cask rancher gcloud-cli` in place of the last line above. Open Rancher
> Desktop, and in its first-run screen (or **Preferences**) set **Container Engine** to
> **dockerd (moby)**, not containerd, so the `docker` and `docker compose` commands work.
> Untick **Kubernetes** (ASF doesn't use it) and give the VM at least **6 GB** of memory
> (**Preferences → Virtual Machine**). It shares your home folder with containers, so the
> Google login in `~/.config/gcloud` reaches the worker the same way.

Check everything with:

```bash
git --version && docker compose version && gcloud --version | head -1
```

## 2. Sign in to Google (on the computer that will run the factory)

```bash
gcloud auth application-default login
```

A browser opens: sign in with your **work** Google account and allow access. This
writes `~/.config/gcloud/application_default_credentials.json`, which is how the
factory reaches Vertex. If you don't know the project id yet:

```bash
gcloud auth login            # same account; lets the next command list projects
gcloud projects list         # the PROJECT_ID column is what ASF needs
```

## 3. Install ASF

```bash
git clone https://github.com/bennybrau/agentic-software-factory.git ~/asf
cd ~/asf
./scripts/setup.sh           # press Enter for mode 1 (everything in Docker)
```

The first build takes several minutes. When it prints a URL (**http://localhost:8787**),
open it. Keep the checkout in `~/asf`, not in `~/Documents`, `~/Desktop` or
`~/Downloads`: macOS can block Docker from those.

**Mode 1 is right for Vertex.** The worker container reads your Google login through a
read-only mount of `~/.config/gcloud`, so signing in again on the Mac is picked up with
no restart. Mode 2, the worker running directly on the Mac, also works; see
[Running the worker on the Mac](#running-the-worker-on-the-mac-mode-2).

## 4. Choose Claude on Google Cloud in the setup questions

The page opens on a short questionnaire. At **Which AI should do the work?** choose
**Claude on Google Cloud**, then:

1. Type the **Google Cloud project id**, and the **region** (leave `global` unless told
   otherwise).
2. Press **Check which Claude models work**. A worker tries each Claude model on your
   project with a 1-token request (a fraction of a cent each), then runs Claude Code
   once for real on the best one. It takes up to a minute.
3. Each model shows ✓ or ✗ with the fix in plain words:

   | You see | What to do |
   |---|---|
   | No Google login found on the worker | Do step 2, then press the button again (no restart). |
   | Your Google login has expired | Run `gcloud auth application-default login` again. |
   | Not allowed to use Claude in project … | Ask the admin for **Vertex AI User** on that project. |
   | The Vertex AI API is turned off | Ask the admin to enable `aiplatform.googleapis.com`. |
   | Not enabled for this project | Ask the admin to enable that model in **Model Garden**, or untick it. If you picked a specific region, try `global`. |
   | Still waiting for a worker | The factory isn't running: `scripts/asf status`. |

4. Models that work are ticked. Untick any you don't want, then **Save**. Save is only
   possible once the check has passed.

Saving stores the project, the region and exactly the ticked models
(`ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `MODEL_ALLOWLIST`), points every job
at an allowed model, and switches the factory to Vertex. Nothing restarts. Change any of
it later in **Settings → Which AI should do the work?**, or pick which allowed model each
job uses under **Which AI model does each job?**

Finish the remaining questions (tickets, code host, approvals, spending limit) as in
[`INSTALL.md`](INSTALL.md#first-run--finish-in-the-browser), and start your first ticket
from **Things to do**.

## When the Google login expires

Company Google accounts are often made to sign in again every day or so. Every worker in
Vertex mode re-checks its login every `AGENT_AUTH_RECHECK_MS` (5 minutes by default) by
refreshing an access token. That is free: no model call. If Google says the login has
expired or was revoked (or no login is found, twice in a row):

- the worker **stops taking Claude tasks** but stays connected, and the setup checklist
  says why;
- you get **one** notification (web inbox and any notifier you set up), not one per check;
- a task that fails because of it says so in plain words.

Run `gcloud auth application-default login` on that computer. The worker notices within
about 5 minutes, checks Claude for real, and takes work again: no restart. Then press
**Retry role** on any run that failed meanwhile.

A service-account key that stops working is reported the same way, with the fix
"put a fresh key where `GOOGLE_APPLICATION_CREDENTIALS` points". Credential types the
worker can't refresh itself (workload identity federation, impersonation) are not watched:
the worker logs that once, and an expiry then shows up only as failed tasks. Bedrock is
not covered by this check.

## How it works

- **Where the login lives.** Only the worker uses your Google login, read from
  `~/.config/gcloud` (mounted read-only into the container at `/etc/asf/gcloud` in mode 1,
  override the source with `GCLOUD_CONFIG_DIR`; read directly in mode 2). On a Linux host the
  agent user must be able to read it: see
  [Agents run as their own user](SELF_HOSTING.md#agents-run-as-their-own-user). The api, the database and the web
  page never see it, and nothing is stored in Settings' encrypted secrets. That's also
  why a worker, not the api, answers **Check which Claude models work**.
- **What each run gets.** For every Claude task the worker sets
  `CLAUDE_CODE_USE_VERTEX=1`, `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (no telemetry or update checks to
  anthropic.com). Any `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or
  `ANTHROPIC_AUTH_TOKEN` in the worker's environment is removed, so a stray key can't
  move billing off Google Cloud. The reverse holds too: in API-key or subscription mode a
  `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_BEDROCK` inherited from a shell profile is
  removed, so the mode chosen in Settings always wins.
- **Models Claude Code picks by itself.** ASF passes `--model` for each job, but Claude
  Code also makes background calls and resolves the `haiku` / `sonnet` / `opus` aliases
  used by sub-agents (`.claude/agents/*.md` from the repo checkout or the worker's home).
  On Vertex those must be models your project has enabled, so ASF points
  `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` and
  `ANTHROPIC_SMALL_FAST_MODEL` at the strongest ticked model of each kind.
- **Model ids.** Vertex uses the same names as Anthropic for current models
  (`claude-sonnet-5`, `claude-opus-5-5`), plus dated ids for some
  (`claude-haiku-4-5@20251001`) and long-context variants (`claude-sonnet-5[1m]`). To
  try one that isn't listed, use **Use a model id that isn't listed** under the check
  button. The allowlist, extra models and the `[1m]` pricing rule are in
  [`CONFIGURATION.md`](CONFIGURATION.md) (`MODEL_ALLOWLIST`, `MODEL_CATALOG_EXTRA`).
- **Cost figures are estimates.** The cost per run and the spending limits
  (`ORG_MAX_COST_USD`, `ORG_MONTHLY_BUDGET_USD`) use Claude Code's estimate from token
  counts at list prices. Your Google Cloud invoice is the real number (it can differ with
  discounts or regional pricing). The limits still work as guard rails.

## Company-managed Claude Code settings

Companies can push **managed settings** to Claude Code (on a Mac:
`/Library/Application Support/ClaudeCode/managed-settings.json`), for example tool
permission rules or policy hooks. ASF adds its own hooks with `--settings`, which never
overrides a managed policy:

- **Mode 1 (Docker):** the container doesn't see the Mac's managed settings, so they
  don't apply to factory runs.
- **Mode 2 (worker on the Mac):** they **do** apply. If a run is blocked by a permission
  rule you didn't write, read that file
  (`cat "/Library/Application Support/ClaudeCode/managed-settings.json"`) and check the
  run's event log for the denied tool.

Already ran a company script that added `CLAUDE_CODE_USE_VERTEX`,
`ANTHROPIC_VERTEX_PROJECT_ID` and the like to `~/.zshrc`? That's fine, and not needed.
Docker containers and the mode 2 background service don't read `~/.zshrc`; the settings
saved in the web page are what runs use.

## Running the worker on the Mac (mode 2)

```bash
./scripts/setup.sh --mode 2
```

The database, registry and api stay in Docker; the worker runs on the Mac as a background
service that starts when you log in
([`SELF_HOSTING.md`](SELF_HOSTING.md#running-the-worker-on-the-host-hybrid-mode)). It reads
the same `~/.config/gcloud` login, and it needs Node 22+, pnpm and Claude Code on the Mac.
Pick it when runs should use the Mac's own tools or company Claude Code settings;
otherwise mode 1 is simpler.

## Setting it in `.env` instead (optional)

The web page is the normal way. To pin Vertex for every worker from the environment
instead (a value in `.env` wins over the web page, which then shows it as set by your
admin):

```bash
AGENT_AUTH_MODE=vertex
ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project-id
CLOUD_ML_REGION=global
MODEL_ALLOWLIST=claude-opus-5-5,claude-sonnet-5
```

then `scripts/asf restart`. Leaving `MODEL_ALLOWLIST` out lets jobs pick models your
project may not have enabled. A dated id such as `claude-haiku-4-5@20251001` must also be
listed in `MODEL_CATALOG_EXTRA` (the web page does that for you).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Notification "Google login on worker … stopped working"; the setup checklist says the worker can't run Claude; a task failed with "The Google login … has expired" | **ADC expired** or was revoked | Run `gcloud auth application-default login` on the computer running that worker. See [When the Google login expires](#when-the-google-login-expires). |
| The check button keeps "Waiting for a worker…" | No worker is running | `scripts/asf status`; `scripts/asf logs worker`. |
| "No Google login found" right after signing in | Signed in as a different macOS user than the one running Docker, or `GCLOUD_CONFIG_DIR` points elsewhere | Sign in as the same user that ran `setup.sh`, then check again. |
| Model-not-found / not-enabled errors | The model isn't enabled in Model Garden for that project, or not in that region | Ask the admin to enable it, untick it, or use region `global`. |
| "Vertex AI User" / permission denied | Your account lacks the role on that project | Ask the admin for `roles/aiplatform.user`. |
| Runs blocked by a permission rule you didn't set (mode 2) | Company-managed Claude Code settings | See [Company-managed Claude Code settings](#company-managed-claude-code-settings). |
| Docker build or `git clone` fails on the company network | A proxy or TLS-inspecting firewall | Not handled by ASF yet (planned); try off the company VPN, or ask IT for the proxy settings. |
