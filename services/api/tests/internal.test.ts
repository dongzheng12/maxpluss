/**
 * 任务二测试 — 内部接口 + subscribe/grant + R06/R15 真实查询 + push/send 全流程
 *
 * 微信 API 调用用 __setWxSubscribeSender / __setWxTokenFetcher 打桩，不真连外网。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { registerInternalRoutes } from '../src/internal/routes.js'
import { __setWxSubscribeSender } from '../src/internal/wxSubscribeMessage.js'
import { __setWxTokenFetcher, __clearWxTokenCache } from '../src/internal/wxAccessToken.js'
import { TEMPLATE_R06, TEMPLATE_R15 } from '../src/internal/rules/types.js'
import { createUser, getTestToken, ensurePlans } from './factory.js'

const app = express()
app.use(express.json())

const INTERNAL_TOKEN = 'test-internal-secret-xxxx'

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = INTERNAL_TOKEN
  process.env.WX_APPID = 'wx-test-appid'
  process.env.WX_SECRET = 'wx-test-secret'

  await ensurePlans()
  registerAppRoutes(app)
  registerInternalRoutes(app)
  await ensureAppSeed()

  // 微信 API 打桩：token 固定 + send 默认成功
  __setWxTokenFetcher(async () => ({ access_token: 'fake-token', expires_in: 7200 }))
  __setWxSubscribeSender(async () => ({ errcode: 0, errmsg: 'ok' }))
})

afterAll(() => {
  __setWxSubscribeSender(null)
  __setWxTokenFetcher(null)
  __clearWxTokenCache()
})

describe('内部认证中间件', () => {
  it('缺 x-internal-token → 401', async () => {
    const res = await request(app).get('/api/internal/users/rule/R06')
    expect(res.status).toBe(401)
  })

  it('错误 token → 401', async () => {
    const res = await request(app).get('/api/internal/users/rule/R06').set('x-internal-token', 'wrong')
    expect(res.status).toBe(401)
  })

  it('正确 token + 未知规则 → 404', async () => {
    const res = await request(app).get('/api/internal/users/rule/R99').set('x-internal-token', INTERNAL_TOKEN)
    expect(res.status).toBe(404)
  })

  it('正确 token + R01 骨架 → 200 + 空数组', async () => {
    const res = await request(app).get('/api/internal/users/rule/R01').set('x-internal-token', INTERNAL_TOKEN)
    expect(res.status).toBe(200)
    expect(res.body.users).toEqual([])
  })
})

describe('R06 查询：下单未支付召回', () => {
  let userId: string
  beforeEach(async () => {
    await prisma.pushLog.deleteMany()
    await prisma.subscribeQuota.deleteMany()
    await prisma.appOrder.deleteMany({ where: { orderNo: { startsWith: 'ORD-R06-' } } })
    const u = await createUser({ phone: `138${Math.floor(Math.random() * 1e8)}` })
    await prisma.appUser.update({ where: { id: u.id }, data: { openId: `openid-r06-${u.id}` } })
    userId = u.id
  })

  async function mkPendingOrder(ageMin: number, orderNo = `ORD-R06-${Date.now()}-${Math.random()}`) {
    return prisma.appOrder.create({
      data: {
        orderNo, userId, planId: 'personal', productType: 'MEMBERSHIP',
        title: '个人会员', amount: 59800, status: 'PENDING',
        createdAt: new Date(Date.now() - ageMin * 60 * 1000),
      },
    })
  }

  it('30-60 分钟前 + 有配额 → 命中', async () => {
    const order = await mkPendingOrder(45)
    await prisma.subscribeQuota.create({ data: { userId, templateId: TEMPLATE_R06, quota: 1 } })

    const res = await request(app).get('/api/internal/users/rule/R06').set('x-internal-token', INTERNAL_TOKEN)
    expect(res.status).toBe(200)
    expect(res.body.users.length).toBe(1)
    const u = res.body.users[0]
    expect(u.userId).toBe(userId)
    expect(u.refId).toBe(order.orderNo)
    expect(u.templateId).toBe(TEMPLATE_R06)
    expect(u.templateData.character_string1).toBe(order.orderNo)
    expect(u.templateData.amount2).toBe('598.00')
    expect(u.templateData.date3).toMatch(/^\d{4}-\d{2}-\d{2}$/) // wx date 类型只接 YYYY-MM-DD
    expect(u.templateData.thing4.length).toBeLessThanOrEqual(20) // wx thing 限 20 字
    expect(u.templateData.phrase5).toBe('待支付')
    expect(u.templateData.phrase5.length).toBeLessThanOrEqual(5) // wx phrase 限 5 字
  })

  it('< 30 分钟新单 → 不命中', async () => {
    await mkPendingOrder(10)
    await prisma.subscribeQuota.create({ data: { userId, templateId: TEMPLATE_R06, quota: 1 } })
    const res = await request(app).get('/api/internal/users/rule/R06').set('x-internal-token', INTERNAL_TOKEN)
    expect(res.body.users.length).toBe(0)
  })

  it('无配额 → 不命中', async () => {
    await mkPendingOrder(45)
    const res = await request(app).get('/api/internal/users/rule/R06').set('x-internal-token', INTERNAL_TOKEN)
    expect(res.body.users.length).toBe(0)
  })

  it('已推过该 orderNo → 不命中', async () => {
    const order = await mkPendingOrder(45)
    await prisma.subscribeQuota.create({ data: { userId, templateId: TEMPLATE_R06, quota: 1 } })
    await prisma.pushLog.create({ data: { userId, ruleId: 'R06', status: 'SUCCESS', refId: order.orderNo } })
    const res = await request(app).get('/api/internal/users/rule/R06').set('x-internal-token', INTERNAL_TOKEN)
    expect(res.body.users.length).toBe(0)
  })
})

describe('R15 查询：首扫奖励', () => {
  let userId: string
  beforeEach(async () => {
    await prisma.pushLog.deleteMany()
    await prisma.subscribeQuota.deleteMany()
    const u = await createUser({ phone: `138${Math.floor(Math.random() * 1e8)}` })
    await prisma.appUser.update({
      where: { id: u.id },
      data: {
        openId: `openid-r15-${u.id}`,
        firstScanAt: new Date(Date.now() - 45 * 60 * 1000), // 45 分钟前
      },
    })
    userId = u.id
  })

  it('首扫 45 分钟前 + 有配额 → 命中，字段 key 对齐公众平台模板', async () => {
    await prisma.subscribeQuota.create({ data: { userId, templateId: TEMPLATE_R15, quota: 1 } })
    const res = await request(app).get('/api/internal/users/rule/R15').set('x-internal-token', INTERNAL_TOKEN)
    expect(res.body.users.length).toBe(1)
    const u = res.body.users[0]
    expect(u.templateId).toBe(TEMPLATE_R15)
    // 真实模板 key 断言（防回退）
    expect(u.templateData.phrase1.length).toBeLessThanOrEqual(5) // phrase 限 5 字
    expect(u.templateData.time2).toBe('7天')
    expect(u.templateData.thing3.length).toBeLessThanOrEqual(20)
    expect(u.templateData.number4).toBe(7) // number 类型必须整数
    expect(typeof u.templateData.number4).toBe('number')
    expect(u.templateData.time5).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('已推过 → 不命中', async () => {
    await prisma.subscribeQuota.create({ data: { userId, templateId: TEMPLATE_R15, quota: 1 } })
    await prisma.pushLog.create({ data: { userId, ruleId: 'R15', status: 'SUCCESS' } })
    const res = await request(app).get('/api/internal/users/rule/R15').set('x-internal-token', INTERNAL_TOKEN)
    expect(res.body.users.length).toBe(0)
  })
})

describe('POST /api/internal/push/send', () => {
  let userId: string
  let openid: string

  beforeEach(async () => {
    await prisma.pushLog.deleteMany()
    await prisma.subscribeQuota.deleteMany()
    await prisma.userMembership.deleteMany()
    const u = await createUser({ phone: `138${Math.floor(Math.random() * 1e8)}` })
    openid = `openid-send-${u.id}`
    await prisma.appUser.update({ where: { id: u.id }, data: { openId: openid } })
    userId = u.id
    // 默认恢复成功桩
    __setWxSubscribeSender(async () => ({ errcode: 0, errmsg: 'ok' }))
  })

  it('无配额 → NO_QUOTA', async () => {
    const res = await request(app).post('/api/internal/push/send')
      .set('x-internal-token', INTERNAL_TOKEN)
      .send({ userId, openid, ruleId: 'R06', templateId: TEMPLATE_R06, templateData: { x: '1' } })
    expect(res.body).toEqual({ success: false, reason: 'NO_QUOTA' })
  })

  it('已发过相同 refId → ALREADY_SENT', async () => {
    await prisma.subscribeQuota.create({ data: { userId, templateId: TEMPLATE_R06, quota: 1 } })
    await prisma.pushLog.create({ data: { userId, ruleId: 'R06', status: 'SUCCESS', refId: 'ORD-999' } })
    const res = await request(app).post('/api/internal/push/send')
      .set('x-internal-token', INTERNAL_TOKEN)
      .send({ userId, openid, ruleId: 'R06', templateId: TEMPLATE_R06, templateData: { x: '1' }, refId: 'ORD-999' })
    expect(res.body.reason).toBe('ALREADY_SENT')
  })

  it('成功下发 → 扣配额 + PushLog SUCCESS', async () => {
    await prisma.subscribeQuota.create({ data: { userId, templateId: TEMPLATE_R06, quota: 3 } })
    const res = await request(app).post('/api/internal/push/send')
      .set('x-internal-token', INTERNAL_TOKEN)
      .send({ userId, openid, ruleId: 'R06', templateId: TEMPLATE_R06, templateData: { x: '1' }, refId: 'ORD-SUCCESS' })
    expect(res.body.success).toBe(true)
    expect(res.body.pushLogId).toBeTruthy()

    const q = await prisma.subscribeQuota.findUnique({ where: { userId_templateId: { userId, templateId: TEMPLATE_R06 } } })
    expect(q?.quota).toBe(2)
    const logs = await prisma.pushLog.findMany({ where: { userId, ruleId: 'R06' } })
    expect(logs.length).toBe(1)
    expect(logs[0].status).toBe('SUCCESS')
  })

  it('微信返回错误 → WECHAT_ERROR + PushLog FAILED + 配额不扣', async () => {
    __setWxSubscribeSender(async () => ({ errcode: 40003, errmsg: 'invalid openid' }))
    await prisma.subscribeQuota.create({ data: { userId, templateId: TEMPLATE_R06, quota: 1 } })
    const res = await request(app).post('/api/internal/push/send')
      .set('x-internal-token', INTERNAL_TOKEN)
      .send({ userId, openid, ruleId: 'R06', templateId: TEMPLATE_R06, templateData: { x: '1' }, refId: 'ORD-FAIL' })
    expect(res.body.success).toBe(false)
    expect(res.body.reason).toBe('WECHAT_ERROR')
    expect(res.body.errcode).toBe(40003)
    const q = await prisma.subscribeQuota.findUnique({ where: { userId_templateId: { userId, templateId: TEMPLATE_R06 } } })
    expect(q?.quota).toBe(1) // 不扣
    const logs = await prisma.pushLog.findMany({ where: { userId, ruleId: 'R06' } })
    expect(logs[0].status).toBe('FAILED')
    expect(logs[0].errorMsg).toContain('40003')
  })

  it('R15 成功下发 → 额外开通 7 天体验会员', async () => {
    await prisma.subscribeQuota.create({ data: { userId, templateId: TEMPLATE_R15, quota: 1 } })
    const res = await request(app).post('/api/internal/push/send')
      .set('x-internal-token', INTERNAL_TOKEN)
      .send({ userId, openid, ruleId: 'R15', templateId: TEMPLATE_R15, templateData: { x: '1' } })
    expect(res.body.success).toBe(true)

    const ms = await prisma.userMembership.findMany({ where: { userId, status: 'ACTIVE' } })
    expect(ms.length).toBe(1)
    expect(ms[0].source).toBe('SYSTEM')
    expect(ms[0].sourceRef).toContain('R15_FIRST_SCAN_REWARD')
    const days = (ms[0].endAt.getTime() - ms[0].startAt.getTime()) / 86400000
    expect(days).toBeCloseTo(7, 1)
  })
})

describe('GET /api/internal/push/stats', () => {
  beforeEach(async () => {
    await prisma.pushLog.deleteMany()
  })
  it('按 ruleId+status 分组统计', async () => {
    const u = await createUser({ phone: `138${Math.floor(Math.random() * 1e8)}` })
    await prisma.pushLog.createMany({
      data: [
        { userId: u.id, ruleId: 'R06', status: 'SUCCESS' },
        { userId: u.id, ruleId: 'R06', status: 'SUCCESS' },
        { userId: u.id, ruleId: 'R06', status: 'FAILED' },
        { userId: u.id, ruleId: 'R15', status: 'SUCCESS' },
      ],
    })
    const res = await request(app).get('/api/internal/push/stats').set('x-internal-token', INTERNAL_TOKEN)
    expect(res.status).toBe(200)
    expect(res.body.stats.R06).toEqual({ total: 3, success: 2, failed: 1, skipped: 0 })
    expect(res.body.stats.R15).toEqual({ total: 1, success: 1, failed: 0, skipped: 0 })
  })
})

describe('POST /api/subscribe/grant', () => {
  it('未登录 → 401', async () => {
    const res = await request(app).post('/api/subscribe/grant').send({ templateId: TEMPLATE_R06 })
    expect(res.status).toBe(401)
  })

  it('登录 + 首次授权 → quota=1，再授权一次 → quota=2', async () => {
    const u = await createUser({ phone: `138${Math.floor(Math.random() * 1e8)}` })
    const token = getTestToken(u.id)

    const r1 = await request(app).post('/api/subscribe/grant')
      .set('Authorization', `Bearer ${token}`)
      .send({ templateId: TEMPLATE_R15 })
    expect(r1.body.quota).toBe(1)

    const r2 = await request(app).post('/api/subscribe/grant')
      .set('Authorization', `Bearer ${token}`)
      .send({ templateId: TEMPLATE_R15 })
    expect(r2.body.quota).toBe(2)
  })

  it('缺 templateId → 400', async () => {
    const u = await createUser({ phone: `138${Math.floor(Math.random() * 1e8)}` })
    const token = getTestToken(u.id)
    const res = await request(app).post('/api/subscribe/grant')
      .set('Authorization', `Bearer ${token}`).send({})
    expect(res.status).toBe(400)
  })
})
