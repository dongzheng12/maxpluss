#!/usr/bin/env bash
set -euo pipefail

abort() {
  printf 'ABORT: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/deploy-pre-check.sh \
    [--stage baseline|image|post-deploy|all] \
    --target prod|8083 \
    --commit <deploy-commit> \
    [--image-tag <docker-image-tag>] \
    [--health-url <url-returning-json-with-commit>] \
    [--smoke-proof-file <path>] \
    [--web-url <url-serving-web-index>] \
    [--marker-manifest <path>] \
    [--branch-audit-file <path>]

Stages:
  baseline     build 前：git HEAD/main 口径、工作区 clean、必读已 commit、Dockerfile label 铁律、未合 main 分支审计
  image        save 前：镜像 tag 含 commit、镜像 label.build.commit == 部署 commit
  post-deploy  swap 后：/health.commit、正反 smoke proof、web 已 ship marker
  all          兼容旧用法：依次跑 baseline + image + post-deploy

Branch audit file format, required when `git branch -r --no-merged origin/main` is non-empty:
  origin/name<TAB>delete|merge|keep<TAB>short explanation

Any decision containing "ship" is treated as already-shipped-unmerged and aborts.
EOF
}

TARGET=''
DEPLOY_COMMIT=''
IMAGE_TAG=''
HEALTH_URL=''
SMOKE_PROOF_FILE=''
BRANCH_AUDIT_FILE=''
WEB_URL=''
MARKER_MANIFEST=''
STAGE='all'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)
      STAGE="${2:?missing value for --stage}"
      shift 2
      ;;
    --target)
      TARGET="${2:?missing value for --target}"
      shift 2
      ;;
    --commit)
      DEPLOY_COMMIT="${2:?missing value for --commit}"
      shift 2
      ;;
    --image-tag)
      IMAGE_TAG="${2:?missing value for --image-tag}"
      shift 2
      ;;
    --health-url)
      HEALTH_URL="${2:?missing value for --health-url}"
      shift 2
      ;;
    --smoke-proof-file)
      SMOKE_PROOF_FILE="${2:?missing value for --smoke-proof-file}"
      shift 2
      ;;
    --web-url)
      WEB_URL="${2:?missing value for --web-url}"
      shift 2
      ;;
    --marker-manifest)
      MARKER_MANIFEST="${2:?missing value for --marker-manifest}"
      shift 2
      ;;
    --branch-audit-file)
      BRANCH_AUDIT_FILE="${2:?missing value for --branch-audit-file}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      abort "unknown argument: $1"
      ;;
  esac
done

: "${TARGET:?--target is required}"
: "${DEPLOY_COMMIT:?--commit is required}"

case "$TARGET" in
  prod|8083) ;;
  *) abort "--target must be prod or 8083, got: $TARGET" ;;
esac

case "$STAGE" in
  baseline|image|post-deploy|all) ;;
  *) abort "--stage must be baseline, image, post-deploy, or all; got: $STAGE" ;;
esac

should_run() {
  [[ "$STAGE" == "all" || "$STAGE" == "$1" ]]
}

if should_run image; then
  : "${IMAGE_TAG:?--image-tag is required for --stage image/all}"
fi

if should_run post-deploy; then
  : "${HEALTH_URL:?--health-url is required for --stage post-deploy/all}"
  : "${SMOKE_PROOF_FILE:?--smoke-proof-file is required for --stage post-deploy/all}"
fi

command -v git >/dev/null || abort "git is required"
if should_run image; then
  command -v docker >/dev/null || abort "docker is required for --stage image/all"
fi
if should_run post-deploy; then
  command -v python3 >/dev/null || abort "python3 is required for --stage post-deploy/all"
  command -v curl >/dev/null || abort "curl is required for --stage post-deploy/all"
fi

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
API_DOCKERFILE="$PROJECT_DIR/services/api/Dockerfile.prod"
MARKER_MANIFEST="${MARKER_MANIFEST:-$PROJECT_DIR/scripts/shipped-feature-markers.tsv}"

git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || abort "not inside a git work tree"

