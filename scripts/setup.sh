#!/usr/bin/env bash
#
# ASF install wizard: git clone && ./scripts/setup.sh -> running factory, URL printed.
#
# Idempotent (re-run to reconcile), no shell-profile dependency, and it never
# clobbers an existing .env without --force.
#
#   ./scripts/setup.sh                 # interactive: pick a mode, generate .env, bring it up
#   ./scripts/setup.sh --mode 1        # containers (default)  (alias: --mode containers)
#   ./scripts/setup.sh --mode 2        # containers + a note on running a host worker (alias: host-worker)
#   ./scripts/setup.sh --mode 3        # dev: postgres in Docker, apps on the host (alias: dev)
#   ./scripts/setup.sh --no-up         # generate .env + preflight only, start nothing
#   ./scripts/setup.sh --no-supervisor # mode 2: write worker.env + build, but don't install/start the supervisor
#   ./scripts/setup.sh --pull          # pull prebuilt images instead of building (fast path)
#   ./scripts/setup.sh --force         # regenerate .env even if one exists
#   ASF_MODE=1 ASF_PORT=9000 ./scripts/setup.sh --non-interactive
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# --- presentation -----------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_GREEN=''; C_RED=''; C_YELLOW=''; C_BOLD=''; C_DIM=''
fi

FAILURES=0
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$1"; [ -n "${2:-}" ] && printf '      %s%s%s\n' "$C_DIM" "$2" "$C_RESET"; FAILURES=$((FAILURES + 1)); }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
info() { printf '    %s\n' "$1"; }
section() { printf '\n%s%s%s\n' "$C_BOLD" "$1" "$C_RESET"; }

# --- args -------------------------------------------------------------------
INTERACTIVE=1
FORCE=0
NO_UP=0
NO_SUPERVISOR=0
PULL=0
MODE=""

usage() {
  cat <<'EOF'
ASF install wizard.

Usage: scripts/setup.sh [options]

  --mode N            1 = containers (default), 2 = containers + a worker on this host, 3 = dev
                      names also accepted: containers | host-worker | dev
  --force             regenerate .env even if one already exists
  --no-up             generate .env and run preflight, but start nothing
  --no-supervisor     mode 2: write worker.env and build, but do not install or start the
                      launchd/systemd supervisor (you start the worker yourself)
  --pull              pull prebuilt images and start (no local build); default builds
  --non-interactive   never prompt; read ASF_MODE / ASF_PORT / ASF_FORCE from the environment
  --help              show this help

Environment (used by --non-interactive):
  ASF_MODE   1|2|3     which mode, or containers|host-worker|dev (default 1)
  ASF_PORT   number    host port the UI binds (default 8787)
  ASF_FORCE  1         same as --force
  ASF_PULL   1         same as --pull
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --force) FORCE=1; shift ;;
    --no-up) NO_UP=1; shift ;;
    --no-supervisor) NO_SUPERVISOR=1; shift ;;
    --pull) PULL=1; shift ;;
    --non-interactive) INTERACTIVE=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

# No controlling terminal => we cannot prompt.
[ -t 0 ] || INTERACTIVE=0
[ "${ASF_FORCE:-}" = "1" ] && FORCE=1
[ "${ASF_PULL:-}" = "1" ] && PULL=1

# --- helpers ----------------------------------------------------------------
rand_hex() { # $1 = bytes of entropy -> 2*$1 hex chars
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

port_in_use() { # $1 = port ; 0 if something is listening on loopback
  local p=$1
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    exec 3>&- 2>/dev/null || true
    exec 3<&- 2>/dev/null || true
    return 0
  fi
  return 1
}

# Rewrite (or append) KEY=VALUE in an env file, matching only a line that starts
# with "KEY=" (so AUTH_MODE never touches AGENT_AUTH_MODE, and comments are left
# alone). Pure bash, no sed, so a value with / & : is written verbatim.
# The KEY on each line that follows a comment ending in "(also editable in the UI)".
ui_editable_keys() {
  local prev="" line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$prev" in *"(also editable in the UI)") case "$line" in *=*) printf '%s\n' "${line%%=*}" ;; esac ;; esac
    prev="$line"
  done < "$1"
}

set_env_key() {
  local file=$1 key=$2 value=$3 line found=0 tmp
  tmp="$(mktemp)"
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "${line%%=*}" = "$key" ] && [ "${line#"$key"=}" != "$line" ]; then
      printf '%s=%s\n' "$key" "$value" >> "$tmp"
      found=1
    else
      printf '%s\n' "$line" >> "$tmp"
    fi
  done < "$file"
  [ "$found" -eq 0 ] && printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$file"
}

