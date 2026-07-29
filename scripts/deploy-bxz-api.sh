#!/usr/bin/env bash
#
# bxz-api 安全发布脚本（重构 SOP 铁律 5）
#
# 事故根因（2026-04-25 sales 上线）：
#   canary 和旧容器都用 host 网络监听 3000，canary EADDRINUSE 挂掉，
#   但健康检查 curl 127.0.0.1:3000/health 打到旧容器返 200 误判，
#   脚本停旧 + rename 后 bxz-api = Exited 的 canary → 服务 DOWN。
#
# 本脚本 10 条防线（对应你拉清单）：
#   1. canary 用 bridge + 127.0.0.1:3001:3000，永不复用宿主机 3000
#   2. 健康检查只允许打 3001（canary 身份绑定）
#   3. 停旧前硬性闸门（5 条件）
#   4. swap 前再次验证 canary 仍活着
#   5. swap 后再用 3000 正式端口 + commit 字段双校验
#   6. 自动回滚（swap 后 30s 内监控）
#   7. ENTRYPOINT/CMD 检查（防 docker commit 旁路污染）
#   8. /health/schema 返回 commit + schema drift 状态，脚本校验是本次发版版本
#   9. set -Eeuo pipefail + trap 严格模式
#   10. --dry-run 先演练
#
# 重要决策：**放弃 rename canary → bxz-api** 策略
#   原因：canary bridge + 3001，旧/新 bxz-api host + 3000 —— rename 不会改网络，
#   rename 后服务器端口错乱。改用 swap：stop 旧 → rename 旧为 old-<TS> 备用 →
#   rm canary → run 新 bxz-api（host 网络完整参数）→ 验证 → 失败秒回旧。
#   中断窗口 = run 新 bxz-api 到 listen 3000 的 3-5s，容忍范围。
#
# 用法：
#   bash scripts/deploy-bxz-api.sh              # 正常发布
#   bash scripts/deploy-bxz-api.sh --dry-run    # 只打印命令不执行
#
set -Eeuo pipefail

# ───────────────────────── 参数 ─────────────────────────
SERVER="${SERVER:-root@154.8.197.13}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10"

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
API_DIR="$PROJECT_DIR/services/api"

IMG_NAME="bxz-api"
IMG_TAG="prod"
CANARY_NAME="bxz-api-canary"
PROD_NAME="bxz-api"
CANARY_HOST_PORT=3001
PROD_HOST_PORT=3000

COMMIT="$(git -C "$PROJECT_DIR" rev-parse --short HEAD)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TS="$(date +%Y%m%d-%H%M%S)"
OLD_CONTAINER_NAME="bxz-api-old-$TS"
ROLLBACK_TAG="${IMG_NAME}:rollback-pre-deploy-$TS"

DRY_RUN=0
for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=1
done

# ───────────────────────── 工具函数 ─────────────────────────
C_R='\033[0;31m'; C_G='\033[0;32m'; C_Y='\033[1;33m'; C_B='\033[0;34m'; C_N='\033[0m'
info()  { printf "${C_B}▸ %s${C_N}\n" "$*"; }
ok()    { printf "${C_G}✓ %s${C_N}\n" "$*"; }
warn()  { printf "${C_Y}⚠ %s${C_N}\n" "$*"; }
err()   { printf "${C_R}✗ %s${C_N}\n" "$*"; }

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  DRY-RUN: $*"
  else
    eval "$@"
  fi
}

ssh_run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  DRY-RUN (ssh): $*"
  else
    ssh $SSH_OPTS "$SERVER" "$@"
  fi
}

# 失败 trap：打印诊断信息 + 绝不停旧容器
on_error() {
  local code=$?
  err "发布失败（exit=${code}），保留旧容器，收集诊断："
  echo ""
  echo "=== canary 容器状态 ==="
  ssh $SSH_OPTS "$SERVER" "docker inspect $CANARY_NAME --format 'State: {{.State.Status}} ExitCode: {{.State.ExitCode}} Started: {{.State.StartedAt}}' 2>/dev/null || echo '(canary 不存在)'" || true
  echo ""
  echo "=== canary 日志（最后 40 行） ==="
  ssh $SSH_OPTS "$SERVER" "docker logs $CANARY_NAME --tail 40 2>&1 || echo '(无日志)'" || true
  echo ""
  echo "=== 当前 bxz-api 容器状态 ==="
  ssh $SSH_OPTS "$SERVER" "docker ps -a --filter name=^bxz-api --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'" || true
  echo ""
  err "旧 bxz-api 容器未被动过，生产服务不受影响。修复后重跑本脚本。"
  exit $code
}
trap on_error ERR

