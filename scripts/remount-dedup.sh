#!/bin/bash
# ============================================================
# remount-dedup.sh — 服务器重启后恢复全部数据 + 重启所有数据服务
#
# 管理的三类加密文件：
#   ① bx_standards.db.enc        → tmpfs（去重主库，2.9GB，RandomRead 密集）
#   ② classification_result.json.enc → 磁盘（487K 元数据，启动时一次读入 Python）
#   ③ all_standards.json.enc      → 磁盘（487K 搜索索引原料，启动时建 SQLite）
#
# 使用场景：
#   1. 服务器重启后 → tmpfs 被清空，运行此脚本恢复全部数据
#   2. 数据更新后   → 上传新 .enc 文件后，运行此脚本切换到新数据
#
# 执行方式：
#   bash /root/remount-dedup.sh                    # 恢复，保留旧搜索 DB（快速）
#   bash /root/remount-dedup.sh --reset-search-db  # 恢复 + 强制重建搜索索引（数据更新时用）
#
# 建议加入 crontab（服务器重启后自动执行）：
#   @reboot /bin/bash /root/remount-dedup.sh >> /var/log/remount-dedup.log 2>&1
#
# 加密规范（本地 & 服务器必须一致）：
#   加密：openssl enc -aes-256-cbc -md sha256 -in <file> -out <file>.enc -pass pass:口令
#   解密：openssl enc -d -aes-256-cbc -md sha256 -in <file>.enc -out <file> -pass pass:口令
#   注意：-md sha256 必须显式指定（macOS 默认 SHA-256，CentOS 7 OpenSSL 1.0.x 默认 MD5）
# ============================================================

set -e

# ---------- 参数 ----------
RESET_SEARCH_DB=0
for arg in "$@"; do
  [ "$arg" = "--reset-search-db" ] && RESET_SEARCH_DB=1
done

# ---------- 路径配置 ----------
RAM_DIR="/opt/biaozhunxiaozhi/data/dedup/ram"
DEDUP_DIR="/opt/biaozhunxiaozhi/data/dedup"
SEARCH_DIR="/opt/biaozhunxiaozhi/data/crawled_v2"
STANDARDS_DB="/opt/biaozhunxiaozhi/data/standards.db"

# 加密文件
ENC_DB="$DEDUP_DIR/bx_standards.db.enc"
ENC_META="$DEDUP_DIR/classification_result.json.enc"
ENC_SEARCH="$SEARCH_DIR/all_standards.json.enc"

# 解密目标
DB_TARGET="$RAM_DIR/bx_standards.db"
META_TARGET="$DEDUP_DIR/classification_result.json"
SEARCH_TARGET="$SEARCH_DIR/all_standards.json"

# tmpfs 大小（bx_standards.db ≈ 2.9GB，留 20% 余量）
TMPFS_SIZE="3500m"

LOG_PREFIX="[remount-dedup]"

# ---------- 解密口令 ----------
PASSPHRASE_FILE="/root/.bxz_db_pass"

if [ ! -f "$PASSPHRASE_FILE" ]; then
  echo "$LOG_PREFIX ERROR: 口令文件不存在: $PASSPHRASE_FILE"
  echo "$LOG_PREFIX 请先执行: echo '口令' > $PASSPHRASE_FILE && chmod 600 $PASSPHRASE_FILE"
  exit 1
fi

if [ "$(stat -c %a $PASSPHRASE_FILE)" != "600" ]; then
  echo "$LOG_PREFIX WARN: 口令文件权限不是 600，强制修正"
  chmod 600 "$PASSPHRASE_FILE"
fi

PASSPHRASE=$(cat "$PASSPHRASE_FILE")

echo "$LOG_PREFIX =========================================="
echo "$LOG_PREFIX 开始恢复数据服务  $(date '+%Y-%m-%d %H:%M:%S')"
echo "$LOG_PREFIX   --reset-search-db: $RESET_SEARCH_DB"
echo "$LOG_PREFIX =========================================="

# ---------- 创建目录 ----------
mkdir -p "$RAM_DIR" "$DEDUP_DIR" "$SEARCH_DIR"

# ══════════════════════════════════════════════════════════════
# ① 挂载 tmpfs（去重主库专用）
# ══════════════════════════════════════════════════════════════
if mountpoint -q "$RAM_DIR"; then
  echo "$LOG_PREFIX tmpfs 已挂载（跳过），大小: $(df -h $RAM_DIR | awk 'NR==2{print $2}')"
else
  echo "$LOG_PREFIX 挂载 tmpfs ($TMPFS_SIZE) → $RAM_DIR"
  mount -t tmpfs -o size=$TMPFS_SIZE,mode=700 tmpfs "$RAM_DIR"
fi

# ══════════════════════════════════════════════════════════════
# ② 解密去重主库 → tmpfs
# ══════════════════════════════════════════════════════════════
if [ ! -f "$ENC_DB" ]; then
  echo "$LOG_PREFIX ERROR: 主库加密文件不存在: $ENC_DB"
  exit 1
fi

echo "$LOG_PREFIX [①] 解密 bx_standards.db → tmpfs..."
openssl enc -d -aes-256-cbc \
  -md sha256 \
  -in "$ENC_DB" \
  -out "$DB_TARGET" \
  -pass "pass:$PASSPHRASE"

chmod 600 "$DB_TARGET"
chown dedup:dedup "$DB_TARGET" 2>/dev/null || true
echo "$LOG_PREFIX [①] ✅ 主库解密完成: $(du -sh $DB_TARGET | cut -f1)"

# ══════════════════════════════════════════════════════════════
# ③ 解密 487K 元数据（报告增强用）→ 磁盘
# ══════════════════════════════════════════════════════════════
if [ ! -f "$ENC_META" ]; then
  echo "$LOG_PREFIX [②] WARN: 元数据加密文件不存在: $ENC_META（报告增强不可用，服务仍可启动）"
