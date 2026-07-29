/**
 * 优惠券核心模块（阶段三）
 *
 * 责任边界：
 *   - calcDiscount: 纯函数，给定原价 + 模板，返回 discountAmount/finalAmount
 *   - validateAndLock: 选券下单时调用，事务内原子锁券（AVAILABLE → LOCKED）
 *   - unlock: 取消订单 / 超时关单时调用，原子解锁（LOCKED → AVAILABLE）
 *   - redeem: 支付成功回调时调用，事务内原子核销（LOCKED → USED）
 *   - issueCoupon: 发券统一入口，四元组幂等
 *
 * 关键不变性：
 *   - finalAmount >= 1（不允许 0 元订单走支付链路）
 *   - 整数（分）运算，禁用 float
 *   - 任何状态变更都用 updateMany + check affected.count 保证并发安全
 */
import type { Prisma, Coupon, UserCoupon } from '@prisma/client'

type TxClient = Prisma.TransactionClient

export type DiscountCalcResult = {
  ok: true
  originalAmount: number
  discountAmount: number
  finalAmount: number
} | {
  ok: false
  reason: string
}

/** 商品类型 → 适用 scope 集合的命中判断 */
function scopeMatches(scope: string, productType: string, planId: string | null | undefined): boolean {
  // 专家评审投票订单第一版不支持优惠券（按专家数计费，与 ALL 抵扣语义不兼容）
  // 显式拦截在 ALL 命中之前，否则 ALL 券会绕过本规则
  if (productType === 'EXPERT_VOTE') return false
  if (scope === 'ALL') return true
  if (scope === 'MEMBERSHIP') return productType === 'MEMBERSHIP'
  if (scope === 'MEMBERSHIP_PERSONAL') return productType === 'MEMBERSHIP' && planId === 'personal'
  if (scope === 'MEMBERSHIP_PRO') return productType === 'MEMBERSHIP' && planId === 'pro'
  if (scope === 'STANDARD') return productType === 'STANDARD_PREVIEW' || productType === 'STANDARD_DOWNLOAD'
  return false
}

/**
 * 纯函数：根据券模板与原价计算抵扣
 * - FIXED: discountAmount = min(discountValue, originalAmount)
 * - PERCENT: floor(originalAmount * discountValue / 100)，可选 maxDiscount 封顶
 * 不会校验时间/状态/scope，调用方自己先校验。
 */
export function calcDiscount(coupon: Pick<Coupon, 'discountType' | 'discountValue' | 'maxDiscount' | 'minAmount'>, originalAmount: number): DiscountCalcResult {
  if (originalAmount < coupon.minAmount) {
    return { ok: false, reason: `订单金额未达到 ${coupon.minAmount} 分门槛` }
  }
  let discountAmount = 0
  if (coupon.discountType === 'FIXED') {
    discountAmount = Math.min(coupon.discountValue, originalAmount)
  } else if (coupon.discountType === 'PERCENT') {
    if (coupon.discountValue < 1 || coupon.discountValue > 99) {
      return { ok: false, reason: '券折扣值非法（需 1-99）' }
    }
    // floor 到整分：原价 × 折扣百分比
    discountAmount = Math.floor((originalAmount * coupon.discountValue) / 100)
    if (coupon.maxDiscount != null && discountAmount > coupon.maxDiscount) {
      discountAmount = coupon.maxDiscount
    }
  } else {
    return { ok: false, reason: `不支持的 discountType: ${coupon.discountType}` }
  }
  const finalAmount = originalAmount - discountAmount
  if (finalAmount < 1) {
    return { ok: false, reason: '抵扣后应付金额必须 >= 1 分' }
  }
  return { ok: true, originalAmount, discountAmount, finalAmount }
}

/**
 * 校验 + 锁券：必须在事务内调用
 * 成功：返回 { coupon, userCoupon, calc }，UserCoupon 已置 LOCKED
 * 失败：抛 Error，事务由调用方回滚
 */
