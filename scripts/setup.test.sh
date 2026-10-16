#!/usr/bin/env bash
# Tests for scripts/setup.sh (M10 WP1).
#
# Run directly:  bash scripts/setup.test.sh
#
# No real Docker is required: a fake `docker` + `pnpm` are put on PATH so
# preflight passes; every scenario here uses --no-up so nothing is actually
# started. The "docker missing" scenario deliberately does NOT fake docker.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETUP_SH="$REPO_ROOT/scripts/setup.sh"

PASS=0
FAIL=0

fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }

assert_contains() { # $1=haystack $2=needle $3=message
  case "$1" in *"$2"*) pass ;; *) fail "$3 (expected to find: $2)" ;; esac
}
assert_not_contains() {
  case "$1" in *"$2"*) fail "$3 (did not expect to find: $2)" ;; *) pass ;; esac
}
assert_eq() { # $1=actual $2=expected $3=message
  [ "$1" = "$2" ] && pass || fail "$3 (got '$1', want '$2')"
}

# --- an isolated fake checkout: setup.sh, .env.example, compose file only ---
FAKE_ROOT="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
NODOCKER_BIN="$(mktemp -d)"   # /usr/bin + /bin minus docker (CI runners keep docker in /usr/bin)
for d in /bin /usr/bin; do
  for f in "$d"/*; do
    n="${f##*/}"
    case "$n" in docker|docker-*|com.docker*) continue ;; esac
    [ -e "$NODOCKER_BIN/$n" ] || ln -s "$f" "$NODOCKER_BIN/$n" 2>/dev/null || true
  done
done
cleanup() { rm -rf "$FAKE_ROOT" "$FAKE_BIN" "$NODOCKER_BIN"; }
trap cleanup EXIT

mkdir -p "$FAKE_ROOT/scripts"
cp "$SETUP_SH" "$FAKE_ROOT/scripts/setup.sh"
cp "$REPO_ROOT/scripts/worker-host.sh" "$FAKE_ROOT/scripts/worker-host.sh"
cp "$REPO_ROOT/.env.example" "$FAKE_ROOT/.env.example"
cp "$REPO_ROOT/docker-compose.self-host.yml" "$FAKE_ROOT/docker-compose.self-host.yml"
cp "$REPO_ROOT/docker-compose.host-worker.yml" "$FAKE_ROOT/docker-compose.host-worker.yml"
cp "$REPO_ROOT/docker-compose.host-gateway.yml" "$FAKE_ROOT/docker-compose.host-gateway.yml"
chmod +x "$FAKE_ROOT/scripts/setup.sh" "$FAKE_ROOT/scripts/worker-host.sh"
git init -q "$FAKE_ROOT"

cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "info" ]; then exit 0; fi
if [ "$1" = "compose" ] && [ "${2:-}" = "version" ]; then
  echo "Docker Compose version v2.99.9"
  exit 0
fi
exit 0
EOF
chmod +x "$FAKE_BIN/docker"

cat > "$FAKE_BIN/pnpm" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = "--version" ] && { echo "9.0.0"; exit 0; }
exit 0
EOF
chmod +x "$FAKE_BIN/pnpm"

run_setup() { # runs setup.sh from within FAKE_ROOT with fakes on PATH
  ( cd "$FAKE_ROOT" && PATH="$FAKE_BIN:$PATH" "$FAKE_ROOT/scripts/setup.sh" "$@" )
}

# --- --help -------------------------------------------------------------
out="$(run_setup --help 2>&1)"; code=$?
assert_eq "$code" "0" "--help exits 0"
assert_contains "$out" "Usage: scripts/setup.sh" "--help prints usage"

# --- unknown option -------------------------------------------------------
out="$("$FAKE_ROOT/scripts/setup.sh" --bogus 2>&1)"; code=$?
assert_eq "$code" "2" "unknown option exits 2"

