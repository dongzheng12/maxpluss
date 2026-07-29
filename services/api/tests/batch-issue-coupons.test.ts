/**
 * POST /api/admin/coupons/batch-issue + GET /api/admin/coupons/templates
 *
 * 覆盖：happy path / 权限拦截 / 幂等(已持有 AVAILABLE skipped) /
 *      未注册 notFound / templateCode 路径 / 上限 / 模板已下线
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { registerCouponRoutes } from '../src/couponRoutes.js'
import { createUser, getTestToken, ensurePlans } from './factory.js'

const app = express()
app.use(express.json())

// 强制启用 coupon feature flag
process.env.BXZ_COUPON_ENABLED = 'true'

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  registerCouponRoutes(app)
  await ensureAppSeed()
})

const TEMPLATE_CODE = 'BATCH_TEST_50'
let templateId = ''

beforeEach(async () => {
  // 清掉测试用 phone 段 + 测试用模板
  const tmpl = await prisma.coupon.findUnique({ where: { code: TEMPLATE_CODE } })
  if (tmpl) {
    await prisma.userCoupon.deleteMany({ where: { couponId: tmpl.id } })
  }
  await prisma.coupon.deleteMany({ where: { code: TEMPLATE_CODE } })
  // 先清 13912 段 user 的相关 UserCoupon（避免 createUser 重建后 fk 残留）
  const testUsers = await prisma.appUser.findMany({
    where: { phone: { startsWith: '13912' } },
    select: { id: true },
  })
  const testUserIds = testUsers.map(u => u.id)
  if (testUserIds.length > 0) {
    await prisma.userCoupon.deleteMany({ where: { userId: { in: testUserIds } } })
  }
  await prisma.appUser.deleteMany({ where: { phone: { startsWith: '13912' } } })

  // 重建测试模板 ACTIVE
  const created = await prisma.coupon.create({
    data: {
      code: TEMPLATE_CODE,
      name: '批量发券测试 ¥50 直减',
      description: '测试用',
      discountType: 'FIXED',
      discountValue: 5000,
      minAmount: 0,
      applicableScope: 'MEMBERSHIP',
      validFrom: new Date(Date.now() - 86400000),
      validTo: new Date(Date.now() + 30 * 86400000),
      status: 'ACTIVE',
      createdBy: 'test',
    },
  })
  templateId = created.id
})

describe('GET /api/admin/coupons/templates', () => {
  it('admin → 仅返回 status=ACTIVE 且未过期', async () => {
    const admin = await createUser({ role: 'admin', phone: '13912000001' })

    // 加一个 DISABLED + 一个过期 干扰项
    await prisma.coupon.create({
      data: {
        code: 'DISABLED_T1', name: 'd', discountType: 'FIXED', discountValue: 100,
        minAmount: 0, applicableScope: 'ALL',
        validFrom: new Date(), validTo: new Date(Date.now() + 86400000),
        status: 'DISABLED', createdBy: 'test',
      },
    })
    await prisma.coupon.create({
      data: {
        code: 'EXPIRED_T1', name: 'e', discountType: 'FIXED', discountValue: 100,
        minAmount: 0, applicableScope: 'ALL',
        validFrom: new Date(Date.now() - 30 * 86400000),
        validTo: new Date(Date.now() - 86400000),
        status: 'ACTIVE', createdBy: 'test',
      },
    })

    const res = await request(app)
      .get('/api/admin/coupons/templates')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)

    expect(res.status).toBe(200)
    const codes = (res.body.items || []).map((t: any) => t.code)
    expect(codes).toContain(TEMPLATE_CODE)
    expect(codes).not.toContain('DISABLED_T1')
    expect(codes).not.toContain('EXPIRED_T1')

    // cleanup
    await prisma.coupon.deleteMany({ where: { code: { in: ['DISABLED_T1', 'EXPIRED_T1'] } } })
  })

  it('未登录 → 401', async () => {
    const res = await request(app).get('/api/admin/coupons/templates')
    expect(res.status).toBe(401)
  })

  it('普通 user → 403', async () => {
    const u = await createUser({ phone: '13912000002' })
    const res = await request(app)
      .get('/api/admin/coupons/templates')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
    expect(res.status).toBe(403)
  })
})

describe('POST /api/admin/coupons/batch-issue — happy path', () => {
  it('phones × 2 全部已注册 → issued × 2', async () => {
    const admin = await createUser({ role: 'admin', phone: '13912000010' })
    await createUser({ phone: '13912000011' })
    await createUser({ phone: '13912000012' })

    const res = await request(app)
      .post('/api/admin/coupons/batch-issue')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ couponId: templateId, phones: ['13912000011', '13912000012'] })

    expect(res.status).toBe(200)
    expect(res.body.issued).toHaveLength(2)
    expect(res.body.skipped).toEqual([])
    expect(res.body.notFound).toEqual([])
    expect(res.body.coupon.code).toBe(TEMPLATE_CODE)
  })

  it('templateCode 路径同样工作', async () => {
    const admin = await createUser({ role: 'admin', phone: '13912000020' })
    await createUser({ phone: '13912000021' })

    const res = await request(app)
      .post('/api/admin/coupons/batch-issue')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ templateCode: TEMPLATE_CODE, phones: ['13912000021'] })

    expect(res.status).toBe(200)
    expect(res.body.issued).toHaveLength(1)
  })
})

describe('POST /api/admin/coupons/batch-issue — 幂等', () => {
  it('已持有同模板 AVAILABLE → skipped（不依赖 batchId）', async () => {
    const admin = await createUser({ role: 'admin', phone: '13912000030' })
    await createUser({ phone: '13912000031' })

    // 第一次
    await request(app)
      .post('/api/admin/coupons/batch-issue')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ couponId: templateId, phones: ['13912000031'] })

    // 第二次（新 batchId）→ 仍 skipped
    const res = await request(app)
      .post('/api/admin/coupons/batch-issue')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ couponId: templateId, phones: ['13912000031'] })

    expect(res.status).toBe(200)
    expect(res.body.issued).toEqual([])
    expect(res.body.skipped).toHaveLength(1)
    expect(res.body.skipped[0].reason).toContain('已持有该券')

    // 实际 UserCoupon 仅 1 张
    const ucs = await prisma.userCoupon.findMany({
      where: { couponId: templateId, user: { phone: '13912000031' } },
    })
    expect(ucs).toHaveLength(1)
  })
})

describe('POST /api/admin/coupons/batch-issue — 边界', () => {
  it('未注册手机号 → notFound', async () => {
    const admin = await createUser({ role: 'admin', phone: '13912000040' })
    const res = await request(app)
      .post('/api/admin/coupons/batch-issue')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ couponId: templateId, phones: ['13912000099'] })

    expect(res.status).toBe(200)
    expect(res.body.issued).toEqual([])
    expect(res.body.notFound).toEqual(['13912000099'])
  })

  it('couponId 和 templateCode 都不传 → 400', async () => {
    const admin = await createUser({ role: 'admin', phone: '13912000050' })
    const res = await request(app)
      .post('/api/admin/coupons/batch-issue')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ phones: ['13912000051'] })

    expect(res.status).toBe(400)
  })

  it('couponId 不存在 → 404', async () => {
    const admin = await createUser({ role: 'admin', phone: '13912000060' })
    const res = await request(app)
      .post('/api/admin/coupons/batch-issue')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ couponId: 'nonexistent', phones: ['13912000061'] })

    expect(res.status).toBe(404)
  })

  it('模板 DISABLED → 400', async () => {
    const admin = await createUser({ role: 'admin', phone: '13912000070' })
    await prisma.coupon.update({ where: { id: templateId }, data: { status: 'DISABLED' } })

    const res = await request(app)
      .post('/api/admin/coupons/batch-issue')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ couponId: templateId, phones: ['13912000071'] })

    expect(res.status).toBe(400)
  })

  it('phones 超 100 → 400', async () => {
    const admin = await createUser({ role: 'admin', phone: '13912000080' })
    const phones = Array.from({ length: 101 }, (_, i) => `139${String(i).padStart(8, '0')}`)
    const res = await request(app)
      .post('/api/admin/coupons/batch-issue')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ couponId: templateId, phones })

    expect(res.status).toBe(400)
  })
})

describe('POST /api/admin/coupons/batch-issue — 权限', () => {
  it('未登录 → 401', async () => {
    const res = await request(app)
      .post('/api/admin/coupons/batch-issue')
      .send({ couponId: templateId, phones: ['13912000090'] })
    expect(res.status).toBe(401)
  })

  it('普通 user → 403', async () => {
    const u = await createUser({ phone: '13912000091' })
    const res = await request(app)
      .post('/api/admin/coupons/batch-issue')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
      .send({ couponId: templateId, phones: ['13912000092'] })
    expect(res.status).toBe(403)
  })
})
