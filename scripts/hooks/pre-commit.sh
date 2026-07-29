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

say "main freshness: warning only at commit time"
scripts/hooks/check-main-fresh.sh --warn || true
run "whitespace: git diff --cached --check" git diff --cached --check
run "markers: conflict and disabled-code guard" scripts/hooks/check-staged-markers.sh

STAGED_PATHS="$(git diff --cached --name-only --diff-filter=ACMR)"
if printf '%s\n' "$STAGED_PATHS" | scripts/hooks/paths-require-api.sh; then
  timed_run "typecheck: services/api tsc --noEmit" pnpm --dir services/api typecheck
else
  say "typecheck: services/api skipped (no API/package paths staged)"
fi

say "pre-commit passed"