# --- docker missing => preflight fails, exit 1, no .env written ---------
rm -f "$FAKE_ROOT/.env"
out="$(cd "$FAKE_ROOT" && PATH="$NODOCKER_BIN" ./scripts/setup.sh --non-interactive --no-up 2>&1)"; code=$?
assert_eq "$code" "1" "missing docker => exit 1"
assert_contains "$out" "docker not found" "missing docker => clear failure message"
[ -f "$FAKE_ROOT/.env" ] && fail "no .env should be written when preflight fails" || pass

# --- mode 1, non-interactive, custom port: generates a valid .env -------
out="$(ASF_MODE=1 ASF_PORT=9123 run_setup --non-interactive --no-up 2>&1)"; code=$?
assert_eq "$code" "0" "mode 1 non-interactive --no-up succeeds"
[ -f "$FAKE_ROOT/.env" ] && pass || fail ".env was written"
assert_contains "$out" "http://localhost:9123" "banner prints the chosen port's URL"

perm="$(stat -c '%a' "$FAKE_ROOT/.env" 2>/dev/null || stat -f '%Lp' "$FAKE_ROOT/.env")"
assert_eq "$perm" "600" ".env is chmod 600"

get() { # $1 = KEY, reads from the generated .env
  awk -F= -v k="$1" '$1==k{print substr($0, length(k)+2)}' "$FAKE_ROOT/.env" | tail -1
}
assert_eq "$(get ASF_PORT)" "9123" "ASF_PORT written from env var"
assert_eq "$(get AUTH_MODE)" "none" "AUTH_MODE forced to none"
assert_eq "$(get TICKET_PROVIDER)" "" "TICKET_PROVIDER left blank for the UI"
assert_eq "$(get SCM_PROVIDER)" "" "SCM_PROVIDER left blank for the UI"
assert_eq "$(get AGENT_AUTH_MODE)" "" "AGENT_AUTH_MODE left blank for the UI"
assert_eq "$(get ASF_MODE)" "1" "ASF_MODE recorded for the day-2 CLI"
secret="$(get RUN_EVENT_SECRET)"
assert_eq "${#secret}" "64" "RUN_EVENT_SECRET is 32 bytes of hex"
pw="$(get POSTGRES_PASSWORD)"
assert_eq "${#pw}" "32" "POSTGRES_PASSWORD is 16 bytes of hex"
assert_not_contains "$(get DATABASE_URL)" "$pw" "mode 1 does not touch DATABASE_URL"
skey="$(get ASF_SECRET_KEY)"
assert_eq "${#skey}" "64" "ASF_SECRET_KEY is 32 bytes of hex (#9)"
assert_not_contains "$out" "$skey" "the secret key is never printed in full"

# --- re-run without --force: idempotent no-op reconcile ------------------
before="$(cat "$FAKE_ROOT/.env")"
out="$(ASF_MODE=1 ASF_PORT=9123 run_setup --non-interactive --no-up 2>&1)"; code=$?
assert_eq "$code" "0" "re-run succeeds"
assert_contains "$out" "already present" "re-run reports .env already present"
after="$(cat "$FAKE_ROOT/.env")"
assert_eq "$after" "$before" "re-run without --force leaves .env untouched"

# --- --force regenerates and backs up the old .env ------------------------
out="$(ASF_MODE=1 ASF_PORT=9123 run_setup --non-interactive --no-up --force 2>&1)"; code=$?
assert_eq "$code" "0" "--force re-run succeeds"
[ -f "$FAKE_ROOT/.env.bak" ] && pass || fail "--force backs up the previous .env"
new_secret="$(get RUN_EVENT_SECRET)"
[ "$new_secret" != "$secret" ] && pass || fail "--force regenerates RUN_EVENT_SECRET"
assert_eq "$(get ASF_SECRET_KEY)" "$skey" "--force KEEPS ASF_SECRET_KEY (a new key would orphan saved tokens)"

