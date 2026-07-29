-- 营销自动化 R14 两级裂变奖励：注册 +7 天，付费 +30 天
-- SQLite 3.7 不支持 DROP COLUMN，用 RECREATE 模式保数据

CREATE TABLE "new_Referral" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "inviterId" TEXT NOT NULL,
  "inviteeId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "registrationRewardedAt" DATETIME,
  "paymentRewardedAt" DATETIME
);

-- 迁移已有数据：老 rewardedAt 语义是付费奖励（7 天），迁到 paymentRewardedAt
INSERT INTO "new_Referral" ("id", "inviterId", "inviteeId", "createdAt", "paymentRewardedAt")
  SELECT "id", "inviterId", "inviteeId", "createdAt", "rewardedAt" FROM "Referral";

DROP TABLE "Referral";
ALTER TABLE "new_Referral" RENAME TO "Referral";

CREATE UNIQUE INDEX "Referral_inviteeId_key" ON "Referral"("inviteeId");
CREATE INDEX "Referral_inviterId_idx" ON "Referral"("inviterId");
