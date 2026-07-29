/**
 * 管理员销售接口端到端测试
 *
 * 覆盖最近新增能力：
 *   1. DELETE /api/admin/sales/:id — 删除（含 SalesCode/SalesProfile，user 降级）+ 归因保护
 *   2. POST /api/admin/sales — 升级已注册普通用户 / 边界
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

async function cleanSalesTables() {
  await prisma.appOrder.deleteMany({ where: { orderNo: { startsWith: 'ORD-TEST-ADMIN-' } } })
  await prisma.salesInvite.deleteMany()
  await prisma.salesCode.deleteMany()
  await prisma.salesProfile.deleteMany()
}

/** 创建一个销售（user + profile + 主码 SalesCode），跟生产 POST /admin/sales 路径同构 */
async function seedSalesAccount(opts: { phone?: string; realName?: string } = {}) {
  const user = await createUser({
    phone: opts.phone || `138${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`,
    role: 'sales',
  })
  const salesCode = 'AD' + Math.random().toString(36).slice(2, 8).toUpperCase()
  const profile = await prisma.salesProfile.create({
    data: {
      salesCode,
      userId: user.id,
      realName: opts.realName || '测试销售',
      companyName: '通标中研',
      status: 'ENABLED',
      isPublic: true,
      contactVisible: true,
      companyVisible: true,
      displayProducts: JSON.stringify([{ code: 'xiaozhi', sort: 1 }]),
    },
  })
  await prisma.salesCode.create({
    data: { salesCode, profileId: profile.id, label: '主码', status: 'ACTIVE' },
  })
  return { user, profile, salesCode }
}

// ═════════════════════════════════════════════════════════
// DELETE /api/admin/sales/:id
// ═════════════════════════════════════════════════════════
describe('DELETE /api/admin/sales/:id', () => {
  beforeEach(cleanSalesTables)

  it('happy path：无归因数据 → 200，SalesProfile/SalesCode 删，AppUser.role 降回 user', async () => {
    const admin = await createUser({ role: 'admin' })
    const { user, profile, salesCode } = await seedSalesAccount({ realName: '待删销售' })

    const res = await request(app)
      .delete(`/api/admin/sales/${profile.id}`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    // 数据层验证
    const profileAfter = await prisma.salesProfile.findUnique({ where: { id: profile.id } })
    expect(profileAfter).toBeNull()

    const codesAfter = await prisma.salesCode.findMany({ where: { salesCode } })
    expect(codesAfter).toHaveLength(0)

    const userAfter = await prisma.appUser.findUnique({ where: { id: user.id } })
    expect(userAfter).not.toBeNull()           // 用户保留
    expect(userAfter?.role).toBe('user')        // 角色降级
  })

  it('有归因注册用户 → 200 mode=soft（软删除）', async () => {
    const admin = await createUser({ role: 'admin' })
    const { profile, salesCode } = await seedSalesAccount({})
    await createUser({ phone: '13900009001' }).then(u =>
      prisma.appUser.update({ where: { id: u.id }, data: { salesCode } })
    )

    const res = await request(app)
      .delete(`/api/admin/sales/${profile.id}`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.mode).toBe('soft')

    // 软删除：profile 行还在但 deletedAt 有值
    const profileAfter = await prisma.salesProfile.findUnique({ where: { id: profile.id } })
    expect(profileAfter?.deletedAt).not.toBeNull()
  })

  it('有归因订单 → 200 mode=soft（软删除）', async () => {
    const admin = await createUser({ role: 'admin' })
    const { profile, salesCode } = await seedSalesAccount({})
    await prisma.appOrder.create({
      data: {
        orderNo: `ORD-TEST-ADMIN-${Date.now()}`,
        productType: 'MEMBERSHIP',
        title: '测试订单',
        amount: 100,
        status: 'PAID',
        salesCode,
      },
    })

    const res = await request(app)
      .delete(`/api/admin/sales/${profile.id}`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.mode).toBe('soft')
  })

  it('不存在的 id → 404', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .delete('/api/admin/sales/nonexistent-id')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(404)
  })

  it('无 token → 401', async () => {
    const { profile } = await seedSalesAccount({})
    const res = await request(app).delete(`/api/admin/sales/${profile.id}`)
    expect(res.status).toBe(401)
  })

  it('非 admin token（普通 user）→ 403', async () => {
    const u = await createUser({ role: 'user' })
    const { profile } = await seedSalesAccount({})
    const res = await request(app)
      .delete(`/api/admin/sales/${profile.id}`)
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
    expect(res.status).toBe(403)
  })

  it('非 admin token（sales 自己）→ 403', async () => {
    const { user, profile } = await seedSalesAccount({})
    const res = await request(app)
      .delete(`/api/admin/sales/${profile.id}`)
      .set('Authorization', `Bearer ${getTestToken(user.id, 'sales')}`)
    expect(res.status).toBe(403)
  })
})