read_env_key() { # $1 = file, $2 = key ; prints the last value found (blank if none)
  local file=$1 key=$2 line val=""
  [ -f "$file" ] || { printf '%s' ""; return; }
  while IFS= read -r line || [ -n "$line" ]; do
    [ "${line%%=*}" = "$key" ] && [ "${line#"$key"=}" != "$line" ] && val="${line#"$key"=}"
  done < "$file"
  printf '%s' "$val"
}

mask() { # show enough of a secret to recognise it, not enough to use it
  local v=$1
  if [ "${#v}" -le 10 ]; then printf '%s' "$v"; else printf '%s…(%d chars, hidden)' "${v:0:6}" "${#v}"; fi
}

# --- preflight (core) -------------------------------------------------------
section "Preflight"

if command -v git >/dev/null 2>&1; then ok "git"; else bad "git not found" "install git, then re-run"; fi

DOCKER_OK=0
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then ok "docker daemon reachable"; DOCKER_OK=1
  else bad "docker is installed but the daemon is not reachable" "start Docker Desktop / the docker service, then re-run"; fi
else
  bad "docker not found" "install Docker: https://docs.docker.com/get-docker/"
fi

if docker compose version >/dev/null 2>&1; then
  ok "docker compose v2 ($(docker compose version --short 2>/dev/null || echo present))"
else
  bad "docker compose v2 not available" "install the Compose v2 plugin (the 'docker compose' subcommand, not docker-compose)"
fi

# >=10 GB free where Docker keeps its data (the repo/home filesystem is the fallback).
DISK_DIR=""
if [ "$DOCKER_OK" -eq 1 ]; then DISK_DIR="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"; fi
if [ -z "$DISK_DIR" ] || [ ! -d "$DISK_DIR" ]; then DISK_DIR="$HOME"; fi
if [ ! -d "$DISK_DIR" ]; then DISK_DIR="$ROOT"; fi
AVAIL_KB="$(df -Pk "$DISK_DIR" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "$AVAIL_KB" ]; then
  AVAIL_GB=$((AVAIL_KB / 1024 / 1024))
  if [ "$AVAIL_GB" -ge 10 ]; then ok "disk: ${AVAIL_GB} GB free (${DISK_DIR})"
  else bad "disk: only ${AVAIL_GB} GB free (${DISK_DIR}); need >= 10 GB" "free up space (images + Postgres volume need room)"; fi
else
  warn "could not measure free disk space at ${DISK_DIR}; make sure >= 10 GB is available"
fi

if command -v openssl >/dev/null 2>&1; then ok "openssl (secret generation)"
elif [ -r /dev/urandom ]; then ok "/dev/urandom (secret generation)"
else bad "no way to generate secrets" "install openssl, or make /dev/urandom readable"; fi

# macOS TCC: an unattended stack under a protected folder cannot read/write freely.
if [ "$(uname -s)" = "Darwin" ]; then
  case "$ROOT/" in
    "$HOME/Documents/"*|"$HOME/Desktop/"*|"$HOME/Downloads/"*)
      warn "this checkout is under a macOS privacy-protected folder (Documents/Desktop/Downloads)."
      info "Docker may be denied file access there. Prefer a path like ~/asf or ~/src/." ;;
  esac
fi

