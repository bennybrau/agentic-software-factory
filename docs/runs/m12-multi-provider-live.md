# M12 several trackers and code hosts — live check log

> **Status: pending live run.** This is a template. Nobody has run it yet. Fill it in
> during a real run against real trackers and code hosts (an agent has no credentials
> for them). Replace every `<…>` with what actually happened. Do not invent output:
> leave a section empty rather than make it up. Design: [`M12_MULTI_PROVIDER.md`](../M12_MULTI_PROVIDER.md).

## Setup

- ASF version / commit: `<vX.Y.Z / sha>`
- `TICKET_PROVIDERS`: `<e.g. jira,github>`, set in: `<Settings / .env>`
- `SCM_PROVIDERS`: `<e.g. gitlab,github>`, set in: `<Settings / .env>`
- Jira site and projects: `<https://<org>.atlassian.net, PROJ>`
- GitHub repositories (tickets and code): `<acme/web, …>`
- GitLab host and repositories: `<https://gitlab.example.com, acme/platform/…>`
- `GET /health` shows each connection ok: `<paste the tickets and scm arrays>`

## 1. Jira and GitHub Issues listed together

- Planned tasks shows tickets from both, each with its `Jira` / `GitHub` badge: `<yes/no + screenshot>`
- Source filter All / Jira / GitHub narrows the list, and is kept after a reload: `<yes/no>`
- Board, sprint and status controls appear only with the Jira source chosen: `<yes/no>`
- With one tracker's credentials broken, the other still lists and the failed one says why: `<yes/no + reason shown>`

## 2. A Jira ticket delivered to `acme/web` on GitHub

| step | run id / task id | outcome | notes |
| --- | --- | --- | --- |
| start `<PROJ-12>` in `github:acme/web` | `<run id>` | | Start page reason: `<…>` |
| planner | | | |
| implementer | | | |
| tester | | | |
| reviewer | | | |
| draft PR opened on GitHub | | | `<PR url>` |
| Jira status on PR open | | | `<status before → after>` |
| merge (by ASF or outside it) | | | |
| Jira status on merge | | | `<status before → after>` |

- Run page shows the `Jira` source badge and the GitHub host beside the PR: `<yes/no>`
- Comments landed on the Jira ticket, none on GitHub issues: `<yes/no>`

## 3. A split with parts on GitLab and GitHub

| part | repository | run id | change request | merged on | notes |
| --- | --- | --- | --- | --- | --- |
| parent `<ticket>` | `<repo>` | `<run id>` | — | — | split approved at `<time>` |
| 1 | `gitlab:<path>` | `<run id>` | `<MR url>` | GitLab | |
| 2 | `github:<path>` | `<run id>` | `<PR url>` | GitHub | |

- Each part's change request opened and merged on its own host: `<yes/no>`
- The parent ticket moved to Done on its own tracker, with one comment listing the parts: `<yes/no + link>`
- Hive keys recorded for the parts: `<gl/… and gh/…>`

## Frictions / follow-ups

1. `<…>`
