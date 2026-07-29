-- Requirement parse audit fields.
ALTER TABLE "StandardExecutionRequirement"
  ADD COLUMN "parseMode" TEXT,
  ADD COLUMN "degradedReason" TEXT;
