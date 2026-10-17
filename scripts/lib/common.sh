# Shared helpers for scripts/asf (M10 WP3). Sourced, never executed directly.
#
# Provides: colours, ok/bad/warn/info/section/die reporters (bad/warn feed the
# doctor counters), a `compose` wrapper pinned to the self-host file, env-file
# reader, health helpers, confirm, and a loopback port probe.

# --- colours (off when not a TTY or NO_COLOR is set) ------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_GREEN=''; C_RED=''; C_YELLOW=''; C_BOLD=''; C_DIM=''
fi

# doctor tallies: bad => ✗ (blocks exit 0), warn => ⚠ (still usable).
DOCTOR_FAIL=0
DOCTOR_WARN=0

ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$1"; [ -n "${2:-}" ] && printf '      %sfix: %s%s\n' "$C_DIM" "$2" "$C_RESET"; DOCTOR_FAIL=$((DOCTOR_FAIL + 1)); return 0; }
warn() { printf '  %s⚠%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; [ -n "${2:-}" ] && printf '      %sfix: %s%s\n' "$C_DIM" "$2" "$C_RESET"; DOCTOR_WARN=$((DOCTOR_WARN + 1)); return 0; }
info() { printf '    %s\n' "$1"; }
section() { printf '\n%s%s%s\n' "$C_BOLD" "$1" "$C_RESET"; }
die()  { printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; exit "${2:-1}"; }

# --- compose (pinned to the self-host project) ------------------------------
: "${COMPOSE_FILE:=docker-compose.self-host.yml}"
COMPOSE_ARG="-f $COMPOSE_FILE"
compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# Whether to layer docker-compose.host-gateway.yml, which maps host.docker.internal
# to the host for the api and worker (M11 WP7). A native Linux daemon needs it;
# Docker/Rancher Desktop define the name themselves, and on Rancher for macOS the
# mapping would point at the VM instead of the Mac. ASF_HOST_GATEWAY in .env:
# 1 = always, 0 = never, blank/auto = on Linux only.
host_gateway_on() { # $1 = env file ; exit 0 iff the overlay applies
  case "$(read_env_key "$1" ASF_HOST_GATEWAY)" in
    1|on|true|yes)   return 0 ;;
    0|off|false|no)  return 1 ;;
    *) [ "$(uname -s)" = "Linux" ] ;;
  esac
}

# A yes/no .env value, forgiving of case, quotes, spaces, a trailing comment and CRLF:
# prints 1, 0, or nothing (blank or unrecognised).
env_flag() { # $1 = env file, $2 = key
  local v
  v="$(read_env_key "$1" "$2" | tr -d '\r"'"'"'' | sed 's/[[:space:]]*#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')"
  case "$v" in
    1|on|true|yes)  printf 1 ;;
    0|off|false|no) printf 0 ;;
  esac
}

# Whether to layer docker-compose.testdb.yml, a scratch Postgres the agents' tests can
# use (#40). Off unless ASF_TEST_DB in .env is yes. Never in host-worker mode
# (ASF_MODE=2): the host worker can't reach it.
test_db_on() { # $1 = env file ; exit 0 iff the overlay applies
  [ "$(read_env_key "$1" ASF_MODE)" != "2" ] && [ "$(env_flag "$1" ASF_TEST_DB)" = 1 ]
}

# --- env-file reader (last KEY=value wins; blank if absent) -----------------
read_env_key() { # $1 = file, $2 = key
  local file=$1 key=$2 line val=""
  [ -f "$file" ] || { printf '%s' ""; return 0; }
  while IFS= read -r line || [ -n "$line" ]; do
    [ "${line%%=*}" = "$key" ] && [ "${line#"$key"=}" != "$line" ] && val="${line#"$key"=}"
  done < "$file"
  printf '%s' "$val"
}

# --- env-file writer: rewrite (or append) KEY=VALUE, verbatim, comments untouched
set_env_key() { # $1 = file, $2 = key, $3 = value
  local file=$1 key=$2 value=$3 line found=0 tmp
  tmp="$(mktemp)"
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "${line%%=*}" = "$key" ] && [ "${line#"$key"=}" != "$line" ]; then
      printf '%s=%s\n' "$key" "$value" >> "$tmp"; found=1
    else
      printf '%s\n' "$line" >> "$tmp"
    fi
  done < "$file"
  [ "$found" -eq 0 ] && printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > "$file"   # keep the file's inode + chmod 600
  rm -f "$tmp"
}

rand_hex() { # $1 = bytes of entropy -> 2*$1 hex chars
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

# --- container health (via docker inspect; no curl in the images) -----------
container_health() { # $1 = service -> healthy|starting|unhealthy|running|missing|unknown
  local cid
  cid="$(compose ps -q "$1" 2>/dev/null || true)"
  [ -n "$cid" ] || { printf 'missing'; return 0; }
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || printf 'unknown'
}

wait_healthy() { # $1 = service, $2 = label, $3 = timeout secs
  local svc=$1 label=${2:-$1} timeout=${3:-180} elapsed=0 status
  while [ "$elapsed" -lt "$timeout" ]; do
    status="$(container_health "$svc")"
    case "$status" in
      healthy|running) ok "$label $status"; return 0 ;;
      unhealthy) bad "$label unhealthy" "asf logs $svc"; return 1 ;;
    esac
    sleep 2; elapsed=$((elapsed + 2))
  done
  bad "$label did not become healthy in ${timeout}s" "asf logs $svc"; return 1
}

# --- misc -------------------------------------------------------------------
confirm() { # $1 = prompt ; 0 = yes. Non-interactive assumes yes (callers gate with --yes).
  local reply
  [ -t 0 ] || return 0
  printf '  %s [y/N]: ' "$1"
  read -r reply || reply=""
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
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
