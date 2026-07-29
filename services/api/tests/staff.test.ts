/**
 * staffRoutes 端到端测试
 *
 * 覆盖 8 个接口：
 *   GET    /api/admin/me/permissions
 *   GET    /api/admin/staff
 *   GET    /api/admin/staff/search?phone=
 *   POST   /api/admin/staff/set-admin
 *   DELETE /api/admin/staff/:id/unset-admin
 *   POST   /api/admin/staff/:id/set-sales
 *   PATCH  /api/admin/staff/:id/roles
 *   PATCH  /api/admin/staff/:id/toggle
 *
 * 风格参考 tests/sales-admin.test.ts。
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { registerStaffRoutes } from '../src/staffRoutes.js'
import { registerRoleRoutes } from '../src/roleRoutes.js'
import { createUser, getTestToken, ensurePlans } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  registerStaffRoutes(app)
  registerRoleRoutes(app) // 给"分配角色"用例用到 GET /api/admin/roles 创建角色的能力
  await ensureAppSeed()
})

/**
 * 清 staff/role 测试相关数据。
 * 不删 AppUser（其它表如 UserCoupon FK 会拦），靠 createUser 的 random phone 避免冲突。
 * 与 sales-admin.test.ts 风格一致。
 */
async function cleanRbacAndUsers() {
  await prisma.adminUserRole.deleteMany()
  await prisma.adminRole.deleteMany()
  await prisma.salesCode.deleteMany()
  await prisma.salesProfile.deleteMany()
}

// ═════════════════════════════════════════════════════════
// GET /api/admin/me/permissions
// ═════════════════════════════════════════════════════════
describe('GET /api/admin/me/permissions', () => {
  beforeEach(cleanRbacAndUsers)

  it('admin 返回通配符全权限', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/me/permissions')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.isAdmin).toBe(true)
    expect(res.body.hasAdminAccess).toBe(true)
    expect(res.body.menuPaths).toContain('*')
    expect(res.body.actionKeys).toContain('*')
  })

  it('sales 返回销售工作台白名单（信号 1：role=sales）', async () => {
    const sales = await createUser({ role: 'sales' })
    const res = await request(app)
      .get('/api/admin/me/permissions')
      .set('Authorization', `Bearer ${getTestToken(sales.id, 'sales')}`)
    expect(res.status).toBe(200)
    expect(res.body.isSales).toBe(true)
    expect(res.body.hasAdminAccess).toBe(true)
    expect(res.body.menuPaths).toContain('/admin/sales/workspace')
    expect(res.body.menuPaths).toContain('/admin')
  })

  it('信号 2：role=user 但持有"销售"内置角色 → isSales=true', async () => {
    const { ensureSalesBuiltInRole } = await import('../src/services/builtInRoles.js')
    const admin = await createUser({ role: 'admin' })
    const u = await createUser({ role: 'user' })
    const salesRole = await ensureSalesBuiltInRole(admin.id)
    await prisma.adminUserRole.create({
      data: { userId: u.id, roleId: salesRole.id, status: 'ACTIVE', assignedBy: admin.id },
    })
    const res = await request(app)
      .get('/api/admin/me/permissions')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
    expect(res.status).toBe(200)
    expect(res.body.isSales).toBe(true)
    expect(res.body.hasAdminAccess).toBe(true)
    expect(res.body.menuPaths).toContain('/admin/sales/workspace')
  })

  it('信号 3：role=user 无角色但有 SalesProfile → isSales=true', async () => {
    const u = await createUser({ role: 'user' })
    await prisma.salesProfile.create({
      data: { salesCode: 'SIG3TEST', userId: u.id, realName: '档案信号' },
    })
    const res = await request(app)
      .get('/api/admin/me/permissions')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
    expect(res.status).toBe(200)
    expect(res.body.isSales).toBe(true)
    expect(res.body.hasAdminAccess).toBe(true)
    expect(res.body.menuPaths).toContain('/admin/sales/workspace')
  })

  it('撤销销售角色但 SalesProfile 仍存在 → isSales 仍 true（v3 §5）', async () => {
    const { ensureSalesBuiltInRole } = await import('../src/services/builtInRoles.js')
    const admin = await createUser({ role: 'admin' })
    const u = await createUser({ role: 'user' })
    const salesRole = await ensureSalesBuiltInRole(admin.id)
    // 同时给销售角色 + SalesProfile
    await prisma.adminUserRole.create({
      data: { userId: u.id, roleId: salesRole.id, status: 'ACTIVE', assignedBy: admin.id },
    })
    await prisma.salesProfile.create({
      data: { salesCode: 'KEEPSALE', userId: u.id, realName: '撤角色后保留' },
    })
    // 撤角色
    await prisma.adminUserRole.deleteMany({ where: { userId: u.id } })
    // /me/permissions 仍应 isSales=true（档案信号兜底）
    const res = await request(app)
      .get('/api/admin/me/permissions')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
    expect(res.body.isSales).toBe(true)
    expect(res.body.menuPaths).toContain('/admin/sales/workspace')
  })

  it('SalesProfile.status=DISABLED → 不再算销售（v3 §5 留二期专项接口的预留）', async () => {
    const u = await createUser({ role: 'user' })
    await prisma.salesProfile.create({
      data: { salesCode: 'DISABLED1', userId: u.id, realName: '禁用档案', status: 'DISABLED' },
    })
    const res = await request(app)
      .get('/api/admin/me/permissions')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
    expect(res.body.isSales).toBe(false)
    expect(res.body.menuPaths).not.toContain('/admin/sales/workspace')
  })

  it('普通 user 无角色：hasAdminAccess=false menuPaths=[]', async () => {
    const user = await createUser({ role: 'user' })
    const res = await request(app)
      .get('/api/admin/me/permissions')
      .set('Authorization', `Bearer ${getTestToken(user.id, 'user')}`)
    expect(res.status).toBe(200)
    expect(res.body.hasAdminAccess).toBe(false)
    expect(res.body.isStaff).toBe(false)
    expect(res.body.menuPaths).toEqual([])
  })

  it('staff (user + ACTIVE AdminUserRole)：返回该角色的菜单合集', async () => {
    const admin = await createUser({ role: 'admin' })
    const user = await createUser({ role: 'user' })
    const role = await prisma.adminRole.create({
      data: {
        name: 'staff-perm-test-role',
        menuPermissions: ['/admin/announcements', '/admin/content-config'],
        actionPermissions: ['admin.announcements.manage'],
        createdBy: admin.id,
      },
    })
    await prisma.adminUserRole.create({
      data: { userId: user.id, roleId: role.id, status: 'ACTIVE', assignedBy: admin.id },
    })
    const res = await request(app)
      .get('/api/admin/me/permissions')
      .set('Authorization', `Bearer ${getTestToken(user.id, 'user')}`)
    expect(res.status).toBe(200)
    expect(res.body.isStaff).toBe(true)
    expect(res.body.hasAdminAccess).toBe(true)
    expect(res.body.menuPaths).toEqual(expect.arrayContaining(['/admin/announcements', '/admin/content-config']))
    expect(res.body.actionKeys).toContain('admin.announcements.manage')
  })

  it('无 token → 401', async () => {
    const res = await request(app).get('/api/admin/me/permissions')
    expect(res.status).toBe(401)
  })
})