// ═════════════════════════════════════════════════════════
// POST /api/admin/sales — 已注册用户升级
// ═════════════════════════════════════════════════════════
describe('POST /api/admin/sales 升级路径', () => {
  beforeEach(cleanSalesTables)

  it('已注册的普通用户（无 SalesProfile）→ 201，role 升 sales，note 含 "升级"，可 password 不传', async () => {
    const admin = await createUser({ role: 'admin' })
    const phone = '13800001111'
    const existing = await createUser({ phone, role: 'user' })

    const res = await request(app)
      .post('/api/admin/sales')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        phone,
        // 不传 password → 升级路径不要求
        realName: '升级销售',
        companyName: '某公司',
      })
    expect(res.status).toBe(201)
    expect(res.body.note).toMatch(/升级/)
    expect(res.body.salesCode).toMatch(/^[A-Z2-9]{8}$/)

    const userAfter = await prisma.appUser.findUnique({ where: { id: existing.id } })
    expect(userAfter?.role).toBe('sales')

    const profile = await prisma.salesProfile.findUnique({ where: { userId: existing.id } })
    expect(profile?.realName).toBe('升级销售')

    // 主码 SalesCode 同步建好
    const mainCode = await prisma.salesCode.findUnique({ where: { salesCode: profile!.salesCode } })
    expect(mainCode?.label).toBe('主码')
  })

  it('已有 SalesProfile 的手机号 → 409 不允许重复绑定', async () => {
    const admin = await createUser({ role: 'admin' })
    const phone = '13800001112'
    await seedSalesAccount({ phone })

    const res = await request(app)
      .post('/api/admin/sales')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        phone,
        password: 'whatever123',
        realName: '重复',
      })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/已配置/)
  })

  it('admin 账号的手机号 → 409 不允许降级', async () => {
    const admin = await createUser({ role: 'admin' })
    const phone = '13800001113'
    await createUser({ phone, role: 'admin' })

    const res = await request(app)
      .post('/api/admin/sales')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        phone,
        password: 'whatever123',
        realName: 'admin转销售',
      })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/管理员/)
  })

  it('全新用户不传 password → 400', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .post('/api/admin/sales')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        phone: '13800001114',  // 全新手机号
        realName: '新销售',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/初始密码/)
  })

  it('全新用户 + password → 201 创建成功', async () => {
    const admin = await createUser({ role: 'admin' })
    const phone = '13800001115'
    const res = await request(app)
      .post('/api/admin/sales')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        phone,
        password: 'newpass123',
        realName: '全新销售',
      })
    expect(res.status).toBe(201)
    expect(res.body).not.toHaveProperty('note')   // 新建路径无 note

    const u = await prisma.appUser.findUnique({ where: { phone } })
    expect(u?.role).toBe('sales')
  })
})

