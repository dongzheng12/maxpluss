#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  DEPLOY_COMMIT=<short-sha> NEW_IMAGE=<loaded-image-tag> WEB_TAR=<web-dist.tar.gz> \
    bash scripts/bxz-prod-swap.sh

Server-side production swap script. Run it only on 154.8.197.13 after:
  - deploy-pre-check production baseline passed
  - production DB backup completed
  - API image has been docker loaded on the server
  - web dist tarball has been uploaded to the server

Required env:
  DEPLOY_COMMIT   Expected /health commit and image label build.commit.
  NEW_IMAGE       New bxz-api image tag already loaded on the server.
  WEB_TAR         Uploaded web dist tarball path.

Optional env:
  EXPECTED_OLD_IMAGE       Refuse swap if current bxz-api image differs.
  API_NAME                 Default: bxz-api
  ENV_FILE                 Default: /mnt/datadisk0/bxz-pg-prod-env/.env
  WEB_ROOT                 Default: /var/www/biaozhun-web
  BACKUP_ROOT              Default: /mnt/datadisk0/backups
  DEPLOY_DIR               Default: dirname(WEB_TAR)
  HEALTH_BASE_URL          Default: http://127.0.0.1:3000
  STOP_TIMEOUT_SECONDS     Default: 25
  STOP_GRACE_SECONDS       Default: 10
  STABILITY_PROBES         Default: 3
  STABILITY_INTERVAL       Default: 5
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
if [[ "$#" -ne 0 ]]; then
  usage >&2
  exit 1
fi

DEPLOY_COMMIT="${DEPLOY_COMMIT:?DEPLOY_COMMIT is required}"
NEW_IMAGE="${NEW_IMAGE:?NEW_IMAGE is required}"
WEB_TAR="${WEB_TAR:?WEB_TAR is required}"

API_NAME="${API_NAME:-bxz-api}"
ENV_FILE="${ENV_FILE:-/mnt/datadisk0/bxz-pg-prod-env/.env}"
WEB_ROOT="${WEB_ROOT:-/var/www/biaozhun-web}"
BACKUP_ROOT="${BACKUP_ROOT:-/mnt/datadisk0/backups}"
DEPLOY_DIR="${DEPLOY_DIR:-$(dirname "$WEB_TAR")}"
HEALTH_BASE_URL="${HEALTH_BASE_URL:-http://127.0.0.1:3000}"
STOP_TIMEOUT_SECONDS="${STOP_TIMEOUT_SECONDS:-25}"
STOP_GRACE_SECONDS="${STOP_GRACE_SECONDS:-10}"
STABILITY_PROBES="${STABILITY_PROBES:-3}"
STABILITY_INTERVAL="${STABILITY_INTERVAL:-5}"
MEMORY_LIMIT="${MEMORY_LIMIT:-2g}"
MEMORY_SWAP="${MEMORY_SWAP:-4g}"
TS="${TS:-$(date +%Y%m%d%H%M%S)}"

OLD_NAME="${API_NAME}-old-${TS}"
BAD_NAME="${API_NAME}-bad-${TS}"
WEB_BACKUP="${BACKUP_ROOT}/web/biaozhun-web-bak-${TS}"
STAGING="${DEPLOY_DIR}/web-dist-prod-${TS}"
DRYRUN_LOG="${DEPLOY_DIR}/rsync-prod-dry-run-${TS}.log"
OLD_IMAGE=""

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

abort() {
  printf 'ABORT: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || abort "$1 not found in PATH"
}

container_image() {
  docker inspect "$1" --format '{{.Config.Image}}' 2>/dev/null || true
}

container_status() {
  docker inspect "$1" --format '{{.State.Status}}' 2>/dev/null || true
}

container_exists() {
  docker ps -a --format '{{.Names}}' | grep -qx "$1"
}

image_label_commit() {
  docker image inspect "$1" --format '{{index .Config.Labels "build.commit"}}' 2>/dev/null || true
}

parse_json_field() {
  local expr="$1"
  python3 -c "import json,sys; data=json.load(sys.stdin); print($expr)"
}

preserve_bad_container() {
  if ! container_exists "$API_NAME"; then
    return 0
  fi

  local image
  image="$(container_image "$API_NAME")"
  if [[ "$image" != "$NEW_IMAGE" ]]; then
    return 0
  fi

  log "BAD_CONTAINER_PRESERVE_START name=$API_NAME badName=$BAD_NAME image=$image"
  if container_exists "$BAD_NAME"; then
    docker rm -f "$BAD_NAME" >/dev/null 2>&1 || true
  fi
  docker rename "$API_NAME" "$BAD_NAME" >/dev/null
  log "BAD_CONTAINER_PRESERVED name=$BAD_NAME status=$(container_status "$BAD_NAME")"
}

