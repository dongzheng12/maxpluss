#!/usr/bin/env bash
# bxz production container / probe / log alert hook.
# Server path: /opt/biaozhunxiaozhi/scripts/bxz-container-restart-alert.sh
# Cron: * * * * * /bin/bash /opt/biaozhunxiaozhi/scripts/bxz-container-restart-alert.sh >> /var/log/bxz-container-restart-alert.log 2>&1

set -u

ENV_FILE="${ENV_FILE:-/opt/biaozhunxiaozhi/services/api/.env}"
STATE_DIR="${STATE_DIR:-/var/lib/bxz-monitor}"
LOG_FILE="${LOG_FILE:-/var/log/bxz-container-restart-alert.log}"
CONTAINERS=(bxz-api bxz-pg-prod bxz-dedup)
HOSTNAME_S="$(hostname)"
NOW="$(date '+%Y-%m-%d %H:%M:%S')"
PROBE_FAIL_THRESHOLD="${PROBE_FAIL_THRESHOLD:-2}"
PROBE_RECOVER_THRESHOLD="${PROBE_RECOVER_THRESHOLD:-2}"
PROBE_TIMEOUT_SECONDS="${PROBE_TIMEOUT_SECONDS:-10}"
LOG_ALERT_DEDUPE_SECONDS="${LOG_ALERT_DEDUPE_SECONDS:-600}"
ALERT_DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  ALERT_DRY_RUN=1
  STATE_DIR="$(mktemp -d /tmp/bxz-monitor-dry-run.XXXXXX)"
  trap 'rm -rf "$STATE_DIR"' EXIT
elif [ -n "${1:-}" ] && [ "${1:-}" != "--test-alert" ]; then
  echo "Usage: $0 [--dry-run|--test-alert]" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

WEBHOOK=""
SECRET=""
if [ -f "$ENV_FILE" ]; then
  WEBHOOK="$(grep -E '^ALERT_WEBHOOK_URL=' "$ENV_FILE" | head -1 | sed -e 's/^ALERT_WEBHOOK_URL=//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")"
  SECRET="$(grep -E '^ALERT_SIGN_SECRET=' "$ENV_FILE" | head -1 | sed -e 's/^ALERT_SIGN_SECRET=//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")"
fi

send_alert() {
  local title="$1"
  local body="$2"
  local content="${title}
${body}"

  if [ "$ALERT_DRY_RUN" -eq 1 ]; then
    log "dry-run alert suppressed: title='${title}'"
    printf '%s\n%s\n' "$title" "$body" | sed 's/^/[DRY-RUN] /'
    return
  fi

  if [ -z "$WEBHOOK" ]; then
    log "webhook missing, alert not sent: $title"
    return
  fi

  local payload
  payload="$(python3 - <<'PYEOF' "$content"
import json, sys
print(json.dumps({"msgtype": "text", "text": {"content": sys.argv[1]}}, ensure_ascii=False))
PYEOF
)"

  local url="$WEBHOOK"
  if [ -n "$SECRET" ]; then
    local ts sign
    ts="$(date +%s)000"
    sign="$(python3 - <<'PYEOF' "$ts" "$SECRET"
import hmac, hashlib, base64, urllib.parse, sys
ts = sys.argv[1]
secret = sys.argv[2]
s = f"{ts}\n{secret}"
h = hmac.new(secret.encode("utf-8"), s.encode("utf-8"), hashlib.sha256).digest()
print(urllib.parse.quote_plus(base64.b64encode(h)))
PYEOF
)"
    if echo "$WEBHOOK" | grep -q '?'; then
      url="${WEBHOOK}&timestamp=${ts}&sign=${sign}"
    else
      url="${WEBHOOK}?timestamp=${ts}&sign=${sign}"
    fi
  fi

  local http_code body_resp
  http_code="$(curl -sS -m 10 -o /tmp/.bxz_alert_resp.$$ -w '%{http_code}' -H 'Content-Type: application/json' -X POST -d "$payload" "$url" 2>&1)"
  body_resp="$(head -c 200 /tmp/.bxz_alert_resp.$$ 2>/dev/null)"
  rm -f /tmp/.bxz_alert_resp.$$
  log "alert sent: title='${title}' http=${http_code} resp=${body_resp}"
}

