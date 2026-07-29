-- Per-assignee TaskItem progress. StandardExecutionTaskItem remains the task template item.
CREATE TABLE "StandardExecutionTaskItemProgress" (
  "id" TEXT NOT NULL,
  "enterpriseId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "taskItemId" TEXT NOT NULL,
  "requirementId" TEXT NOT NULL,
  "assigneeId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "note" TEXT,
  "fileUrls" JSONB,
  "completedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "StandardExecutionTaskItemProgress_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "StandardExecutionTaskItemProgress"
  ADD CONSTRAINT "StandardExecutionTaskItemProgress_taskItemId_fkey"
  FOREIGN KEY ("taskItemId") REFERENCES "StandardExecutionTaskItem"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "StandardExecutionTaskItemProgress_taskItemId_assigneeId_key"
  ON "StandardExecutionTaskItemProgress"("taskItemId", "assigneeId");
CREATE INDEX "StandardExecutionTaskItemProgress_enterpriseId_idx"
  ON "StandardExecutionTaskItemProgress"("enterpriseId");
CREATE INDEX "StandardExecutionTaskItemProgress_enterpriseId_taskId_idx"
  ON "StandardExecutionTaskItemProgress"("enterpriseId", "taskId");
CREATE INDEX "StandardExecutionTaskItemProgress_enterpriseId_assigneeId_idx"
  ON "StandardExecutionTaskItemProgress"("enterpriseId", "assigneeId");
CREATE INDEX "StandardExecutionTaskItemProgress_enterpriseId_taskItemId_idx"
  ON "StandardExecutionTaskItemProgress"("enterpriseId", "taskItemId");
