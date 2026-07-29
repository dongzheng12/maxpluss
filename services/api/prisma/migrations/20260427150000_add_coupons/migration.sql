-- 阶段三：优惠券体系
-- 三表（Coupon / UserCoupon / OrderDiscount）+ AppOrder 增 3 字段
-- 关键不变性：AppOrder.amount 仍是"应付金额"=微信下单 amount.total=回调 notification.amountCents
--   originalAmount/discountAmount/userCouponId 是审计辅助字段，不参与微信支付链路
-- 关键幂等：UserCoupon 四元组 UNIQUE (userId,couponId,source,sourceRef) 防注册并发重发 + 邀请多人独立兜住

-- ─── Coupon：优惠券模板 ─────────────────────────────────────
CREATE TABLE "Coupon" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "discountType" TEXT NOT NULL,                      -- FIXED | PERCENT
  "discountValue" INTEGER NOT NULL,                  -- FIXED:分；PERCENT:1-99
  "minAmount" INTEGER NOT NULL DEFAULT 0,
  "maxDiscount" INTEGER,                              -- PERCENT 封顶（分）
  "applicableScope" TEXT NOT NULL DEFAULT 'ALL',     -- ALL|MEMBERSHIP|MEMBERSHIP_PERSONAL|MEMBERSHIP_PRO|STANDARD
  "validFrom" DATETIME NOT NULL,
  "validTo" DATETIME NOT NULL,
  "totalQuota" INTEGER,                               -- null = 无限
  "issuedCount" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',           -- ACTIVE | DISABLED
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");
CREATE INDEX "Coupon_status_validTo_idx" ON "Coupon"("status", "validTo");
CREATE INDEX "Coupon_code_idx" ON "Coupon"("code");

-- ─── UserCoupon：用户已领的具体券 ─────────────────────────
CREATE TABLE "UserCoupon" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "couponId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'AVAILABLE',        -- AVAILABLE|LOCKED|USED|EXPIRED|REVOKED
  "source" TEXT NOT NULL,                             -- ISSUED_REGISTER|ISSUED_REFERRAL|ISSUED_ADMIN|ISSUED_CAMPAIGN
  "sourceRef" TEXT,
  "issuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "lockedOrderNo" TEXT,
  "lockedAt" DATETIME,
  "usedAt" DATETIME,
  "usedOrderNo" TEXT,
  "revokedAt" DATETIME,
  "revokedBy" TEXT,
  "revokeReason" TEXT,
  CONSTRAINT "UserCoupon_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "UserCoupon_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- 四元组唯一：发券路径全部用 sourceRef 区分，邀请多人各发一张不冲突
CREATE UNIQUE INDEX "UserCoupon_userId_couponId_source_sourceRef_key" ON "UserCoupon"("userId", "couponId", "source", "sourceRef");
CREATE INDEX "UserCoupon_userId_status_idx" ON "UserCoupon"("userId", "status");
CREATE INDEX "UserCoupon_status_expiresAt_idx" ON "UserCoupon"("status", "expiresAt");
CREATE INDEX "UserCoupon_lockedOrderNo_idx" ON "UserCoupon"("lockedOrderNo");

-- ─── OrderDiscount：订单优惠快照（成交后冻结，1:1 AppOrder） ─
CREATE TABLE "OrderDiscount" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderNo" TEXT NOT NULL,
  "userCouponId" TEXT NOT NULL,
  "couponSnapshot" TEXT NOT NULL,                     -- JSON
  "originalAmount" INTEGER NOT NULL,
  "discountAmount" INTEGER NOT NULL,
  "finalAmount" INTEGER NOT NULL,
  "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "OrderDiscount_orderNo_key" ON "OrderDiscount"("orderNo");
CREATE INDEX "OrderDiscount_userCouponId_idx" ON "OrderDiscount"("userCouponId");

-- ─── AppOrder：增 3 字段 + 1 索引 ─────────────────────────
-- discountAmount 必须 DEFAULT 0，老数据不能 NULL（业务读 sum/avg 时会爆）
-- originalAmount 允许 NULL，业务读取时用 ?? amount 兜底
ALTER TABLE "AppOrder" ADD COLUMN "originalAmount" INTEGER;
ALTER TABLE "AppOrder" ADD COLUMN "discountAmount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AppOrder" ADD COLUMN "userCouponId" TEXT;
CREATE INDEX "AppOrder_userCouponId_idx" ON "AppOrder"("userCouponId");
