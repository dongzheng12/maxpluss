-- P1: 订单 FAILED 状态 + 比对任务错误信息
-- AppOrder 增加 failedAt 字段
ALTER TABLE "AppOrder" ADD COLUMN "failedAt" DATETIME;

-- CompareTask 增加 errorMessage 字段
ALTER TABLE "CompareTask" ADD COLUMN "errorMessage" TEXT;
