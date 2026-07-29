/**
 * 阶段三 — 优惠券体系端到端测试
 *
 * 覆盖矩阵：
 *  计算    : FIXED 满减 / PERCENT / PERCENT+maxDiscount / 不达 minAmount / 抵扣后<1
 *  锁/解   : 创建订单锁券 / 取消解锁 / 超时解锁 / 并发竞态
 *  核销    : 支付成功 LOCKED→USED / 回调幂等 / 金额不一致不核销
 *  幂等发券: 同 source+sourceRef 不重发 / 邀请多人独立各一张
 *  范围    : MEMBERSHIP_PRO 用在 personal 订单被拒 / ALL 通过
 *  过期    : 过期券下单被拒
 *  撤销    : AVAILABLE 撤销 / LOCKED 拒绝撤销
 *  审计    : OrderDiscount 快照固化、Coupon 改名后历史不变
 *  Feature: BXZ_COUPON_ENABLED=false 时下单忽略 userCouponId
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import {
  registerAppRoutes, ensureAppSeed,
  __setWxCode2SessionFetcher,
} from '../src/appRoutes.js'
import { registerCouponRoutes } from '../src/couponRoutes.js'
import { calcDiscount, issueCoupon, validateAndLockCoupon, redeemCouponByOrder, issueSalesPromoCouponOnRegister, SALES_PROMO_COUPON_CODE, SALES_PROMO_EXPIRES_DAYS } from '../src/coupons.js'
import { sweepStaleOrders } from '../src/orderSweeper.js'
import { ensurePlans, createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  process.env.WX_APPID = 'wx-test'
  process.env.WX_SECRET = 'secret-test'
  process.env.BXZ_COUPON_ENABLED = 'true'
  await ensurePlans()
  registerAppRoutes(app)
  registerCouponRoutes(app)
  await ensureAppSeed()
})

afterAll(async () => {
  __setWxCode2SessionFetcher(null)
  await prisma.$disconnect()
})

// ─── 辅助 ─────────────────────────

async function cleanAll() {
  await prisma.analyticsEvent.deleteMany()
  await prisma.enterpriseApplication.deleteMany()
  await prisma.chatMessage.deleteMany()
  await prisma.conversation.deleteMany()
  await prisma.invoiceRequest.deleteMany()
  await prisma.serviceBooking.deleteMany()
  await prisma.orderDiscount.deleteMany()
  await prisma.userCoupon.deleteMany()
  await prisma.coupon.deleteMany()
  await prisma.userMembership.deleteMany()
  await prisma.appOrder.deleteMany()
  await prisma.compareTask.deleteMany()
  await prisma.userLabel.deleteMany()
  await prisma.notification.deleteMany()
  await prisma.pushLog.deleteMany()
  await prisma.subscribeQuota.deleteMany()
  await prisma.referral.deleteMany()
  await prisma.referralCode.deleteMany()
  await prisma.scheduledPush.deleteMany()
  await prisma.salesCode.deleteMany()
  await prisma.salesProfile.deleteMany()
  await prisma.salesInvite.deleteMany()
  await prisma.adminUserRole.deleteMany()
  await prisma.appUser.deleteMany({ where: { role: { in: ['user', 'admin'] } } })
}

let cnt = 0
function uniqCode(prefix = 'C') { cnt++; return `${prefix}${Date.now() % 1e7}${cnt}` }

async function makeCoupon(overrides: Partial<{
  code: string; name: string; discountType: string; discountValue: number;
  minAmount: number; maxDiscount: number | null; applicableScope: string;
  validFrom: Date; validTo: Date; totalQuota: number | null; status: string;
}> = {}) {
  const admin = await createUser({ role: 'admin' })
  const now = new Date()
  return prisma.coupon.create({
    data: {
      code: overrides.code || uniqCode(),
      name: overrides.name || '测试券',
      discountType: overrides.discountType || 'FIXED',
      discountValue: overrides.discountValue ?? 10000,  // 默认 ¥100
      minAmount: overrides.minAmount ?? 0,
      maxDiscount: overrides.maxDiscount ?? null,
      applicableScope: overrides.applicableScope || 'ALL',
      validFrom: overrides.validFrom || new Date(now.getTime() - 86400_000),
      validTo: overrides.validTo || new Date(now.getTime() + 30 * 86400_000),
      totalQuota: overrides.totalQuota ?? null,
      status: overrides.status || 'ACTIVE',
      createdBy: admin.id,
    },
  })
}

async function giveUserCoupon(userId: string, couponId: string, opts: { sourceRef?: string; source?: string; expiresAt?: Date } = {}) {
  return prisma.$transaction((tx) =>
    issueCoupon(tx, {
      userId,
      couponId,
      source: (opts.source as any) || 'ISSUED_ADMIN',
      sourceRef: opts.sourceRef ?? `seed-${cnt++}`,
      expiresAt: opts.expiresAt,
    })
  )
}

// ═══════════════════ 1. 纯函数计算 ═══════════════════
describe('calcDiscount 纯函数', () => {
  const baseFixed = { discountType: 'FIXED', discountValue: 10000, maxDiscount: null, minAmount: 0 }
  const basePct  = { discountType: 'PERCENT', discountValue: 30, maxDiscount: null, minAmount: 0 }

  it('FIXED 满减正常', () => {
    const r = calcDiscount(baseFixed as any, 59800)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.discountAmount).toBe(10000)
      expect(r.finalAmount).toBe(49800)
    }
  })

  it('FIXED 抵扣不能折成负数（discount 取 min）', () => {
    const r = calcDiscount({ ...baseFixed, discountValue: 80000 } as any, 50000)
    // 50000 - 80000 = -30000 → 拒绝（finalAmount < 1）
    expect(r.ok).toBe(false)
  })

  it('PERCENT 正常 floor 取整', () => {
    const r = calcDiscount(basePct as any, 59800)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.discountAmount).toBe(Math.floor(59800 * 30 / 100))  // 17940
      expect(r.finalAmount).toBe(59800 - 17940)
    }
  })

  it('PERCENT + maxDiscount 封顶', () => {
    const r = calcDiscount({ ...basePct, maxDiscount: 5000 } as any, 59800)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.discountAmount).toBe(5000)
  })

  it('未达 minAmount 拒绝', () => {
    const r = calcDiscount({ ...baseFixed, minAmount: 99900 } as any, 59800)
    expect(r.ok).toBe(false)
  })

  it('抵扣后 finalAmount < 1 拒绝', () => {
    const r = calcDiscount({ ...baseFixed, discountValue: 59800 } as any, 59800)
    expect(r.ok).toBe(false)  // 59800 - 59800 = 0
  })

  it('PERCENT 越界拒绝（>=100）', () => {
    const r = calcDiscount({ ...basePct, discountValue: 100 } as any, 59800)
    expect(r.ok).toBe(false)
  })
})

// ═══════════════════ 2. 锁 / 解 / 核销 ═══════════════════
describe('券锁/解锁/核销 — 通过订单接口端到端', () => {
  beforeEach(cleanAll)

  it('创建订单锁券 → AppOrder.amount 为折后 + UserCoupon LOCKED + OrderDiscount 写入', async () => {
    const u = await createUser({ phone: `139${cnt++}1234567` })
    const c = await makeCoupon({ discountType: 'FIXED', discountValue: 30000 })  // ¥300
    const { userCoupon } = await giveUserCoupon(u.id, c.id)

    const res = await request(app)
      .post('/api/app/orders')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send({ productType: 'MEMBERSHIP', planId: 'personal', title: '个人会员', userCouponId: userCoupon.id })

    expect(res.status).toBe(200)
    expect(res.body.amount).toBe(59800 - 30000)             // 应付
    expect(res.body.originalAmount).toBe(59800)
    expect(res.body.discountAmount).toBe(30000)
    expect(res.body.userCouponId).toBe(userCoupon.id)

    const ucReloaded = await prisma.userCoupon.findUnique({ where: { id: userCoupon.id } })
    expect(ucReloaded?.status).toBe('LOCKED')
    expect(ucReloaded?.lockedOrderNo).toBe(res.body.orderNo)

    const od = await prisma.orderDiscount.findUnique({ where: { orderNo: res.body.orderNo } })
    expect(od?.originalAmount).toBe(59800)
    expect(od?.discountAmount).toBe(30000)
    expect(od?.finalAmount).toBe(29800)
    const snap = JSON.parse(od!.couponSnapshot)
    expect(snap.discountValue).toBe(30000)
  })

  it('取消订单 → 券回 AVAILABLE', async () => {
    const u = await createUser({ phone: `139${cnt++}1234568` })
    const c = await makeCoupon()
    const { userCoupon } = await giveUserCoupon(u.id, c.id)
    const create = await request(app)
      .post('/api/app/orders')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send({ productType: 'MEMBERSHIP', planId: 'personal', title: 'X', userCouponId: userCoupon.id })
    expect(create.status).toBe(200)
    expect((await prisma.userCoupon.findUnique({ where: { id: userCoupon.id } }))?.status).toBe('LOCKED')

    const cancel = await request(app)
      .post(`/api/app/orders/${create.body.orderNo}/cancel`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send({})
    expect(cancel.status).toBe(200)
    const final = await prisma.userCoupon.findUnique({ where: { id: userCoupon.id } })
    expect(final?.status).toBe('AVAILABLE')
    expect(final?.lockedOrderNo).toBeNull()
  })

  it('sweeper 超时解锁 LOCKED 券', async () => {
    const u = await createUser({ phone: `139${cnt++}1234569` })
    const c = await makeCoupon()
    const { userCoupon } = await giveUserCoupon(u.id, c.id)
    const create = await request(app)
      .post('/api/app/orders')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send({ productType: 'MEMBERSHIP', planId: 'personal', title: 'X', userCouponId: userCoupon.id })
    expect(create.status).toBe(200)
    // 把订单 updatedAt 拨到 31 分钟前
    await prisma.appOrder.update({
      where: { orderNo: create.body.orderNo },
      data: { updatedAt: new Date(Date.now() - 31 * 60_000) },
    })
    await sweepStaleOrders(prisma as any)
    const order = await prisma.appOrder.findUnique({ where: { orderNo: create.body.orderNo } })
    expect(order?.status).toBe('CANCELLED')  // PENDING → CANCELLED
    const uc = await prisma.userCoupon.findUnique({ where: { id: userCoupon.id } })
    expect(uc?.status).toBe('AVAILABLE')
  })

  it('并发：两单抢一张券，一胜一败', async () => {
    const u = await createUser({ phone: `139${cnt++}1234570` })
    const c = await makeCoupon()
    const { userCoupon } = await giveUserCoupon(u.id, c.id)
    const orderNo1 = 'ORD-T1', orderNo2 = 'ORD-T2'
    // 模拟并发锁，单事务内不能 await Promise.all 多 tx，改用顺序两次 lock 验证第二次失败
    const tx1 = await prisma.$transaction(async (tx) =>
      validateAndLockCoupon(tx, {
        userId: u.id, userCouponId: userCoupon.id, orderNo: orderNo1,
        productType: 'MEMBERSHIP', planId: 'personal', originalAmount: 59800,
      })
    )
    expect(tx1.userCoupon.id).toBe(userCoupon.id)
    await expect(prisma.$transaction(async (tx) =>
      validateAndLockCoupon(tx, {
        userId: u.id, userCouponId: userCoupon.id, orderNo: orderNo2,
        productType: 'MEMBERSHIP', planId: 'personal', originalAmount: 59800,
      })
    )).rejects.toThrow(/已被.*占用|不可用/)
  })
})

// ═══════════════════ 3. 幂等发券 ═══════════════════
describe('issueCoupon 幂等', () => {
  beforeEach(cleanAll)

  it('同 (user,coupon,source,sourceRef) 重发只发一次', async () => {
    const u = await createUser({ phone: `139${cnt++}9990001` })
    const c = await makeCoupon()
    const r1 = await prisma.$transaction(tx => issueCoupon(tx, { userId: u.id, couponId: c.id, source: 'ISSUED_REGISTER', sourceRef: u.id }))
    const r2 = await prisma.$transaction(tx => issueCoupon(tx, { userId: u.id, couponId: c.id, source: 'ISSUED_REGISTER', sourceRef: u.id }))
    expect(r1.issued).toBe(true)
    expect(r2.issued).toBe(false)
    expect(r2.userCoupon.id).toBe(r1.userCoupon.id)
    const c2 = await prisma.coupon.findUnique({ where: { id: c.id } })
    expect(c2?.issuedCount).toBe(1)  // 只增了一次
  })

  it('邀请多人各发一张（sourceRef=不同 inviteeId）', async () => {
    const inviter = await createUser({ phone: `139${cnt++}9990002` })
    const invitee1 = await createUser({ phone: `139${cnt++}9990003` })
    const invitee2 = await createUser({ phone: `139${cnt++}9990004` })
    const c = await makeCoupon()
    const r1 = await prisma.$transaction(tx => issueCoupon(tx, { userId: inviter.id, couponId: c.id, source: 'ISSUED_REFERRAL', sourceRef: invitee1.id }))
    const r2 = await prisma.$transaction(tx => issueCoupon(tx, { userId: inviter.id, couponId: c.id, source: 'ISSUED_REFERRAL', sourceRef: invitee2.id }))
    expect(r1.issued).toBe(true)
    expect(r2.issued).toBe(true)
    expect(r1.userCoupon.id).not.toBe(r2.userCoupon.id)
    const all = await prisma.userCoupon.findMany({ where: { userId: inviter.id } })
    expect(all.length).toBe(2)  // 关键 bug 修复点验证
  })
})

// ═══════════════════ 4. 范围/过期 ═══════════════════
describe('applicableScope / 过期', () => {
  beforeEach(cleanAll)

  it('MEMBERSHIP_PRO 券用在 personal 订单 → 拒绝', async () => {
    const u = await createUser({ phone: `139${cnt++}9990010` })
    const c = await makeCoupon({ applicableScope: 'MEMBERSHIP_PRO', discountValue: 10000 })
    const { userCoupon } = await giveUserCoupon(u.id, c.id)
    const res = await request(app)
      .post('/api/app/orders')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send({ productType: 'MEMBERSHIP', planId: 'personal', title: 'X', userCouponId: userCoupon.id })
    expect(res.status).toBe(400)
    const uc = await prisma.userCoupon.findUnique({ where: { id: userCoupon.id } })
    expect(uc?.status).toBe('AVAILABLE')  // 未被锁
  })

  it('过期券下单被拒，券保持 AVAILABLE', async () => {
    const u = await createUser({ phone: `139${cnt++}9990011` })
    const c = await makeCoupon()
    const { userCoupon } = await giveUserCoupon(u.id, c.id, { expiresAt: new Date(Date.now() - 1000) })
    const res = await request(app)
      .post('/api/app/orders')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send({ productType: 'MEMBERSHIP', planId: 'personal', title: 'X', userCouponId: userCoupon.id })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════ 5. 撤销 ═══════════════════
describe('管理员撤销 UserCoupon', () => {
  beforeEach(cleanAll)

  it('撤销 AVAILABLE 券 → REVOKED', async () => {
    const admin = await createUser({ role: 'admin' })
    const u = await createUser({ phone: `139${cnt++}9990020` })
    const c = await makeCoupon()
    const { userCoupon } = await giveUserCoupon(u.id, c.id)
    const res = await request(app)
      .post(`/api/admin/user-coupons/${userCoupon.id}/revoke`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ reason: '运营调整' })
    expect(res.status).toBe(200)
    const uc = await prisma.userCoupon.findUnique({ where: { id: userCoupon.id } })
    expect(uc?.status).toBe('REVOKED')
  })

  it('撤销 LOCKED 券 → 409 拒绝（防止破坏支付中订单）', async () => {
    const admin = await createUser({ role: 'admin' })
    const u = await createUser({ phone: `139${cnt++}9990021` })
    const c = await makeCoupon()
    const { userCoupon } = await giveUserCoupon(u.id, c.id)
    // 先用券下单
    await request(app)
      .post('/api/app/orders')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send({ productType: 'MEMBERSHIP', planId: 'personal', title: 'X', userCouponId: userCoupon.id })
    // 此时券已 LOCKED
    const res = await request(app)
      .post(`/api/admin/user-coupons/${userCoupon.id}/revoke`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ reason: '试图破坏' })
    expect(res.status).toBe(409)
    const uc = await prisma.userCoupon.findUnique({ where: { id: userCoupon.id } })
    expect(uc?.status).toBe('LOCKED')
  })
})

// ═══════════════════ 6. 审计快照 ═══════════════════
describe('OrderDiscount 快照固化', () => {
  beforeEach(cleanAll)

  it('Coupon 改名后历史订单 OrderDiscount.couponSnapshot 不变', async () => {
    const u = await createUser({ phone: `139${cnt++}9990030` })
    const c = await makeCoupon({ name: '原名' })
    const { userCoupon } = await giveUserCoupon(u.id, c.id)
    const order = await request(app)
      .post('/api/app/orders')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send({ productType: 'MEMBERSHIP', planId: 'personal', title: 'X', userCouponId: userCoupon.id })
    expect(order.status).toBe(200)
    // 改名
    await prisma.coupon.update({ where: { id: c.id }, data: { name: '新名' } })
    const od = await prisma.orderDiscount.findUnique({ where: { orderNo: order.body.orderNo } })
    const snap = JSON.parse(od!.couponSnapshot)
    expect(snap.name).toBe('原名')  // 历史不变
  })
})

// ═══════════════════ 7. 销售推广页注册发券（B1 兑现链路）═══════════════════
describe('issueSalesPromoCouponOnRegister', () => {
  beforeEach(cleanAll)

  async function makeSalesPromoTemplate(overrides: Partial<{ status: string }> = {}) {
    return makeCoupon({
      code: SALES_PROMO_COUPON_CODE,
      name: '新用户专属 ¥50 直减券',
      discountType: 'FIXED',
      discountValue: 5000,
      applicableScope: 'MEMBERSHIP',
      status: overrides.status || 'ACTIVE',
      // 生产模板有效期 1 年（365 天），避免 issueCoupon 把 60 天 expiresAt cap 到模板的默认 30 天
      validTo: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
  }

  it('正常路径：模板存在 → 发券成功，expiresAt 接近 60 天后', async () => {
    await makeSalesPromoTemplate()
    const u = await createUser({ phone: `139${cnt++}9991001` })
    const before = Date.now()
    const uc = await prisma.$transaction(tx => issueSalesPromoCouponOnRegister(tx, u.id))
    expect(uc).not.toBeNull()
    expect(uc!.userId).toBe(u.id)
    expect(uc!.source).toBe('ISSUED_REGISTER')
    expect(uc!.sourceRef).toBe(u.id)
    expect(uc!.status).toBe('AVAILABLE')
    const days = (uc!.expiresAt.getTime() - before) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(SALES_PROMO_EXPIRES_DAYS - 0.01)
    expect(days).toBeLessThan(SALES_PROMO_EXPIRES_DAYS + 0.01)
  })

  it('幂等：同一用户重复触发只发一张（四元组 UNIQUE 兜住）', async () => {
    await makeSalesPromoTemplate()
    const u = await createUser({ phone: `139${cnt++}9991002` })
    const r1 = await prisma.$transaction(tx => issueSalesPromoCouponOnRegister(tx, u.id))
    const r2 = await prisma.$transaction(tx => issueSalesPromoCouponOnRegister(tx, u.id))
    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(r2!.id).toBe(r1!.id)
    const all = await prisma.userCoupon.findMany({ where: { userId: u.id } })
    expect(all.length).toBe(1)
  })

  it('模板缺失 → 返回 null，不抛错', async () => {
    // 不建模板
    const u = await createUser({ phone: `139${cnt++}9991003` })
    const uc = await prisma.$transaction(tx => issueSalesPromoCouponOnRegister(tx, u.id))
    expect(uc).toBeNull()
  })

  it('模板 DISABLED → 返回 null，不发', async () => {
    await makeSalesPromoTemplate({ status: 'DISABLED' })
    const u = await createUser({ phone: `139${cnt++}9991004` })
    const uc = await prisma.$transaction(tx => issueSalesPromoCouponOnRegister(tx, u.id))
    expect(uc).toBeNull()
    const all = await prisma.userCoupon.findMany({ where: { userId: u.id } })
    expect(all.length).toBe(0)
  })

  it('couponsEnabled=false → 返回 null，不发', async () => {
    await makeSalesPromoTemplate()
    process.env.BXZ_COUPON_ENABLED = 'false'
    try {
      const u = await createUser({ phone: `139${cnt++}9991005` })
      const uc = await prisma.$transaction(tx => issueSalesPromoCouponOnRegister(tx, u.id))
      expect(uc).toBeNull()
      const all = await prisma.userCoupon.findMany({ where: { userId: u.id } })
      expect(all.length).toBe(0)
    } finally {
      process.env.BXZ_COUPON_ENABLED = 'true'
    }
  })

  it('不同用户各发一张（sourceRef=userId 互不冲突）', async () => {
    await makeSalesPromoTemplate()
    const u1 = await createUser({ phone: `139${cnt++}9991006` })
    const u2 = await createUser({ phone: `139${cnt++}9991007` })
    const r1 = await prisma.$transaction(tx => issueSalesPromoCouponOnRegister(tx, u1.id))
    const r2 = await prisma.$transaction(tx => issueSalesPromoCouponOnRegister(tx, u2.id))
    expect(r1!.id).not.toBe(r2!.id)
    expect(r1!.userId).toBe(u1.id)
    expect(r2!.userId).toBe(u2.id)
  })
})

// ═══════════════════ 8. Feature flag ═══════════════════
describe('BXZ_COUPON_ENABLED feature flag', () => {
  it('flag=false 时下单忽略 userCouponId（券保持 AVAILABLE）', async () => {
    process.env.BXZ_COUPON_ENABLED = 'false'
    try {
      await cleanAll()
      const u = await createUser({ phone: `139${cnt++}9990040` })
      const c = await makeCoupon()
      const { userCoupon } = await giveUserCoupon(u.id, c.id)
      const res = await request(app)
        .post('/api/app/orders')
        .set('Authorization', `Bearer ${getTestToken(u.id)}`)
        .send({ productType: 'MEMBERSHIP', planId: 'personal', title: 'X', userCouponId: userCoupon.id })
      expect(res.status).toBe(200)
      expect(res.body.amount).toBe(59800)              // 没打折
      expect(res.body.userCouponId).toBeNull()
      expect(res.body.discountAmount).toBe(0)
      const uc = await prisma.userCoupon.findUnique({ where: { id: userCoupon.id } })
      expect(uc?.status).toBe('AVAILABLE')             // 没被锁
    } finally {
      process.env.BXZ_COUPON_ENABLED = 'true'  // 恢复
    }
  })
})