# --- mode -------------------------------------------------------------------
section "Mode"
if [ -z "$MODE" ]; then
  if [ "$INTERACTIVE" -eq 1 ]; then
    printf '  1) containers      everything in Docker (recommended)\n'
    printf '  2) host-worker     containers + a host worker (the agent runs on this machine)\n'
    printf '  3) dev             Postgres in Docker, the apps on the host (pnpm dev)\n'
    printf '  Choose [1]: '
    read -r MODE || MODE=""
  else
    MODE="${ASF_MODE:-1}"
  fi
fi
[ -z "$MODE" ] && MODE=1
# Accept the ticket's mode names as aliases for the numbers (from --mode or ASF_MODE).
case "$MODE" in
  containers)  MODE=1 ;;
  host-worker) MODE=2 ;;
  dev)         MODE=3 ;;
esac
case "$MODE" in
  1) info "mode 1 — containers" ;;
  2) info "mode 2 — host-worker" ;;
  3) info "mode 3 — dev" ;;
  *) printf '%sinvalid mode: %s (want 1, 2 or 3)%s\n' "$C_RED" "$MODE" "$C_RESET" >&2; exit 2 ;;
esac

# --- preflight (mode 2/3 needs Node + pnpm) ---------------------------------
if [ "$MODE" = "2" ] || [ "$MODE" = "3" ]; then
  section "Preflight (host build)"
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$NODE_MAJOR" -ge 22 ]; then ok "node $(node --version)"
    else bad "node $(node --version) is too old; need >= 22" "install Node 22+ (https://nodejs.org or nvm)"; fi
  else
    bad "node not found" "install Node 22+ (https://nodejs.org or nvm)"
  fi
  if command -v pnpm >/dev/null 2>&1; then
    ok "pnpm $(pnpm --version 2>/dev/null || true)"
  elif command -v corepack >/dev/null 2>&1; then
    if [ "$INTERACTIVE" -eq 1 ]; then
      printf '  pnpm is not on PATH but corepack is. Run "corepack enable" now? [Y/n]: '
      read -r reply || reply=""
      case "$reply" in
        n|N) bad "pnpm not available" "run: corepack enable  (or install pnpm)" ;;
        *) if corepack enable >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then ok "pnpm enabled via corepack ($(pnpm --version 2>/dev/null || true))"
           else bad "could not enable pnpm via corepack" "run: corepack enable  (may need sudo), or install pnpm"; fi ;;
      esac
    else
      bad "pnpm not available" "run: corepack enable  (or install pnpm), then re-run"
    fi
  else
    bad "pnpm not available and corepack not found" "install pnpm (https://pnpm.io/installation)"
  fi
fi

if [ "$FAILURES" -gt 0 ]; then
  printf '\n%s%d check(s) failed — fix the above and re-run.%s\n' "$C_RED" "$FAILURES" "$C_RESET" >&2
  exit 1
fi

# --- .env -------------------------------------------------------------------
section "Configuration (.env)"
ENV_FILE="$ROOT/.env"
EXAMPLE="$ROOT/.env.example"

# Resolve the port up front (used whether we generate .env or reuse it).
DEFAULT_PORT="${ASF_PORT:-8787}"

if [ -f "$ENV_FILE" ] && [ "$FORCE" -ne 1 ]; then
  ASF_PORT_VALUE="$(read_env_key "$ENV_FILE" ASF_PORT)"
  [ -n "$ASF_PORT_VALUE" ] || ASF_PORT_VALUE="$DEFAULT_PORT"
  ok ".env already present — keeping it (use --force to regenerate)"
  info "port from .env: ${ASF_PORT_VALUE}"
  # Upgrade path for #9: an .env from before saved-token encryption gets a key, so
  # the registry encrypts the tokens already saved in Settings on its next boot.
  # An existing key is NEVER replaced — that would orphan every saved token.
  if [ -z "$(read_env_key "$ENV_FILE" ASF_SECRET_KEY)" ]; then
    set_env_key "$ENV_FILE" ASF_SECRET_KEY "$(rand_hex 32)"
    chmod 600 "$ENV_FILE"
    ok "added ASF_SECRET_KEY to .env (encrypts tokens saved in Settings)"
    info "back up .env separately from database backups: a restore without this key loses the saved tokens"
  fi
