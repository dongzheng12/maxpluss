#!/usr/bin/env bash
# ============================================================
# bxz-dedup 容器部署脚本
# ============================================================
# 流程：本地 build (--no-cache) → 校验 → save → scp → docker load
#      → rollback tag → stop + rm + run(--restart=unless-stopped)
#      → health 检查 → 清理
#
# 用法：
#   bash scripts/deploy-dedup.sh             # 实际执行
#   bash scripts/deploy-dedup.sh --dry-run   # 只打印计划，不执行
#
# 前置：本地 docker 可用，ssh key 已加入服务器 authorized_keys
# ============================================================

set -euo pipefail

# ---------- 常量 ----------
SERVER_IP="154.8.197.13"
SERVER_USER="root"
SERVER="$SERVER_USER@$SERVER_IP"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o BatchMode=yes $SERVER"
SCP="scp -i $SSH_KEY -o StrictHostKeyChecking=no -o BatchMode=yes"

IMAGE_TAG="bxz-dedup:py39"
CONTAINER="bxz-dedup"
DATA_DISK="/mnt/datadisk0"
REMOTE_TAR="$DATA_DISK/bxz-dedup.tar.gz"
LOCAL_TAR="/tmp/bxz-dedup.tar.gz"
PROJECT_REMOTE="/opt/biaozhunxiaozhi"

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEDUP_DIR="$PROJECT_DIR/services/dedup"

# ---------- 颜色 ----------
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
info()  { echo -e "${GREEN}>>> $1${NC}"; }
warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
error() { echo -e "${RED}❌ $1${NC}"; }

# ---------- dry-run ----------
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" || "${1:-}" == "-n" ]]; then
  DRY_RUN=1
  warn "DRY-RUN 模式：只打印计划，不实际执行"
fi

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[DRY-RUN] $*"
  else
    eval "$@"
  fi
}

# ---------- 0. 前置检查 ----------
info "[0/8] 前置检查"
if [ ! -f "$SSH_KEY" ]; then
  error "SSH key 不存在: $SSH_KEY"
  exit 1
fi
if ! command -v docker &>/dev/null; then
  error "本地未安装 docker"
  exit 1
fi
if [ ! -f "$DEDUP_DIR/Dockerfile" ]; then
  error "Dockerfile 未找到: $DEDUP_DIR/Dockerfile"
  exit 1
fi
if [ "$DRY_RUN" -eq 0 ] && ! $SSH "echo ok" < /dev/null > /dev/null 2>&1; then
  error "SSH 连接 $SERVER 失败"
  exit 1
fi
echo "  SSH_KEY = $SSH_KEY"
echo "  IMAGE   = $IMAGE_TAG"
echo "  SERVER  = $SERVER"
echo "  DEDUP_DIR = $DEDUP_DIR"

# ---------- 1. 本地 build（永远 --no-cache）----------
info "[1/8] 本地 build --no-cache"
echo "  # 为什么永远 --no-cache？"
echo "  # 2026-04-21 踩坑：buildx cache 命中导致镜像里保留旧 .pyc，"
echo "  # 本地 service.py 改过，但 build 出来的镜像配置 hash 跟旧版完全一致"
echo "  # 花了一轮 save/scp/load/rm/run 才发现，回滚重 build 才真正生效"
run "cd '$DEDUP_DIR' && docker build --no-cache --platform linux/amd64 -t $IMAGE_TAG ."

# ---------- 2. 构建后校验（镜像内 BUILD_INFO vs 本地 .py md5）----------
info "[2/8] 校验镜像内源码 md5"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[DRY-RUN] docker run --rm --entrypoint cat $IMAGE_TAG /app/BUILD_INFO.txt"
  echo "[DRY-RUN] 对比结果：本地 dedup/*.py md5 VS 镜像 /app/BUILD_INFO.txt"
else
  IMAGE_MD5=$(docker run --rm --entrypoint cat "$IMAGE_TAG" /app/BUILD_INFO.txt 2>/dev/null) || {
    error "镜像内没有 /app/BUILD_INFO.txt（Dockerfile 是否加了生成步骤？）"
    exit 1
  }
  # 本地对同样 6 个核心 .py 算 md5
  LOCAL_MD5=$(cd "$DEDUP_DIR" && md5sum __init__.py auth.py compare.py report.py service.py jobs.py | sort)
  if [ "$IMAGE_MD5" = "$LOCAL_MD5" ]; then
    echo "  ✅ 校验通过：镜像内源码 = 本地源码"
    echo "$LOCAL_MD5" | sed 's/^/    /'
  else
    error "校验失败！镜像里的源码跟本地不一致，可能是 buildx cache 命中"
    echo "— 镜像内 —"
    echo "$IMAGE_MD5"
    echo "— 本地 —"
    echo "$LOCAL_MD5"
    error "终止部署，不进行 save/scp。请删除本地镜像后重新运行本脚本"
    exit 1
  fi
fi

# ---------- 3. save + gzip ----------
info "[3/8] docker save + gzip → $LOCAL_TAR"
run "docker save $IMAGE_TAG | gzip > $LOCAL_TAR"
run "ls -lh $LOCAL_TAR"

# ---------- 4. scp 到服务器数据盘 ----------
info "[4/8] scp → $SERVER:$REMOTE_TAR"
run "$SCP $LOCAL_TAR $SERVER:$REMOTE_TAR"

