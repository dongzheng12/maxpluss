-- 营销自动化 R13：流失召回附赠的全库比对次数（年度限制外额度）
ALTER TABLE "AppUser" ADD COLUMN "bonusCompareQuota" INTEGER NOT NULL DEFAULT 0;
