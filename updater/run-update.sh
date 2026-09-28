#!/bin/sh
# One self-host update to a release tag. Runs inside the updater container.
# The build happens BEFORE the swap, so a failed build never touches the running web container.
# Paths default to the container layout and can be pointed at a temp dir by the unit test.
# Exit: 0 ok · 10 rolled back · 20 rollback failed · 30 local edits (nothing touched).
set -eu

TAG="${1-}"
# Whole-string match. Rejects `main` and anything with a shell metacharacter
# before git, docker, or the deploy folder are touched.
case "$TAG" in
  v[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]|v[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9].[0-9]*) ;;
  *)
    echo "==> ERROR not a release tag: $TAG"
    exit 2
    ;;
esac

REPO="${UPDATER_REPO_DIR:-/repo}"
STATE="${UPDATER_STATE_DIR:-/state}"
WEB="${UPDATER_WEB_BASE:-http://web:3000}"
cd "$REPO"

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
trap 'rm -f "$TMP"' EXIT
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

wait_idle() {
  i=0
  while [ "$i" -lt 60 ]; do
    TOKEN=""
    if [ -r "$STATE/token" ]; then
      TOKEN="$(cat "$STATE/token")"
    fi
    BUSY="$(wget -qO- --header "Authorization: Bearer ${TOKEN}" "${WEB%/}/api/update/busy" 2>/dev/null || true)"
    case "$BUSY" in
      *'"busy":true'*) ;;
      *) return 0 ;;
    esac
    if [ "$i" -eq 0 ]; then
      echo "==> STEP waiting"
    fi
    i=$((i + 1))
    sleep 30
  done
  echo "==> STILL_BUSY — switching anyway; interrupted runs are requeued on start"
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

wait_idle
echo "==> STEP switching"
# Only web. Recreating any other service from /repo would resolve bind mounts
# inside the updater, not on the host, and start a second empty stack.
compose up -d --no-deps web

echo "==> STEP verifying"
if verify "$GIT_SHA"; then
  echo "==> DONE $TAG"
  exit 0
fi

echo "==> VERIFY_FAILED — rolling back to $FROM"
g -c advice.detachedHead=false checkout "$FROM"
GIT_SHA="$FROM"
export GIT_SHA
if compose build web && compose up -d --no-deps web && verify "$FROM"; then
  echo "==> ROLLED_BACK"
  exit 10
fi
echo "==> ROLLBACK_FAILED"
exit 20
