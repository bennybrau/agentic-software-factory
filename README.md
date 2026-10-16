# Agentic Software Factory

[![ci](https://github.com/bennybrau/agentic-software-factory/actions/workflows/ci.yml/badge.svg)](https://github.com/bennybrau/agentic-software-factory/actions/workflows/ci.yml)
[![install-e2e](https://github.com/bennybrau/agentic-software-factory/actions/workflows/install-e2e.yml/badge.svg)](https://github.com/bennybrau/agentic-software-factory/actions/workflows/install-e2e.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Pick a ticket from your work tracker, spawn a small agent team (planner → implementer → tester → reviewer) under a deterministic orchestrator, and get a pull/merge request back — with a human at every gate you choose to keep.

**What you get:** a self-hosted web app where you browse your backlog, send a ticket to an agent team, and watch the run live: team timeline, event log, cost meter, and gate cards where you approve, edit or reject each step. A plain TypeScript orchestrator (not an LLM) runs every stage: gates after each role (`required` stops, `notify` continues, `auto` skips), a reviewer `REQUEST_CHANGES` loop back to the implementer (bounded), and a publish phase (push → draft PR → merge) behind a `before_merge` gate that only an explicit org setting can relax.

- **Trackers:** Jira, GitHub Issues, Trello, plus ad-hoc tasks typed into the UI
- **Source control:** GitHub, GitLab
- **Agents:** Claude Code (subscription, API key, Vertex AI, Bedrock), OpenAI Codex, OpenCode and GitHub Copilot CLI, chosen per role
- **Operations:** a queue, a Today view, needs-human notifications (web inbox, Telegram), cost caps, one-command install, published multi-arch images

> **Status:** pre-1.0 and moving fast. It's used daily, but settings and APIs can still change between minor versions. See [CHANGELOG.md](CHANGELOG.md).

## Install

Self-host it with Docker Compose (Postgres + registry + api + worker + web) — clone,
run one script, open the URL:

```bash
git clone https://github.com/bennybrau/agentic-software-factory.git
cd agentic-software-factory
./scripts/setup.sh            # preflight → generate .env → build & start → print the URL
# open http://localhost:8787  (ASF_PORT), then /setup finishes the rest in the browser
```

Full walkthrough (modes, agent auth, Tailscale, day-2 `asf` CLI): [`docs/INSTALL.md`](docs/INSTALL.md).
Which Claude credential to use, and why a subscription is for personal use only: [`docs/CLAUDE_USAGE.md`](docs/CLAUDE_USAGE.md).
Compose reference: [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md). Upgrades & backups: [`docs/UPGRADING.md`](docs/UPGRADING.md).

```
┌────────────┐  HTTP/SSE  ┌────────────────┐        ┌──────────────────────┐
│  apps/web  │◀──────────▶│   apps/api     │───────▶│ TicketProvider       │ jira | github | trello | adhoc
│ Today/Queue│            │ providers +    │───────▶│ ScmProvider          │ gitlab | github
│ Run/Team   │            │ notifications  │───────▶│ NotificationSink     │ web | telegram
└────────────┘            └───────┬────────┘        └──────────────────────┘
                                  │ RPC/SSE
                          ┌───────┴────────┐        ┌──────────────────────┐
                          │ apps/registry  │◀───────│  apps/worker (N)     │
                          │ runs, tasks,   │  claim │  one role task,      │
                          │ orchestrator,  │        │  one AgentRuntime,   │
                          │ Postgres       │        │  one process, exit   │
                          └────────────────┘        └──────────────────────┘
```

## Layout

```
packages/shared/      Zod schemas + the four provider interfaces. The contract everything imports.
  ticket.ts           Ticket, TicketProvider
  scm.ts              Repo, ChangeRequest, ScmProvider, FORBIDDEN_BRANCHES
  team.ts             Role, TeamTemplate, gates (required | notify | auto), STANDARD_TEAM
  run.ts              Run, RunTask, RunEvent, states
  runtime.ts          AgentRuntime, AgentSpawn, AgentOutcome
  notification.ts     NotificationSink
  settings.ts         Every decision as a named setting; .env.example + docs/CONFIGURATION.md generated from it
apps/api/             Fastify. Holds credentials. providers/tickets/*, providers/scm/*. No DB.
apps/registry/        Fastify + Postgres. Runs, tasks, gates, workers, orchestrator, sweeper, SSE fan-out.
apps/worker/          Claims a task, runs a role via runtimes/*, reports events, exits.
apps/web/             Vite + React. Today, Things to do (backlog), Work history (runs), Settings.
prompts/roles/        planner.md, implementer.md, tester.md, reviewer.md — shipped here, not discovered from a laptop.
db/migrations/        Additive SQL, applied by the registry.
docs/plan.md          Architecture & extraction plan (the why).
docs/IMPLEMENTATION_PLAN.md  Milestones, work packages, done-when (the how).
docs/PIPELINE.md      The run lifecycle: roles, gates, review loop, publish.
docs/PROVIDERS.md     The four provider interfaces and how to add one.
docs/CONFIGURATION.md Every setting, generated from the code (`pnpm gen:config`).
docs/INSTALL.md       The single "how do I run this" page: clone, setup.sh, finish in the browser.
docs/SELF_HOSTING.md  Compose reference: the containers, volumes, ports, and host-worker mode.
docs/UPGRADING.md     asf update, additive migrations, pinning ASF_VERSION, restore from backup.
docs/CLAUDE_USAGE.md  Which Claude credential to use; Anthropic's terms in plain words.
docs/VERTEX.md        Claude Code on Vertex AI (GCP project + host ADC).
docs/OLLAMA.md        Free models: a local Ollama server or Ollama Cloud, mixed into a team.
docs/HOSTING.md       Running it on GCP (Cloud Run + Cloud SQL + IAP + Vertex); infra runbook.
```

## Rules that must stay true

- No credential reaches the browser; no ticket/SCM credential reaches the registry or an agent.
- Only the registry connects to Postgres.
- The orchestrator is plain TypeScript. An LLM never decides what a state becomes.
- One task = one process; nothing is held across a gate.
- Gates are configurable, but `before_merge` defaults to `required` and can only be relaxed by an explicit, visible project-level setting.
- Refuse with a reason rather than guess. Never push to a forbidden branch.
- Providers are loaded from one factory each (`providers/*/index.ts`, `runtimes/index.ts`); nothing else imports a concrete provider.
- Every decision is a named setting in `packages/shared/src/settings.ts`, resolved env > org (UI) > default; `.env.example` and `docs/CONFIGURATION.md` are generated from it and CI fails if they drift.

## Developing

```bash
pnpm install
pnpm --filter @asf/shared build
cp .env.example .env
pnpm db:up                     # Postgres in Docker (role asf/asf, databases asf + asf_test)
pnpm test                      # registry tests need DATABASE_TEST_URL (default asf_test); they skip without it
pnpm dev                       # registry :8788 -> api :8787 -> one worker, waited on in turn (node scripts/dev.mjs)
pnpm dev:mock                  # registry + api only, no agent spend (--no-worker)
pnpm dev:web                   # :3999
```

Regenerate `.env.example` and `docs/CONFIGURATION.md` after editing the settings catalogue with `pnpm gen:config` (CI runs `pnpm gen:config:check`).

## Roadmap

[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) records how it was built, milestone by milestone. Open work is tracked in [issues](https://github.com/bennybrau/agentic-software-factory/issues) and [milestones](https://github.com/bennybrau/agentic-software-factory/milestones).

## Contributing

Contributions are welcome: bug reports, docs, new ticket/SCM providers, new agent runtimes. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately per [SECURITY.md](SECURITY.md). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Jon Arme. Third-party notices are in [NOTICE](NOTICE). The worker image installs the Claude Code and Codex CLIs, which have their own terms. You bring your own agent account or API key. See [Using Claude responsibly](docs/CLAUDE_USAGE.md).
