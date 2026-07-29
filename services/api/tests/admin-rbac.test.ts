/**
 * roleRoutes (AdminRole) + RBAC 端到端测试
 *
 * 覆盖 6 个接口：
 *   GET    /api/admin/roles
 *   POST   /api/admin/roles
 *   PUT    /api/admin/roles/:id
 *   PATCH  /api/admin/roles/:id/status
 *   DELETE /api/admin/roles/:id
 *   GET    /api/admin/roles/:id/users
 *
 * 以及"权限分配组合"端到端：
 *   创建角色 → 分配 user → 验证 /me/permissions → 撤销 → 再验证失效
 *
 * 注：当前 roleRoutes 没有独立的 GET /api/admin/roles/:id（详情），
 * 角色详情通过 GET /api/admin/roles 列表 + filter 验证。
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { registerStaffRoutes } from '../src/staffRoutes.js'
import { registerRoleRoutes } from '../src/roleRoutes.js'
import { ensureBuiltInRoles } from '../src/services/builtInRoles.js'
import { createUser, getTestToken, ensurePlans, bodyItems, findItem } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  registerStaffRoutes(app)
  registerRoleRoutes(app)
  await ensureAppSeed()
})

/**
 * 清 RBAC 表。不删 AppUser（FK 拦阻），靠 createUser 的 random phone 避免冲突。
 * 清完后重建内置"销售"角色（保证测试初始状态与生产 ensureAppSeed 后一致）。
 */
async function cleanRbac() {
  await prisma.adminUserRole.deleteMany()
  await prisma.adminRole.deleteMany()
  await ensureBuiltInRoles('test')
}

