-- AlterTable: 加 3 个任务类型结构化配置字段（JSONB, 可空）
ALTER TABLE "StandardExecutionTask" ADD COLUMN "checklistSchema"   JSONB;
ALTER TABLE "StandardExecutionTask" ADD COLUMN "parametersSchema"  JSONB;
ALTER TABLE "StandardExecutionTask" ADD COLUMN "learningMaterials" JSONB;
