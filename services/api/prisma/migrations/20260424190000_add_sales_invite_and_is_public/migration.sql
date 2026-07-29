-- SalesProfile: 新增 isPublic（销售自控发布开关，status 是管理员总开关，不重复）
ALTER TABLE "SalesProfile" ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT 1;

-- Backfill 存量：保守设为 true（已有销售保持可见）
-- 注意：SQLite 3.7 不认 true/false 字面量，用 1/0
UPDATE "SalesProfile" SET "isPublic" = 1 WHERE "isPublic" IS NULL;

-- SalesInvite 邀请码表
CREATE TABLE "SalesInvite" (
  "id"         TEXT PRIMARY KEY NOT NULL,
  "inviteCode" TEXT NOT NULL,
  "createdBy"  TEXT NOT NULL,
  "status"     TEXT NOT NULL DEFAULT 'UNUSED',
  "usedBy"     TEXT,
  "usedAt"     DATETIME,
  "expiresAt"  DATETIME,
  "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  DATETIME NOT NULL
);
CREATE UNIQUE INDEX "SalesInvite_inviteCode_key" ON "SalesInvite"("inviteCode");
CREATE INDEX "SalesInvite_status_idx" ON "SalesInvite"("status");
CREATE INDEX "SalesInvite_createdBy_idx" ON "SalesInvite"("createdBy");
