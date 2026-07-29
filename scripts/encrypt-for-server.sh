#!/bin/bash
# ============================================================
# encrypt-for-server.sh — 本地加密数据文件，准备上传服务器
#
# 加密规范（与 remount-dedup.sh 完全对称）：
#   openssl enc -aes-256-cbc -md sha256 -in <file> -out <file>.enc -pass pass:口令
#   注意：-md sha256 必须显式指定，确保与服务器 OpenSSL 1.0.x 兼容
#
# 用法：
#   bash scripts/encrypt-for-server.sh                  # 加密所有需要上传的文件
#   bash scripts/encrypt-for-server.sh search           # 只加密搜索数据
#   bash scripts/encrypt-for-server.sh dedup            # 只加密去重主库
#   bash scripts/encrypt-for-server.sh meta             # 只加密 487K 元数据
#
# 在本地项目根目录执行：
#   bash ~/Documents/Codex/01_Projects/biaozhunxiaozhi/scripts/encrypt-for-server.sh
# ============================================================

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}>>> $1${NC}"; }
warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
error() { echo -e "${RED}❌ $1${NC}"; exit 1; }

# ---------- 读取口令 ----------
if [ -n "$BXZ_PASSPHRASE" ]; then
  PASSPHRASE="$BXZ_PASSPHRASE"
else
  read -s -p "请输入加密口令（与服务器 /root/.bxz_db_pass 一致）: " PASSPHRASE
  echo ""
fi
[ -z "$PASSPHRASE" ] && error "口令不能为空"

TARGET="${1:-all}"

# ---------- 加密函数 ----------
encrypt_file() {
  local SRC="$1"
  local DST="${SRC}.enc"
  if [ ! -f "$SRC" ]; then
    warn "源文件不存在，跳过: $SRC"
    return 0
  fi
  info "加密: $SRC → $DST"
  openssl enc -aes-256-cbc \
    -md sha256 \
    -in "$SRC" \
    -out "$DST" \
    -pass "pass:$PASSPHRASE"
  echo "  大小: $(du -sh $SRC | cut -f1) → $(du -sh $DST | cut -f1)"
  echo "  MD5:  $(md5 -q $DST 2>/dev/null || md5sum $DST 2>/dev/null | cut -d' ' -f1)"
  echo ""
}

echo ""
echo "======================================================"
echo "  标准小智 — 本地加密准备"
echo "  目标: $TARGET"
echo "======================================================"
echo ""

# ── ① 搜索索引原料 ──
if [ "$TARGET" = "all" ] || [ "$TARGET" = "search" ]; then
  info "=== 搜索元数据 (all_standards.json) ==="
  encrypt_file "data/crawled_v2/all_standards.json"
fi

# ── ② 487K 主元数据（报告增强用） ──
if [ "$TARGET" = "all" ] || [ "$TARGET" = "meta" ]; then
  info "=== 487K 元数据 (classification_result_final.json) ==="
  # 服务器上叫 classification_result.json.enc，加密时输出到 dedup 目录
  if [ -f "data/classification_result_final.json" ]; then
    openssl enc -aes-256-cbc \
      -md sha256 \
      -in "data/classification_result_final.json" \
      -out "data/dedup/classification_result.json.enc" \
      -pass "pass:$PASSPHRASE"
    echo "  输出: data/dedup/classification_result.json.enc"
    echo "  大小: $(du -sh data/classification_result_final.json | cut -f1) → $(du -sh data/dedup/classification_result.json.enc | cut -f1)"
    echo ""
  else
    warn "data/classification_result_final.json 不存在，跳过"
  fi
fi

# ── ③ 去重主库 ──
if [ "$TARGET" = "all" ] || [ "$TARGET" = "dedup" ]; then
  info "=== 去重主库 (bx_standards.db) ==="
  if [ -f "data/bx_standards.db" ]; then
    encrypt_file "data/bx_standards.db"
    mv "data/bx_standards.db.enc" "data/dedup/bx_standards.db.enc" 2>/dev/null || true
    echo "  输出: data/dedup/bx_standards.db.enc"
  else
    warn "data/bx_standards.db 不存在，跳过"
  fi
fi

# ---------- 摘要 ----------
echo "======================================================"
echo "  加密完成，以下文件可上传服务器："
echo "======================================================"
for f in \
  "data/crawled_v2/all_standards.json.enc" \
  "data/dedup/classification_result.json.enc" \
  "data/dedup/bx_standards.db.enc"
do
  if [ -f "$f" ]; then
    echo "  ✅ $f  ($(du -sh $f | cut -f1))"
  else
    echo "  —  $f  （未生成）"
  fi
done
echo ""
echo "  上传命令（在项目根执行）："
echo "  bash scripts/upload-to-server.sh"
echo ""
