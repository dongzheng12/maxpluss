#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

say() { printf '[guard] %s\n' "$*"; }
fail() {
  printf '[guard] FAIL: %s\n' "$*" >&2
  printf '[guard] Fix the issue and retry. Emergency escape: --no-verify only for urgent rollback or broken hooks; record why in the task report.\n' >&2
  exit 1
}
run() {
  local label="$1"
  shift
  say "$label"
  "$@" || fail "$label"
}

timed_run() {
  local label="$1"
  shift
  local start end elapsed
  start="$(date +%s)"
  run "$label" "$@"
  end="$(date +%s)"
  elapsed=$((end - start))
  say "$label completed in ${elapsed}s"
}

ZERO_SHA='0000000000000000000000000000000000000000'
TMP_PATHS="$(mktemp)"
trap 'rm -f "$TMP_PATHS"' EXIT

SAW_STDIN=0
while read -r local_ref local_sha remote_ref remote_sha; do
  SAW_STDIN=1
  [[ -z "${local_ref:-}" ]] && continue
  [[ "$local_sha" == "$ZERO_SHA" ]] && continue

  if [[ "$local_ref" == "refs/heads/main" && "$remote_ref" == "refs/heads/main" && "$remote_sha" != "$ZERO_SHA" ]]; then
    if ! git merge-base --is-ancestor "$remote_sha" "$local_sha"; then
      fail "main freshness: remote main is not an ancestor of local main. Run: git fetch origin && git switch main && git pull --ff-only origin main"
    fi
    say "main freshness OK for push: remote main is ancestor of local main"
  fi

  if [[ "$remote_sha" == "$ZERO_SHA" ]]; then
    base="$(git merge-base "$local_sha" origin/main 2>/dev/null || git rev-list --max-parents=0 "$local_sha" | tail -1)"
    git diff --name-only "$base" "$local_sha" >> "$TMP_PATHS"
  else
    git diff --name-only "$remote_sha" "$local_sha" >> "$TMP_PATHS"
  fi
done

if [[ "$SAW_STDIN" -eq 0 ]]; then
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name HEAD@{upstream} 2>/dev/null || true)"
  if [[ -n "$upstream" ]]; then
    git diff --name-only "$upstream"...HEAD >> "$TMP_PATHS"
  else
    git diff --name-only HEAD~1..HEAD >> "$TMP_PATHS" 2>/dev/null || git diff --name-only --cached >> "$TMP_PATHS"
  fi
  run "main freshness: local main must not be behind upstream" scripts/hooks/check-main-fresh.sh
fi

sort -u "$TMP_PATHS" -o "$TMP_PATHS"
if scripts/hooks/paths-require-api.sh < "$TMP_PATHS"; then
  timed_run "api tests: services/api vitest" pnpm --dir services/api test
else
  say "api tests skipped (no API/package paths in pushed commits)"
fi

say "pre-push passed"
