-- SalesProfile: 新增 companyVisible 开关
ALTER TABLE "SalesProfile" ADD COLUMN "companyVisible" BOOLEAN NOT NULL DEFAULT 1;

-- SalesCode 表（多码支持）
CREATE TABLE "SalesCode" (
  "id"        TEXT PRIMARY KEY NOT NULL,
  "salesCode" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "label"     TEXT,
  "status"    TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalesCode_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "SalesProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SalesCode_salesCode_key" ON "SalesCode"("salesCode");
CREATE INDEX "SalesCode_profileId_idx" ON "SalesCode"("profileId");
CREATE INDEX "SalesCode_status_idx" ON "SalesCode"("status");

-- Backfill：把存量 SalesProfile.salesCode 同步插一条 SalesCode 记录（主码）
-- 用 lower(hex(randomblob(12))) 生成 cuid 替代（SQLite 不支持 cuid，用 random hex 够用）
INSERT INTO "SalesCode" ("id", "salesCode", "profileId", "label", "status", "createdAt")
SELECT
  lower(hex(randomblob(12))),
  "salesCode",
  "id",
  '主码',
  'ACTIVE',
  CURRENT_TIMESTAMP
FROM "SalesProfile";