// ═════════════════════════════════════════════════════════
// 内置"销售"角色（v3 §4）
// ═════════════════════════════════════════════════════════
describe('内置"销售"角色', () => {
  beforeEach(cleanRbac)

  it('ensureAppSeed 后："销售"内置角色存在 + isSystem=true + 含核心菜单', async () => {
    // ensureAppSeed 已在 beforeAll 跑过，这里只读校验
    const role = await prisma.adminRole.findUnique({ where: { name: '销售' } })
    expect(role).not.toBeNull()
    expect(role?.isSystem).toBe(true)
    expect(role?.status).toBe('ACTIVE')
    expect(role?.menuPermissions).toEqual(['/admin/sales/workspace'])
  })

  it('"销售"内置角色 → DELETE 返回 403（保留 isSystem 已实现的拦截）', async () => {
    const admin = await createUser({ role: 'admin' })
    const role = await prisma.adminRole.findUnique({ where: { name: '销售' } })
    expect(role).not.toBeNull()
    const res = await request(app)
      .delete(`/api/admin/roles/${role!.id}`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(403)
  })

  it('"销售"内置角色 → PATCH /status active=false 返回 403（不可停用）', async () => {
    const admin = await createUser({ role: 'admin' })
    const role = await prisma.adminRole.findUnique({ where: { name: '销售' } })
    const res = await request(app)
      .patch(`/api/admin/roles/${role!.id}/status`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ active: false })
    expect(res.status).toBe(403)
    const after = await prisma.adminRole.findUnique({ where: { id: role!.id } })
    expect(after?.status).toBe('ACTIVE')
  })

  it('"销售"内置角色 → PUT 改 name 被忽略（强制还原为"销售"）', async () => {
    const admin = await createUser({ role: 'admin' })
    const role = await prisma.adminRole.findUnique({ where: { name: '销售' } })
    const res = await request(app)
      .put(`/api/admin/roles/${role!.id}`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        name: '销售改名',
        menuPermissions: ['/admin/sales/workspace', '/admin/orders'],
        actionPermissions: [],
      })
    expect(res.status).toBe(200)
    const after = await prisma.adminRole.findUnique({ where: { id: role!.id } })
    expect(after?.name).toBe('销售') // name 强制还原
    expect(after?.menuPermissions).toEqual(['/admin/sales/workspace', '/admin/orders']) // 其它权限可叠加
  })

  it('"销售"内置角色 → PUT 缺核心菜单时自动补回', async () => {
    const admin = await createUser({ role: 'admin' })
    const role = await prisma.adminRole.findUnique({ where: { name: '销售' } })
    const res = await request(app)
      .put(`/api/admin/roles/${role!.id}`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        name: '销售',
        menuPermissions: ['/admin/orders'], // 故意不传销售工作台
        actionPermissions: [],
      })
    expect(res.status).toBe(200)
    const after = await prisma.adminRole.findUnique({ where: { id: role!.id } })
    const menu = after?.menuPermissions as string[]
    expect(menu).toContain('/admin/sales/workspace') // 自动补回
    expect(menu).toContain('/admin/orders') // 用户传的也保留
  })

  it('ensureBuiltInRoles 幂等：手动删销售角色后再 ensure → 重建', async () => {
    // 手动删销售角色（绕过接口，模拟数据库被外部清空的情况）
    await prisma.adminRole.deleteMany({ where: { name: '销售' } })
    let role = await prisma.adminRole.findUnique({ where: { name: '销售' } })
    expect(role).toBeNull()

    await ensureBuiltInRoles('test')
    role = await prisma.adminRole.findUnique({ where: { name: '销售' } })
    expect(role).not.toBeNull()
    expect(role?.isSystem).toBe(true)
    expect(role?.menuPermissions).toEqual(['/admin/sales/workspace'])

    // 再次 ensure 不重复创建
    await ensureBuiltInRoles('test')
    const count = await prisma.adminRole.count({ where: { name: '销售' } })
    expect(count).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════
// POST /api/admin/roles
// ═════════════════════════════════════════════════════════
describe('POST /api/admin/roles', () => {
  beforeEach(cleanRbac)

  it('happy path：创建角色 → 200 + id', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .post('/api/admin/roles')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        name: '财务',
        description: '财务运营',
        menuPermissions: ['/admin/orders', '/admin/invoices'],
        actionPermissions: ['admin.orders.read', 'admin.invoices.issue'],
        dataScope: 'ALL',
      })
    expect(res.status).toBe(200)
    expect(res.body.id).toBeTruthy()
    const created = await prisma.adminRole.findUnique({ where: { id: res.body.id } })
    expect(created?.name).toBe('财务')
    expect(created?.dataScope).toBe('ALL')
    expect((created?.menuPermissions as string[]).length).toBe(2)
  })

  it('name 重复 → 409', async () => {
    const admin = await createUser({ role: 'admin' })
    await prisma.adminRole.create({ data: { name: '财务', createdBy: admin.id } })
    const res = await request(app)
      .post('/api/admin/roles')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ name: '财务', menuPermissions: [], actionPermissions: [] })
    expect(res.status).toBe(409)
  })

  it('name 超 40 字符 → 400', async () => {
    const admin = await createUser({ role: 'admin' })
    const longName = 'a'.repeat(41)
    const res = await request(app)
      .post('/api/admin/roles')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ name: longName, menuPermissions: [], actionPermissions: [] })
    expect(res.status).toBe(400)
  })

  it('非 admin 调用 → 403', async () => {
    const sales = await createUser({ role: 'sales' })
    const res = await request(app)
      .post('/api/admin/roles')
      .set('Authorization', `Bearer ${getTestToken(sales.id, 'sales')}`)
      .send({ name: '应被拒', menuPermissions: [], actionPermissions: [] })
    expect(res.status).toBe(403)
  })
})

// ═════════════════════════════════════════════════════════
// GET /api/admin/roles
// ═════════════════════════════════════════════════════════
describe('GET /api/admin/roles', () => {
  beforeEach(cleanRbac)

  it('空列表：仅含内置"销售"角色（cleanRbac 后 reseed）', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/roles')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    const names = bodyItems<{ name: string }>(res).map((r) => r.name)
    expect(names).toEqual(['销售'])
  })

  it('happy path：返回多个角色 + userCount', async () => {
    const admin = await createUser({ role: 'admin' })
    const u = await createUser({ role: 'user' })
    const r1 = await prisma.adminRole.create({ data: { name: 'role-list-1', createdBy: admin.id } })
    await prisma.adminRole.create({ data: { name: 'role-list-2', createdBy: admin.id } })
    await prisma.adminUserRole.create({
      data: { userId: u.id, roleId: r1.id, status: 'ACTIVE', assignedBy: admin.id },
    })

    const res = await request(app)
      .get('/api/admin/roles')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    // 内置"销售" + 本测新建 2 个 = 3
    expect(res.body.items.length).toBe(3)
    type RoleRow = { name: string; userCount: number; isSystem: boolean }
    const map = new Map(bodyItems<RoleRow>(res).map((r) => [r.name, r]))
    expect(map.get('role-list-1')!.userCount).toBe(1)
    expect(map.get('role-list-2')!.userCount).toBe(0)
    expect(map.get('销售')!.isSystem).toBe(true)
  })

  it('角色详情：列表 + filter（接口未提供单详情）', async () => {
    const admin = await createUser({ role: 'admin' })
    const r = await prisma.adminRole.create({
      data: {
        name: 'role-detail-test',
        description: '详情测试',
        menuPermissions: ['/admin/users'],
        actionPermissions: ['admin.users.read'],
        createdBy: admin.id,
      },
    })
    const res = await request(app)
      .get('/api/admin/roles')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    const found = findItem<{ id: string; description: string; menuPermissions: string[] }>(res, (x) => x.id === r.id)
    expect(found).toBeTruthy()
    expect(found!.description).toBe('详情测试')
    expect(found!.menuPermissions).toEqual(['/admin/users'])
  })
})