state_value() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] || return 0
  grep "^${key}=" "$file" | head -1 | cut -d= -f2-
}

write_probe_state() {
  local file="$1"
  local status="$2"
  local fail_count="$3"
  local success_count="$4"
  local last_alert="$5"
  local last_code="$6"
  local last_latency="$7"
  {
    echo "status=$status"
    echo "failCount=$fail_count"
    echo "successCount=$success_count"
    echo "lastAlert=$last_alert"
    echo "lastCode=$last_code"
    echo "lastLatency=$last_latency"
    echo "lastUpdate=$NOW"
  } > "$file"
}

probe_http() {
  local name="$1"
  local url="$2"
  local expect_code="$3"
  local expect_pattern="${4:-}"
  local state_file="$STATE_DIR/probe.${name}.state"
  local body_file="/tmp/.bxz_probe_${name}.$$"
  local meta http_code latency result body_sample local_health local_health_code

  meta="$(curl -sS -m "$PROBE_TIMEOUT_SECONDS" -o "$body_file" -w '%{http_code} %{time_total}' "$url" 2>>"$body_file" || true)"
  if echo "$meta" | grep -Eq '^[0-9]{3} '; then
    http_code="$(echo "$meta" | awk '{print $1}')"
    latency="$(echo "$meta" | awk '{print $2}')"
  else
    http_code="000"
    latency="0"
    echo "$meta" > "$body_file"
  fi

  result="FAIL"
  if [ "$http_code" = "$expect_code" ]; then
    if [ -z "$expect_pattern" ] || grep -q "$expect_pattern" "$body_file" 2>/dev/null; then
      result="OK"
    fi
  fi

  local prev_status fail_count success_count last_alert
  prev_status="$(state_value "$state_file" status)"
  fail_count="$(state_value "$state_file" failCount)"
  success_count="$(state_value "$state_file" successCount)"
  last_alert="$(state_value "$state_file" lastAlert)"
  [ -n "$fail_count" ] || fail_count=0
  [ -n "$success_count" ] || success_count=0
  [ -n "$last_alert" ] || last_alert=none

  if [ ! -f "$state_file" ]; then
    if [ "$result" = "OK" ]; then
      write_probe_state "$state_file" OK 0 1 none "$http_code" "$latency"
    else
      write_probe_state "$state_file" FAIL 1 0 none "$http_code" "$latency"
    fi
    log "probe state init: $name result=$result code=$http_code latency=$latency"
    rm -f "$body_file"
    return
  fi

  if [ "$result" = "OK" ]; then
    fail_count=0
    success_count=$((success_count + 1))
    if [ "$prev_status" = "ALERT" ] && [ "$success_count" -ge "$PROBE_RECOVER_THRESHOLD" ]; then
      send_alert "[bxz prod recovery] ${name} 恢复" "环境: production
主机: ${HOSTNAME_S}
时间: ${NOW}
探针: ${name}
URL: ${url}
HTTP: ${http_code}
Latency: ${latency}s"
      write_probe_state "$state_file" OK 0 "$success_count" recovered "$http_code" "$latency"
      log "probe recovered: $name code=$http_code latency=$latency"
    else
      write_probe_state "$state_file" OK 0 "$success_count" "$last_alert" "$http_code" "$latency"
    fi
    rm -f "$body_file"
    return
  fi

  fail_count=$((fail_count + 1))
  success_count=0
  body_sample="$(head -c 300 "$body_file" 2>/dev/null)"
  if [ "$name" = "api-health" ]; then
    local_health="$(curl -sS -m 5 -o /tmp/.bxz_local_health.$$ -w '%{http_code}' http://localhost:3000/health 2>&1)"
    local_health_code="$local_health"
    rm -f /tmp/.bxz_local_health.$$
  else
    local_health_code="not_checked"
  fi

  if [ "$fail_count" -ge "$PROBE_FAIL_THRESHOLD" ] && [ "$prev_status" != "ALERT" ]; then
    send_alert "[bxz prod alert] ${name} 拨测失败" "环境: production
主机: ${HOSTNAME_S}
时间: ${NOW}
探针: ${name}
URL: ${url}
期望: HTTP ${expect_code}${expect_pattern:+ + body pattern ${expect_pattern}}
实际: HTTP ${http_code}, latency=${latency}s
连续失败: ${fail_count}
localhost:3000/health: ${local_health_code}
响应样本:
${body_sample}"
    write_probe_state "$state_file" ALERT "$fail_count" 0 alerted "$http_code" "$latency"
    log "probe alert: $name code=$http_code latency=$latency fail_count=$fail_count"
  else
    write_probe_state "$state_file" "$prev_status" "$fail_count" 0 "$last_alert" "$http_code" "$latency"
  fi

  rm -f "$body_file"
}