// ═════════════════════════════════════════════════════════
// GET /api/admin/staff
// ═════════════════════════════════════════════════════════
describe('GET /api/admin/staff', () => {
  beforeEach(cleanRbacAndUsers)

  it('admin 可访问，返回 admin + sales + has-AdminUserRole 的 user', async () => {
    const admin = await createUser({ role: 'admin' })
    const sales = await createUser({ role: 'sales' })
    const user1 = await createUser({ role: 'user' }) // 无角色，不应出现
    const user2 = await createUser({ role: 'user' }) // 有角色，应出现
    const role = await prisma.adminRole.create({
      data: { name: 'staff-list-role', createdBy: admin.id },
    })
    await prisma.adminUserRole.create({
      data: { userId: user2.id, roleId: role.id, status: 'ACTIVE', assignedBy: admin.id },
    })

    const res = await request(app)
      .get('/api/admin/staff')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    const ids = (res.body.items as Array<{ id: string }>).map((u) => u.id)
    expect(ids).toContain(admin.id)
    expect(ids).toContain(sales.id)
    expect(ids).toContain(user2.id)
    expect(ids).not.toContain(user1.id)
  })

  it('sales 访问 → 403', async () => {
    const sales = await createUser({ role: 'sales' })
    const res = await request(app)
      .get('/api/admin/staff')
      .set('Authorization', `Bearer ${getTestToken(sales.id, 'sales')}`)
    expect(res.status).toBe(403)
  })

  it('回归：role=user + AdminUserRole + SalesProfile → items 含 salesProfile 字段不为 null', async () => {
    // 防止 staffUsers 分支再次漏 select salesProfile
    // 之前 bug：role=user + 销售角色 + 已有 SalesProfile 时，列表里 salesProfile=null
    // 导致前端"销售状态"误判为"待初始化"
    const admin = await createUser({ role: 'admin' })
    const u = await createUser({ role: 'user' })
    const salesRole = await prisma.adminRole.create({ data: { name: 'staff-list-sales-mock', createdBy: admin.id } })
    await prisma.adminUserRole.create({
      data: { userId: u.id, roleId: salesRole.id, status: 'ACTIVE', assignedBy: admin.id },
    })
    await prisma.salesProfile.create({
      data: { salesCode: 'JOINFIX1', userId: u.id, realName: 'JOIN 修复测试' },
    })

    const res = await request(app)
      .get('/api/admin/staff')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    const found = (res.body.items as Array<any>).find((x) => x.id === u.id)
    expect(found).toBeTruthy()
    expect(found.salesProfile).not.toBeNull()
    expect(found.salesProfile.salesCode).toBe('JOINFIX1')
  })

  it('user 访问 → 403', async () => {
    const user = await createUser({ role: 'user' })
    const res = await request(app)
      .get('/api/admin/staff')
      .set('Authorization', `Bearer ${getTestToken(user.id, 'user')}`)
    expect(res.status).toBe(403)
  })
})