# ───────────────────────── 阶段 0：前置检查 ─────────────────────────
info "阶段 0：前置检查"
echo "  COMMIT=$COMMIT  BUILT_AT=$BUILT_AT"
echo "  TS=$TS"
echo "  SERVER=$SERVER"
[[ $DRY_RUN -eq 1 ]] && warn "DRY-RUN 模式：所有命令只打印不执行"

# git clean
if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
  err "git 工作区不干净，commit 后再发版"
  exit 1
fi

# 远程连通性
ssh $SSH_OPTS "$SERVER" "echo ok" > /dev/null 2>&1 || { err "SSH 不通 $SERVER"; exit 1; }
ok "SSH 可达"

# ───────────────────────── 阶段 1：本地 build ─────────────────────────
info "阶段 1：本地 bundle + obfuscate + docker build（linux/amd64）"
run "cd '$PROJECT_DIR' && bash scripts/build-obfuscate.sh"
run "cd '$API_DIR' && docker buildx build --platform linux/amd64 \
    --no-cache \
    -f Dockerfile.prod \
    --build-arg BUILD_COMMIT=$COMMIT \
    --build-arg BUILT_AT=$BUILT_AT \
    -t $IMG_NAME:$IMG_TAG --load ."

# 校验镜像 ENTRYPOINT/CMD 正确（防 docker commit 旁路污染）
info "阶段 1.5：校验新镜像 ENTRYPOINT/CMD"
if [[ $DRY_RUN -eq 0 ]]; then
  EP=$(docker image inspect $IMG_NAME:$IMG_TAG --format '{{json .Config.Entrypoint}}')
  CMD=$(docker image inspect $IMG_NAME:$IMG_TAG --format '{{json .Config.Cmd}}')
  echo "  ENTRYPOINT=$EP"
  echo "  CMD=$CMD"
  if echo "$EP $CMD" | grep -qiE 'sleep|tail -f|^\["/?bin/sh"\]$'; then
    err "镜像 ENTRYPOINT/CMD 包含可疑调试命令（sleep/tail/裸 sh），拒绝发布"
    exit 1
  fi
  ok "ENTRYPOINT/CMD 校验通过"
fi

# ───────────────────────── 阶段 2：save + scp ─────────────────────────
info "阶段 2：save + scp 镜像"
run "docker save $IMG_NAME:$IMG_TAG | gzip > /tmp/bxz-api.tar.gz"
run "ls -lh /tmp/bxz-api.tar.gz"
run "scp $SSH_OPTS /tmp/bxz-api.tar.gz $SERVER:/mnt/datadisk0/bxz-api.tar.gz"

# ───────────────────────── 阶段 3：远程 load + 打镜像级 rollback tag ─────────────────────────
info "阶段 3：远程 docker load + 打 rollback tag（镜像级秒回）"
ssh_run "docker tag $IMG_NAME:$IMG_TAG $ROLLBACK_TAG && docker load -i /mnt/datadisk0/bxz-api.tar.gz"

# ───────────────────────── 阶段 4：起 canary（bridge + 3001）─────────────────────────
info "阶段 4：起 canary 容器（bridge 网络 + 127.0.0.1:$CANARY_HOST_PORT → 3000）"
# 防护：先清理可能残留的同名 canary（上次失败遗留）
ssh_run "docker rm -f $CANARY_NAME 2>/dev/null || true"

# 提取当前生产 BXZ_INTERNAL_SECRET（从正在跑的 bxz-api 继承）
if [[ $DRY_RUN -eq 0 ]]; then
  SECRET=$(ssh $SSH_OPTS "$SERVER" "docker inspect $PROD_NAME --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep '^BXZ_INTERNAL_SECRET=' | cut -d= -f2-")
  [[ -z "$SECRET" ]] && { err "无法提取 BXZ_INTERNAL_SECRET，中止"; exit 1; }
