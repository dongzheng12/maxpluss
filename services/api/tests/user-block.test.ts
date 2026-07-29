/**
 * 用户启用/禁用 (isBlocked) 测试
 *
 * 覆盖：
 *   - PATCH /api/admin/users/:id/toggle-blocked
 *     - 鉴权：未登录 401 / 无 admin.users.toggle 403 / 有 key 200 / admin role 早 return 200
 *     - 边界：用户不存在 404，target.role='admin' 拒绝 400
 *     - 切换语义：false → true → false
 *   - requireAuth 中 isBlocked 拦截
 *     - 已禁用普通用户访问受保护接口 → 403「账号已被禁用」
 *     - admin role 不受 isBlocked 影响（避免锁死自己）
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { _resetConfigCache } from '../src/wechat-pay.js'
import { createUser, getTestToken, ensurePlans, cleanAll } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  for (const k of [
    'WECHAT_PAY_MCH_ID', 'WECHAT_PAY_SERIAL_NO', 'WECHAT_PAY_PRIVATE_KEY',
    'WECHAT_PAY_API_V3_KEY', 'WECHAT_PAY_APPID', 'WX_APPID',
  ]) delete process.env[k]
  _resetConfigCache()
  await ensurePlans()
  registerAppRoutes(app)
  await ensureAppSeed()
})

beforeEach(async () => {
  await prisma.adminUserRole.deleteMany()
  await prisma.adminRole.deleteMany()
  await cleanAll()
  await ensurePlans()
})

async function makeStaffWithPerms(perms: string[]) {
  const user = await createUser({ role: 'user' })
  const role = await prisma.adminRole.create({
    data: {
      name: `r-${user.id.slice(-6)}`,
      menuPermissions: [], actionPermissions: perms,
      dataScope: 'ALL', createdBy: user.id,
    },
  })
  await prisma.adminUserRole.create({
    data: { userId: user.id, roleId: role.id, status: 'ACTIVE', assignedBy: user.id },
  })
  return { user, token: getTestToken(user.id, 'user') }
}

// ─── PATCH /toggle-blocked 鉴权 ───────────────────────────────

describe('PATCH /api/admin/users/:id/toggle-blocked 鉴权', () => {
  it('未登录 → 401', async () => {
    const target = await createUser({ role: 'user' })
    const res = await request(app).patch(`/api/admin/users/${target.id}/toggle-blocked`)
    expect(res.status).toBe(401)
  })

  it('无 admin.users.toggle → 403', async () => {
    const target = await createUser({ role: 'user' })
    const { token } = await makeStaffWithPerms(['admin.users.read']) // 只有 read
    const res = await request(app)
      .patch(`/api/admin/users/${target.id}/toggle-blocked`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('有 admin.users.toggle → 200 + 切换状态', async () => {
    const target = await createUser({ role: 'user' })
    const { token } = await makeStaffWithPerms(['admin.users.toggle'])
    const r1 = await request(app)
      .patch(`/api/admin/users/${target.id}/toggle-blocked`)
      .set('Authorization', `Bearer ${token}`)
    expect(r1.status).toBe(200)
    expect(r1.body.isBlocked).toBe(true)

    const r2 = await request(app)
      .patch(`/api/admin/users/${target.id}/toggle-blocked`)
      .set('Authorization', `Bearer ${token}`)
    expect(r2.body.isBlocked).toBe(false)
  })

  it('admin role 早 return（无须 actionPermissions）', async () => {
    const target = await createUser({ role: 'user' })
    const adminUser = await createUser({ role: 'admin' })
    const res = await request(app)
      .patch(`/api/admin/users/${target.id}/toggle-blocked`)
      .set('Authorization', `Bearer ${getTestToken(adminUser.id, 'admin')}`)
    expect(res.status).toBe(200)
  })
})

// ─── PATCH /toggle-blocked 业务边界 ────────────────────────────

describe('PATCH /api/admin/users/:id/toggle-blocked 业务边界', () => {
  it('目标用户不存在 → 404', async () => {
    const adminUser = await createUser({ role: 'admin' })
    const res = await request(app)
      .patch(`/api/admin/users/nope-${Date.now()}/toggle-blocked`)
      .set('Authorization', `Bearer ${getTestToken(adminUser.id, 'admin')}`)
    expect(res.status).toBe(404)
  })

  it('禁止禁用 admin role 用户 → 400', async () => {
    const targetAdmin = await createUser({ role: 'admin' })
    const operator = await createUser({ role: 'admin' })
    const res = await request(app)
      .patch(`/api/admin/users/${targetAdmin.id}/toggle-blocked`)
      .set('Authorization', `Bearer ${getTestToken(operator.id, 'admin')}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/管理员/)
  })
})

// ─── requireAuth isBlocked 拦截 ────────────────────────────────

describe('requireAuth isBlocked 拦截', () => {
  it('已禁用普通用户访问受保护接口 → 403「账号已被禁用」', async () => {
    const u = await createUser({ role: 'user' })
    await prisma.appUser.update({ where: { id: u.id }, data: { isBlocked: true } })
    const res = await request(app)
      .get('/api/app/profile')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/已被禁用/)
  })

  it('未禁用普通用户访问受保护接口正常', async () => {
    const u = await createUser({ role: 'user' })
    const res = await request(app)
      .get('/api/app/profile')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
    expect(res.status).toBe(200)
  })

  it('admin 即使 isBlocked=true 也能访问（豁免，避免锁死管理员）', async () => {
    const a = await createUser({ role: 'admin' })
    await prisma.appUser.update({ where: { id: a.id }, data: { isBlocked: true } })
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.status).toBe(200)
  })
})

// ─── GET /api/admin/users 返回 isBlocked + keyword ─────────────

describe('GET /api/admin/users 字段与搜索', () => {
  it('items 包含 isBlocked 字段', async () => {
    const u = await createUser({ role: 'user' })
    await prisma.appUser.update({ where: { id: u.id }, data: { isBlocked: true } })
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.status).toBe(200)
    const found = res.body.items.find((x: any) => x.id === u.id)
    expect(found).toBeDefined()
    expect(found.isBlocked).toBe(true)
  })

  it('?keyword= 按 phone 模糊匹配', async () => {
    const u = await createUser({ role: 'user', phone: '13900008888' })
    await createUser({ role: 'user', phone: '13700001111' })
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/users?keyword=8888')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.items.some((x: any) => x.id === u.id)).toBe(true)
    expect(res.body.items.every((x: any) => (x.phone || '').includes('8888'))).toBe(true)
  })

  it('?keyword= 按 name 匹配', async () => {
    const u = await createUser({ role: 'user' })
    await prisma.appUser.update({ where: { id: u.id }, data: { name: '张三测试' } })
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/users?keyword=三测试')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.body.items.some((x: any) => x.id === u.id)).toBe(true)
  })
})
