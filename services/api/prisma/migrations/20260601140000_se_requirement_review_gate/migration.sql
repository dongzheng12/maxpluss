-- Requirement Review Gate: route newly parsed/manual requirements through REVIEW_PENDING.
ALTER TABLE "StandardExecutionRequirement" ALTER COLUMN "status" SET DEFAULT 'REVIEW_PENDING';

UPDATE "StandardExecutionRequirement"
SET "status" = 'REVIEW_PENDING'
WHERE "status" = 'DRAFT';
