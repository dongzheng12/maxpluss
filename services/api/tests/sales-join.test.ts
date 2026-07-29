/**
 * POST /api/app/sales/join — 7 场景端到端测试
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

async function cleanSales() {
  await prisma.salesInvite.deleteMany()
  await prisma.salesCode.deleteMany()
  await prisma.salesProfile.deleteMany()
}

async function createInvite(adminId: string, opts: { status?: string; expiresAt?: Date | null } = {}) {
  return prisma.salesInvite.create({
    data: {
      inviteCode: 'JOIN' + Math.random().toString(36).slice(2, 6).toUpperCase(),
      createdBy: adminId,
      status: opts.status || 'UNUSED',
      expiresAt: opts.expiresAt === undefined ? new Date(Date.now() + 30 * 86400000) : opts.expiresAt,
    },
  })
}

describe('POST /api/app/sales/join — 7 场景', () => {
  beforeEach(cleanSales)

  // 场景 1：邀请码无效
  it('S1：不存在的 inviteCode → 400', async () => {
    const res = await request(app).post('/api/app/sales/join').send({
      inviteCode: 'NOTEXIST',
      phone: '13911110001',
      password: 'pass1234',
      realName: 'X',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/邀请码/)
  })

  it('S1：USED 邀请码 → 400', async () => {
    const admin = await createUser({ role: 'admin' })
    const inv = await createInvite(admin.id, { status: 'USED' })
    const res = await request(app).post('/api/app/sales/join').send({
      inviteCode: inv.inviteCode,
      phone: '13911110002', password: 'pass1234', realName: 'X',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/已被使用/)
  })

  it('S1：DISABLED 邀请码 → 400', async () => {
    const admin = await createUser({ role: 'admin' })
    const inv = await createInvite(admin.id, { status: 'DISABLED' })
    const res = await request(app).post('/api/app/sales/join').send({
      inviteCode: inv.inviteCode,
      phone: '13911110003', password: 'pass1234', realName: 'X',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/禁用/)
  })

  it('S1：过期 → 400 + 状态自动更新为 EXPIRED', async () => {
    const admin = await createUser({ role: 'admin' })
    const inv = await createInvite(admin.id, { expiresAt: new Date(Date.now() - 1000) })
    const res = await request(app).post('/api/app/sales/join').send({
      inviteCode: inv.inviteCode,
      phone: '13911110004', password: 'pass1234', realName: 'X',
    })
    expect(res.status).toBe(400)
    const after = await prisma.salesInvite.findUnique({ where: { id: inv.id } })
    expect(after?.status).toBe('EXPIRED')
  })

  // 场景 2：未登录 + 手机号未注册 → 注册新销售 + 直接发 token
  it('S2：未登录 + 未注册手机号 → 201 + 返回 token + 创建用户/Profile/SalesCode 主码', async () => {
    const admin = await createUser({ role: 'admin' })
    const inv = await createInvite(admin.id)
    const phone = '13911112001'
    const res = await request(app).post('/api/app/sales/join').send({
      inviteCode: inv.inviteCode,
      phone, password: 'newpass123', realName: '场景2新销售',
    })
    expect(res.status).toBe(201)
    expect(res.body.note).toBe('register')
    expect(res.body.token).toBeTruthy()
    expect(res.body.salesCode).toMatch(/^[A-Z2-9]{8}$/)

    const newUser = await prisma.appUser.findUnique({ where: { phone } })
    expect(newUser?.role).toBe('sales')
    const profile = await prisma.salesProfile.findUnique({ where: { userId: newUser!.id } })
    expect(profile).not.toBeNull()
    const main = await prisma.salesCode.findUnique({ where: { salesCode: res.body.salesCode } })
    expect(main?.label).toBe('主码')
    const usedInv = await prisma.salesInvite.findUnique({ where: { id: inv.id } })
    expect(usedInv?.status).toBe('USED')
  })

  // 场景 3：未登录 + 手机号已注册 → 409 + hint=login_and_bind
  it('S3：未登录 + 手机号已注册 → 409 + hint=login_and_bind', async () => {
    const admin = await createUser({ role: 'admin' })
    const inv = await createInvite(admin.id)
    const phone = '13911113001'
    await createUser({ phone, role: 'user' })

    const res = await request(app).post('/api/app/sales/join').send({
      inviteCode: inv.inviteCode,
      phone, password: 'whatever123', realName: 'X',
    })
    expect(res.status).toBe(409)
    expect(res.body.hint).toBe('login_and_bind')

    // 邀请码不应被消耗
    const after = await prisma.salesInvite.findUnique({ where: { id: inv.id } })
    expect(after?.status).toBe('UNUSED')
  })

  // 场景 4：已登录 + 普通 user + 无 SalesProfile → 200 note=upgraded
  it('S4：已登录 + 非销售 + 无 SalesProfile → 200 note=upgraded', async () => {
    const admin = await createUser({ role: 'admin' })
    const inv = await createInvite(admin.id)
    const u = await createUser({ role: 'user' })

    const res = await request(app)
      .post('/api/app/sales/join')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
      .send({ inviteCode: inv.inviteCode, realName: '升级销售' })
    expect(res.status).toBe(200)
    expect(res.body.note).toBe('upgraded')
    expect(res.body.token).toBeTruthy()
    expect(res.body.salesCode).toMatch(/^[A-Z2-9]{8}$/)

    const userAfter = await prisma.appUser.findUnique({ where: { id: u.id } })
    expect(userAfter?.role).toBe('sales')
  })

  // 场景 5：已登录 + role=sales + 无 SalesProfile（异常态） → 200 note=profile_created
  it('S5：已登录 + role=sales 但无 Profile → 200 note=profile_created', async () => {
    const admin = await createUser({ role: 'admin' })
    const inv = await createInvite(admin.id)
    const u = await createUser({ role: 'sales' })   // role 是 sales 但没建 SalesProfile

    const res = await request(app)
      .post('/api/app/sales/join')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'sales')}`)
      .send({ inviteCode: inv.inviteCode })
    expect(res.status).toBe(200)
    expect(res.body.note).toBe('profile_created')
  })

  // 场景 6：已登录 + 已有 SalesProfile → 409
  it('S6：已登录 + 已有完整 SalesProfile → 409', async () => {
    const admin = await createUser({ role: 'admin' })
    const inv = await createInvite(admin.id)
    const u = await createUser({ role: 'sales' })
    await prisma.salesProfile.create({
      data: {
        salesCode: 'EXISTSALES',
        userId: u.id,
        realName: '已是销售',
        status: 'ENABLED',
      },
    })

    const res = await request(app)
      .post('/api/app/sales/join')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'sales')}`)
      .send({ inviteCode: inv.inviteCode })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/已开通销售身份/)
  })

  // 场景 7：已登录 admin → 403
  it('S7：已登录 admin → 403 + 邀请码不消耗', async () => {
    const admin = await createUser({ role: 'admin' })
    const inv = await createInvite(admin.id)

    const res = await request(app)
      .post('/api/app/sales/join')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ inviteCode: inv.inviteCode })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/管理员账号/)

    const after = await prisma.salesInvite.findUnique({ where: { id: inv.id } })
    expect(after?.status).toBe('UNUSED')
  })

  // 边界：未登录 + 缺必填 → 400
  it('未登录路径下缺 phone/password/realName → 400', async () => {
    const admin = await createUser({ role: 'admin' })
    const inv = await createInvite(admin.id)
    const res = await request(app).post('/api/app/sales/join').send({
      inviteCode: inv.inviteCode,
      // 没传 phone/password/realName
    })
    expect(res.status).toBe(400)
  })
})

afterAll(async () => {
  await cleanSales()
  await prisma.$disconnect()
})
