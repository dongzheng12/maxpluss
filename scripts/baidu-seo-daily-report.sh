#!/usr/bin/env bash
#
# 标准小智百度 SEO 日报
#
# 汇总：
#   - 百度推送成功数 / over quota / remain
#   - Baiduspider 抓取量、/standards/ 抓取量、状态码分布
#
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO_ROOT/logs"
OUT="$LOG_DIR/baidu-seo-daily.tsv"

DATE="${1:-$(date +%F)}"
PUSH_LOG="$LOG_DIR/baidu-push-${DATE}.log"
DATE_NGINX="$(python3 - "$DATE" <<'PY'
import datetime
import sys

try:
    print(datetime.date.fromisoformat(sys.argv[1]).strftime('%d/%b/%Y'))
except Exception:
    print('')
PY
)"

ACCESS_CANDIDATES=(
  "/www/wwwlogs/bxz-com-access.log-${DATE//-/}"
  "/www/wwwlogs/bxz-com-access.log-${DATE//-/}.gz"
  "/www/wwwlogs/bxz-access.log-${DATE//-/}"
  "/www/wwwlogs/bxz-access.log-${DATE//-/}.gz"
  "/www/wwwlogs/bxz-com-access.log"
  "/www/wwwlogs/bxz-access.log"
)

mkdir -p "$LOG_DIR"

if [ ! -f "$OUT" ]; then
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    date push_success push_over_quota push_remain pushed_total baiduspider_hits baiduspider_standards baiduspider_200 baiduspider_404 baiduspider_other > "$OUT"
fi

push_success=0
push_over_quota=0
push_remain=""
pushed_total=""

if [ -f "$PUSH_LOG" ]; then
  push_success=$(grep -hoE '"success":[0-9]+' "$PUSH_LOG" | grep -oE '[0-9]+' | awk '{s+=$1} END{print s+0}')
  push_over_quota=$(grep -ci 'over quota' "$PUSH_LOG" || true)
  push_remain=$(grep -hoE '"remain":[0-9]+' "$PUSH_LOG" | tail -1 | grep -oE '[0-9]+' || true)
  pushed_total=$(grep -hoE '累计已推=[0-9]+' "$PUSH_LOG" | tail -1 | grep -oE '[0-9]+' || true)
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

read_access_log() {
  case "$1" in
    *.gz) gzip -cd -- "$1" ;;
    *) cat -- "$1" ;;
  esac
}

for f in "${ACCESS_CANDIDATES[@]}"; do
  [ -f "$f" ] || continue
  if [ -n "$DATE_NGINX" ]; then
    read_access_log "$f" | grep -i 'Baiduspider' | grep "\\[$DATE_NGINX:" >> "$tmp" || true
  else
    read_access_log "$f" | grep -i 'Baiduspider' >> "$tmp" || true
  fi
done

baidu_hits=0
baidu_standards=0
baidu_200=0
baidu_404=0
baidu_other=0

if [ -s "$tmp" ]; then
  baidu_hits=$(wc -l < "$tmp" | tr -d ' ')
  baidu_standards=$(grep -c ' /standards/' "$tmp" || true)
  baidu_200=$(awk '$9 == 200 {c++} END{print c+0}' "$tmp")
  baidu_404=$(awk '$9 == 404 {c++} END{print c+0}' "$tmp")
  baidu_other=$(awk '$9 != 200 && $9 != 404 {c++} END{print c+0}' "$tmp")
fi

# Replace existing row for DATE, then append the current one.
if grep -q "^${DATE}	" "$OUT"; then
  filtered="$(mktemp)"
  grep -v "^${DATE}	" "$OUT" > "$filtered"
  mv "$filtered" "$OUT"
fi

printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$DATE" "$push_success" "$push_over_quota" "${push_remain:-}" "${pushed_total:-}" \
  "$baidu_hits" "$baidu_standards" "$baidu_200" "$baidu_404" "$baidu_other" >> "$OUT"

tail -n 2 "$OUT"