// ═════════════════════════════════════════════════════════
// GET /api/admin/staff/search
// ═════════════════════════════════════════════════════════
describe('GET /api/admin/staff/search', () => {
  beforeEach(cleanRbacAndUsers)

  it('找到用户 → 200 + user 字段（含 salesProfile / adminRoles 空形）', async () => {
    const admin = await createUser({ role: 'admin' })
    const target = await createUser({ phone: '13912345678', role: 'user' })
    const res = await request(app)
      .get('/api/admin/staff/search?phone=13912345678')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(target.id)
    expect(res.body.user.phone).toBe('13912345678')
    expect(res.body.user.salesProfile).toBeNull()
    expect(res.body.user.adminRoles).toEqual([])
  })

  it('用户已分配角色 + 销售档案 → adminRoles / salesProfile 都回填', async () => {
    const { ensureSalesBuiltInRole } = await import('../src/services/builtInRoles.js')
    const admin = await createUser({ role: 'admin' })
    const u = await createUser({ phone: '13912345699', role: 'user' })
    const salesRole = await ensureSalesBuiltInRole(admin.id)
    const customRole = await prisma.adminRole.create({
      data: { name: '专家智库-test', menuPermissions: [], actionPermissions: [], createdBy: admin.id },
    })
    await prisma.adminUserRole.createMany({
      data: [
        { userId: u.id, roleId: salesRole.id, status: 'ACTIVE', assignedBy: admin.id },
        { userId: u.id, roleId: customRole.id, status: 'ACTIVE', assignedBy: admin.id },
      ],
    })
    await prisma.salesProfile.create({
      data: { salesCode: 'TST0001', userId: u.id, realName: 'tester' },
    })
    const res = await request(app)
      .get('/api/admin/staff/search?phone=13912345699')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.user.salesProfile?.salesCode).toBe('TST0001')
    expect(res.body.user.adminRoles).toHaveLength(2)
    const names = res.body.user.adminRoles.map((r: { name: string }) => r.name).sort()
    expect(names).toEqual(['专家智库-test', '销售'])
    for (const r of res.body.user.adminRoles) {
      expect(r.status).toBe('ACTIVE')
      expect(r.roleStatus).toBe('ACTIVE')
      expect(typeof r.id).toBe('string')
    }
  })

  it('找不到用户 → 404', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/staff/search?phone=13900000099')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(404)
  })

  it('参数缺失 / 非法手机号 → 400', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/staff/search?phone=abc')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(400)
  })
})

// ═════════════════════════════════════════════════════════
// POST /api/admin/staff/set-admin
// ═════════════════════════════════════════════════════════
describe('POST /api/admin/staff/set-admin', () => {
  beforeEach(cleanRbacAndUsers)

  it('happy path：user → admin', async () => {
    const admin = await createUser({ role: 'admin' })
    const target = await createUser({ phone: '13911111101', role: 'user' })
    const res = await request(app)
      .post('/api/admin/staff/set-admin')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ phone: '13911111101' })
    expect(res.status).toBe(200)
    const after = await prisma.appUser.findUnique({ where: { id: target.id } })
    expect(after?.role).toBe('admin')
  })

  it('已是 admin → 409', async () => {
    const admin = await createUser({ role: 'admin' })
    await createUser({ phone: '13911111102', role: 'admin' })
    const res = await request(app)
      .post('/api/admin/staff/set-admin')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ phone: '13911111102' })
    expect(res.status).toBe(409)
  })

  it('非 admin 调用 → 403', async () => {
    const sales = await createUser({ role: 'sales' })
    const res = await request(app)
      .post('/api/admin/staff/set-admin')
      .set('Authorization', `Bearer ${getTestToken(sales.id, 'sales')}`)
      .send({ phone: '13911111103' })
    expect(res.status).toBe(403)
  })
})

