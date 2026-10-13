#!/usr/bin/env bash
#
# ASF one-liner installer: clone (or update) the repo, then hand off to setup.sh.
#
#   curl -fsSL https://raw.githubusercontent.com/bennybrau/agentic-software-factory/main/scripts/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --mode 2      # flags pass through to setup.sh
#
# Env:
#   ASF_HOME     where to clone      (default: $HOME/asf)
#   ASF_VERSION  branch/tag to check out (default: main)
#
# The whole body is in main(), called at EOF, so a truncated download never runs a
# partial script.
set -euo pipefail

REPO_URL="https://github.com/bennybrau/agentic-software-factory.git"

main() {
  local home="${ASF_HOME:-$HOME/asf}"
  local version="${ASF_VERSION:-main}"

  if ! command -v git >/dev/null 2>&1; then
    printf 'install.sh: git is required but was not found. Install git, then re-run.\n' >&2
    exit 1
  fi

  if [ -d "$home/.git" ]; then
    printf 'Updating existing checkout at %s (%s)\n' "$home" "$version"
    git -C "$home" fetch --quiet origin "$version"
    git -C "$home" checkout --quiet "$version"
    git -C "$home" pull --ff-only --quiet origin "$version"
  else
    printf 'Cloning %s into %s (%s)\n' "$REPO_URL" "$home" "$version"
    git clone --branch "$version" "$REPO_URL" "$home"
  fi

  printf 'ASF checkout: %s\n\n' "$home"
  cd "$home"
  exec scripts/setup.sh "$@"
}

main "$@"
