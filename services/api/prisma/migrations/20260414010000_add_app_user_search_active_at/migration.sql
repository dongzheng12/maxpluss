-- 营销自动化：AppUser 新增 firstSearchAt（首检索，R02）+ lastActiveAt（沉默/流失判定，R12/R13）
ALTER TABLE "AppUser" ADD COLUMN "firstSearchAt" DATETIME;
ALTER TABLE "AppUser" ADD COLUMN "lastActiveAt" DATETIME;
