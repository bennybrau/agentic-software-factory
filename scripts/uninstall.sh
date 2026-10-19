#!/usr/bin/env bash
#
# ASF uninstall: remove everything scripts/setup.sh put on this machine, so the
# next ./scripts/setup.sh starts from nothing.
#
#   ./scripts/uninstall.sh                 # list what will go, ask, back up, remove
#   ./scripts/uninstall.sh --dry-run       # only list what would be removed
#   ./scripts/uninstall.sh --yes           # no prompt (needed when there is no terminal)
#   ./scripts/uninstall.sh --images        # also delete the ASF Docker images
#   ./scripts/uninstall.sh --no-backup     # skip the safety copy (data is gone for good)
#
# What it removes:
#   - the Docker compose project (containers, volumes incl. the database, network),
#     plus any updater container the in-app updater left behind
#   - the dev-mode Postgres project (docker-compose.yml, `setup.sh --mode 3`)
#   - the host worker (mode 2): launchd agent / systemd --user unit and ~/.asf
#   - .env, .env.bak and ./backups in this checkout
#
# What it keeps: this checkout, Docker / Rancher Desktop, your `claude login`, gcloud
# credentials, and every other container on the machine.
#
# Before removing anything it saves a safety copy (database dumps, the nightly dumps
# in the backups volume, .env, ./backups) to ~/asf-uninstall-<timestamp>/ unless
# --no-backup is given. It changes nothing when Docker is down, when a database
# can't be dumped, or when a compose project was started from another checkout.
set -euo pipefail
umask 077   # the safety copy holds .env and database dumps

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Physical path: Docker records the resolved path in its labels and bind mounts.
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
cd "$ROOT"

# shellcheck source=scripts/lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

case "${HOME:-}" in ""|/) printf 'uninstall.sh: HOME is not set to a home directory\n' >&2; exit 2 ;; esac

ENV_FILE="$ROOT/.env"
SELF_HOST_COMPOSE="$ROOT/docker-compose.self-host.yml"
LAUNCHD_LABEL="com.asf.worker"
PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
SYSTEMD_SERVICE="asf-worker.service"
SYSTEMD_UNIT="$HOME/.config/systemd/user/${SYSTEMD_SERVICE}"
HOST_HOME="$HOME/.asf"
UPDATER_LABEL="asf.updater"

usage() {
  cat <<'EOF'
ASF uninstall: remove this machine's ASF install so setup.sh can start fresh.

Usage: scripts/uninstall.sh [options]

  --dry-run          list what would be removed, change nothing
  --yes, -y          do not ask for confirmation (required without a terminal)
  --images           also delete the ASF Docker images (next setup pulls/builds again)
  --no-backup        skip the safety copy (database dumps, .env, ./backups and the
                     nightly dumps in the backups volume); needed when postgres
                     can't be started to dump
  --backup-dir DIR   where to put the safety copy (default: ~/asf-uninstall-<timestamp>)
  --help             show this help

Removes: the compose project's containers, volumes (the database, worktrees, runs,
backups) and network; the dev-mode Postgres; the host worker (launchd/systemd unit
and ~/.asf); .env, .env.bak and ./backups in this checkout.

Keeps: this checkout, Docker itself, Claude/gcloud logins, other containers.
EOF
}

DRY_RUN=0
YES=0
IMAGES=0
BACKUP=1
BACKUP_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --images) IMAGES=1; shift ;;
    --no-backup) BACKUP=0; shift ;;
    --backup-dir) [ -n "${2:-}" ] || die "--backup-dir needs a directory" 2; BACKUP_DIR="$2"; shift 2 ;;
    --backup-dir=*) BACKUP_DIR="${1#*=}"; [ -n "$BACKUP_DIR" ] || die "--backup-dir needs a directory" 2; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$BACKUP_DIR" ] || BACKUP_DIR="$HOME/asf-uninstall-$(date +%Y%m%d-%H%M%S)"

