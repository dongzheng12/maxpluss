#!/usr/bin/env bash
set -euo pipefail

NEED=1

while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  case "$path" in
    services/api/*|package.json|pnpm-lock.yaml|pnpm-workspace.yaml)
      printf '[guard] API gate required by path: %s\n' "$path"
      NEED=0
      ;;
  esac
done

exit "$NEED"
