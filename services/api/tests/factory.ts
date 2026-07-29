/**
 * 测试工厂函数 — 快速创建测试数据
 */
import { prisma } from '../src/db.js'
import { hashPassword, signJwt } from '../src/auth.js'
import crypto from 'crypto'

let counter = 0
function uid() { return `test-${++counter}-${crypto.randomBytes(4).toString('hex')}` }

// ─── 用户 ─────────────────────────────────────────────

export async function createUser(overrides: Partial<{
  id: string; phone: string; email: string; role: string; password: string
}> = {}) {
  const id = overrides.id || uid()
  const phone = overrides.phone || `138${crypto.randomBytes(4).toString('hex')}`
  const passwordHash = await hashPassword(overrides.password || 'test123456')
  const user = await prisma.appUser.create({
    data: {
      id,
      phone,
      email: overrides.email || null,
      passwordHash,
      role: overrides.role || 'user',
    },
  })
  return user
}

export function getTestToken(
  userId: string,
  role = 'user',
  opts: { enterpriseId?: string | null; enterpriseRole?: string | null } = {},
): string {
  return signJwt({
    sub: userId,
    role,
    enterpriseId: opts.enterpriseId ?? null,
    enterpriseRole: opts.enterpriseRole ?? null,
  })
}

// ─── 会员方案 ─────────────────────────────────────────

export async function ensurePlans() {
  const plans = [
    { id: 'personal', name: '个人包年', price: 59800, badge: '个人', description: '个人会员', featuresJson: '[]', status: 'ACTIVE' },
    { id: 'pro', name: '专业会员', price: 99800, badge: '专业', description: '专业会员', featuresJson: '[]', status: 'ACTIVE' },
  ]
  for (const p of plans) {
    await prisma.membershipPlan.upsert({ where: { id: p.id }, update: {}, create: p })
  }
}

// ─── 订单 ─────────────────────────────────────────────

export async function createOrder(overrides: Partial<{
  userId: string; planId: string; amount: number; status: string; productType: string
}> = {}) {
  const orderNo = `ORD-TEST-${uid()}`
  return prisma.appOrder.create({
    data: {
      orderNo,
      userId: overrides.userId || null,
      planId: overrides.planId || 'personal',
      productType: overrides.productType || 'MEMBERSHIP',
      title: '测试订单',
      amount: overrides.amount ?? 59800,
      status: overrides.status || 'PENDING',
    },
  })
}

export async function createPaidOrder(userId: string, planId = 'personal') {
  const orderNo = `ORD-TEST-${uid()}`
  return prisma.appOrder.create({
    data: {
      orderNo,
      userId,
      planId,
      productType: 'MEMBERSHIP',
      title: '测试已支付订单',
      amount: planId === 'pro' ? 99800 : 59800,
      status: 'PAID',
      paidAt: new Date(),
    },
  })
}

// ─── 会员 ─────────────────────────────────────────────

export async function createMembership(userId: string, planId = 'personal', overrides: Partial<{
  status: string; startAt: Date; endAt: Date; source: string
}> = {}) {
  const now = new Date()
  const oneYearLater = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)
  return prisma.userMembership.create({
    data: {
      userId,
      planId,
      status: overrides.status || 'ACTIVE',
      source: overrides.source || 'PURCHASE',
      startAt: overrides.startAt || now,
      endAt: overrides.endAt || oneYearLater,
    },
  })
}

// ─── 响应体类型化读取 ─────────────────────────────────
// supertest res.body 是 any，统一经这两个 helper 收口，测试里不再散落 (e: any)

export function bodyItems<T = Record<string, unknown>>(res: { body: { items?: unknown } }): T[] {
  return (res.body.items ?? []) as T[]
}

export function findItem<T = Record<string, unknown>>(
  res: { body: { items?: unknown } },
  pred: (item: T) => boolean,
): T | undefined {
  return bodyItems<T>(res).find(pred)
}

// ─── 清理 ─────────────────────────────────────────────

export async function cleanAll() {
  // 按外键依赖顺序删除
  await prisma.auditLog.deleteMany()
  await prisma.analyticsEvent.deleteMany()
  await prisma.enterpriseApplication.deleteMany()
  await prisma.chatMessage.deleteMany()
  await prisma.conversation.deleteMany()
  await prisma.invoiceRequest.deleteMany()
  await prisma.serviceBooking.deleteMany()
  // 专家评审投票（CASCADE：deleteMany 主表会带走所有子表附件 / 专家 / 投票 / 签章日志）
  await prisma.expertVoteRequest.deleteMany()
  // 阶段三：优惠券 FK → AppUser/Coupon，必须在 appUser/coupon 之前清
  await prisma.orderDiscount.deleteMany()
  await prisma.userCoupon.deleteMany()
  await prisma.coupon.deleteMany()
  await prisma.userMembership.deleteMany()
  await prisma.appOrder.deleteMany()
  await prisma.compareTask.deleteMany()
  // 营销自动化 FK → AppUser（UserLabel / Notification 是 RESTRICT，必须在 appUser 之前清）
  await prisma.userLabel.deleteMany()
  await prisma.notification.deleteMany()
  await prisma.pushLog.deleteMany()
  await prisma.subscribeQuota.deleteMany()
  await prisma.referral.deleteMany()
  await prisma.referralCode.deleteMany()
  await prisma.scheduledPush.deleteMany()
  // Sales 体系 FK → AppUser（RESTRICT），必须在 appUser 之前清
  await prisma.salesCode.deleteMany()
  await prisma.salesProfile.deleteMany()
  await prisma.salesInvite.deleteMany()
  await prisma.enterpriseApiAccessLog.deleteMany()
  await prisma.enterpriseWebhookDelivery.deleteMany()
  await prisma.enterpriseWebhook.deleteMany()
  await prisma.enterpriseApiKey.deleteMany()
  await prisma.sEParseJob.deleteMany()
  await prisma.sEVectorIndexItem.deleteMany()
  await prisma.sERecordCoverage.deleteMany()
  await prisma.sERequirementMapping.deleteMany()
  // RBAC：AdminUserRole FK → AppUser/AdminRole；AdminRole 可独立存在
  await prisma.adminUserRole.deleteMany()
  await prisma.adminRole.deleteMany()
  await prisma.appUser.deleteMany()
  await prisma.membershipPlan.deleteMany()
}
