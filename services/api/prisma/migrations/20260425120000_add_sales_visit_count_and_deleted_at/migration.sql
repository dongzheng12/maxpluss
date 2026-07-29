-- SalesProfile 加 visitCount（公开页访问数）+ deletedAt（软删除时间戳）
-- SQLite 3.7 不认 true/false 字面量，DEFAULT 用 0/1 数字
ALTER TABLE "SalesProfile" ADD COLUMN "visitCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SalesProfile" ADD COLUMN "deletedAt" DATETIME;

-- 软删除查询索引（admin 列表 WHERE deletedAt IS NULL）
CREATE INDEX "SalesProfile_deletedAt_idx" ON "SalesProfile"("deletedAt");
