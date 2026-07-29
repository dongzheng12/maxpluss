/**
 * Phase 3 RBAC 路由权限细化测试
 *
 * 覆盖：appRoutes.ts 中公告 / 展示内容的 admin 路由从 requireAdmin 迁移到
 * requirePermission(key) 后：
 *   - 401（未登录）/ 403（无对应 key）/ 200（有 key）三态
 *   - admin role 早 return 直接通过
 *
 * 路由映射：
 *   GET/POST/PUT/DELETE /api/admin/announcements → admin.announcements.manage
 *   GET/PUT             /api/admin/content-config → admin.content.manage
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

async function makeStaffNoPerms() {
  const user = await createUser({ role: 'user' })
  return { user, token: getTestToken(user.id, 'user') }
}

async function makeAdmin() {
  const user = await createUser({ role: 'admin' })
  return { user, token: getTestToken(user.id, 'admin') }
}

// ─── 公告管理 ────────────────────────────────────────────

describe('GET /api/admin/announcements 权限', () => {
  it('未登录 → 401', async () => {
    const res = await request(app).get('/api/admin/announcements')
    expect(res.status).toBe(401)
  })

  it('staff 无 announcements.manage → 403', async () => {
    const { token } = await makeStaffNoPerms()
    const res = await request(app).get('/api/admin/announcements').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('staff 有 admin.announcements.manage → 200', async () => {
    const { token } = await makeStaffWithPerms(['admin.announcements.manage'])
    const res = await request(app).get('/api/admin/announcements').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.items)).toBe(true)
  })

  it('admin role 即使无 actionPermissions 也通过', async () => {
    const { token } = await makeAdmin()
    const res = await request(app).get('/api/admin/announcements').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })
})

describe('POST /api/admin/announcements 权限', () => {
  it('staff 无 announcements.manage → 403', async () => {
    const { token } = await makeStaffNoPerms()
    const res = await request(app)
      .post('/api/admin/announcements')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'x', content: 'y' })
    expect(res.status).toBe(403)
  })

  it('staff 有 announcements.manage → 通过守卫', async () => {
    const { token } = await makeStaffWithPerms(['admin.announcements.manage'])
    const res = await request(app)
      .post('/api/admin/announcements')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '测试公告', content: '测试内容' })
    expect(res.status).not.toBe(403)
    // 业务路径成功通常 200/201
    expect([200, 201]).toContain(res.status)
  })
})

describe('PUT /api/admin/announcements/:id 权限', () => {
  it('staff 无权限 → 403', async () => {
    const { token } = await makeStaffNoPerms()
    const res = await request(app)
      .put('/api/admin/announcements/nope')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(403)
  })

  it('staff 有权限 → 通过守卫（业务可能 404）', async () => {
    const { token } = await makeStaffWithPerms(['admin.announcements.manage'])
    const res = await request(app)
      .put('/api/admin/announcements/nope')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'x' })
    expect(res.status).not.toBe(403)
  })
})

describe('DELETE /api/admin/announcements/:id 权限', () => {
  it('staff 无权限 → 403', async () => {
    const { token } = await makeStaffNoPerms()
    const res = await request(app)
      .delete('/api/admin/announcements/nope')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('staff 有权限 → 通过守卫', async () => {
    const { token } = await makeStaffWithPerms(['admin.announcements.manage'])
    const res = await request(app)
      .delete('/api/admin/announcements/nope')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).not.toBe(403)
  })
})

// ─── 展示内容（content-config）─────────────────────────────

describe('GET /api/admin/content-config 权限', () => {
  it('staff 无 content.manage → 403', async () => {
    const { token } = await makeStaffNoPerms()
    const res = await request(app).get('/api/admin/content-config').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('staff 有 admin.content.manage → 200', async () => {
    const { token } = await makeStaffWithPerms(['admin.content.manage'])
    const res = await request(app).get('/api/admin/content-config').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })

  it('admin role 早 return → 200', async () => {
    const { token } = await makeAdmin()
    const res = await request(app).get('/api/admin/content-config').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })
})

describe('PUT /api/admin/content-config/:key 权限', () => {
  it('staff 无 content.manage → 403', async () => {
    const { token } = await makeStaffNoPerms()
    const res = await request(app)
      .put('/api/admin/content-config/some-key')
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 'x' })
    expect(res.status).toBe(403)
  })

  it('staff 有 content.manage → 通过守卫', async () => {
    const { token } = await makeStaffWithPerms(['admin.content.manage'])
    const res = await request(app)
      .put('/api/admin/content-config/some-key')
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 'x' })
    expect(res.status).not.toBe(403)
  })
})

// ─── 跨 key 隔离 ─────────────────────────────────────────

describe('权限 key 跨模块隔离', () => {
  it('仅有 announcements.manage 不放行 content-config', async () => {
    const { token } = await makeStaffWithPerms(['admin.announcements.manage'])
    const res = await request(app).get('/api/admin/content-config').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('仅有 content.manage 不放行 announcements', async () => {
    const { token } = await makeStaffWithPerms(['admin.content.manage'])
    const res = await request(app).get('/api/admin/announcements').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })
})