else
  SECRET="DRY_RUN_SECRET"
fi

ssh_run "docker run -d --name $CANARY_NAME \
  -p 127.0.0.1:$CANARY_HOST_PORT:3000 \
  --memory=2g --memory-swap=2g \
  --log-opt max-size=50m --log-opt max-file=3 \
  -v /opt/biaozhunxiaozhi/services/api/.env:/app/.env:ro \
  -v /opt/biaozhunxiaozhi/services/api/prisma/dev.db:/app/prisma/dev.db \
  -v /opt/biaozhunxiaozhi/services/api/prisma/data:/app/prisma/data \
  -v /opt/biaozhunxiaozhi/services/api/prisma/migrations:/app/prisma/migrations:ro \
  -v /opt/biaozhunxiaozhi/services/api/certs:/app/certs:ro \
  -v /opt/biaozhunxiaozhi/services/api/public:/app/public:ro \
  -v /mnt/datadisk0/bxz-uploads:/app/uploads \
  -e DATABASE_URL=file:/app/prisma/dev.db \
  -e UPLOAD_DIR=/app/uploads \
  -e NODE_ENV=production \
  -e TZ=Asia/Shanghai \
  -e BXZ_INTERNAL_SECRET='$SECRET' \
  $IMG_NAME:$IMG_TAG"

# ───────────────────────── 阶段 5：硬性闸门 5 条件 ─────────────────────────
info "阶段 5：canary 硬性闸门（5 条件全过才继续）"

if [[ $DRY_RUN -eq 0 ]]; then
  # 等最多 30s 让应用 listen 3000
  HEALTH_OK=0
  for i in $(seq 1 10); do
    sleep 3
    RESP=$(ssh $SSH_OPTS "$SERVER" "curl -fsS -m 3 http://127.0.0.1:$CANARY_HOST_PORT/health/schema 2>/dev/null" || true)
    if [[ -n "$RESP" ]]; then
      HEALTH_OK=1
      echo "  第 $i 次健康检查 OK: $RESP"
      break
    fi
    echo "  第 $i 次未通过，继续等"
  done
  [[ $HEALTH_OK -eq 0 ]] && { err "条件 1 失败：/health/schema 30s 内不通"; exit 1; }
  ok "条件 1：curl :$CANARY_HOST_PORT/health/schema 2xx"

  # 校验 commit 字段 == 本次发布 commit（核心防误判）
  HEALTH_COMMIT=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("commit",""))')
  if [[ "$HEALTH_COMMIT" != "$COMMIT" ]]; then
    err "条件 2 失败：/health/schema 返回 commit=$HEALTH_COMMIT 不是本次发版 ${COMMIT}（可能误打旧容器）"
    exit 1
  fi
  ok "条件 2：commit 字段 == $COMMIT"

  # 容器 State.Running + ExitCode=0
  STATE_JSON=$(ssh $SSH_OPTS "$SERVER" "docker inspect $CANARY_NAME --format '{{.State.Running}}|{{.State.ExitCode}}|{{.State.Health.Status}}'")
  IFS='|' read -r RUNNING EXITCODE HEALTH_STATE <<< "$STATE_JSON"
  [[ "$RUNNING" != "true" ]] && { err "条件 3 失败：容器 Running=$RUNNING"; exit 1; }
  [[ "$EXITCODE" != "0" ]] && { err "条件 3 失败：ExitCode=$EXITCODE"; exit 1; }
  ok "条件 3：Running=true ExitCode=0 HealthStatus=$HEALTH_STATE"

  # 容器内 node 进程存活 + 监听 3000
  PS_OK=$(ssh $SSH_OPTS "$SERVER" "docker exec $CANARY_NAME sh -c 'ps -ef | grep -v grep | grep -cE \"node.*server\\.mjs\"' || echo 0")
  [[ "$PS_OK" == "0" ]] && { err "条件 4 失败：canary 内无 node server.mjs 进程"; exit 1; }
  ok "条件 4：canary 内 $PS_OK 个 node server.mjs 进程存活"

  # 日志无启动失败关键字
  BAD_LOG=$(ssh $SSH_OPTS "$SERVER" "docker logs $CANARY_NAME 2>&1 | grep -cE 'EADDRINUSE|fatal|Cannot find module|permission denied|PrismaClientInitializationError' || true")
  [[ "$BAD_LOG" != "0" ]] && { err "条件 5 失败：canary 日志出现启动失败关键字（$BAD_LOG 处）"; exit 1; }
  ok "条件 5：canary 日志无 fatal 关键字"
