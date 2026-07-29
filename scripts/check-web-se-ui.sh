#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="${1:-apps/web/dist}"

"$SCRIPT_DIR/check-shipped-feature-markers.sh" --dist "$DIST_DIR"
