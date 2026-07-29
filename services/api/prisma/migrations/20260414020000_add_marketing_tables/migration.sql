-- 营销自动化：新增 5 张表支撑用户分层、订阅配额、推送日志、裂变、延迟排程

-- UserLabel：每日 labelSync job 聚合写入
CREATE TABLE "UserLabel" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "lifecycle" TEXT NOT NULL,
  "lastActiveAt" DATETIME,
  "weeklyActions" INTEGER NOT NULL DEFAULT 0,
  "isPaid" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "UserLabel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "UserLabel_userId_key" ON "UserLabel"("userId");
CREATE INDEX "UserLabel_lifecycle_idx" ON "UserLabel"("lifecycle");

-- SubscribeQuota：小程序订阅消息一次授权 quota+1，一次推送 quota-1
CREATE TABLE "SubscribeQuota" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "quota" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "SubscribeQuota_userId_templateId_key" ON "SubscribeQuota"("userId", "templateId");
CREATE INDEX "SubscribeQuota_userId_idx" ON "SubscribeQuota"("userId");

-- PushLog：推送日志 + 去重（userId+ruleId+refId 同一事件不重复推）
CREATE TABLE "PushLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "templateId" TEXT,
  "status" TEXT NOT NULL,
  "refId" TEXT,
  "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "errorMsg" TEXT
);
CREATE INDEX "PushLog_userId_ruleId_refId_idx" ON "PushLog"("userId", "ruleId", "refId");
CREATE INDEX "PushLog_ruleId_sentAt_idx" ON "PushLog"("ruleId", "sentAt");

-- ReferralCode：裂变邀请码
CREATE TABLE "ReferralCode" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "totalInvited" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ReferralCode_userId_key" ON "ReferralCode"("userId");
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");

-- ScheduledPush：延迟推送排程（R01 注册 24h 未激活等）
CREATE TABLE "ScheduledPush" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "fireAt" DATETIME NOT NULL,
  "done" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ScheduledPush_done_fireAt_idx" ON "ScheduledPush"("done", "fireAt");
