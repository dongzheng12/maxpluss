/**
 * requireSales RBAC fallback 测试
 *
 * 验证 Option A 修复：role='user' 但持有"销售"内置 AdminUserRole 的用户
 * 能通过 requireSales guard（之前因 JWT role='user' 被 403）。
 *
 * 覆盖：
 *   - happy path（RBAC）：role='user' + AdminUserRole → 通过 requireSales，非 403
 *   - 阻断：role='user'，无 AdminUserRole → 403
 *   - 原有路径：role='sales'（legacy JWT）→ 通过
 *   - 原有路径：role='admin' → 通过
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { registerStaffRoutes } from '../src/staffRoutes.js'
import { registerSalesV2Routes } from '../src/salesV2Routes.js'
import { ensureBuiltInRoles, SALES_BUILT_IN_ROLE_NAME } from '../src/services/builtInRoles.js'
import { createUser, getTestToken, ensurePlans } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  registerStaffRoutes(app)
  // /api/app/sales/codes 等 requireSales 守卫的端点在 salesV2Routes
  registerSalesV2Routes(app)
  await ensureAppSeed()
})

async function cleanup13988() {
  const testUsers = await prisma.appUser.findMany({
    where: { phone: { startsWith: '13988' } },
    select: { id: true },
  })
  const ids = testUsers.map(u => u.id)
  if (ids.length > 0) {
    const profiles = await prisma.salesProfile.findMany({
      where: { userId: { in: ids } },
      select: { id: true },
    })
    if (profiles.length > 0) {
      await prisma.salesCode.deleteMany({ where: { profileId: { in: profiles.map(p => p.id) } } })
    }
    await prisma.adminUserRole.deleteMany({ where: { userId: { in: ids } } })
    await prisma.salesProfile.deleteMany({ where: { userId: { in: ids } } })
  }
  await prisma.appUser.deleteMany({ where: { phone: { startsWith: '13988' } } })
}

beforeEach(async () => {
  await cleanup13988()
  await ensureBuiltInRoles('test')
})

// 关键：afterAll 清最后一个 it 残留,避免污染下一个测试文件
// (例如 taskWorker.test.ts cleanRbac 全清 AppUser 时撞 AdminUserRole_userId_fkey)
afterAll(async () => {
  await cleanup13988()
})

/** 给指定用户挂上"销售"内置 AdminUserRole（模拟 batch-assign 效果） */
async function grantSalesRole(userId: string) {
  const role = await prisma.adminRole.findUnique({ where: { name: SALES_BUILT_IN_ROLE_NAME } })
  if (!role) throw new Error('销售内置角色不存在，请先 ensureBuiltInRoles')
  await prisma.adminUserRole.upsert({
    where: { userId_roleId: { userId, roleId: role.id } },
    create: { userId, roleId: role.id, status: 'ACTIVE', assignedBy: 'test' },
    update: { status: 'ACTIVE' },
  })
}

// 使用 GET /api/app/sales/codes 作为 requireSales 代理端点
// 通过 auth → 200 或 404（无 profile）；未通过 → 403
const SALES_ENDPOINT = '/api/app/sales/codes'

describe('requireSales RBAC fallback', () => {
  it('happy path：role=user + RBAC 销售角色 → 通过 requireSales（非 403）', async () => {
    const u = await createUser({ phone: '13988000001' })
    await grantSalesRole(u.id)

    const res = await request(app)
      .get(SALES_ENDPOINT)
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)

    expect(res.status).not.toBe(403)
  })

  it('阻断：role=user，无 AdminUserRole → 403', async () => {
    const u = await createUser({ phone: '13988000002' })

    const res = await request(app)
      .get(SALES_ENDPOINT)
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('需要销售权限')
  })

  it('原有路径：role=sales（legacy JWT）→ 通过', async () => {
    const u = await createUser({ phone: '13988000003', role: 'sales' })

    const res = await request(app)
      .get(SALES_ENDPOINT)
      .set('Authorization', `Bearer ${getTestToken(u.id, 'sales')}`)

    expect(res.status).not.toBe(403)
  })

  it('原有路径：role=admin → 通过', async () => {
    const u = await createUser({ phone: '13988000004', role: 'admin' })

    const res = await request(app)
      .get(SALES_ENDPOINT)
      .set('Authorization', `Bearer ${getTestToken(u.id, 'admin')}`)

    expect(res.status).not.toBe(403)
  })

  it('未登录 → 401', async () => {
    const res = await request(app).get(SALES_ENDPOINT)
    expect(res.status).toBe(401)
  })

  it('AdminUserRole 被 DISABLED 后失效 → 403', async () => {
    const u = await createUser({ phone: '13988000005' })
    await grantSalesRole(u.id)

    // 撤销（schema 语义：ACTIVE | DISABLED）
    const role = await prisma.adminRole.findUnique({ where: { name: SALES_BUILT_IN_ROLE_NAME } })
    await prisma.adminUserRole.update({
      where: { userId_roleId: { userId: u.id, roleId: role!.id } },
      data: { status: 'DISABLED' },
    })

    const res = await request(app)
      .get(SALES_ENDPOINT)
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)

    expect(res.status).toBe(403)
  })
})