check_pg_isready() {
  local name="bxz-pg-prod"
  local pg_state_file="$STATE_DIR/${name}.pgnotready"
  if ! docker inspect "$name" >/dev/null 2>&1; then
    log "container $name not found, skip pg_isready"
    return
  fi
  if docker exec "$name" pg_isready -U bxz_prod -d bxz_prod -q >/dev/null 2>&1; then
    if [ -f "$pg_state_file" ]; then
      log "pg_isready recovered: $name"
      rm -f "$pg_state_file"
    fi
    return
  fi
  if [ ! -f "$pg_state_file" ]; then
    send_alert "[bxz prod alert] ${name} pg_isready 失败" "环境: production
主机: ${HOSTNAME_S}
容器: ${name}
时间: ${NOW}
事件: pg_isready 拒连（容器仍 running 但 PG server 不接受连接）
建议排查: docker logs ${name} --since 10m"
    log "alert triggered: ${name} pg_isready failed"
    touch "$pg_state_file"
  fi
}

check_container() {
  local name="$1"
  local state_file="$STATE_DIR/${name}.state"
  local info
  info="$(docker inspect --format '{{.Id}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.State.OOMKilled}}|{{.State.Status}}' "$name" 2>/dev/null)"
  if [ -z "$info" ]; then
    log "container $name not found, skip"
    return
  fi

  local cid restart started oom status
  cid="$(echo "$info" | cut -d'|' -f1)"
  restart="$(echo "$info" | cut -d'|' -f2)"
  started="$(echo "$info" | cut -d'|' -f3)"
  oom="$(echo "$info" | cut -d'|' -f4)"
  status="$(echo "$info" | cut -d'|' -f5)"

  local fatal_lines fatal_hash
  fatal_lines="$(docker logs --since 10m "$name" 2>&1 | grep -aE 'heap out of memory|Allocation failed|FATAL ERROR|unhandledRejection|uncaughtException|Killed' | tail -20)"
  fatal_hash=""
  if [ -n "$fatal_lines" ]; then
    fatal_hash="$(printf '%s' "$fatal_lines" | sha256sum | awk '{print $1}' | cut -c1-16)"
  fi

  local sig="${cid}|${restart}|${started}|${oom}|${fatal_hash}"

  if [ ! -f "$state_file" ]; then
    {
      echo "container=$name"
      echo "id=$cid"
      echo "restart=$restart"
      echo "startedAt=$started"
      echo "oomKilled=$oom"
      echo "status=$status"
      echo "fatalHash=$fatal_hash"
      echo "lastSig=$sig"
      echo "initAt=$NOW"
    } > "$state_file"
    log "state init: $name restart=$restart oom=$oom fatalHash=${fatal_hash:-none}"
    return
  fi

  local prev_restart prev_started prev_oom prev_fatal_hash prev_sig
  prev_restart="$(state_value "$state_file" restart)"
  prev_started="$(state_value "$state_file" startedAt)"
  prev_oom="$(state_value "$state_file" oomKilled)"
  prev_fatal_hash="$(state_value "$state_file" fatalHash)"
  prev_sig="$(state_value "$state_file" lastSig)"

  if [ "$sig" = "$prev_sig" ]; then
    return
  fi

  local events="" sep=""
  if [ "$restart" != "$prev_restart" ] && [ "$restart" -gt "$prev_restart" ] 2>/dev/null; then
    events="${events}${sep}restart count ${prev_restart} -> ${restart}"
    sep="; "
  fi
  if [ "$started" != "$prev_started" ]; then
    events="${events}${sep}startedAt ${prev_started} -> ${started}"
    sep="; "
  fi
  if [ "$oom" = "true" ] && [ "$prev_oom" != "true" ]; then
    events="${events}${sep}OOMKilled=true (prev=${prev_oom})"
    sep="; "
  fi
  if [ -n "$fatal_hash" ] && [ "$fatal_hash" != "$prev_fatal_hash" ]; then
    events="${events}${sep}fatal log new pattern (hash=${fatal_hash})"
    sep="; "
  fi

  if [ -n "$events" ]; then
    local body
    body="环境: production
主机: ${HOSTNAME_S}
容器: ${name}
时间: ${NOW}
事件: ${events}
RestartCount: ${prev_restart} -> ${restart}
StartedAt: ${prev_started} -> ${started}
OOMKilled: ${oom}
Status: ${status}"
    if [ -n "$fatal_lines" ]; then
      body="${body}

最近 fatal 日志（最多 20 行）:
${fatal_lines}"
    fi
    body="${body}

建议排查: docker logs ${name} --since 10m"
    send_alert "[bxz prod alert] ${name} 容器异常" "$body"
    log "alert triggered: ${name} events=${events}"
  fi

  {
    echo "container=$name"
    echo "id=$cid"
    echo "restart=$restart"
    echo "startedAt=$started"
    echo "oomKilled=$oom"
    echo "status=$status"
    echo "fatalHash=$fatal_hash"
    echo "lastSig=$sig"
    echo "lastUpdate=$NOW"
  } > "$state_file"
}

