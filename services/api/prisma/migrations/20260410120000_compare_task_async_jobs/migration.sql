-- 异步状态机字段（BXZ_TASK_ASYNC_MODE=1 时使用）
-- 对外 status 字段不变（PENDING/PROCESSING/COMPLETED/FAILED）
-- 三个新字段全部 nullable，关闭异步模式时不影响旧路径

ALTER TABLE "CompareTask" ADD COLUMN "processingStage" TEXT;
ALTER TABLE "CompareTask" ADD COLUMN "dedupJobId" TEXT;
ALTER TABLE "CompareTask" ADD COLUMN "stageStartedAt" DATETIME;
