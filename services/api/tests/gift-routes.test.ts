/**
 * 销售赠送闭环测试 — giftRoutes.ts
 * 覆盖：
 *   前台：查询（5 状态分支 + IP 限速） / 已登录 claim / 注册并领取
 *   后台：创建（档位 refine） / 列表 / 详情 / 作废 / 撤销已发放权益 / 批量导入 / 模板下载 / 统计
 *
 * 锁定项（必读/MEMORY.md）：
 *   - GIFT_TIERS 4 档白名单：personal/7、personal/30、personal/365、pro/365
 *   - 乐观锁：原子 updateMany {status:PENDING} → CLAIMED 防并发重复领取
 *   - 失败回滚：phone/email/sms 校验失败必须回滚 status=PENDING
 *   - source=SALES_GIFT，sourceRef=赠送码（精确撤销靠这个）
 *   - 撤销已发放权益：membership 标 REVOKED + gift 标 REVOKED
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import crypto from 'node:crypto'
import { prisma } from '../src/db.js'
import { registerGiftRoutes } from '../src/giftRoutes.js'
import { createUser, getTestToken, ensurePlans, cleanAll } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerGiftRoutes(app)
})

beforeEach(async () => {
  // factory.cleanAll 不清 salesGift / verificationCode，本测试需要手动清
  await prisma.salesGift.deleteMany()
  await prisma.verificationCode.deleteMany()
  await cleanAll()
  await ensurePlans()
})

// ─── 工具 ─────────────────────────────────────────

let ipSeed = 0
function uniqueIp() {
  // 每次返回不同 IP，避开 GET 查询接口的 5/min 限速
  ipSeed++
  return `10.${(ipSeed >> 16) & 0xff}.${(ipSeed >> 8) & 0xff}.${ipSeed & 0xff}`
}

async function createAdmin() {
  const u = await createUser({ role: 'admin' })
  return { user: u, token: getTestToken(u.id, 'admin') }
}
async function createNormalUser(phone?: string) {
  const u = await createUser({ phone, role: 'user' })
  return { user: u, token: getTestToken(u.id, 'user') }
}

async function seedGift(opts: Partial<{
  code: string; phone: string; email: string; planId: string;
  durationDays: number; status: string; expiresAt: Date;
  createdBy: string; createdByName: string;
}> = {}) {
  return prisma.salesGift.create({
    data: {
      id: crypto.randomUUID(),
      code: opts.code ?? `GFT${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      phone: opts.phone ?? '13900001111',
      email: opts.email ?? '',
      planId: opts.planId ?? 'personal',
      durationDays: opts.durationDays ?? 365,
      status: opts.status ?? 'PENDING',
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdBy: opts.createdBy ?? 'admin-seed',
      createdByName: opts.createdByName ?? '种子管理员',
    },
  })
}

// ════════════════════════════════════════════════════════════
// 前台：GET /api/app/gifts/:code
// ════════════════════════════════════════════════════════════

describe('GET /api/app/gifts/:code 查询赠送码', () => {
  it('happy：PENDING + 未过期 → 200 + planName + phone/email 脱敏', async () => {
    const gift = await seedGift({
      code: 'GIFTHAPY', phone: '13800138001', email: 'cust@example.com',
    })
    const res = await request(app)
      .get(`/api/app/gifts/${gift.code}`)
      .set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(200)
    expect(res.body.code).toBe('GIFTHAPY')
    expect(res.body.planName).toBe('个人包年')
    expect(res.body.durationDays).toBe(365)
    // 脱敏：手机号 + 邮箱不应原样返回
    expect(res.body.phone).not.toBe('13800138001')
    expect(res.body.email).not.toBe('cust@example.com')
  })

  it('赠送码不存在 → 404', async () => {
    const res = await request(app)
      .get('/api/app/gifts/NOSUCH99')
      .set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(404)
  })

  it('CLAIMED → 410 + status:CLAIMED', async () => {
    const gift = await seedGift({ status: 'CLAIMED' })
    const res = await request(app)
      .get(`/api/app/gifts/${gift.code}`)
      .set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(410)
    expect(res.body.status).toBe('CLAIMED')
  })

  it('REVOKED → 410 + status:REVOKED', async () => {
    const gift = await seedGift({ status: 'REVOKED' })
    const res = await request(app)
      .get(`/api/app/gifts/${gift.code}`)
      .set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(410)
    expect(res.body.status).toBe('REVOKED')
  })

  it('已过期（expiresAt < now）→ 410 + status:EXPIRED', async () => {
    const gift = await seedGift({ expiresAt: new Date(Date.now() - 1000) })
    const res = await request(app)
      .get(`/api/app/gifts/${gift.code}`)
      .set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(410)
    expect(res.body.status).toBe('EXPIRED')
  })

  it('IP 限速：同 IP 5/min，第 6 次 429', async () => {
    const ip = '198.51.100.42' // 专属 IP
    const gift = await seedGift({ code: 'IPLIM001' })
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .get(`/api/app/gifts/${gift.code}`)
        .set('X-Forwarded-For', ip)
      expect(r.status).toBe(200)
    }
    const r6 = await request(app)
      .get(`/api/app/gifts/${gift.code}`)
      .set('X-Forwarded-For', ip)
    expect(r6.status).toBe(429)
  })
})

// ════════════════════════════════════════════════════════════
// 前台：POST /api/app/gifts/:code/claim
// ════════════════════════════════════════════════════════════

describe('POST /api/app/gifts/:code/claim 已登录领取', () => {
  it('无 token → 401', async () => {
    const gift = await seedGift()
    const res = await request(app)
      .post(`/api/app/gifts/${gift.code}/claim`)
      .send({})
    expect(res.status).toBe(401)
  })

  it('happy：phone 匹配 + PENDING → 200 + 发放 SALES_GIFT 会员 + 状态 CLAIMED', async () => {
    const u = await createNormalUser('13700001234')
    const gift = await seedGift({
      code: 'CLAIMOK1', phone: '13700001234', planId: 'personal', durationDays: 30,
    })
    const res = await request(app)
      .post(`/api/app/gifts/${gift.code}/claim`)
      .set('Authorization', `Bearer ${u.token}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.message).toMatch(/领取成功/)
    expect(res.body.membership.planId).toBe('personal')

    // gift 标 CLAIMED + 关联 membershipId
    const updatedGift = await prisma.salesGift.findUnique({ where: { id: gift.id } })
    expect(updatedGift!.status).toBe('CLAIMED')
    expect(updatedGift!.claimedBy).toBe(u.user.id)
    expect(updatedGift!.membershipId).toBeTruthy()

    // 创建的 membership：source=SALES_GIFT + sourceRef=赠送码
    const m = await prisma.userMembership.findUnique({ where: { id: updatedGift!.membershipId! } })
    expect(m!.source).toBe('SALES_GIFT')
    expect(m!.sourceRef).toBe('CLAIMOK1')
    expect(m!.status).toBe('ACTIVE')
  })

  it('phone 不匹配 → 403 + 状态自动回滚 PENDING', async () => {
    const u = await createNormalUser('13888888888') // 用户手机号
    const gift = await seedGift({ phone: '13700001234' }) // 赠送码绑定了别的手机
    const res = await request(app)
      .post(`/api/app/gifts/${gift.code}/claim`)
      .set('Authorization', `Bearer ${u.token}`)
      .send({})
    expect(res.status).toBe(403)
    const after = await prisma.salesGift.findUnique({ where: { id: gift.id } })
    expect(after!.status).toBe('PENDING') // 回滚
    expect(after!.claimedBy).toBeNull()
  })

  it('已 CLAIMED → 400「已被领取」', async () => {
    const u = await createNormalUser('13700001234')
    const gift = await seedGift({ phone: '13700001234', status: 'CLAIMED' })
    const res = await request(app)
      .post(`/api/app/gifts/${gift.code}/claim`)
      .set('Authorization', `Bearer ${u.token}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/已被领取/)
  })

  it('已过期 → 400', async () => {
    const u = await createNormalUser('13700001234')
    const gift = await seedGift({
      phone: '13700001234',
      expiresAt: new Date(Date.now() - 1000),
    })
    const res = await request(app)
      .post(`/api/app/gifts/${gift.code}/claim`)
      .set('Authorization', `Bearer ${u.token}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/已过期/)
  })

  it('叠加续期：已有 ACTIVE 会员 → 新 endAt = 旧 endAt + 赠送天数', async () => {
    const u = await createNormalUser('13700001234')
    const oldEndAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 天后
    await prisma.userMembership.create({
      data: {
        userId: u.user.id, planId: 'personal', source: 'PURCHASE',
        status: 'ACTIVE', startAt: new Date(), endAt: oldEndAt,
      },
    })
    const gift = await seedGift({
      code: 'RENEW001', phone: '13700001234', durationDays: 7,
    })
    const res = await request(app)
      .post(`/api/app/gifts/${gift.code}/claim`)
      .set('Authorization', `Bearer ${u.token}`)
      .send({})
    expect(res.status).toBe(200)
    const newEndAt = new Date(res.body.membership.endAt).getTime()
    const expected = oldEndAt.getTime() + 7 * 24 * 60 * 60 * 1000
    expect(Math.abs(newEndAt - expected)).toBeLessThan(1000) // 容忍 1s 误差
  })
})

// ════════════════════════════════════════════════════════════
// 前台：POST /api/app/gifts/:code/claim-with-register
// ════════════════════════════════════════════════════════════

describe('POST /api/app/gifts/:code/claim-with-register 注册并领取', () => {
  async function seedSmsCode(phone: string, code = '123456') {
    return prisma.verificationCode.create({
      data: {
        target: phone, type: 'phone', code,
        purpose: 'register',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    })
  }

  it('happy：phone 匹配 + 短信码正确 + 新手机号 → 201 + token + membership', async () => {
    const phone = '13900111222'
    await seedSmsCode(phone, '888888')
    const gift = await seedGift({ code: 'CWREG001', phone, durationDays: 365, planId: 'pro' })
    const res = await request(app)
      .post(`/api/app/gifts/${gift.code}/claim-with-register`)
      .send({ phone, smsCode: '888888', password: 'pwd123', name: '小明' })
    expect(res.status).toBe(201)
    expect(res.body.token).toBeTruthy()
    expect(res.body.user.phone).toBe(phone)
    expect(res.body.membership.planId).toBe('pro')

    const newUser = await prisma.appUser.findUnique({ where: { phone } })
    expect(newUser).not.toBeNull()
    expect(newUser!.role).toBe('user')
  })

  it('phone 与赠送记录不一致 → 403 + 状态回滚 PENDING', async () => {
    const gift = await seedGift({ code: 'CWREG002', phone: '13700000000' })
    const res = await request(app)
      .post(`/api/app/gifts/${gift.code}/claim-with-register`)
      .send({ phone: '13900222333', smsCode: '123456', password: 'pwd123' })
    expect(res.status).toBe(403)
    const after = await prisma.salesGift.findUnique({ where: { id: gift.id } })
    expect(after!.status).toBe('PENDING')
  })

  it('短信码错误 → 400 + 状态回滚 PENDING', async () => {
    const phone = '13900333444'
    await seedSmsCode(phone, '111111')
    const gift = await seedGift({ code: 'CWREG003', phone })
    const res = await request(app)
      .post(`/api/app/gifts/${gift.code}/claim-with-register`)
      .send({ phone, smsCode: '999999', password: 'pwd123' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/验证码/)
    const after = await prisma.salesGift.findUnique({ where: { id: gift.id } })
    expect(after!.status).toBe('PENDING')
  })

  it('手机号已注册（有 passwordHash）→ 409 + 状态回滚', async () => {
    const phone = '13900444555'
    await createUser({ phone })
    await seedSmsCode(phone, '222222')
    const gift = await seedGift({ code: 'CWREG004', phone })
    const res = await request(app)
      .post(`/api/app/gifts/${gift.code}/claim-with-register`)
      .send({ phone, smsCode: '222222', password: 'pwd123' })
    expect(res.status).toBe(409)
    const after = await prisma.salesGift.findUnique({ where: { id: gift.id } })
    expect(after!.status).toBe('PENDING')
  })

  it('参数 schema 错误（短信码非 6 位）→ 400 + 状态回滚', async () => {
    const gift = await seedGift({ code: 'CWREG005', phone: '13900555666' })
    const res = await request(app)
      .post(`/api/app/gifts/${gift.code}/claim-with-register`)
      .send({ phone: '13900555666', smsCode: '12', password: 'pwd123' })
    expect(res.status).toBe(400)
    const after = await prisma.salesGift.findUnique({ where: { id: gift.id } })
    expect(after!.status).toBe('PENDING')
  })
})

// ════════════════════════════════════════════════════════════
// 后台：POST /api/admin/gifts 创建
// ════════════════════════════════════════════════════════════

describe('POST /api/admin/gifts 创建赠送（含档位 refine）', () => {
  let adminToken: string

  beforeEach(async () => {
    const a = await createAdmin()
    adminToken = a.token
  })

  it('权限：无 token 401 / user 403 / sales 403', async () => {
    const u = await createNormalUser()
    const r1 = await request(app).post('/api/admin/gifts').send({ phone: '13800138000', planId: 'personal', durationDays: 365 })
    expect(r1.status).toBe(401)
    const r2 = await request(app).post('/api/admin/gifts')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ phone: '13800138000', planId: 'personal', durationDays: 365 })
    expect(r2.status).toBe(403)
    const sales = await createUser({ role: 'sales' })
    const r3 = await request(app).post('/api/admin/gifts')
      .set('Authorization', `Bearer ${getTestToken(sales.id, 'sales')}`)
      .send({ phone: '13800138000', planId: 'personal', durationDays: 365 })
    expect(r3.status).toBe(403)
  })

  it('happy：personal/365 → 201 + 8 位 code + claimUrl', async () => {
    const res = await request(app).post('/api/admin/gifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '13800138001', planId: 'personal', durationDays: 365, note: '客户A' })
    expect(res.status).toBe(201)
    expect(res.body.code).toMatch(/^[A-Z0-9]{8}$/)
    expect(res.body.claimUrl).toBe(`/claim/${res.body.code}`)
  })

  it('档位白名单：personal/7 → 201', async () => {
    const res = await request(app).post('/api/admin/gifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '13800138001', planId: 'personal', durationDays: 7 })
    expect(res.status).toBe(201)
  })

  it('档位白名单：personal/30 → 201', async () => {
    const res = await request(app).post('/api/admin/gifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '13800138001', planId: 'personal', durationDays: 30 })
    expect(res.status).toBe(201)
  })

  it('档位白名单：pro/365 → 201', async () => {
    const res = await request(app).post('/api/admin/gifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '13800138001', planId: 'pro', durationDays: 365 })
    expect(res.status).toBe(201)
  })

  it('档位非法：pro/30 → 400「档位组合不合法」', async () => {
    const res = await request(app).post('/api/admin/gifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '13800138001', planId: 'pro', durationDays: 30 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/档位组合/)
  })

  it('档位非法：pro/7 → 400', async () => {
    const res = await request(app).post('/api/admin/gifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '13800138001', planId: 'pro', durationDays: 7 })
    expect(res.status).toBe(400)
  })

  it('phone 格式错误 → 400', async () => {
    const res = await request(app).post('/api/admin/gifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '12345', planId: 'personal', durationDays: 365 })
    expect(res.status).toBe(400)
  })

  it('durationDays 不在 [7,30,365] → 400', async () => {
    const res = await request(app).post('/api/admin/gifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '13800138001', planId: 'personal', durationDays: 90 })
    expect(res.status).toBe(400)
  })

  it('已存在该客户的 PENDING 赠送 → 201 + warning 字段', async () => {
    await seedGift({ phone: '13800138099', status: 'PENDING' })
    const res = await request(app).post('/api/admin/gifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '13800138099', planId: 'personal', durationDays: 365 })
    expect(res.status).toBe(201)
    expect(res.body.warning).toMatch(/已有未领取/)
  })
})

// ════════════════════════════════════════════════════════════
// 后台：列表 / 详情 / 模板 / 统计
// ════════════════════════════════════════════════════════════

describe('GET /api/admin/gifts 列表', () => {
  let adminToken: string
  beforeEach(async () => {
    const a = await createAdmin()
    adminToken = a.token
  })

  it('权限拦截：user 403', async () => {
    const u = await createNormalUser()
    const res = await request(app).get('/api/admin/gifts')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(403)
  })

  it('happy：返回分页 + phone/email 脱敏 + logs JSON 解析', async () => {
    await seedGift({ code: 'LIST0001', phone: '13888888888' })
    await seedGift({ code: 'LIST0002', phone: '13877777777', status: 'CLAIMED' })
    const res = await request(app).get('/api/admin/gifts?page=1&pageSize=10')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBeGreaterThanOrEqual(2)
    expect(res.body.items[0].phone).not.toMatch(/^138\d{8}$/) // 脱敏
    expect(Array.isArray(res.body.items[0].logs)).toBe(true)
  })

  it('status 过滤 → 仅返回该状态', async () => {
    await seedGift({ code: 'STAT0001', status: 'PENDING' })
    await seedGift({ code: 'STAT0002', status: 'CLAIMED' })
    const res = await request(app).get('/api/admin/gifts?status=CLAIMED')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.items.every((g: any) => g.status === 'CLAIMED')).toBe(true)
  })
})

describe('GET /api/admin/gifts/:id 详情 + 单条权限', () => {
  let adminToken: string
  beforeEach(async () => {
    const a = await createAdmin()
    adminToken = a.token
  })

  it('id 不存在 → 404', async () => {
    const res = await request(app).get('/api/admin/gifts/no-such-id')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(404)
  })

  it('happy → 200 + logs 已解析为数组', async () => {
    const gift = await seedGift({ code: 'DETL0001' })
    // 写一条日志
    await prisma.salesGift.update({
      where: { id: gift.id },
      data: { logs: JSON.stringify([{ action: 'CREATED', operator: 'admin-x', time: '2026-01-01T00:00:00Z' }]) },
    })
    const res = await request(app).get(`/api/admin/gifts/${gift.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.code).toBe('DETL0001')
    expect(Array.isArray(res.body.logs)).toBe(true)
    expect(res.body.logs[0].action).toBe('CREATED')
  })
})

describe('GET /api/admin/gifts/template 模板下载', () => {
  let adminToken: string
  beforeEach(async () => {
    const a = await createAdmin()
    adminToken = a.token
  })

  it('权限：user 403', async () => {
    const u = await createNormalUser()
    const res = await request(app).get('/api/admin/gifts/template')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(403)
  })

  it('admin → 200 + Content-Disposition + xlsx', async () => {
    const res = await request(app).get('/api/admin/gifts/template')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/gift_import_template\.xlsx/)
    expect(res.headers['content-type']).toMatch(/spreadsheetml/)
  })
})

describe('GET /api/admin/gifts/stats 统计看板', () => {
  let adminToken: string
  beforeEach(async () => {
    const a = await createAdmin()
    adminToken = a.token
  })

  it('overview 字段齐 + claimRate 计算正确 + salesRanking 按 createdByName 聚合', async () => {
    await seedGift({ code: 'STA0001', status: 'CLAIMED', createdByName: '销售A' })
    await seedGift({ code: 'STA0002', status: 'CLAIMED', createdByName: '销售A' })
    await seedGift({ code: 'STA0003', status: 'PENDING', createdByName: '销售A' })
    await seedGift({ code: 'STA0004', status: 'PENDING', createdByName: '销售B' })
    const res = await request(app).get('/api/admin/gifts/stats')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.overview).toMatchObject({
      total: 4, pending: 2, claimed: 2,
    })
    expect(res.body.overview.claimRate).toBe(50) // 2/4
    expect(res.body.salesRanking).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '销售A', total: 3, claimed: 2, pending: 1 }),
      expect.objectContaining({ name: '销售B', total: 1, claimed: 0, pending: 1 }),
    ]))
    expect(res.body.monthlyStats).toHaveLength(12)
  })
})

// ════════════════════════════════════════════════════════════
// 后台：作废 / 撤销已发放权益
// ════════════════════════════════════════════════════════════

describe('POST /api/admin/gifts/:id/revoke 作废未领取', () => {
  let adminToken: string
  beforeEach(async () => {
    const a = await createAdmin()
    adminToken = a.token
  })

  it('权限：user 403', async () => {
    const gift = await seedGift({ status: 'PENDING' })
    const u = await createNormalUser()
    const res = await request(app).post(`/api/admin/gifts/${gift.id}/revoke`)
      .set('Authorization', `Bearer ${u.token}`)
      .send({})
    expect(res.status).toBe(403)
  })

  it('happy：PENDING → 200 + 状态 REVOKED + 日志写入', async () => {
    const gift = await seedGift({ status: 'PENDING' })
    const res = await request(app).post(`/api/admin/gifts/${gift.id}/revoke`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '客户取消' })
    expect(res.status).toBe(200)
    const after = await prisma.salesGift.findUnique({ where: { id: gift.id } })
    expect(after!.status).toBe('REVOKED')
    expect(after!.revokeReason).toBe('客户取消')
    const logs = JSON.parse(after!.logs!)
    expect(logs[logs.length - 1].action).toBe('REVOKED')
  })

  it('CLAIMED 不能作废 → 400「只能作废未领取」', async () => {
    const gift = await seedGift({ status: 'CLAIMED' })
    const res = await request(app).post(`/api/admin/gifts/${gift.id}/revoke`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/未领取/)
  })

  it('id 不存在 → 404', async () => {
    const res = await request(app).post('/api/admin/gifts/no-id/revoke')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(res.status).toBe(404)
  })
})

describe('POST /api/admin/gifts/:id/revoke-membership 撤销已发放权益', () => {
  let adminToken: string
  beforeEach(async () => {
    const a = await createAdmin()
    adminToken = a.token
  })

  async function seedClaimedGiftWithMembership() {
    const u = await createUser()
    const m = await prisma.userMembership.create({
      data: {
        userId: u.id, planId: 'personal', source: 'SALES_GIFT',
        sourceRef: 'CMG00001', status: 'ACTIVE',
        startAt: new Date(),
        endAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    })
    const g = await seedGift({
      code: 'CMG00001', status: 'CLAIMED', phone: u.phone,
    })
    await prisma.salesGift.update({
      where: { id: g.id }, data: { claimedBy: u.id, membershipId: m.id, claimedAt: new Date() },
    })
    return { user: u, membership: m, gift: g }
  }

  it('权限：user 403', async () => {
    const { gift } = await seedClaimedGiftWithMembership()
    const u = await createNormalUser()
    const res = await request(app).post(`/api/admin/gifts/${gift.id}/revoke-membership`)
      .set('Authorization', `Bearer ${u.token}`)
      .send({})
    expect(res.status).toBe(403)
  })

  it('happy：membership → REVOKED + gift → REVOKED', async () => {
    const { membership, gift } = await seedClaimedGiftWithMembership()
    const res = await request(app).post(`/api/admin/gifts/${gift.id}/revoke-membership`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '违规操作' })
    expect(res.status).toBe(200)
    const m = await prisma.userMembership.findUnique({ where: { id: membership.id } })
    expect(m!.status).toBe('REVOKED')
    expect(m!.revokeReason).toBe('违规操作')
    const g = await prisma.salesGift.findUnique({ where: { id: gift.id } })
    expect(g!.status).toBe('REVOKED')
  })

  it('PENDING 不能撤销权益 → 400「只能撤销已领取」', async () => {
    const gift = await seedGift({ status: 'PENDING' })
    const res = await request(app).post(`/api/admin/gifts/${gift.id}/revoke-membership`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/已领取/)
  })

  it('CLAIMED 但 membershipId=null → 400', async () => {
    const gift = await seedGift({ status: 'CLAIMED' }) // 无 membershipId
    const res = await request(app).post(`/api/admin/gifts/${gift.id}/revoke-membership`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(res.status).toBe(400)
  })
})

// ════════════════════════════════════════════════════════════
// 后台：批量导入
// ════════════════════════════════════════════════════════════

describe('POST /api/admin/gifts/batch 批量导入', () => {
  let adminToken: string
  beforeEach(async () => {
    const a = await createAdmin()
    adminToken = a.token
  })

  // 工具：构造一个 .xlsx Buffer
  async function buildXlsx(rows: Array<Record<string, any>>) {
    const xlsx = (await import('xlsx')).default || (await import('xlsx'))
    const ws = xlsx.utils.json_to_sheet(rows)
    const wb = xlsx.utils.book_new()
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1')
    return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
  }

  it('权限：user 403', async () => {
    const u = await createNormalUser()
    const res = await request(app).post('/api/admin/gifts/batch')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(403)
  })

  it('缺文件 → 400「请上传」', async () => {
    const res = await request(app).post('/api/admin/gifts/batch')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/上传/)
  })

  it('happy：3 行（2 成功 + 1 手机号无效）→ 200 + results 区分 success/failed', async () => {
    const buf = await buildXlsx([
      { '手机号': '13800138001', '权益类型': 'personal', '赠送时长(天)': 365, '备注': 'A' },
      { '手机号': '13800138002', '权益类型': 'pro', '赠送时长(天)': 365, '备注': 'B' },
      { '手机号': 'INVALID',     '权益类型': 'personal', '赠送时长(天)': 365, '备注': 'X' },
    ])
    const res = await request(app).post('/api/admin/gifts/batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', buf, 'import.xlsx')
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(3)
    expect(res.body.success).toBe(2)
    expect(res.body.failed).toBe(1)
    expect(res.body.results.find((r: any) => r.phone === 'INVALID').error).toMatch(/手机号格式/)
  })

  it('档位非法 pro/30 → results error「档位组合不合法」', async () => {
    const buf = await buildXlsx([
      { '手机号': '13800138003', '权益类型': 'pro', '赠送时长(天)': 30, '备注': '专业30天非法' },
    ])
    const res = await request(app).post('/api/admin/gifts/batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', buf, 'bad.xlsx')
    expect(res.status).toBe(200)
    expect(res.body.failed).toBe(1)
    expect(res.body.results[0].error).toMatch(/档位组合/)
  })
})
