#!/bin/sh
#
# Container entrypoint. Runs as root only long enough to make the volume usable,
# then drops to an unprivileged uid permanently and execs the server.
#
# ── Why this file exists at all ───────────────────────────────────────────────
#
# Railway mounts a volume when the container *starts*, not when the image is built,
# and the mount is root-owned. Both halves of that matter:
#
#   * A `chown` in the Dockerfile is erased. The image's /data is replaced by the
#     mount, so whatever ownership the build set is simply not there any more.
#   * A process that is already uid 10001 when the mount appears cannot create
#     panel.db inside it. It fails with EACCES on the first write, at boot, on a
#     deployment that looked fine until then.
#
# So something has to run as root after the mount and before the server. That
# something must then stop being root, because Phase 3 spawns agent processes as
# children of the server and a root panel makes every one of them root.
#
# ── The three rules this file is built around ─────────────────────────────────
#
#  1. **Never `chown -R`.** /data will grow to hold project checkouts, and a
#     recursive chown over those on every boot is a multi-minute startup that gets
#     slower forever. Only the top level and the known layout are touched, and only
#     when the ownership is actually wrong — the no-op path is a handful of stat(2)
#     calls and it prints its own cost.
#  2. **`exec`, so the server is pid 1** and receives SIGTERM directly from the
#     container runtime. `setpriv` replaces this shell and is in turn replaced by
#     node, so there is no wrapper process in between to swallow signals.
#  3. **`setpriv`, not `su` and not a `gosu` download.** util-linux is already in
#     bookworm-slim, and `setpriv --reuid` sets the *saved* set-user-ID as well as
#     the real and effective ones — which is the difference between a permanent drop
#     and a process that can call `setuid(0)` and get root back. The server asserts
#     that at boot (`utils/privileges.ts`) rather than trusting this comment.
#
set -eu

PANEL_UID="${PANEL_UID:-10001}"
PANEL_GID="${PANEL_GID:-10001}"

# Railway exposes the mount path; PANEL_DATA_DIR is what the server reads. Resolve
# once here and export it, so the directory this script prepares and the directory
# the server opens can never be two different places.
DATA_DIR="${PANEL_DATA_DIR:-${RAILWAY_VOLUME_MOUNT_PATH:-/data}}"
export PANEL_DATA_DIR="$DATA_DIR"

log() {
  echo "[entrypoint] $*"
}

die() {
  echo "[entrypoint] FATAL: $*" >&2
  exit 1
}

# Milliseconds since the epoch. `date +%s%N` is nanoseconds; dash has no floating
# point, so the division is integer and that is fine for a timer.
now_ms() {
  echo $(($(date +%s%N) / 1000000))
}

# The known layout, mirroring ensureDataLayout() in src/server/app.ts. Kept as an
# explicit list precisely so this is not a recursive walk.
LAYOUT_DIRS="
$DATA_DIR
$DATA_DIR/home
$DATA_DIR/config
$DATA_DIR/global
$DATA_DIR/global/claude-home
$DATA_DIR/projects
$DATA_DIR/logs
$DATA_DIR/exports
$DATA_DIR/exports/incoming
"

# Files at the top level that the server must be able to write. They do not exist on
# a first boot; on every boot after that they must not be root-owned, which is what a
# single run with a broken entrypoint would leave behind.
LAYOUT_FILES="
$DATA_DIR/panel.db
$DATA_DIR/panel.db-wal
$DATA_DIR/panel.db-shm
$DATA_DIR/config/instance.json
"

# Sets ownership on one path, but only if it is not already correct. The `stat` is
# the whole optimisation: chown(2) on an unchanged path still dirties the inode and,
# multiplied by a volume full of project files, is the difference between a boot and
# an outage.
CHECKED=0
CHANGED=0
fix_owner() {
  target="$1"
  [ -e "$target" ] || return 0
  CHECKED=$((CHECKED + 1))
  current="$(stat -c '%u:%g' "$target")"
  if [ "$current" != "${PANEL_UID}:${PANEL_GID}" ]; then
    chown "${PANEL_UID}:${PANEL_GID}" "$target"
    CHANGED=$((CHANGED + 1))
  fi
}

prepare_as_root() {
  started="$(now_ms)"

  for dir in $LAYOUT_DIRS; do
    [ -d "$dir" ] || mkdir -p "$dir"
  done
  for dir in $LAYOUT_DIRS; do
    fix_owner "$dir"
  done
  for file in $LAYOUT_FILES; do
    fix_owner "$file"
  done

  elapsed=$(( $(now_ms) - started ))
  log "ownership pass: ${CHECKED} paths checked, ${CHANGED} changed, ${elapsed}ms"
}

# `id -u` rather than a $UID that dash does not set.
CURRENT_UID="$(id -u)"

if [ "$CURRENT_UID" = "0" ]; then
  command -v setpriv >/dev/null 2>&1 ||
    die "setpriv is not installed. It comes from util-linux; the runtime stage of the Dockerfile installs it. Without it this container cannot drop privileges, and it will not serve as root."

  prepare_as_root

  log "dropping to uid ${PANEL_UID} and exec'ing the server"
  # --clear-groups   drops root's supplementary groups, which --reuid does not.
  # --no-new-privs   sets PR_SET_NO_NEW_PRIVS: no setuid binary in this container can
  #                  hand privilege back, so the drop holds for every child too —
  #                  which matters because Phase 3's children are agent processes.
  exec setpriv \
    --reuid "$PANEL_UID" \
    --regid "$PANEL_GID" \
    --clear-groups \
    --no-new-privs \
    -- "$@"
fi

# Not root. There is nothing to drop, so the only question is whether the volume is
# already usable — and if it is not, the honest outcome is to refuse rather than to
# start and fail on the first write with a stack trace the operator has to decode.
log "already running as uid ${CURRENT_UID}; no privilege drop needed"

# Whether the directory is usable is settled by *trying*, not by inspecting. It may not
# exist yet and still be perfectly fine — a `PANEL_DATA_DIR` under a writable parent, a
# local `docker run` with no volume — and a bare `[ -d ]` test would refuse those with a
# message about Railway volumes that has nothing to do with them. `-w` alone can also
# lie under an ACL, so the probe writes a file and removes it, which is the same thing
# checkDataWritable() does in the server for the same reason.
mkdir -p "$DATA_DIR" 2>/dev/null || true
probe="$DATA_DIR/.entrypoint-write-probe.$$"
if ! { [ -d "$DATA_DIR" ] && touch "$probe" 2>/dev/null; }; then
  die "$(
    cat <<MESSAGE

  $DATA_DIR could not be created or written by uid $CURRENT_UID, and this container
  is not root, so it cannot fix that itself.

  On Railway this means the service is running as a non-root uid while the volume
  mount is root-owned. The fix is one variable:

      RAILWAY_RUN_UID=0

  That starts the container as root; this entrypoint then fixes ownership of the
  volume and drops to uid $PANEL_UID before the server starts, so the panel itself
  never runs as root. See "Why RAILWAY_RUN_UID=0 is not a security regression" in
  docs/DEPLOY.md.

  Refusing to start rather than degrading.
MESSAGE
  )"
fi
rm -f "$probe"
log "$DATA_DIR is writable by uid ${CURRENT_UID}"

exec "$@"
