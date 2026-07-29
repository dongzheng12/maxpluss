/**
 * 销售推广系统 — 端到端测试
 *
 * 覆盖 Phase 1-4 + 多码 + 删除保护 + 敏感词 + 归因试用发放：
 *  - 管理员邀请码：POST/GET/POST :id/disable
 *  - 销售自助注册：POST /api/app/sales/join
 *  - 公开落地页：GET /api/public/sales/:salesCode（两层 status→isPublic 校验 + contactVisible + companyVisible）
 *  - 销售多码：POST/GET /codes、PATCH :id/disable、DELETE :id（主码/订单保护）
 *  - 权限守卫：requireSales 拦 user/无 token
 *  - 注册归因：带 salesCode → 发 7 天试用 SALES_REFERRAL
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { registerSalesRoutes } from '../src/salesRoutes.js'
import { registerSalesV2Routes } from '../src/salesV2Routes.js'
import { createUser, getTestToken, ensurePlans } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  registerSalesRoutes(app)
  registerSalesV2Routes(app)
  await ensureAppSeed()
})

// ───────────────────────── 辅助 ─────────────────────────

/** 清销售推广相关表（保留 AppUser / MembershipPlan 等共享数据） */
async function cleanSalesTables() {
  await prisma.salesInvite.deleteMany()
  await prisma.salesCode.deleteMany()
  await prisma.salesProfile.deleteMany()
}

/** 造一个 sales 账号（带 SalesProfile + 主码 SalesCode） */
async function createSalesAccount(opts: {
  phone?: string
  realName?: string
  status?: string
  isPublic?: boolean
  contactVisible?: boolean
  companyVisible?: boolean
  wechat?: string | null
  salesPhone?: string | null
} = {}) {
  const user = await createUser({
    phone: opts.phone || `138${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`,
    role: 'sales',
  })
  const salesCode = 'TEST' + Math.random().toString(36).slice(2, 6).toUpperCase()
  const profile = await prisma.salesProfile.create({
    data: {
      salesCode,
      userId: user.id,
      realName: opts.realName || '测试销售',
      companyName: '通标中研测试部',
      status: opts.status || 'ENABLED',
      isPublic: opts.isPublic !== false,
      contactVisible: opts.contactVisible !== false,
      companyVisible: opts.companyVisible !== false,
      wechat: opts.wechat ?? 'wx_test',
      phone: opts.salesPhone ?? '13800000001',
      displayProducts: JSON.stringify([{ code: 'xiaozhi', sort: 1 }]),
    },
  })
  await prisma.salesCode.create({
    data: { salesCode, profileId: profile.id, label: '主码', status: 'ACTIVE' },
  })
  return { user, profile, salesCode }
}

