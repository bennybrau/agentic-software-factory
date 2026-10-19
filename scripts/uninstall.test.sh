#!/usr/bin/env bash
# Tests for scripts/uninstall.sh.
#
# Run directly:  bash scripts/uninstall.test.sh
#
# No real Docker: a fake `docker` on PATH answers from a state dir (which
# containers/volumes/networks each compose project has) and logs every call, so
# the tests assert exactly what would be removed. HOME points at a temp dir, and
# fake `uname`/`launchctl`/`systemctl` cover the macOS and Linux host-worker paths.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0
FAIL=0
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }
assert_contains() { case "$1" in *"$2"*) pass ;; *) fail "$3 (expected to find: $2)" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) fail "$3 (did not expect to find: $2)" ;; *) pass ;; esac; }
assert_eq() { [ "$1" = "$2" ] && pass || fail "$3 (got '$1', want '$2')"; }

TMP="$(cd "$(mktemp -d)" && pwd -P)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# The checkout dir is named "devasf", so dev mode's compose project is "devasf".
ROOT="$TMP/devasf"
FAKE_BIN="$TMP/bin"
STATE="$TMP/state"
FAKE_HOME="$TMP/home"
NODOCKER_BIN="$TMP/nodocker"   # /usr/bin + /bin minus docker (CI runners keep docker in /usr/bin)
mkdir -p "$ROOT/scripts/lib" "$FAKE_BIN" "$NODOCKER_BIN"
cp "$REPO_ROOT/scripts/uninstall.sh" "$ROOT/scripts/uninstall.sh"
cp "$REPO_ROOT/scripts/lib/common.sh" "$ROOT/scripts/lib/common.sh"
cp "$REPO_ROOT/docker-compose.self-host.yml" "$ROOT/docker-compose.self-host.yml"
chmod +x "$ROOT/scripts/uninstall.sh"
for d in /bin /usr/bin; do
  for f in "$d"/*; do
    n="${f##*/}"
    case "$n" in docker|docker-*|com.docker*|uname|launchctl|systemctl) continue ;; esac
    [ -e "$NODOCKER_BIN/$n" ] || ln -s "$f" "$NODOCKER_BIN/$n" 2>/dev/null || true
  done
done

cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
S="$FAKE_STATE"
printf '%s\n' "$*" >> "$S/calls"
label() { for a in "$@"; do case "$a" in label=*) printf '%s\n' "${a#label=}" ;; esac; done; }
proj() { label "$@" | sed -n 's/^com.docker.compose.project=//p' | head -1; }
case "$1" in
  info) [ -f "$S/daemon-down" ] && exit 1; exit 0 ;;
  ps)
    if label "$@" | grep -q '^asf.updater=1$'; then cat "$S/updaters" 2>/dev/null; exit 0; fi
    if label "$@" | grep -q '^com.docker.compose.service=postgres$'; then cat "$S/pg.$(proj "$@")" 2>/dev/null; exit 0; fi
    if label "$@" | grep -q '^com.docker.compose.service=backup$'; then cat "$S/bak.$(proj "$@")" 2>/dev/null; exit 0; fi
    cat "$S/containers.$(proj "$@")" 2>/dev/null; exit 0 ;;
  volume)
    case "$2" in ls) cat "$S/volumes.$(proj "$@")" 2>/dev/null ;; rm) [ -f "$S/fail-volume-rm" ] && exit 1 ;; esac; exit 0 ;;
  network)
    case "$2" in ls) cat "$S/networks.$(proj "$@")" 2>/dev/null ;; inspect) printf '%s\n' "${!#}" ;; esac; exit 0 ;;
  images) cat "$S/images.$(proj "$@")" 2>/dev/null; exit 0 ;;
  inspect)
    id="${!#}"
    case "$3" in
      *Config.Image*) cat "$S/image.$id" 2>/dev/null ;;
      *HostConfig.Binds*) cat "$S/binds.$id" 2>/dev/null ;;
      *working_dir*) if [ -f "$S/wd.$id" ]; then cat "$S/wd.$id"; else printf '%s\n' "$FAKE_ROOT"; fi ;;
      *) printf '/%s\n' "$id" ;;
    esac; exit 0 ;;
  exec)
    [ -f "$S/dump-fail" ] && exit 1
    printf -- '-- PostgreSQL database dump (%s)\n' "$2"
    [ -f "$S/dump-truncated" ] || printf -- '-- PostgreSQL database dump complete\n'
    exit 0 ;;
  cp) [ -f "$S/cp-fail" ] && exit 1; printf 'nightly\n' > "${!#}/asf-2026-10-18.sql.gz"; exit 0 ;;
  rm|image) exit 0 ;;