else
  [ -f "$EXAMPLE" ] || { printf '%s.env.example missing — is this an ASF checkout?%s\n' "$C_RED" "$C_RESET" >&2; exit 1; }

  # Pick the port (default 8787), warning if something already holds it.
  ASF_PORT_VALUE="$DEFAULT_PORT"
  if port_in_use "$ASF_PORT_VALUE"; then
    if [ "$INTERACTIVE" -eq 1 ]; then
      warn "port ${ASF_PORT_VALUE} is already in use."
      printf '  Enter a different port, or press Enter to use %s anyway: ' "$ASF_PORT_VALUE"
      read -r alt || alt=""
      [ -n "$alt" ] && ASF_PORT_VALUE="$alt"
    else
      warn "port ${ASF_PORT_VALUE} is already in use — continuing (it may be your existing ASF)."
    fi
  fi

  if [ -f "$ENV_FILE" ]; then
    cp "$ENV_FILE" "$ENV_FILE.bak"
    info "existing .env backed up to .env.bak"
  fi

  RUN_EVENT_SECRET_VALUE="$(rand_hex 32)"
  POSTGRES_PASSWORD_VALUE="$(rand_hex 16)"
  # Encrypts tokens saved in Settings at rest (#9). --force keeps an existing key:
  # a new one would make every token already in the database unreadable.
  SECRET_KEY_VALUE="$(read_env_key "$ENV_FILE" ASF_SECRET_KEY)"
  [ -n "$SECRET_KEY_VALUE" ] || SECRET_KEY_VALUE="$(rand_hex 32)"
  # ...and an unfinished rotation's old key, or the tokens still on it are lost.
  SECRET_KEY_PREVIOUS_VALUE="$(read_env_key "$ENV_FILE" ASF_SECRET_KEY_PREVIOUS)"
  # Keep the stack-layout choices a person made in .env (they aren't in .env.example).
  HOST_GATEWAY_VALUE="$(read_env_key "$ENV_FILE" ASF_HOST_GATEWAY)"
  TEST_DB_VALUE="$(read_env_key "$ENV_FILE" ASF_TEST_DB)"

  TMP_ENV="$(mktemp)"
  cp "$EXAMPLE" "$TMP_ENV"
  set_env_key "$TMP_ENV" RUN_EVENT_SECRET "$RUN_EVENT_SECRET_VALUE"
  set_env_key "$TMP_ENV" POSTGRES_PASSWORD "$POSTGRES_PASSWORD_VALUE"
  set_env_key "$TMP_ENV" ASF_SECRET_KEY "$SECRET_KEY_VALUE"
  [ -z "$SECRET_KEY_PREVIOUS_VALUE" ] || set_env_key "$TMP_ENV" ASF_SECRET_KEY_PREVIOUS "$SECRET_KEY_PREVIOUS_VALUE"
  [ -z "$HOST_GATEWAY_VALUE" ] || set_env_key "$TMP_ENV" ASF_HOST_GATEWAY "$HOST_GATEWAY_VALUE"
  [ -z "$TEST_DB_VALUE" ] || set_env_key "$TMP_ENV" ASF_TEST_DB "$TEST_DB_VALUE"
  set_env_key "$TMP_ENV" ASF_PORT "$ASF_PORT_VALUE"
  # The day-2 CLI (scripts/asf) reads the mode from .env to decide, e.g., whether
  # `up` also starts a host worker (mode 2).
  set_env_key "$TMP_ENV" ASF_MODE "$MODE"
  set_env_key "$TMP_ENV" AUTH_MODE none
  # Leave every setting the UI asks about blank, so the UI (org settings) owns it.
  # .env.example carries each key's default, and a non-empty value pins a key and
  # locks its question read-only. gen:config marks exactly those keys
  # "(also editable in the UI)" on the comment line above them.
  for key in $(ui_editable_keys "$TMP_ENV"); do set_env_key "$TMP_ENV" "$key" ""; done
  # Dev mode talks to the host Postgres directly; point it at the generated
  # password (docker-compose.yml wiring for it lands in WP2).
  if [ "$MODE" = "3" ]; then
    set_env_key "$TMP_ENV" DATABASE_URL "postgres://asf:${POSTGRES_PASSWORD_VALUE}@localhost:5432/asf"
  fi
  mv "$TMP_ENV" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  ok "wrote .env (chmod 600)"
  printf '    %s%-18s %s%s\n' "$C_DIM" "RUN_EVENT_SECRET" "$(mask "$RUN_EVENT_SECRET_VALUE")" "$C_RESET"
  printf '    %s%-18s %s%s\n' "$C_DIM" "POSTGRES_PASSWORD" "$(mask "$POSTGRES_PASSWORD_VALUE")" "$C_RESET"
  printf '    %s%-18s %s%s\n' "$C_DIM" "ASF_SECRET_KEY" "$(mask "$SECRET_KEY_VALUE") (back up .env: database backups need it)" "$C_RESET"
  printf '    %s%-18s %s%s\n' "$C_DIM" "ASF_PORT" "$ASF_PORT_VALUE" "$C_RESET"
  printf '    %s%-18s %s%s\n' "$C_DIM" "AUTH_MODE" "none" "$C_RESET"
  printf '    %s%-18s %s%s\n' "$C_DIM" "TICKET_PROVIDER" "(blank — set in the web UI)" "$C_RESET"
  printf '    %s%-18s %s%s\n' "$C_DIM" "SCM_PROVIDER" "(blank — set in the web UI)" "$C_RESET"
  printf '    %s%-18s %s%s\n' "$C_DIM" "AGENT_AUTH_MODE" "(blank — set in the web UI)" "$C_RESET"
  [ "$MODE" = "3" ] && printf '    %s%-18s %s%s\n' "$C_DIM" "DATABASE_URL" "postgres://asf:***@localhost:5432/asf" "$C_RESET"
