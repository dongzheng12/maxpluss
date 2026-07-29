-- se-plan-taskitem-refactor
-- 新增 StandardExecutionPlan + StandardExecutionTaskItem 两张表
-- 为 StandardExecutionTask 加可选 planId FK 字段及索引
-- 纯 additive：不删除/重命名任何现有字段

-- AlterTable: StandardExecutionTask 加 planId
ALTER TABLE "StandardExecutionTask" ADD COLUMN "planId" TEXT;

-- CreateTable: StandardExecutionPlan
CREATE TABLE "StandardExecutionPlan" (
    "id"           TEXT           NOT NULL,
    "enterpriseId" TEXT           NOT NULL,
    "sourceId"     TEXT           NOT NULL,
    "title"        TEXT           NOT NULL,
    "roundNumber"  INTEGER        NOT NULL DEFAULT 1,
    "scheduledAt"  TIMESTAMPTZ(3),
    "status"       TEXT           NOT NULL DEFAULT 'DRAFT',
    "createdBy"    TEXT           NOT NULL,
    "createdAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StandardExecutionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable: StandardExecutionTaskItem
CREATE TABLE "StandardExecutionTaskItem" (
    "id"            TEXT           NOT NULL,
    "taskId"        TEXT           NOT NULL,
    "requirementId" TEXT           NOT NULL,
    "status"        TEXT           NOT NULL DEFAULT 'PENDING',
    "note"          TEXT,
    "fileUrls"      JSONB,
    "completedAt"   TIMESTAMPTZ(3),
    "createdAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StandardExecutionTaskItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: StandardExecutionPlan
CREATE INDEX "StandardExecutionPlan_enterpriseId_idx"          ON "StandardExecutionPlan"("enterpriseId");
CREATE INDEX "StandardExecutionPlan_enterpriseId_sourceId_idx" ON "StandardExecutionPlan"("enterpriseId", "sourceId");
CREATE INDEX "StandardExecutionPlan_enterpriseId_status_idx"   ON "StandardExecutionPlan"("enterpriseId", "status");

-- CreateIndex: StandardExecutionTaskItem
CREATE INDEX "StandardExecutionTaskItem_taskId_idx"        ON "StandardExecutionTaskItem"("taskId");
CREATE INDEX "StandardExecutionTaskItem_requirementId_idx" ON "StandardExecutionTaskItem"("requirementId");

-- CreateIndex: StandardExecutionTask 新索引
CREATE INDEX "StandardExecutionTask_enterpriseId_planId_idx" ON "StandardExecutionTask"("enterpriseId", "planId");

-- AddForeignKey: StandardExecutionTask.planId → StandardExecutionPlan
ALTER TABLE "StandardExecutionTask"
    ADD CONSTRAINT "StandardExecutionTask_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "StandardExecutionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: StandardExecutionPlan.enterpriseId → Enterprise
ALTER TABLE "StandardExecutionPlan"
    ADD CONSTRAINT "StandardExecutionPlan_enterpriseId_fkey"
    FOREIGN KEY ("enterpriseId") REFERENCES "Enterprise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: StandardExecutionPlan.sourceId → StandardExecutionSource
ALTER TABLE "StandardExecutionPlan"
    ADD CONSTRAINT "StandardExecutionPlan_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "StandardExecutionSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: StandardExecutionTaskItem.taskId → StandardExecutionTask
ALTER TABLE "StandardExecutionTaskItem"
    ADD CONSTRAINT "StandardExecutionTaskItem_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "StandardExecutionTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: StandardExecutionTaskItem.requirementId → StandardExecutionRequirement
ALTER TABLE "StandardExecutionTaskItem"
    ADD CONSTRAINT "StandardExecutionTaskItem_requirementId_fkey"
    FOREIGN KEY ("requirementId") REFERENCES "StandardExecutionRequirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
