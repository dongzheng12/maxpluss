-- 埋点分析表
CREATE TABLE IF NOT EXISTS "AnalyticsEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "event" TEXT NOT NULL,
    "props" TEXT,
    "platform" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "clientTs" BIGINT,
    "serverTs" BIGINT NOT NULL,
    "ip" TEXT,
    "ua" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "AnalyticsEvent_event_serverTs_idx" ON "AnalyticsEvent"("event", "serverTs");
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_userId_serverTs_idx" ON "AnalyticsEvent"("userId", "serverTs");