alert_log_category() {
  local category="$1"
  local title="$2"
  local count="$3"
  local sample="$4"
  local hash
  hash="$(printf '%s\n%s\n%s' "$category" "$count" "$sample" | sha256sum | awk '{print $1}' | cut -c1-16)"
  local state_file="$STATE_DIR/log.${category}.state"
  local now_epoch last_epoch last_hash
  now_epoch="$(date +%s)"
  last_epoch="$(state_value "$state_file" lastEpoch)"
  last_hash="$(state_value "$state_file" hash)"
  [ -n "$last_epoch" ] || last_epoch=0

  if [ "$hash" = "$last_hash" ] && [ $((now_epoch - last_epoch)) -lt "$LOG_ALERT_DEDUPE_SECONDS" ]; then
    log "log alert deduped: category=$category hash=$hash count=$count"
    return
  fi

  send_alert "$title" "环境: production
主机: ${HOSTNAME_S}
时间: ${NOW}
类别: ${category}
命中数: ${count}
去重 hash: ${hash}
样本:
${sample}"
  {
    echo "hash=$hash"
    echo "lastEpoch=$now_epoch"
    echo "lastUpdate=$NOW"
  } > "$state_file"
  log "log alert sent: category=$category hash=$hash count=$count"
}

check_api_logs() {
  local tmp="/tmp/.bxz_api_logs.$$"
  docker logs bxz-api --since 2m 2>&1 > "$tmp" || {
    log "docker logs bxz-api failed"
    rm -f "$tmp"
    return
  }

  local hard_count hard_sample
  hard_sample="$(grep -aE 'FATAL|OOM|Prisma error|P2002|P2034|25P02|uncaughtException|unhandledRejection' "$tmp" | tail -20)"
  hard_count="$(printf '%s\n' "$hard_sample" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$hard_count" -gt 0 ]; then
    alert_log_category "api-hard-error" "[bxz prod alert] bxz-api 硬错误日志" "$hard_count" "$hard_sample"
  fi

  local http5_sample http5_count
  http5_sample="$(grep -aE '(^|[^0-9])(500|502|503|504)([^0-9]|$)|status=5[0-9][0-9]|HTTP/[^ ]+ 5[0-9][0-9]|HTTP 5[0-9][0-9]' "$tmp" | tail -30)"
  http5_count="$(printf '%s\n' "$http5_sample" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$http5_count" -ge 5 ]; then
    alert_log_category "api-5xx-spike" "[bxz prod alert] bxz-api 5xx 突增" "$http5_count" "$http5_sample"
  fi

  local llm_sample llm_count
  llm_sample="$(grep -aiE 'LLM|AiCallFailedError|timeout|overloaded|POLISH_AI_OVERLOADED|AI 解析服务繁忙|服务暂时不可用' "$tmp" | tail -30)"
  llm_count="$(printf '%s\n' "$llm_sample" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$llm_count" -ge 3 ]; then
    alert_log_category "api-llm-failures" "[bxz prod alert] bxz-api LLM 连续失败" "$llm_count" "$llm_sample"
  fi

  rm -f "$tmp"
}