// ═════════════════════════════════════════════════════════
// DELETE /api/admin/staff/:id/unset-admin
// ═════════════════════════════════════════════════════════
describe('DELETE /api/admin/staff/:id/unset-admin', () => {
  beforeEach(cleanRbacAndUsers)

  it('happy path：admin → user', async () => {
    const admin = await createUser({ role: 'admin' })
    const target = await createUser({ role: 'admin' })
    const res = await request(app)
      .delete(`/api/admin/staff/${target.id}/unset-admin`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    const after = await prisma.appUser.findUnique({ where: { id: target.id } })
    expect(after?.role).toBe('user')
  })

  it('对自己操作 → 403（不能自降）', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .delete(`/api/admin/staff/${admin.id}/unset-admin`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(403)
  })

  it('对非 admin 用户 → 409', async () => {
    const admin = await createUser({ role: 'admin' })
    const target = await createUser({ role: 'user' })
    const res = await request(app)
      .delete(`/api/admin/staff/${target.id}/unset-admin`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(409)
  })
})

// ═════════════════════════════════════════════════════════
// POST /api/admin/staff/:id/set-sales
// ═════════════════════════════════════════════════════════
describe('POST /api/admin/staff/:id/set-sales', () => {
  beforeEach(cleanRbacAndUsers)

  it('happy path：分配销售角色 + 自动建 SalesProfile + 主推码（不改 role）', async () => {
    const admin = await createUser({ role: 'admin' })
    const target = await createUser({ role: 'user' })
    const res = await request(app)
      .post(`/api/admin/staff/${target.id}/set-sales`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ realName: '测试销售', companyName: '通标中研' })
    expect(res.status).toBe(200)
    expect(res.body.salesCode).toMatch(/^[A-Z2-9]{8}$/)
    expect(res.body.created).toBe(true)
    expect(res.body.roleAssigned).toBe(true)

    // v3：不再改 AppUser.role
    const after = await prisma.appUser.findUnique({ where: { id: target.id } })
    expect(after?.role).toBe('user')

    // SalesProfile + 主推码
    const profile = await prisma.salesProfile.findUnique({ where: { userId: target.id } })
    expect(profile).not.toBeNull()
    expect(profile?.realName).toBe('测试销售')
    const codes = await prisma.salesCode.findMany({ where: { profileId: profile!.id } })
    expect(codes).toHaveLength(1)
    expect(codes[0].label).toBe('主码')

    // "销售"内置角色已分配
    const roleAssign = await prisma.adminUserRole.findFirst({
      where: { userId: target.id, status: 'ACTIVE', role: { name: '销售' } },
    })
    expect(roleAssign).not.toBeNull()
  })

  it('幂等：重复 set-sales 返回 200 + created=false', async () => {
    const admin = await createUser({ role: 'admin' })
    const target = await createUser({ role: 'user' })
    // 第一次
    const r1 = await request(app)
      .post(`/api/admin/staff/${target.id}/set-sales`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ realName: '原始销售' })
    expect(r1.status).toBe(200)
    expect(r1.body.created).toBe(true)
    // 第二次
    const r2 = await request(app)
      .post(`/api/admin/staff/${target.id}/set-sales`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ realName: '改名应被忽略' })
    expect(r2.status).toBe(200)
    expect(r2.body.created).toBe(false)
    expect(r2.body.roleAssigned).toBe(false)
    expect(r2.body.salesCode).toBe(r1.body.salesCode)
    // SalesProfile / SalesCode / AdminUserRole 都仍只有 1 份
    const profiles = await prisma.salesProfile.findMany({ where: { userId: target.id } })
    expect(profiles).toHaveLength(1)
    expect(profiles[0].realName).toBe('原始销售') // 不被覆盖
    const codes = await prisma.salesCode.findMany({ where: { profileId: profiles[0].id } })
    expect(codes).toHaveLength(1)
    const assigns = await prisma.adminUserRole.findMany({ where: { userId: target.id } })
    expect(assigns).toHaveLength(1)
  })

  it('admin 不能转销售 → 403', async () => {
    const admin = await createUser({ role: 'admin' })
    const targetAdmin = await createUser({ role: 'admin' })
    const res = await request(app)
      .post(`/api/admin/staff/${targetAdmin.id}/set-sales`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ realName: '不应成功' })
    expect(res.status).toBe(403)
  })

  it('非 admin 调用 → 403', async () => {
    const sales = await createUser({ role: 'sales' })
    const target = await createUser({ role: 'user' })
    const res = await request(app)
      .post(`/api/admin/staff/${target.id}/set-sales`)
      .set('Authorization', `Bearer ${getTestToken(sales.id, 'sales')}`)
      .send({ realName: '应被拒' })
    expect(res.status).toBe(403)
  })
})

