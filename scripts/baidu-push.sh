#!/usr/bin/env bash
#
# 标准小智 pSEO — 百度主动推送（快速收录）
#
# 数据源 : data/seo-pages/manifest.jsonl  （每行 {"code","fname","pub_date"}）
# URL    : https://www.biaozhunxiaozhi.com/standards/<fname>
# 去重   : data/seo-pages/.baidu-pushed-urls.txt  （已被 .gitignore 覆盖，不进 git）
# 日志   : logs/baidu-push-YYYY-MM-DD.log
#
# token  : 只从环境变量 BAIDU_PUSH_TOKEN 读，绝不硬编码。
#          export BAIDU_PUSH_TOKEN=xxxx  之后再跑本脚本。
#
# 用法   :
#   scripts/baidu-push.sh                 # 推默认 10 条（当前百度日配额约 10，脚本会在 over-quota 时降级逐条吃满）
#   scripts/baidu-push.sh --limit=3       # 只推 3 条
#   scripts/baidu-push.sh --dry-run       # 只选 URL 打印，不推、不写去重（不需要 token）
#   scripts/baidu-push.sh --limit=2000 --dry-run
#
# 选 URL 策略：默认按商业价值排序取 N 条（去重文件保证不重复消耗配额）。
#
set -eu

# ── 路径（相对脚本自身定位，cron 下 cwd 不确定也能跑）────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MANIFEST="$REPO_ROOT/data/seo-pages/manifest.jsonl"
PUSHED="$REPO_ROOT/data/seo-pages/.baidu-pushed-urls.txt"
SEED_URLS="$REPO_ROOT/data/seo-pages/baidu-priority-seeds.txt"
LOG_DIR="$REPO_ROOT/logs"

# ── 可配置 ──────────────────────────────────────────────────────────
SITE="https://biaozhunxiaozhi.com"              # 必须与百度站长平台验证站点完全一致（无www；2026-05-26 起，配合 www→无www 301 与站长无www验证）
API="http://data.zz.baidu.com/urls"
HTTP_TIMEOUT=15                                  # 代码铁律：HTTP 必须有超时

LIMIT=10         # 当前百度主动推送日配额约 10 条，默认吃满；over-quota 时会降级逐条推送
STRATEGY=priority
DRY_RUN=0

# ── 参数解析 ────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --limit=*)  LIMIT="${arg#*=}" ;;
    --strategy=*) STRATEGY="${arg#*=}" ;;
    --dry-run)  DRY_RUN=1 ;;
    --site=*)   SITE="${arg#*=}" ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 64 ;;
  esac
done

case "$LIMIT" in
  ''|*[!0-9]*) echo "ERROR: --limit 必须是正整数，收到: $LIMIT" >&2; exit 64 ;;
esac
[ "$LIMIT" -ge 1 ] || { echo "ERROR: --limit 必须 >=1" >&2; exit 64; }
case "$STRATEGY" in
  priority|random) ;;
  *) echo "ERROR: --strategy 只支持 priority 或 random，收到: $STRATEGY" >&2; exit 64 ;;
esac

# ── 前置检查 ────────────────────────────────────────────────────────
[ -f "$MANIFEST" ] || { echo "ERROR: manifest 不存在: $MANIFEST" >&2; echo "请先跑 node scripts/generate-seo-pages.js" >&2; exit 1; }
mkdir -p "$LOG_DIR"
touch "$PUSHED"

LOG="$LOG_DIR/baidu-push-$(date +%F).log"
TS() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(TS)] $*" | tee -a "$LOG"; }

# 临时文件
TMP_SEL="$(mktemp)"
trap 'rm -f "$TMP_SEL"' EXIT

# ── 选 URL：商业种子 URL 优先，再从 manifest 按策略补足 LIMIT 条 ────
if [ "$STRATEGY" = "random" ]; then
  node - "$MANIFEST" "$PUSHED" "$SITE" "$LIMIT" > "$TMP_SEL" <<'NODE'
