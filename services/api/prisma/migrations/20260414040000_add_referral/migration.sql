-- 营销自动化任务六：裂变归因表 + ReferralCode 扩展缓存小程序码

-- ReferralCode 加 2 列：qrcodeBase64（缓存）+ qrcodeUpdatedAt
ALTER TABLE "ReferralCode" ADD COLUMN "qrcodeBase64" TEXT;
ALTER TABLE "ReferralCode" ADD COLUMN "qrcodeUpdatedAt" DATETIME;

-- Referral：被邀请人一人一生只归属一个邀请人（inviteeId UNIQUE）
CREATE TABLE "Referral" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "inviterId" TEXT NOT NULL,
  "inviteeId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rewardedAt" DATETIME
);
CREATE UNIQUE INDEX "Referral_inviteeId_key" ON "Referral"("inviteeId");
CREATE INDEX "Referral_inviterId_idx" ON "Referral"("inviterId");
