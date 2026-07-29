#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install --workspaces
fi

API_CMD="npm --workspace services/api run dev"
H5_CMD="npm --workspace apps/h5 run dev"
WEB_CMD="npm --workspace apps/web run dev"

echo "Starting API, H5, and Web..."

($API_CMD) &
API_PID=$!

($H5_CMD) &
H5_PID=$!

($WEB_CMD) &
WEB_PID=$!

trap 'kill $API_PID $H5_PID $WEB_PID 2>/dev/null || true' EXIT

wait $API_PID $H5_PID $WEB_PID
