# Contributing to Agentic Software Factory

Thanks for helping. This page covers how to get a dev environment running, what CI
checks, and how pull requests are reviewed and merged.

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE), and you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug or ask for a feature** with the [issue templates](https://github.com/bennybrau/agentic-software-factory/issues/new/choose).
- **Report a security problem privately.** See [SECURITY.md](SECURITY.md). Don't open a public issue for it.
- **Pick up an issue.** Issues labelled `good first issue` are small and self-contained.
  Comment on an issue before starting anything large, so two people don't build the same thing.
- **Add a provider or runtime.** A ticket tracker, an SCM host, a notification sink or a
  coding-agent runtime is one new file behind an existing interface. See
  [docs/PROVIDERS.md](docs/PROVIDERS.md) and [docs/RUNTIMES.md](docs/RUNTIMES.md).

## Dev setup

You need **Node ≥ 22**, **pnpm 11** (`corepack enable` picks the pinned version from
`package.json`), **Docker** (for Postgres) and **git ≥ 2.42**.

```bash
pnpm install
pnpm --filter @asf/shared build   # ALWAYS build shared first; every app imports its dist/
cp .env.example .env              # set RUN_EVENT_SECRET to any random hex string
pnpm db:up                        # Postgres in Docker (asf/asf, databases asf + asf_test)

pnpm dev:mock                     # registry :8788 + api :8787, mock tracker + mock SCM, no agent spend
pnpm dev:web                      # web UI on :3999 (proxies /api to :8787)
pnpm dev                          # adds one worker: real agent runs, real token spend
```

`pnpm dev:mock` is all most changes need. It uses the built-in **mock** ticket
tracker and **mock** SCM, so you don't need GitHub, Jira or an AI provider account.
You only need agent credentials (Claude Code subscription token, Anthropic or OpenAI
API key) to run the worker against a real model.

Rebuild shared (`pnpm --filter @asf/shared build`) after every change in
`packages/shared/src`, and after switching branches. Its `dist/` is gitignored and
stale types there cause confusing errors in every app.

## Before you open a PR

CI (`.github/workflows/ci.yml`) runs these. Run them locally first:

```bash
pnpm --filter @asf/shared build
pnpm typecheck          # ALL five projects, test files included
pnpm lint
pnpm test               # registry tests need Postgres (pnpm db:up); they skip without DATABASE_TEST_URL
pnpm gen:config:check   # .env.example + docs/CONFIGURATION.md must match the settings catalogue
```

- **Changing the shape of a type in `packages/shared`** affects every app's test
  fixtures, so typecheck all of them, not only the app you touched.
- **Added or changed a setting?** Edit `packages/shared/src/settings.ts`, run
  `pnpm gen:config`, and map the key to a Settings question in
  `packages/shared/src/setup-questions.ts`, or add it to `UI_ENV_ONLY` with a reason.
  A test fails if an org-settable key is unmapped.
- **Web code** imports shared runtime code from `@asf/shared/ui` (browser-safe), never
  the `@asf/shared` barrel. For web changes also run the bundle build:
  `pnpm --filter @asf/web build`.
- **New icons** have to be in the vendored font subset (see `apps/web/src/assets/README.md`).
- **DB migrations** are additive: add a new numbered file in `db/migrations/` and never
  edit one that has shipped. Don't put a semicolon inside a `--` comment.

## Rules the code must keep

These are architectural guarantees. CI enforces several of them. A PR that breaks one
needs a very good reason, discussed in an issue first.

- No credential reaches the browser. No ticket/SCM credential reaches the registry or an agent.
- Agent runtime code (`apps/worker/src/runtimes/`) never reads a token/secret from the
  environment. Credential env names live only under `apps/worker/src/auth/`.
- Only the registry connects to Postgres.
- The orchestrator is plain, deterministic TypeScript. An LLM never decides a run's state.
- One task = one process. Nothing is held across a human gate.
- `before_merge` defaults to `required` and can be relaxed only by an explicit org-level setting.
- Every operator decision is a named setting, resolved env > org (UI) > default.

## Pull requests

- **One change per PR**, on its own branch off `main`. Keep unrelated cleanups out.
- **Conventional Commit titles** (`feat: …`, `fix: …`, `docs: …`, `chore: …`; `!` for
  breaking changes). PRs are **squash-merged**, and the PR title becomes the commit
  on `main`. That title drives the automatic version bump and release
  (`scripts/next-version.sh`), so it matters.
- **Linear history.** Rebase onto `main` to pick up changes. Don't merge `main` into your branch.
- Put `Closes #123` in the PR body so the issue closes on merge.
- Add or update tests with the change. For UI changes, include a screenshot.
- Update docs (`docs/`, `CHANGELOG.md` under `[Unreleased]`) when behaviour changes.

## Project layout

See the [README](README.md#layout) for the map, [docs/plan.md](docs/plan.md) for the
architecture and the reasoning behind it, and [docs/PIPELINE.md](docs/PIPELINE.md) for
the run lifecycle.
