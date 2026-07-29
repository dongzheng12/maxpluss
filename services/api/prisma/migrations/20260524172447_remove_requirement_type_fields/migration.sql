-- PG DROP COLUMN 会级联删依赖该列的索引
ALTER TABLE "StandardExecutionRequirement" DROP COLUMN IF EXISTS "recommendedTaskType";
ALTER TABLE "StandardExecutionRequirement" DROP COLUMN IF EXISTS "requirementType";