esac
exit 0
EOF
cat > "$FAKE_BIN/launchctl" <<'EOF'
#!/usr/bin/env bash
printf 'launchctl %s\n' "$*" >> "$FAKE_STATE/calls"
case "$1" in
  print) [ -f "$FAKE_STATE/launchd-loaded" ] && exit 0; exit 1 ;;
  bootout) rm -f "$FAKE_STATE/launchd-loaded"; exit 0 ;;
esac
exit 0
EOF
cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$FAKE_STATE/calls"
exit 0
EOF
cat > "$FAKE_BIN/uname" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${FAKE_UNAME:-Darwin}"
EOF
chmod +x "$FAKE_BIN"/*

# A full mode-1 install: 6 containers, 4 volumes, a network, a dev-mode postgres,
# an updater left behind, files in the checkout.
seed() {
  rm -rf "$STATE" "$FAKE_HOME" "$ROOT/.env" "$ROOT/.env.bak" "$ROOT/backups"
  mkdir -p "$STATE" "$FAKE_HOME"
  printf 'c_pg\nc_reg\nc_api\nc_wrk\nc_sup\nc_bak\n' > "$STATE/containers.asf"
  printf 'c_pg\n' > "$STATE/pg.asf"
  printf 'asf_pgdata\nasf_worktrees\nasf_runs\nasf_backups\n' > "$STATE/volumes.asf"
  printf 'asf_default\n' > "$STATE/networks.asf"
  printf 'c_bak\n' > "$STATE/bak.asf"
  printf 'c_devpg\n' > "$STATE/containers.devasf"
  printf 'c_devpg\n' > "$STATE/pg.devasf"
  printf 'devasf_pgdata\n' > "$STATE/volumes.devasf"
  printf 'devasf_default\n' > "$STATE/networks.devasf"
  printf 'c_upd\nc_upd_other\n' > "$STATE/updaters"
  printf '/var/run/docker.sock:/var/run/docker.sock\n%s:%s\n' "$ROOT" "$ROOT" > "$STATE/binds.c_upd"
  printf '/var/run/docker.sock:/var/run/docker.sock\n/elsewhere/asf:/elsewhere/asf\n' > "$STATE/binds.c_upd_other"
  printf 'ghcr.io/bennybrau/asf-api:v1.2.0\n' > "$STATE/image.c_api"
  printf 'ghcr.io/bennybrau/asf-api:v1.2.0\n' > "$STATE/image.c_sup"
  printf 'postgres:16-alpine\n' > "$STATE/image.c_pg"
  printf 'sha256:built1\n' > "$STATE/images.asf"
  printf 'ASF_PORT=8787\nASF_SECRET_KEY=%s\n' "$(printf 'a%.0s' $(seq 64))" > "$ROOT/.env"
  chmod 600 "$ROOT/.env"
  printf 'old\n' > "$ROOT/.env.bak"
  mkdir -p "$ROOT/backups" && printf 'dump\n' > "$ROOT/backups/asf-manual-1.sql.gz"
}
run() { # runs uninstall.sh with the fakes; stdin is not a terminal
  ( cd "$ROOT" && HOME="$FAKE_HOME" FAKE_STATE="$STATE" FAKE_ROOT="$ROOT" PATH="$FAKE_BIN:$PATH" ./scripts/uninstall.sh "$@" ) </dev/null 2>&1
}
calls() { cat "$STATE/calls" 2>/dev/null; }

# --- --help / bad option ------------------------------------------------------
seed
out="$(run --help)"; code=$?
assert_eq "$code" "0" "--help exits 0"
assert_contains "$out" "Usage: scripts/uninstall.sh" "--help prints usage"
out="$(run --bogus)"; code=$?
assert_eq "$code" "2" "unknown option exits 2"
out="$(run --backup-dir)"; code=$?
assert_eq "$code" "2" "--backup-dir without a value exits 2"

# --- --dry-run lists everything and changes nothing ---------------------------
seed
out="$(run --dry-run)"; code=$?
assert_eq "$code" "0" "--dry-run exits 0"
for want in c_pg c_wrk c_sup c_bak c_devpg c_upd asf_pgdata asf_backups devasf_pgdata asf_default devasf_default "$ROOT/.env" "$ROOT/.env.bak" "$ROOT/backups" "database dump"; do
  assert_contains "$out" "$want" "--dry-run lists $want"
done
assert_contains "$out" "nothing was changed" "--dry-run says nothing changed"
assert_contains "$out" "asf-dev-final.sql.gz" "--dry-run lists the dev database dump"
assert_contains "$out" "nightly dumps in the backups volume" "--dry-run lists the backups volume copy"
assert_not_contains "$(calls)" "rm -f" "--dry-run removes no container"
assert_not_contains "$(calls)" "volume rm" "--dry-run removes no volume"
assert_not_contains "$(calls)" "exec" "--dry-run takes no dump"
[ -f "$ROOT/.env" ] && [ -d "$ROOT/backups" ] && pass || fail "--dry-run keeps .env and ./backups"
assert_not_contains "$out" "ghcr.io" "images are not listed without --images"
assert_not_contains "$out" "c_upd_other" "--dry-run skips another checkout's updater"

# --- no terminal and no --yes: refuse, change nothing -------------------------
seed
out="$(run)"; code=$?
assert_eq "$code" "2" "no terminal without --yes exits 2"
assert_contains "$out" "--yes" "refusal names --yes"
assert_not_contains "$(calls)" "volume rm" "refusal removes nothing"
[ -f "$ROOT/.env" ] && pass || fail "refusal keeps .env"

# --- --yes: safety copy, then everything is removed ---------------------------
seed
BK="$TMP/safety"
out="$(run --yes --backup-dir "$BK")"; code=$?
assert_eq "$code" "0" "--yes uninstall exits 0"
c="$(calls)"
for want in "rm -f c_upd" "rm -f c_pg" "rm -f c_wrk" "rm -f c_sup" "rm -f c_devpg" "volume rm asf_pgdata" "volume rm asf_worktrees" "volume rm asf_runs" "volume rm asf_backups" "volume rm devasf_pgdata" "network rm asf_default" "network rm devasf_default"; do
  assert_contains "$c" "$want" "--yes runs: docker $want"
done
assert_not_contains "$c" "image rm" "images are kept without --images"
assert_not_contains "$c" "rm -f c_upd_other" "an updater for another checkout is left alone"
# Order: the updater goes before the stack; the dump before any removal.
first_rm="$(grep -n '^rm -f' "$STATE/calls" | head -1)"
assert_contains "$first_rm" "c_upd" "the updater container is removed first"
dump_line="$(grep -n '^exec' "$STATE/calls" | head -1 | cut -d: -f1)"
rm_line="$(grep -n '^rm -f\|^volume rm' "$STATE/calls" | head -1 | cut -d: -f1)"
[ -n "$dump_line" ] && [ "$dump_line" -lt "$rm_line" ] && pass || fail "database dump happens before anything is removed"
assert_contains "$(grep '^exec' "$STATE/calls")" "c_pg pg_dump -U asf asf" "dump runs pg_dump in the self-host postgres"
assert_contains "$(grep '^exec' "$STATE/calls")" "c_devpg pg_dump -U asf asf" "dump runs pg_dump in the dev-mode postgres too"
gunzip -c "$BK/asf-dev-final.sql.gz" 2>/dev/null | grep -q 'c_devpg' && pass || fail "safety copy has the dev database dump"
[ -f "$BK/backups-volume/asf-2026-10-18.sql.gz" ] && pass || fail "safety copy has the nightly dumps from the backups volume"
assert_contains "$c" "cp c_bak:/backups/." "backups volume copied via the backup container"
[ ! -e "$ROOT/.env" ] && [ ! -e "$ROOT/.env.bak" ] && [ ! -e "$ROOT/backups" ] && pass || fail "--yes removes .env, .env.bak and ./backups"
[ -s "$BK/asf-final.sql.gz" ] && pass || fail "safety copy has the database dump"
gunzip -c "$BK/asf-final.sql.gz" 2>/dev/null | grep -q 'PostgreSQL database dump' && pass || fail "the dump is a valid gzip of pg_dump output"
[ -f "$BK/.env" ] && grep -q ASF_SECRET_KEY "$BK/.env" && pass || fail "safety copy has .env (with ASF_SECRET_KEY)"
[ -f "$BK/backups/asf-manual-1.sql.gz" ] && pass || fail "safety copy has ./backups"
perm="$(stat -c '%a' "$BK" 2>/dev/null || stat -f '%Lp' "$BK")"
assert_eq "$perm" "700" "safety copy dir is chmod 700"
perm="$(stat -c '%a' "$BK/.env" 2>/dev/null || stat -f '%Lp' "$BK/.env")"
assert_eq "$perm" "600" "copied .env is chmod 600"
assert_contains "$out" "ASF is uninstalled" "success banner"
assert_contains "$out" "./scripts/setup.sh" "points at setup.sh to start fresh"

# --- the backup dir must not clobber an earlier safety copy -------------------
seed
out="$(run --yes --backup-dir "$BK")"; code=$?
assert_eq "$code" "1" "a non-empty --backup-dir is refused"
assert_not_contains "$(calls)" "volume rm" "refused backup dir removes nothing"
[ -f "$ROOT/.env" ] && pass || fail "refused backup dir keeps .env"

# --- a failed dump stops before anything is removed ---------------------------
seed
touch "$STATE/dump-fail"
out="$(run --yes --backup-dir "$TMP/safety-fail")"; code=$?
assert_eq "$code" "1" "a failed dump exits 1"
assert_contains "$out" "failed, so nothing was removed" "a failed dump says so"
assert_not_contains "$(calls)" "rm -f" "a failed dump removes no container"
assert_not_contains "$(calls)" "volume rm" "a failed dump removes no volume"
[ -f "$ROOT/.env" ] && pass || fail "a failed dump keeps .env"
[ ! -e "$TMP/safety-fail/asf-final.sql.gz" ] && pass || fail "a failed dump leaves no partial dump file"

# --- --no-backup: no dump, no copy -------------------------------------------
seed
out="$(run --yes --no-backup)"; code=$?
assert_eq "$code" "0" "--no-backup exits 0"
assert_not_contains "$(calls)" "exec" "--no-backup takes no dump"
assert_contains "$(calls)" "volume rm asf_pgdata" "--no-backup still removes the database volume"
assert_not_contains "$out" "Safety copy:" "--no-backup prints no safety-copy path"

# --- --images removes the images the stack used ------------------------------
seed
out="$(run --yes --no-backup --images)"; code=$?
assert_eq "$code" "0" "--images exits 0"
c="$(calls)"
assert_contains "$c" "image rm ghcr.io/bennybrau/asf-api:v1.2.0" "--images removes the pulled GHCR image"
assert_contains "$c" "image rm postgres:16-alpine" "--images removes the postgres image"
assert_contains "$c" "image rm sha256:built1" "--images removes images compose built"
assert_eq "$(grep -c 'image rm ghcr.io/bennybrau/asf-api' "$STATE/calls")" "1" "--images removes each image once"

# --- postgres not running: refuse unless --no-backup ---------------------------
seed
rm -f "$STATE/pg.asf"
out="$(run --yes --backup-dir "$TMP/safety-nopg")"; code=$?
assert_eq "$code" "1" "postgres down + backup refuses"
assert_contains "$out" "postgres isn't running for: asf" "postgres down names the project"
assert_not_contains "$(calls)" "volume rm" "postgres down removes nothing"
[ -f "$ROOT/.env" ] && pass || fail "postgres down keeps .env"
out="$(run --dry-run)"; code=$?
assert_eq "$code" "0" "postgres down dry run exits 0"
assert_contains "$out" "a real run refuses" "postgres down dry run warns"
out="$(run --yes --no-backup)"; code=$?
assert_eq "$code" "0" "postgres down + --no-backup uninstalls"
assert_contains "$(calls)" "volume rm asf_pgdata" "postgres down + --no-backup removes the volume"

# --- a truncated dump (no completion line) stops everything -------------------
seed
touch "$STATE/dump-truncated"
out="$(run --yes --backup-dir "$TMP/safety-trunc")"; code=$?
assert_eq "$code" "1" "a truncated dump exits 1"
assert_not_contains "$(calls)" "volume rm" "a truncated dump removes nothing"
[ ! -e "$TMP/safety-trunc/asf-final.sql.gz" ] && pass || fail "a truncated dump is deleted"

# --- backups volume copy failing stops everything -----------------------------
seed
touch "$STATE/cp-fail"
out="$(run --yes --backup-dir "$TMP/safety-cpfail")"; code=$?
assert_eq "$code" "1" "a failed backups-volume copy exits 1"
assert_not_contains "$(calls)" "volume rm" "a failed backups-volume copy removes nothing"

# --- a dev project started from another checkout is left alone ---------------
seed
printf '/somewhere/else/devasf\n' > "$STATE/wd.c_devpg"
out="$(run --yes --no-backup)"; code=$?
assert_eq "$code" "0" "another checkout's dev project: uninstall still succeeds"
assert_contains "$out" "/somewhere/else/devasf" "another checkout's project is named as left alone"
c="$(calls)"
assert_not_contains "$c" "rm -f c_devpg" "another checkout's dev container is kept"
assert_not_contains "$c" "volume rm devasf_pgdata" "another checkout's dev volume is kept"
assert_contains "$c" "volume rm asf_pgdata" "this checkout's stack is still removed"

# --- a self-host project from another checkout is left alone too ------------
seed
for x in c_pg c_reg c_api c_wrk c_sup c_bak; do printf '/other/asf\n' > "$STATE/wd.$x"; done
out="$(run --yes --no-backup)"; code=$?
assert_not_contains "$(calls)" "volume rm asf_pgdata" "another checkout's self-host stack is kept"
assert_contains "$out" "/other/asf" "another checkout's self-host stack is named"

# --- dev volumes with no containers: can't tell whose, left alone -----------
seed
rm -f "$STATE/containers.devasf" "$STATE/pg.devasf"
out="$(run --yes --no-backup)"; code=$?
assert_eq "$code" "0" "orphan dev volumes: uninstall succeeds"
assert_not_contains "$(calls)" "volume rm devasf_pgdata" "orphan dev volume is kept (name is only a guess)"
assert_contains "$out" "no containers to show which checkout" "orphan dev volume is reported"

# --- a volume that can't be removed is reported, exit 1 -----------------------
seed
touch "$STATE/fail-volume-rm"
out="$(run --yes --no-backup)"; code=$?
assert_eq "$code" "1" "a failed volume rm exits 1"
assert_contains "$out" "could not remove volume asf_pgdata" "a failed volume rm is named"
[ ! -e "$ROOT/.env" ] && pass || fail "files are still removed after a docker problem"

# --- host worker on macOS: launchd agent + ~/.asf ------------------------------
seed
mkdir -p "$FAKE_HOME/Library/LaunchAgents" "$FAKE_HOME/.asf/logs"
touch "$FAKE_HOME/Library/LaunchAgents/com.asf.worker.plist" "$FAKE_HOME/.asf/worker.env" "$STATE/launchd-loaded"
out="$(FAKE_UNAME=Darwin run --yes --no-backup)"; code=$?
assert_eq "$code" "0" "macOS host worker uninstall exits 0"
assert_contains "$(calls)" "launchctl bootout gui/" "macOS: launchd agent booted out"
[ ! -e "$FAKE_HOME/Library/LaunchAgents/com.asf.worker.plist" ] && pass || fail "macOS: plist removed"
[ ! -e "$FAKE_HOME/.asf" ] && pass || fail "macOS: ~/.asf removed"
# The worker stops before the stack goes, so it can't write mid-removal.
boot="$(grep -n 'launchctl bootout' "$STATE/calls" | head -1 | cut -d: -f1)"
rm1="$(grep -n '^rm -f' "$STATE/calls" | head -1 | cut -d: -f1)"
[ -n "$boot" ] && [ "$boot" -lt "$rm1" ] && pass || fail "host worker stops before containers are removed"

# --- host worker on Linux: systemd --user unit ---------------------------------
seed
mkdir -p "$FAKE_HOME/.config/systemd/user" "$FAKE_HOME/.asf"
touch "$FAKE_HOME/.config/systemd/user/asf-worker.service"
out="$(FAKE_UNAME=Linux run --yes --no-backup)"; code=$?
assert_eq "$code" "0" "Linux host worker uninstall exits 0"
assert_contains "$(calls)" "systemctl --user disable --now asf-worker.service" "Linux: unit disabled and stopped"
assert_contains "$(calls)" "systemctl --user daemon-reload" "Linux: systemd reloaded"
[ ! -e "$FAKE_HOME/.config/systemd/user/asf-worker.service" ] && pass || fail "Linux: unit file removed"
[ ! -e "$FAKE_HOME/.asf" ] && pass || fail "Linux: ~/.asf removed"

# --- docker daemon down: refuse, change nothing ------------------------------
seed
mkdir -p "$FAKE_HOME/.asf"
touch "$STATE/daemon-down"
out="$(run --yes --no-backup)"; code=$?
assert_eq "$code" "1" "daemon down exits 1"
assert_contains "$out" "Docker isn't reachable" "daemon down is reported"
assert_contains "$out" "nothing was changed" "daemon down says nothing changed"
[ -f "$ROOT/.env" ] && [ -d "$FAKE_HOME/.asf" ] && pass || fail "daemon down keeps .env and ~/.asf"

# --- docker not installed at all ---------------------------------------------
seed
out="$( cd "$ROOT" && HOME="$FAKE_HOME" FAKE_STATE="$STATE" FAKE_ROOT="$ROOT" PATH="$NODOCKER_BIN" ./scripts/uninstall.sh --dry-run </dev/null 2>&1 )"; code=$?
assert_eq "$code" "0" "dry run without docker exits 0"
assert_contains "$out" "Docker isn't reachable" "no docker is reported"
assert_contains "$out" "$ROOT/.env" "no docker still lists files"

# --- nothing installed --------------------------------------------------------
seed
rm -rf "$ROOT/.env" "$ROOT/.env.bak" "$ROOT/backups"
for f in "$STATE"/containers.* "$STATE"/volumes.* "$STATE"/networks.* "$STATE"/updaters "$STATE"/pg.*; do rm -f "$f"; done
out="$(run --yes)"; code=$?
assert_eq "$code" "0" "nothing installed exits 0"
assert_contains "$out" "nothing to remove" "nothing installed says so"
touch "$STATE/daemon-down"
out="$(run --yes)"; code=$?
assert_eq "$code" "1" "nothing found but docker down exits 1"
assert_not_contains "$out" "nothing to remove" "docker down doesn't claim there's nothing"

# --- an empty HOME is refused (rm -rf $HOME/.asf would be /.asf) ----------------
out="$( cd "$ROOT" && HOME="" PATH="$FAKE_BIN:$PATH" ./scripts/uninstall.sh --dry-run </dev/null 2>&1 )"; code=$?
assert_eq "$code" "2" "empty HOME exits 2"

# --- project name comes from the compose file --------------------------------
seed
sed -i.orig 's/^name: asf$/name: asfclean/' "$ROOT/docker-compose.self-host.yml"
out="$(run --dry-run)"
assert_contains "$(calls)" "com.docker.compose.project=asfclean" "project name read from docker-compose.self-host.yml"
mv "$ROOT/docker-compose.self-host.yml.orig" "$ROOT/docker-compose.self-host.yml"

printf '\nuninstall.test.sh: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
