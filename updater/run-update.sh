#!/bin/sh
# One self-host update to a release tag. Runs inside the updater container.
# The build happens BEFORE the swap, so a failed build never touches the running web container.
# Paths default to the container layout and can be pointed at a temp dir by the unit test.
# Exit: 0 ok · 10 rolled back · 20 rollback failed · 30 local edits (nothing touched)
#       · 40 could not pause new tasks before the swap (nothing swapped)
#       · 50 stopped before the swap and could not check the old commit back out
#         (the old version is still serving; the updater retries the checkout).
#
# When the updater restarts and finds an update that was cut off:
#   `run-update.sh rollback <commit>` — the swap had begun: rebuild and swap back.
#     Exit: 10 rolled back · 20 rollback failed.
#   `run-update.sh restore <commit>` — before the swap: the old version never stopped,
#     only the deploy folder is left on the new tag; check the old commit back out and
#     release the hold if that run had taken it.
#     Exit: 0 restored.
# Either exits 2 on a bad commit.
set -eu

MODE=update
if [ "${1-}" = rollback ] || [ "${1-}" = restore ]; then
  MODE="$1"
  ROLLBACK_TO="${2-}"
  case "$ROLLBACK_TO" in
    *[!0-9a-f]*|"") echo "==> ERROR not a commit: $ROLLBACK_TO"; exit 2 ;;
  esac
  [ "${#ROLLBACK_TO}" -eq 40 ] || { echo "==> ERROR not a commit: $ROLLBACK_TO"; exit 2; }
fi

TAG="${1-}"
# Same rule as apps/web/lib/release-version.ts: vYYYY.MM.DD or vYYYY.MM.DD.N (N >= 2),
# and a real calendar date. Checked before git, docker, or the deploy folder are touched.
is_release_tag() {
  # A newline inside the tag would let grep match one line of it.
  case "$1" in *"
"*) return 1 ;; esac
  # Years 2000–2099 only: no leading zeros for $(( )) to misread as octal, and no year 0
  # (JavaScript's Date.UTC maps years 0–99 to 1900–1999).
  printf '%s' "$1" | grep -Eq '^v20[0-9]{2}\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])(\.([2-9]|[1-9][0-9]+))?$' || return 1
  y=$(printf '%s' "$1" | cut -c2-5)
  m=$(printf '%s' "$1" | cut -c7-8)
  d=$(printf '%s' "$1" | cut -c10-11)
  # Leading zeros would read as octal in $(( )).
  m=${m#0}
  d=${d#0}
  case "$m" in
    4|6|9|11) max=30 ;;
    2)
      if [ $((y % 4)) -eq 0 ] && { [ $((y % 100)) -ne 0 ] || [ $((y % 400)) -eq 0 ]; }; then max=29; else max=28; fi
      ;;
    *) max=31 ;;
  esac
  [ "$d" -le "$max" ]
}
if [ "$MODE" = update ] && ! is_release_tag "$TAG"; then
  echo "==> ERROR not a release tag: $TAG"
  exit 2
fi

REPO="${UPDATER_REPO_DIR:-/repo}"
STATE="${UPDATER_STATE_DIR:-/state}"
WEB="${UPDATER_WEB_BASE:-http://web:3000}"
cd "$REPO"

token() {
  if [ -r "$STATE/token" ]; then cat "$STATE/token"; fi
}
# -T: busybox wget has no timeout of its own; a web process that accepts the connection
# and never answers would hang the update forever.
web_get() {
  wget -q -T 10 -O- --header "Authorization: Bearer $(token)" "${WEB%/}$1"
}
web_post() {
  wget -q -T 10 -O- --header "Authorization: Bearer $(token)" --header "content-type: application/json" \
    --post-data "$1" "${WEB%/}/api/update/hold"
}

# The container runs as root. Run git as whoever owns the deploy folder, so the
# files it writes stay editable by that user (a root-owned .git breaks the next pull).
OWNER="$(stat -c '%u:%g' "$REPO")"
g() { HOME=/tmp su-exec "$OWNER" git "$@"; }

# Never overwrite a user's edits. No checkout --force. Config belongs in .env.
if [ -n "$(g status --porcelain --untracked-files=no)" ]; then
  echo "==> LOCAL_CHANGES"
  g status --short --untracked-files=no
  exit 30
fi

# A bare `docker compose` would name the project after the mount point ("repo") and
# start a second, empty stack. Target the stack this updater belongs to.
PROJECT="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$(hostname)")"
[ -n "$PROJECT" ] || { echo "==> ERROR cannot read compose project name"; exit 2; }
compose() { docker compose -p "$PROJECT" --project-directory "$REPO" "$@"; }

