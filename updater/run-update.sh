#!/bin/sh
# One self-host update to a release tag. Runs inside the updater container.
# The build happens BEFORE the swap, so a failed build never touches the running web container.
# Paths default to the container layout and can be pointed at a temp dir by the unit test.
# Exit: 0 ok · 10 rolled back · 20 rollback failed · 30 local edits (nothing touched).
set -eu

TAG="${1-}"
# Same rule as apps/web/lib/release-version.ts: vYYYY.MM.DD or vYYYY.MM.DD.N (N >= 2),
# and a real calendar date. Checked before git, docker, or the deploy folder are touched.
is_release_tag() {
  # A newline inside the tag would let grep match one line of it.
  case "$1" in *"
"*) return 1 ;; esac
  printf '%s' "$1" | grep -Eq '^v[0-9]{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])(\.([2-9]|[1-9][0-9]+))?$' || return 1
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
if ! is_release_tag "$TAG"; then
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
web_get() {
  wget -qO- --header "Authorization: Bearer $(token)" "${WEB%/}$1"
}
web_post() {
  wget -qO- --header "Authorization: Bearer $(token)" --header "content-type: application/json" \
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

FROM="$(g rev-parse HEAD)"
echo "==> FROM $FROM"

echo "==> STEP backing_up"
mkdir -p ./backups
chown "$OWNER" ./backups
STAMP="$(date +%Y%m%d-%H%M%S)"
# Dump to a temp file first: `pg_dump | gzip` would hide a failed dump behind gzip's exit 0.
TMP="./backups/pre-update-${STAMP}.sql.tmp"
HELD=0
SWAPPED=0
# shellcheck disable=SC2329 # invoked by the EXIT trap below
cleanup() {
  rm -f "$TMP"
  # Stopped after taking the hold but before the swap: let the old version start runs
  # again. After a swap the old process, and its hold, are gone. Best effort.
  if [ "$HELD" = 1 ] && [ "$SWAPPED" = 0 ]; then
    web_post '{"hold":false}' >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
compose exec -T postgres pg_dump -U mediatrack -d mediatrack > "$TMP"
gzip -c "$TMP" > "./backups/pre-update-${STAMP}.sql.gz"
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
g -c advice.detachedHead=false checkout "refs/tags/$TAG"
GIT_SHA="$(g rev-parse HEAD)"
export GIT_SHA
if ! compose build web; then
  echo "==> BUILD_FAILED"
  g -c advice.detachedHead=false checkout "$FROM"
  exit 10
fi

# Only an explicit "busy":false means idle. A failed request, the login page, or any
# other answer is "not idle yet": swapping on a failed probe would cut running tasks.
wait_idle() {
  i=0
  last=""
  while [ "$i" -lt 60 ]; do
    if BUSY="$(web_get /api/update/busy 2>/dev/null)"; then
      case "$BUSY" in
        *'"busy":false'*) return 0 ;;
        *'"busy":true'*) seen=busy ;;
        *) seen=unexpected ;;
      esac
    else
      seen=unreachable
    fi
    if [ "$i" -eq 0 ]; then
      echo "==> STEP waiting"
    fi
    if [ "$seen" != "$last" ]; then
      echo "==> BUSY_CHECK $seen"
      last="$seen"
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

# Stop the old version from starting new runs before the final wait, so nothing starts
# between that wait and the swap. Queued runs stay queued and run on the new version.
if web_post '{"hold":true}' >/dev/null 2>&1; then
  HELD=1
else
  echo "==> HOLD_FAILED — waiting for running tasks without it"
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
g -c advice.detachedHead=false checkout "$FROM"
GIT_SHA="$FROM"
export GIT_SHA
if compose build web && compose up -d --no-deps web && verify "$FROM"; then
  echo "==> ROLLED_BACK"
  exit 10
fi
echo "==> ROLLBACK_FAILED"
exit 20