# ---------- 5. docker load + rollback tag ----------
info "[5/8] 服务器 docker load + 旧镜像打 rollback tag"
REMOTE_SCRIPT_5=$(cat <<'REMOTE_EOF'
set -e
# 旧镜像 ID 先记下来（docker load 会覆盖 tag）
OLD_IMG=$(docker inspect bxz-dedup:py39 --format '{{.Id}}' 2>/dev/null || echo "")
if [ -n "$OLD_IMG" ]; then
  ROLLBACK_TAG="bxz-dedup:rollback-$(date +%m%d-%H%M)"
  docker tag "$OLD_IMG" "$ROLLBACK_TAG"
  echo "  ✅ 旧镜像打 tag: $ROLLBACK_TAG → $OLD_IMG"
else
  echo "  ℹ️  无旧镜像，跳过 rollback tag"
fi

docker load < /mnt/datadisk0/bxz-dedup.tar.gz 2>&1 | tail -3
echo "  ✅ 新镜像 ID: $(docker inspect bxz-dedup:py39 --format '{{.Id}}')"
REMOTE_EOF
)
run "$SSH 'bash -s' <<'OUTER_EOF'
$REMOTE_SCRIPT_5
OUTER_EOF"

# ---------- 6. stop + rm + run（新容器带 --restart=unless-stopped）----------
info "[6/8] 重建容器（约 5-8 秒业务中断）"
REMOTE_SCRIPT_6=$(cat <<'REMOTE_EOF'
set -e
# 从服务器 .env 读 BXZ_INTERNAL_SECRET（密钥不进代码/脚本）
BXZ_SECRET=$(grep -E '^BXZ_INTERNAL_SECRET' /opt/biaozhunxiaozhi/services/dedup/.env | cut -d= -f2)
if [ -z "$BXZ_SECRET" ]; then
  echo "❌ .env 里没有 BXZ_INTERNAL_SECRET"
  exit 1
fi

echo "  停旧容器 $(date +%H:%M:%S)"
docker stop bxz-dedup 2>/dev/null || true
docker rm   bxz-dedup 2>/dev/null || true

echo "  起新容器 $(date +%H:%M:%S)"
# --restart=unless-stopped：服务器重启后自动拉起，除非手工 docker stop
# 挂载 / env 从上一版 docker inspect 同步而来，不得省略：
#   - .env (ro)            : 服务启动时 dotenv 读取
#   - bx_standards.db (ro) : 73K 指纹库（放 tmpfs）
#   - classification_result_final.json (ro) : 487K 元数据
#   - brand_category_extended.json (ro)     : 56K 品牌库
docker run -d --name bxz-dedup --network host --restart unless-stopped \
  -e TZ=Asia/Shanghai \
  -e BXZ_INTERNAL_SECRET="$BXZ_SECRET" \
  -e BXZ_DB_PATH=/app/bx_standards.db \
  -v /opt/biaozhunxiaozhi/services/dedup/.env:/app/.env:ro \
  -v /opt/biaozhunxiaozhi/data/dedup/ram/bx_standards.db:/app/bx_standards.db:ro \
  -v /mnt/datadisk0/bxz-dedup-data/classification_result.json:/data/classification_result_final.json:ro \
  -v /opt/biaozhunxiaozhi/services/dedup/brand_category_extended.json:/app/dedup/brand_category_extended.json:ro \
  bxz-dedup:py39 \
  uvicorn dedup.service:app --host 0.0.0.0 --port 8067 --workers 2

echo "  等待启动就绪 ..."
for i in $(seq 1 20); do
  sleep 1
  if docker logs bxz-dedup 2>&1 | grep -q "Dedup service ready"; then
    echo "  ✅ ready @ $(date +%H:%M:%S)（第 ${i} 秒）"
    break
  fi
done

echo "  容器状态："
docker ps --filter name=bxz-dedup --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.RunningFor}}'
echo "  Restart policy：$(docker inspect bxz-dedup --format '{{.HostConfig.RestartPolicy.Name}}')"
REMOTE_EOF
)
run "$SSH 'bash -s' <<'OUTER_EOF'
$REMOTE_SCRIPT_6
OUTER_EOF"

# ---------- 7. health 检查 ----------
info "[7/8] /internal/health 验证"
REMOTE_SCRIPT_7=$(cat <<'REMOTE_EOF'
set -e
BXZ_SECRET=$(grep -E '^BXZ_INTERNAL_SECRET' /opt/biaozhunxiaozhi/services/dedup/.env | cut -d= -f2)
TS=$(date +%s)
PAYLOAD="GET\n/internal/health\n${TS}\n"
SIG=$(printf "$PAYLOAD" | openssl dgst -sha256 -hmac "$BXZ_SECRET" | awk '{print $2}')
HEALTH=$(curl -s -H "X-Internal-Timestamp: $TS" -H "X-Internal-Key: $SIG" http://127.0.0.1:8067/internal/health)
echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"

# 关键指标校验
if echo "$HEALTH" | grep -q '"status":"ok"' && echo "$HEALTH" | grep -q '"metadata_loaded":true'; then
  echo "  ✅ health 通过"
else
  echo "  ❌ health 异常，请 docker logs bxz-dedup 排查"
  exit 1
fi
REMOTE_EOF
)
run "$SSH 'bash -s' <<'OUTER_EOF'
$REMOTE_SCRIPT_7
OUTER_EOF"

# ---------- 8. 清理 ----------
info "[8/8] 清理 $REMOTE_TAR 和 $LOCAL_TAR"
run "$SSH 'rm -f $REMOTE_TAR'"
run "rm -f $LOCAL_TAR"

echo ""
echo "======================================"
echo "  ✅ bxz-dedup 部署完成"
echo "======================================"
echo "  镜像 tag : $IMAGE_TAG"
echo "  回滚     : ssh $SERVER 'docker images | grep rollback | head -3'"
echo "  health   : curl -s http://127.0.0.1:8067/internal/health  (需 HMAC 头)"
echo ""