ERRORS=0
err() { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$1"; [ -n "${2:-}" ] && printf '      %s%s%s\n' "$C_DIM" "$2" "$C_RESET"; ERRORS=$((ERRORS + 1)); return 0; }

# --- names ------------------------------------------------------------------
# The self-host project name is the `name:` in docker-compose.self-host.yml ("asf").
compose_project_name() {
  local n=""
  [ -f "$SELF_HOST_COMPOSE" ] && n="$(sed -n 's/^name:[[:space:]]*//p' "$SELF_HOST_COMPOSE" | head -1 | tr -d "\"'\r" | sed 's/[[:space:]]*#.*$//; s/[[:space:]]*$//')"
  printf '%s' "${n:-asf}"
}
# Dev mode (`setup.sh --mode 3`) runs docker-compose.yml, which has no `name:`, so
# compose names the project after this directory: lowercase, [a-z0-9_-] only, no
# leading - or _. Another checkout with the same directory name gets the same
# project name, so project_owned() checks whose it is before anything is taken.
dev_project_name() {
  basename "$ROOT" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-' | sed 's/^[-_]*//'
}
PROJECT="$(compose_project_name)"
DEV_PROJECT="$(dev_project_name)"
PROJECTS="$PROJECT"
[ -n "$DEV_PROJECT" ] && [ "$DEV_PROJECT" != "$PROJECT" ] && PROJECTS="$PROJECT $DEV_PROJECT"

# --- discovery --------------------------------------------------------------
DOCKER_OK=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then DOCKER_OK=1; fi

lines() { # one item per line, blanks dropped
  grep -v '^[[:space:]]*$' || true
}
# Every docker call tolerates failure: under pipefail a failed listing would
# otherwise abort the script halfway through an assignment.
project_containers() { { docker ps -aq --filter "label=com.docker.compose.project=$1" 2>/dev/null || true; } | lines; }
project_volumes()    { { docker volume ls -q --filter "label=com.docker.compose.project=$1" 2>/dev/null || true; } | lines; }
project_networks()   { { docker network ls -q --filter "label=com.docker.compose.project=$1" 2>/dev/null || true; } | lines; }
# The in-app updater runs in its own container (label asf.updater=1) with this
# checkout bind-mounted at the same path. Only take the ones bound to THIS
# checkout: another install's update is not ours to kill.
updater_containers() {
  local c
  for c in $({ docker ps -aq --filter "label=${UPDATER_LABEL}=1" 2>/dev/null || true; } | lines); do
    { docker inspect --format '{{range .HostConfig.Binds}}{{println .}}{{end}}' "$c" 2>/dev/null || true; } \
      | awk -v r="${ROOT}:" 'index($0, r) == 1 { found = 1 } END { exit !found }' && printf '%s\n' "$c"
  done
  return 0
}
describe_container() { { docker inspect --format '{{.Name}}' "$1" 2>/dev/null || printf '%s' "$1"; } | sed 's#^/##'; }
describe_volume()    { printf '%s' "$1"; }
describe_network()   { docker network inspect --format '{{.Name}}' "$1" 2>/dev/null || printf '%s' "$1"; }

# Images the project's containers run, plus images compose built for it.
project_images() { # $1 = project ; image refs, one per line, deduped
  local c
  {
    for c in $(project_containers "$1"); do docker inspect --format '{{.Config.Image}}' "$c" 2>/dev/null || true; done
    docker images -q --filter "label=com.docker.compose.project=$1" 2>/dev/null || true
  } | lines | sort -u
}

# Whether a compose project belongs to this checkout. Compose stamps each container
# with the directory it was started from; volumes and networks carry only the
# project name. A project whose containers came from another directory is another
# install's, and is left alone. With no containers left there is nothing to check
# against: the self-host project (a fixed name from our compose file) is taken, a
# dev project (a guess from the directory name) is not.
SKIPPED=""
project_owned() { # $1 = project, $2 = 1 if the name is only a guess
  local c dir mine=0 other=""
  for c in $(project_containers "$1"); do
    dir="$({ docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$c" 2>/dev/null || true; } | head -1)"
    if [ "$dir" = "$ROOT" ]; then mine=1; else other="${dir:-unknown}"; fi
  done
  if [ -n "$other" ]; then
    SKIPPED="${SKIPPED}  compose project '$1' was started from ${other}, not this checkout