HEAD_COMMIT="$(git -C "$PROJECT_DIR" rev-parse HEAD)"
DEPLOY_FULL="$(git -C "$PROJECT_DIR" rev-parse "${DEPLOY_COMMIT}^{commit}")" || abort "cannot resolve deploy commit: $DEPLOY_COMMIT"

SHORT_COMMIT="$(git -C "$PROJECT_DIR" rev-parse --short "$DEPLOY_FULL")"

run_baseline_checks() {
  if [[ "$HEAD_COMMIT" != "$DEPLOY_FULL" ]]; then
    abort "HEAD ($HEAD_COMMIT) must equal deploy commit ($DEPLOY_FULL)"
  fi

  git -C "$PROJECT_DIR" fetch --quiet origin main || abort "cannot fetch origin/main"

  case "$TARGET" in
    prod)
      git -C "$PROJECT_DIR" merge-base --is-ancestor "$DEPLOY_FULL" origin/main \
        || abort "prod deploy commit must be an ancestor of origin/main"
      ;;
    8083)
      BEHIND_COUNT="$(git -C "$PROJECT_DIR" rev-list --count "$DEPLOY_FULL"..origin/main)" \
        || abort "cannot compare deploy commit against origin/main"
      [[ "$BEHIND_COUNT" =~ ^[0-9]+$ ]] || abort "invalid rev-list count: $BEHIND_COUNT"
      [[ "$BEHIND_COUNT" == "0" ]] || abort "8083 deploy branch is behind origin/main by $BEHIND_COUNT commit(s)"
      ;;
  esac

  STATUS="$(git -C "$PROJECT_DIR" status --short)" || abort "cannot read git status"
  if [[ -n "$STATUS" ]]; then
    printf '%s\n' "$STATUS" >&2
    abort "git working tree must be clean"
  fi

  DOC_STATUS="$(git -C "$PROJECT_DIR" status --short -- '必读')" || abort "cannot read required-doc status"
  if [[ -n "$DOC_STATUS" ]]; then
    printf '%s\n' "$DOC_STATUS" >&2
    abort "required docs under 必读/ must be committed before deploy"
  fi

  [[ -f "$API_DOCKERFILE" ]] || abort "missing Dockerfile: $API_DOCKERFILE"
  grep -Eq '^[[:space:]]*ARG[[:space:]]+BUILD_COMMIT(=|[[:space:]]|$)' "$API_DOCKERFILE" \
    || abort "services/api/Dockerfile.prod must define ARG BUILD_COMMIT"
  grep -Eq '^[[:space:]]*LABEL[[:space:]]+build\.commit=' "$API_DOCKERFILE" \
    || abort "services/api/Dockerfile.prod must define LABEL build.commit"

  UNMERGED_BRANCHES="$(git -C "$PROJECT_DIR" branch -r --no-merged origin/main | sed 's/^[*[:space:]]*//')" \
    || abort "cannot list remote branches not merged into origin/main"
  if [[ -n "$UNMERGED_BRANCHES" ]]; then
    [[ -n "$BRANCH_AUDIT_FILE" ]] || {
      printf '%s\n' "$UNMERGED_BRANCHES" >&2
      abort "remote branches not merged into origin/main require --branch-audit-file"
    }
    [[ -f "$BRANCH_AUDIT_FILE" ]] || abort "missing branch audit file: $BRANCH_AUDIT_FILE"

    while IFS= read -r branch; do
      [[ -n "$branch" ]] || continue
      line="$(awk -F '\t' -v b="$branch" '$1 == b { print; found=1 } END { if (!found) exit 1 }' "$BRANCH_AUDIT_FILE")" \
        || abort "branch audit missing explanation for: $branch"
      decision="$(printf '%s' "$line" | awk -F '\t' '{ print $2 }')"
      explanation="$(printf '%s' "$line" | awk -F '\t' '{ print $3 }')"
      case "$decision" in
        delete|merge|keep) ;;
        *) abort "branch audit decision must be delete|merge|keep for $branch, got: $decision" ;;
      esac
      [[ -n "$explanation" ]] || abort "branch audit explanation is empty for: $branch"
      if printf '%s\n' "$line" | grep -Eiq '(^|[^[:alnum:]_])ship(ped)?([^[:alnum:]_]|$)'; then
        abort "already-shipped branch not merged into origin/main is forbidden: $branch"
      fi
    done <<<"$UNMERGED_BRANCHES"
  fi

  printf 'deploy pre-check baseline passed: target=%s commit=%s\n' "$TARGET" "$DEPLOY_FULL"
}