// ═════════════════════════════════════════════════════════
// ① 管理员邀请码
// ═════════════════════════════════════════════════════════
describe('POST /api/admin/sales-invites', () => {
  beforeEach(cleanSalesTables)

  it('admin 生成邀请码 → 201 + 返回 inviteCode/url/expiresAt', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .post('/api/admin/sales-invites')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(201)
    expect(res.body.inviteCode).toMatch(/^[A-Z2-9]{8}$/)
    expect(res.body.status).toBe('UNUSED')
    expect(res.body.inviteUrl).toContain('/sales/join?invite=')
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('无 token → 401', async () => {
    const res = await request(app).post('/api/admin/sales-invites').send({})
    expect(res.status).toBe(401)
  })

  it('sales 用户（非 admin）→ 403', async () => {
    const sales = await createUser({ role: 'sales' })
    const res = await request(app)
      .post('/api/admin/sales-invites')
      .set('Authorization', `Bearer ${getTestToken(sales.id, 'sales')}`)
      .send({})
    expect(res.status).toBe(403)
  })

  it('普通 user → 403', async () => {
    const u = await createUser()
    const res = await request(app)
      .post('/api/admin/sales-invites')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
      .send({})
    expect(res.status).toBe(403)
  })
})

describe('POST /api/admin/sales-invites/:id/disable', () => {
  beforeEach(cleanSalesTables)

  it('UNUSED → 200 + 状态变 DISABLED', async () => {
    const admin = await createUser({ role: 'admin' })
    const inv = await prisma.salesInvite.create({
      data: { inviteCode: 'INV00001', createdBy: admin.id, status: 'UNUSED' },
    })
    const res = await request(app)
      .post(`/api/admin/sales-invites/${inv.id}/disable`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('DISABLED')
  })

  it('已使用的邀请码 → 400', async () => {
    const admin = await createUser({ role: 'admin' })
    const inv = await prisma.salesInvite.create({
      data: { inviteCode: 'INV00002', createdBy: admin.id, status: 'USED' },
    })
    const res = await request(app)
      .post(`/api/admin/sales-invites/${inv.id}/disable`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('不存在的 id → 404', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .post('/api/admin/sales-invites/nonexistent/disable')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(404)
  })
})

// ═════════════════════════════════════════════════════════
// ② 销售自助注册 /sales/join
// ═════════════════════════════════════════════════════════
describe('POST /api/app/sales/join', () => {
  beforeEach(cleanSalesTables)

  async function createValidInvite(adminId: string) {
    return prisma.salesInvite.create({
      data: {
        inviteCode: 'VALID' + Math.random().toString(36).slice(2, 5).toUpperCase(),
        createdBy: adminId,
        status: 'UNUSED',
        expiresAt: new Date(Date.now() + 30 * 86400000),
      },
    })
  }

  it('happy path → 201 + 创建 User/SalesProfile/SalesCode主码 + invite 标 USED', async () => {
    const admin = await createUser({ role: 'admin' })
    const invite = await createValidInvite(admin.id)
    const phone = '13777770001'
    const res = await request(app)
      .post('/api/app/sales/join')
      .send({
        inviteCode: invite.inviteCode,
        phone,
        password: 'joinpass123',
        realName: '新销售',
        companyName: '新公司',
      })
    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    expect(res.body.salesCode).toMatch(/^[A-Z2-9]{8}$/)

    // DB 验证
    const newUser = await prisma.appUser.findUnique({ where: { phone } })
    expect(newUser?.role).toBe('sales')
    const profile = await prisma.salesProfile.findUnique({ where: { userId: newUser!.id } })
    expect(profile?.salesCode).toBe(res.body.salesCode)
    // 主码应同步写入 SalesCode 表
    const mainCode = await prisma.salesCode.findUnique({ where: { salesCode: res.body.salesCode } })
    expect(mainCode?.label).toBe('主码')
    // invite 标记已用
    const usedInvite = await prisma.salesInvite.findUnique({ where: { id: invite.id } })
    expect(usedInvite?.status).toBe('USED')
    expect(usedInvite?.usedBy).toBe(newUser!.id)
  })

  it('邀请码不存在 → 400', async () => {
    const res = await request(app)
      .post('/api/app/sales/join')
      .send({
        inviteCode: 'NOTEXIST',
        phone: '13777770002',
        password: 'abc123456',
        realName: '某销售',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/邀请码/)
  })

  it('邀请码已使用 → 400', async () => {
    const admin = await createUser({ role: 'admin' })
    const inv = await prisma.salesInvite.create({
      data: { inviteCode: 'USED0001', createdBy: admin.id, status: 'USED' },
    })
    const res = await request(app)
      .post('/api/app/sales/join')
      .send({
        inviteCode: inv.inviteCode,
        phone: '13777770003',
        password: 'abc123456',
        realName: '某销售',
      })
    expect(res.status).toBe(400)
  })

  it('邀请码已过期 → 400 + 标 EXPIRED', async () => {
    const admin = await createUser({ role: 'admin' })
    const inv = await prisma.salesInvite.create({
      data: {
        inviteCode: 'EXPIRE01',
        createdBy: admin.id,
        status: 'UNUSED',
        expiresAt: new Date(Date.now() - 1000),
      },
    })
    const res = await request(app)
      .post('/api/app/sales/join')
      .send({
        inviteCode: inv.inviteCode,
        phone: '13777770004',
        password: 'abc123456',
        realName: '某销售',
      })
    expect(res.status).toBe(400)
    const after = await prisma.salesInvite.findUnique({ where: { id: inv.id } })
    expect(after?.status).toBe('EXPIRED')
  })

  it('手机号已被使用 → 409', async () => {
    const admin = await createUser({ role: 'admin' })
    const invite = await createValidInvite(admin.id)
    await createUser({ phone: '13777770005' })
    const res = await request(app)
      .post('/api/app/sales/join')
      .send({
        inviteCode: invite.inviteCode,
        phone: '13777770005',
        password: 'abc123456',
        realName: '某销售',
      })
    expect(res.status).toBe(409)
  })

  it('参数缺失 → 400', async () => {
    const res = await request(app)
      .post('/api/app/sales/join')
      .send({ inviteCode: 'whatever' })
    expect(res.status).toBe(400)
  })
})

// ═════════════════════════════════════════════════════════
// ③ 公开落地页接口（两层校验 + visibility）
// ═════════════════════════════════════════════════════════
describe('GET /api/public/sales/:salesCode', () => {
  beforeEach(cleanSalesTables)

  it('status=ENABLED + isPublic=true → 200 + 返回资料', async () => {
    const { salesCode } = await createSalesAccount({ realName: '对外小张' })
    const res = await request(app).get(`/api/public/sales/${salesCode}`)
    expect(res.status).toBe(200)
    expect(res.body.realName).toBe('对外小张')
    expect(res.body.salesCode).toBe(salesCode)
  })

  it('不存在的 code → 404 NOT_FOUND', async () => {
    const res = await request(app).get('/api/public/sales/NOTEXIST')
    expect(res.status).toBe(404)
    expect(res.body.status).toBe('NOT_FOUND')
  })

  it('status=DISABLED（管理员停用）→ 404 DISABLED（status 校验优先）', async () => {
    const { salesCode } = await createSalesAccount({ status: 'DISABLED' })
    const res = await request(app).get(`/api/public/sales/${salesCode}`)
    expect(res.status).toBe(404)
    expect(res.body.status).toBe('DISABLED')
  })

  it('status=ENABLED 但 isPublic=false → 404 NOT_PUBLIC', async () => {
    const { salesCode } = await createSalesAccount({ isPublic: false })
    const res = await request(app).get(`/api/public/sales/${salesCode}`)
    expect(res.status).toBe(404)
    expect(res.body.status).toBe('NOT_PUBLIC')
  })

  it('contactVisible=false → contact 字段全 null', async () => {
    const { salesCode } = await createSalesAccount({ contactVisible: false })
    const res = await request(app).get(`/api/public/sales/${salesCode}`)
    expect(res.status).toBe(200)
    expect(res.body.contactVisible).toBe(false)
    expect(res.body.contact.phone).toBeNull()
    expect(res.body.contact.wechat).toBeNull()
    expect(res.body.contact.qrcode).toBeNull()
  })

  it('contactVisible=true → contact 有真实值', async () => {
    const { salesCode } = await createSalesAccount({ contactVisible: true })
    const res = await request(app).get(`/api/public/sales/${salesCode}`)
    expect(res.body.contact.phone).toBe('13800000001')
    expect(res.body.contact.wechat).toBe('wx_test')
  })

  it('companyVisible=false → companyName 为 null', async () => {
    const { salesCode } = await createSalesAccount({ companyVisible: false })
    const res = await request(app).get(`/api/public/sales/${salesCode}`)
    expect(res.body.companyVisible).toBe(false)
    expect(res.body.companyName).toBeNull()
  })

  it('多码场景：SalesCode 表的额外码也能访问 + 返回用户实际访问的码', async () => {
    const { profile, salesCode: mainCode } = await createSalesAccount({})
    await prisma.salesCode.create({
      data: { salesCode: 'EXTRA001', profileId: profile.id, label: '抖音', status: 'ACTIVE' },
    })
    const res = await request(app).get('/api/public/sales/EXTRA001')
    expect(res.status).toBe(200)
    expect(res.body.salesCode).toBe('EXTRA001')  // 不是主码 mainCode
    expect(mainCode).not.toBe('EXTRA001')
  })
})

// ═════════════════════════════════════════════════════════
// ④ 销售 me 系列权限守卫
// ═════════════════════════════════════════════════════════
describe('权限守卫：requireSales', () => {
  beforeEach(cleanSalesTables)

  it('无 token → 401', async () => {
    const res = await request(app).get('/api/app/sales/profile/me')
    expect(res.status).toBe(401)
  })

  it('普通 user token → 403', async () => {
    const u = await createUser({ role: 'user' })
    const res = await request(app)
      .get('/api/app/sales/profile/me')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
    expect(res.status).toBe(403)
  })

  it('sales token + 无 profile → 404', async () => {
    const s = await createUser({ role: 'sales' })
    const res = await request(app)
      .get('/api/app/sales/profile/me')
      .set('Authorization', `Bearer ${getTestToken(s.id, 'sales')}`)
    expect(res.status).toBe(404)  // 账号有但没建 profile
  })

  it('sales token + 有 profile → 200', async () => {
    const { user } = await createSalesAccount({ realName: '自己看' })
    const res = await request(app)
      .get('/api/app/sales/profile/me')
      .set('Authorization', `Bearer ${getTestToken(user.id, 'sales')}`)
    expect(res.status).toBe(200)
    expect(res.body.realName).toBe('自己看')
  })
})

// ═════════════════════════════════════════════════════════
// ⑤ 推广码删除保护
// ═════════════════════════════════════════════════════════
describe('DELETE /api/app/sales/codes/:id', () => {
  beforeEach(cleanSalesTables)

  it('主码 → 400 不可删除', async () => {
    const { user, profile } = await createSalesAccount({})
    const mainCode = await prisma.salesCode.findFirst({ where: { profileId: profile.id, label: '主码' } })
    const res = await request(app)
      .delete(`/api/app/sales/codes/${mainCode!.id}`)
      .set('Authorization', `Bearer ${getTestToken(user.id, 'sales')}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/主码/)
  })

  it('额外码无订单 → 200 删除成功', async () => {
    const { user, profile } = await createSalesAccount({})
    const extra = await prisma.salesCode.create({
      data: { salesCode: 'NOORDER1', profileId: profile.id, label: '测试', status: 'ACTIVE' },
    })
    const res = await request(app)
      .delete(`/api/app/sales/codes/${extra.id}`)
      .set('Authorization', `Bearer ${getTestToken(user.id, 'sales')}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    const after = await prisma.salesCode.findUnique({ where: { id: extra.id } })
    expect(after).toBeNull()
  })

  it('额外码有归因订单 → 400 归因保护', async () => {
    const { user, profile } = await createSalesAccount({})
    const extra = await prisma.salesCode.create({
      data: { salesCode: 'HASORD01', profileId: profile.id, label: '测试', status: 'ACTIVE' },
    })
    await prisma.appOrder.create({
      data: {
        orderNo: `ORD-TEST-PROMO-${Date.now()}`,
        productType: 'MEMBERSHIP',
        title: '测试订单',
        amount: 100,
        status: 'PAID',
        salesCode: 'HASORD01',
      },
    })
    const res = await request(app)
      .delete(`/api/app/sales/codes/${extra.id}`)
      .set('Authorization', `Bearer ${getTestToken(user.id, 'sales')}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/归因订单/)
    const after = await prisma.salesCode.findUnique({ where: { id: extra.id } })
    expect(after).not.toBeNull()  // 没删成功
  })

  it('无 token → 401', async () => {
    const { profile } = await createSalesAccount({})
    const extra = await prisma.salesCode.create({
      data: { salesCode: 'NOAUTH01', profileId: profile.id, label: '测试', status: 'ACTIVE' },
    })
    const res = await request(app).delete(`/api/app/sales/codes/${extra.id}`)
    expect(res.status).toBe(401)
  })

  it('其他销售的码 → 404（只能删自己的）', async () => {
    const a = await createSalesAccount({})
    const b = await createSalesAccount({})
    const bExtra = await prisma.salesCode.create({
      data: { salesCode: 'BEXTRA01', profileId: b.profile.id, label: '测试', status: 'ACTIVE' },
    })
    const res = await request(app)
      .delete(`/api/app/sales/codes/${bExtra.id}`)
      .set('Authorization', `Bearer ${getTestToken(a.user.id, 'sales')}`)
    expect(res.status).toBe(404)
  })
})

// ═════════════════════════════════════════════════════════
// ⑥ 推广码最多 10 个
// ═════════════════════════════════════════════════════════
describe('POST /api/app/sales/codes 数量上限', () => {
  beforeEach(cleanSalesTables)

  it('已有 10 个（含主码）再建 → 400', async () => {
    const { user, profile } = await createSalesAccount({})
    // 再建 9 个（加主码正好 10）
    for (let i = 0; i < 9; i++) {
      await prisma.salesCode.create({
        data: { salesCode: `X${i}${Math.random().toString(36).slice(2, 6).toUpperCase()}`, profileId: profile.id, label: `测试${i}`, status: 'ACTIVE' },
      })
    }
    const res = await request(app)
      .post('/api/app/sales/codes')
      .set('Authorization', `Bearer ${getTestToken(user.id, 'sales')}`)
      .send({ label: 'overflow' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/10/)
  })
})

// ═════════════════════════════════════════════════════════
// ⑦ 销售归因：注册 → 7 天试用
// ═════════════════════════════════════════════════════════
describe('POST /api/app/auth/register 销售归因 7 天试用', () => {
  beforeEach(async () => {
    await prisma.userMembership.deleteMany()
    await cleanSalesTables()
  })

  it('带有效 salesCode 注册 → UserMembership 记录 SALES_REFERRAL + 7 天有效期', async () => {
    const { salesCode } = await createSalesAccount({})
    // 手工插 VerificationCode 绕过真实短信
    const phone = '13555550001'
    await prisma.verificationCode.create({
      data: {
        id: `test-${Date.now()}`,
        target: phone,
        type: 'phone',
        code: '111222',
        purpose: 'register',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    })

    const res = await request(app)
      .post('/api/app/auth/register')
      .send({
        phone,
        smsCode: '111222',
        password: 'regpass123',
        salesCode,
      })
    expect(res.status).toBe(201)
    const newUser = await prisma.appUser.findUnique({ where: { phone } })
    expect(newUser?.salesCode).toBe(salesCode)

    const ms = await prisma.userMembership.findFirst({ where: { userId: newUser!.id } })
    expect(ms).not.toBeNull()
    expect(ms?.source).toBe('SALES_REFERRAL')
    expect(ms?.salesCode).toBe(salesCode)
    expect(ms?.planId).toBe('personal')
    const durationMs = new Date(ms!.endAt).getTime() - new Date(ms!.startAt).getTime()
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
    expect(Math.abs(durationMs - sevenDaysMs)).toBeLessThan(1000)  // 容差 1s
  })

  it('带无效 salesCode → 注册成功但无销售归因会员', async () => {
    const phone = '13555550002'
    await prisma.verificationCode.create({
      data: {
        id: `test-invalid-${Date.now()}`,
        target: phone,
        type: 'phone',
        code: '333444',
        purpose: 'register',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    })
    const res = await request(app)
      .post('/api/app/auth/register')
      .send({
        phone,
        smsCode: '333444',
        password: 'regpass123',
        salesCode: 'INVALIDX',
      })
    expect(res.status).toBe(201)
    const newUser = await prisma.appUser.findUnique({ where: { phone } })
    expect(newUser?.salesCode).toBeNull()  // 无效 code 静默忽略
    const ms = await prisma.userMembership.findFirst({
      where: { userId: newUser!.id, source: 'SALES_REFERRAL' },
    })
    expect(ms).toBeNull()
  })
})

afterAll(async () => {
  await cleanSalesTables()
  await prisma.$disconnect()
})