fi

# --- host worker unit (mode 2) ----------------------------------------------
# In host-worker mode the worker runs on THIS machine, supervised across reboots
# by launchd (macOS) or systemd --user (Linux), so the agent can use host-only
# Claude auth (interactive `claude login`) or Google ADC for Vertex. Write the
# per-host override file and the supervisor unit now (config, not a start); they
# are loaded in the "Starting" section (or later by scripts/host-worker.sh up).
ASF_HOME="$HOME/.asf"

worker_path() { # a PATH the launchd/systemd unit can trust (no shell profile involved)
  local node_dir pnpm_dir
  node_dir="$(dirname "$(command -v node)")"
  pnpm_dir="$(dirname "$(command -v pnpm)")"
  printf '%s' "$HOME/.local/bin:${node_dir}:${pnpm_dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
}

install_worker_env() { # ~/.asf/worker.env — sourced by scripts/worker-host.sh, never a shell profile
  mkdir -p "$ASF_HOME" "$ASF_HOME/worktrees" "$ASF_HOME/runs" "$ASF_HOME/logs"
  cat > "$ASF_HOME/worker.env" <<EOF
# ASF host worker overrides — generated by scripts/setup.sh --mode 2.
# Sourced by scripts/worker-host.sh (NOT your shell profile). Edit freely — e.g.
# prepend the directory that holds \`claude\` to PATH if it isn't found.
PATH=$(worker_path)
WORKTREE_ROOT=${ASF_HOME}/worktrees
RUN_DATA_ROOT=${ASF_HOME}/runs
EOF
  chmod 600 "$ASF_HOME/worker.env"
  ok "wrote ${ASF_HOME}/worker.env"
}

