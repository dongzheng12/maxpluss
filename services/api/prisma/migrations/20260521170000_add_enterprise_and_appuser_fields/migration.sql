-- SaaS 数据底座：Enterprise 表 + AppUser 兜底字段 + DEFAULT 初始企业（幂等）
-- additive 变更，AppUser 新增字段均为 nullable，对现有数据零破坏
-- 详见 必读/standard-execution-开工指令-v1.md §十六

-- ─── 1. Enterprise 主表 ─────────────────────────────────
CREATE TABLE "Enterprise" (
    "id"        TEXT            NOT NULL,
    "name"      TEXT            NOT NULL,
    "code"      TEXT            NOT NULL,
    "status"    TEXT            NOT NULL DEFAULT 'ACTIVE',
    "plan"      TEXT            NOT NULL DEFAULT 'BASIC',
    "createdAt" TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3)  NOT NULL,

    CONSTRAINT "Enterprise_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Enterprise_code_key"   ON "Enterprise"("code");
CREATE INDEX        "Enterprise_status_idx" ON "Enterprise"("status");

-- ─── 2. AppUser 预留企业字段（nullable，老用户不影响）──────
ALTER TABLE "AppUser" ADD COLUMN "enterpriseId"   TEXT;
ALTER TABLE "AppUser" ADD COLUMN "enterpriseRole" TEXT;
CREATE INDEX "AppUser_enterpriseId_idx" ON "AppUser"("enterpriseId");

-- ─── 3. 默认企业（一期单租户，幂等）─────────────────────
INSERT INTO "Enterprise" ("id", "name", "code", "status", "plan", "createdAt", "updatedAt")
VALUES ('DEFAULT', '默认企业', 'DEFAULT', 'ACTIVE', 'BASIC', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
