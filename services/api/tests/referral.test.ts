/**
 * 任务六 R14 两级裂变奖励 — 端到端测试
 *
 * 覆盖：
 *  - GET /api/app/referral/code：首次生成 + 二次读缓存
 *  - POST /api/app/referral/track：首次归因 → 邀请人 +7天 + registrationRewardedAt 写入
 *  - handlePostPayment → 被邀请人首付 → 邀请人 +30天 + paymentRewardedAt + 微信推送
 *  - 两级奖励幂等（重复触发不重发）
 *  - 好友付费时 sendPushForRule 调用断言
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed, handlePostPayment } from '../src/appRoutes.js'
import { __setWxaCodeFetcher } from '../src/internal/wxacode.js'
import { __setWxTokenFetcher, __clearWxTokenCache } from '../src/internal/wxAccessToken.js'
import { __setWxSubscribeSender } from '../src/internal/wxSubscribeMessage.js'
import { createUser, getTestToken, ensurePlans } from './factory.js'

const app = express()
app.use(express.json())
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00])

beforeAll(async () => {
  process.env.WX_APPID = 'wx-test'
  process.env.WX_SECRET = 'secret-test'
  await ensurePlans()
  registerAppRoutes(app)
  await ensureAppSeed()
  __setWxTokenFetcher(async () => ({ access_token: 'fake', expires_in: 7200 }))
  __setWxaCodeFetcher(async () => ({ status: 200, buffer: PNG_BYTES, contentType: 'image/png' }))
  __setWxSubscribeSender(async () => ({ errcode: 0, errmsg: 'ok' }))
})

afterAll(() => {
  __setWxaCodeFetcher(null)
  __setWxTokenFetcher(null)
  __clearWxTokenCache()
  __setWxSubscribeSender(null)
})

async function freshUser(tag: string) {
  return createUser({ phone: `139${tag}${Math.floor(Math.random() * 1e6)}` })
}

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

describe('GET /api/app/referral/code', () => {
  beforeEach(async () => {
    await prisma.referral.deleteMany()
    await prisma.referralCode.deleteMany()
  })

  it('首次调：生成邀请码 + 调微信生成码 + 缓存 base64', async () => {
    const u = await freshUser('60')
    const token = getTestToken(u.id)
    const res = await request(app).get('/api/app/referral/code').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.code).toMatch(/^[A-Z2-9]{8}$/)
    expect(res.body.qrcodeBase64).toContain('data:image/png;base64,')
    expect(res.body.totalInvited).toBe(0)
  })

  it('首次调：微信小程序码 page 使用已发布首页路径', async () => {
    const u = await freshUser('62')
    const token = getTestToken(u.id)
    let wxBody: Record<string, unknown> | null = null
    __setWxaCodeFetcher(async (_token, body) => {
      wxBody = body
      return { status: 200, buffer: PNG_BYTES, contentType: 'image/png' }
    })

    const res = await request(app).get('/api/app/referral/code').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(wxBody?.page).toBe('pages/home/index')
    expect(String(wxBody?.scene || '')).toBe(`ref_${u.id}`)
  })

  it('微信返回错误 JSON 时不缓存为二维码', async () => {
    const u = await freshUser('63')
    const token = getTestToken(u.id)
    __setWxaCodeFetcher(async () => ({
      status: 200,
      buffer: Buffer.from(JSON.stringify({ errcode: 41030, errmsg: 'invalid page' })),
      contentType: 'application/json',
    }))

    const res = await request(app).get('/api/app/referral/code').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(502)
    expect(res.body.errcode).toBe(41030)
    const row = await prisma.referralCode.findUnique({ where: { userId: u.id } })
    expect(row?.qrcodeBase64).toBeFalsy()
  })

  it('旧 page 缓存：下次访问会刷新二维码，保留 ref_userId 归因', async () => {
    const u = await freshUser('64')
    const token = getTestToken(u.id)
    await prisma.referralCode.create({
      data: {
        userId: u.id,
        code: 'ZZZZ2222',
        qrcodeBase64: 'data:image/png;base64,OLD',
        qrcodeUpdatedAt: new Date('2026-05-27T08:00:00.000Z'),
      },
    })
    let wxCalls = 0
    let wxBody: Record<string, unknown> | null = null
    __setWxaCodeFetcher(async (_token, body) => {
      wxCalls++
      wxBody = body
      return { status: 200, buffer: PNG_BYTES, contentType: 'image/png' }
    })

    const res = await request(app).get('/api/app/referral/code').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(wxCalls).toBe(1)
    expect(wxBody?.page).toBe('pages/home/index')
    expect(wxBody?.scene).toBe(`ref_${u.id}`)
    expect(res.body.qrcodeBase64).not.toBe('data:image/png;base64,OLD')
  })

  it('二次调：直接返回缓存', async () => {
    const u = await freshUser('61')
    const token = getTestToken(u.id)
    let wxCalls = 0
    __setWxaCodeFetcher(async () => { wxCalls++; return { status: 200, buffer: PNG_BYTES, contentType: 'image/png' } })
    await request(app).get('/api/app/referral/code').set('Authorization', `Bearer ${token}`)
    expect(wxCalls).toBe(1)
    const r2 = await request(app).get('/api/app/referral/code').set('Authorization', `Bearer ${token}`)
    expect(r2.status).toBe(200)
    expect(wxCalls).toBe(1)
    __setWxaCodeFetcher(async () => ({ status: 200, buffer: PNG_BYTES, contentType: 'image/png' }))
  })
})

describe('POST /api/app/referral/track 注册奖励（A3：双方各 +7）', () => {
  beforeEach(async () => {
    await prisma.referral.deleteMany()
    await prisma.userMembership.deleteMany()
  })

  it('归因成功 → 邀请人 +7 天 + 被邀请人 +7 天 + registrationRewardedAt 写入', async () => {
    const inviter = await freshUser('70')
    const invitee = await freshUser('71')
    const token = getTestToken(invitee.id)

    // 邀请人已有 pro ACTIVE 会员
    const origEnd = new Date(Date.now() + 60 * 86400000)
    const m = await prisma.userMembership.create({
      data: {
        userId: inviter.id, planId: 'pro', status: 'ACTIVE', source: 'PURCHASE',
        startAt: new Date(), endAt: origEnd,
      },
    })

    const res = await request(app).post('/api/app/referral/track')
      .set('Authorization', `Bearer ${token}`).send({ scene: `ref_${inviter.id}` })
    expect(res.body.ok).toBe(true)

    // 邀请人 endAt +7
    const updated = await prisma.userMembership.findUnique({ where: { id: m.id } })
    const delta = (updated!.endAt.getTime() - origEnd.getTime()) / 86400000
    expect(delta).toBeCloseTo(7, 1)

    // 被邀请人新建 SYSTEM 7 天会员
    const inviteeMs = await prisma.userMembership.findMany({
      where: { userId: invitee.id, status: 'ACTIVE' },
    })
    expect(inviteeMs.length).toBe(1)
    expect(inviteeMs[0].source).toBe('SYSTEM')
    expect(inviteeMs[0].sourceRef).toContain('REFERRAL_REG_INVITEE_REWARD:')
    expect(inviteeMs[0].sourceRef).toContain(inviter.id)
    const inviteeDays = (inviteeMs[0].endAt.getTime() - inviteeMs[0].startAt.getTime()) / 86400000
    expect(inviteeDays).toBeCloseTo(7, 1)

    const ref = await prisma.referral.findUnique({ where: { inviteeId: invitee.id } })
    expect(ref?.registrationRewardedAt).toBeTruthy()
    expect(ref?.paymentRewardedAt).toBeNull()
  })

  it('双方都无 ACTIVE 会员 → 各自新建 SYSTEM personal 7 天', async () => {
    const inviter = await freshUser('72')
    const invitee = await freshUser('73')
    const token = getTestToken(invitee.id)

    const res = await request(app).post('/api/app/referral/track')
      .set('Authorization', `Bearer ${token}`).send({ scene: `ref_${inviter.id}` })
    expect(res.body.ok).toBe(true)

    const inviterMs = await prisma.userMembership.findMany({ where: { userId: inviter.id, status: 'ACTIVE' } })
    expect(inviterMs.length).toBe(1)
    expect(inviterMs[0].sourceRef).toContain('REFERRAL_REG_REWARD:')
    expect((inviterMs[0].endAt.getTime() - inviterMs[0].startAt.getTime()) / 86400000).toBeCloseTo(7, 1)

    const inviteeMs = await prisma.userMembership.findMany({ where: { userId: invitee.id, status: 'ACTIVE' } })
    expect(inviteeMs.length).toBe(1)
    expect(inviteeMs[0].sourceRef).toContain('REFERRAL_REG_INVITEE_REWARD:')
    expect((inviteeMs[0].endAt.getTime() - inviteeMs[0].startAt.getTime()) / 86400000).toBeCloseTo(7, 1)
  })

  it('自邀自 → SELF_INVITE_IGNORED，邀请人不发奖', async () => {
    const u = await freshUser('74')
    const token = getTestToken(u.id)
    const res = await request(app).post('/api/app/referral/track')
      .set('Authorization', `Bearer ${token}`).send({ scene: `ref_${u.id}` })
    expect(res.body).toEqual({ ok: false, reason: 'SELF_INVITE_IGNORED' })
    const ms = await prisma.userMembership.findMany({ where: { userId: u.id, status: 'ACTIVE' } })
    expect(ms.length).toBe(0)
  })

  it('二次 track 同用户 → ALREADY_ATTRIBUTED，不重发注册奖励', async () => {
    const a = await freshUser('75')
    const b = await freshUser('76')
    const invitee = await freshUser('77')
    const token = getTestToken(invitee.id)

    await request(app).post('/api/app/referral/track')
      .set('Authorization', `Bearer ${token}`).send({ scene: `ref_${a.id}` })

    const aMsBefore = await prisma.userMembership.findMany({ where: { userId: a.id, status: 'ACTIVE' } })
    expect(aMsBefore.length).toBe(1)

    const r2 = await request(app).post('/api/app/referral/track')
      .set('Authorization', `Bearer ${token}`).send({ scene: `ref_${b.id}` })
    expect(r2.body.reason).toBe('ALREADY_ATTRIBUTED')

    // b 不应有任何会员
    const bMs = await prisma.userMembership.findMany({ where: { userId: b.id } })
    expect(bMs.length).toBe(0)
    // a 的会员也不应再增加
    const aMsAfter = await prisma.userMembership.findMany({ where: { userId: a.id, status: 'ACTIVE' } })
    expect(aMsAfter.length).toBe(1)
  })
})

describe('handlePostPayment → 付费奖励（+30 天）+ 微信推送', () => {
  beforeEach(async () => {
    await prisma.referral.deleteMany()
    await prisma.referralCode.deleteMany()
    await prisma.userMembership.deleteMany()
    await prisma.pushLog.deleteMany()
    await prisma.subscribeQuota.deleteMany()
    await prisma.notification.deleteMany()
    await prisma.appOrder.deleteMany({ where: { orderNo: { startsWith: 'ORD-REF-' } } })
  })

  async function setupInviteePay(invitee: { id: string }, orderTag: string) {
    const orderNo = `ORD-REF-${orderTag}-${Date.now()}-${Math.random()}`
    await prisma.appOrder.create({
      data: {
        orderNo, userId: invitee.id, planId: 'personal', productType: 'MEMBERSHIP',
        title: '个人会员', amount: 59800, status: 'PAID', paidAt: new Date(),
      },
    })
    await handlePostPayment({
      orderNo, productType: 'MEMBERSHIP', userId: invitee.id, planId: 'personal', productRef: null,
    })
    return orderNo
  }

  it('邀请人有 ACTIVE → endAt +30 天 + paymentRewardedAt + totalInvited+1', async () => {
    const inviter = await freshUser('80')
    const invitee = await freshUser('81')
    await prisma.referralCode.create({ data: { userId: inviter.id, code: 'AAAA1111' } })
    // 此处直接造 Referral（已有注册归因完毕的状态）
    await prisma.referral.create({
      data: { inviterId: inviter.id, inviteeId: invitee.id, registrationRewardedAt: new Date() },
    })
    const origEnd = new Date(Date.now() + 60 * 86400000)
    const m = await prisma.userMembership.create({
      data: {
        userId: inviter.id, planId: 'pro', status: 'ACTIVE', source: 'PURCHASE',
        startAt: new Date(), endAt: origEnd,
      },
    })

    await setupInviteePay(invitee, 'A')

    const updated = await prisma.userMembership.findUnique({ where: { id: m.id } })
    const delta = (updated!.endAt.getTime() - origEnd.getTime()) / 86400000
    expect(delta).toBeCloseTo(30, 1)

    const ref = await prisma.referral.findUnique({ where: { inviteeId: invitee.id } })
    expect(ref?.paymentRewardedAt).toBeTruthy()
    expect(ref?.registrationRewardedAt).toBeTruthy() // 原状态保留

    const rc = await prisma.referralCode.findUnique({ where: { userId: inviter.id } })
    expect(rc?.totalInvited).toBe(1)
  })

  it('邀请人无 ACTIVE → 新建 SYSTEM personal 30 天，sourceRef=REFERRAL_PAY_REWARD', async () => {
    const inviter = await freshUser('82')
    const invitee = await freshUser('83')
    await prisma.referralCode.create({ data: { userId: inviter.id, code: 'BBBB2222' } })
    await prisma.referral.create({
      data: { inviterId: inviter.id, inviteeId: invitee.id, registrationRewardedAt: new Date() },
    })

    await setupInviteePay(invitee, 'B')

    const ms = await prisma.userMembership.findMany({ where: { userId: inviter.id, status: 'ACTIVE' } })
    expect(ms.length).toBe(1)
    expect(ms[0].source).toBe('SYSTEM')
    expect(ms[0].sourceRef).toContain('REFERRAL_PAY_REWARD:')
    const days = (ms[0].endAt.getTime() - ms[0].startAt.getTime()) / 86400000
    expect(days).toBeCloseTo(30, 1)
  })

  it('幂等：同一被邀请人二次付费不重复奖励', async () => {
    const inviter = await freshUser('84')
    const invitee = await freshUser('85')
    await prisma.referralCode.create({ data: { userId: inviter.id, code: 'CCCC3333' } })
    await prisma.referral.create({
      data: { inviterId: inviter.id, inviteeId: invitee.id, registrationRewardedAt: new Date() },
    })

    await setupInviteePay(invitee, 'C1')
    const rc1 = await prisma.referralCode.findUnique({ where: { userId: inviter.id } })
    expect(rc1?.totalInvited).toBe(1)

    await setupInviteePay(invitee, 'C2')
    const rc2 = await prisma.referralCode.findUnique({ where: { userId: inviter.id } })
    expect(rc2?.totalInvited).toBe(1)

    const rewardMs = await prisma.userMembership.findMany({
      where: { userId: inviter.id, sourceRef: { contains: 'REFERRAL_PAY_REWARD:' } },
    })
    expect(rewardMs.length).toBe(1)
  })

  it('好友付费 → 微信推送被调用（sendSubscribeMessage 命中）', async () => {
    const inviter = await freshUser('86')
    const invitee = await freshUser('87')
    await prisma.appUser.update({ where: { id: inviter.id }, data: { openId: `openid-inv-${inviter.id}` } })
    await prisma.subscribeQuota.create({
      data: { userId: inviter.id, templateId: 'UtPIdDEn7g_p8mcspWlie_cvq_QTqiZ1TcCkCI1KKuM', quota: 3 },
    })
    await prisma.referralCode.create({ data: { userId: inviter.id, code: 'DDDD4444' } })
    await prisma.referral.create({
      data: { inviterId: inviter.id, inviteeId: invitee.id, registrationRewardedAt: new Date() },
    })

    // 观察 wx 推送调用
    const sendCalls: any[] = []
    __setWxSubscribeSender(async (token, body) => {
      sendCalls.push(body)
      return { errcode: 0, errmsg: 'ok' }
    })

    await setupInviteePay(invitee, 'D')
    // setImmediate 后触发的 send，等它跑完
    await sleep(200)

    expect(sendCalls.length).toBeGreaterThanOrEqual(1)
    // 断言推送到的是邀请人 + R14 模板 + 30 天文案
    const call = sendCalls.find((c) => c.touser === `openid-inv-${inviter.id}`)
    expect(call).toBeTruthy()
    expect(call.template_id).toBe('UtPIdDEn7g_p8mcspWlie_cvq_QTqiZ1TcCkCI1KKuM')
    expect(JSON.stringify(call.data)).toContain('30天')

    // Notification 也应落一条（type=REWARD）
    const notifs = await prisma.notification.findMany({ where: { userId: inviter.id } })
    expect(notifs.length).toBe(1)
    expect(notifs[0].type).toBe('REWARD')
    expect(notifs[0].body).toContain('30')

    // 恢复默认
    __setWxSubscribeSender(async () => ({ errcode: 0, errmsg: 'ok' }))
  })

  it('无 Referral 行 → 付费不触发奖励，不影响正常支付链', async () => {
    const user = await freshUser('88')
    await setupInviteePay(user, 'E')
    const ms = await prisma.userMembership.findMany({ where: { userId: user.id } })
    expect(ms.filter((m) => m.sourceRef?.includes('REFERRAL_PAY_REWARD:')).length).toBe(0)
  })
})
