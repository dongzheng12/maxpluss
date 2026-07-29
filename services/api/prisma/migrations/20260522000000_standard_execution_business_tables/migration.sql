-- standard-execution 业务表（11 张）
-- 详见 必读/standard-execution-开工指令-v1.md §六
-- 一期单租户：enterpriseId 默认 'DEFAULT'，所有查询必须按 enterpriseId 隔离

-- ─── 1. StandardExecutionSource ────────────────────────────
CREATE TABLE "StandardExecutionSource" (
    "id"           TEXT           NOT NULL,
    "enterpriseId" TEXT           NOT NULL,
    "title"        TEXT           NOT NULL,
    "sourceType"   TEXT           NOT NULL,
    "sourceNo"     TEXT,
    "version"      TEXT,
    "rawText"      TEXT,
    "fileUrl"      TEXT,
    "status"       TEXT           NOT NULL DEFAULT 'ACTIVE',
    "createdBy"    TEXT           NOT NULL,
    "updatedBy"    TEXT,
    "createdAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StandardExecutionSource_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StandardExecutionSource_enterpriseId_idx"            ON "StandardExecutionSource"("enterpriseId");
CREATE INDEX "StandardExecutionSource_enterpriseId_sourceType_idx" ON "StandardExecutionSource"("enterpriseId", "sourceType");
CREATE INDEX "StandardExecutionSource_enterpriseId_status_idx"     ON "StandardExecutionSource"("enterpriseId", "status");

-- ─── 2. StandardExecutionRequirement ───────────────────────
CREATE TABLE "StandardExecutionRequirement" (
    "id"                  TEXT           NOT NULL,
    "enterpriseId"        TEXT           NOT NULL,
    "sourceId"            TEXT           NOT NULL,
    "clauseNo"            TEXT,
    "title"               TEXT           NOT NULL,
    "requirementText"     TEXT           NOT NULL,
    "requirementType"     TEXT,
    "applicableDeptIds"   JSONB,
    "recommendedTaskType" TEXT,
    "archiveTags"         JSONB,
    "generateMode"        TEXT           NOT NULL DEFAULT 'MANUAL',
    "status"              TEXT           NOT NULL DEFAULT 'DRAFT',
    "createdBy"           TEXT           NOT NULL,
    "updatedBy"           TEXT,
    "createdAt"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StandardExecutionRequirement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StandardExecutionRequirement_enterpriseId_idx"                 ON "StandardExecutionRequirement"("enterpriseId");
CREATE INDEX "StandardExecutionRequirement_enterpriseId_sourceId_idx"        ON "StandardExecutionRequirement"("enterpriseId", "sourceId");
CREATE INDEX "StandardExecutionRequirement_enterpriseId_status_idx"          ON "StandardExecutionRequirement"("enterpriseId", "status");
CREATE INDEX "StandardExecutionRequirement_enterpriseId_requirementType_idx" ON "StandardExecutionRequirement"("enterpriseId", "requirementType");
ALTER TABLE "StandardExecutionRequirement"
    ADD CONSTRAINT "StandardExecutionRequirement_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "StandardExecutionSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 3. StandardExecutionTask ──────────────────────────────
CREATE TABLE "StandardExecutionTask" (
    "id"                TEXT           NOT NULL,
    "enterpriseId"      TEXT           NOT NULL,
    "requirementId"     TEXT           NOT NULL,
    "title"             TEXT           NOT NULL,
    "description"       TEXT,
    "submitRequirement" TEXT,
    "deadlineAt"        TIMESTAMPTZ(3) NOT NULL,
    "reviewerId"        TEXT           NOT NULL,
    "status"            TEXT           NOT NULL DEFAULT 'DRAFT',
    "publishedAt"       TIMESTAMPTZ(3),
    "completedAt"       TIMESTAMPTZ(3),
    "cancelledAt"       TIMESTAMPTZ(3),
    "createdBy"         TEXT           NOT NULL,
    "updatedBy"         TEXT,
    "createdAt"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StandardExecutionTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StandardExecutionTask_enterpriseId_idx"                ON "StandardExecutionTask"("enterpriseId");
CREATE INDEX "StandardExecutionTask_enterpriseId_requirementId_idx"  ON "StandardExecutionTask"("enterpriseId", "requirementId");
CREATE INDEX "StandardExecutionTask_enterpriseId_status_idx"         ON "StandardExecutionTask"("enterpriseId", "status");
CREATE INDEX "StandardExecutionTask_enterpriseId_deadlineAt_idx"     ON "StandardExecutionTask"("enterpriseId", "deadlineAt");
CREATE INDEX "StandardExecutionTask_enterpriseId_reviewerId_idx"     ON "StandardExecutionTask"("enterpriseId", "reviewerId");
ALTER TABLE "StandardExecutionTask"
    ADD CONSTRAINT "StandardExecutionTask_requirementId_fkey"
    FOREIGN KEY ("requirementId") REFERENCES "StandardExecutionRequirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 4. StandardExecutionTaskAssignee ──────────────────────
CREATE TABLE "StandardExecutionTaskAssignee" (
    "id"           TEXT           NOT NULL,
    "enterpriseId" TEXT           NOT NULL,
    "taskId"       TEXT           NOT NULL,
    "assigneeId"   TEXT           NOT NULL,
    "departmentId" TEXT,
    "reviewerId"   TEXT,
    "status"       TEXT           NOT NULL DEFAULT 'PENDING',
    "submittedAt"  TIMESTAMPTZ(3),
    "reviewedAt"   TIMESTAMPTZ(3),
    "createdAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StandardExecutionTaskAssignee_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StandardExecutionTaskAssignee_enterpriseId_idx"               ON "StandardExecutionTaskAssignee"("enterpriseId");
CREATE INDEX "StandardExecutionTaskAssignee_enterpriseId_taskId_idx"        ON "StandardExecutionTaskAssignee"("enterpriseId", "taskId");
CREATE INDEX "StandardExecutionTaskAssignee_enterpriseId_assigneeId_idx"    ON "StandardExecutionTaskAssignee"("enterpriseId", "assigneeId");
CREATE INDEX "StandardExecutionTaskAssignee_enterpriseId_departmentId_idx"  ON "StandardExecutionTaskAssignee"("enterpriseId", "departmentId");
CREATE INDEX "StandardExecutionTaskAssignee_enterpriseId_status_idx"        ON "StandardExecutionTaskAssignee"("enterpriseId", "status");
ALTER TABLE "StandardExecutionTaskAssignee"
    ADD CONSTRAINT "StandardExecutionTaskAssignee_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "StandardExecutionTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 5. StandardExecutionSubmission ────────────────────────
CREATE TABLE "StandardExecutionSubmission" (
    "id"                 TEXT           NOT NULL,
    "enterpriseId"       TEXT           NOT NULL,
    "taskId"             TEXT           NOT NULL,
    "assigneeId"         TEXT           NOT NULL,
    "submitText"         TEXT           NOT NULL,
    "submitDataJson"     JSONB,
    "status"             TEXT           NOT NULL DEFAULT 'SUBMITTED',
    "version"            INTEGER        NOT NULL DEFAULT 1,
    "isLatest"           BOOLEAN        NOT NULL DEFAULT true,
    "parentSubmissionId" TEXT,
    "submittedAt"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt"         TIMESTAMPTZ(3),
    "reviewerId"         TEXT,
    "reviewComment"      TEXT,
    "createdAt"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StandardExecutionSubmission_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StandardExecutionSubmission_enterpriseId_idx"             ON "StandardExecutionSubmission"("enterpriseId");
CREATE INDEX "StandardExecutionSubmission_enterpriseId_taskId_idx"      ON "StandardExecutionSubmission"("enterpriseId", "taskId");
CREATE INDEX "StandardExecutionSubmission_enterpriseId_assigneeId_idx"  ON "StandardExecutionSubmission"("enterpriseId", "assigneeId");
CREATE INDEX "StandardExecutionSubmission_enterpriseId_status_idx"      ON "StandardExecutionSubmission"("enterpriseId", "status");
CREATE INDEX "StandardExecutionSubmission_enterpriseId_isLatest_idx"    ON "StandardExecutionSubmission"("enterpriseId", "isLatest");
ALTER TABLE "StandardExecutionSubmission"
    ADD CONSTRAINT "StandardExecutionSubmission_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "StandardExecutionTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 6. StandardExecutionAttachment ────────────────────────
CREATE TABLE "StandardExecutionAttachment" (
    "id"           TEXT           NOT NULL,
    "enterpriseId" TEXT           NOT NULL,
    "bizType"      TEXT           NOT NULL,
    "bizId"        TEXT           NOT NULL,
    "fileName"     TEXT           NOT NULL,
    "fileUrl"      TEXT           NOT NULL,
    "fileSize"     INTEGER,
    "mimeType"     TEXT,
    "uploadedBy"   TEXT           NOT NULL,
    "createdAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StandardExecutionAttachment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StandardExecutionAttachment_enterpriseId_idx"                ON "StandardExecutionAttachment"("enterpriseId");
CREATE INDEX "StandardExecutionAttachment_enterpriseId_bizType_bizId_idx"  ON "StandardExecutionAttachment"("enterpriseId", "bizType", "bizId");
-- bizType=SUBMISSION 时 bizId → Submission.id；SOURCE/PACKAGE 走应用层校验
ALTER TABLE "StandardExecutionAttachment"
    ADD CONSTRAINT "submission_attachment"
    FOREIGN KEY ("bizId") REFERENCES "StandardExecutionSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 7. StandardExecutionReviewLog ─────────────────────────
CREATE TABLE "StandardExecutionReviewLog" (
    "id"           TEXT           NOT NULL,
    "enterpriseId" TEXT           NOT NULL,
    "submissionId" TEXT           NOT NULL,
    "taskId"       TEXT           NOT NULL,
    "action"       TEXT           NOT NULL,
    "fromStatus"   TEXT           NOT NULL,
    "toStatus"     TEXT           NOT NULL,
    "reviewerId"   TEXT           NOT NULL,
    "comment"      TEXT,
    "createdAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StandardExecutionReviewLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StandardExecutionReviewLog_enterpriseId_idx"               ON "StandardExecutionReviewLog"("enterpriseId");
CREATE INDEX "StandardExecutionReviewLog_enterpriseId_submissionId_idx"  ON "StandardExecutionReviewLog"("enterpriseId", "submissionId");
CREATE INDEX "StandardExecutionReviewLog_enterpriseId_taskId_idx"        ON "StandardExecutionReviewLog"("enterpriseId", "taskId");
CREATE INDEX "StandardExecutionReviewLog_enterpriseId_reviewerId_idx"    ON "StandardExecutionReviewLog"("enterpriseId", "reviewerId");
ALTER TABLE "StandardExecutionReviewLog"
    ADD CONSTRAINT "StandardExecutionReviewLog_submissionId_fkey"
    FOREIGN KEY ("submissionId") REFERENCES "StandardExecutionSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StandardExecutionReviewLog"
    ADD CONSTRAINT "StandardExecutionReviewLog_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "StandardExecutionTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 8. StandardExecutionRecord ────────────────────────────
CREATE TABLE "StandardExecutionRecord" (
    "id"            TEXT           NOT NULL,
    "enterpriseId"  TEXT           NOT NULL,
    "sourceId"      TEXT           NOT NULL,
    "requirementId" TEXT           NOT NULL,
    "taskId"        TEXT           NOT NULL,
    "submissionId"  TEXT           NOT NULL,
    "assigneeId"    TEXT           NOT NULL,
    "departmentId"  TEXT,
    "recordType"    TEXT,
    "title"         TEXT           NOT NULL,
    "summary"       TEXT,
    "recordDate"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil"    TIMESTAMPTZ(3),
    "status"        TEXT           NOT NULL DEFAULT 'VALID',
    "createdFrom"   TEXT           NOT NULL DEFAULT 'REVIEW_APPROVE',
    "createdAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StandardExecutionRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StandardExecutionRecord_submissionId_key"             ON "StandardExecutionRecord"("submissionId");
CREATE INDEX "StandardExecutionRecord_enterpriseId_idx"                    ON "StandardExecutionRecord"("enterpriseId");
CREATE INDEX "StandardExecutionRecord_enterpriseId_sourceId_idx"           ON "StandardExecutionRecord"("enterpriseId", "sourceId");
CREATE INDEX "StandardExecutionRecord_enterpriseId_requirementId_idx"      ON "StandardExecutionRecord"("enterpriseId", "requirementId");
CREATE INDEX "StandardExecutionRecord_enterpriseId_taskId_idx"             ON "StandardExecutionRecord"("enterpriseId", "taskId");
CREATE INDEX "StandardExecutionRecord_enterpriseId_assigneeId_idx"         ON "StandardExecutionRecord"("enterpriseId", "assigneeId");
CREATE INDEX "StandardExecutionRecord_enterpriseId_departmentId_idx"       ON "StandardExecutionRecord"("enterpriseId", "departmentId");
CREATE INDEX "StandardExecutionRecord_enterpriseId_status_idx"             ON "StandardExecutionRecord"("enterpriseId", "status");
CREATE INDEX "StandardExecutionRecord_enterpriseId_recordDate_idx"         ON "StandardExecutionRecord"("enterpriseId", "recordDate");
ALTER TABLE "StandardExecutionRecord"
    ADD CONSTRAINT "StandardExecutionRecord_submissionId_fkey"
    FOREIGN KEY ("submissionId") REFERENCES "StandardExecutionSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StandardExecutionRecord"
    ADD CONSTRAINT "StandardExecutionRecord_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "StandardExecutionTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 9. StandardExecutionPackage ───────────────────────────
CREATE TABLE "StandardExecutionPackage" (
    "id"               TEXT           NOT NULL,
    "enterpriseId"     TEXT           NOT NULL,
    "title"            TEXT           NOT NULL,
    "packageScene"     TEXT           NOT NULL,
    "description"      TEXT,
    "status"           TEXT           NOT NULL DEFAULT 'DRAFT',
    "hasInvalidRecord" BOOLEAN        NOT NULL DEFAULT false,
    "generatedAt"      TIMESTAMPTZ(3),
    "createdBy"        TEXT           NOT NULL,
    "createdAt"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StandardExecutionPackage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StandardExecutionPackage_enterpriseId_idx"                ON "StandardExecutionPackage"("enterpriseId");
CREATE INDEX "StandardExecutionPackage_enterpriseId_status_idx"         ON "StandardExecutionPackage"("enterpriseId", "status");
CREATE INDEX "StandardExecutionPackage_enterpriseId_packageScene_idx"   ON "StandardExecutionPackage"("enterpriseId", "packageScene");

-- ─── 10. StandardExecutionPackageItem ──────────────────────
CREATE TABLE "StandardExecutionPackageItem" (
    "id"            TEXT           NOT NULL,
    "enterpriseId"  TEXT           NOT NULL,
    "packageId"     TEXT           NOT NULL,
    "recordId"      TEXT           NOT NULL,
    "requirementId" TEXT           NOT NULL,
    "taskId"        TEXT           NOT NULL,
    "submissionId"  TEXT           NOT NULL,
    "sortNo"        INTEGER        NOT NULL DEFAULT 0,
    "createdAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StandardExecutionPackageItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StandardExecutionPackageItem_enterpriseId_idx"             ON "StandardExecutionPackageItem"("enterpriseId");
CREATE INDEX "StandardExecutionPackageItem_enterpriseId_packageId_idx"   ON "StandardExecutionPackageItem"("enterpriseId", "packageId");
CREATE INDEX "StandardExecutionPackageItem_enterpriseId_recordId_idx"    ON "StandardExecutionPackageItem"("enterpriseId", "recordId");
ALTER TABLE "StandardExecutionPackageItem"
    ADD CONSTRAINT "StandardExecutionPackageItem_packageId_fkey"
    FOREIGN KEY ("packageId") REFERENCES "StandardExecutionPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StandardExecutionPackageItem"
    ADD CONSTRAINT "StandardExecutionPackageItem_recordId_fkey"
    FOREIGN KEY ("recordId") REFERENCES "StandardExecutionRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 11. StandardExecutionRisk ─────────────────────────────
CREATE TABLE "StandardExecutionRisk" (
    "id"           TEXT           NOT NULL,
    "enterpriseId" TEXT           NOT NULL,
    "riskType"     TEXT           NOT NULL,
    "riskLevel"    TEXT           NOT NULL,
    "title"        TEXT           NOT NULL,
    "description"  TEXT,
    "relatedType"  TEXT,
    "relatedId"    TEXT,
    "status"       TEXT           NOT NULL DEFAULT 'UNHANDLED',
    "createdAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handledAt"    TIMESTAMPTZ(3),
    "handledBy"    TEXT,

    CONSTRAINT "StandardExecutionRisk_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StandardExecutionRisk_enterpriseId_idx"             ON "StandardExecutionRisk"("enterpriseId");
CREATE INDEX "StandardExecutionRisk_enterpriseId_riskType_idx"    ON "StandardExecutionRisk"("enterpriseId", "riskType");
CREATE INDEX "StandardExecutionRisk_enterpriseId_status_idx"      ON "StandardExecutionRisk"("enterpriseId", "status");