install_launch_unit() { # launchd plist (macOS) or systemd --user unit (Linux)
  local exec_path="$ROOT/scripts/worker-host.sh"
  if [ "$(uname -s)" = "Darwin" ]; then
    local plist="$HOME/Library/LaunchAgents/com.asf.worker.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.asf.worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${exec_path}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${ASF_HOME}/logs/worker.log</string>
  <key>StandardErrorPath</key><string>${ASF_HOME}/logs/worker.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>$(worker_path)</string>
  </dict>
</dict>
</plist>
EOF
    ok "wrote ${plist}"
  else
    local unit="$HOME/.config/systemd/user/asf-worker.service"
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$unit" <<EOF
[Unit]
Description=ASF host worker
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=/bin/bash ${exec_path}
Restart=always
RestartSec=5
StandardOutput=append:${ASF_HOME}/logs/worker.log
StandardError=append:${ASF_HOME}/logs/worker.log

[Install]
WantedBy=default.target
EOF
    ok "wrote ${unit}"
  fi
}

if [ "$MODE" = "2" ]; then
  section "Host worker (mode 2)"
  install_worker_env
  if [ "$NO_SUPERVISOR" -eq 1 ]; then
    info "--no-supervisor: skipping the launchd/systemd unit (start the worker yourself)"
  else
    install_launch_unit
  fi
fi

# --- health helpers ---------------------------------------------------------
SPINNER="|/-\\"
spin_i=0
spin() {
  [ -t 1 ] || return 0
  local ch="${SPINNER:spin_i%4:1}"
  spin_i=$((spin_i + 1))
  printf '\r  %s %s ' "$ch" "$1"
}
clear_line() { [ -t 1 ] && printf '\r\033[K'; return 0; }

container_health() { # $1 = service ; prints healthy|starting|unhealthy|running|missing
  local cid
  cid="$("${COMPOSE[@]}" ps -q "$1" 2>/dev/null || true)"
  [ -n "$cid" ] || { printf 'missing'; return; }
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || printf 'unknown'
}

wait_healthy() { # $1 = service, $2 = label, $3 = timeout secs
  local svc=$1 label=$2 timeout=${3:-180} elapsed=0 status
  while [ "$elapsed" -lt "$timeout" ]; do
    status="$(container_health "$svc")"
    case "$status" in
      healthy) clear_line; ok "$label healthy"; return 0 ;;
      running) clear_line; ok "$label up"; return 0 ;;
      unhealthy) clear_line; bad "$label unhealthy" "logs: docker compose ${COMPOSE_ARG} logs $svc"; return 1 ;;
    esac
    spin "$label ($status)"
    sleep 2; elapsed=$((elapsed + 2))
  done
  clear_line; bad "$label did not become healthy in ${timeout}s" "logs: docker compose ${COMPOSE_ARG} logs $svc"; return 1
}

wait_worker() { # containers-mode worker: registered/polling OR waiting for agent auth (both fine)
  local timeout=${1:-150} elapsed=0 logs
  while [ "$elapsed" -lt "$timeout" ]; do
    logs="$("${COMPOSE[@]}" logs --tail=200 worker 2>/dev/null || true)"
    case "$logs" in
      *"registered; polling"*) clear_line; ok "worker registered; polling for tasks"; return 0 ;;
    esac
    case "$logs" in
      *"waiting for an AI to be connected"*|*"agent auth preflight failed"*|*"no CLAUDE_CODE_OAUTH_TOKEN is set"*|*"no ANTHROPIC_API_KEY is set"*)
        clear_line; ok "worker up, waiting for you to connect Claude or ChatGPT/OpenAI in the web UI (expected)"; return 0 ;;
    esac
    spin "worker (starting)"
    sleep 2; elapsed=$((elapsed + 2))
  done
  clear_line; warn "worker has not registered yet — check: docker compose ${COMPOSE_ARG} logs worker"
  return 0
}

# --- up + health ------------------------------------------------------------
if [ "$MODE" = "3" ]; then
  COMPOSE=(docker compose)
  COMPOSE_ARG=""