// ═════════════════════════════════════════════════════════
// GET /api/admin/sales/check-phone
// ═════════════════════════════════════════════════════════
describe('GET /api/admin/sales/check-phone', () => {
  beforeEach(cleanSalesTables)

  it('未注册手机号 → exists:false role:null hasSalesProfile:false', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/sales/check-phone?phone=13900099001')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ exists: false, role: null, hasSalesProfile: false })
  })

  it('已注册普通用户（无 SalesProfile）→ exists:true role:user hasSalesProfile:false', async () => {
    const admin = await createUser({ role: 'admin' })
    await createUser({ phone: '13900099002', role: 'user' })
    const res = await request(app)
      .get('/api/admin/sales/check-phone?phone=13900099002')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.body).toEqual({ exists: true, role: 'user', hasSalesProfile: false })
  })

  it('已是销售 → exists:true role:sales hasSalesProfile:true', async () => {
    const admin = await createUser({ role: 'admin' })
    const phone = '13900099003'
    await seedSalesAccount({ phone })
    const res = await request(app)
      .get(`/api/admin/sales/check-phone?phone=${phone}`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.body.exists).toBe(true)
    expect(res.body.role).toBe('sales')
    expect(res.body.hasSalesProfile).toBe(true)
  })

  it('admin 账号 → exists:true role:admin hasSalesProfile:false', async () => {
    const admin = await createUser({ role: 'admin' })
    const phone = '13900099004'
    await createUser({ phone, role: 'admin' })
    const res = await request(app)
      .get(`/api/admin/sales/check-phone?phone=${phone}`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.body.role).toBe('admin')
    expect(res.body.hasSalesProfile).toBe(false)
  })

  it('手机号格式错误 → 400', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/sales/check-phone?phone=invalid')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(400)
  })

  it('无 token → 401', async () => {
    const res = await request(app).get('/api/admin/sales/check-phone?phone=13900099005')
    expect(res.status).toBe(401)
  })

  it('非 admin → 403', async () => {
    const u = await createUser({ role: 'user' })
    const res = await request(app)
      .get('/api/admin/sales/check-phone?phone=13900099006')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
    expect(res.status).toBe(403)
  })
})

// ═════════════════════════════════════════════════════════
// GET /api/admin/sales/:id/registrations
// ═════════════════════════════════════════════════════════
describe('GET /api/admin/sales/:id/registrations', () => {
  beforeEach(cleanSalesTables)

  it('正常分页 → 200，返回脱敏 phone + 注册时间 + hasPaid', async () => {
    const admin = await createUser({ role: 'admin' })
    const { profile, salesCode } = await seedSalesAccount({})
    // 造 3 个归因用户，1 个有 PAID 订单
    const u1 = await createUser({ phone: '13888881001' })
    const u2 = await createUser({ phone: '13888881002' })
    const u3 = await createUser({ phone: '13888881003' })
    for (const u of [u1, u2, u3]) {
      await prisma.appUser.update({ where: { id: u.id }, data: { salesCode } })
    }
    await prisma.appOrder.create({
      data: {
        orderNo: `ORD-TEST-ADMIN-PAID-${Date.now()}`,
        userId: u1.id,
        productType: 'MEMBERSHIP',
        title: '已付订单',
        amount: 100,
        status: 'PAID',
        salesCode,
      },
    })

    const res = await request(app)
      .get(`/api/admin/sales/${profile.id}/registrations?page=1&pageSize=10`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(3)
    expect(res.body.items).toHaveLength(3)
    // phone 脱敏（138****）
    for (const it of res.body.items) {
      expect(it.phone).toMatch(/\*+/)
    }
    // u1 应标 hasPaid:true
    const paid = res.body.items.find((it: any) => it.id === u1.id)
    expect(paid?.hasPaid).toBe(true)
  })

  it('销售不存在 → 404', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/sales/nonexistent/registrations')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(404)
  })

  it('无 token → 401', async () => {
    const { profile } = await seedSalesAccount({})
    const res = await request(app).get(`/api/admin/sales/${profile.id}/registrations`)
    expect(res.status).toBe(401)
  })

  it('非 admin → 403', async () => {
    const u = await createUser({ role: 'user' })
    const { profile } = await seedSalesAccount({})
    const res = await request(app)
      .get(`/api/admin/sales/${profile.id}/registrations`)
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
    expect(res.status).toBe(403)
  })
})

