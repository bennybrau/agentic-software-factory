# Upgrading ASF

Updates are one command, and database migrations apply themselves. This page covers
the update, how to pin a version, and how to recover from a backup.

## Update

```bash
scripts/asf update
```

That pulls the prebuilt images (pinned by `ASF_VERSION`, else `:latest`), restarts
with no local build, and waits for Postgres, the registry and the api to be healthy.
To rebuild from this checkout instead:

```bash
git pull --ff-only
scripts/asf update --from-source
```

`--from-source` refuses to run with a dirty working tree — commit or stash first.

## Checking for updates

Every merge to main is a release. The factory's commits and pull request titles carry
a [Conventional Commits](https://www.conventionalcommits.org/) type (the planner and
reviewer each end their artifact with a `Change-Type:` line; the reviewer's wins,
else `fix`). CI's `images` workflow (`scripts/next-version.sh`) reads the commits
since the last `vX.Y.Z` tag and bumps:

- **major** for a `type!:` subject or a `BREAKING CHANGE:` footer;
- **minor** for any `feat:`;
- **patch** for anything else (`fix`, `chore`, `docs`, `ci`, `refactor`, `test`, untyped).

It builds the three images as `sha-<sha>` and, only once all three are pushed,
tags them `vX.Y.Z`, `X.Y.Z`, `X.Y` and `latest` and pushes the `vX.Y.Z` git
tag. Runs go one at a time, so two merges never get the same number; if several
merges queue up behind a running release, the newest one releases them together.

Each image knows its own version: CI bakes it in as `ASF_BUILD_VERSION` (`v0.2.0`).
A local build says `dev`, which never reports an update.

The api checks once at boot and then once a day whether a newer release is published:
it lists the tags of `UPDATE_IMAGE_REPO` (default
`ghcr.io/bennybrau/asf-api`) anonymously and takes the highest strict
`vX.Y.Z` tag. `latest`, `sha-…`, `0.1` and pre-releases like `v1.2.0-rc1` are ignored.
The check only looks — nothing is pulled or installed until you apply the update
(below) or run `scripts/asf update` yourself.

```bash
curl -s localhost:8787/api/updates            # the last result
curl -s -X POST localhost:8787/api/updates/check   # check now
```

Both return `{ current, latest, available, checkedAt, error, canApply }`. A failed
check (registry down, no network) is reported in `error`, not as an HTTP error.

Turn the daily check off with `UPDATE_CHECK_ENABLED=false` in `.env`, or from the
org settings; turning it back on takes effect within the hour, without a restart.

## Applying an update from the UI

On the self-host compose stack, a newer release can be applied without a terminal.
The UI's update button calls this endpoint, which you can also call directly:

```bash
curl -s -X POST localhost:8787/api/updates/apply
```

`canApply` in the status is `true` when the stack has the supervisor sidecar and a
newer release is known. The api then asks the supervisor to start a short-lived
**updater** container (`docker:cli`, labelled `asf.updater=1`). The updater sets
`ASF_VERSION=<latest>` in `.env`, replacing the line or adding it and keeping the
file's owner and mode. Then it runs `docker compose pull && docker compose up -d`
for the `asf` project, with the same directory and compose files the stack was
started from. It removes itself when it is done. The api, the supervisor and the UI
restart along the way, so reload the page after a minute or two. Who asked is
logged by the api.

The apply is refused with HTTP 409 `{ error: 'refused', reason }` when:

- the deployment has no supervisor (`ASF_LOCAL_SUPERVISOR` off): run
  `scripts/asf update` on the host;
- no newer release is known (check first);
- a task is running on a worker, or the registry cannot be reached to say: try again
  once the runs finish (`canApply` does not account for busy workers; the apply
  checks again);
- the supervisor refuses: the version is not a strict `vX.Y.Z`, an update is already
  running, or the supervisor container has no compose project labels (it was not
  started by `docker compose`).

What the updater does **not** do: wait for health checks, roll back, or keep its
output once it has removed itself. Run `scripts/asf doctor` (or `asf update`, which
does wait for health) if something looks wrong afterwards. The updater runs compose
outside your shell, so a compose variable you only `export` in your shell (for
example `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` or `GCLOUD_CONFIG_DIR`) is blank
when it recreates the containers, and `${HOME}` is the updater's own home. If you
rely on any of these, use `scripts/asf update` from that shell.

## Migrations are automatic and additive

Schema migrations live in `db/migrations/*.sql` and are **applied by the registry at
boot**. They are additive-only and checksummed; an applied migration is never edited.
So an update needs nothing extra from you — bringing the new registry up runs any new
migrations before it serves. `asf update` reads the migration count back from the
registry log and reports the schema level so you can confirm they ran.

## Pinning a version

By default the stack tracks `:latest`. To pin a known-good release, set `ASF_VERSION`
in `.env` to a published tag:

```bash
ASF_VERSION=v0.1.0
```

Then `asf update` pulls exactly that tag. `asf doctor` shows the running tag next to
the pinned one and flags a drift. Bump `ASF_VERSION` and re-run `asf update` to move.

For the one-liner installer, `ASF_VERSION` selects the branch/tag it clones/checks
out — e.g. `ASF_VERSION=v0.1.0 curl -fsSL …/install.sh | bash`.

## Encrypting saved tokens (v1.1+)

Releases from v1.1 encrypt tokens saved in Settings at rest. A fresh `setup.sh`
does it for you. On an existing install, once, after `asf update`:

```bash
scripts/asf secret-key     # adds ASF_SECRET_KEY to .env; the registry encrypts on restart
scripts/asf doctor         # "saved tokens: N encrypted at rest (key …)"
```

Until then nothing breaks; `asf doctor` just warns that they're plaintext. To rotate
the key later: `scripts/asf secret-key --rotate`. Details:
[`PROVIDERS.md`](PROVIDERS.md#encryption-at-rest).

## Back up before a big jump, and restoring

Migrations are additive, but a backup before a major update is cheap insurance:

```bash
scripts/asf backup            # pg_dump into the backups volume and ./backups/
```

The stack also writes a **nightly** `pg_dump` (14-day retention) via the `backup`
container. Sync `./backups` (or the `backups` volume) offsite — see
[`SELF_HOSTING.md`](SELF_HOSTING.md).

**Back up `.env` too, somewhere else.** Tokens saved in Settings are encrypted with
its `ASF_SECRET_KEY`; a dump restored without that key comes back with those tokens
unreadable (you'd re-enter them in Settings). `asf restore` checks the dump's key
against `.env` before it replaces anything.

To restore a dump — this **replaces all current data** and is double-checked before
it runs:

```bash
scripts/asf restore ./backups/asf-YYYY-MM-DD.sql.gz
```

It stops the app tier, resets the schema, loads the dump, and brings the stack back
up, then fails loudly if any restored token can't be decrypted with this stack's key. **Test a restore once** so you know it works before you need it.

## Rolling back

Pin `ASF_VERSION` to the previous tag and `asf update`. Because migrations are
additive, an older image runs against the newer schema in the common case; if a
release notes a breaking migration, restore the pre-update backup instead.