run_image_checks() {
  if [[ "$IMAGE_TAG" != *"$SHORT_COMMIT"* && "$IMAGE_TAG" != *"$DEPLOY_FULL"* ]]; then
    abort "image tag must include deploy commit ($SHORT_COMMIT or full SHA): $IMAGE_TAG"
  fi

  IMAGE_LABEL="$(docker image inspect "$IMAGE_TAG" --format '{{index .Config.Labels "build.commit"}}')" \
    || abort "cannot inspect docker image: $IMAGE_TAG"
  [[ -n "$IMAGE_LABEL" && "$IMAGE_LABEL" != "<no value>" ]] || abort "image label build.commit is missing"

  LABEL_FULL="$(git -C "$PROJECT_DIR" rev-parse "${IMAGE_LABEL}^{commit}")" \
    || abort "image label build.commit is not a valid git commit: $IMAGE_LABEL"
  [[ "$LABEL_FULL" == "$DEPLOY_FULL" ]] || abort "image label build.commit ($IMAGE_LABEL) must equal deploy commit ($DEPLOY_COMMIT)"

  printf 'deploy pre-check image passed: target=%s commit=%s image=%s\n' "$TARGET" "$DEPLOY_FULL" "$IMAGE_TAG"
}

run_post_deploy_checks() {
  HEALTH_JSON="$(curl -fsS --max-time 5 "$HEALTH_URL")" || abort "cannot fetch health url: $HEALTH_URL"
  HEALTH_COMMIT="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("commit",""))' <<<"$HEALTH_JSON")" \
    || abort "health response is not valid JSON or has no commit field"
  [[ -n "$HEALTH_COMMIT" ]] || abort "health response commit is empty"
  HEALTH_FULL="$(git -C "$PROJECT_DIR" rev-parse "${HEALTH_COMMIT}^{commit}")" \
    || abort "health commit is not a valid git commit: $HEALTH_COMMIT"
  [[ "$HEALTH_FULL" == "$DEPLOY_FULL" ]] || abort "health commit ($HEALTH_COMMIT) must equal deploy commit ($DEPLOY_COMMIT)"

  [[ -f "$SMOKE_PROOF_FILE" ]] || abort "missing smoke proof file: $SMOKE_PROOF_FILE"
  [[ -s "$SMOKE_PROOF_FILE" ]] || abort "smoke proof file is empty: $SMOKE_PROOF_FILE"
  grep -Eq 'positive|success|ok|pass' "$SMOKE_PROOF_FILE" \
    || abort "smoke proof must include a positive/success path marker"
  grep -Eq 'negative|failure|reject|rollback|forbid|409|error' "$SMOKE_PROOF_FILE" \
    || abort "smoke proof must include a negative/failure boundary marker"
  grep -Eq '企业版登录|/enterprise/login|tab=enterprise' "$SMOKE_PROOF_FILE" \
    || abort "smoke proof must include enterprise login/route marker"

  if [[ -n "$WEB_URL" ]]; then
    "$PROJECT_DIR/scripts/check-shipped-feature-markers.sh" --url "$WEB_URL" --manifest "$MARKER_MANIFEST" \
      || abort "web shipped feature marker guard failed: $WEB_URL"
  fi

  printf 'deploy pre-check post-deploy passed: target=%s commit=%s health=%s\n' \
    "$TARGET" "$DEPLOY_FULL" "$HEALTH_URL"
}

if should_run baseline; then
  run_baseline_checks
fi

if should_run image; then
  run_image_checks
fi

if should_run post-deploy; then
  run_post_deploy_checks
fi

printf 'deploy pre-check passed: stage=%s target=%s commit=%s\n' "$STAGE" "$TARGET" "$DEPLOY_FULL"
