#!/usr/bin/env bash
#
# 标准小智 pSEO — IndexNow URL 推送
#
# 数据源 : data/seo-pages/priority-urls.txt
# 去重   : data/seo-pages/.indexnow-pushed-urls.txt（data/seo-pages 已被 .gitignore 覆盖）
# 日志   : logs/indexnow-push-YYYY-MM-DD.log
#
# key    : 优先读 INDEXNOW_KEY；否则读 INDEXNOW_KEY_FILE；否则自动发现：
#          apps/web/public/indexnow-*.txt 或 /var/www/biaozhun-web/indexnow-*.txt
# 参数   : --dry-run 预览；--force 用于内容更新后重推已推过 URL
# 测试   : --pushed-file=PATH 指定去重文件；--log-dir=PATH 指定日志目录
#
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SITE="https://biaozhunxiaozhi.com"
HOST="biaozhunxiaozhi.com"
API="https://api.indexnow.org/indexnow"
HTTP_TIMEOUT=30
BATCH_SIZE=10000
DRY_RUN=0
LIMIT=0
FORCE=0

URLS_FILE="$REPO_ROOT/data/seo-pages/priority-urls.txt"
PUSHED="$REPO_ROOT/data/seo-pages/.indexnow-pushed-urls.txt"
LOG_DIR="$REPO_ROOT/logs"

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --limit=*) LIMIT="${arg#*=}" ;;
    --urls-file=*) URLS_FILE="${arg#*=}" ;;
    --site=*) SITE="${arg#*=}" ;;
    --host=*) HOST="${arg#*=}" ;;
    --batch-size=*) BATCH_SIZE="${arg#*=}" ;;
    --pushed-file=*) PUSHED="${arg#*=}" ;;
    --log-dir=*) LOG_DIR="${arg#*=}" ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "未知参数: $arg" >&2; exit 64 ;;
  esac
done

case "$LIMIT" in ''|*[!0-9]*) echo "ERROR: --limit 必须是非负整数，收到: $LIMIT" >&2; exit 64 ;; esac
case "$BATCH_SIZE" in ''|*[!0-9]*) echo "ERROR: --batch-size 必须是正整数，收到: $BATCH_SIZE" >&2; exit 64 ;; esac
[ "$BATCH_SIZE" -ge 1 ] || { echo "ERROR: --batch-size 必须 >=1" >&2; exit 64; }
[ "$BATCH_SIZE" -le 10000 ] || { echo "ERROR: IndexNow 单批最多 10000 URL" >&2; exit 64; }

[ -f "$URLS_FILE" ] || { echo "ERROR: URLs file 不存在: $URLS_FILE" >&2; exit 1; }
mkdir -p "$LOG_DIR" "$(dirname "$PUSHED")"
touch "$PUSHED"

LOG="$LOG_DIR/indexnow-push-$(date +%F).log"
TS() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(TS)] $*" | tee -a "$LOG"; }

KEY_FILE="${INDEXNOW_KEY_FILE:-}"
if [ -z "${INDEXNOW_KEY:-}" ] && [ -z "$KEY_FILE" ]; then
  for candidate in "$REPO_ROOT"/apps/web/public/indexnow-*.txt /var/www/biaozhun-web/indexnow-*.txt; do
    if [ -f "$candidate" ]; then
      KEY_FILE="$candidate"
      break
    fi
  done
fi

KEY="${INDEXNOW_KEY:-}"
if [ -z "$KEY" ] && [ -n "$KEY_FILE" ] && [ -f "$KEY_FILE" ]; then
  KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
fi

KEY_LOCATION="${SITE}/indexnow-${KEY}.txt"

TMP_SEL="$(mktemp)"
trap 'rm -f "$TMP_SEL"' EXIT

awk -v pushedfile="$PUSHED" -v force="$FORCE" '
  BEGIN {
    while ((getline l < pushedfile) > 0) { if (l != "") seen[l] = 1 }
  }
  /^[[:space:]]*($|#)/ { next }
  {
    url = $0
    sub(/^[[:space:]]+/, "", url)
    sub(/[[:space:]]+$/, "", url)
    if (url != "" && (force == 1 || !(url in seen))) {
      seen[url] = 1
      print url
    }
  }
' "$URLS_FILE" > "$TMP_SEL"

if [ "$LIMIT" -gt 0 ]; then
  TMP_LIMIT="$(mktemp)"
  trap 'rm -f "$TMP_SEL" "$TMP_LIMIT"' EXIT
  head -n "$LIMIT" "$TMP_SEL" > "$TMP_LIMIT"
  mv "$TMP_LIMIT" "$TMP_SEL"
fi

SELECTED="$(wc -l < "$TMP_SEL" | tr -d ' ')"
TOTAL="$(grep -cv '^[[:space:]]*$' "$URLS_FILE" || true)"
DONE="$(wc -l < "$PUSHED" | tr -d ' ')"
log "选出 $SELECTED 条待推送 | urls_total=$TOTAL 已推=$DONE batch_size=$BATCH_SIZE site=$SITE force=$FORCE"

if [ "$SELECTED" -eq 0 ]; then
  log "没有未推过 URL，退出。"
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] 不推送、不写去重。候选 URL 预览（前 20 条）:"
  head -n 20 "$TMP_SEL" | sed 's/^/    /' | tee -a "$LOG"
  exit 0
fi

if [ -z "$KEY" ]; then
  log "ERROR: 缺少 IndexNow key。请设置 INDEXNOW_KEY 或 INDEXNOW_KEY_FILE。"
  exit 2
fi

python3 - "$TMP_SEL" "$PUSHED" "$LOG" "$API" "$HOST" "$KEY" "$KEY_LOCATION" "$HTTP_TIMEOUT" "$BATCH_SIZE" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

urls_file, pushed_file, log_file, api, host, key, key_location, timeout_raw, batch_raw = sys.argv[1:]
timeout = int(timeout_raw)
batch_size = int(batch_raw)
urls = [line.strip() for line in Path(urls_file).read_text().splitlines() if line.strip()]

def log(message: str) -> None:
    line = time.strftime("[%Y-%m-%d %H:%M:%S] ") + message
    print(line)
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def post_batch(batch, batch_no):
    payload = {
        "host": host,
        "key": key,
        "keyLocation": key_location,
        "urlList": batch,
    }
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        api,
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            log(f"batch={batch_no} urls={len(batch)} HTTP {resp.status} {resp.reason} raw={raw[:1000]}")
            if resp.status not in (200, 202):
                raise SystemExit(10)
            return
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        log(f"FAIL batch={batch_no} urls={len(batch)} HTTP {exc.code} {exc.reason} raw={raw[:2000]}")
        raise SystemExit(10)
    except Exception as exc:
        log(f"FAIL batch={batch_no} urls={len(batch)} error={type(exc).__name__}: {exc}")
        raise SystemExit(10)

sent = 0
batch_no = 0
already_pushed = set(Path(pushed_file).read_text().splitlines()) if Path(pushed_file).exists() else set()
for start in range(0, len(urls), batch_size):
    batch = urls[start:start + batch_size]
    batch_no += 1
    post_batch(batch, batch_no)
    with open(pushed_file, "a", encoding="utf-8") as f:
        for url in batch:
            if url not in already_pushed:
                f.write(url + "\n")
                already_pushed.add(url)
    sent += len(batch)

log(f"OK: indexnow_sent={sent} batches={batch_no}")
PY
