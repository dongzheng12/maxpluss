#!/usr/bin/env bash
# ============================================================
# 迁移验证清单：执行迁移后运行此脚本确认结果
# 用法：bash scripts/verify-prod-email-auth.sh [db路径]
# ============================================================
DB="${1:-/opt/biaozhunxiaozhi/services/api/prisma/dev.db}"

echo "=== 验证数据库：$DB ==="
echo ""

# 1. 检查 AppUser.email 字段是否存在
echo "── 1. AppUser 表结构"
sqlite3 "$DB" "PRAGMA table_info(AppUser);" | grep -E "phone|email|passwordHash|role"
echo ""

# 2. 检查 phone 是否可空（notnull=0）
PHONE_NOTNULL=$(sqlite3 "$DB" "PRAGMA table_info(AppUser);" | awk -F'|' '$2=="phone"{print $4}')
if [ "$PHONE_NOTNULL" = "0" ]; then
  echo "✅ AppUser.phone 已改为可空"
else
  echo "❌ AppUser.phone 仍为 NOT NULL（迁移未生效）"
fi

# 3. 检查 VerificationCode 表是否存在
VC_EXISTS=$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='VerificationCode';")
if [ "$VC_EXISTS" = "VerificationCode" ]; then
  echo "✅ VerificationCode 表已创建"
else
  echo "❌ VerificationCode 表不存在（迁移未生效）"
fi

# 4. 检查索引
echo ""
echo "── 4. VerificationCode 索引"
sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='VerificationCode';"

# 5. 现有用户数（迁移后应和迁移前一致）
echo ""
USER_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM AppUser;")
echo "── 5. 现有用户数：$USER_COUNT（应与迁移前一致）"

echo ""
echo "=== 验证完毕 ==="
