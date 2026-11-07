# Hive

ASF can send each merged run to [Hive](https://github.com/bennybrau/hive) so
Hive remembers what the factory has already done. It is off until `HIVE_URL` is
set.

## Turning it on and off

Set them in Settings → "Send finished work to Hive?". A value in `.env` still
wins and locks the field there. The settings are:

| Setting      | What it is                                                         |
|--------------|--------------------------------------------------------------------|
| `HIVE_URL`   | Hive's base URL, e.g. `https://hive.example.com`. Blank = off.     |
| `HIVE_TOKEN` | Hive API token, sent as `Authorization: Bearer <token>`. Optional. |

To turn it off, clear the address in Settings. It takes effect within about a
minute, with no restart. (If `HIVE_URL` is in `.env`, clear it there and run
`scripts/asf up` again.)

## What is sent

One episode per run whose pull request was **merged** (by the factory or by a
person), POSTed to `<HIVE_URL>/v1/episodes`. A run that succeeded but whose PR
is still open, or was closed, is not sent.

```json
{ "kind": "asf_run", "repo_key": "gh/owner/repo", "ref": "<run id>", "content": "...",
  "metadata": { "merged_at": "<ISO time>", "pr_url": "https://...", "title": "<ticket title>", "paths": ["src/a.ts"] } }
```

- `repo_key` is `gh/<owner/repo>` on GitHub, `gl/<group/repo>` on GitLab. A run
  with no repository is not sent.
- `ref` is the run id. Hive dedupes on it, so sending a run twice is harmless.
- `content` is Markdown: `# <ticket key>: <ticket title>`, the pull request
  link, then the latest `plan.md` and `review.md` the agents wrote. If the
  tracker can't be read, the ticket key stands in for the title. Nothing is
  truncated.
- `metadata.merged_at` is when the PR merged (the run's first
  `change_request:merged` event, else when the run finished).
- `metadata.paths` are the files the PR changed, at most 500. It is `[]` when
  the SCM can't list them; the episode is still sent.

## When

The api checks once a minute for runs that merged since it started
(minus a day) and sends each one it hasn't sent yet. A failed send (Hive down,
an error answer) is logged and retried on the next check, up to 5 times, then
given up with a log line. The hook runs separately from the orchestrator, so
Hive can never block or fail a run.

What has been sent is kept in memory only. After an api restart the last day is
sent again; Hive dedupes it.

## Backfill

Runs that merged before the hook was on (or more than a day before a
restart) are sent with:

```bash
scripts/asf hive-backfill --dry-run                 # how many runs, how many bytes
scripts/asf hive-backfill --since 2026-01-01         # send those merged since then
scripts/asf hive-backfill                            # send every merged run
```

It sends oldest merge first, about 3 a second. Without `--dry-run` it refuses while
`HIVE_URL` is blank. It exits non-zero if any run failed to send; running it
again is safe.
