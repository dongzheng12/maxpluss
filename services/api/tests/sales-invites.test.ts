/**
 * 销售邀请码 — 批量生成接口端到端测试
 *
 * 覆盖 POST /api/admin/sales-invites 的 count 参数行为：
 *   - count=1（缺省）→ 单对象（向后兼容）
 *   - count=N（2..50）→ {count, items[]}
 *   - count>50 → 截断到 50
 *   - 权限拦截
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { registerSalesV2Routes } from '../src/salesV2Routes.js'
import { createUser, getTestToken, ensurePlans } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  registerSalesV2Routes(app)
  await ensureAppSeed()
})

async function cleanInvites() {
  await prisma.salesInvite.deleteMany()
}

// ═════════════════════════════════════════════════════════
// POST /api/admin/sales-invites — count 参数
// ═════════════════════════════════════════════════════════
describe('POST /api/admin/sales-invites', () => {
  beforeEach(cleanInvites)

  it('count=1（缺省，向后兼容）→ 201 + 单对象 {id, inviteCode, status, expiresAt, createdAt, inviteUrl}', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .post('/api/admin/sales-invites')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({})  // 不传 count，等价 count=1

    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty('id')
    expect(res.body.inviteCode).toMatch(/^[A-Z2-9]{8}$/)
    expect(res.body.status).toBe('UNUSED')
    expect(res.body).toHaveProperty('expiresAt')
    expect(res.body).toHaveProperty('createdAt')
    expect(res.body.inviteUrl).toContain('/sales/join?invite=')
    expect(res.body).not.toHaveProperty('count')  // 单个不应有 count 字段
    expect(res.body).not.toHaveProperty('items')

    // DB 实际只插了 1 条
    const dbCount = await prisma.salesInvite.count()
    expect(dbCount).toBe(1)
  })

  it('count=1 显式传 → 同上单对象（兼容前端 batchCount=1 的调用）', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .post('/api/admin/sales-invites')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ count: 1 })

    expect(res.status).toBe(201)
    expect(res.body).not.toHaveProperty('items')
    expect(res.body.inviteCode).toMatch(/^[A-Z2-9]{8}$/)
  })

  it('count=10 → 201 + {count:10, items:[10个]}', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .post('/api/admin/sales-invites')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ count: 10 })

    expect(res.status).toBe(201)
    expect(res.body.count).toBe(10)
    expect(res.body.items).toHaveLength(10)
    // 每个 item 结构完整
    for (const it of res.body.items) {
      expect(it.inviteCode).toMatch(/^[A-Z2-9]{8}$/)
      expect(it.status).toBe('UNUSED')
      expect(it.inviteUrl).toContain('/sales/join?invite=')
    }
    // 邀请码全部唯一
    const codes = new Set(res.body.items.map((i: any) => i.inviteCode))
    expect(codes.size).toBe(10)

    expect(await prisma.salesInvite.count()).toBe(10)
  })

  it('count=100 超过上限 → 后端截断到 50', async () => {
    const admin = await createUser({ role: 'admin' })
    const res = await request(app)
      .post('/api/admin/sales-invites')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ count: 100 })

    expect(res.status).toBe(201)
    expect(res.body.count).toBe(50)
    expect(res.body.items).toHaveLength(50)
    expect(await prisma.salesInvite.count()).toBe(50)
  })

  it('count=0 / 负数 / 非数字 → 兜底为 1', async () => {
    const admin = await createUser({ role: 'admin' })
    for (const v of [0, -5, 'abc' as any, null]) {
      await cleanInvites()
      const res = await request(app)
        .post('/api/admin/sales-invites')
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({ count: v })
      expect(res.status).toBe(201)
      // 等价 count=1，返回单对象
      expect(res.body).not.toHaveProperty('items')
      expect(res.body.inviteCode).toMatch(/^[A-Z2-9]{8}$/)
    }
  })

  it('无 token → 401', async () => {
    const res = await request(app).post('/api/admin/sales-invites').send({ count: 5 })
    expect(res.status).toBe(401)
  })

  it('非 admin token（普通 user）→ 403', async () => {
    const u = await createUser({ role: 'user' })
    const res = await request(app)
      .post('/api/admin/sales-invites')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
      .send({ count: 5 })
    expect(res.status).toBe(403)
  })

  it('非 admin token（sales）→ 403', async () => {
    const u = await createUser({ role: 'sales' })
    const res = await request(app)
      .post('/api/admin/sales-invites')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'sales')}`)
      .send({ count: 5 })
    expect(res.status).toBe(403)
  })
})

afterAll(async () => {
  await cleanInvites()
  await prisma.$disconnect()
})