stop_old_container() {
  local start duration
  start="$(date +%s)"
  log "OLD_STOP_START name=$API_NAME image=$(container_image "$API_NAME") timeout=${STOP_TIMEOUT_SECONDS}s stopGrace=${STOP_GRACE_SECONDS}s"

  if timeout "$STOP_TIMEOUT_SECONDS" docker stop -t "$STOP_GRACE_SECONDS" "$API_NAME" >/dev/null; then
    duration="$(( $(date +%s) - start ))"
    log "OLD_STOP_OK name=$API_NAME duration=${duration}s"
  else
    duration="$(( $(date +%s) - start ))"
    log "OLD_STOP_TIMEOUT name=$API_NAME duration=${duration}s action=kill-fallback"
    docker kill "$API_NAME" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      [[ "$(container_status "$API_NAME")" != "running" ]] && break
      sleep 1
    done
    log "OLD_STOP_KILL_FALLBACK_DONE name=$API_NAME finalStatus=$(container_status "$API_NAME")"
  fi

  [[ "$(container_status "$API_NAME")" != "running" ]] \
    || abort "old container still running after kill fallback"
}

assert_runtime_identity() {
  local image label env_commit
  image="$(container_image "$API_NAME")"
  label="$(docker inspect "$API_NAME" --format '{{index .Config.Labels "build.commit"}}' 2>/dev/null || true)"
  env_commit="$(docker inspect "$API_NAME" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -Fx "BUILD_COMMIT=$DEPLOY_COMMIT" || true)"

  [[ "$image" == "$NEW_IMAGE" ]] || abort "runtime image mismatch: $image"
  [[ "$label" == "$DEPLOY_COMMIT" ]] || abort "runtime build.commit mismatch: $label"
  [[ "$env_commit" == "BUILD_COMMIT=$DEPLOY_COMMIT" ]] \
    || abort "runtime BUILD_COMMIT env mismatch: $env_commit"
}

assert_http_commit() {
  local health commit
  health="$(curl -fsS "${HEALTH_BASE_URL}/health")"
  commit="$(printf '%s' "$health" | parse_json_field 'data.get("commit", "")')"
  [[ "$commit" == "$DEPLOY_COMMIT" ]] || abort "health commit mismatch: $commit"
}

assert_schema_ok() {
  local schema schema_ok
  schema="$(curl -fsS "${HEALTH_BASE_URL}/health/schema")"
  schema_ok="$(printf '%s' "$schema" | parse_json_field 'data.get("schema", {}).get("ok", False)')"
  [[ "$schema_ok" == "True" ]] || abort "schema health not ok"
}

wait_for_docker_healthy() {
  for i in $(seq 1 90); do
    local state health
    state="$(container_status "$API_NAME")"
    health="$(docker inspect "$API_NAME" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-health{{end}}' 2>/dev/null || true)"
    log "DOCKER_HEALTH_CHECK attempt=$i state=$state health=$health"
    [[ "$state" == "running" && "$health" == "healthy" ]] && return 0
    [[ "$state" == "exited" || "$state" == "dead" ]] && return 1
    sleep 2
  done
  return 1
}

stable_gate() {
  log "STABILITY_GATE_START checks=http_commit,schema_ok,docker_healthy,runtime_identity consecutive=${STABILITY_PROBES} interval=${STABILITY_INTERVAL}s"
  assert_http_commit
  assert_schema_ok
  wait_for_docker_healthy || abort "docker health did not become healthy"
  assert_runtime_identity

  for i in $(seq 1 "$STABILITY_PROBES"); do
    sleep "$STABILITY_INTERVAL"
    assert_http_commit
    assert_schema_ok
    assert_runtime_identity
    [[ "$(container_status "$API_NAME")" == "running" ]] \
      || abort "container not running during stability probe"
    log "STABILITY_GATE_PROBE_OK index=$i"
  done
  log "STABILITY_GATE_OK"
}

rollback() {
  local code=$?
  if [[ "$code" -eq 0 ]]; then
    return 0
  fi

  log "ROLLBACK_START code=$code"
  preserve_bad_container

  if container_exists "$OLD_NAME"; then
    if container_exists "$API_NAME"; then
      docker rm -f "$API_NAME" >/dev/null 2>&1 || true
    fi
    docker rename "$OLD_NAME" "$API_NAME" >/dev/null 2>&1 || true
    docker start "$API_NAME" >/dev/null 2>&1 || true
  elif [[ -n "$OLD_IMAGE" ]]; then
    docker run -d --name "$API_NAME" \
      --network host \
      --restart unless-stopped \
      --memory="$MEMORY_LIMIT" --memory-swap="$MEMORY_SWAP" \
      --env-file "$ENV_FILE" \
      -v /opt/biaozhunxiaozhi/services/api/certs:/app/certs:ro \
      -v /opt/biaozhunxiaozhi/services/api/public:/app/public:ro \
      -v /mnt/datadisk0/bxz-uploads:/app/uploads \
      "$OLD_IMAGE" >/dev/null || true
  fi

  if [[ -d "$WEB_BACKUP" ]]; then
    rsync -a --delete "$WEB_BACKUP/" "$WEB_ROOT/" >/dev/null 2>&1 || true
  fi

  curl -fsS "${HEALTH_BASE_URL}/health" || true
  log "ROLLBACK_DONE badName=$BAD_NAME"
  exit "$code"
}
trap rollback EXIT