# Only an explicit "busy":false means idle. A failed request, the login page, or any
# other answer is "not idle yet": swapping on a failed probe would cut running tasks.
WAIT_LIMIT_S="${UPDATER_WAIT_LIMIT_S:-1800}"
wait_idle() {
  i=0
  last=""
  unanswered=0
  deadline=$(( $(date +%s) + WAIT_LIMIT_S ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    # Refresh the hold each poll: it expires 40 minutes after the last refresh, and this
    # wait alone can take that long. Before the first swap a failed refresh stops the
    # update (the hold could lapse); the rollback keeps going, since it must restore.
    if [ "$HELD" = 1 ]; then
      if ! [ "$(web_post '{"hold":true}' 2>/dev/null || true)" = '{"hold":true}' ]; then
        if [ "$MODE" = update ] && [ "$SWAPPED" = 0 ]; then
          echo "==> HOLD_FAILED — could not refresh the pause"
          back_to_from 40
        fi
      fi
    fi
    if BUSY="$(web_get /api/update/busy 2>/dev/null)"; then
      # The whole body, exactly as the route sends it (Response.json); `$(...)` drops
      # the trailing newline. Anything around it (HTML, a proxy page) is unexpected.
      case "$BUSY" in
        '{"busy":false}') return 0 ;;
        '{"busy":true}') seen=busy ;;
        *) seen=unexpected ;;
      esac
    else
      seen=unreachable
    fi
    # Only the wait before the swap is a "waiting" phase. After it the updater's saved phase
    # must stay switching/verifying: a restart in a rollback's wait would otherwise read a
    # pre-swap phase and only check the folder out, leaving the failed new version serving.
    if [ "$i" -eq 0 ] && [ "$MODE" = update ] && [ "$SWAPPED" = 0 ]; then
      echo "==> STEP waiting"
    fi
    if [ "$seen" != "$last" ]; then
      echo "==> BUSY_CHECK $seen"
      last="$seen"
    fi
    # After the swap began, the version being waited on is the new one, which just failed its
    # check. One that fails to answer twice in a row is not running tasks, and waiting out the
    # limit would only keep the broken version serving. An explicit busy:true still waits.
    # The wait before the swap is unchanged.
    if [ "$MODE" = rollback ] || [ "$SWAPPED" = 1 ]; then
      if [ "$seen" = busy ]; then unanswered=0; else unanswered=$((unanswered + 1)); fi
      if [ "$unanswered" -ge 2 ]; then
        echo "==> BUSY_CHECK the new version does not answer — the rollback goes ahead"
        return 0
      fi
    fi
    i=$((i + 1))
    sleep 30
  done
  # Same policy as before: interrupted runs are requeued on start and the janitor
  # cleans their staging, so a stuck task does not block updates forever.
  echo "==> STILL_BUSY ($last) — switching anyway; interrupted runs are requeued on start"
}

verify() {
  i=0
  while [ "$i" -lt 90 ]; do
    RUNNING="$(compose exec -T web cat BUILD_COMMIT 2>/dev/null || true)"
    if [ "$RUNNING" = "$1" ] && compose exec -T web node -e "fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  return 1
}

# Before any swap: put the deploy folder back on the commit that is serving, then exit
# with $1. If that checkout fails, exit 50 so the updater keeps retrying it.
back_to_from() {
  if g -c advice.detachedHead=false checkout "$FROM"; then
    ON_TAG=0
    exit "$1"
  fi
  echo "==> RESTORE_FAILED"
  ON_TAG=0
  exit 50
}

# Back to $1: check it out, rebuild, swap, and check it serves. Exits 10 or 20.
roll_back() {
  if ! g -c advice.detachedHead=false checkout "$1"; then
    echo "==> ROLLBACK_FAILED — could not check out $1"
    exit 20
  fi
  GIT_SHA="$1"
  export GIT_SHA
  # The version being replaced may have started its worker. If it answers, pause it and
  # let its running tasks end before swapping it out; one that does not answer is not
  # running tasks, and waiting on it would only delay getting the old version back.
  if [ "$(web_post '{"hold":true}' 2>/dev/null || true)" = '{"hold":true}' ]; then
    HELD=1
    wait_idle
  fi
  if compose build web && compose up -d --no-deps web && verify "$1"; then
    echo "==> ROLLED_BACK"
    exit 10
  fi
  echo "==> ROLLBACK_FAILED"
  exit 20
}

