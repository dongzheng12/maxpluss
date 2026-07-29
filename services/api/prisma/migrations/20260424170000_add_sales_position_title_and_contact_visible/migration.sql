-- AlterTable: SalesProfile 增加 positionTitle（可空）+ contactVisible（默认 true）
ALTER TABLE "SalesProfile" ADD COLUMN "positionTitle" TEXT;
ALTER TABLE "SalesProfile" ADD COLUMN "contactVisible" BOOLEAN NOT NULL DEFAULT 1;