fi

# ───────────────────────── 阶段 6：swap 前再次确认（防竞态）─────────────────────────
info "阶段 6：swap 前再次确认 canary 活着"
if [[ $DRY_RUN -eq 0 ]]; then
  FINAL_STATE=$(ssh $SSH_OPTS "$SERVER" "docker inspect $CANARY_NAME --format '{{.State.Running}}|{{.State.ExitCode}}'")
  [[ "$FINAL_STATE" != "true|0" ]] && { err "swap 前瞬间 canary 挂了（state=${FINAL_STATE}）"; exit 1; }
  ssh $SSH_OPTS "$SERVER" "curl -fsS -m 3 http://127.0.0.1:$CANARY_HOST_PORT/health/schema > /dev/null" || { err "swap 前 /health/schema 不通"; exit 1; }
  ok "canary 仍然健康"

  info "阶段 6.5：Prisma schema 同步门禁（通过后才允许停止 $PROD_NAME）"
  ssh $SSH_OPTS "$SERVER" "docker exec $CANARY_NAME sh -lc 'cd /app && npx prisma db push --skip-generate --schema /app/prisma/schema.prisma'" || {
    err "Prisma db push --skip-generate 未通过，拒绝停旧容器"
    exit 1
  }
  ok "Prisma db push --skip-generate 门禁通过"
fi

# ───────────────────────── 阶段 7：swap 切换 ─────────────────────────
info "阶段 7：停旧 → 留 old 容器作秒级回滚备用 → rm canary → run 新正式容器"
# 7.1 停旧 + 改名留备
ssh_run "docker stop $PROD_NAME && docker rename $PROD_NAME $OLD_CONTAINER_NAME"
# 7.2 canary 使命完成，销毁（正式容器要用 host 网络 + 完整参数，不能 rename）
ssh_run "docker rm -f $CANARY_NAME"
# 7.3 起正式 bxz-api（host 网络 + 生产完整 bind mount）
ssh_run "docker run -d --name $PROD_NAME --network host \
  --memory=2g --memory-swap=2g \
  --restart unless-stopped \
  --log-opt max-size=50m --log-opt max-file=3 \
  -v /opt/biaozhunxiaozhi/services/api/.env:/app/.env:ro \
  -v /opt/biaozhunxiaozhi/services/api/prisma/dev.db:/app/prisma/dev.db \
  -v /opt/biaozhunxiaozhi/services/api/prisma/data:/app/prisma/data \
  -v /opt/biaozhunxiaozhi/services/api/prisma/migrations:/app/prisma/migrations:ro \
  -v /opt/biaozhunxiaozhi/services/api/certs:/app/certs:ro \
  -v /opt/biaozhunxiaozhi/services/api/public:/app/public:ro \
  -v /mnt/datadisk0/bxz-uploads:/app/uploads \
  -e DATABASE_URL=file:/app/prisma/dev.db \
  -e UPLOAD_DIR=/app/uploads \
  -e NODE_ENV=production \
  -e TZ=Asia/Shanghai \
  -e BXZ_INTERNAL_SECRET='$SECRET' \
  $IMG_NAME:$IMG_TAG"

