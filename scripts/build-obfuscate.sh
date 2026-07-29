#!/bin/bash
# 混淆构建 bxz-api：TS → bundle → obfuscate → 产出 dist/server.mjs
set -e

API_DIR="$(cd "$(dirname "$0")/../services/api" && pwd)"
cd "$API_DIR"

DEFAULT_TEST_DATABASE_URL="postgresql://test:test@localhost:55432/biaozhunxiaozhi_test_a"
TEST_DATABASE_URL_FOR_BUILD="${BUILD_OBFUSCATE_TEST_DATABASE_URL:-${TEST_DATABASE_URL:-${DATABASE_URL:-$DEFAULT_TEST_DATABASE_URL}}}"

mask_database_url() {
  printf '%s' "$1" | sed -E 's#(postgres(ql)?://[^:/@]+):[^@]*@#\1:***@#'
}

database_name_from_url() {
  local url_without_query="${1%%\?*}"
  local db_name="${url_without_query##*/}"
  printf '%s' "$db_name"
}

ensure_local_test_database_exists() {
  local db_url="$1"
  local db_name
  db_name="$(database_name_from_url "$db_url")"

  [[ "$db_url" == postgres://* || "$db_url" == postgresql://* ]] || {
    echo "❌ build-obfuscate test DATABASE_URL must be PostgreSQL: $(mask_database_url "$db_url")" >&2
    exit 1
  }
  [[ "$db_url" == *test* ]] || {
    echo "❌ refusing to run build-obfuscate tests against non-test DB: $(mask_database_url "$db_url")" >&2
    exit 1
  }
  [[ "$db_name" =~ ^[A-Za-z0-9_]+$ ]] || {
    echo "❌ unsupported test DB name: $db_name" >&2
    exit 1
  }

  if [[ "$db_url" == *"localhost:55432"* || "$db_url" == *"127.0.0.1:55432"* ]]; then
    if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx 'bxz-pg-test'; then
      docker exec bxz-pg-test sh -lc \
        "psql -U test -d postgres -tc \"SELECT 1 FROM pg_database WHERE datname = '$db_name'\" | grep -q 1 || createdb -U test '$db_name'"
    fi
  fi
}

ensure_local_test_database_exists "$TEST_DATABASE_URL_FOR_BUILD"
export DATABASE_URL="$TEST_DATABASE_URL_FOR_BUILD"

echo "=== 0. 测试库隔离: $(mask_database_url "$DATABASE_URL") ==="
echo "=== 0.1. 测试门禁: vitest 全量用例（globalSetup 会 db push --force-reset） ==="

if ! npx vitest run --config "$API_DIR/vitest.config.ts" 2>&1; then
  echo "❌ API tests FAILED — 构建中止，不允许带着失败的测试构建镜像"
  exit 1
fi
echo "✅ 测试全部通过"

echo "=== 1. esbuild: TS → 单文件 bundle ==="
npx esbuild src/main.ts \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=esm \
  --outfile=dist/server.mjs \
  --packages=external \
  --minify

echo "=== 2. javascript-obfuscator: 混淆 ==="
npx javascript-obfuscator dist/server.mjs \
  --output dist/server.obf.mjs \
  --compact true \
  --control-flow-flattening true \
  --control-flow-flattening-threshold 0.5 \
  --dead-code-injection true \
  --dead-code-injection-threshold 0.2 \
  --identifier-names-generator hexadecimal \
  --rename-globals false \
  --self-defending false \
  --string-array true \
  --string-array-threshold 0.5 \
  --string-array-encoding base64 \
  --unicode-escape-sequence false

# 用混淆版替换
mv dist/server.obf.mjs dist/server.mjs

echo "=== 3. 复制 prisma schema ==="
mkdir -p dist/prisma
cp prisma/schema.prisma dist/prisma/

echo "=== 构建完成: dist/server.mjs ($(du -h dist/server.mjs | cut -f1)) ==="
