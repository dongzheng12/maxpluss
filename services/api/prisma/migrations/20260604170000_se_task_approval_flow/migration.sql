ALTER TABLE "StandardExecutionTask"
  ALTER COLUMN "deadlineAt" DROP NOT NULL,
  ALTER COLUMN "reviewerId" DROP NOT NULL,
  ADD COLUMN "deadlineMode" TEXT NOT NULL DEFAULT 'FIXED',
  ADD COLUMN "deadlineDaysAfterApproval" INTEGER,
  ADD COLUMN "submittedForApprovalAt" TIMESTAMPTZ(3),
  ADD COLUMN "approvedAt" TIMESTAMPTZ(3);

ALTER TABLE "StandardExecutionPlan"
  ADD COLUMN "frequency" TEXT,
  ADD COLUMN "startAt" TIMESTAMPTZ(3),
  ADD COLUMN "endAt" TIMESTAMPTZ(3),
  ADD COLUMN "nextRunAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastRunAt" TIMESTAMPTZ(3),
  ADD COLUMN "defaultReviewerId" TEXT,
  ADD COLUMN "defaultAssigneeIds" JSONB,
  ADD COLUMN "defaultTaskType" TEXT,
  ADD COLUMN "defaultDeadlineMode" TEXT NOT NULL DEFAULT 'AFTER_APPROVAL_DAYS',
  ADD COLUMN "defaultDeadlineDaysAfterApproval" INTEGER DEFAULT 7;

CREATE TABLE "StandardExecutionTaskApprovalLog" (
  "id" TEXT NOT NULL,
  "enterpriseId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "reviewerId" TEXT NOT NULL,
  "comment" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "StandardExecutionTaskApprovalLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StandardExecutionTaskApprovalLog_enterpriseId_idx"
  ON "StandardExecutionTaskApprovalLog"("enterpriseId");
CREATE INDEX "StandardExecutionTaskApprovalLog_enterpriseId_taskId_idx"
  ON "StandardExecutionTaskApprovalLog"("enterpriseId", "taskId");
CREATE INDEX "StandardExecutionTaskApprovalLog_enterpriseId_reviewerId_idx"
  ON "StandardExecutionTaskApprovalLog"("enterpriseId", "reviewerId");
CREATE INDEX "StandardExecutionTaskApprovalLog_enterpriseId_action_idx"
  ON "StandardExecutionTaskApprovalLog"("enterpriseId", "action");
CREATE INDEX "StandardExecutionTask_enterpriseId_submittedForApprovalAt_idx"
  ON "StandardExecutionTask"("enterpriseId", "submittedForApprovalAt");
CREATE INDEX "StandardExecutionPlan_enterpriseId_nextRunAt_idx"
  ON "StandardExecutionPlan"("enterpriseId", "nextRunAt");

CREATE TABLE "StandardExecutionPlanRun" (
  "id" TEXT NOT NULL,
  "enterpriseId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "runDate" TIMESTAMPTZ(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CREATED',
  "createdTaskIds" JSONB,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "StandardExecutionPlanRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StandardExecutionPlanRun_planId_runDate_key"
  ON "StandardExecutionPlanRun"("planId", "runDate");
CREATE INDEX "StandardExecutionPlanRun_enterpriseId_idx"
  ON "StandardExecutionPlanRun"("enterpriseId");
CREATE INDEX "StandardExecutionPlanRun_enterpriseId_planId_idx"
  ON "StandardExecutionPlanRun"("enterpriseId", "planId");
CREATE INDEX "StandardExecutionPlanRun_enterpriseId_runDate_idx"
  ON "StandardExecutionPlanRun"("enterpriseId", "runDate");

ALTER TABLE "StandardExecutionTaskApprovalLog"
  ADD CONSTRAINT "StandardExecutionTaskApprovalLog_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "StandardExecutionTask"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StandardExecutionPlanRun"
  ADD CONSTRAINT "StandardExecutionPlanRun_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "StandardExecutionPlan"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
