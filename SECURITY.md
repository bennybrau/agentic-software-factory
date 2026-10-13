# Security policy

ASF holds tracker and SCM credentials and runs coding agents that execute repository
code. Security reports are taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:
**Security → Report a vulnerability** on this repository
([private vulnerability reporting](https://github.com/bennybrau/agentic-software-factory/security/advisories/new)).

Include what you found, how to reproduce it, and the impact you expect. You should
get an acknowledgement within a few days. Once a fix ships, the advisory is
published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the latest release gets security fixes.

## Saved credentials at rest

Tokens entered in Settings are stored in Postgres (`org_secret`) encrypted with
AES-256-GCM under `ASF_SECRET_KEY`, a key held only by the registry (never in the
database, and dropped by the api and worker at boot so agents never inherit it). A
database dump or copied volume therefore holds ciphertext only. Back the key up
separately from database backups. This protects data at rest; anyone who controls
the running registry, or holds `RUN_EVENT_SECRET` and can reach the registry, can
still obtain the tokens, so the internal trust boundary is unchanged. Without a key,
tokens are stored in plaintext and `asf doctor` warns. Details:
[`docs/PROVIDERS.md`](docs/PROVIDERS.md#encryption-at-rest).

## Scope and threat model

In scope, for example:
- a credential (ticket/SCM token, agent key, org secret) reaching the browser, the
  registry, an agent process, logs, or a run artifact
- bypassing a human gate, especially `before_merge`
- an agent writing outside its run's worktree, or pushing to a forbidden branch
- authentication/identity bypass when `AUTH_MODE=header`

Expected behaviour, not a vulnerability:
- the worker runs agent CLIs with their own sandboxes disabled **inside the worker
  container**. The container is the isolation boundary. Run the worker on a dedicated
  host or VM, not on a machine holding unrelated secrets.
- with `AUTH_MODE=none`, anyone who can reach the api port is the operator. Bind it to
  loopback and put an authenticating proxy in front (see `docs/SELF_HOSTING.md`).