HELD=0
SWAPPED=0
ON_TAG=0
if [ "$MODE" = rollback ]; then
  echo "==> STEP switching"
  echo "==> RESUMED_ROLLBACK — the update stopped after the swap began; going back to $ROLLBACK_TO"
  roll_back "$ROLLBACK_TO"
fi
if [ "$MODE" = restore ]; then
  g -c advice.detachedHead=false checkout "$ROLLBACK_TO"
  # The cut-off run may have taken the hold; the old version must start runs again.
  web_post '{"hold":false}' >/dev/null 2>&1 || true
  echo "==> RESTORED $ROLLBACK_TO"
  exit 0
fi

FROM="$(g rev-parse HEAD)"
echo "==> FROM $FROM"

echo "==> STEP backing_up"
mkdir -p ./backups
chown "$OWNER" ./backups
STAMP="$(date +%Y%m%d-%H%M%S)"
# Dump to a temp file first: `pg_dump | gzip` would hide a failed dump behind gzip's exit 0.
TMP="./backups/pre-update-${STAMP}.sql.tmp"
# shellcheck disable=SC2329 # invoked by the EXIT trap below
cleanup() {
  code=$?
  rm -f "$TMP" "$TMP.gz"
  # Stopped after taking the hold but before the swap: let the old version start runs
  # again. After a swap the old process, and its hold, are gone. Best effort.
  if [ "$HELD" = 1 ] && [ "$SWAPPED" = 0 ]; then
    web_post '{"hold":false}' >/dev/null 2>&1 || true
  fi
  # An unexpected failure before the swap (set -e) leaves the deploy folder on the new
  # tag while the old version keeps serving: check the old commit back out. The paths
  # that exit on purpose already did (ON_TAG=0), and after the swap roll_back owns it.
  if [ "$code" != 0 ] && [ "$ON_TAG" = 1 ] && [ "$SWAPPED" = 0 ]; then
    if ! g -c advice.detachedHead=false checkout "$FROM" >/dev/null 2>&1; then
      echo "==> RESTORE_FAILED"
      exit 50
    fi
  fi
}
trap cleanup EXIT
compose exec -T postgres pg_dump -U mediatrack -d mediatrack > "$TMP"
# Compress next to it and rename: a full disk must not leave a truncated .sql.gz that
# the keep-5 rule would count as a backup.
gzip -c "$TMP" > "$TMP.gz"
mv "$TMP.gz" "./backups/pre-update-${STAMP}.sql.gz"
chown "$OWNER" "./backups/pre-update-${STAMP}.sql.gz"
rm -f "$TMP"
# Keep the newest 5. `|| true`: the read loop's EOF status is 1, and `set -e` would
# abort a successful backup. Not `xargs -r` — macOS xargs has no -r, and the unit
# test runs this script there. Busybox find/sort/tail behave the same.
find ./backups -name 'pre-update-*.sql.gz' -type f -print | sort -r | tail -n +6 | while IFS= read -r old; do
  [ -n "$old" ] || continue
  rm -f "$old"
done || true

echo "==> STEP building"
g fetch --tags --force origin
ON_TAG=1
g -c advice.detachedHead=false checkout "refs/tags/$TAG"
GIT_SHA="$(g rev-parse HEAD)"
export GIT_SHA
if ! compose build web; then
  echo "==> BUILD_FAILED"
  back_to_from 10
fi


# Stop the old version from starting new runs before the final wait, so nothing starts
# between that wait and the swap. Queued runs stay queued and run on the new version.
# Without the hold a run could start after the last check and be cut by the swap, so
# stop here instead: the new image is built, but the running version is untouched.
if HOLD="$(web_post '{"hold":true}' 2>/dev/null)" && [ "$HOLD" = '{"hold":true}' ]; then
  HELD=1
else
  echo "==> HOLD_FAILED"
  back_to_from 40
fi
wait_idle
echo "==> STEP switching"
SWAPPED=1
# Only web. Recreating any other service from /repo would resolve bind mounts
# inside the updater, not on the host, and start a second empty stack.
# Not left to set -e: the old container may already be stopped, so a failed `up`
# goes to the rollback below like a failed check.
if compose up -d --no-deps web; then
  echo "==> STEP verifying"
  if verify "$GIT_SHA"; then
    echo "==> DONE $TAG"
    exit 0
  fi
  echo "==> VERIFY_FAILED — rolling back to $FROM"
else
  echo "==> UP_FAILED — rolling back to $FROM"
fi
roll_back "$FROM"
