-- AdminRole / AdminUserRole 后台 RBAC（additive，无现有数据破坏）

-- AdminRole 表
CREATE TABLE "AdminRole" (
    "id"                TEXT        NOT NULL,
    "name"              TEXT        NOT NULL,
    "description"       TEXT,
    "menuPermissions"   JSONB       NOT NULL DEFAULT '[]',
    "actionPermissions" JSONB       NOT NULL DEFAULT '[]',
    "dataScope"         TEXT        NOT NULL DEFAULT 'SELF',
    "isSystem"          BOOLEAN     NOT NULL DEFAULT false,
    "status"            TEXT        NOT NULL DEFAULT 'ACTIVE',
    "createdBy"         TEXT        NOT NULL,
    "createdAt"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AdminRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminRole_name_key" ON "AdminRole"("name");

-- AdminUserRole 表（user-role 关系 + 启停状态）
CREATE TABLE "AdminUserRole" (
    "id"         TEXT        NOT NULL,
    "userId"     TEXT        NOT NULL,
    "roleId"     TEXT        NOT NULL,
    "status"     TEXT        NOT NULL DEFAULT 'ACTIVE',
    "assignedBy" TEXT        NOT NULL,
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUserRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminUserRole_userId_roleId_key" ON "AdminUserRole"("userId", "roleId");
CREATE INDEX "AdminUserRole_userId_idx" ON "AdminUserRole"("userId");
CREATE INDEX "AdminUserRole_roleId_idx" ON "AdminUserRole"("roleId");

ALTER TABLE "AdminUserRole" ADD CONSTRAINT "AdminUserRole_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AdminUserRole" ADD CONSTRAINT "AdminUserRole_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
