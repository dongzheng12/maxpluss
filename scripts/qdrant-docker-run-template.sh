#!/usr/bin/env bash
set -euo pipefail

# Qdrant command template for SE vector index.
# Real production execution on 154.8.197.13 requires explicit user ACK per step.

MODE="${1:-local}"

if [[ "$MODE" == "local" ]]; then
  mkdir -p .local/qdrant-data
  docker run -d --name bxz-qdrant-local \
    -p 127.0.0.1:6333:6333 \
    -v "$PWD/.local/qdrant-data:/qdrant/storage" \
    qdrant/qdrant:latest
  exit 0
fi

if [[ "$MODE" == "prod-template" ]]; then
  cat <<'EOF'
mkdir -p /mnt/datadisk0/bxz-qdrant-data
docker run -d --name bxz-qdrant \
  --restart unless-stopped \
  -p 127.0.0.1:6333:6333 \
  -v /mnt/datadisk0/bxz-qdrant-data:/qdrant/storage \
  qdrant/qdrant:latest
EOF
  exit 0
fi

echo "Usage: $0 [local|prod-template]" >&2
exit 2
