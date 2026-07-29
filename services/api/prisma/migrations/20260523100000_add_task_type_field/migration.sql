-- AlterTable: add nullable taskType column to StandardExecutionTask
ALTER TABLE "StandardExecutionTask" ADD COLUMN "taskType" TEXT;