// ═════════════════════════════════════════════════════════
// GET /api/admin/sales/:id/orders
// ═════════════════════════════════════════════════════════
describe('GET /api/admin/sales/:id/orders', () => {
  beforeEach(cleanSalesTables)

  it('正常分页 → 200，只返回 PAID 订单 + 脱敏手机', async () => {
    const admin = await createUser({ role: 'admin' })
    const { profile, salesCode } = await seedSalesAccount({})
    const u1 = await createUser({ phone: '13888882001' })

    // 1 个 PAID + 1 个 PENDING（不应出现）
    await prisma.appOrder.create({
      data: {
        orderNo: `ORD-TEST-ADMIN-PAID-${Date.now()}-1`,
        userId: u1.id,
        productType: 'MEMBERSHIP',
        title: '会员订单',
        amount: 59800,
        status: 'PAID',
        salesCode,
        paidAt: new Date(),
      },
    })
    await prisma.appOrder.create({
      data: {
        orderNo: `ORD-TEST-ADMIN-PEND-${Date.now()}-2`,
        userId: u1.id,
        productType: 'MEMBERSHIP',
        title: '挂单',
        amount: 100,
        status: 'PENDING',
        salesCode,
      },
    })

    const res = await request(app)
      .get(`/api/admin/sales/${profile.id}/orders?page=1&pageSize=10`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)         // 只有 PAID
    expect(res.body.items[0].phone).toMatch(/\*+/)
    expect(res.body.items[0].amount).toBe(59800)
  })

  it('销售不存在 → 404', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/sales/nonexistent/orders')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(404)
  })

  it('无 token → 401', async () => {
    const { profile } = await seedSalesAccount({})
    const res = await request(app).get(`/api/admin/sales/${profile.id}/orders`)
    expect(res.status).toBe(401)
  })

  it('非 admin → 403', async () => {
    const u = await createUser({ role: 'user' })
    const { profile } = await seedSalesAccount({})
    const res = await request(app)
      .get(`/api/admin/sales/${profile.id}/orders`)
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
    expect(res.status).toBe(403)
  })
})

// ═════════════════════════════════════════════════════════
// DELETE /api/admin/sales/:id 软删除（有归因数据时）
// ═════════════════════════════════════════════════════════
describe('DELETE /api/admin/sales/:id 软删除', () => {
  beforeEach(cleanSalesTables)

  it('有归因订单 → 200 mode=soft，profile.deletedAt 被设置 + status=DISABLED + 列表过滤掉', async () => {
    const admin = await createUser({ role: 'admin' })
    const { profile, salesCode } = await seedSalesAccount({})
    await prisma.appOrder.create({
      data: {
        orderNo: `ORD-TEST-ADMIN-SOFT-${Date.now()}`,
        productType: 'MEMBERSHIP', title: '订单', amount: 100, status: 'PAID',
        salesCode,
      },
    })

    const res = await request(app)
      .delete(`/api/admin/sales/${profile.id}`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.mode).toBe('soft')

    // profile 行还在，但 deletedAt 有值 + status=DISABLED
    const after = await prisma.salesProfile.findUnique({ where: { id: profile.id } })
    expect(after).not.toBeNull()
    expect(after?.deletedAt).not.toBeNull()
    expect(after?.status).toBe('DISABLED')

    // 列表查询应该过滤掉
    const listRes = await request(app)
      .get('/api/admin/sales')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(listRes.body.items.find((it: any) => it.id === profile.id)).toBeUndefined()
  })

  it('已软删的 profile 再次 DELETE → 404', async () => {
    const admin = await createUser({ role: 'admin' })
    const { profile } = await seedSalesAccount({})
    await prisma.salesProfile.update({ where: { id: profile.id }, data: { deletedAt: new Date() } })

    const res = await request(app)
      .delete(`/api/admin/sales/${profile.id}`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(404)
  })
})

afterAll(async () => {
  await cleanSalesTables()
  await prisma.$disconnect()
})
