-- 专家评审投票（P0-1）：5 张表全部 additive，无现有数据破坏

-- ExpertVoteRequest 主单
CREATE TABLE "ExpertVoteRequest" (
    "id"                        TEXT            NOT NULL,
    "requestNo"                 TEXT            NOT NULL,
    "userId"                    TEXT            NOT NULL,
    "orderNo"                   TEXT,
    "status"                    TEXT            NOT NULL DEFAULT 'DRAFT',

    -- 基础评审信息
    "projectName"               TEXT            NOT NULL,
    "targetName"                TEXT            NOT NULL,
    "projectType"               TEXT            NOT NULL,
    "standardType"              TEXT            NOT NULL,
    "standardStatus"            TEXT            NOT NULL,
    "industries"                TEXT            NOT NULL DEFAULT '[]',
    "keywords"                  TEXT,
    "draftingOrgs"              TEXT,
    "participatingOrgs"         TEXT,
    "backgroundDesc"            TEXT            NOT NULL,
    "disputePoints"             TEXT,
    "expectedFinishAt"          TIMESTAMPTZ(3),
    "confidentialLevel"         TEXT            NOT NULL DEFAULT 'NONE',
    "confidentialRemark"        TEXT,

    -- 专家需求
    "expertSourceType"          TEXT            NOT NULL,
    "expertCategories"          TEXT            NOT NULL DEFAULT '[]',
    "expertKeywords"            TEXT,
    "titleRequirements"         TEXT            NOT NULL DEFAULT '["不限"]',
    "orgBackgroundRequirements" TEXT            NOT NULL DEFAULT '["不限"]',
    "expertCount"               INTEGER         NOT NULL,
    "extraExpertNote"           TEXT,
    "userSpecifiedExperts"      TEXT,

    -- 会议时间
    "desiredDate"               TIMESTAMPTZ(3),
    "desiredSlot"               TEXT,
    "acceptReschedule"          BOOLEAN         NOT NULL DEFAULT true,
    "backupTimeNote"            TEXT,

    "materialRemark"            TEXT,

    -- 金额快照
    "unitPrice"                 INTEGER,
    "totalAmount"               INTEGER,

    -- 后台回填会议
    "meetingTitle"              TEXT,
    "meetingStartAt"            TIMESTAMPTZ(3),
    "meetingEndAt"              TIMESTAMPTZ(3),
    "tencentMeetingId"          TEXT,
    "tencentMeetingUrl"         TEXT,
    "tencentMeetingPwd"         TEXT,
    "meetingHost"               TEXT,
    "meetingHostContact"        TEXT,
    "meetingNotes"              TEXT,
    "meetingArrangedAt"         TIMESTAMPTZ(3),
    "meetingArrangedBy"         TEXT,

    -- 投票阶段
    "voteStartedAt"             TIMESTAMPTZ(3),
    "voteClosedAt"              TIMESTAMPTZ(3),
    "voteClosedBy"              TEXT,
    "voteResultJson"            TEXT,
    "conclusion"                TEXT,
    "conclusionRemark"          TEXT,

    -- 签章 / 交付
    "resultPdfPath"             TEXT,
    "signedPdfPath"             TEXT,
    "signedPdfHash"             TEXT,
    "signedAt"                  TIMESTAMPTZ(3),
    "signedBy"                  TEXT,
    "signSubject"               TEXT,
    "deliveredAt"               TIMESTAMPTZ(3),

    -- 取消 / 关闭
    "cancelReason"              TEXT,
    "cancelledAt"               TIMESTAMPTZ(3),
    "cancelledBy"               TEXT,
    "closedReason"              TEXT,

    "submittedAt"               TIMESTAMPTZ(3),
    "paidAt"                    TIMESTAMPTZ(3),
    "createdAt"                 TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                 TIMESTAMPTZ(3)  NOT NULL,

    CONSTRAINT "ExpertVoteRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExpertVoteRequest_requestNo_key" ON "ExpertVoteRequest"("requestNo");
CREATE UNIQUE INDEX "ExpertVoteRequest_orderNo_key"   ON "ExpertVoteRequest"("orderNo");
CREATE INDEX "ExpertVoteRequest_userId_status_idx"     ON "ExpertVoteRequest"("userId", "status");
CREATE INDEX "ExpertVoteRequest_status_updatedAt_idx"  ON "ExpertVoteRequest"("status", "updatedAt");

-- ExpertVoteAttachment 附件
CREATE TABLE "ExpertVoteAttachment" (
    "id"           TEXT            NOT NULL,
    "requestId"    TEXT            NOT NULL,
    "category"     TEXT            NOT NULL,
    "originalName" TEXT            NOT NULL,
    "storagePath"  TEXT            NOT NULL,
    "size"         INTEGER         NOT NULL,
    "mimeType"     TEXT,
    "uploadedBy"   TEXT            NOT NULL,
    "deletedAt"    TIMESTAMPTZ(3),
    "createdAt"    TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpertVoteAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExpertVoteAttachment_requestId_category_deletedAt_idx" ON "ExpertVoteAttachment"("requestId", "category", "deletedAt");

ALTER TABLE "ExpertVoteAttachment"
    ADD CONSTRAINT "ExpertVoteAttachment_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "ExpertVoteRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ExpertAssignment 专家分配
CREATE TABLE "ExpertAssignment" (
    "id"            TEXT            NOT NULL,
    "requestId"     TEXT            NOT NULL,
    "expertName"    TEXT            NOT NULL,
    "expertOrg"     TEXT,
    "expertTitle"   TEXT,
    "expertField"   TEXT,
    "expertPhone"   TEXT,
    "expertEmail"   TEXT,
    "confirmStatus" TEXT            NOT NULL DEFAULT 'PENDING',
    "replacedById"  TEXT,
    "appUserId"     TEXT,
    "note"          TEXT,
    "createdAt"     TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMPTZ(3)  NOT NULL,

    CONSTRAINT "ExpertAssignment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExpertAssignment_requestId_confirmStatus_idx" ON "ExpertAssignment"("requestId", "confirmStatus");

ALTER TABLE "ExpertAssignment"
    ADD CONSTRAINT "ExpertAssignment_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "ExpertVoteRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ExpertVoteRecord 投票记录
CREATE TABLE "ExpertVoteRecord" (
    "id"                     TEXT            NOT NULL,
    "requestId"              TEXT            NOT NULL,
    "assignmentId"           TEXT            NOT NULL,
    "voteResult"             TEXT            NOT NULL,
    "reviewOpinion"          TEXT            NOT NULL,
    "modificationSuggestion" TEXT,
    "riskWarning"            TEXT,
    "agreeConclusion"        TEXT            NOT NULL,
    "submittedBy"            TEXT,
    "submittedByMode"        TEXT            NOT NULL DEFAULT 'ADMIN_PROXY',
    "confirmFlag"            BOOLEAN         NOT NULL DEFAULT false,
    "clientIp"               TEXT,
    "clientUa"               TEXT,
    "submittedAt"            TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpertVoteRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExpertVoteRecord_assignmentId_key" ON "ExpertVoteRecord"("assignmentId");
CREATE INDEX "ExpertVoteRecord_requestId_idx"           ON "ExpertVoteRecord"("requestId");

ALTER TABLE "ExpertVoteRecord"
    ADD CONSTRAINT "ExpertVoteRecord_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "ExpertVoteRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExpertVoteRecord"
    ADD CONSTRAINT "ExpertVoteRecord_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "ExpertAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ExpertVoteSignLog 签章审计
CREATE TABLE "ExpertVoteSignLog" (
    "id"          TEXT            NOT NULL,
    "requestId"   TEXT            NOT NULL,
    "action"      TEXT            NOT NULL,
    "operatorId"  TEXT            NOT NULL,
    "payloadJson" TEXT,
    "createdAt"   TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpertVoteSignLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExpertVoteSignLog_requestId_action_idx" ON "ExpertVoteSignLog"("requestId", "action");

ALTER TABLE "ExpertVoteSignLog"
    ADD CONSTRAINT "ExpertVoteSignLog_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "ExpertVoteRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
