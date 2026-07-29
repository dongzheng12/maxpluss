/**
 * POST /api/admin/roles/batch-assign — 批量分配销售角色
 *
 * 覆盖：happy path / 权限拦截 / 边界（重复手机号、未注册、已是销售、admin 转销售拒绝、上限）
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { registerStaffRoutes } from '../src/staffRoutes.js'
import { ensureBuiltInRoles, SALES_BUILT_IN_ROLE_NAME } from '../src/services/builtInRoles.js'
import { createUser, getTestToken, ensurePlans } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  registerStaffRoutes(app)
  await ensureAppSeed()
})

beforeEach(async () => {
  // Prisma deleteMany 不支持 nested relation filter,先 findMany 拿 id 再扁平 deleteMany
  // 删除顺序按 FK 依赖：SalesCode → SalesProfile → AdminUserRole → AppUser
  const testUsers = await prisma.appUser.findMany({
    where: { phone: { startsWith: '13911' } },
    select: { id: true },
  })
  const testUserIds = testUsers.map(u => u.id)
  if (testUserIds.length > 0) {
    const profiles = await prisma.salesProfile.findMany({
      where: { userId: { in: testUserIds } },
      select: { id: true },
    })
    const profileIds = profiles.map(p => p.id)
    if (profileIds.length > 0) {
      await prisma.salesCode.deleteMany({ where: { profileId: { in: profileIds } } })
    }
    await prisma.adminUserRole.deleteMany({ where: { userId: { in: testUserIds } } })
    await prisma.salesProfile.deleteMany({ where: { userId: { in: testUserIds } } })
  }
  await prisma.appUser.deleteMany({ where: { phone: { startsWith: '13911' } } })
  await ensureBuiltInRoles('test')
})

describe('POST /api/admin/roles/batch-assign — happy path', () => {
  it('已注册 user × 2 → assigned × 2，SalesProfile 默认 isPublic=false', async () => {
    const admin = await createUser({ role: 'admin', phone: '13911000001' })
    const u1 = await createUser({ phone: '13911000010' })
    const u2 = await createUser({ phone: '13911000011' })

    const res = await request(app)
      .post('/api/admin/roles/batch-assign')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ phones: ['13911000010', '13911000011'], roleType: 'sales' })

    expect(res.status).toBe(200)
    expect(res.body.assigned).toHaveLength(2)
    expect(res.body.skipped).toEqual([])
    expect(res.body.notFound).toEqual([])

    // SalesProfile 默认 isPublic=false（核心边界）
    const p1 = await prisma.salesProfile.findUnique({ where: { userId: u1.id } })
    const p2 = await prisma.salesProfile.findUnique({ where: { userId: u2.id } })
    expect(p1?.isPublic).toBe(false)
    expect(p2?.isPublic).toBe(false)

    // AdminUserRole 已分配"销售"角色
    const salesRole = await prisma.adminRole.findUnique({ where: { name: SALES_BUILT_IN_ROLE_NAME } })
    const assigns = await prisma.adminUserRole.findMany({
      where: { roleId: salesRole!.id, userId: { in: [u1.id, u2.id] } },
    })
    expect(assigns).toHaveLength(2)
  })

  it('未注册手机号 → notFound，已注册 → assigned', async () => {
    const admin = await createUser({ role: 'admin', phone: '13911000002' })
    await createUser({ phone: '13911000020' })

    const res = await request(app)
      .post('/api/admin/roles/batch-assign')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ phones: ['13911000020', '13911000099'], roleType: 'sales' })

    expect(res.status).toBe(200)
    expect(res.body.assigned).toHaveLength(1)
    expect(res.body.notFound).toEqual(['13911000099'])
  })
})

describe('POST /api/admin/roles/batch-assign — 幂等', () => {
  it('已是销售（已有 SalesProfile + sales 角色）→ skipped', async () => {
    const admin = await createUser({ role: 'admin', phone: '13911000003' })
    const existing = await createUser({ phone: '13911000030' })

    // 第一次：assigned
    await request(app)
      .post('/api/admin/roles/batch-assign')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ phones: ['13911000030'], roleType: 'sales' })

    // 第二次：skipped
    const res = await request(app)
      .post('/api/admin/roles/batch-assign')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ phones: ['13911000030'], roleType: 'sales' })

    expect(res.status).toBe(200)
    expect(res.body.assigned).toEqual([])
    expect(res.body.skipped).toHaveLength(1)
    expect(res.body.skipped[0].phone).toBe('13911000030')
    expect(res.body.skipped[0].reason).toContain('已是销售')

    // 不会重复创建 SalesProfile
    const profiles = await prisma.salesProfile.findMany({ where: { userId: existing.id } })
    expect(profiles).toHaveLength(1)
  })
})

describe('POST /api/admin/roles/batch-assign — 边界', () => {
  it('admin 角色用户 → skipped 含"管理员不能转为销售"', async () => {
    const admin = await createUser({ role: 'admin', phone: '13911000004' })
    await createUser({ phone: '13911000040', role: 'admin' })

    const res = await request(app)
      .post('/api/admin/roles/batch-assign')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ phones: ['13911000040'], roleType: 'sales' })

    expect(res.status).toBe(200)
    expect(res.body.assigned).toEqual([])
    expect(res.body.skipped).toHaveLength(1)
    expect(res.body.skipped[0].reason).toContain('管理员不能转为销售')
  })

  it('重复手机号自动去重 + 非法格式进 invalid', async () => {
    const admin = await createUser({ role: 'admin', phone: '13911000005' })
    await createUser({ phone: '13911000050' })

    const res = await request(app)
      .post('/api/admin/roles/batch-assign')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ phones: ['13911000050', '13911000050', '12345', 'abc'], roleType: 'sales' })

    expect(res.status).toBe(200)
    expect(res.body.assigned).toHaveLength(1)
    expect(res.body.invalid.sort()).toEqual(['12345', 'abc'])
  })

  it('phones 超 100 → 400', async () => {
    const admin = await createUser({ role: 'admin', phone: '13911000006' })
    const phones = Array.from({ length: 101 }, (_, i) => `139${String(i).padStart(8, '0')}`)

    const res = await request(app)
      .post('/api/admin/roles/batch-assign')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ phones, roleType: 'sales' })

    // 100 → 进入业务逻辑；101 → zod max(100) 拒绝
    expect(res.status).toBe(400)
  })

  it('phones 为空 → 400', async () => {
    const admin = await createUser({ role: 'admin', phone: '13911000007' })
    const res = await request(app)
      .post('/api/admin/roles/batch-assign')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ phones: [], roleType: 'sales' })

    expect(res.status).toBe(400)
  })

  it('roleType 必须为 "sales"（本期边界）', async () => {
    const admin = await createUser({ role: 'admin', phone: '13911000008' })
    const res = await request(app)
      .post('/api/admin/roles/batch-assign')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ phones: ['13911000080'], roleType: 'admin' })

    expect(res.status).toBe(400)
  })
})

describe('POST /api/admin/roles/batch-assign — 权限', () => {
  it('未登录 → 401', async () => {
    const res = await request(app)
      .post('/api/admin/roles/batch-assign')
      .send({ phones: ['13911000090'], roleType: 'sales' })
    expect(res.status).toBe(401)
  })

  it('普通 user → 403', async () => {
    const u = await createUser({ phone: '13911000009' })
    const res = await request(app)
      .post('/api/admin/roles/batch-assign')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
      .send({ phones: ['13911000091'], roleType: 'sales' })
    expect(res.status).toBe(403)
  })
})