"
    return 1
  fi
  [ "$mine" -eq 1 ] && return 0
  [ "$2" -eq 1 ] && [ -n "$(project_volumes "$1")$(project_networks "$1")" ] && SKIPPED="${SKIPPED}  compose project '$1' has volumes but no containers to show which checkout made it (remove by hand: docker volume ls --filter label=com.docker.compose.project=$1)
"
  [ "$2" -eq 0 ]
}

host_worker_installed() {
  case "$(uname -s)" in
    Darwin) [ -f "$PLIST" ] || launchctl print "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1 ;;
    *)      [ -f "$SYSTEMD_UNIT" ] ;;
  esac
}

CONTAINERS=""; VOLUMES=""; NETWORKS=""; UPDATERS=""; IMAGE_REFS=""
if [ "$DOCKER_OK" -eq 1 ]; then
  UPDATERS="$(updater_containers)"
  OWNED=""
  for p in $PROJECTS; do
    guess=0; [ "$p" = "$PROJECT" ] || guess=1
    project_owned "$p" "$guess" || continue
    OWNED="$OWNED $p"
    CONTAINERS="$CONTAINERS
$(project_containers "$p")"
    VOLUMES="$VOLUMES
$(project_volumes "$p")"
    NETWORKS="$NETWORKS
$(project_networks "$p")"
    [ "$IMAGES" -eq 1 ] && IMAGE_REFS="$IMAGE_REFS
$(project_images "$p")"
  done
  CONTAINERS="$(printf '%s\n' "$CONTAINERS" | lines)"
  VOLUMES="$(printf '%s\n' "$VOLUMES" | lines)"
  NETWORKS="$(printf '%s\n' "$NETWORKS" | lines)"
  IMAGE_REFS="$(printf '%s\n' "$IMAGE_REFS" | lines | sort -u)"
fi

HOST_WORKER=0; host_worker_installed && HOST_WORKER=1
FILES=""
for f in "$ENV_FILE" "$ENV_FILE.bak" "$ROOT/backups"; do [ -e "$f" ] && FILES="$FILES
$f"; done
[ -d "$HOST_HOME" ] && FILES="$FILES
$HOST_HOME"
FILES="$(printf '%s\n' "$FILES" | lines)"

count() { printf '%s\n' "$1" | lines | wc -l | tr -d ' '; }

# --- plan -------------------------------------------------------------------
section "ASF uninstall — $ROOT"
if [ "$DOCKER_OK" -eq 0 ]; then
  warn "Docker isn't reachable, so containers and volumes can't be listed." "start Docker / Rancher Desktop first"
fi
if [ -n "$SKIPPED" ]; then
  warn "left alone (not this checkout's):"
  printf '%s' "$SKIPPED" | while IFS= read -r l; do info "$l"; done
fi

nothing=1
if [ -n "$UPDATERS" ]; then nothing=0; info "Updater containers ($(count "$UPDATERS")):"; for c in $UPDATERS; do info "  $(describe_container "$c")"; done; fi
if [ -n "$CONTAINERS" ]; then nothing=0; info "Containers ($(count "$CONTAINERS")):"; for c in $CONTAINERS; do info "  $(describe_container "$c")"; done; fi
if [ -n "$VOLUMES" ]; then nothing=0; info "Volumes ($(count "$VOLUMES")) — includes the database:"; for v in $VOLUMES; do info "  $(describe_volume "$v")"; done; fi
if [ -n "$NETWORKS" ]; then nothing=0; info "Networks ($(count "$NETWORKS")):"; for n in $NETWORKS; do info "  $(describe_network "$n")"; done; fi
if [ -n "$IMAGE_REFS" ]; then nothing=0; info "Images ($(count "$IMAGE_REFS")):"; for i in $IMAGE_REFS; do info "  $i"; done; fi
if [ "$HOST_WORKER" -eq 1 ]; then
  nothing=0
  case "$(uname -s)" in
    Darwin) info "Host worker: launchd agent ${LAUNCHD_LABEL} (${PLIST})" ;;
    *)      info "Host worker: systemd --user ${SYSTEMD_SERVICE} (${SYSTEMD_UNIT})" ;;
  esac
fi
if [ -n "$FILES" ]; then nothing=0; info "Files:"; for f in $FILES; do info "  $f"; done; fi