else
  echo "$LOG_PREFIX [②] 解密 classification_result.json → 磁盘..."
  openssl enc -d -aes-256-cbc \
    -md sha256 \
    -in "$ENC_META" \
    -out "$META_TARGET" \
    -pass "pass:$PASSPHRASE"

  chmod 600 "$META_TARGET"
  chown dedup:dedup "$META_TARGET" 2>/dev/null || true
  echo "$LOG_PREFIX [②] ✅ 元数据解密完成: $(du -sh $META_TARGET | cut -f1)"
fi

# ══════════════════════════════════════════════════════════════
# ④ 解密搜索索引原料（all_standards.json）→ 磁盘
# ══════════════════════════════════════════════════════════════
if [ ! -f "$ENC_SEARCH" ]; then
  echo "$LOG_PREFIX [③] WARN: 搜索元数据加密文件不存在: $ENC_SEARCH（搜索服务数据将沿用旧版）"
else
  echo "$LOG_PREFIX [③] 解密 all_standards.json → crawled_v2/..."
  openssl enc -d -aes-256-cbc \
    -md sha256 \
    -in "$ENC_SEARCH" \
    -out "$SEARCH_TARGET" \
    -pass "pass:$PASSPHRASE"

  chmod 640 "$SEARCH_TARGET"
  chown bxz:bxz "$SEARCH_TARGET" 2>/dev/null || true
  echo "$LOG_PREFIX [③] ✅ 搜索元数据解密完成: $(du -sh $SEARCH_TARGET | cut -f1)"
fi

# ══════════════════════════════════════════════════════════════
# ⑤ 可选：删除旧搜索 SQLite（--reset-search-db 时强制重建）
# ══════════════════════════════════════════════════════════════
if [ "$RESET_SEARCH_DB" -eq 1 ]; then
  if [ -f "$STANDARDS_DB" ]; then
    echo "$LOG_PREFIX [④] 删除旧 standards.db（强制重建索引）..."
    rm -f "$STANDARDS_DB"
    echo "$LOG_PREFIX [④] ✅ 已删除: $STANDARDS_DB"
  else
    echo "$LOG_PREFIX [④] standards.db 不存在，无需删除"
  fi
else
  echo "$LOG_PREFIX [④] 保留现有 standards.db（跳过重建，加速启动）"
fi

# ══════════════════════════════════════════════════════════════
# ⑥ 重启数据服务
# ══════════════════════════════════════════════════════════════
source /etc/profile.d/nvm.sh 2>/dev/null || true

# 等 docker daemon 就绪（@reboot 时 cron 可能早于 dockerd 启动）
echo "$LOG_PREFIX [⑤] 等待 docker daemon 就绪 ..."
DOCKER_READY=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if docker info >/dev/null 2>&1; then
    echo "$LOG_PREFIX [⑤] ✅ docker 就绪（耗时 ${i}*5s）"
    DOCKER_READY=1
    break
  fi
  sleep 5
done

if [ "$DOCKER_READY" -eq 1 ]; then
  echo "$LOG_PREFIX [⑤] 重启 bxz-dedup（Docker 容器，确保加载新解密的 tmpfs db）..."
  RESTART_OK=0
  for i in 1 2 3; do
    if docker restart bxz-dedup; then
      RESTART_OK=1
      break
    fi
    echo "$LOG_PREFIX [⑤] WARN: docker restart bxz-dedup 失败（第 ${i} 次），5s 后重试"
    sleep 5
  done
  if [ "$RESTART_OK" -eq 0 ]; then
    echo "$LOG_PREFIX [⑤] ❌ ERROR: docker restart bxz-dedup 三次都失败 — bxz-dedup 可能跑在空 tmpfs 上！请手动 'docker restart bxz-dedup'"
    # 不 exit 1，下面 pyapi 重启仍可继续
  fi
else
  echo "$LOG_PREFIX [⑤] ❌ ERROR: docker daemon 60s 内未就绪 — bxz-dedup 加载状态未知，请手动 'docker ps' + 'docker restart bxz-dedup'"
fi

echo "$LOG_PREFIX [⑥] 重启 bxz-pyapi（首次或 --reset-search-db 时会重建索引，约30~60s）..."
pm2 restart bxz-pyapi 2>/dev/null || pm2 start bxz-pyapi 2>/dev/null || \
  echo "$LOG_PREFIX WARN: bxz-pyapi 重启失败，请手动检查"

# ---------- 完成摘要 ----------
echo ""
echo "$LOG_PREFIX =========================================="
echo "$LOG_PREFIX 恢复完成  $(date '+%Y-%m-%d %H:%M:%S')"
echo "$LOG_PREFIX =========================================="
echo "$LOG_PREFIX tmpfs ($RAM_DIR):"
ls -lh "$RAM_DIR" 2>/dev/null || echo "  （空）"
echo "$LOG_PREFIX dedup 磁盘 ($DEDUP_DIR):"
ls -lh "$DEDUP_DIR"/*.json 2>/dev/null || echo "  （无 .json）"
echo "$LOG_PREFIX 搜索磁盘 ($SEARCH_DIR):"
ls -lh "$SEARCH_DIR/all_standards.json" 2>/dev/null || echo "  （all_standards.json 不存在）"
echo "$LOG_PREFIX 搜索 SQLite ($STANDARDS_DB):"
ls -lh "$STANDARDS_DB" 2>/dev/null || echo "  （尚未构建，bxz-pyapi 将在后台构建）"
echo ""
pm2 list --no-color 2>/dev/null | grep -E "bxz-|App" || true
