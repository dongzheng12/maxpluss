#!/usr/bin/env bash
set -euo pipefail

QUIET=0
if [[ "${1:-}" == "--quiet" ]]; then
  QUIET=1
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
  [[ "$QUIET" -eq 1 ]] || printf '[guard] not inside a git worktree; skip hook install\n'
  exit 0
fi

cd "$REPO_ROOT"
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit .githooks/pre-push scripts/hooks/*.sh

if [[ "$QUIET" -ne 1 ]]; then
  printf '[guard] installed git hooks: core.hooksPath=.githooks\n'
  printf '[guard] emergency escape: git commit --no-verify / git push --no-verify only for urgent rollback or broken hooks, and record it in the task report.\n'
fi
