ALTER TABLE "StandardExecutionSource"
  ADD COLUMN "ownershipTier" TEXT DEFAULT 'R';

CREATE TABLE "StandardExecutionSourceDeclaration" (
  "id" TEXT NOT NULL,
  "enterpriseId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "ownershipTier" TEXT NOT NULL DEFAULT 'O',
  "declarationText" TEXT NOT NULL,
  "declaredBy" TEXT NOT NULL,
  "declaredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress" TEXT,
  "userAgent" TEXT,

  CONSTRAINT "StandardExecutionSourceDeclaration_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StandardExecutionSource_enterpriseId_ownershipTier_idx"
  ON "StandardExecutionSource"("enterpriseId", "ownershipTier");

CREATE INDEX "StandardExecutionSourceDeclaration_enterpriseId_idx"
  ON "StandardExecutionSourceDeclaration"("enterpriseId");

CREATE INDEX "StandardExecutionSourceDeclaration_enterpriseId_sourceId_idx"
  ON "StandardExecutionSourceDeclaration"("enterpriseId", "sourceId");

CREATE INDEX "StandardExecutionSourceDeclaration_enterpriseId_declaredBy_idx"
  ON "StandardExecutionSourceDeclaration"("enterpriseId", "declaredBy");

ALTER TABLE "StandardExecutionSourceDeclaration"
  ADD CONSTRAINT "StandardExecutionSourceDeclaration_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "StandardExecutionSource"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
