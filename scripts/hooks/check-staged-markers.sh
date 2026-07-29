#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

git diff --cached --name-only --diff-filter=ACMR -z > "$TMP_FILE"

if [[ ! -s "$TMP_FILE" ]]; then
  printf '[guard] no staged files to scan\n'
  exit 0
fi

HAS_ERROR=0
while IFS= read -r -d '' file; do
  if [[ ! -f "$file" ]]; then
    continue
  fi
  case "$file" in
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.pdf|*.docx|*.xlsx|*.zip|*.gz|*.pem|*.key)
      continue
      ;;
  esac

  if git show ":$file" | grep -nE '^(<<<<<<<|=======|>>>>>>>)' >/tmp/bxz-hook-marker-match 2>/dev/null; then
    printf '[guard] conflict marker in %s:\n' "$file" >&2
    sed 's/^/[guard]   /' /tmp/bxz-hook-marker-match >&2
    HAS_ERROR=1
  fi

  TS_IGNORE='@ts''-ignore'
  TS_NOCHECK='@ts''-nocheck'
  ESLINT_DISABLE='eslint''-disable'
  ISTANBUL_IGNORE='istanbul'' ignore'
  SKIP_ONLY_PATTERN="(${TS_IGNORE}|${TS_NOCHECK}|${ESLINT_DISABLE}|${ISTANBUL_IGNORE}|vitest[.]skip|describe[.]skip|it[.]skip|test[.]skip|[.]only[(])"
  if git show ":$file" | grep -nE "$SKIP_ONLY_PATTERN" >/tmp/bxz-hook-marker-match 2>/dev/null; then
    printf '[guard] disabled-code/test marker in %s:\n' "$file" >&2
    sed 's/^/[guard]   /' /tmp/bxz-hook-marker-match >&2
    HAS_ERROR=1
  fi
done < "$TMP_FILE"

rm -f /tmp/bxz-hook-marker-match

if [[ "$HAS_ERROR" -ne 0 ]]; then
  printf '[guard] remove conflict/disabled markers or document an explicit exception before committing\n' >&2
  exit 1
fi

printf '[guard] staged marker scan passed\n'
