# Hive

ASF can send each merged run, and what people said to the agents along the way,
to [Hive](https://github.com/bennybrau/hive) so Hive remembers what the factory
has already done. It is off until `HIVE_URL` is
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

### Dialog (`asf_dialog`)

One episode per human turn, on a run of **any** state (merged, closed,
failed, still running) that has a repository:

- a gate a person decided with a note (a blank note is not sent), and
- a message a person wrote in a run's chat.

```json
{ "kind": "asf_dialog", "repo_key": "gh/owner/repo", "ref": "<run id>:gate:<gate id>",
  "content": "assistant: <what the agent said>\nuser: <what the person wrote>",
  "metadata": { "author": "<who wrote it>" } }
```

- `ref` is `<run id>:gate:<gate id>` or `<run id>:msg:<message id>`.
- `assistant:` is an excerpt of at most 1,500 characters: for a gate, the
  artifact it showed (e.g. `plan.md`); for a chat message, the agent's latest
  message before it. It is empty when there was none.
- The edited artifact from a gate is not sent.

## When

The api checks once a minute for runs that merged, and dialog written, since
it started (minus a day) and sends each one it hasn't sent yet. A failed send (Hive down,
an error answer) is logged and retried on the next check, up to 5 times, then
given up with a log line. The hook runs separately from the orchestrator, so
Hive can never block or fail a run.

What has been sent is kept in memory only. After an api restart the last day is
sent again; Hive dedupes it.

## "Sent to team memory for review"

Once a gate note or a chat message has been sent (by the hook or by a backfill
that isn't a dry run), the registry records when (`hive_sent_at`), and the web
shows **Sent to team memory for review** under it: under your message in the
planner chat, and under the note in the run page's **Gate notes** list. Hive
turns what it learns from them into facts that a person reviews before the
agents act on them.

The marker never shows when Hive is off (blank `HIVE_URL`), because then nothing
is sent. Notes and messages written before migration 024, or sent before
this release, have no marker until a backfill sends them again. If recording
the time fails, the api logs a warning and does not send the item again, so
that item has no marker.

## What the planner reads

When `HIVE_URL` is set, the api also asks Hive for a briefing on the ticket
(`POST <HIVE_URL>/v1/brief`) when a worker fetches a step's context, and the
**planner**, **implementer** and **reviewer** get it as a `## TEAM MEMORY (Hive)`
section just above their role skill. The tester gets nothing.

- The **planner** and **implementer** are told to follow it. The planner also
  ends `plan.md` with a `## Team memory` section (just before `Change-Type:`),
  one line per Gotchas/Facts line in the briefing:

  ```
  ## Team memory
  - [hive:0456204e] Keep human review of Hive facts: applied
  - [hive:2793498f] Planner chat renders markdown: overridden: the ticket replaces the chat
  - [hive:2d48f8c8] Things-to-do without MCP: doesn't apply here
  ```

  With no gotchas or facts it is the single line `Nothing remembered applies to
  this ticket.` `parseTeamMemory` (`packages/shared/src/hive-brief.ts`) reads
  the section back as `id8 → applied | overridden (+ reason) | not_applicable`.
- The **reviewer** treats a change that contradicts a remembered decision as a
  finding citing its `[hive:<id8>]`, unless the plan's Team memory section
  overrode that fact with a reason.

- **What is asked:** the ticket title and body (cut to 4,000 characters), the
  run's repo as `repo_key`, the other repositories the ticket names as
  `also_repos` (only when there are any), and `budget_tokens: 800`.
- **What the agent sees:** the best-matching playbook (numbered steps, then
  pitfalls), gotchas, facts, where to look, past runs and tests. Every fact ends
  with `[hive:<first 8 characters of its id>]`, and the agent is asked to cite the
  ones it relies on and to say so when the ticket contradicts one.
- **Cached** in memory per run, so every step of a run gets the same briefing. A
  chat reply to the planner (a re-plan) fetches it again.
- **Timeout:** 2 s. If Hive is down, answers an error or is slower than that, the
  step runs without a briefing and the api logs one warning. A failure is not
  cached, so the next step asks again. A run with no repo, or an empty briefing,
  gets no section, and the prompt is the same as without Hive.
- **Off switch:** `HIVE_BRIEF=off` (in `.env`, or as an org setting) stops the
  briefing. Sending episodes is not affected.

## Backfill

Runs that merged, and dialog written, before the hook was on (or more than a
day before a restart) are sent with:

```bash
scripts/asf hive-backfill --dry-run                 # how many runs and dialog messages, how many bytes
scripts/asf hive-backfill --since 2026-01-01         # send those merged / written since then
scripts/asf hive-backfill                            # send every merged run and all dialog
```

It sends merged runs oldest merge first, then dialog oldest first, about 3 a second. Without `--dry-run` it refuses while
`HIVE_URL` is blank. It exits non-zero if any episode failed to send; running it
again is safe.
