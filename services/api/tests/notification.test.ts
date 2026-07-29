/**
 * 任务五 后端 — 站内通知中心
 * 覆盖：
 *  - push/send 成功时顺手写 Notification
 *  - GET /api/app/notifications 分页 + unreadCount
 *  - POST /api/app/notifications/:id/read 幂等 + 只允许本人
 *  - POST /api/app/notifications/read-all
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

const INTERNAL_TOKEN = 'test-internal-notif-secret'

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = INTERNAL_TOKEN
  process.env.WX_APPID = 'wx-test-appid'
  process.env.WX_SECRET = 'wx-test-secret'
  await ensurePlans()
  registerAppRoutes(app)
  registerInternalRoutes(app)
  await ensureAppSeed()
  __setWxTokenFetcher(async () => ({ access_token: 'fake', expires_in: 7200 }))
  __setWxSubscribeSender(async () => ({ errcode: 0, errmsg: 'ok' }))
})

afterAll(() => {
  __setWxSubscribeSender(null)
  __setWxTokenFetcher(null)
  __clearWxTokenCache()
})

async function freshUser(phoneTag: string) {
  const u = await createUser({ phone: `138${phoneTag}${Math.floor(Math.random() * 1e6)}` })
  await prisma.appUser.update({ where: { id: u.id }, data: { openId: `openid-notif-${u.id}` } })
  return u
}

describe('push/send 写 Notification', () => {
  beforeEach(async () => {
    await prisma.notification.deleteMany()
    await prisma.pushLog.deleteMany()
    await prisma.subscribeQuota.deleteMany()
  })

  it('R06 成功下发 → Notification 落库，文案来自 最终版-全量话术', async () => {
    const u = await freshUser('60')
    await prisma.subscribeQuota.create({ data: { userId: u.id, templateId: TEMPLATE_R06, quota: 1 } })
    const res = await request(app).post('/api/internal/push/send')
      .set('x-internal-token', INTERNAL_TOKEN)
      .send({
        userId: u.id, openid: `openid-notif-${u.id}`,
        ruleId: 'R06', templateId: TEMPLATE_R06,
        templateData: { character_string1: 'ORD-X', amount2: '598.00', date3: '2026-04-14', thing4: '订单待支付', phrase5: '待支付' },
        refId: 'ORD-X',
      })
    expect(res.body.success).toBe(true)
    const notifs = await prisma.notification.findMany({ where: { userId: u.id } })
    expect(notifs.length).toBe(1)
    expect(notifs[0].type).toBe('RULE_PUSH')
    expect(notifs[0].title).toBe('订单待支付提醒')
    expect(notifs[0].body).toContain('会员订单待支付')
    expect(notifs[0].link).toContain('ORD-X')
    expect(notifs[0].readAt).toBeNull()
  })

  it('R15 成功下发 → Notification 链接到会员权益页', async () => {
    const u = await freshUser('15')
    await prisma.subscribeQuota.create({ data: { userId: u.id, templateId: TEMPLATE_R15, quota: 1 } })
    const res = await request(app).post('/api/internal/push/send')
      .set('x-internal-token', INTERNAL_TOKEN)
      .send({
        userId: u.id, openid: `openid-notif-${u.id}`,
        ruleId: 'R15', templateId: TEMPLATE_R15,
        templateData: { phrase1: '首扫奖励', time2: '7天', thing3: '点击查看', number4: 7, time5: '2026-04-21' },
      })
    expect(res.body.success).toBe(true)
    const notifs = await prisma.notification.findMany({ where: { userId: u.id } })
    expect(notifs.length).toBe(1)
    expect(notifs[0].title).toBe('首扫体验权益已送达')
    expect(notifs[0].link).toBe('/membership/benefits')
  })

  it('微信发送失败 → 不写 Notification（事务与 wx 成功绑定）', async () => {
    __setWxSubscribeSender(async () => ({ errcode: 40003, errmsg: 'invalid openid' }))
    const u = await freshUser('fa')
    await prisma.subscribeQuota.create({ data: { userId: u.id, templateId: TEMPLATE_R06, quota: 1 } })
    const res = await request(app).post('/api/internal/push/send')
      .set('x-internal-token', INTERNAL_TOKEN)
      .send({
        userId: u.id, openid: `openid-notif-${u.id}`,
        ruleId: 'R06', templateId: TEMPLATE_R06,
        templateData: { character_string1: 'ORD-Y', amount2: '598.00', date3: '2026-04-14', thing4: 'x', phrase5: 'x' },
      })
    expect(res.body.success).toBe(false)
    const notifs = await prisma.notification.findMany({ where: { userId: u.id } })
    expect(notifs.length).toBe(0)
    // 恢复成功桩给后续用例
    __setWxSubscribeSender(async () => ({ errcode: 0, errmsg: 'ok' }))
  })
})

describe('GET /api/app/notifications', () => {
  let userId: string
  let token: string
  beforeEach(async () => {
    await prisma.notification.deleteMany()
    const u = await freshUser('gl')
    userId = u.id
    token = getTestToken(u.id)
  })

  it('未登录 → 401', async () => {
    const res = await request(app).get('/api/app/notifications')
    expect(res.status).toBe(401)
  })

  it('返回分页 + unreadCount + Cache-Control no-store', async () => {
    // 造 5 未读 + 2 已读
    // 注：每条 create 之间 sleep 2ms 让 createdAt 在 PG TIMESTAMPTZ(3) ms 精度下错开，
    // 否则连续 create 可能同 ms，orderBy createdAt desc 排序不稳定，断言「已读1」第一会 flake
    for (let i = 0; i < 5; i++) {
      await prisma.notification.create({
        data: { userId, title: `未读${i}`, body: 'b', type: 'RULE_PUSH' },
      })
      await new Promise((r) => setTimeout(r, 2))
    }
    for (let i = 0; i < 2; i++) {
      await prisma.notification.create({
        data: { userId, title: `已读${i}`, body: 'b', type: 'RULE_PUSH', readAt: new Date() },
      })
      await new Promise((r) => setTimeout(r, 2))
    }
    const res = await request(app).get('/api/app/notifications?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toContain('no-store')
    expect(res.body.total).toBe(7)
    expect(res.body.unreadCount).toBe(5)
    expect(res.body.items.length).toBe(7)
    // 按 createdAt DESC，最新的应该是最后创建的"已读1"
    expect(res.body.items[0].title).toBe('已读1')
  })

  it('pageSize 上限 100', async () => {
    const res = await request(app).get('/api/app/notifications?pageSize=999')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.pageSize).toBe(100)
  })
})

describe('POST /api/app/notifications/:id/read', () => {
  let userId: string
  let token: string
  let notifId: string
  beforeEach(async () => {
    await prisma.notification.deleteMany()
    const u = await freshUser('rd')
    userId = u.id
    token = getTestToken(u.id)
    const n = await prisma.notification.create({
      data: { userId, title: 't', body: 'b', type: 'RULE_PUSH' },
    })
    notifId = n.id
  })

  it('标记已读 → readAt 非空 + updated=1', async () => {
    const res = await request(app).post(`/api/app/notifications/${notifId}/read`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body).toEqual({ ok: true, updated: 1 })
    const n = await prisma.notification.findUnique({ where: { id: notifId } })
    expect(n?.readAt).toBeTruthy()
  })

  it('重复标记 → updated=0，幂等不报错', async () => {
    await request(app).post(`/api/app/notifications/${notifId}/read`).set('Authorization', `Bearer ${token}`)
    const res2 = await request(app).post(`/api/app/notifications/${notifId}/read`).set('Authorization', `Bearer ${token}`)
    expect(res2.body).toEqual({ ok: true, updated: 0 })
  })

  it('他人通知 → updated=0（FK 范围隔离）', async () => {
    const other = await freshUser('ot')
    const otherToken = getTestToken(other.id)
    const res = await request(app).post(`/api/app/notifications/${notifId}/read`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.body.updated).toBe(0)
    const n = await prisma.notification.findUnique({ where: { id: notifId } })
    expect(n?.readAt).toBeNull()
  })

  it('POST read-all → 一键全部已读', async () => {
    await prisma.notification.createMany({
      data: [
        { userId, title: 't2', body: 'b', type: 'RULE_PUSH' },
        { userId, title: 't3', body: 'b', type: 'RULE_PUSH' },
      ],
    })
    const res = await request(app).post('/api/app/notifications/read-all').set('Authorization', `Bearer ${token}`)
    expect(res.body.updated).toBe(3) // notifId + t2 + t3
    const unread = await prisma.notification.count({ where: { userId, readAt: null } })
    expect(unread).toBe(0)
  })
})