check_mem_threshold() {
  local name="bxz-api"
  local sf="$STATE_DIR/${name}.memhigh"
  local raw num unit cur_mb level prev up rc icon
  raw="$(docker stats "$name" --no-stream --format '{{.MemUsage}}' 2>/dev/null | awk '{print $1}')"
  if [ -z "$raw" ] || [ "$raw" = "0B" ]; then
    log "mem sample skipped: $name raw=${raw:-empty}"
    return
  fi
  unit="$(echo "$raw" | grep -oE '(MiB|GiB)$' || true)"
  num="$(echo "$raw" | sed -E 's/(MiB|GiB)$//' | cut -d. -f1)"
  if [ -z "$unit" ] || ! echo "$num" | grep -Eq '^[0-9]+$'; then
    log "mem sample unparsable: $name raw=$raw"
    return
  fi

  cur_mb="$num"
  [ "$unit" = "GiB" ] && cur_mb=$((num * 1024))
  level=""
  if [ "$cur_mb" -ge 1400 ]; then
    level="red"
  elif [ "$cur_mb" -ge 1200 ]; then
    level="yellow"
  fi

  prev=""
  [ -f "$sf" ] && prev="$(cat "$sf")"
  if [ -z "$level" ]; then
    if [ -n "$prev" ]; then
      send_alert "[bxz prod alert] ${name} 内存回落正常" "当前 ${cur_mb}MB，低于警戒线"
      rm -f "$sf"
    fi
    return
  fi
  [ "$level" = "$prev" ] && return

  up="$(docker inspect "$name" --format '{{.State.StartedAt}}' 2>/dev/null)"
  rc="$(docker inspect "$name" --format '{{.RestartCount}}' 2>/dev/null)"
  icon=">=1.2GB warning"
  [ "$level" = "red" ] && icon=">=1.4GB critical"
  send_alert "[bxz prod alert] ${name} 内存 ${icon}" "环境: production
主机: ${HOSTNAME_S}
容器: ${name}
当前内存: ${cur_mb}MB / heap 上限 1536MB
RestartCount: ${rc}
StartedAt: ${up}
说明: 内存预警，未自动重启（周一 04:50 定时重启兜底）"
  echo "$level" > "$sf"
  log "mem alert: $name ${cur_mb}MB level=$level"
}

if [ "${1:-}" = "--test-alert" ]; then
  send_alert "[bxz prod alert] TEST ALERT - bxz container monitor" "TEST ALERT - bxz container monitor
环境: production
主机: ${HOSTNAME_S}
时间: ${NOW}
说明: 这是 hook 安装后的连通性测试，不是真实事件。"
  exit 0
fi

if [ "$ALERT_DRY_RUN" -eq 1 ]; then
  log "dry-run mode: using temp state dir $STATE_DIR and suppressing DingTalk sends"
fi

for c in "${CONTAINERS[@]}"; do
  check_container "$c"
done

check_pg_isready
check_mem_threshold
probe_http "web-home" "https://biaozhunxiaozhi.com/" "200"
probe_http "api-health" "https://api.biaozhunxiaozhi.com/health" "200" '"ok":true'
check_api_logs