if [ "$nothing" -eq 1 ]; then
  if [ "$DOCKER_OK" -eq 1 ]; then ok "nothing to remove: no ASF install found for this checkout"; exit 0; fi
  info "no ASF files or host worker found; containers and volumes couldn't be checked"
  exit 1
fi

# What the safety copy takes, per project this checkout owns: a pg_dump from its
# running postgres, and the nightly dumps in the backups volume (via the backup
# service's container, running or not). A project with volumes but no running
# postgres can't be dumped, so the uninstall refuses unless --no-backup.
DUMPS=""         # "container file" pairs, one per line
NO_DUMP=""       # projects whose database can't be dumped
BACKUP_SRC=""    # backup-service container holding /backups
pg_running() { { docker ps -q --filter "label=com.docker.compose.project=$1" --filter "label=com.docker.compose.service=postgres" 2>/dev/null || true; } | lines | head -1; }
if [ "$DOCKER_OK" -eq 1 ]; then
  for p in $OWNED; do
    [ -n "$(project_volumes "$p")" ] || continue
    pg="$(pg_running "$p")"
    if [ "$p" = "$PROJECT" ]; then f="asf-final.sql.gz"; else f="asf-dev-final.sql.gz"; fi
    if [ -n "$pg" ]; then DUMPS="${DUMPS}${pg} ${f}
"; else NO_DUMP="$NO_DUMP $p"; fi
  done
  case " $OWNED " in *" $PROJECT "*)
    BACKUP_SRC="$({ docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=backup" 2>/dev/null || true; } | lines | head -1)" ;;
  esac
fi

if [ "$BACKUP" -eq 1 ]; then
  info ""
  info "A safety copy goes to $BACKUP_DIR first:"
  printf '%s' "$DUMPS" | while read -r _ f; do [ -n "$f" ] && info "  database dump ($f)"; done
  [ -n "$BACKUP_SRC" ] && info "  the nightly dumps in the backups volume"
  [ -f "$ENV_FILE" ] && info "  .env (holds ASF_SECRET_KEY, which a restore needs)"
  [ -d "$ROOT/backups" ] && info "  ./backups"
else
  info ""
  info "No safety copy (--no-backup): the database and saved settings are gone for good."
fi

if [ "$DRY_RUN" -eq 1 ]; then
  [ "$BACKUP" -eq 1 ] && [ -n "$NO_DUMP" ] && warn "postgres isn't running for:${NO_DUMP} — a real run refuses until it is (or --no-backup)"
  section "Dry run — nothing was changed"
  exit 0
fi

# Refuse before changing anything when part of the install can't be handled.
[ "$DOCKER_OK" -eq 1 ] || die "Docker isn't reachable, so the database can't be removed — start Docker and re-run (nothing was changed)"
if [ "$BACKUP" -eq 1 ] && [ -n "$NO_DUMP" ]; then
  die "postgres isn't running for:${NO_DUMP}, so the database can't be saved first. Start it (scripts/asf up, or docker compose up -d postgres for dev mode) and re-run, or pass --no-backup to delete it unsaved (nothing was changed)"
fi

# --- confirm ----------------------------------------------------------------
if [ "$YES" -ne 1 ]; then
  if [ ! -t 0 ]; then die "no terminal to confirm on — re-run with --yes to uninstall" 2; fi
  printf '\n  This deletes the factory'"'"'s database and settings. Type %suninstall%s to continue: ' "$C_BOLD" "$C_RESET"
  read -r reply || reply=""
  [ "$reply" = "uninstall" ] || { info "aborted — nothing was changed"; exit 1; }
fi

