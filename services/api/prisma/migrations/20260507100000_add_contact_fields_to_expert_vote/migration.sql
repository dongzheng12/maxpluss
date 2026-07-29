-- 申请人联系信息：DB nullable，提交时由 assertDraftSubmittable 校验必填
-- 兼容存量 DRAFT 记录（旧数据两字段为 NULL，提交时会被拦住要求补填）

ALTER TABLE "ExpertVoteRequest" ADD COLUMN "contactName"  TEXT;
ALTER TABLE "ExpertVoteRequest" ADD COLUMN "contactPhone" TEXT;