// ═════════════════════════════════════════════════════════
// PATCH /api/admin/staff/:id/roles
// ═════════════════════════════════════════════════════════
describe('PATCH /api/admin/staff/:id/roles', () => {
  beforeEach(cleanRbacAndUsers)

  it('happy path：分配角色（全量替换）', async () => {
    const admin = await createUser({ role: 'admin' })
    const user = await createUser({ role: 'user' })
    const r1 = await prisma.adminRole.create({ data: { name: 'role-a', createdBy: admin.id } })
    const r2 = await prisma.adminRole.create({ data: { name: 'role-b', createdBy: admin.id } })

    const res = await request(app)
      .patch(`/api/admin/staff/${user.id}/roles`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ roleIds: [r1.id, r2.id] })
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(2)

    const ur = await prisma.adminUserRole.findMany({ where: { userId: user.id } })
    expect(ur).toHaveLength(2)
  })

  it('roleId 不存在 → 400（接口校验所有 roleIds 都 ACTIVE）', async () => {
    const admin = await createUser({ role: 'admin' })
    const user = await createUser({ role: 'user' })
    const res = await request(app)
      .patch(`/api/admin/staff/${user.id}/roles`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ roleIds: ['nonexistent-role-id'] })
    expect(res.status).toBe(400)
  })

  it('全量替换：传 [] 撤销所有角色', async () => {
    const admin = await createUser({ role: 'admin' })
    const user = await createUser({ role: 'user' })
    const r = await prisma.adminRole.create({ data: { name: 'role-temp', createdBy: admin.id } })
    await prisma.adminUserRole.create({
      data: { userId: user.id, roleId: r.id, status: 'ACTIVE', assignedBy: admin.id },
    })

    const res = await request(app)
      .patch(`/api/admin/staff/${user.id}/roles`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ roleIds: [] })
    expect(res.status).toBe(200)
    const after = await prisma.adminUserRole.findMany({ where: { userId: user.id } })
    expect(after).toHaveLength(0)
  })

  it('非 admin 调用 → 403', async () => {
    const sales = await createUser({ role: 'sales' })
    const user = await createUser({ role: 'user' })
    const res = await request(app)
      .patch(`/api/admin/staff/${user.id}/roles`)
      .set('Authorization', `Bearer ${getTestToken(sales.id, 'sales')}`)
      .send({ roleIds: [] })
    expect(res.status).toBe(403)
  })
})

// ═════════════════════════════════════════════════════════
// PATCH /api/admin/staff/:id/toggle
// ═════════════════════════════════════════════════════════
describe('PATCH /api/admin/staff/:id/toggle', () => {
  beforeEach(cleanRbacAndUsers)

  it('disable：将所有 AdminUserRole.status → DISABLED', async () => {
    const admin = await createUser({ role: 'admin' })
    const user = await createUser({ role: 'user' })
    const r = await prisma.adminRole.create({ data: { name: 'role-toggle', createdBy: admin.id } })
    await prisma.adminUserRole.create({
      data: { userId: user.id, roleId: r.id, status: 'ACTIVE', assignedBy: admin.id },
    })

    const res = await request(app)
      .patch(`/api/admin/staff/${user.id}/toggle`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ active: false })
    expect(res.status).toBe(200)
    expect(res.body.affected).toBe(1)
    const after = await prisma.adminUserRole.findFirst({ where: { userId: user.id } })
    expect(after?.status).toBe('DISABLED')
  })

  it('enable：DISABLED → ACTIVE', async () => {
    const admin = await createUser({ role: 'admin' })
    const user = await createUser({ role: 'user' })
    const r = await prisma.adminRole.create({ data: { name: 'role-toggle-2', createdBy: admin.id } })
    await prisma.adminUserRole.create({
      data: { userId: user.id, roleId: r.id, status: 'DISABLED', assignedBy: admin.id },
    })

    const res = await request(app)
      .patch(`/api/admin/staff/${user.id}/toggle`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ active: true })
    expect(res.status).toBe(200)
    const after = await prisma.adminUserRole.findFirst({ where: { userId: user.id } })
    expect(after?.status).toBe('ACTIVE')
  })

  it('对自己操作 → 403', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .patch(`/api/admin/staff/${admin.id}/toggle`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ active: false })
    expect(res.status).toBe(403)
  })
})
