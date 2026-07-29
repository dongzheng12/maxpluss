/*
  Warnings:

  - Added the required column `comparator` to the `StandardClause` table without a default value. This is not possible if the table is not empty.
  - Added the required column `indicator` to the `StandardClause` table without a default value. This is not possible if the table is not empty.
  - Added the required column `threshold` to the `StandardClause` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "ProductionStandard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "standardId" TEXT NOT NULL,
    "dataSource" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductionStandard_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProductionStandard_standardId_fkey" FOREIGN KEY ("standardId") REFERENCES "Standard" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReportItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productionStandardId" TEXT NOT NULL,
    "indicator" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "unit" TEXT,
    "result" TEXT,
    CONSTRAINT "ReportItem_productionStandardId_fkey" FOREIGN KEY ("productionStandardId") REFERENCES "ProductionStandard" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Indicator" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "indicatorId" TEXT,
    "name" TEXT NOT NULL,
    "synonyms" TEXT,
    "defaultUnit" TEXT,
    "dimension" TEXT NOT NULL DEFAULT 'quality',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "reportNo" TEXT,
    "org" TEXT,
    "date" DATETIME,
    "batchNo" TEXT,
    "sourceType" TEXT NOT NULL,
    "fileUrl" TEXT,
    "trustLevel" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Report_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Measurement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "indicatorId" TEXT,
    "rawName" TEXT NOT NULL,
    "rawValue" REAL,
    "rawUnit" TEXT,
    "valueStd" REAL,
    "unitStd" TEXT,
    "mappingConfidence" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Measurement_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Measurement_indicatorId_fkey" FOREIGN KEY ("indicatorId") REFERENCES "Indicator" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PeerBaseline" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categoryId" TEXT NOT NULL,
    "indicatorId" TEXT NOT NULL,
    "avg" REAL,
    "p50" REAL,
    "p75" REAL,
    "p90" REAL,
    "updatedAt" DATETIME,
    "source" TEXT,
    CONSTRAINT "PeerBaseline_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PeerBaseline_indicatorId_fkey" FOREIGN KEY ("indicatorId") REFERENCES "Indicator" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IndicatorMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mappingType" TEXT NOT NULL,
    "rawKey" TEXT NOT NULL,
    "indicatorId" TEXT NOT NULL,
    "rule" TEXT,
    "confidence" REAL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IndicatorMapping_indicatorId_fkey" FOREIGN KEY ("indicatorId") REFERENCES "Indicator" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IngestionJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceType" TEXT NOT NULL,
    "sourceName" TEXT,
    "payloadRef" TEXT,
    "status" TEXT NOT NULL,
    "progress" REAL,
    "errorLog" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "diffJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "StandardContent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "standardId" TEXT NOT NULL,
    "header" TEXT,
    "toc" TEXT,
    "preface" TEXT,
    "intro" TEXT,
    "sections" TEXT,
    "figures" TEXT,
    "tables" TEXT,
    "references" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StandardContent_standardId_fkey" FOREIGN KEY ("standardId") REFERENCES "Standard" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Scene" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "industry" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT '启用',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SceneModule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sceneId" TEXT NOT NULL,
    "moduleType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SceneModule_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "Scene" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SceneStandardBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sceneId" TEXT NOT NULL,
    "standardId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SceneStandardBinding_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "Scene" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SceneStandardBinding_standardId_fkey" FOREIGN KEY ("standardId") REFERENCES "Standard" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SceneRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sceneId" TEXT NOT NULL,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" TEXT,
    CONSTRAINT "SceneRun_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "Scene" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SceneStepLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sceneRunId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "media" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SceneStepLog_sceneRunId_fkey" FOREIGN KEY ("sceneRunId") REFERENCES "SceneRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SceneQuizResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sceneRunId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "score" REAL NOT NULL,
    "total" REAL NOT NULL,
    "durationSec" INTEGER,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SceneQuizResult_sceneRunId_fkey" FOREIGN KEY ("sceneRunId") REFERENCES "SceneRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "category" TEXT,
    "categoryId" TEXT,
    "barcode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Product" ("barcode", "brand", "category", "createdAt", "id", "name") SELECT "barcode", "brand", "category", "createdAt", "id", "name" FROM "Product";
DROP TABLE "Product";
ALTER TABLE "new_Product" RENAME TO "Product";
CREATE UNIQUE INDEX "Product_barcode_key" ON "Product"("barcode");
CREATE TABLE "new_StandardClause" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "standardId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requirement" TEXT NOT NULL,
    "weight" REAL NOT NULL,
    "indicator" TEXT NOT NULL,
    "indicatorId" TEXT,
    "comparator" TEXT NOT NULL,
    "threshold" REAL NOT NULL,
    "limitType" TEXT,
    "thresholdMin" REAL,
    "thresholdMax" REAL,
    "unit" TEXT,
    "scopeText" TEXT,
    "veto" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "StandardClause_standardId_fkey" FOREIGN KEY ("standardId") REFERENCES "Standard" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StandardClause_indicatorId_fkey" FOREIGN KEY ("indicatorId") REFERENCES "Indicator" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_StandardClause" ("id", "key", "requirement", "standardId", "weight") SELECT "id", "key", "requirement", "standardId", "weight" FROM "StandardClause";
DROP TABLE "StandardClause";
ALTER TABLE "new_StandardClause" RENAME TO "StandardClause";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Indicator_indicatorId_key" ON "Indicator"("indicatorId");

-- CreateIndex
CREATE UNIQUE INDEX "StandardContent_standardId_key" ON "StandardContent"("standardId");
