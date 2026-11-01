# syntax=docker/dockerfile:1.7
# Multi-stage: build the workspace once, then copy one app's pruned production tree.
# uv (Astral), pinned like the agent CLIs (images.yml passes the same value): Python target
# repos install and test with it (`uv sync`, `uv run pytest`); it fetches any Python version
# a repo pins that the system python3 doesn't satisfy, on first use.
ARG UV_VERSION=0.11.26
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM node:22-slim AS build
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY prompts ./prompts
COPY db ./db
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @asf/shared build
RUN pnpm --filter @asf/worker build
RUN pnpm --filter @asf/worker --prod deploy --legacy /out

# Debian 13 (trixie), not the bookworm default: the worker needs git >= 2.42 for
# `git worktree add --orphan` (first delivery into an empty repo). Bookworm ships
# 2.39, and not even bookworm-backports has a newer one.
FROM node:22-trixie-slim
# Pin the Claude Code CLI so an image build is reproducible. Bump deliberately;
# the worker logs the resolved `claude --version` in its `starting` event.
# Newer models need a minimum CLI (claude-opus-5-5 needs >= 2.1.280). Keep this in
# step with .github/workflows/images.yml, which passes the same value.
ARG CLAUDE_CODE_VERSION=2.1.284
# The OpenAI Codex CLI (runtime `codex`), pinned the same way. Both agents ship in
# every worker; the worker offers whichever one has working credentials.
ARG CODEX_VERSION=0.159.0
# poppler-utils: `pdftotext`/`pdfinfo` for target repos whose code or tests extract PDF
# text (e.g. the Hive's docs ingest). Without it those tests fail in the tester's run.
# python3: a system interpreter for repos that call `python3` directly (Debian's 3.13);
# uv uses it when a repo's requires-python allows, so most repos need no download.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client tini poppler-utils python3 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} \
 && corepack enable pnpm yarn
# pnpm and yarn for the agents: a target repo's own install/test/lint commands (the
# version comes from the repo's `packageManager` field, fetched on first use).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY --from=uv /uv /uvx /usr/local/bin/
WORKDIR /app
COPY --from=build /out/dist ./apps/worker/dist
COPY --from=build /out/node_modules ./apps/worker/node_modules
COPY --from=build /out/package.json ./apps/worker/package.json
COPY --from=build /src/apps/worker/hooks ./apps/worker/hooks
# tsc doesn't copy JSON fixtures; the auth golden test reads this next to its .js.
COPY --from=build /src/apps/worker/src/auth/anthropic.golden.json ./apps/worker/dist/auth/anthropic.golden.json
COPY --from=build /src/prompts ./prompts
# `pnpm deploy --legacy` symlinks @asf/shared back into /src; make the image self-contained.
COPY --from=build /src/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build /src/packages/shared/dist /app/packages/shared/dist
# shared's own deps (zod) as a real, symlink-free install.
RUN cd /app/packages/shared && npm install --omit=dev --no-package-lock --no-audit --no-fund --loglevel=error
RUN rm -f apps/worker/node_modules/@asf/shared && ln -s ../../../../packages/shared apps/worker/node_modules/@asf/shared \
 && mkdir -p /data/worktrees /data/runs && chown -R node:node /app
# #68: agents run as their own user, so an agent command that kills by name or pattern
# (`pkill -f dist/index.js`) can't reach the worker: Linux only lets a process signal its
# own uid. `agent` (1001) and the worker's `node` share the group `asfwork` (1500), so each
# can write the worktrees and run dirs the other made (the worker runs with umask 002).
# The worker switches to `agent` with a copy of setpriv that holds cap_setuid/cap_setgid and
# that only `node` can execute (root:node 0750). The agent is not in group `node`, and
# setpriv drops every capability before exec, so it can't use the helper to switch back.
RUN groupadd -g 1500 asfwork && useradd -m -u 1001 -U -G asfwork -s /bin/bash agent && usermod -aG asfwork node \
 && apt-get update && apt-get install -y --no-install-recommends libcap2-bin \
 && install -d -m 0755 /usr/local/libexec/asf \
 && install -o root -g node -m 0750 /usr/bin/setpriv /usr/local/libexec/asf/as-agent \
 && setcap cap_setuid,cap_setgid+ep /usr/local/libexec/asf/as-agent \
 && apt-get purge -y libcap2-bin && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && printf '[safe]\n\tdirectory = *\n' > /home/agent/.gitconfig && chown agent:agent /home/agent/.gitconfig \
 && chown -R node:asfwork /data && chmod -R 2775 /data \
 && install -d -o root -g asfwork -m 0750 /etc/asf/gcloud
ENV ASF_AGENT_USER=agent
USER node
ARG ASF_BUILD_VERSION=dev
ENV ASF_BUILD_VERSION=$ASF_BUILD_VERSION
ENV NODE_ENV=production WORKTREE_ROOT=/data/worktrees RUN_DATA_ROOT=/data/runs
# tini as PID 1. Agents spawn process trees (Bash tools, test runners), and a
# cancelled task's group is killed. Without an init, nothing reaps those children,
# so they pile up as zombies (and a zombie still answers kill(pid, 0), so the
# guard's "the group is dead" check can't tell). tini reaps them and forwards
# signals to node.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/worker/dist/index.js"]