# --- safety copy ------------------------------------------------------------
if [ "$BACKUP" -eq 1 ]; then
  section "Safety copy"
  if [ -e "$BACKUP_DIR" ] && [ -n "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]; then
    die "$BACKUP_DIR already exists and is not empty — pick another with --backup-dir"
  fi
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  while read -r pg f; do
    [ -n "$pg" ] || continue
    dump="$BACKUP_DIR/$f"
    # pg_dump ends a complete dump with this line; a truncated one doesn't.
    if docker exec "$pg" pg_dump -U asf asf 2>/dev/null | gzip > "$dump" \
      && gzip -t "$dump" 2>/dev/null \
      && gunzip -c "$dump" 2>/dev/null | tail -n 5 | grep -q 'PostgreSQL database dump complete'; then
      ok "database dumped to $dump"
    else
      rm -f "$dump"
      die "the database dump ($f) failed, so nothing was removed (re-run with --no-backup to skip it)"
    fi
  done <<EOF
$DUMPS
EOF
  if [ -n "$BACKUP_SRC" ]; then
    mkdir -p "$BACKUP_DIR/backups-volume"
    if docker cp "$BACKUP_SRC:/backups/." "$BACKUP_DIR/backups-volume" >/dev/null 2>&1; then
      ok "copied the nightly dumps from the backups volume"
    else
      die "could not copy the backups volume, so nothing was removed (re-run with --no-backup to skip it)"
    fi
  fi
  if [ -f "$ENV_FILE" ]; then cp "$ENV_FILE" "$BACKUP_DIR/.env"; chmod 600 "$BACKUP_DIR/.env"; ok "copied .env"; fi
  if [ -d "$ROOT/backups" ]; then cp -R "$ROOT/backups" "$BACKUP_DIR/backups"; ok "copied ./backups"; fi
fi

# --- host worker ------------------------------------------------------------
if [ "$HOST_WORKER" -eq 1 ]; then
  section "Host worker"
  if [ "$(uname -s)" = "Darwin" ]; then
    launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null \
      || launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    if launchctl print "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1; then
      err "launchd agent ${LAUNCHD_LABEL} is still loaded" "launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}"
    else
      ok "stopped launchd agent ${LAUNCHD_LABEL}"
    fi
    if [ -e "$PLIST" ]; then rm -f "$PLIST"; ok "removed $PLIST"; fi
  else
    systemctl --user disable --now "$SYSTEMD_SERVICE" >/dev/null 2>&1 || true
    if [ -e "$SYSTEMD_UNIT" ]; then rm -f "$SYSTEMD_UNIT"; ok "removed $SYSTEMD_UNIT"; fi
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
fi

# --- docker -----------------------------------------------------------------
if [ "$DOCKER_OK" -eq 1 ]; then
  section "Docker"
  # Updaters first: one mid-run would recreate the stack we are removing.
  for c in $UPDATERS $CONTAINERS; do
    name="$(describe_container "$c")"
    if docker rm -f "$c" >/dev/null 2>&1; then ok "removed container ${name:-$c}"
    else err "could not remove container ${name:-$c}" "docker rm -f $c"; fi
  done
  for v in $VOLUMES; do
    if docker volume rm "$v" >/dev/null 2>&1; then ok "removed volume $v"
    else err "could not remove volume $v" "docker volume rm $v"; fi
  done
  for n in $NETWORKS; do
    name="$(describe_network "$n")"
    if docker network rm "$n" >/dev/null 2>&1; then ok "removed network ${name:-$n}"
    else err "could not remove network ${name:-$n}" "docker network rm $n"; fi
  done
  for i in $IMAGE_REFS; do
    # An image another container still uses stays; that's not ours to break.
    if docker image rm "$i" >/dev/null 2>&1; then ok "removed image $i"
    else warn "kept image $i (in use elsewhere, or already gone)"; fi
  done
fi

# --- files ------------------------------------------------------------------
section "Files"
for f in "$ENV_FILE" "$ENV_FILE.bak"; do if [ -e "$f" ]; then rm -f "$f"; ok "removed $f"; fi; done
[ -d "$ROOT/backups" ] && rm -rf "$ROOT/backups" && ok "removed $ROOT/backups"
[ -d "$HOST_HOME" ] && rm -rf "$HOST_HOME" && ok "removed $HOST_HOME"

# --- done -------------------------------------------------------------------
if [ "$ERRORS" -gt 0 ]; then
  section "Finished with $ERRORS problem(s) — see ✗ above"
else
  section "ASF is uninstalled"
fi
[ "$BACKUP" -eq 1 ] && info "Safety copy: $BACKUP_DIR (delete it when you no longer need it)"
info "Kept: this checkout ($ROOT), Docker, your Claude/gcloud logins."
info "Start fresh:  ./scripts/setup.sh"
[ "$ERRORS" -eq 0 ] || exit 1
