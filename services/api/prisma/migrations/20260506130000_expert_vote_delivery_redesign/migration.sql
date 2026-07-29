-- Migration: 专家评审投票确认文件交付重设计
-- 目标：取消"电子签 / 签章"语义，统一为"最终交付文件 + 专家签字材料"
-- 原则：仅追加字段，不删除旧字段（signedPdfPath/Hash/At/By/SignSubject 保留作向后兼容双写过渡）

-- 行级通知状态：后台逐位标记"已通知"
ALTER TABLE "ExpertAssignment"
    ADD COLUMN "notifiedAt" TIMESTAMPTZ(3),
    ADD COLUMN "notifiedBy" TEXT;

-- 交付字段：路径一（系统合成）+ 路径二（线下上传）共用 finalDeliverable*
ALTER TABLE "ExpertVoteRequest"
    ADD COLUMN "resultDocxPath"              TEXT,
    ADD COLUMN "expertSignatureMaterialPath" TEXT,
    ADD COLUMN "finalDeliverablePath"        TEXT,
    ADD COLUMN "finalDeliverableHash"        TEXT,
    ADD COLUMN "deliveryMode"                TEXT,
    ADD COLUMN "deliveredBy"                 TEXT;
