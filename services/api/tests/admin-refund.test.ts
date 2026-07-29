/**
 * 管理员退款接口测试
 * 路由：POST /api/admin/orders/:orderNo/refund
 * 覆盖锁定项（必读/MEMORY.md「业务规则」+「退款 / 协议 / 联系客服」）：
 *   - 用户退款接口已关闭，统一返回 403
 *   - 管理员仅 PAID 订单可退；非 PAID 一律 400
 *   - executeRefund 按 sourceRef 精确撤销 ACTIVE 会员
 *   - legacy fallback：sourceRef=null 老会员按 userId+planId 兜底
 *   - SALES_GIFT 等其它来源会员永不被误伤（精确模式 + sourceRef 隔离）
 *   - COMPARE_REPORT / COMPARE_EXPORT 退款 → 解锁状态回滚
 *   - 权限：无 token / 普通 user / sales 都 403/401
 *   - mock 模式：wechat-pay 未配置时 createRefund 走 mock 直接成功
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { _resetConfigCache } from '../src/wechat-pay.js'
import * as wechatPay from '../src/wechat-pay.js'
import { EXPERT_VOTE_REFUNDABLE_STATUSES } from '../src/services/expertVote.js'
import { createUser, getTestToken, createPaidOrder, ensurePlans, cleanAll } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  // 测试期间确保 wechat-pay 走 mock 模式（清掉 wechat env + 重置 cache）
  for (const k of [
    'WECHAT_PAY_MCH_ID', 'WECHAT_PAY_SERIAL_NO', 'WECHAT_PAY_PRIVATE_KEY',
    'WECHAT_PAY_API_V3_KEY', 'WECHAT_PAY_APPID', 'WX_APPID',
  ]) {
    delete process.env[k]
  }
  _resetConfigCache()
  await ensurePlans()
  registerAppRoutes(app)
  await ensureAppSeed()
})

beforeEach(async () => {
  await cleanAll()
  await ensurePlans()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── 工具：创建 admin / sales / user ───────────────────────

async function createAdmin() {
  const u = await createUser({ role: 'admin' })
  return { user: u, token: getTestToken(u.id, 'admin') }
}
async function createSalesUser() {
  const u = await createUser({ role: 'sales' })
  return { user: u, token: getTestToken(u.id, 'sales') }
}
async function createNormalUser() {
  const u = await createUser({ role: 'user' })
  return { user: u, token: getTestToken(u.id, 'user') }
}

// 直接建 ACTIVE 会员（控制 sourceRef 字段）
async function seedMembership(opts: {
  userId: string
  planId?: string
  sourceRef?: string | null
  source?: string
  status?: string
}) {
  const now = new Date()
  return prisma.userMembership.create({
    data: {
      userId: opts.userId,
      planId: opts.planId ?? 'personal',
      status: opts.status ?? 'ACTIVE',
      source: opts.source ?? 'PURCHASE',
      sourceRef: opts.sourceRef ?? null,
      startAt: now,
      endAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
    },
  })
}

async function seedExpertVoteOrder(opts: {
  userId: string
  status: string
  orderStatus?: string
  amount?: number
}) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
  const requestNo = `EVR-REFUND-${suffix}`
  const orderNo = `ORD-EVR-REFUND-${suffix}`
  const amount = opts.amount ?? 600000
  const order = await prisma.appOrder.create({
    data: {
      orderNo,
      userId: opts.userId,
      productType: 'EXPERT_VOTE',
      productRef: requestNo,
      title: '专家评审退款测试',
      amount,
      status: opts.orderStatus ?? 'PAID',
      paidAt: new Date(),
    },
  })
  const requestRow = await prisma.expertVoteRequest.create({
    data: {
      requestNo,
      userId: opts.userId,
      orderNo,
      status: opts.status,
      contactName: '测试申请人',
      contactPhone: '13800000000',
      projectName: '专家评审退款测试',
      targetName: '测试标准',
      projectType: '专家投票',
      standardType: '团体标准',
      standardStatus: '送审稿',
      industries: JSON.stringify(['测试行业']),
      backgroundDesc: '退款联动测试',
      expertSourceType: 'PLATFORM',
      expertCount: 3,
      unitPrice: 200000,
      totalAmount: amount,
      submittedAt: new Date(),
      paidAt: new Date(),
    },
  })
  return { order, request: requestRow, requestNo, orderNo, amount }
}

// ────────────────────────────────────────────────────────────

describe('POST /api/admin/orders/:orderNo/refund 权限拦截', () => {
  let adminToken: string
  let userToken: string
  let salesToken: string
  let order: any

  beforeEach(async () => {
    const admin = await createAdmin()
    const u = await createNormalUser()
    const s = await createSalesUser()
    adminToken = admin.token
    userToken = u.token
    salesToken = s.token
    order = await createPaidOrder(u.user.id, 'personal')
  })

  it('无 token → 401', async () => {
    const res = await request(app).post(`/api/admin/orders/${order.orderNo}/refund`).send({})
    expect(res.status).toBe(401)
  })

  it('普通 user token → 403', async () => {
    const res = await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({})
    expect(res.status).toBe(403)
  })

  it('sales token → 403', async () => {
    const res = await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({})
    expect(res.status).toBe(403)
  })

  it('admin token → 200', async () => {
    const res = await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })
})

describe('admin refund 状态机校验', () => {
  let adminToken: string
  let userId: string

  beforeEach(async () => {
    const admin = await createAdmin()
    const u = await createNormalUser()
    adminToken = admin.token
    userId = u.user.id
  })

  it('订单不存在 → 404', async () => {
    const res = await request(app)
      .post('/api/admin/orders/ORD-NOPE-NOT-EXIST/refund')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/订单不存在/)
  })

  it('PENDING 订单 → 400「只有已支付订单可退款」', async () => {
    const order = await prisma.appOrder.create({
      data: {
        orderNo: 'ORD-TEST-PENDING-1',
        userId,
        planId: 'personal',
        productType: 'MEMBERSHIP',
        title: 't',
        amount: 59800,
        status: 'PENDING',
      },
    })
    const res = await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/已支付/)
  })

  it('PAYING 订单 → 400', async () => {
    const order = await prisma.appOrder.create({
      data: {
        orderNo: 'ORD-TEST-PAYING-1', userId, planId: 'personal',
        productType: 'MEMBERSHIP', title: 't', amount: 59800, status: 'PAYING',
      },
    })
    const res = await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('CANCELLED 订单 → 400', async () => {
    const order = await prisma.appOrder.create({
      data: {
        orderNo: 'ORD-TEST-CANCEL-1', userId, planId: 'personal',
        productType: 'MEMBERSHIP', title: 't', amount: 59800, status: 'CANCELLED',
      },
    })
    const res = await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('REFUNDED 订单（已退过）→ 400 不可重复退', async () => {
    const order = await prisma.appOrder.create({
      data: {
        orderNo: 'ORD-TEST-REFUNDED-1', userId, planId: 'personal',
        productType: 'MEMBERSHIP', title: 't', amount: 59800, status: 'REFUNDED',
      },
    })
    const res = await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(res.status).toBe(400)
  })
})

describe('admin refund happy path（mock 微信退款）', () => {
  let adminToken: string
  let adminId: string
  let userId: string

  beforeEach(async () => {
    const admin = await createAdmin()
    const u = await createNormalUser()
    adminId = admin.user.id
    adminToken = admin.token
    userId = u.user.id
  })

  it('全额退款 → response 含 ok / status=REFUNDED / refundCents / mock=true', async () => {
    const order = await createPaidOrder(userId, 'personal')
    const res = await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '客户投诉退款' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      orderNo: order.orderNo,
      status: 'REFUNDED',
      refundCents: 59800,
      mock: true,
    })
    expect(res.body.refundId).toBeTruthy()
  })

  it('AppOrder 落库：status=REFUNDED + refundedAt + refundReason + payloadJson 含 refundId/refundRate=1', async () => {
    const order = await createPaidOrder(userId, 'pro')
    await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '人工干预' })
    const updated = await prisma.appOrder.findUnique({ where: { orderNo: order.orderNo } })
    expect(updated!.status).toBe('REFUNDED')
    expect(updated!.refundedAt).not.toBeNull()
    expect(updated!.refundReason).toBe('人工干预')
    const payload = JSON.parse(updated!.payloadJson || '{}')
    expect(payload.refundCents).toBe(99800)
    expect(payload.refundRate).toBe(1) // 全额
    expect(payload.refundId).toMatch(/^MOCK-REFUND-/)
    expect(payload.refundNo).toMatch(/^RF-/)
  })

  it('reason 缺省 → 默认「管理员操作退款」', async () => {
    const order = await createPaidOrder(userId, 'personal')
    await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({}) // 不传 reason
    const updated = await prisma.appOrder.findUnique({ where: { orderNo: order.orderNo } })
    expect(updated!.refundReason).toBe('管理员操作退款')
  })
})

describe('executeRefund 会员撤销 — sourceRef 精确模式', () => {
  let adminToken: string
  let userId: string

  beforeEach(async () => {
    const admin = await createAdmin()
    const u = await createNormalUser()
    adminToken = admin.token
    userId = u.user.id
  })

  it('退款 → ACTIVE 会员 (sourceRef=orderNo) → EXPIRED + revokedAt + revokedBy + revokeReason', async () => {
    const order = await createPaidOrder(userId, 'personal')
    const m = await seedMembership({ userId, planId: 'personal', sourceRef: order.orderNo })
    await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    const updated = await prisma.userMembership.findUnique({ where: { id: m.id } })
    expect(updated!.status).toBe('EXPIRED')
    expect(updated!.revokedAt).not.toBeNull()
    expect(updated!.revokedBy).toBeTruthy()
    expect(updated!.revokeReason).toMatch(/退款撤销/)
  })

  it('其他订单（不同 sourceRef）的 ACTIVE 会员不受影响', async () => {
    const order = await createPaidOrder(userId, 'personal')
    const otherOrderRef = 'ORD-OTHER-NOT-REFUNDED'
    const targetMember = await seedMembership({ userId, planId: 'personal', sourceRef: order.orderNo })
    const otherMember = await seedMembership({ userId, planId: 'personal', sourceRef: otherOrderRef })
    await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    const target = await prisma.userMembership.findUnique({ where: { id: targetMember.id } })
    const other = await prisma.userMembership.findUnique({ where: { id: otherMember.id } })
    expect(target!.status).toBe('EXPIRED')
    expect(other!.status).toBe('ACTIVE')
  })

  it('SALES_GIFT 来源会员（sourceRef ≠ orderNo）不被误伤', async () => {
    const order = await createPaidOrder(userId, 'personal')
    const giftMember = await seedMembership({
      userId, planId: 'personal',
      source: 'SALES_GIFT', sourceRef: 'GIFT_CODE_ABC',
    })
    const purchaseMember = await seedMembership({
      userId, planId: 'personal', sourceRef: order.orderNo,
    })
    await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    const gift = await prisma.userMembership.findUnique({ where: { id: giftMember.id } })
    const purchase = await prisma.userMembership.findUnique({ where: { id: purchaseMember.id } })
    expect(gift!.status).toBe('ACTIVE') // 不动
    expect(gift!.source).toBe('SALES_GIFT')
    expect(purchase!.status).toBe('EXPIRED')
  })
})

describe('executeRefund 会员撤销 — legacy fallback (sourceRef=null)', () => {
  let adminToken: string
  let userId: string

  beforeEach(async () => {
    const admin = await createAdmin()
    const u = await createNormalUser()
    adminToken = admin.token
    userId = u.user.id
  })

  it('老 ACTIVE 会员 sourceRef=null + 同 userId/planId → 兜底 EXPIRED', async () => {
    const order = await createPaidOrder(userId, 'personal')
    const legacyMember = await seedMembership({
      userId, planId: 'personal', sourceRef: null, // 2026-04-09 之前的老数据
    })
    await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    const updated = await prisma.userMembership.findUnique({ where: { id: legacyMember.id } })
    expect(updated!.status).toBe('EXPIRED')
    expect(updated!.revokeReason).toMatch(/legacy fallback/)
  })

  it('精确匹配 ≥1 命中时，legacy fallback 不触发（避免误伤其他 sourceRef=null 会员）', async () => {
    const order = await createPaidOrder(userId, 'personal')
    // 1 条精确匹配 + 1 条 legacy null 数据
    const exactMember = await seedMembership({
      userId, planId: 'personal', sourceRef: order.orderNo,
    })
    const legacyMember = await seedMembership({
      userId, planId: 'personal', sourceRef: null,
    })
    await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    const exact = await prisma.userMembership.findUnique({ where: { id: exactMember.id } })
    const legacy = await prisma.userMembership.findUnique({ where: { id: legacyMember.id } })
    expect(exact!.status).toBe('EXPIRED')
    expect(legacy!.status).toBe('ACTIVE') // 没被 fallback 误伤
  })

  it('legacy fallback：planId 必须匹配 — 不同 plan 的 sourceRef=null 会员不被撤销', async () => {
    const order = await createPaidOrder(userId, 'personal') // planId=personal
    const proMember = await seedMembership({
      userId, planId: 'pro', sourceRef: null, // 不同 plan
    })
    await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    const pro = await prisma.userMembership.findUnique({ where: { id: proMember.id } })
    expect(pro!.status).toBe('ACTIVE') // 不动
  })
})

describe('executeRefund 不同 productType — 解锁状态回滚', () => {
  let adminToken: string
  let userId: string

  beforeEach(async () => {
    const admin = await createAdmin()
    const u = await createNormalUser()
    adminToken = admin.token
    userId = u.user.id
  })

  it('COMPARE_REPORT 退款 → CompareTask.fullReportUnlockedAt 清空', async () => {
    const task = await prisma.compareTask.create({
      data: {
        taskNo: 'CMP-TEST-RPT-1',
        userId,
        documentName: 'a.docx',
        compareMode: 'LIBRARY',
        selectedStandardIds: '[]',
        status: 'COMPLETED',
        fullReportUnlockedAt: new Date(),
      },
    })
    const order = await prisma.appOrder.create({
      data: {
        orderNo: 'ORD-TEST-RPT-1', userId, planId: null,
        productType: 'COMPARE_REPORT', productRef: task.taskNo,
        title: '解锁报告', amount: 1990, status: 'PAID', paidAt: new Date(),
      },
    })
    await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    const updated = await prisma.compareTask.findUnique({ where: { taskNo: task.taskNo } })
    expect(updated!.fullReportUnlockedAt).toBeNull()
  })

  it('COMPARE_EXPORT 退款 → CompareTask.exportUnlockedAt 清空', async () => {
    const task = await prisma.compareTask.create({
      data: {
        taskNo: 'CMP-TEST-EXP-1', userId,
        documentName: 'a.docx',
        compareMode: 'LIBRARY',
        selectedStandardIds: '[]',
        status: 'COMPLETED',
        exportUnlockedAt: new Date(),
      },
    })
    const order = await prisma.appOrder.create({
      data: {
        orderNo: 'ORD-TEST-EXP-1', userId, planId: null,
        productType: 'COMPARE_EXPORT', productRef: task.taskNo,
        title: '导出', amount: 990, status: 'PAID', paidAt: new Date(),
      },
    })
    await request(app)
      .post(`/api/admin/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    const updated = await prisma.compareTask.findUnique({ where: { taskNo: task.taskNo } })
    expect(updated!.exportUnlockedAt).toBeNull()
  })
})

describe('executeRefund EXPERT_VOTE 退款联动', () => {
  let adminToken: string
  let adminId: string
  let userId: string

  beforeEach(async () => {
    const admin = await createAdmin()
    const u = await createNormalUser()
    adminId = admin.user.id
    adminToken = admin.token
    userId = u.user.id
  })

  it.each(EXPERT_VOTE_REFUNDABLE_STATUSES)('%s → REFUNDED happy path', async (status) => {
    const fixture = await seedExpertVoteOrder({ userId, status })
    const res = await request(app)
      .post(`/api/admin/orders/${fixture.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '业务协商退款' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      orderNo: fixture.orderNo,
      status: 'REFUNDED',
      refundCents: fixture.amount,
      mock: true,
    })

    const [order, requestRow, signLog, notification, auditLog] = await Promise.all([
      prisma.appOrder.findUnique({ where: { orderNo: fixture.orderNo } }),
      prisma.expertVoteRequest.findUnique({ where: { requestNo: fixture.requestNo } }),
      prisma.expertVoteSignLog.findFirst({ where: { requestId: fixture.request.id, action: 'REFUND' } }),
      prisma.notification.findFirst({ where: { userId, type: 'EXPERT_VOTE' } }),
      prisma.auditLog.findFirst({ where: { action: 'ORDER_REFUND', targetId: fixture.orderNo } }),
    ])
    expect(order!.status).toBe('REFUNDED')
    expect(order!.refundReason).toBe('业务协商退款')
    expect(requestRow!.status).toBe('REFUNDED')
    expect(notification!.body).toContain('金额 ¥6000.00 将原路退回')

    const payload = JSON.parse(signLog!.payloadJson || '{}')
    expect(payload.fromStatus).toBe(status)
    expect(payload.toStatus).toBe('REFUNDED')
    expect(payload.refundAmount).toBe(fixture.amount)
    expect(payload.operatorId).toBe(adminId)
    expect(payload.orderNo).toBe(fixture.orderNo)
    expect(payload.reason).toBe('业务协商退款')

    const audit = JSON.parse(auditLog!.diffJson || '{}')
    expect(audit).toMatchObject({
      orderNo: fixture.orderNo,
      productType: 'EXPERT_VOTE',
      refundCents: fixture.amount,
      operatorId: adminId,
      reason: '业务协商退款',
    })
    expect(audit.requestNo).toBeUndefined()
    expect(audit.projectName).toBeUndefined()
  })

  it.each(['VOTING', 'VOTED', 'SIGNING', 'COMPLETED'])('%s 退款 → 409，不调用微信退款；订单仍 PAID', async (status) => {
    const spy = vi.spyOn(wechatPay, 'createRefund')
    const fixture = await seedExpertVoteOrder({ userId, status })
    const res = await request(app)
      .post(`/api/admin/orders/${fixture.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '会议后不允许退款' })

    expect(res.status).toBe(409)
    expect(spy).not.toHaveBeenCalled()
    const [order, requestRow] = await Promise.all([
      prisma.appOrder.findUnique({ where: { orderNo: fixture.orderNo } }),
      prisma.expertVoteRequest.findUnique({ where: { requestNo: fixture.requestNo } }),
    ])
    expect(order!.status).toBe('PAID')
    expect(requestRow!.status).toBe(status)
  })

  it.each(['DRAFT', 'PAYING', 'CANCELLED', 'REFUNDED'])('%s 退款 → 409，不调用微信退款', async (status) => {
    const spy = vi.spyOn(wechatPay, 'createRefund')
    const fixture = await seedExpertVoteOrder({ userId, status })
    const res = await request(app)
      .post(`/api/admin/orders/${fixture.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '状态不允许退款' })

    expect(res.status).toBe(409)
    expect(spy).not.toHaveBeenCalled()
    const [order, requestRow] = await Promise.all([
      prisma.appOrder.findUnique({ where: { orderNo: fixture.orderNo } }),
      prisma.expertVoteRequest.findUnique({ where: { requestNo: fixture.requestNo } }),
    ])
    expect(order!.status).toBe('PAID')
    expect(requestRow!.status).toBe(status)
  })

  it('REFUNDED 订单二次退款 → 409，不重复写 SignLog / Notification', async () => {
    const fixture = await seedExpertVoteOrder({ userId, status: 'REFUNDED', orderStatus: 'REFUNDED' })
    const res = await request(app)
      .post(`/api/admin/orders/${fixture.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '二次退款' })

    expect(res.status).toBe(409)
    expect(await prisma.expertVoteSignLog.count({ where: { requestId: fixture.request.id } })).toBe(0)
    expect(await prisma.notification.count({ where: { userId } })).toBe(0)
  })

  it('无 admin.orders.refund 权限 → 403', async () => {
    const normal = await createNormalUser()
    const token = getTestToken(normal.user.id, 'user')
    const fixture = await seedExpertVoteOrder({ userId, status: 'VOTING' })
    const res = await request(app)
      .post(`/api/admin/orders/${fixture.orderNo}/refund`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: '无权限测试' })
    expect(res.status).toBe(403)
  })

  it('reason 缺失 / 仅空格 → 400，且不调微信、不写退款记录', async () => {
    const spy = vi.spyOn(wechatPay, 'createRefund')
    const missing = await seedExpertVoteOrder({ userId, status: 'VOTING' })
    const blank = await seedExpertVoteOrder({ userId, status: 'VOTING' })

    const resMissing = await request(app)
      .post(`/api/admin/orders/${missing.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    const resBlank = await request(app)
      .post(`/api/admin/orders/${blank.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: ' \n\t ' })

    expect(resMissing.status).toBe(400)
    expect(resMissing.body.error).toMatch(/请填写退款原因/)
    expect(resBlank.status).toBe(400)
    expect(resBlank.body.error).toMatch(/请填写退款原因/)
    expect(spy).not.toHaveBeenCalled()
    for (const fixture of [missing, blank]) {
      const order = await prisma.appOrder.findUnique({ where: { orderNo: fixture.orderNo } })
      expect(order!.status).toBe('PAID')
      expect(order!.refundedAt).toBeNull()
      expect(await prisma.expertVoteSignLog.count({ where: { requestId: fixture.request.id } })).toBe(0)
      expect(await prisma.auditLog.count({ where: { targetId: fixture.orderNo } })).toBe(0)
    }
  })

  it('refundCents 不等于 order.amount → 400，且不调微信', async () => {
    const spy = vi.spyOn(wechatPay, 'createRefund')
    const fixture = await seedExpertVoteOrder({ userId, status: 'VOTING' })
    const res = await request(app)
      .post(`/api/admin/orders/${fixture.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '金额错误', refundCents: 1 })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/仅支持全额退款/)
    expect(spy).not.toHaveBeenCalled()
    const order = await prisma.appOrder.findUnique({ where: { orderNo: fixture.orderNo } })
    expect(order!.status).toBe('PAID')
  })

  it('CAS 失败兜底：AppOrder 仍 REFUNDED + AuditLog + REFUND_CAS_FAILED + HTTP 500', async () => {
    const fixture = await seedExpertVoteOrder({ userId, status: 'MEETING_SCHEDULED' })
    vi.spyOn(wechatPay, 'createRefund').mockImplementation(async () => {
      await prisma.expertVoteRequest.update({
        where: { requestNo: fixture.requestNo },
        data: { status: 'VOTING' },
      })
      return { success: true, mock: true, refundId: 'MOCK-RACE-REFUND', status: 'SUCCESS' }
    })

    const res = await request(app)
      .post(`/api/admin/orders/${fixture.orderNo}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '并发漂移测试' })

    expect(res.status).toBe(500)
    expect(res.body).toMatchObject({
      error: '退款已发起但状态联动失败，请联系工程处理',
      refundId: 'MOCK-RACE-REFUND',
      requestNo: fixture.requestNo,
    })
    const [order, requestRow, auditLog, failedLog] = await Promise.all([
      prisma.appOrder.findUnique({ where: { orderNo: fixture.orderNo } }),
      prisma.expertVoteRequest.findUnique({ where: { requestNo: fixture.requestNo } }),
      prisma.auditLog.findFirst({ where: { action: 'ORDER_REFUND', targetId: fixture.orderNo } }),
      prisma.expertVoteSignLog.findFirst({ where: { requestId: fixture.request.id, action: 'REFUND_CAS_FAILED' } }),
    ])
    expect(order!.status).toBe('REFUNDED')
    expect(requestRow!.status).toBe('VOTING')
    expect(auditLog).not.toBeNull()
    const payload = JSON.parse(failedLog!.payloadJson || '{}')
    expect(payload).toMatchObject({
      wxRefundId: 'MOCK-RACE-REFUND',
      orderNo: fixture.orderNo,
      requestNo: fixture.requestNo,
      expertVoteRequestId: fixture.request.id,
      refundCents: fixture.amount,
      actualStatus: 'VOTING',
      operatorId: adminId,
      message: '钱已退但本地专家评审状态联动失败，需要人工介入。',
    })
    expect(payload.expectedRefundableStates).toEqual([...EXPERT_VOTE_REFUNDABLE_STATUSES])
  })

  it('admin orders list/detail 返回 expertVoteRequestStatus，且批量查询无 N+1', async () => {
    const fixture = await seedExpertVoteOrder({ userId, status: 'SIGNING' })
    const list = await request(app)
      .get('/api/admin/orders')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(list.status).toBe(200)
    const item = list.body.items.find((row: any) => row.orderNo === fixture.orderNo)
    expect(item.expertVoteRequestStatus).toBe('SIGNING')

    const detail = await request(app)
      .get(`/api/admin/orders/${fixture.orderNo}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(detail.status).toBe(200)
    expect(detail.body.expertVoteRequestStatus).toBe('SIGNING')
  })
})

describe('用户退款接口已关闭（对称面）', () => {
  let userToken: string
  let order: any

  beforeEach(async () => {
    const u = await createNormalUser()
    userToken = u.token
    order = await createPaidOrder(u.user.id, 'personal')
  })

  it('POST /api/app/orders/:orderNo/refund → 403 + 邮箱', async () => {
    const res = await request(app)
      .post(`/api/app/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({})
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/退款通道已关闭/)
    expect(res.body.error).toMatch(/biaozhunxiaozhi@tbzy\.org\.cn/)
  })

  it('订单状态不变（PAID 仍 PAID）', async () => {
    await request(app)
      .post(`/api/app/orders/${order.orderNo}/refund`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({})
    const after = await prisma.appOrder.findUnique({ where: { orderNo: order.orderNo } })
    expect(after!.status).toBe('PAID')
  })
})