elif [ "$MODE" = "2" ]; then
  # host-worker mode: layer the overlay that publishes the registry on loopback
  # and moves the container worker behind a profile so it does not start.
  COMPOSE=(docker compose -f docker-compose.self-host.yml -f docker-compose.host-worker.yml)
  COMPOSE_ARG="-f docker-compose.self-host.yml -f docker-compose.host-worker.yml"
else
  COMPOSE=(docker compose -f docker-compose.self-host.yml)
  COMPOSE_ARG="-f docker-compose.self-host.yml"
fi
# A native Linux daemon doesn't define host.docker.internal, which the api and worker
# use to reach a server on this machine (Ollama, docs/OLLAMA.md): layer the overlay
# that maps it. ASF_HOST_GATEWAY in .env: 1 = always, 0 = never, blank = Linux only.
# Same rule as host_gateway_on in scripts/lib/common.sh (this script is standalone).
if [ "$MODE" != "3" ]; then
  case "$(read_env_key "$ENV_FILE" ASF_HOST_GATEWAY 2>/dev/null || true)" in
    1|on|true|yes)  hg=1 ;;
    0|off|false|no) hg=0 ;;
    *) if [ "$(uname -s)" = "Linux" ]; then hg=1; else hg=0; fi ;;
  esac
  if [ "$hg" = 1 ]; then
    COMPOSE+=(-f docker-compose.host-gateway.yml)
    COMPOSE_ARG="$COMPOSE_ARG -f docker-compose.host-gateway.yml"
  fi
fi

# A scratch Postgres for the agents' tests (#40): ASF_TEST_DB=1 in .env layers it.
# Same rule as test_db_on in scripts/lib/common.sh: the container worker only (not
# mode 2, whose worker can't reach it, nor mode 3, which uses docker-compose.yml).
if [ "$MODE" = "1" ]; then
  tdb="$(read_env_key "$ENV_FILE" ASF_TEST_DB 2>/dev/null | tr -d '\r"'"'"'' | sed 's/[[:space:]]*#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]' || true)"
  case "$tdb" in
    1|on|true|yes)
      COMPOSE+=(-f docker-compose.testdb.yml)
      COMPOSE_ARG="$COMPOSE_ARG -f docker-compose.testdb.yml" ;;
  esac
fi

# Bring the stack up: --pull grabs the prebuilt images (fast, ~3 min) then `up -d`;
# the default builds from this checkout (`up -d --build`), which is what a PR that
# changes a Dockerfile/db needs.
compose_up() {
  if [ "$PULL" -eq 1 ]; then
    info "docker compose ${COMPOSE_ARG} pull"
    "${COMPOSE[@]}" pull
    info "docker compose ${COMPOSE_ARG} up -d"
    "${COMPOSE[@]}" up -d
  else
    info "docker compose ${COMPOSE_ARG} up -d --build"
    "${COMPOSE[@]}" up -d --build
  fi
}

if [ "$NO_UP" -eq 1 ]; then
  section "Skipping start (--no-up)"
  if [ "$MODE" = "3" ]; then
    info "when ready:  docker compose up -d postgres  &&  pnpm install  &&  pnpm dev"
  elif [ "$MODE" = "2" ]; then
    info "when ready:  docker compose ${COMPOSE_ARG} up -d --build"
    info "then load the host worker:  scripts/host-worker.sh up"
  else
    info "when ready:  docker compose ${COMPOSE_ARG} up -d --build"
  fi
