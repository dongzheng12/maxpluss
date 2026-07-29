-- Migration: add notifiedAt / notifiedBy to ExpertVoteRequest
-- 记录管理员人工通知专家的时间和操作人，用于通知模块状态展示

ALTER TABLE "ExpertVoteRequest"
    ADD COLUMN "notifiedAt" TIMESTAMPTZ(3),
    ADD COLUMN "notifiedBy" TEXT;
