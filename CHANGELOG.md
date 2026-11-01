# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Every merge to main
publishes a `vX.Y.Z` release of the GHCR images
(`ghcr.io/rag-against-the-machine/asf-*`); see [`docs/UPGRADING.md`](docs/UPGRADING.md).

## [Unreleased]

### Fixed
- **An agent can no longer kill the worker.** In the worker container, agents now run as their
  own user (`agent`, uid 1001) instead of the worker's (`node`), and Linux only lets a process
  signal its own user's processes. Before, an implementer stopping its own test server with a
  kill-by-name loop also matched the worker (`node apps/worker/dist/index.js`); the worker
  shut down and the run went `stale`. The agent also can't read the worker's environment any
  more. Cancel and timeout still kill the agent's whole process group. Existing worktree and
  run volumes are shared with the agent user on the first start, once. **Vertex on a Linux
  host:** give uid 1001 read access to your Google login
  (`setfacl -m u:1001:r ~/.config/gcloud/application_default_credentials.json`); it's now
  mounted at `/etc/asf/gcloud`. See
  [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#agents-run-as-their-own-user). A worker on the
  host (hybrid mode) is unchanged.
- **The agents' test database has pgvector.** `testdb` (`ASF_TEST_DB=1`) now runs
  `pgvector/pgvector:pg16` instead of `postgres:16-alpine`, so repos whose migrations run
  `create extension vector` can run their database tests. Before, every such test run
  failed at the first migration, the tester reported `Verified: no`, and the reviewer
  escalated work that was fine. Run `asf up` to pick it up (the database is scratch, so
  nothing is lost).
- **The worker image ships `pdftotext`.** `poppler-utils` is now installed next to git,
  so a target repo whose code or tests extract PDF text (`pdftotext`, `pdfinfo`) can run
  them in the tester's run instead of failing on a missing binary. Adds about 10 MB.

### Added
- **The worker image ships Python and uv.** `python3` (Debian's 3.13) and a pinned `uv`
  (0.11.26) are installed, so Python target repos can install and run their tests
  (`uv sync`, `uv run pytest`, or plain `python3`). uv fetches another Python version on
  first use when a repo pins one. Adds about 36 MB.
- **Saved tokens are encrypted at rest** (#9). Tokens entered in Settings (`org_secret`)
  are stored as AES-256-GCM envelopes under a new registry-only `ASF_SECRET_KEY`, the
  row name bound as authenticated data. `setup.sh` generates the key; existing installs
  run `asf secret-key` once and the registry encrypts the plaintext rows at boot,
  keeping each token's saved date. `asf secret-key --rotate` rotates the key via
  `ASF_SECRET_KEY_PREVIOUS`. `asf doctor` reports plaintext / encrypted / key-mismatch,
  `asf backup` reminds you to back the key up apart from the dumps, and `asf restore`
  checks a dump's key before replacing anything. A missing or wrong key is a loud,
  specific error, never an "unset" token. The api and worker drop the key at boot so
  agents never inherit it.

## [1.0.0] - 2026-10-11

First public release, under the MIT license. Everything below shipped before the
repository went public (earlier versions were published as private v0.x images).

### Added
- Open-source release under the MIT license: `LICENSE`, `NOTICE`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue/PR templates, CODEOWNERS and Dependabot.
- `docs/CLAUDE_USAGE.md`: which Claude credential to use under Anthropic's terms. Settings
  now recommends a Claude API key, labels a subscription as personal use, and warns (in
  Settings, `/api/setup/status` and `asf doctor`) when a subscription token serves a
  multi-operator factory (`AUTH_MODE=header`).
- Themes (M12): the agent crew gets names, pictures, lines and an accent colour.
  Two built-ins: **classic** (the default) and **hive** (The Queen, Scout,
  Builder, Guard, Inspector). Custom themes upload as a zip. Pick one in
  Settings → "How should the factory look?" or set `THEME`. See
  [`docs/THEMES.md`](docs/THEMES.md).
- The crew stage on each job page: the member with the work is lit and animated,
  handoffs fly from the orchestrator, and a caption says what is happening.
  Respects reduced motion.
- A crew strip on each "Working on now" row ("Builder is writing code").
- A theme can set the app title (`appTitle`, shown in the sidebar and browser
  tab) and the page colours (`background`, `text`; refused below 4.5:1
  contrast). The Hive is now "The Hive Mind", warm dark with cream text.

### Changed
- Every merge to main cuts a semver release. Factory commits are now
  `<type>: <KEY> <title>` and PR titles `<type>: <KEY>: <title>`, with the
  Conventional Commits type taken from a `Change-Type:` line the reviewer (else
  the planner) writes; default `fix`. The `images` workflow bumps major for
  `!`/`BREAKING CHANGE`, minor for `feat`, patch otherwise, and tags the images
  `vX.Y.Z`, `X.Y.Z`, `X.Y` and `latest` once all three are built. So the
  update check now sees new releases. Pushing a `v*` tag by hand no longer builds
  images.
- Agent avatars are now a theme's crew pictures. Migration `018_theme` copies
  existing avatars onto the classic theme.
- `pnpm lint` is clean and runs in CI.

## [0.1.0] - 2026-09-22

First tagged release. Cutting this `v0.1.0` tag publishes the GHCR service
images so a self-hosted install pulls prebuilt images instead of building.

### Added
- One-command install (M10): `scripts/setup.sh` interactive wizard (prereq
  checks → generated `.env` → `compose up` → health wait → next steps) and a
  `scripts/asf` operator CLI (`up`/`down`/`restart`/`logs`/`status`/`doctor`/
  `update`/`backup`/`restore`/`reset`/`open`).
- Prebuilt multi-arch service images published to GHCR on push to `main` and on
  `v*` tags; installs pull them via compose `image:` instead of building locally
  (`build:` stays for contributors — `asf update --from-source`).
- `ASF_VERSION` pins the image tag in `docker-compose.self-host.yml`
  (defaults to `latest`).
