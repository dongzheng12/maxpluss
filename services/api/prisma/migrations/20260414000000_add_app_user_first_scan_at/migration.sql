-- 营销自动化：AppUser 新增 firstScanAt 字段，标记首扫时间（首扫奖励规则依赖）
ALTER TABLE "AppUser" ADD COLUMN "firstScanAt" DATETIME;
