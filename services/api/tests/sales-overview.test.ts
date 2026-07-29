/**
 * GET /api/admin/sales/overview + GET /api/admin/sales/overview/:salesCode/orders
 *  + POST /api/app/sales/profile/init
 *
 * 覆盖：admin 200 / sales 403 / user 403 / 数据汇总正确性 / init 幂等
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { registerSalesRoutes } from '../src/salesRoutes.js'
import { createUser, getTestToken, ensurePlans } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  registerSalesRoutes(app)
  await ensureAppSeed()
})

beforeEach(async () => {
  // 清测试用数据。Prisma deleteMany 不支持 nested relation filter,
  // 用 findMany 先拿 id 再 deleteMany by id
  // 删除顺序按 FK：AppOrder → SalesCode → SalesProfile → AdminUserRole → AppUser
  const testUsers = await prisma.appUser.findMany({
    where: { phone: { startsWith: '13913' } },
    select: { id: true },
  })
  const testUserIds = testUsers.map(u => u.id)

  // 1. 清按 userId 关联订单（包括 buyer 订单）
  if (testUserIds.length > 0) {
    await prisma.appOrder.deleteMany({ where: { userId: { in: testUserIds } } })
  }
  // 2. 清按 salesCode 关联订单（OVR 前缀，归属测试销售的）
  await prisma.appOrder.deleteMany({ where: { salesCode: { startsWith: 'OVR' } } })

  // 3. 清 OVR 前缀 SalesProfile 的 SalesCode（FK 依赖）
  const profilesByCode = await prisma.salesProfile.findMany({
    where: { salesCode: { startsWith: 'OVR' } },
    select: { id: true },
  })
  const profileIdsByCode = profilesByCode.map(p => p.id)
  if (profileIdsByCode.length > 0) {
    await prisma.salesCode.deleteMany({ where: { profileId: { in: profileIdsByCode } } })
  }
  // 4. 清按 userId 关联 SalesProfile（admin profile/init 创建的也在这里）
  if (testUserIds.length > 0) {
    const profilesByUser = await prisma.salesProfile.findMany({
      where: { userId: { in: testUserIds } },
      select: { id: true },
    })
    const profileIdsByUser = profilesByUser.map(p => p.id)
    if (profileIdsByUser.length > 0) {
      await prisma.salesCode.deleteMany({ where: { profileId: { in: profileIdsByUser } } })
    }
    await prisma.salesProfile.deleteMany({ where: { userId: { in: testUserIds } } })
    await prisma.adminUserRole.deleteMany({ where: { userId: { in: testUserIds } } })
  }
  // 5. 清残留 OVR SalesProfile
  await prisma.salesProfile.deleteMany({ where: { salesCode: { startsWith: 'OVR' } } })
  // 6. 清 user
  await prisma.appUser.deleteMany({ where: { phone: { startsWith: '13913' } } })
})

describe('GET /api/admin/sales/overview — 权限', () => {
  it('未登录 → 401', async () => {
    const res = await request(app).get('/api/admin/sales/overview')
    expect(res.status).toBe(401)
  })

  it('普通 user → 403', async () => {
    const u = await createUser({ phone: '13913000001' })
    const res = await request(app)
      .get('/api/admin/sales/overview')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
    expect(res.status).toBe(403)
  })

  it('sales role → 403（看板仅 admin 可见）', async () => {
    const s = await createUser({ phone: '13913000002', role: 'sales' })
    const res = await request(app)
      .get('/api/admin/sales/overview')
      .set('Authorization', `Bearer ${getTestToken(s.id, 'sales')}`)
    expect(res.status).toBe(403)
  })

  it('admin → 200', async () => {
    const a = await createUser({ phone: '13913000003', role: 'admin' })
    const res = await request(app)
      .get('/api/admin/sales/overview')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('summary')
    expect(res.body).toHaveProperty('items')
    expect(res.body.summary).toHaveProperty('salesCount')
    expect(res.body.summary).toHaveProperty('totalRegistered')
    expect(res.body.summary).toHaveProperty('totalPaidUsers')
    expect(res.body.summary).toHaveProperty('totalPaidAmount')
  })
})

describe('GET /api/admin/sales/overview — 数据汇总', () => {
  it('summary 与 items 数据一致', async () => {
    const a = await createUser({ phone: '13913000010', role: 'admin' })
    const sales1 = await createUser({ phone: '13913000020' })
    const sales2 = await createUser({ phone: '13913000021' })

    // 建两个销售档案
    await prisma.salesProfile.create({
      data: { salesCode: 'OVR00001', userId: sales1.id, realName: '销售一' },
    })
    await prisma.salesProfile.create({
      data: { salesCode: 'OVR00002', userId: sales2.id, realName: '销售二' },
    })

    // 给 OVR00001 归属 2 个注册用户 + 1 个付费订单
    const u1 = await createUser({ phone: '13913000030' })
    const u2 = await createUser({ phone: '13913000031' })
    await prisma.appUser.update({ where: { id: u1.id }, data: { salesCode: 'OVR00001' } })
    await prisma.appUser.update({ where: { id: u2.id }, data: { salesCode: 'OVR00001' } })
    await prisma.appOrder.create({
      data: {
        orderNo: `OVRORD-${Date.now()}-1`,
        userId: u1.id,
        productType: 'MEMBERSHIP',
        title: 'test',
        amount: 10000,
        status: 'PAID',
        salesCode: 'OVR00001',
        paidAt: new Date(),
      },
    })

    const res = await request(app)
      .get('/api/admin/sales/overview')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)

    expect(res.status).toBe(200)
    expect(res.body.summary.salesCount).toBeGreaterThanOrEqual(2)

    const ovr1 = res.body.items.find((i: any) => i.salesCode === 'OVR00001')
    expect(ovr1).toBeDefined()
    expect(ovr1.registerCount).toBe(2)
    expect(ovr1.paidUserCount).toBe(1)
    expect(ovr1.paidAmount).toBe(10000)
    expect(ovr1.realName).toBe('销售一')
  })
})

describe('GET /api/admin/sales/overview/:salesCode/orders', () => {
  it('admin 看订单明细 200，含 user.phone', async () => {
    const a = await createUser({ phone: '13913000050', role: 'admin' })
    const s = await createUser({ phone: '13913000051' })
    await prisma.salesProfile.create({
      data: { salesCode: 'OVR00050', userId: s.id, realName: '销售看明细' },
    })
    const buyer = await createUser({ phone: '13913000052' })
    await prisma.appOrder.create({
      data: {
        orderNo: `OVRORD-${Date.now()}-50`,
        userId: buyer.id,
        productType: 'MEMBERSHIP',
        title: 'test order',
        amount: 59800,
        status: 'PAID',
        salesCode: 'OVR00050',
        paidAt: new Date(),
      },
    })

    const res = await request(app)
      .get('/api/admin/sales/overview/OVR00050/orders')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)

    expect(res.status).toBe(200)
    expect(res.body.realName).toBe('销售看明细')
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].user.phone).toBe('13913000052')
  })

  it('未知 salesCode → 404', async () => {
    const a = await createUser({ phone: '13913000060', role: 'admin' })
    const res = await request(app)
      .get('/api/admin/sales/overview/NONEXIST/orders')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.status).toBe(404)
  })

  it('sales 看订单明细 → 403', async () => {
    const s = await createUser({ phone: '13913000061', role: 'sales' })
    const res = await request(app)
      .get('/api/admin/sales/overview/OVR00060/orders')
      .set('Authorization', `Bearer ${getTestToken(s.id, 'sales')}`)
    expect(res.status).toBe(403)
  })
})

describe('POST /api/app/sales/profile/init — admin 自助开通', () => {
  it('admin 首次调用 → 200 + created=true', async () => {
    const a = await createUser({ phone: '13913000070', role: 'admin' })
    const res = await request(app)
      .post('/api/app/sales/profile/init')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(true)
    expect(res.body.salesCode).toBeTruthy()

    const profile = await prisma.salesProfile.findUnique({ where: { userId: a.id } })
    expect(profile).toBeTruthy()
    expect(profile?.isPublic).toBe(true) // admin 自助开通默认 public
  })

  it('admin 重复调用 → 200 + created=false（幂等）', async () => {
    const a = await createUser({ phone: '13913000071', role: 'admin' })
    await request(app)
      .post('/api/app/sales/profile/init')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    const res2 = await request(app)
      .post('/api/app/sales/profile/init')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res2.status).toBe(200)
    expect(res2.body.created).toBe(false)
  })

  it('普通 user（无销售角色）→ 403', async () => {
    const u = await createUser({ phone: '13913000072' })
    const res = await request(app)
      .post('/api/app/sales/profile/init')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
    expect(res.status).toBe(403)
  })

  it('已被分配 ACTIVE 销售内置角色的 user（batch-assign 后无 SalesProfile 兜底场景）→ 200', async () => {
    // 模拟 batch-assign 后的状态：user role='user'，但有 ACTIVE 销售内置角色
    // 但故意不建 SalesProfile，触发"补齐"路径
    const u = await createUser({ phone: '13913000074' })

    const { ensureBuiltInRoles, SALES_BUILT_IN_ROLE_NAME } = await import('../src/services/builtInRoles.js')
    await ensureBuiltInRoles('test')
    const salesRole = await prisma.adminRole.findUnique({ where: { name: SALES_BUILT_IN_ROLE_NAME } })
    await prisma.adminUserRole.create({
      data: { userId: u.id, roleId: salesRole!.id, status: 'ACTIVE', assignedBy: 'test' },
    })

    const res = await request(app)
      .post('/api/app/sales/profile/init')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)

    expect(res.status).toBe(200)
    expect(res.body.created).toBe(true)
    expect(res.body.salesCode).toBeTruthy()

    const profile = await prisma.salesProfile.findUnique({ where: { userId: u.id } })
    expect(profile).toBeTruthy()
    expect(profile?.isPublic).toBe(true) // 自助 init 默认 public

    // cleanup（FK：先 SalesCode → SalesProfile → AdminUserRole）
    await prisma.salesCode.deleteMany({ where: { profileId: profile!.id } })
    await prisma.salesProfile.deleteMany({ where: { userId: u.id } })
    await prisma.adminUserRole.deleteMany({ where: { userId: u.id } })
  })

  it('已 DISABLED 销售角色的 user → 403（仅 ACTIVE 角色才放行）', async () => {
    const u = await createUser({ phone: '13913000075' })
    const { ensureBuiltInRoles, SALES_BUILT_IN_ROLE_NAME } = await import('../src/services/builtInRoles.js')
    await ensureBuiltInRoles('test')
    const salesRole = await prisma.adminRole.findUnique({ where: { name: SALES_BUILT_IN_ROLE_NAME } })
    await prisma.adminUserRole.create({
      data: { userId: u.id, roleId: salesRole!.id, status: 'DISABLED', assignedBy: 'test' },
    })

    const res = await request(app)
      .post('/api/app/sales/profile/init')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)

    expect(res.status).toBe(403)

    await prisma.adminUserRole.deleteMany({ where: { userId: u.id } })
  })

  it('sales role 历史用户 → 200（按 user.role==="sales" 也视作有销售身份的兜底路径，但要先 ensure 内置角色; 这里通过分配角色等价）', async () => {
    // 历史 role='sales' 用户没有自动获得 AdminUserRole.sales,
    // 本测试构造"分配了销售内置角色"的 sales 用户走 init 兜底
    const u = await createUser({ phone: '13913000076', role: 'sales' })
    const { ensureBuiltInRoles, SALES_BUILT_IN_ROLE_NAME } = await import('../src/services/builtInRoles.js')
    await ensureBuiltInRoles('test')
    const salesRole = await prisma.adminRole.findUnique({ where: { name: SALES_BUILT_IN_ROLE_NAME } })
    await prisma.adminUserRole.create({
      data: { userId: u.id, roleId: salesRole!.id, status: 'ACTIVE', assignedBy: 'test' },
    })

    const res = await request(app)
      .post('/api/app/sales/profile/init')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'sales')}`)

    expect(res.status).toBe(200)

    const profile = await prisma.salesProfile.findUnique({ where: { userId: u.id } })
    if (profile) {
      await prisma.salesCode.deleteMany({ where: { profileId: profile.id } })
      await prisma.salesProfile.deleteMany({ where: { userId: u.id } })
    }
    await prisma.adminUserRole.deleteMany({ where: { userId: u.id } })
  })

  it('未登录 → 401', async () => {
    const res = await request(app).post('/api/app/sales/profile/init')
    expect(res.status).toBe(401)
  })
})
