-- P0-5 / P1-9: 检查点表补 AI 解析可执行字段
-- recommendedTaskType 供「批量生成任务」继承；其余字段持久化 AI 解析的可执行描述
ALTER TABLE "StandardExecutionRequirement" ADD COLUMN "recommendedTaskType" TEXT;
ALTER TABLE "StandardExecutionRequirement" ADD COLUMN "executionDescription" TEXT;
ALTER TABLE "StandardExecutionRequirement" ADD COLUMN "submitRequirement" TEXT;
ALTER TABLE "StandardExecutionRequirement" ADD COLUMN "requiredMaterials" JSONB;
