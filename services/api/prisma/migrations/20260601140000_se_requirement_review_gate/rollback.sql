UPDATE "StandardExecutionRequirement"
SET "status" = 'DRAFT'
WHERE "status" = 'REVIEW_PENDING';

ALTER TABLE "StandardExecutionRequirement" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
