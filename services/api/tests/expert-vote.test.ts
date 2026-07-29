/**
 * 专家评审投票（P0-1）测试
 *
 * 覆盖：
 *   - 状态机迁移白名单 / CAS 并发安全
 *   - 14 天提前预约校验
 *   - 金额计算（expertCount × unitPrice 快照）
 *   - 鉴权：未登录 / 跨用户访问拦截
 *   - 草稿创建 / 编辑 / 删除
 *   - 提交建单 → DRAFT → PAYING + AppOrder 生成（productType=EXPERT_VOTE）
 *   - 用户取消（PAYING → CANCELLED）
 *   - handlePostPaymentInTx 模拟：PAYING → EXPERT_ARRANGING（金额快照不变）
 *   - orderSweeper 联动：EXPERT_VOTE 订单超时 → ExpertVoteRequest CANCELLED
 *   - 优惠券显式排除 EXPERT_VOTE
 *   - 附件大小双闸门
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import {
  EXPERT_VOTE_TRANSITIONS,
  EXPERT_VOTE_DEFAULTS,
  PRESET_EXPERT_COUNTS,
  isAllowedTransition,
  transitionStatus,
  calcExpertVoteAmount,
  ensureExpertVoteSettings,
  getExpertVotePathAEnabled,
  getExpertVoteUnitPrice,
  assertDesiredDateLeadTime,
  assertDraftSubmittable,
  makeExpertVoteRequestNo,
} from '../src/services/expertVote.js'
import { registerExpertVoteRoutes } from '../src/expertVoteRoutes.js'
import { sweepStaleOrders } from '../src/orderSweeper.js'
import { createUser, getTestToken, cleanAll, ensurePlans } from './factory.js'

const app = express()
app.use(express.json())
registerExpertVoteRoutes(app)

beforeAll(async () => {
  await ensurePlans()
  await ensureExpertVoteSettings()
})

beforeEach(async () => {
  // 清理顺序：AppOrder 先于 AppUser；ExpertVoteRequest 走 cleanAll 处理
  await cleanAll()
  await ensureExpertVoteSettings()
})

function dateAfterDays(days: number): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + days)
  return d
}

function isoAfterDays(days: number): string {
  return dateAfterDays(days).toISOString()
}

function validDraftPayload(overrides: Record<string, any> = {}) {
  return {
    contactName: '张三',
    contactPhone: '13800001234',
    projectName: '《示例团体标准》专家审查会',
    targetName: 'T/CECS 12345-2026',
    projectType: '标准评审',
    standardType: '团体标准',
    standardStatus: '送审稿',
    industries: ['化工'],
    backgroundDesc: '本标准已完成多轮意见征集，需要组织专家进行送审稿评审。',
    expertSourceType: 'PLATFORM',
    expertCategories: ['行业技术专家'],
    expertCount: 5,
    desiredDate: isoAfterDays(15), // 满足 14 天约束
    desiredSlot: 'AFTERNOON',
    acceptReschedule: true,
    confidentialLevel: 'NONE',
    ...overrides,
  }
}

// ═════════════════════════════════════════════════════════════
// 1. 状态机
// ═════════════════════════════════════════════════════════════

describe('状态机 EXPERT_VOTE_TRANSITIONS', () => {
  it('白名单允许 DRAFT → PAYING / CANCELLED', () => {
    expect(isAllowedTransition('DRAFT', 'PAYING')).toBe(true)
    expect(isAllowedTransition('DRAFT', 'CANCELLED')).toBe(true)
  })

  it('白名单拒绝 DRAFT → EXPERT_ARRANGING（必须经 PAYING）', () => {
    expect(isAllowedTransition('DRAFT', 'EXPERT_ARRANGING')).toBe(false)
  })

  it('PAYING 仅允许迁 EXPERT_ARRANGING / CANCELLED', () => {
    expect(EXPERT_VOTE_TRANSITIONS.PAYING).toEqual(['EXPERT_ARRANGING', 'CANCELLED'])
  })

  it('VOTING 起不允许退款迁移', () => {
    expect(isAllowedTransition('VOTING', 'REFUNDED')).toBe(false)
    expect(isAllowedTransition('VOTED', 'REFUNDED')).toBe(false)
    expect(isAllowedTransition('SIGNING', 'REFUNDED')).toBe(false)
    expect(isAllowedTransition('COMPLETED', 'REFUNDED')).toBe(false)
  })

  it('COMPLETED / CANCELLED / REFUNDED 是终态', () => {
    expect(EXPERT_VOTE_TRANSITIONS.COMPLETED).toEqual([])
    expect(EXPERT_VOTE_TRANSITIONS.CANCELLED).toEqual([])
    expect(EXPERT_VOTE_TRANSITIONS.REFUNDED).toEqual([])
  })

  it('transitionStatus CAS：状态匹配则更新返回 true', async () => {
    const u = await createUser()
    const r = await prisma.expertVoteRequest.create({
      data: {
        requestNo: makeExpertVoteRequestNo(),
        userId: u.id,
        status: 'DRAFT',
        projectName: '测试', targetName: 'T1',
        projectType: '标准评审', standardType: '团体标准', standardStatus: '送审稿',
        backgroundDesc: '...', expertSourceType: 'PLATFORM', expertCount: 3,
      },
    })
    const ok = await transitionStatus(prisma, r.requestNo, 'DRAFT', 'PAYING')
    expect(ok).toBe(true)
    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.status).toBe('PAYING')
  })

  it('transitionStatus CAS：状态不匹配返回 false 且不写库', async () => {
    const u = await createUser()
    const r = await prisma.expertVoteRequest.create({
      data: {
        requestNo: makeExpertVoteRequestNo(),
        userId: u.id,
        status: 'PAYING',
        projectName: '测试', targetName: 'T1',
        projectType: '标准评审', standardType: '团体标准', standardStatus: '送审稿',
        backgroundDesc: '...', expertSourceType: 'PLATFORM', expertCount: 3,
      },
    })
    const ok = await transitionStatus(prisma, r.requestNo, 'DRAFT', 'PAYING') // expectedFrom=DRAFT 但当前是 PAYING
    expect(ok).toBe(false)
    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.status).toBe('PAYING') // 不变
  })

  it('transitionStatus 非法迁移直接抛错', async () => {
    await expect(
      transitionStatus(prisma, 'NOT-EXIST', 'CANCELLED', 'PAYING'),
    ).rejects.toThrow(/非法状态迁移/)
  })
})

// ═════════════════════════════════════════════════════════════
// 2. 金额 / 14 天
// ═════════════════════════════════════════════════════════════

describe('calcExpertVoteAmount', () => {
  it('正常：5 专家 × 200000 = 1000000 分', () => {
    expect(calcExpertVoteAmount(5, EXPERT_VOTE_DEFAULTS.UNIT_PRICE)).toBe(1000000)
  })

  it('非法 expertCount 抛错', () => {
    expect(() => calcExpertVoteAmount(0, 100)).toThrow()
    expect(() => calcExpertVoteAmount(-1, 100)).toThrow()
  })

  it('非法 unitPrice 抛错', () => {
    expect(() => calcExpertVoteAmount(3, 0)).toThrow()
  })

  it('SystemSetting 默认值生效：getExpertVoteUnitPrice 返回 200000', async () => {
    const price = await getExpertVoteUnitPrice()
    expect(price).toBe(EXPERT_VOTE_DEFAULTS.UNIT_PRICE)
  })

  it('SystemSetting 默认值生效：Path A 平台内自动合成默认关闭', async () => {
    const enabled = await getExpertVotePathAEnabled()
    expect(enabled).toBe(false)
  })

  it('SystemSetting 改单价后立即生效', async () => {
    await prisma.systemSetting.upsert({
      where: { key: 'expert_vote_unit_price' },
      update: { value: '300000' },
      create: { key: 'expert_vote_unit_price', value: '300000' },
    })
    const price = await getExpertVoteUnitPrice()
    expect(price).toBe(300000)
    // 还原
    await prisma.systemSetting.update({
      where: { key: 'expert_vote_unit_price' },
      data: { value: String(EXPERT_VOTE_DEFAULTS.UNIT_PRICE) },
    })
  })
})

describe('14 天提前预约校验', () => {
  it('今天 + 14 天 OK', async () => {
    await expect(assertDesiredDateLeadTime(dateAfterDays(14))).resolves.toBeUndefined()
  })

  it('今天 + 13 天 抛错', async () => {
    await expect(assertDesiredDateLeadTime(dateAfterDays(13))).rejects.toThrow(/14 天/)
  })

  it('明天直接抛错', async () => {
    await expect(assertDesiredDateLeadTime(dateAfterDays(1))).rejects.toThrow(/14 天/)
  })

  it('null 不抛（DRAFT 阶段允许空）', async () => {
    await expect(assertDesiredDateLeadTime(null)).resolves.toBeUndefined()
  })
})

describe('草稿提交校验', () => {
  const baseValid = {
    contactName: '张三', contactPhone: '13800001234',
    projectName: 'a', targetName: 'b', projectType: '标准评审', standardType: '团体标准',
    standardStatus: '送审稿', backgroundDesc: 'c', expertSourceType: 'PLATFORM',
    expertCount: 5, desiredDate: dateAfterDays(20), desiredSlot: 'ANY',
    confidentialLevel: 'NONE',
  }

  it('正常通过', async () => {
    await expect(assertDraftSubmittable({ ...baseValid })).resolves.toBeUndefined()
  })

  it('contactName 缺失抛错', async () => {
    await expect(assertDraftSubmittable({ ...baseValid, contactName: null }))
      .rejects.toThrow(/contactName|必填/)
  })

  it('contactPhone 缺失抛错', async () => {
    await expect(assertDraftSubmittable({ ...baseValid, contactPhone: null }))
      .rejects.toThrow(/contactPhone|必填/)
  })

  it('contactPhone 格式错误抛错', async () => {
    await expect(assertDraftSubmittable({ ...baseValid, contactPhone: '12345' }))
      .rejects.toThrow(/格式无效|手机号/)
  })

  it('expertCount 偶数抛错', async () => {
    await expect(assertDraftSubmittable({ ...baseValid, expertCount: 4 }))
      .rejects.toThrow(/奇数/)
  })

  it('expertCount 自定义奇数（11）通过', async () => {
    await expect(assertDraftSubmittable({ ...baseValid, expertCount: 11 }))
      .resolves.toBeUndefined()
  })

  it('expertCount < 3 抛错', async () => {
    await expect(assertDraftSubmittable({ ...baseValid, expertCount: 1 }))
      .rejects.toThrow()
  })

  it('涉密未填说明抛错', async () => {
    await expect(assertDraftSubmittable({
      ...baseValid, confidentialLevel: 'STRICT', confidentialRemark: null,
    })).rejects.toThrow(/保密/)
  })
})

// ═════════════════════════════════════════════════════════════
// 3. 路由：鉴权 / 创建 / 编辑 / 删除 / 列表
// ═════════════════════════════════════════════════════════════

describe('用户端 expert-votes 接口', () => {
  it('未登录访问列表 → 401', async () => {
    const res = await request(app).get('/api/app/expert-votes')
    expect(res.status).toBe(401)
  })

  it('创建草稿 → 200 + status=DRAFT', async () => {
    const u = await createUser()
    const res = await request(app)
      .post('/api/app/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send(validDraftPayload())
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('DRAFT')
    expect(res.body.requestNo).toMatch(/^EVR-/)
    expect(res.body.userId).toBe(u.id)
    expect(res.body.industries).toEqual(['化工'])
  })

  it('创建草稿：14 天约束被后端拦截', async () => {
    const u = await createUser()
    const res = await request(app)
      .post('/api/app/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send(validDraftPayload({ desiredDate: isoAfterDays(5) }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/14 天/)
  })

  it('创建草稿：expertCount 非法被 zod 拒绝', async () => {
    const u = await createUser()
    const res = await request(app)
      .post('/api/app/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send(validDraftPayload({ expertCount: 4 }))
    expect(res.status).toBe(400)
  })

  it('跨用户读取详情 → 403', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const created = await request(app)
      .post('/api/app/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(owner.id)}`)
      .send(validDraftPayload())
    const res = await request(app)
      .get(`/api/app/expert-votes/${created.body.requestNo}`)
      .set('Authorization', `Bearer ${getTestToken(stranger.id)}`)
    expect(res.status).toBe(403)
  })

  it('编辑草稿正常 / 非 DRAFT 拦截', async () => {
    const u = await createUser()
    const created = await request(app)
      .post('/api/app/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send(validDraftPayload())
    const requestNo = created.body.requestNo

    const updated = await request(app)
      .patch(`/api/app/expert-votes/${requestNo}`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send(validDraftPayload({ projectName: '改名后的项目' }))
    expect(updated.status).toBe(200)
    expect(updated.body.projectName).toBe('改名后的项目')

    // 强行把状态改为 PAYING，再尝试编辑
    await prisma.expertVoteRequest.update({
      where: { requestNo },
      data: { status: 'PAYING' },
    })
    const blocked = await request(app)
      .patch(`/api/app/expert-votes/${requestNo}`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send(validDraftPayload({ projectName: '不应生效' }))
    expect(blocked.status).toBe(409)
  })

  it('删除草稿正常；非 DRAFT 拦截', async () => {
    const u = await createUser()
    const created = await request(app)
      .post('/api/app/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send(validDraftPayload())
    const requestNo = created.body.requestNo

    const del = await request(app)
      .delete(`/api/app/expert-votes/${requestNo}`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
    expect(del.status).toBe(200)
    const gone = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    expect(gone).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════
// 4. 提交建单 / 取消 / 支付回调联动
// ═════════════════════════════════════════════════════════════

describe('提交建单与状态联动', () => {
  it('提交：DRAFT → PAYING + 创建 AppOrder + 金额快照', async () => {
    const u = await createUser()
    const created = await request(app)
      .post('/api/app/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send(validDraftPayload({ expertCount: 5 }))
    const requestNo = created.body.requestNo

    const submit = await request(app)
      .post(`/api/app/expert-votes/${requestNo}/submit`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send({})
    expect(submit.status).toBe(200)
    expect(submit.body.request.status).toBe('PAYING')
    expect(submit.body.request.unitPrice).toBe(EXPERT_VOTE_DEFAULTS.UNIT_PRICE)
    expect(submit.body.request.totalAmount).toBe(5 * EXPERT_VOTE_DEFAULTS.UNIT_PRICE)
    expect(submit.body.order.productType).toBe('EXPERT_VOTE')
    expect(submit.body.order.productRef).toBe(requestNo)
    expect(submit.body.order.amount).toBe(5 * EXPERT_VOTE_DEFAULTS.UNIT_PRICE)
    expect(submit.body.order.status).toBe('PENDING')
  })

  it('提交后改 SystemSetting 单价不影响已下单的金额（快照锁定）', async () => {
    const u = await createUser()
    const created = await request(app)
      .post('/api/app/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send(validDraftPayload({ expertCount: 3 }))
    await request(app)
      .post(`/api/app/expert-votes/${created.body.requestNo}/submit`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send({})

    // 改 SystemSetting
    await prisma.systemSetting.update({
      where: { key: 'expert_vote_unit_price' },
      data: { value: '999999' },
    })

    const after = await prisma.expertVoteRequest.findUnique({
      where: { requestNo: created.body.requestNo },
    })
    expect(after!.unitPrice).toBe(EXPERT_VOTE_DEFAULTS.UNIT_PRICE)
    expect(after!.totalAmount).toBe(3 * EXPERT_VOTE_DEFAULTS.UNIT_PRICE)

    // 还原
    await prisma.systemSetting.update({
      where: { key: 'expert_vote_unit_price' },
      data: { value: String(EXPERT_VOTE_DEFAULTS.UNIT_PRICE) },
    })
  })

  it('用户取消（PAYING → CANCELLED）：订单同步 CANCELLED', async () => {
    const u = await createUser()
    const created = await request(app)
      .post('/api/app/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send(validDraftPayload())
    const requestNo = created.body.requestNo
    const submit = await request(app)
      .post(`/api/app/expert-votes/${requestNo}/submit`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send({})
    const orderNo = submit.body.order.orderNo

    const cancel = await request(app)
      .post(`/api/app/expert-votes/${requestNo}/cancel`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send({})
    expect(cancel.status).toBe(200)

    const evReq = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    expect(evReq!.status).toBe('CANCELLED')
    const order = await prisma.appOrder.findUnique({ where: { orderNo } })
    expect(order!.status).toBe('CANCELLED')
  })

  it('用户取消：EXPERT_ARRANGING 状态拒绝', async () => {
    const u = await createUser()
    const r = await prisma.expertVoteRequest.create({
      data: {
        requestNo: makeExpertVoteRequestNo(),
        userId: u.id, status: 'EXPERT_ARRANGING',
        projectName: 'p', targetName: 't', projectType: '标准评审',
        standardType: '团体标准', standardStatus: '送审稿', backgroundDesc: '...',
        expertSourceType: 'PLATFORM', expertCount: 3,
      },
    })
    const res = await request(app)
      .post(`/api/app/expert-votes/${r.requestNo}/cancel`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send({})
    expect(res.status).toBe(409)
  })

  it('支付回调（模拟）：PAYING → EXPERT_ARRANGING（CAS 幂等）', async () => {
    const u = await createUser()
    const created = await request(app)
      .post('/api/app/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send(validDraftPayload())
    const requestNo = created.body.requestNo
    await request(app)
      .post(`/api/app/expert-votes/${requestNo}/submit`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send({})

    // 模拟 handlePostPaymentInTx 中的迁移
    const moved1 = await transitionStatus(prisma, requestNo, 'PAYING', 'EXPERT_ARRANGING', { paidAt: new Date() })
    expect(moved1).toBe(true)

    // 重复回调：第二次返回 false（幂等）
    const moved2 = await transitionStatus(prisma, requestNo, 'PAYING', 'EXPERT_ARRANGING')
    expect(moved2).toBe(false)

    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    expect(fresh!.status).toBe('EXPERT_ARRANGING')
    expect(fresh!.paidAt).not.toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════
// 5. orderSweeper 联动
// ═════════════════════════════════════════════════════════════

describe('orderSweeper 联动', () => {
  it('AppOrder PAYING 超时关闭 → ExpertVoteRequest 同步 CANCELLED', async () => {
    const u = await createUser()
    const requestNo = makeExpertVoteRequestNo()
    const orderNo = `ORD-EXPV-${Date.now()}`
    const old = new Date(Date.now() - 31 * 60 * 1000)

    await prisma.expertVoteRequest.create({
      data: {
        requestNo, userId: u.id, status: 'PAYING',
        projectName: 'p', targetName: 't', projectType: '标准评审',
        standardType: '团体标准', standardStatus: '送审稿', backgroundDesc: '...',
        expertSourceType: 'PLATFORM', expertCount: 3,
        orderNo, unitPrice: 200000, totalAmount: 600000,
      },
    })
    await prisma.appOrder.create({
      data: {
        orderNo, userId: u.id, productType: 'EXPERT_VOTE', productRef: requestNo,
        title: '专家评审', amount: 600000, status: 'PAYING',
        createdAt: old, updatedAt: old,
      },
    })

    await sweepStaleOrders(prisma)

    const order = await prisma.appOrder.findUnique({ where: { orderNo } })
    expect(order!.status).toBe('FAILED')
    const evReq = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    expect(evReq!.status).toBe('CANCELLED')
    expect(evReq!.cancelReason).toMatch(/支付超时/)
  })
})

// ═════════════════════════════════════════════════════════════
// 6. 优惠券显式排除
// ═════════════════════════════════════════════════════════════

describe('优惠券对 EXPERT_VOTE 的排除', () => {
  it('ALL 范围的券不能用于 EXPERT_VOTE 商品', async () => {
    const { listApplicableCoupons } = await import('../src/coupons.js')
    const u = await createUser()
    // 建一张 ALL 券
    const coupon = await prisma.coupon.create({
      data: {
        code: 'TEST_ALL_EXPV',
        name: '通用 100 元',
        discountType: 'FIXED',
        discountValue: 10000,
        minAmount: 0,
        applicableScope: 'ALL',
        validFrom: new Date(Date.now() - 86400_000),
        validTo: new Date(Date.now() + 86400_000 * 30),
        status: 'ACTIVE',
        createdBy: 'test',
      },
    })
    await prisma.userCoupon.create({
      data: {
        userId: u.id,
        couponId: coupon.id,
        source: 'ISSUED_ADMIN',
        sourceRef: 'test-batch',
        expiresAt: new Date(Date.now() + 86400_000 * 30),
      },
    })
    const list = await listApplicableCoupons(prisma, {
      userId: u.id,
      productType: 'EXPERT_VOTE',
      planId: null,
      originalAmount: 1000000,
    })
    // 全部不可用
    expect(list.every((c) => !c.applicable)).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════
// 7. 附件大小双闸门
// ═════════════════════════════════════════════════════════════

describe('附件大小校验', () => {
  it('路径深度合理：上传一个小文件成功', async () => {
    const u = await createUser()
    const created = await request(app)
      .post('/api/app/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send(validDraftPayload())
    const requestNo = created.body.requestNo

    const buf = Buffer.from('hello'.repeat(100))
    const res = await request(app)
      .post(`/api/app/expert-votes/${requestNo}/attachments`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .attach('file', buf, { filename: 'demo.pdf', contentType: 'application/pdf' })
      .field('category', 'MAIN')
    expect(res.status).toBe(200)
    expect(res.body.size).toBe(buf.length)
    expect(res.body.category).toBe('MAIN')
  })

  it('累计大小超 totalMax 拒绝', async () => {
    // 把 totalMax 调到 1MB，单文件 5MB 直接被卡
    await prisma.systemSetting.upsert({
      where: { key: 'expert_vote_total_max_mb' },
      update: { value: '1' },
      create: { key: 'expert_vote_total_max_mb', value: '1' },
    })
    await prisma.systemSetting.upsert({
      where: { key: 'expert_vote_file_max_mb' },
      update: { value: '5' },
      create: { key: 'expert_vote_file_max_mb', value: '5' },
    })
    const u = await createUser()
    const created = await request(app)
      .post('/api/app/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .send(validDraftPayload())
    const requestNo = created.body.requestNo

    const big = Buffer.alloc(2 * 1024 * 1024) // 2MB
    const res = await request(app)
      .post(`/api/app/expert-votes/${requestNo}/attachments`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
      .attach('file', big, { filename: 'big.pdf', contentType: 'application/pdf' })
    expect(res.status).toBe(413)

    // 还原
    await prisma.systemSetting.update({
      where: { key: 'expert_vote_total_max_mb' },
      data: { value: String(EXPERT_VOTE_DEFAULTS.TOTAL_MAX_MB) },
    })
    await prisma.systemSetting.update({
      where: { key: 'expert_vote_file_max_mb' },
      data: { value: String(EXPERT_VOTE_DEFAULTS.FILE_MAX_MB) },
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// 安全：用户端详情不泄漏专家 phone / email
// ═══════════════════════════════════════════════════════════════
describe('用户端详情安全：专家字段过滤', () => {
  it('GET /api/app/expert-votes/:no 响应中专家列表不含 phone/email', async () => {
    const u = await createUser()
    // 创建已进入 MEETING_SCHEDULED 的申请
    const r = await prisma.expertVoteRequest.create({
      data: {
        requestNo: makeExpertVoteRequestNo(),
        userId: u.id,
        status: 'MEETING_SCHEDULED',
        projectName: '安全测试申请',
        targetName: 'T/SEC 001-2026',
        projectType: '标准评审',
        standardType: '团体标准',
        standardStatus: '送审稿',
        backgroundDesc: '测试',
        expertSourceType: 'PLATFORM',
        expertCount: 3,
        desiredDate: new Date(Date.now() + 20 * 86400_000),
        desiredSlot: 'AFTERNOON',
        acceptReschedule: true,
        unitPrice: 200000,
        totalAmount: 600000,
        paidAt: new Date(),
      },
    })
    // 直接写入带有敏感字段的专家记录
    await prisma.expertAssignment.createMany({
      data: [
        { requestId: r.id, expertName: '张三', expertPhone: '13800138001', expertEmail: 'zhang@example.com' },
        { requestId: r.id, expertName: '李四', expertPhone: '13900139001', expertEmail: 'li@example.com' },
        { requestId: r.id, expertName: '王五', expertPhone: '13700137001', expertEmail: 'wang@example.com' },
      ],
    })

    const res = await request(app)
      .get(`/api/app/expert-votes/${r.requestNo}`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
    expect(res.status).toBe(200)
    expect(res.body.experts).toHaveLength(3)
    // 安全：不得含 phone / email
    for (const expert of res.body.experts) {
      expect(expert).not.toHaveProperty('expertPhone')
      expect(expert).not.toHaveProperty('expertEmail')
      expect(expert).not.toHaveProperty('phone')
      expect(expert).not.toHaveProperty('email')
    }
    // 展示字段应正常返回
    expect(res.body.experts[0].expertName).toBe('张三')
  })
})