# --- upgrade: an .env from before #9 gets a key on re-run; nothing else changes
grep -v '^ASF_SECRET_KEY=' "$FAKE_ROOT/.env" > "$FAKE_ROOT/.env.old" && cp "$FAKE_ROOT/.env.old" "$FAKE_ROOT/.env" && rm -f "$FAKE_ROOT/.env.old"
before_up="$(grep -v '^ASF_SECRET_KEY=' "$FAKE_ROOT/.env")"
out="$(ASF_MODE=1 ASF_PORT=9123 run_setup --non-interactive --no-up 2>&1)"; code=$?
assert_eq "$code" "0" "re-run on a pre-#9 .env succeeds"
assert_contains "$out" "added ASF_SECRET_KEY" "re-run reports the added key"
up_key="$(get ASF_SECRET_KEY)"
assert_eq "${#up_key}" "64" "re-run adds a 64-hex ASF_SECRET_KEY"
assert_eq "$(grep -v '^ASF_SECRET_KEY=' "$FAKE_ROOT/.env")" "$before_up" "re-run changes nothing but the added key"
perm_up="$(stat -c '%a' "$FAKE_ROOT/.env" 2>/dev/null || stat -f '%Lp' "$FAKE_ROOT/.env")"
assert_eq "$perm_up" "600" ".env stays chmod 600 after adding the key"

# --- --force mid-rotation keeps ASF_SECRET_KEY_PREVIOUS too
printf 'ASF_SECRET_KEY_PREVIOUS=%s\n' "$skey" >> "$FAKE_ROOT/.env"
out="$(ASF_MODE=1 ASF_PORT=9123 run_setup --non-interactive --no-up --force 2>&1)"; code=$?
assert_eq "$code" "0" "--force mid-rotation succeeds"
assert_eq "$(get ASF_SECRET_KEY)" "$up_key" "--force mid-rotation keeps ASF_SECRET_KEY"
assert_eq "$(get ASF_SECRET_KEY_PREVIOUS)" "$skey" "--force mid-rotation keeps ASF_SECRET_KEY_PREVIOUS"

# --- mode 3: DATABASE_URL carries the generated password ------------------
rm -f "$FAKE_ROOT/.env" "$FAKE_ROOT/.env.bak"
out="$(ASF_MODE=3 ASF_PORT=9124 run_setup --non-interactive --no-up 2>&1)"; code=$?
assert_eq "$code" "0" "mode 3 non-interactive --no-up succeeds"
pw3="$(get POSTGRES_PASSWORD)"
assert_eq "$(get DATABASE_URL)" "postgres://asf:${pw3}@localhost:5432/asf" "mode 3 rewrites DATABASE_URL with the generated password"

# --- mode 2: writes the host-worker override files and advertises the host worker
rm -f "$FAKE_ROOT/.env" "$FAKE_ROOT/.env.bak"
FAKE_HOME="$(mktemp -d)"
out="$(HOME="$FAKE_HOME" ASF_MODE=2 ASF_PORT=9200 run_setup --non-interactive --no-up 2>&1)"; code=$?
assert_eq "$code" "0" "mode 2 non-interactive --no-up succeeds"
assert_eq "$(get ASF_MODE)" "2" "mode 2 recorded in .env"
# worker.env: per-host overrides sourced by worker-host.sh (never a shell profile)
[ -f "$FAKE_HOME/.asf/worker.env" ] && pass || fail "mode 2 writes ~/.asf/worker.env"
werenv="$(cat "$FAKE_HOME/.asf/worker.env" 2>/dev/null)"
assert_contains "$werenv" "WORKTREE_ROOT=$FAKE_HOME/.asf/worktrees" "worker.env sets WORKTREE_ROOT under ~/.asf"
assert_contains "$werenv" "RUN_DATA_ROOT=$FAKE_HOME/.asf/runs" "worker.env sets RUN_DATA_ROOT under ~/.asf"
perm2="$(stat -c '%a' "$FAKE_HOME/.asf/worker.env" 2>/dev/null || stat -f '%Lp' "$FAKE_HOME/.asf/worker.env")"
assert_eq "$perm2" "600" "worker.env is chmod 600"
# the supervisor unit (systemd on Linux CI, launchd on macOS)
if [ "$(uname -s)" = "Darwin" ]; then
  [ -f "$FAKE_HOME/Library/LaunchAgents/com.asf.worker.plist" ] && pass || fail "mode 2 writes the launchd plist"
  assert_contains "$(cat "$FAKE_HOME/Library/LaunchAgents/com.asf.worker.plist")" "worker-host.sh" "plist ExecStart points at worker-host.sh"