else
  if [ "$MODE" = "3" ]; then
    section "Starting (dev)"
    info "docker compose up -d postgres"
    "${COMPOSE[@]}" up -d postgres
    section "Health"
    wait_healthy postgres "postgres" 120 || true
    info "ensuring the asf_test database exists"
    "${COMPOSE[@]}" exec -T postgres createdb -U asf asf_test >/dev/null 2>&1 || true
    ok "asf_test database ready"
    section "Installing host dependencies"
    info "pnpm install"
    pnpm install
    info "pnpm --filter @asf/shared build"
    pnpm --filter @asf/shared build
    ok "host build ready"
  elif [ "$MODE" = "2" ]; then
    section "Starting (this builds images — first run takes a few minutes)"
    compose_up
    section "Health"
    wait_healthy postgres "postgres" 120 || true
    wait_healthy registry "registry" 180 || true
    wait_healthy api "api" 180 || true
    # The compose worker is disabled in this mode; build + supervise one on the host.
    section "Host worker"
    info "building the worker on this host"
    pnpm install
    pnpm --filter @asf/shared build
    pnpm --filter @asf/worker build
    ok "worker built"
    if [ "$NO_SUPERVISOR" -eq 1 ]; then
      info "--no-supervisor: not installing/starting the supervisor — start the worker yourself:"
      info "  scripts/worker-host.sh   (or scripts/host-worker.sh up to supervise it)"
    else
      if [ "$(uname -s)" = "Linux" ]; then
        systemctl --user daemon-reload 2>/dev/null || true
        systemctl --user enable asf-worker.service >/dev/null 2>&1 || true
        # Linger lets the user service keep running after logout (and start at boot).
        loginctl enable-linger "$USER" >/dev/null 2>&1 \
          || warn "could not enable linger; the worker stops when you log out (run: sudo loginctl enable-linger $USER)"
      fi
      if "$SCRIPT_DIR/host-worker.sh" up; then :; else
        warn "could not start the host worker automatically — start it with: scripts/host-worker.sh up"
      fi
    fi
  else
    section "Starting (this builds images — first run takes a few minutes)"
    compose_up
    section "Health"
    wait_healthy postgres "postgres" 120 || true
    wait_healthy registry "registry" 180 || true
    wait_healthy api "api" 180 || true
    wait_worker 150 || true
  fi
fi

# --- next steps -------------------------------------------------------------
URL="http://localhost:${ASF_PORT_VALUE}"
section "You're set"
if [ "$MODE" = "3" ]; then
  printf '  Start the apps on the host:  %spnpm dev%s   (registry :8788 -> api :8787 -> worker + web :3999)\n' "$C_BOLD" "$C_RESET"
  printf '  Then open:                   %s%shttp://localhost:3999%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
  URL="http://localhost:3999"
fi
printf '\n'
printf '  Open the setup checklist:      %s%s%s/setup%s\n' "$C_BOLD" "$C_GREEN" "$URL" "$C_RESET"
printf '  It walks you through the rest in your browser, one question at a time:\n'
printf '    1. Where your tickets and code live\n'
printf '    2. %sWhich AI should do the work?%s  Claude or ChatGPT/OpenAI, with step-by-step help getting a key\n' "$C_BOLD" "$C_RESET"
printf '    3. Pick a ticket and press Start\n'
printf '  Nothing to edit here: the worker picks up the AI you connect within a minute.\n'
if [ "$MODE" = "2" ]; then
  printf '\n'
  printf '  %sHost worker (mode 2):%s the agent runs on THIS machine (supervised); the compose stack runs everything else.\n' "$C_BOLD" "$C_RESET"
  printf '    Agent auth is host-side: run %sclaude login%s (or %sclaude setup-token%s), or provide Google ADC for Vertex.\n' "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
  printf '    Manage it:  %sscripts/host-worker.sh up|down|status|logs%s\n' "$C_BOLD" "$C_RESET"
  printf '    %sIt starts at LOGIN, not at boot%s — log in once after a reboot (or enable auto-login).\n' "$C_DIM" "$C_RESET"
  if [ "$(uname -s)" = "Darwin" ]; then
    printf '    Keep the Mac awake so runs are not missed:  %ssudo pmset -a sleep 0%s\n' "$C_DIM" "$C_RESET"
  fi
fi
if [ "$MODE" != "3" ]; then
  printf '\n'
  printf '  Manage the stack:\n'
  printf '    docker compose %s ps        # status\n' "$COMPOSE_ARG"
  printf '    docker compose %s logs -f   # follow logs\n' "$COMPOSE_ARG"
  printf '    docker compose %s down      # stop (volumes kept)\n' "$COMPOSE_ARG"
fi
printf '\n'