// ═════════════════════════════════════════════════════════
// PUT /api/admin/roles/:id
// ═════════════════════════════════════════════════════════
describe('PUT /api/admin/roles/:id', () => {
  beforeEach(cleanRbac)

  it('happy path：改 name + 权限', async () => {
    const admin = await createUser({ role: 'admin' })
    const r = await prisma.adminRole.create({ data: { name: 'role-old', createdBy: admin.id } })
    const res = await request(app)
      .put(`/api/admin/roles/${r.id}`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        name: 'role-new',
        description: '改名后',
        menuPermissions: ['/admin/announcements'],
        actionPermissions: ['admin.announcements.manage'],
        dataScope: 'TEAM',
      })
    expect(res.status).toBe(200)
    const after = await prisma.adminRole.findUnique({ where: { id: r.id } })
    expect(after?.name).toBe('role-new')
    expect(after?.dataScope).toBe('TEAM')
  })

  it('改名时与已有角色重名 → 409', async () => {
    const admin = await createUser({ role: 'admin' })
    const r1 = await prisma.adminRole.create({ data: { name: 'r-a', createdBy: admin.id } })
    await prisma.adminRole.create({ data: { name: 'r-b', createdBy: admin.id } })
    const res = await request(app)
      .put(`/api/admin/roles/${r1.id}`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ name: 'r-b', menuPermissions: [], actionPermissions: [] })
    expect(res.status).toBe(409)
  })

  it('角色不存在 → 404', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .put('/api/admin/roles/nonexistent-id')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ name: 'whatever', menuPermissions: [], actionPermissions: [] })
    expect(res.status).toBe(404)
  })

  it('非 admin 调用 → 403', async () => {
    const sales = await createUser({ role: 'sales' })
    const res = await request(app)
      .put('/api/admin/roles/whatever')
      .set('Authorization', `Bearer ${getTestToken(sales.id, 'sales')}`)
      .send({ name: 'x', menuPermissions: [], actionPermissions: [] })
    expect(res.status).toBe(403)
  })
})

