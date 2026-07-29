-- CreateTable: ContentConfig (CMS 展示内容管理, 2026-04-26)
CREATE TABLE "ContentConfig" (
    "id"          TEXT NOT NULL PRIMARY KEY,
    "key"         TEXT NOT NULL,
    "group"       TEXT NOT NULL,
    "platform"    TEXT NOT NULL,
    "type"        TEXT NOT NULL,
    "title"       TEXT,
    "subtitle"    TEXT,
    "description" TEXT,
    "content"     TEXT,
    "imageUrl"    TEXT,
    "linkUrl"     TEXT,
    "linkText"    TEXT,
    "extraJson"   TEXT,
    "sortOrder"   INTEGER NOT NULL DEFAULT 0,
    "enabled"     INTEGER NOT NULL DEFAULT 1,
    "remark"      TEXT,
    "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ContentConfig_key_key" ON "ContentConfig"("key");
CREATE INDEX "ContentConfig_group_platform_enabled_sortOrder_idx"
    ON "ContentConfig"("group", "platform", "enabled", "sortOrder");