# ───────────────────────── 阶段 8：正式验证（3000 + commit） ─────────────────────────
info "阶段 8：正式端口 3000 验证 + commit 二次校验"
if [[ $DRY_RUN -eq 0 ]]; then
  OK_3000=0
  for i in $(seq 1 10); do
    sleep 3
    RESP=$(ssh $SSH_OPTS "$SERVER" "curl -fsS -m 3 http://127.0.0.1:$PROD_HOST_PORT/health/schema" || true)
    if [[ -n "$RESP" ]]; then
      OK_3000=1
      echo "  第 $i 次 OK: $RESP"
      break
    fi
    echo "  第 $i 次未通过"
  done
  if [[ $OK_3000 -eq 0 ]]; then
    err "正式验证失败：:3000/health/schema 30s 不通，自动回滚"
    # 自动回滚
    ssh $SSH_OPTS "$SERVER" "docker rm -f $PROD_NAME && docker rename $OLD_CONTAINER_NAME $PROD_NAME && docker start $PROD_NAME"
    sleep 5
    ssh $SSH_OPTS "$SERVER" "curl -fsS http://127.0.0.1:$PROD_HOST_PORT/health/schema" && ok "已回滚到旧版" || err "回滚后仍不通，人工介入"
    exit 1
  fi
  ok "正式 :3000/health/schema 通"

  VERIFIED_COMMIT=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("commit",""))')
  [[ "$VERIFIED_COMMIT" != "$COMMIT" ]] && { err "正式 commit=$VERIFIED_COMMIT 不对，疑似错误镜像，手工排查"; exit 1; }
  ok "正式 commit == $COMMIT"

  # 外网 https 最终验证
  HTTPS_RESP=$(curl -fsS -m 10 https://api.biaozhunxiaozhi.com/health/schema 2>/dev/null || echo "")
  [[ -n "$HTTPS_RESP" ]] && ok "外网 https 验证通：$HTTPS_RESP" || warn "外网 https 验证不通（可能 nginx 未配 /health/schema）"
fi

# ───────────────────────── 阶段 9：30 秒观察窗 + 自动回滚 ─────────────────────────
info "阶段 9：30 秒观察窗（容器退出 / 端口不监听 / fatal 日志任一 → 自动回滚）"
if [[ $DRY_RUN -eq 0 ]]; then
  for i in $(seq 1 6); do
    sleep 5
    STATE=$(ssh $SSH_OPTS "$SERVER" "docker inspect $PROD_NAME --format '{{.State.Running}}'" || echo "false")
    [[ "$STATE" != "true" ]] && { err "观察窗内 $PROD_NAME 退出，自动回滚"; ROLLBACK=1; break; }
    ssh $SSH_OPTS "$SERVER" "curl -fsS -m 3 http://127.0.0.1:$PROD_HOST_PORT/health/schema" > /dev/null || { err "观察窗内 /health/schema 不通，回滚"; ROLLBACK=1; break; }
    BAD=$(ssh $SSH_OPTS "$SERVER" "docker logs $PROD_NAME --since 30s 2>&1 | grep -cE 'EADDRINUSE|fatal|PrismaClientInitializationError' || true")
    [[ "$BAD" != "0" ]] && { err "观察窗内日志出现 fatal 关键字（$BAD 处），回滚"; ROLLBACK=1; break; }
    echo "  $((i*5))s ok"
  done
  if [[ "${ROLLBACK:-0}" == "1" ]]; then
    ssh $SSH_OPTS "$SERVER" "docker rm -f $PROD_NAME && docker rename $OLD_CONTAINER_NAME $PROD_NAME && docker start $PROD_NAME"
    sleep 5
    ssh $SSH_OPTS "$SERVER" "curl -fsS http://127.0.0.1:$PROD_HOST_PORT/health/schema" && ok "已回滚到旧版" || err "回滚后仍不通，人工"
    exit 1
  fi
  ok "30 秒观察窗平稳"
fi

# ───────────────────────── 收尾 ─────────────────────────
info "收尾：保留 ${OLD_CONTAINER_NAME} 作 24h 秒级回滚备用（手动清理：docker rm ${OLD_CONTAINER_NAME}）"
ok "发布完成"
echo ""
echo "================================================================"
echo "  COMMIT:      $COMMIT"
echo "  BUILT_AT:    $BUILT_AT"
echo "  ROLLBACK:    ${ROLLBACK_TAG}（镜像层 rollback）"
echo "  OLD 容器:    ${OLD_CONTAINER_NAME}（容器层秒回）"
echo "================================================================"