else
  [ -f "$FAKE_HOME/.config/systemd/user/asf-worker.service" ] && pass || fail "mode 2 writes the systemd user unit"
  assert_contains "$(cat "$FAKE_HOME/.config/systemd/user/asf-worker.service")" "worker-host.sh" "service ExecStart points at worker-host.sh"
fi
# --no-up must not load the supervisor, only write it
assert_contains "$out" "load the host worker:  scripts/host-worker.sh up" "mode 2 --no-up explains how to load the host worker"
assert_contains "$out" "starts at LOGIN, not at boot" "mode 2 warns the worker starts at login, not boot"
assert_contains "$out" "docker-compose.host-worker.yml" "mode 2 uses the host-worker compose overlay"
rm -rf "$FAKE_HOME"

# --- mode name aliases: containers|host-worker|dev map to 1|2|3 -----------
rm -f "$FAKE_ROOT/.env" "$FAKE_ROOT/.env.bak"
out="$(run_setup --mode containers --non-interactive --no-up 2>&1)"; code=$?
assert_eq "$code" "0" "--mode containers succeeds"
assert_eq "$(get ASF_MODE)" "1" "--mode containers is recorded as mode 1"
assert_contains "$out" "mode 1 — containers" "--mode containers selects mode 1"

rm -f "$FAKE_ROOT/.env" "$FAKE_ROOT/.env.bak"
out="$(ASF_MODE=dev run_setup --non-interactive --no-up 2>&1)"; code=$?
assert_eq "$code" "0" "ASF_MODE=dev succeeds"
assert_eq "$(get ASF_MODE)" "3" "ASF_MODE=dev is recorded as mode 3"

# --- --pull parses (only affects the start path, so a --no-up run is enough) --
rm -f "$FAKE_ROOT/.env" "$FAKE_ROOT/.env.bak"
out="$(run_setup --mode 1 --non-interactive --no-up --pull 2>&1)"; code=$?
assert_eq "$code" "0" "--pull is accepted"

# --- mode 2 --no-supervisor: writes worker.env but installs NO supervisor unit
rm -f "$FAKE_ROOT/.env" "$FAKE_ROOT/.env.bak"
FAKE_HOME2="$(mktemp -d)"
out="$(HOME="$FAKE_HOME2" ASF_MODE=host-worker ASF_PORT=9300 run_setup --non-interactive --no-up --no-supervisor 2>&1)"; code=$?
assert_eq "$code" "0" "mode 2 --no-supervisor succeeds"
assert_eq "$(get ASF_MODE)" "2" "host-worker alias is recorded as mode 2"
[ -f "$FAKE_HOME2/.asf/worker.env" ] && pass || fail "--no-supervisor still writes ~/.asf/worker.env"
if [ "$(uname -s)" = "Darwin" ]; then
  [ -f "$FAKE_HOME2/Library/LaunchAgents/com.asf.worker.plist" ] && fail "--no-supervisor must not write the launchd plist" || pass
else
  [ -f "$FAKE_HOME2/.config/systemd/user/asf-worker.service" ] && fail "--no-supervisor must not write the systemd unit" || pass
fi
assert_contains "$out" "skipping the launchd/systemd unit" "--no-supervisor says it skipped the supervisor"
rm -rf "$FAKE_HOME2"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
