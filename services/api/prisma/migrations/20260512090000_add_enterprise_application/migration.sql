-- 企业版申请表单（PC Web 登录页 → 企业版 Tab）
-- 公开接口写入，Admin 后台跟进；status: pending | contacted | converted
-- additive 变更，无对现有表破坏

CREATE TABLE "EnterpriseApplication" (
    "id"          TEXT            NOT NULL,
    "name"        TEXT            NOT NULL,
    "position"    TEXT            NOT NULL,
    "company"     TEXT            NOT NULL,
    "phone"       TEXT            NOT NULL,
    "requirement" TEXT            NOT NULL DEFAULT '',
    "status"      TEXT            NOT NULL DEFAULT 'pending',
    "ipAddress"   TEXT,
    "createdAt"   TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMPTZ(3)  NOT NULL,

    CONSTRAINT "EnterpriseApplication_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EnterpriseApplication_phone_idx" ON "EnterpriseApplication"("phone");
CREATE INDEX "EnterpriseApplication_status_createdAt_idx" ON "EnterpriseApplication"("status", "createdAt" DESC);