for cmd in docker curl python3 rsync tar timeout grep find date dirname seq; do
  require_command "$cmd"
done

[[ -f "$ENV_FILE" ]] || abort "env file not found: $ENV_FILE"
[[ -f "$WEB_TAR" ]] || abort "web tar not found: $WEB_TAR"
[[ -d "$WEB_ROOT" ]] || abort "web root not found: $WEB_ROOT"
docker image inspect "$NEW_IMAGE" >/dev/null 2>&1 || abort "new image not found: $NEW_IMAGE"
[[ "$(image_label_commit "$NEW_IMAGE")" == "$DEPLOY_COMMIT" ]] \
  || abort "new image build.commit label mismatch: $(image_label_commit "$NEW_IMAGE")"
container_exists "$API_NAME" || abort "current container not found: $API_NAME"
[[ "$(container_status "$API_NAME")" == "running" ]] || abort "current container is not running"

OLD_IMAGE="$(container_image "$API_NAME")"
[[ -n "$OLD_IMAGE" ]] || abort "cannot resolve current container image"
[[ "$OLD_IMAGE" != "$NEW_IMAGE" ]] || abort "current container already uses new image: $NEW_IMAGE"
if [[ -n "${EXPECTED_OLD_IMAGE:-}" && "$OLD_IMAGE" != "$EXPECTED_OLD_IMAGE" ]]; then
  abort "current image mismatch: expected=$EXPECTED_OLD_IMAGE actual=$OLD_IMAGE"
fi

log "SWAP_START ts=$TS deployCommit=$DEPLOY_COMMIT newImage=$NEW_IMAGE oldImage=$OLD_IMAGE"
mkdir -p "$BACKUP_ROOT/web" "$STAGING"
cp -a "$WEB_ROOT" "$WEB_BACKUP"
tar --exclude='._*' -xzf "$WEB_TAR" -C "$STAGING"
find "$STAGING" -name '._*' -type f -delete

WEB_SRC="$STAGING"
if [[ -d "$STAGING/dist" ]]; then
  WEB_SRC="$STAGING/dist"
fi

RSYNC_EXCLUDES=(
  --exclude='baidu_verify_*.html'
  --exclude='MP_verify_*.txt'
  --exclude='RyzhrDvEwC.txt'
  --exclude='robots.txt'
  --exclude='robots.txt.bak*'
  --exclude='sitemap.xml'
  --exclude='sitemap-*.xml'
  --exclude='sitemap-index.xml'
  --exclude='seo/'
  --exclude='index.html.bak*'
  --exclude='demo-yongbiaozhun.html'
  --exclude='demo-yongbiaozhun.html.bak*'
)

rsync -av --delete --dry-run "${RSYNC_EXCLUDES[@]}" \
  "$WEB_SRC/" "$WEB_ROOT/" > "$DRYRUN_LOG"

if grep -E '^deleting (robots|sitemap|MP_verify|Ryzhr|baidu_verify|seo/|index\.html\.bak|demo-yongbiaozhun\.html)' "$DRYRUN_LOG"; then
  abort "rsync dry-run would delete protected SEO/verify/demo assets"
fi

docker tag "$OLD_IMAGE" "bxz-api:prod-rollback-pre-deploy-${TS}"
stop_old_container
docker rename "$API_NAME" "$OLD_NAME" >/dev/null
[[ "$(container_image "$OLD_NAME")" == "$OLD_IMAGE" ]] \
  || abort "old container image mismatch after rename: $(container_image "$OLD_NAME")"
log "OLD_RENAMED oldName=$OLD_NAME image=$(container_image "$OLD_NAME")"

docker run -d --name "$API_NAME" \
  --network host \
  --restart unless-stopped \
  --memory="$MEMORY_LIMIT" --memory-swap="$MEMORY_SWAP" \
  --env-file "$ENV_FILE" \
  -v /opt/biaozhunxiaozhi/services/api/certs:/app/certs:ro \
  -v /opt/biaozhunxiaozhi/services/api/public:/app/public:ro \
  -v /mnt/datadisk0/bxz-uploads:/app/uploads \
  "$NEW_IMAGE" >/dev/null
log "NEW_STARTED name=$API_NAME image=$(container_image "$API_NAME")"

for _ in $(seq 1 40); do
  health="$(curl -fsS "${HEALTH_BASE_URL}/health" 2>/dev/null || true)"
  commit="$(printf '%s' "$health" | python3 -c 'import json,sys; data=sys.stdin.read(); print(json.loads(data).get("commit","") if data else "")' 2>/dev/null || true)"
  [[ "$commit" == "$DEPLOY_COMMIT" ]] && break
  sleep 1
done

stable_gate

find "$WEB_ROOT" -name '._*' -type f -delete
rsync -av --delete "${RSYNC_EXCLUDES[@]}" "$WEB_SRC/" "$WEB_ROOT/" >/dev/null

stable_gate
docker inspect "$API_NAME" --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} {{.Config.Image}}'
log "SWAP_OK ts=$TS oldName=$OLD_NAME webBackup=$WEB_BACKUP staging=$STAGING dryRunLog=$DRYRUN_LOG"