export async function validateAndLockCoupon(
  tx: TxClient,
  params: {
    userId: string
    userCouponId: string
    orderNo: string
    productType: string
    planId: string | null | undefined
    originalAmount: number
  },
): Promise<{ coupon: Coupon; userCoupon: UserCoupon; discountAmount: number; finalAmount: number }> {
  const uc = await tx.userCoupon.findUnique({ where: { id: params.userCouponId } })
  if (!uc) throw new Error('优惠券不存在')
  if (uc.userId !== params.userId) throw new Error('无权使用该优惠券')
  if (uc.status !== 'AVAILABLE') throw new Error('优惠券当前不可用')
  if (uc.expiresAt.getTime() <= Date.now()) throw new Error('优惠券已过期')

  const coupon = await tx.coupon.findUnique({ where: { id: uc.couponId } })
  if (!coupon) throw new Error('优惠券模板不存在')
  if (coupon.status !== 'ACTIVE') throw new Error('优惠券已下线')
  if (coupon.validTo.getTime() <= Date.now()) throw new Error('优惠券模板已过期')
  if (!scopeMatches(coupon.applicableScope, params.productType, params.planId)) {
    throw new Error('该优惠券不适用于此商品')
  }

  const calc = calcDiscount(coupon, params.originalAmount)
  if (!calc.ok) throw new Error(calc.reason)

  // 原子锁：AVAILABLE → LOCKED
  const locked = await tx.userCoupon.updateMany({
    where: { id: uc.id, status: 'AVAILABLE' },
    data: {
      status: 'LOCKED',
      lockedOrderNo: params.orderNo,
      lockedAt: new Date(),
    },
  })
  if (locked.count !== 1) throw new Error('优惠券已被其他订单占用')

  return {
    coupon,
    userCoupon: uc,
    discountAmount: calc.discountAmount,
    finalAmount: calc.finalAmount,
  }
}

/** 解锁：LOCKED → AVAILABLE（取消/超时调用，幂等） */
export async function unlockCouponByOrder(tx: TxClient, orderNo: string): Promise<void> {
  await tx.userCoupon.updateMany({
    where: { lockedOrderNo: orderNo, status: 'LOCKED' },
    data: { status: 'AVAILABLE', lockedOrderNo: null, lockedAt: null },
  })
}

/** 核销：LOCKED → USED（支付回调内调用，幂等） */
export async function redeemCouponByOrder(tx: TxClient, orderNo: string, userCouponId: string): Promise<void> {
  await tx.userCoupon.updateMany({
    where: { id: userCouponId, status: 'LOCKED', lockedOrderNo: orderNo },
    data: {
      status: 'USED',
      usedAt: new Date(),
      usedOrderNo: orderNo,
      lockedOrderNo: null,
    },
  })
}

/**
 * 序列化券模板成快照 JSON（写 OrderDiscount.couponSnapshot 用）
 * 字段固化，模板后续改动不影响历史订单审计
 */
export function snapshotCoupon(c: Coupon): string {
  return JSON.stringify({
    id: c.id,
    code: c.code,
    name: c.name,
    discountType: c.discountType,
    discountValue: c.discountValue,
    minAmount: c.minAmount,
    maxDiscount: c.maxDiscount,
    applicableScope: c.applicableScope,
  })
}

/**
 * 发券统一入口（事务内调用）
 * 四元组 UNIQUE 保证幂等：同一 (userId, couponId, source, sourceRef) 只发一张
 *
 * 返回值：
 *   - userCoupon: 新建或已存在的 UserCoupon（幂等命中时返回老的）
 *   - issued: true=本次新发 / false=已存在直接返回
 *
 * 超发策略：宽松版。totalQuota 在事务里 increment，并发极端下可能超 ±1-2 张（业务可接受）
 */
export async function issueCoupon(
  tx: TxClient,
  params: {
    userId: string
    couponId: string
    source: 'ISSUED_REGISTER' | 'ISSUED_REFERRAL' | 'ISSUED_ADMIN' | 'ISSUED_CAMPAIGN'
    sourceRef: string | null
    expiresAt?: Date  // 不传则用 Coupon.validTo
  },
): Promise<{ userCoupon: UserCoupon; issued: boolean }> {
  const coupon = await tx.coupon.findUnique({ where: { id: params.couponId } })
  if (!coupon) throw new Error('优惠券模板不存在')
  if (coupon.status !== 'ACTIVE') throw new Error('优惠券模板已下线')
  if (coupon.validTo.getTime() <= Date.now()) throw new Error('优惠券模板已过期')

  // 配额（宽松版）：超 quota 拒绝（不严格防 ±1）
  if (coupon.totalQuota != null && coupon.issuedCount >= coupon.totalQuota) {
    throw new Error('优惠券模板配额已发完')
  }

  // 幂等：四元组 UNIQUE 兜底
  const existing = await tx.userCoupon.findFirst({
    where: {
      userId: params.userId,
      couponId: params.couponId,
      source: params.source,
      sourceRef: params.sourceRef ?? null,
    },
  })
  if (existing) return { userCoupon: existing, issued: false }

  const expiresAt = params.expiresAt ?? coupon.validTo
  // 这张券生命周期不能超过模板截止
  const realExpire = expiresAt.getTime() > coupon.validTo.getTime() ? coupon.validTo : expiresAt

  const created = await tx.userCoupon.create({
    data: {
      userId: params.userId,
      couponId: params.couponId,
      source: params.source,
      sourceRef: params.sourceRef ?? null,
      expiresAt: realExpire,
    },
  })
  await tx.coupon.update({
    where: { id: params.couponId },
    data: { issuedCount: { increment: 1 } },
  })
  return { userCoupon: created, issued: true }
}

