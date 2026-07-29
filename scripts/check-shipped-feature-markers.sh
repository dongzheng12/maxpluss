#!/usr/bin/env bash
set -euo pipefail

abort() {
  printf 'ABORT: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/check-shipped-feature-markers.sh --dist <apps/web/dist> [--manifest <path>]
  scripts/check-shipped-feature-markers.sh --url <web-base-url> [--manifest <path>]

Manifest format:
  id<TAB>location<TAB>marker<TAB>description

location:
  index  check index.html only
  main   check the referenced assets/index-*.js bundle
  any    check index.html and the referenced main bundle
EOF
}

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$PROJECT_DIR/scripts/shipped-feature-markers.tsv"
DIST_DIR=''
BASE_URL=''

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dist)
      DIST_DIR="${2:?missing value for --dist}"
      shift 2
      ;;
    --url)
      BASE_URL="${2:?missing value for --url}"
      shift 2
      ;;
    --manifest)
      MANIFEST="${2:?missing value for --manifest}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      abort "unknown argument: $1"
      ;;
  esac
done

[[ -n "$DIST_DIR" || -n "$BASE_URL" ]] || abort "one of --dist or --url is required"
[[ -z "$DIST_DIR" || -z "$BASE_URL" ]] || abort "--dist and --url are mutually exclusive"
[[ -f "$MANIFEST" ]] || abort "missing shipped feature marker manifest: $MANIFEST"

TMP_DIR=''
INDEX_FILE=''
MAIN_FILE=''
MAIN_REF=''
MODE=''

cleanup() {
  if [[ -n "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

extract_main_ref() {
  local index_file="${1:?missing index file}"
  grep -oE 'src="[^"]*/assets/index-[^"]+\.js"' "$index_file" \
    | sed -E 's/^src="//; s/"$//' \
    | head -1
}

if [[ -n "$DIST_DIR" ]]; then
  MODE='dist'
  [[ -d "$DIST_DIR" ]] || abort "missing web dist directory: $DIST_DIR"
  [[ -f "$DIST_DIR/index.html" ]] || abort "missing web dist index.html: $DIST_DIR/index.html"
  INDEX_FILE="$DIST_DIR/index.html"
  MAIN_REF="$(extract_main_ref "$INDEX_FILE" || true)"
  [[ -n "$MAIN_REF" ]] || abort "index.html does not reference an assets/index-*.js bundle"
  MAIN_REF="${MAIN_REF#/}"
  MAIN_FILE="$DIST_DIR/$MAIN_REF"
  [[ -f "$MAIN_FILE" ]] || abort "referenced main bundle does not exist: $MAIN_FILE"
else
  MODE='url'
  command -v curl >/dev/null || abort "curl is required for --url checks"
  TMP_DIR="$(mktemp -d)"
  INDEX_FILE="$TMP_DIR/index.html"
  MAIN_FILE="$TMP_DIR/main.js"
  curl -fsS --max-time 10 "$BASE_URL" > "$INDEX_FILE" || abort "cannot fetch web index: $BASE_URL"
  MAIN_REF="$(extract_main_ref "$INDEX_FILE" || true)"
  [[ -n "$MAIN_REF" ]] || abort "fetched index does not reference an assets/index-*.js bundle"

  if [[ "$MAIN_REF" =~ ^https?:// ]]; then
    MAIN_URL="$MAIN_REF"
  elif [[ "$MAIN_REF" == /* ]]; then
    ORIGIN="$(printf '%s\n' "$BASE_URL" | sed -E 's#^([^/]+://[^/]+).*#\1#')"
    [[ "$ORIGIN" =~ ^https?:// ]] || abort "cannot derive origin from url: $BASE_URL"
    MAIN_URL="$ORIGIN$MAIN_REF"
  else
    MAIN_URL="${BASE_URL%/}/$MAIN_REF"
  fi
  curl -fsS --max-time 15 "$MAIN_URL" > "$MAIN_FILE" || abort "cannot fetch web main bundle: $MAIN_URL"
fi

check_marker() {
  local id="${1:?missing id}"
  local location="${2:?missing location}"
  local marker="${3:?missing marker}"
  local target_desc=''

  case "$location" in
    index)
      target_desc='index.html'
      grep -F -- "$marker" "$INDEX_FILE" >/dev/null || abort "missing shipped feature marker [$id] in $target_desc: $marker"
      ;;
    main)
      target_desc="$MAIN_REF"
      grep -F -- "$marker" "$MAIN_FILE" >/dev/null || abort "missing shipped feature marker [$id] in $target_desc: $marker"
      ;;
    any)
      target_desc="index.html or $MAIN_REF"
      if ! grep -F -- "$marker" "$INDEX_FILE" >/dev/null && ! grep -F -- "$marker" "$MAIN_FILE" >/dev/null; then
        abort "missing shipped feature marker [$id] in $target_desc: $marker"
      fi
      ;;
    *)
      abort "invalid marker location for [$id]: $location"
      ;;
  esac
}

CHECKED=0
LINE_NO=0
while IFS= read -r line || [[ -n "$line" ]]; do
  LINE_NO=$((LINE_NO + 1))
  [[ -z "$line" || "$line" == \#* ]] && continue

  IFS=$'\t' read -r id location marker description extra <<< "$line"
  [[ -n "${id:-}" && -n "${location:-}" && -n "${marker:-}" && -n "${description:-}" ]] \
    || abort "malformed marker manifest row $LINE_NO: expected 4 tab-separated columns"
  [[ -z "${extra:-}" ]] || abort "malformed marker manifest row $LINE_NO: too many tab-separated columns"

  check_marker "$id" "$location" "$marker"
  CHECKED=$((CHECKED + 1))
done < "$MANIFEST"

[[ "$CHECKED" -gt 0 ]] || abort "marker manifest has no checkable rows: $MANIFEST"

printf 'shipped feature marker guard passed: mode=%s checked=%s main=%s manifest=%s\n' \
  "$MODE" "$CHECKED" "$MAIN_REF" "$MANIFEST"