const fs = require('node:fs')
const [manifest, pushedFile, site, limitRaw] = process.argv.slice(2)
const limit = Number(limitRaw)
const pushed = new Set(fs.existsSync(pushedFile) ? fs.readFileSync(pushedFile, 'utf8').split(/\r?\n/).filter(Boolean) : [])
const rows = []
for (const line of fs.readFileSync(manifest, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  let obj
  try { obj = JSON.parse(line) } catch { continue }
  if (!obj.fname) continue
  const url = `${site}/standards/${obj.fname}`
  if (!pushed.has(url)) rows.push(url)
}
rows.sort(() => Math.random() - 0.5).slice(0, limit).forEach(url => console.log(url))
NODE
else
  TMP_PUSHED_PLUS="$(mktemp)"
  trap 'rm -f "$TMP_SEL" "$TMP_PUSHED_PLUS"' EXIT
  cp "$PUSHED" "$TMP_PUSHED_PLUS"

  if [ -f "$SEED_URLS" ]; then
    awk -v pushedfile="$PUSHED" '
      BEGIN {
        while ((getline l < pushedfile) > 0) { if (l != "") seen[l] = 1 }
      }
      /^[[:space:]]*($|#)/ { next }
      {
        url = $0
        sub(/^[[:space:]]+/, "", url)
        sub(/[[:space:]]+$/, "", url)
        if (url != "" && !(url in seen)) {
          seen[url] = 1
          print url
        }
      }
    ' "$SEED_URLS" | head -n "$LIMIT" > "$TMP_SEL"
    cat "$TMP_SEL" >> "$TMP_PUSHED_PLUS"
  else
    : > "$TMP_SEL"
  fi

  SELECTED_SEEDS=$(wc -l < "$TMP_SEL" | tr -d ' ')
  REMAINING=$((LIMIT - SELECTED_SEEDS))
  if [ "$REMAINING" -gt 0 ]; then
    node "$REPO_ROOT/scripts/seo-priority.js" \
      --format=urls \
      --manifest="$MANIFEST" \
      --site="$SITE" \
      --limit="$REMAINING" \
      --exclude-pushed="$TMP_PUSHED_PLUS" >> "$TMP_SEL"
  fi
fi

SELECTED=$(wc -l < "$TMP_SEL" | tr -d ' ')

TOTAL=$(wc -l < "$MANIFEST" | tr -d ' ')
DONE=$(wc -l < "$PUSHED" | tr -d ' ')

log "选出 $SELECTED 条 (limit=$LIMIT strategy=$STRATEGY)  | manifest 总数=$TOTAL  已推=$DONE  site=$SITE"

if [ "$SELECTED" -eq 0 ]; then
  log "没有可推的未推过 URL（可能已全部推完）。退出。"
  exit 0
fi

# ── dry-run：只打印，不推、不写去重 ─────────────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] 不推送、不写去重。候选 URL 预览（前 10 条）:"
  head -n 10 "$TMP_SEL" | sed 's/^/    /'
  [ "$SELECTED" -gt 10 ] && echo "    ... 其余 $((SELECTED - 10)) 条省略"
  exit 0
fi

# ── 真推：token 必须存在 ────────────────────────────────────────────
: "${BAIDU_PUSH_TOKEN:?ERROR: 环境变量 BAIDU_PUSH_TOKEN 未设置，无法推送}"

log "POST $SELECTED 条到百度 ..."
HTTP_BODY=$(mktemp); trap 'rm -f "$TMP_SEL" "$HTTP_BODY"' EXIT
HTTP_CODE=$(curl -sS --max-time "$HTTP_TIMEOUT" \
  -H 'Content-Type:text/plain' \
  --data-binary @"$TMP_SEL" \
  -o "$HTTP_BODY" -w '%{http_code}' \
  "${API}?site=${SITE}&token=${BAIDU_PUSH_TOKEN}" ) || {
    log "ERROR: curl 失败（网络/超时），未写去重。"
    exit 3
  }

RESP=$(cat "$HTTP_BODY")
# 日志里隐去 token，原样记返回体
log "HTTP $HTTP_CODE  resp=$RESP"

ERR=$(printf '%s' "$RESP"     | grep -oE '"error":[0-9]+'   | head -1 | grep -oE '[0-9]+' || true)
SUCCESS=$(printf '%s' "$RESP" | grep -oE '"success":[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
REMAIN=$(printf '%s' "$RESP"  | grep -oE '"remain":[0-9]+'  | head -1 | grep -oE '[0-9]+' || true)

if [ -n "$ERR" ]; then
  MSG=$(printf '%s' "$RESP" | grep -oE '"message":"[^"]*"' | head -1)
  if printf '%s' "$RESP" | grep -qi 'over quota' && [ "$SELECTED" -gt 1 ]; then
    log "WARN: 批量推送超过今日剩余额度，降级为逐条推送，尽量吃满剩余额度。"
    ONE_OK=0
    ONE_STOP=0
    while IFS= read -r ONE_URL; do
      [ -n "$ONE_URL" ] || continue
      printf '%s\n' "$ONE_URL" > "$HTTP_BODY.one"
      ONE_CODE=$(curl -sS --max-time "$HTTP_TIMEOUT" \
        -H 'Content-Type:text/plain' \
        --data-binary @"$HTTP_BODY.one" \
        -o "$HTTP_BODY" -w '%{http_code}' \
        "${API}?site=${SITE}&token=${BAIDU_PUSH_TOKEN}" ) || {
          log "WARN: 单条推送 curl 失败，停止逐条重试。"
          ONE_STOP=1
          break
        }
      ONE_RESP=$(cat "$HTTP_BODY")
      ONE_ERR=$(printf '%s' "$ONE_RESP" | grep -oE '"error":[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
      ONE_SUCCESS=$(printf '%s' "$ONE_RESP" | grep -oE '"success":[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
      ONE_REMAIN=$(printf '%s' "$ONE_RESP" | grep -oE '"remain":[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
      log "single HTTP $ONE_CODE url=$ONE_URL resp=$ONE_RESP"
      if [ -n "$ONE_ERR" ]; then
        ONE_STOP=1
        break
      fi
      if [ "${ONE_SUCCESS:-0}" -ge 1 ]; then
        printf '%s\n' "$ONE_URL" >> "$PUSHED"
        ONE_OK=$((ONE_OK + 1))
      else
        ONE_STOP=1
        break
      fi
      [ "${ONE_REMAIN:-1}" -gt 0 ] || { ONE_STOP=1; break; }
    done < "$TMP_SEL"
    rm -f "$HTTP_BODY.one"
    NEWDONE=$(wc -l < "$PUSHED" | tr -d ' ')
    log "OK: single_success=$ONE_OK stopped=$ONE_STOP | 累计已推=$NEWDONE"
    echo "----------------------------------------" >> "$LOG"
    [ "$ONE_OK" -gt 0 ] && exit 0
  fi
  log "FAIL: 百度返回 error=$ERR $MSG  | 未写去重，可修正后重推。"
  exit 4
fi

if [ -z "$SUCCESS" ] || [ "$SUCCESS" -eq 0 ]; then
  log "WARN: success=0（可能 site 与验证站点不符 / URL 主机名不属于 site / 配额已用尽）。未写去重，可修正后重推。"
  exit 5
fi

# 部分成功（如配额不足）：success < 实际发送数。
# 此时无法得知具体哪几条进了，为避免把没推上去的误标为已推、永不重试，整批都不写去重。
if [ "$SUCCESS" -lt "$SELECTED" ]; then
  log "WARN: success=$SUCCESS < 发送=$SELECTED（多半是当日配额不足）。为避免误标，本批不写去重，下次会重新参与随机；remain=${REMAIN:-?}。建议把 --limit 调到 <= 当日配额。"
  exit 6
fi

# ── 全部成功：把这批 URL 追加进去重文件 ────────────────────────────
cat "$TMP_SEL" >> "$PUSHED"
NEWDONE=$(wc -l < "$PUSHED" | tr -d ' ')
log "OK: success=$SUCCESS  remain=${REMAIN:-?}  | 已记入去重，累计已推=$NEWDONE"
echo "----------------------------------------" >> "$LOG"
