-- DropForeignKey
ALTER TABLE "StandardExecutionTask" DROP CONSTRAINT "StandardExecutionTask_requirementId_fkey";

-- DropIndex
DROP INDEX "StandardExecutionRecord_submissionId_key";

-- AlterTable
ALTER TABLE "StandardExecutionRecord" ADD COLUMN     "taskItemId" TEXT;

-- AlterTable
ALTER TABLE "StandardExecutionTask" ALTER COLUMN "requirementId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "StandardExecutionRecord_submissionId_taskItemId_key" ON "StandardExecutionRecord"("submissionId", "taskItemId");

-- AddForeignKey
ALTER TABLE "StandardExecutionTask" ADD CONSTRAINT "StandardExecutionTask_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "StandardExecutionRequirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandardExecutionRecord" ADD CONSTRAINT "StandardExecutionRecord_taskItemId_fkey" FOREIGN KEY ("taskItemId") REFERENCES "StandardExecutionTaskItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

