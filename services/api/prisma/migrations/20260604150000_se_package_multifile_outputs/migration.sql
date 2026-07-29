ALTER TABLE "StandardExecutionPackage"
  ADD COLUMN "generationStatus" TEXT NOT NULL DEFAULT 'IDLE',
  ADD COLUMN "generationBatchId" TEXT,
  ADD COLUMN "generationOptions" JSONB,
  ADD COLUMN "outputDir" TEXT,
  ADD COLUMN "outputManifest" JSONB,
  ADD COLUMN "generationError" TEXT;

ALTER TABLE "StandardExecutionPackage"
  ALTER COLUMN "format" SET DEFAULT 'FOLDER';
