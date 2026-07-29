/**
 * Phase 2 RBAC 路由权限细化测试
 *
 * 覆盖：appRoutes.ts 中订单/发票/预约/用户的 admin 路由从 requireAdmin 迁移到
 * requirePermission(key) 后：
 *   - 未登录 → 401
 *   - role='user' 但无对应 actionPermissions → 403
 *   - role='user' 且通过 AdminUserRole 关联角色拥有 key → 通过（≠403）
 *   - role='admin' 早 return 直接通过（不查 DB）
 *
 * 不验证业务路径成功结果，仅断言守卫行为；业务逻辑细节由其他测试覆盖。
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
      name: `测试角色-${user.id.slice(-6)}`,
      menuPermissions: [],
      actionPermissions: perms,
      dataScope: 'ALL',
      createdBy: user.id,
    },
  })
  await prisma.adminUserRole.create({
    data: { userId: user.id, roleId: role.id, status: 'ACTIVE', assignedBy: user.id },
  })
  return { user, token: getTestToken(user.id, 'user') }
}

async function makeStaffNoPerms() {
  const user = await createUser({ role: 'user' })
  return { user, token: getTestToken(user.id, 'user') }
}

async function makeAdmin() {
  const user = await createUser({ role: 'admin' })
  return { user, token: getTestToken(user.id, 'admin') }
}

// ─── /api/admin/orders ────────────────────────────────────────

describe('GET /api/admin/orders 权限拦截', () => {
  it('未登录 → 401', async () => {
    const res = await request(app).get('/api/admin/orders')
    expect(res.status).toBe(401)
  })

  it('staff 无 admin.orders.read → 403', async () => {
    const { token } = await makeStaffNoPerms()
    const res = await request(app).get('/api/admin/orders').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('staff 有 admin.orders.read → 200', async () => {
    const { token } = await makeStaffWithPerms(['admin.orders.read'])
    const res = await request(app).get('/api/admin/orders').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.items)).toBe(true)
  })

  it('admin role 即使无 actionPermissions 也通过（早 return）', async () => {
    const { token } = await makeAdmin()
    const res = await request(app).get('/api/admin/orders').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })
})

describe('POST /api/admin/orders/:orderNo/refund 权限拦截', () => {
  it('staff 无 admin.orders.refund → 403', async () => {
    const { token } = await makeStaffWithPerms(['admin.orders.read']) // 有 read 但无 refund
    const res = await request(app)
      .post('/api/admin/orders/ORD-NOPE/refund')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'test' })
    expect(res.status).toBe(403)
  })

  it('staff 有 admin.orders.refund → 通过守卫（业务可能 404，但不是 403）', async () => {
    const { token } = await makeStaffWithPerms(['admin.orders.refund'])
    const res = await request(app)
      .post('/api/admin/orders/ORD-NOPE/refund')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'test' })
    expect(res.status).not.toBe(403)
    expect([400, 404]).toContain(res.status)
  })
})

describe('POST /api/admin/orders/:orderNo/confirm 权限拦截', () => {
  it('staff 无 admin.orders.confirm → 403', async () => {
    const { token } = await makeStaffWithPerms(['admin.orders.read'])
    const res = await request(app)
      .post('/api/admin/orders/ORD-NOPE/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(403)
  })

  it('staff 有 admin.orders.confirm → 通过守卫', async () => {
    const { token } = await makeStaffWithPerms(['admin.orders.confirm'])
    const res = await request(app)
      .post('/api/admin/orders/ORD-NOPE/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).not.toBe(403)
  })

  it('reject-receipt 与 confirm 共用 admin.orders.confirm key', async () => {
    const { token } = await makeStaffWithPerms(['admin.orders.confirm'])
    const res = await request(app)
      .post('/api/admin/orders/ORD-NOPE/reject-receipt')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'x' })
    expect(res.status).not.toBe(403)
  })
})

// ─── /api/admin/invoices ─────────────────────────────────────

describe('GET /api/admin/invoices 权限拦截', () => {
  it('staff 无 admin.invoices.read → 403', async () => {
    const { token } = await makeStaffNoPerms()
    const res = await request(app).get('/api/admin/invoices').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('staff 有 admin.invoices.read → 200', async () => {
    const { token } = await makeStaffWithPerms(['admin.invoices.read'])
    const res = await request(app).get('/api/admin/invoices').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })
})

describe('POST /api/admin/invoices/:invoiceNo/issue 权限拦截', () => {
  it('staff 仅有 invoices.read → 403', async () => {
    const { token } = await makeStaffWithPerms(['admin.invoices.read'])
    const res = await request(app)
      .post('/api/admin/invoices/INV-NOPE/issue')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(403)
  })

  it('staff 有 admin.invoices.issue → 通过守卫', async () => {
    const { token } = await makeStaffWithPerms(['admin.invoices.issue'])
    const res = await request(app)
      .post('/api/admin/invoices/INV-NOPE/issue')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).not.toBe(403)
  })
})

describe('POST /api/admin/invoices/:invoiceNo/reject 独立 key', () => {
  it('仅有 invoices.issue 不放行 reject', async () => {
    const { token } = await makeStaffWithPerms(['admin.invoices.issue'])
    const res = await request(app)
      .post('/api/admin/invoices/INV-NOPE/reject')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'x' })
    expect(res.status).toBe(403)
  })

  it('有 admin.invoices.reject → 通过守卫', async () => {
    const { token } = await makeStaffWithPerms(['admin.invoices.reject'])
    const res = await request(app)
      .post('/api/admin/invoices/INV-NOPE/reject')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'x' })
    expect(res.status).not.toBe(403)
  })
})

// ─── /api/admin/bookings ─────────────────────────────────────

describe('PATCH /api/admin/bookings/:bookingNo/status 权限拦截', () => {
  it('staff 仅 bookings.read → 403', async () => {
    const { token } = await makeStaffWithPerms(['admin.bookings.read'])
    const res = await request(app)
      .patch('/api/admin/bookings/BK-NOPE/status')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'CONTACTED' })
    expect(res.status).toBe(403)
  })

  it('staff 有 admin.bookings.manage → 通过守卫', async () => {
    const { token } = await makeStaffWithPerms(['admin.bookings.manage'])
    const res = await request(app)
      .patch('/api/admin/bookings/BK-NOPE/status')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'CONTACTED' })
    expect(res.status).not.toBe(403)
  })
})

describe('GET /api/admin/bookings 权限拦截', () => {
  it('staff 无 bookings.read → 403', async () => {
    const { token } = await makeStaffNoPerms()
    const res = await request(app).get('/api/admin/bookings').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('staff 有 bookings.read → 200', async () => {
    const { token } = await makeStaffWithPerms(['admin.bookings.read'])
    const res = await request(app).get('/api/admin/bookings').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })
})

// ─── /api/admin/users ────────────────────────────────────────

describe('GET /api/admin/users 权限拦截', () => {
  it('未登录 → 401', async () => {
    const res = await request(app).get('/api/admin/users')
    expect(res.status).toBe(401)
  })

  it('staff 无 users.read → 403', async () => {
    const { token } = await makeStaffNoPerms()
    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('staff 有 admin.users.read → 200', async () => {
    const { token } = await makeStaffWithPerms(['admin.users.read'])
    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })
})

// ─── 多角色合并 actionPermissions ────────────────────────────

describe('多角色 actionPermissions 合并', () => {
  it('两个角色各持一半 key，合并后两条接口都能访问', async () => {
    const user = await createUser({ role: 'user' })
    const r1 = await prisma.adminRole.create({
      data: {
        name: `r1-${user.id.slice(-6)}`,
        menuPermissions: [], actionPermissions: ['admin.orders.read'],
        dataScope: 'ALL', createdBy: user.id,
      },
    })
    const r2 = await prisma.adminRole.create({
      data: {
        name: `r2-${user.id.slice(-6)}`,
        menuPermissions: [], actionPermissions: ['admin.invoices.read'],
        dataScope: 'ALL', createdBy: user.id,
      },
    })
    await prisma.adminUserRole.create({
      data: { userId: user.id, roleId: r1.id, status: 'ACTIVE', assignedBy: user.id },
    })
    await prisma.adminUserRole.create({
      data: { userId: user.id, roleId: r2.id, status: 'ACTIVE', assignedBy: user.id },
    })
    const token = getTestToken(user.id, 'user')

    const a = await request(app).get('/api/admin/orders').set('Authorization', `Bearer ${token}`)
    expect(a.status).toBe(200)
    const b = await request(app).get('/api/admin/invoices').set('Authorization', `Bearer ${token}`)
    expect(b.status).toBe(200)
  })

  it('AdminUserRole status=DISABLED 时其角色 actionPermissions 不计入', async () => {
    const user = await createUser({ role: 'user' })
    const role = await prisma.adminRole.create({
      data: {
        name: `disabled-${user.id.slice(-6)}`,
        menuPermissions: [], actionPermissions: ['admin.orders.read'],
        dataScope: 'ALL', createdBy: user.id,
      },
    })
    await prisma.adminUserRole.create({
      data: { userId: user.id, roleId: role.id, status: 'DISABLED', assignedBy: user.id },
    })
    const token = getTestToken(user.id, 'user')
    const res = await request(app).get('/api/admin/orders').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })
})
