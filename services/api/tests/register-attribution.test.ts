/**
 * 阶段二 — 注册归因统一（inviteCode 与 salesCode 互斥，inviteCode 优先）
 *
 * 覆盖 T1-T10：
 *  - register: 仅 salesCode / 仅 inviteCode / 互斥优先 / 邀请码无效 / 自邀 / salesCode 无效 / 重复路径 / 重复路径+inviteCode
 *  - wx-login: 同样四组合
 *  - 公开接口（无 token）正常工作
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import {
  registerAppRoutes, ensureAppSeed,
  __setWxCode2SessionFetcher,
} from '../src/appRoutes.js'
import { ensurePlans, createUser } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  process.env.WX_APPID = 'wx-test'
  process.env.WX_SECRET = 'secret-test'
  process.env.BXZ_INVITECODE_INLINE = 'true'
  await ensurePlans()
  registerAppRoutes(app)
  await ensureAppSeed()
})

afterAll(async () => {
  __setWxCode2SessionFetcher(null)
  await prisma.$disconnect()
})

// ───────── 辅助 ─────────

let counter = 0
function uniquePhone() {
  counter += 1
  return `139${String(Date.now() % 1e8).padStart(8, '0').slice(-7)}${counter % 10}`
}

async function ensureSmsCode(phone: string, code = '654321') {
  await prisma.verificationCode.create({
    data: {
      id: `t-vc-${Date.now()}-${counter++}`,
      target: phone,
      type: 'phone',
      code,
      purpose: 'register',
      expiresAt: new Date(Date.now() + 10 * 60_000),
    },
  })
  return code
}

async function makeSales(opts: { status?: string; codeStatus?: string } = {}) {
  const u = await createUser({ role: 'sales' })
  const salesCode = 'SLS' + Math.random().toString(36).slice(2, 7).toUpperCase()
  const profile = await prisma.salesProfile.create({
    data: {
      salesCode,
      userId: u.id,
      realName: '测试销售',
      status: opts.status || 'ENABLED',
      isPublic: true,
    },
  })
  await prisma.salesCode.create({
    data: { salesCode, profileId: profile.id, label: '主码', status: opts.codeStatus || 'ACTIVE' },
  })
  return { user: u, salesCode }
}

async function makeInviter() {
  const u = await createUser({ role: 'user' })
  const code = 'INV' + Math.random().toString(36).slice(2, 7).toUpperCase()
  await prisma.referralCode.create({ data: { userId: u.id, code } })
  return { user: u, inviteCode: code }
}

async function cleanAll() {
  // 必须按 FK 依赖顺序：所有 child 表（含其他测试可能留下的 AppOrder/UserCoupon 等）先清，再清 AppUser
  await prisma.orderDiscount.deleteMany()
  await prisma.userCoupon.deleteMany()
  await prisma.coupon.deleteMany()
  await prisma.userMembership.deleteMany()
  await prisma.appOrder.deleteMany()
  await prisma.compareTask.deleteMany()
  await prisma.userLabel.deleteMany()
  await prisma.notification.deleteMany()
  await prisma.pushLog.deleteMany()
  await prisma.subscribeQuota.deleteMany()
  await prisma.referral.deleteMany()
  await prisma.referralCode.deleteMany()
  await prisma.scheduledPush.deleteMany()
  await prisma.verificationCode.deleteMany()
  await prisma.salesCode.deleteMany()
  await prisma.salesProfile.deleteMany()
  await prisma.salesInvite.deleteMany()
  // RBAC：AdminUserRole FK → AppUser，必须在 appUser deleteMany 之前清，否则 P2003
  await prisma.adminUserRole.deleteMany()
  await prisma.adminRole.deleteMany()
  await prisma.appUser.deleteMany({ where: { role: { in: ['user', 'sales'] } } })
}

// ═══════════════════ /register ═══════════════════
describe('POST /api/app/auth/register — 归因互斥', () => {
  beforeEach(cleanAll)

  it('T1 仅有效 salesCode → AppUser.salesCode 写入，发 7 天 SALES_REFERRAL，无 Referral', async () => {
    const { salesCode } = await makeSales()
    const phone = uniquePhone()
    const sms = await ensureSmsCode(phone)
    const res = await request(app).post('/api/app/auth/register').send({
      phone, smsCode: sms, password: 'pw123456', salesCode,
    })
    expect(res.status).toBe(201)
    const u = await prisma.appUser.findUnique({ where: { phone } })
    expect(u?.salesCode).toBe(salesCode)
    const ms = await prisma.userMembership.findFirst({ where: { userId: u!.id } })
    expect(ms?.source).toBe('SALES_REFERRAL')
    expect(ms?.salesCode).toBe(salesCode)
    const ref = await prisma.referral.findUnique({ where: { inviteeId: u!.id } })
    expect(ref).toBeNull()
  })

  it('T2 仅有效 inviteCode → 建 Referral + 双方各 +7 天，AppUser.salesCode=null', async () => {
    const { user: inviter, inviteCode } = await makeInviter()
    const phone = uniquePhone()
    const sms = await ensureSmsCode(phone)
    const res = await request(app).post('/api/app/auth/register').send({
      phone, smsCode: sms, password: 'pw123456', inviteCode,
    })
    expect(res.status).toBe(201)
    const u = await prisma.appUser.findUnique({ where: { phone } })
    expect(u?.salesCode).toBeNull()
    const ref = await prisma.referral.findUnique({ where: { inviteeId: u!.id } })
    expect(ref).not.toBeNull()
    expect(ref?.inviterId).toBe(inviter.id)
    expect(ref?.registrationRewardedAt).not.toBeNull()
    const inviterMs = await prisma.userMembership.findFirst({ where: { userId: inviter.id } })
    const inviteeMs = await prisma.userMembership.findFirst({ where: { userId: u!.id } })
    expect(inviterMs?.source).toBe('SYSTEM')
    expect(inviteeMs?.source).toBe('SYSTEM')
  })

  it('T3 同时有效 salesCode + inviteCode → inviteCode 优先：salesCode 不写，无 SALES_REFERRAL', async () => {
    const { salesCode } = await makeSales()
    const { user: inviter, inviteCode } = await makeInviter()
    const phone = uniquePhone()
    const sms = await ensureSmsCode(phone)
    const res = await request(app).post('/api/app/auth/register').send({
      phone, smsCode: sms, password: 'pw123456', salesCode, inviteCode,
    })
    expect(res.status).toBe(201)
    const u = await prisma.appUser.findUnique({ where: { phone } })
    expect(u?.salesCode).toBeNull()
    const salesMs = await prisma.userMembership.findFirst({ where: { userId: u!.id, source: 'SALES_REFERRAL' } })
    expect(salesMs).toBeNull()
    const ref = await prisma.referral.findUnique({ where: { inviteeId: u!.id } })
    expect(ref?.inviterId).toBe(inviter.id)
  })

  it('T4 inviteCode 不存在 → 400 + field=inviteCode，AppUser 未创建，验证码未消费', async () => {
    const phone = uniquePhone()
    const sms = await ensureSmsCode(phone)
    const res = await request(app).post('/api/app/auth/register').send({
      phone, smsCode: sms, password: 'pw123456', inviteCode: 'NOTEXIST',
    })
    expect(res.status).toBe(400)
    expect(res.body.field).toBe('inviteCode')
    const u = await prisma.appUser.findUnique({ where: { phone } })
    expect(u).toBeNull()
    const vc = await prisma.verificationCode.findFirst({ where: { target: phone } })
    expect(vc?.usedAt).toBeNull()
  })

  it('T5 inviteCode 自邀（半 user 用自己的码再注册） → 注册成功，Referral 不创建', async () => {
    // 先建一个无密码 phone-only 半 user，并给 ta 一个 ReferralCode
    const phone = uniquePhone()
    const halfUser = await prisma.appUser.create({
      data: { id: `half-${Date.now()}`, phone, role: 'user' },
    })
    const code = 'SELF' + Math.random().toString(36).slice(2, 6).toUpperCase()
    await prisma.referralCode.create({ data: { userId: halfUser.id, code } })

    const sms = await ensureSmsCode(phone)
    const res = await request(app).post('/api/app/auth/register').send({
      phone, smsCode: sms, password: 'pw123456', inviteCode: code,
    })
    expect(res.status).toBe(201)
    const ref = await prisma.referral.findUnique({ where: { inviteeId: halfUser.id } })
    expect(ref).toBeNull()
  })

  it('T6 salesCode 无效 + 无 inviteCode → 注册成功，无归因，无 4xx', async () => {
    const phone = uniquePhone()
    const sms = await ensureSmsCode(phone)
    const res = await request(app).post('/api/app/auth/register').send({
      phone, smsCode: sms, password: 'pw123456', salesCode: 'NOTEXIST',
    })
    expect(res.status).toBe(201)
    const u = await prisma.appUser.findUnique({ where: { phone } })
    expect(u?.salesCode).toBeNull()
    const ms = await prisma.userMembership.findFirst({ where: { userId: u!.id, source: 'SALES_REFERRAL' } })
    expect(ms).toBeNull()
  })

  it('T7 已注册（半 user，已有 salesCode）+ 新 salesCode → 首次归因不被覆盖', async () => {
    const { salesCode: oldCode } = await makeSales()
    const { salesCode: newCode } = await makeSales()
    const phone = uniquePhone()
    // 半 user 已带 salesCode 快照（由销售推广首次访问 wx-login 写入的场景）
    await prisma.appUser.create({
      data: { id: `half-${Date.now()}`, phone, role: 'user', salesCode: oldCode },
    })
    const sms = await ensureSmsCode(phone)
    const res = await request(app).post('/api/app/auth/register').send({
      phone, smsCode: sms, password: 'pw123456', salesCode: newCode,
    })
    expect(res.status).toBe(201)
    const u = await prisma.appUser.findUnique({ where: { phone } })
    expect(u?.salesCode).toBe(oldCode)
  })

  it('T8 已注册（半 user）+ 新 inviteCode → existingByPhone 路径不发奖励/不建 Referral', async () => {
    const { inviteCode } = await makeInviter()
    const phone = uniquePhone()
    const halfUser = await prisma.appUser.create({
      data: { id: `half-${Date.now()}`, phone, role: 'user' },
    })
    const sms = await ensureSmsCode(phone)
    const res = await request(app).post('/api/app/auth/register').send({
      phone, smsCode: sms, password: 'pw123456', inviteCode,
    })
    expect(res.status).toBe(201)
    const ref = await prisma.referral.findUnique({ where: { inviteeId: halfUser.id } })
    expect(ref).toBeNull()
    const ms = await prisma.userMembership.findFirst({ where: { userId: halfUser.id } })
    expect(ms).toBeNull()
  })
})

// ═══════════════════ /wx-login ═══════════════════
describe('POST /api/app/auth/wx-login — 归因互斥', () => {
  beforeEach(async () => {
    await cleanAll()
    // 默认每个 code 返回不同 openid，避免互相污染
    __setWxCode2SessionFetcher(async (code) => ({ openid: `openid-${code}` }))
  })

  it('T9a 仅有效 inviteCode → 建 Referral + 不写 salesCode', async () => {
    const { user: inviter, inviteCode } = await makeInviter()
    const res = await request(app).post('/api/app/auth/wx-login').send({
      code: 'wxc1', inviteCode,
    })
    expect(res.status).toBe(200)
    const created = await prisma.appUser.findUnique({ where: { openId: 'openid-wxc1' } })
    expect(created?.salesCode).toBeNull()
    const ref = await prisma.referral.findUnique({ where: { inviteeId: created!.id } })
    expect(ref?.inviterId).toBe(inviter.id)
  })

  it('T9b 仅有效 salesCode → 写 salesCode + 发 SALES_REFERRAL', async () => {
    const { salesCode } = await makeSales()
    const res = await request(app).post('/api/app/auth/wx-login').send({
      code: 'wxc2', salesCode,
    })
    expect(res.status).toBe(200)
    const created = await prisma.appUser.findUnique({ where: { openId: 'openid-wxc2' } })
    expect(created?.salesCode).toBe(salesCode)
    const ms = await prisma.userMembership.findFirst({ where: { userId: created!.id, source: 'SALES_REFERRAL' } })
    expect(ms).not.toBeNull()
  })

  it('T9c 同时 salesCode + inviteCode → inviteCode 优先', async () => {
    const { salesCode } = await makeSales()
    const { inviteCode } = await makeInviter()
    const res = await request(app).post('/api/app/auth/wx-login').send({
      code: 'wxc3', salesCode, inviteCode,
    })
    expect(res.status).toBe(200)
    const created = await prisma.appUser.findUnique({ where: { openId: 'openid-wxc3' } })
    expect(created?.salesCode).toBeNull()
    const sms = await prisma.userMembership.findFirst({ where: { userId: created!.id, source: 'SALES_REFERRAL' } })
    expect(sms).toBeNull()
    const ref = await prisma.referral.findUnique({ where: { inviteeId: created!.id } })
    expect(ref).not.toBeNull()
  })

  it('T9d inviteCode 不存在 → 400 + field=inviteCode，wxCode2Session 未调用，AppUser 未创建', async () => {
    let wxCalled = 0
    __setWxCode2SessionFetcher(async (code) => { wxCalled++; return { openid: `openid-${code}` } })
    const res = await request(app).post('/api/app/auth/wx-login').send({
      code: 'wxc4', inviteCode: 'NOTEXIST',
    })
    expect(res.status).toBe(400)
    expect(res.body.field).toBe('inviteCode')
    expect(wxCalled).toBe(0)
    const created = await prisma.appUser.findUnique({ where: { openId: 'openid-wxc4' } })
    expect(created).toBeNull()
  })
})

// ═══════════════════ T10 公开调用 ═══════════════════
describe('注册接口为公开接口', () => {
  beforeEach(cleanAll)

  it('T10 不带任何 token 调 register/wx-login → 200/201', async () => {
    __setWxCode2SessionFetcher(async (code) => ({ openid: `openid-${code}` }))
    const phone = uniquePhone()
    const sms = await ensureSmsCode(phone)
    const r1 = await request(app).post('/api/app/auth/register').send({
      phone, smsCode: sms, password: 'pw123456',
    })
    expect(r1.status).toBe(201)

    const r2 = await request(app).post('/api/app/auth/wx-login').send({ code: 'wxc-t10' })
    expect(r2.status).toBe(200)
  })
})