/** 选券查询：返回该用户当前可用、且适用于指定商品的券（已预算抵扣） */
export async function listApplicableCoupons(
  prisma: Prisma.TransactionClient | any,
  params: {
    userId: string
    productType: string
    planId: string | null | undefined
    originalAmount: number
  },
): Promise<Array<{
  id: string
  couponId: string
  name: string
  code: string
  discountType: string
  discountValue: number
  minAmount: number
  maxDiscount: number | null
  expiresAt: Date
  calculatedDiscount: number
  applicable: boolean
  unmatchReason?: string
}>> {
  const now = new Date()
  const list = await prisma.userCoupon.findMany({
    where: {
      userId: params.userId,
      status: 'AVAILABLE',
      expiresAt: { gt: now },
    },
    include: { coupon: true },
    orderBy: { expiresAt: 'asc' },
  })
  return list.map((uc: UserCoupon & { coupon: Coupon }) => {
    const c = uc.coupon
    let applicable = true
    let unmatchReason: string | undefined
    let calculatedDiscount = 0
    if (c.status !== 'ACTIVE' || c.validTo.getTime() <= now.getTime()) {
      applicable = false; unmatchReason = '优惠券已下线或过期'
    } else if (!scopeMatches(c.applicableScope, params.productType, params.planId)) {
      applicable = false; unmatchReason = '该券不适用此商品'
    } else {
      const calc = calcDiscount(c, params.originalAmount)
      if (!calc.ok) { applicable = false; unmatchReason = calc.reason }
      else calculatedDiscount = calc.discountAmount
    }
    return {
      id: uc.id,
      couponId: c.id,
      name: c.name,
      code: c.code,
      discountType: c.discountType,
      discountValue: c.discountValue,
      minAmount: c.minAmount,
      maxDiscount: c.maxDiscount,
      expiresAt: uc.expiresAt,
      calculatedDiscount,
      applicable,
      unmatchReason,
    }
  })
}

/** Feature flag：BXZ_COUPON_ENABLED=false（默认）禁用所有优惠券业务 */
export function couponsEnabled(): boolean {
  return process.env.BXZ_COUPON_ENABLED === 'true'
}

// ─── 销售推广页注册发券（阶段三 B1）───────────────────────
// 文案承诺：销售推广页注册即可获得 ¥50 直减券（60 天有效）
// 触发条件由调用方控制：必须 attributedSalesCode 命中 + 首次创建用户 + 无 inviteCode
export const SALES_PROMO_COUPON_CODE = 'NEW_USER_50'
export const SALES_PROMO_EXPIRES_DAYS = 60

/**
 * 销售推广页注册发券（事务内调用）
 * 静默策略：couponsEnabled=false / 模板缺失 / 模板 DISABLED → return null，不抛错
 * 幂等：source='ISSUED_REGISTER', sourceRef=userId 四元组 UNIQUE 兜住
 * 失败语义：调用方必须 try/catch；本函数对模板异常返回 null，对 DB 异常透传抛出
 */
export async function issueSalesPromoCouponOnRegister(
  tx: TxClient,
  userId: string,
): Promise<UserCoupon | null> {
  if (!couponsEnabled()) return null
  const tmpl = await tx.coupon.findUnique({ where: { code: SALES_PROMO_COUPON_CODE } })
  if (!tmpl || tmpl.status !== 'ACTIVE') return null
  const expiresAt = new Date(Date.now() + SALES_PROMO_EXPIRES_DAYS * 24 * 60 * 60 * 1000)
  const r = await issueCoupon(tx, {
    userId,
    couponId: tmpl.id,
    source: 'ISSUED_REGISTER',
    sourceRef: userId,
    expiresAt,
  })
  return r.userCoupon
}