// ═════════════════════════════════════════════════════════
// PATCH /api/admin/roles/:id/status
// ═════════════════════════════════════════════════════════
describe('PATCH /api/admin/roles/:id/status', () => {
  beforeEach(cleanRbac)

  it('disable → status=DISABLED', async () => {
    const admin = await createUser({ role: 'admin' })
    const r = await prisma.adminRole.create({ data: { name: 'role-status', createdBy: admin.id } })
    const res = await request(app)
      .patch(`/api/admin/roles/${r.id}/status`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ active: false })
    expect(res.status).toBe(200)
    const after = await prisma.adminRole.findUnique({ where: { id: r.id } })
    expect(after?.status).toBe('DISABLED')
  })

  it('enable → status=ACTIVE', async () => {
    const admin = await createUser({ role: 'admin' })
    const r = await prisma.adminRole.create({
      data: { name: 'role-status-2', status: 'DISABLED', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/roles/${r.id}/status`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ active: true })
    expect(res.status).toBe(200)
    const after = await prisma.adminRole.findUnique({ where: { id: r.id } })
    expect(after?.status).toBe('ACTIVE')
  })

  it('角色不存在 → 404', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .patch('/api/admin/roles/nonexistent/status')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ active: true })
    expect(res.status).toBe(404)
  })
})

// ═════════════════════════════════════════════════════════
// DELETE /api/admin/roles/:id
// ═════════════════════════════════════════════════════════
describe('DELETE /api/admin/roles/:id', () => {
  beforeEach(cleanRbac)

  it('happy path：无关联人员 → 200', async () => {
    const admin = await createUser({ role: 'admin' })
    const r = await prisma.adminRole.create({ data: { name: 'role-del', createdBy: admin.id } })
    const res = await request(app)
      .delete(`/api/admin/roles/${r.id}`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    const after = await prisma.adminRole.findUnique({ where: { id: r.id } })
    expect(after).toBeNull()
  })

  it('有 userRole 关联 → 409（先撤销分配再删）', async () => {
    const admin = await createUser({ role: 'admin' })
    const u = await createUser({ role: 'user' })
    const r = await prisma.adminRole.create({ data: { name: 'role-del-busy', createdBy: admin.id } })
    await prisma.adminUserRole.create({
      data: { userId: u.id, roleId: r.id, status: 'ACTIVE', assignedBy: admin.id },
    })
    const res = await request(app)
      .delete(`/api/admin/roles/${r.id}`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(409)
    const after = await prisma.adminRole.findUnique({ where: { id: r.id } })
    expect(after).not.toBeNull()
  })

  it('isSystem=true → 403 不可删', async () => {
    const admin = await createUser({ role: 'admin' })
    const r = await prisma.adminRole.create({
      data: { name: 'role-system', isSystem: true, createdBy: admin.id },
    })
    const res = await request(app)
      .delete(`/api/admin/roles/${r.id}`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(403)
  })

  it('角色不存在 → 404', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .delete('/api/admin/roles/nonexistent')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(404)
  })
})

// ═════════════════════════════════════════════════════════
// GET /api/admin/roles/:id/users
// ═════════════════════════════════════════════════════════
describe('GET /api/admin/roles/:id/users', () => {
  beforeEach(cleanRbac)

  it('返回该角色下的人员', async () => {
    const admin = await createUser({ role: 'admin' })
    const u1 = await createUser({ role: 'user', phone: '13911100001' })
    const u2 = await createUser({ role: 'user', phone: '13911100002' })
    const r = await prisma.adminRole.create({ data: { name: 'role-with-users', createdBy: admin.id } })
    await prisma.adminUserRole.createMany({
      data: [
        { userId: u1.id, roleId: r.id, status: 'ACTIVE', assignedBy: admin.id },
        { userId: u2.id, roleId: r.id, status: 'DISABLED', assignedBy: admin.id },
      ],
    })
    const res = await request(app)
      .get(`/api/admin/roles/${r.id}/users`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(2)
    const phones = bodyItems<{ phone: string }>(res).map((x) => x.phone)
    expect(phones).toEqual(expect.arrayContaining(['13911100001', '13911100002']))
  })

  it('角色不存在 → 404', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/roles/nonexistent/users')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
    expect(res.status).toBe(404)
  })
})

// ═════════════════════════════════════════════════════════
// 权限分配组合：端到端
// ═════════════════════════════════════════════════════════
describe('权限分配组合：端到端', () => {
  beforeEach(cleanRbac)

  it('创建角色 → 分配 user → /me/permissions 命中 → 撤销 → 再验证失效', async () => {
    const admin = await createUser({ role: 'admin' })
    const user = await createUser({ role: 'user' })
    const adminToken = getTestToken(admin.id, 'admin')
    const userToken = getTestToken(user.id, 'user')

    // 1) 创建角色
    const create = await request(app)
      .post('/api/admin/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'e2e-role',
        menuPermissions: ['/admin/announcements'],
        actionPermissions: ['admin.announcements.manage'],
        dataScope: 'SELF',
      })
    expect(create.status).toBe(200)
    const roleId = create.body.id

    // 2) 初始 user 无后台权限
    const before = await request(app)
      .get('/api/admin/me/permissions')
      .set('Authorization', `Bearer ${userToken}`)
    expect(before.body.hasAdminAccess).toBe(false)

    // 3) 分配
    const assign = await request(app)
      .patch(`/api/admin/staff/${user.id}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roleIds: [roleId] })
    expect(assign.status).toBe(200)

    // 4) /me/permissions 命中
    const after = await request(app)
      .get('/api/admin/me/permissions')
      .set('Authorization', `Bearer ${userToken}`)
    expect(after.body.hasAdminAccess).toBe(true)
    expect(after.body.isStaff).toBe(true)
    expect(after.body.menuPaths).toContain('/admin/announcements')
    expect(after.body.actionKeys).toContain('admin.announcements.manage')

    // 5) 撤销
    const revoke = await request(app)
      .patch(`/api/admin/staff/${user.id}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roleIds: [] })
    expect(revoke.status).toBe(200)

    // 6) 再验证失效
    const final = await request(app)
      .get('/api/admin/me/permissions')
      .set('Authorization', `Bearer ${userToken}`)
    expect(final.body.hasAdminAccess).toBe(false)
    expect(final.body.menuPaths).toEqual([])
  })
})
