#!/usr/bin/env bash
set -euo pipefail

WARN_ONLY=0
if [[ "${1:-}" == "--warn" ]]; then
  WARN_ONLY=1
fi

finish_fail() {
  if [[ "$WARN_ONLY" -eq 1 ]]; then
    printf '[guard] WARN: %s\n' "$*" >&2
    return 0
  fi
  printf '[guard] %s\n' "$*" >&2
  exit 1
}

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if ! git show-ref --verify --quiet refs/heads/main; then
  finish_fail "main branch is missing locally"
  exit 0
fi

UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name main@{upstream} 2>/dev/null || true)"
if [[ -z "$UPSTREAM" ]]; then
  finish_fail "main has no upstream; run: git branch --set-upstream-to=origin/main main"
  exit 0
fi

LOCAL_MAIN="$(git rev-parse main)"
UPSTREAM_MAIN="$(git rev-parse "$UPSTREAM")"
BASE="$(git merge-base main "$UPSTREAM")"

if [[ "$LOCAL_MAIN" == "$UPSTREAM_MAIN" ]]; then
  printf '[guard] main freshness OK: main == %s\n' "$UPSTREAM"
  exit 0
fi

if [[ "$BASE" == "$UPSTREAM_MAIN" ]]; then
  printf '[guard] main freshness OK: local main is ahead of %s\n' "$UPSTREAM"
  exit 0
fi

if [[ "$BASE" == "$LOCAL_MAIN" ]]; then
  finish_fail "local main is behind $UPSTREAM. Run: git switch main && git pull --ff-only origin main"
  exit 0
fi

finish_fail "local main and $UPSTREAM diverged. Reconcile before committing/pushing."
