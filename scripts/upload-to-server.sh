#!/bin/bash
# ============================================================
# upload-to-server.sh — 上传加密文件 + engine.py 到服务器，执行切换
#
# 前置条件：已运行 encrypt-for-server.sh 生成 .enc 文件
#
# 用法：
#   bash scripts/upload-to-server.sh                   # 上传全部 + 重启全部
#   bash scripts/upload-to-server.sh search            # 只上传搜索数据（重建索引）
#   bash scripts/upload-to-server.sh engine            # 只上传 engine.py
#   bash scripts/upload-to-server.sh dedup             # 只上传去重主库 + 元数据
# ============================================================

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

SERVER_IP="154.8.197.13"
SSH_PORT="22"
SERVER_USER="root"
SERVER="$SERVER_USER@$SERVER_IP"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH="ssh -i $SSH_KEY -p $SSH_PORT -o StrictHostKeyChecking=no -o BatchMode=yes $SERVER"
SCP="scp -i $SSH_KEY -P $SSH_PORT -o StrictHostKeyChecking=no -o BatchMode=yes"

SERVER_PROJECT="/opt/biaozhunxiaozhi"
SERVER_DEDUP="$SERVER_PROJECT/data/dedup"
SERVER_SEARCH="$SERVER_PROJECT/data/crawled_v2"
SERVER_ENGINE="$SERVER_PROJECT/services/python-search-legacy"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}>>> $1${NC}"; }
warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }

TARGET="${1:-all}"

echo ""
echo "======================================================"
echo "  标准小智 — 服务器数据上传"
echo "  服务器: $SERVER_IP  目标: $TARGET"
echo "======================================================"
echo ""

# ---------- 连通性检查 ----------
info "检查 SSH 连通性..."
$SSH "echo '✅ SSH OK'" || { echo "❌ SSH 连接失败，请检查密钥和网络"; exit 1; }

# ---------- 服务器备份 ----------
if [ "$TARGET" = "all" ] || [ "$TARGET" = "search" ]; then
  info "备份服务器旧 all_standards.json.enc..."
  $SSH "[ -f $SERVER_SEARCH/all_standards.json.enc ] && \
    cp $SERVER_SEARCH/all_standards.json.enc $SERVER_SEARCH/all_standards.json.enc.bak && \
    echo '已备份 all_standards.json.enc' || echo '无旧版本，跳过备份'"
fi

if [ "$TARGET" = "all" ] || [ "$TARGET" = "engine" ]; then
  info "备份服务器旧 engine.py..."
  $SSH "cp $SERVER_ENGINE/engine.py $SERVER_ENGINE/engine.py.bak && echo '已备份 engine.py'"
fi

# ---------- 上传加密文件 ----------
if [ "$TARGET" = "all" ] || [ "$TARGET" = "search" ]; then
  if [ ! -f "data/crawled_v2/all_standards.json.enc" ]; then
    echo "❌ 找不到 data/crawled_v2/all_standards.json.enc，请先运行 encrypt-for-server.sh search"
    exit 1
  fi
  info "上传 all_standards.json.enc ($(du -sh data/crawled_v2/all_standards.json.enc | cut -f1))..."
  $SCP data/crawled_v2/all_standards.json.enc \
    $SERVER:$SERVER_SEARCH/all_standards.json.enc
  echo "  ✅ 上传完成"
fi

if [ "$TARGET" = "all" ] || [ "$TARGET" = "dedup" ]; then
  if [ -f "data/dedup/classification_result.json.enc" ]; then
    info "上传 classification_result.json.enc ($(du -sh data/dedup/classification_result.json.enc | cut -f1))..."
    $SCP data/dedup/classification_result.json.enc \
      $SERVER:$SERVER_DEDUP/classification_result.json.enc
    echo "  ✅ 上传完成"
  fi
  if [ -f "data/dedup/bx_standards.db.enc" ]; then
    info "上传 bx_standards.db.enc ($(du -sh data/dedup/bx_standards.db.enc | cut -f1))..."
    $SCP data/dedup/bx_standards.db.enc \
      $SERVER:$SERVER_DEDUP/bx_standards.db.enc
    echo "  ✅ 上传完成"
  fi
fi

if [ "$TARGET" = "all" ] || [ "$TARGET" = "engine" ]; then
  info "上传 engine.py..."
  $SCP services/python-search-legacy/engine.py \
    $SERVER:$SERVER_ENGINE/engine.py
  echo "  ✅ 上传完成"
fi

# ---------- 上传最新 remount-dedup.sh 到服务器 ----------
info "上传 remount-dedup.sh 到服务器 /root/..."
$SCP scripts/remount-dedup.sh $SERVER:/root/remount-dedup.sh
$SSH "chmod +x /root/remount-dedup.sh && echo '✅ remount-dedup.sh 已更新'"

# ---------- 服务器切换 ----------
info "服务器切换（remount + 重启）..."

if [ "$TARGET" = "all" ] || [ "$TARGET" = "search" ] || [ "$TARGET" = "engine" ]; then
  # 数据/引擎有更新 → 需要重建搜索索引
  REMOUNT_FLAG="--reset-search-db"
else
  REMOUNT_FLAG=""
fi

$SSH "bash /root/remount-dedup.sh $REMOUNT_FLAG"

# ---------- 等待 bxz-pyapi 就绪 ----------
if [ "$TARGET" = "all" ] || [ "$TARGET" = "search" ] || [ "$TARGET" = "engine" ]; then
  info "等待 bxz-pyapi 索引重建（最多 120s）..."
  for i in $(seq 1 12); do
    sleep 10
    STATUS=$($SSH "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/api/v1/stats 2>/dev/null || echo '000'")
    echo "  [${i}0s] HTTP: $STATUS"
    [ "$STATUS" = "200" ] && break
  done
fi

# ---------- 验证 ----------
info "验证 Python API..."
RESULT=$($SSH "curl -s 'http://127.0.0.1:8000/api/v1/standards?q=建筑&page_size=1' 2>/dev/null | python3 -c \"
import json,sys
d=json.load(sys.stdin)
item=d.get('items',[{}])[0]
print('total:', d.get('total',0))
for k in ['code','ics','ccs','source','pub_date','publisher']:
    print(f'{k}: {repr(item.get(k,\\\"\\\"))}')
\" 2>/dev/null || echo '⚠️ 验证失败'")
echo "$RESULT"

echo ""
echo "======================================================"
echo "  部署完成  $(date '+%Y-%m-%d %H:%M:%S')"
echo "======================================================"
echo ""
echo "  回滚方法："
echo "  $SSH 'cp $SERVER_SEARCH/all_standards.json.enc.bak $SERVER_SEARCH/all_standards.json.enc && bash /root/remount-dedup.sh --reset-search-db'"
