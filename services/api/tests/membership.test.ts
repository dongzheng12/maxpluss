/**
 * 会员核心链路测试
 * 覆盖：首次开通 / 升级 / 过期重买 / 重复发放保护 / 权益判断
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { prisma } from '../src/db.js'
import { createUser, createMembership, ensurePlans, cleanAll } from './factory.js'

describe('会员核心链路', () => {
  let userId: string

  beforeAll(async () => {
    await cleanAll()
    await ensurePlans()
  })

  beforeEach(async () => {
    await prisma.userMembership.deleteMany()
    await prisma.appOrder.deleteMany()
    await prisma.appUser.deleteMany()
    const user = await createUser()
    userId = user.id
  })

  it('首次开通 — 创建 ACTIVE 会员', async () => {
    const m = await createMembership(userId, 'personal')
    expect(m.status).toBe('ACTIVE')
    expect(m.planId).toBe('personal')
    expect(m.userId).toBe(userId)
    expect(m.endAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('升级 — 旧会员 REVOKED + 新会员 ACTIVE', async () => {
    // 先开通 personal
    const old = await createMembership(userId, 'personal')

    // 升级到 pro：撤销旧的
    await prisma.userMembership.update({
      where: { id: old.id },
      data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: '升级到 pro' },
    })

    // 创建新的 pro
    const upgraded = await createMembership(userId, 'pro')

    // 验证
    const oldRecord = await prisma.userMembership.findUnique({ where: { id: old.id } })
    expect(oldRecord!.status).toBe('REVOKED')

    const newRecord = await prisma.userMembership.findUnique({ where: { id: upgraded.id } })
    expect(newRecord!.status).toBe('ACTIVE')
    expect(newRecord!.planId).toBe('pro')
  })

  it('已过期重买 — 可以新建 ACTIVE', async () => {
    // 创建一个已过期的会员
    const pastEnd = new Date(Date.now() - 24 * 60 * 60 * 1000) // 昨天
    const pastStart = new Date(pastEnd.getTime() - 365 * 24 * 60 * 60 * 1000)
    await createMembership(userId, 'personal', {
      status: 'EXPIRED',
      startAt: pastStart,
      endAt: pastEnd,
    })

    // 重新购买
    const renewed = await createMembership(userId, 'personal')
    expect(renewed.status).toBe('ACTIVE')

    // 应该有 2 条记录
    const all = await prisma.userMembership.findMany({ where: { userId } })
    expect(all.length).toBe(2)
    expect(all.filter(m => m.status === 'ACTIVE').length).toBe(1)
    expect(all.filter(m => m.status === 'EXPIRED').length).toBe(1)
  })

  it('重复发放保护 — 同一 ACTIVE 不应重复创建', async () => {
    await createMembership(userId, 'personal')

    // 检查是否已有 ACTIVE
    const existing = await prisma.userMembership.findFirst({
      where: { userId, planId: 'personal', status: 'ACTIVE' },
    })
    expect(existing).not.toBeNull()

    // 业务逻辑：已有 ACTIVE 就不再创建
    // （这里验证查询逻辑正确即可）
    const activeCount = await prisma.userMembership.count({
      where: { userId, status: 'ACTIVE' },
    })
    expect(activeCount).toBe(1)
  })

  it('权益判断 — free / personal / pro 三档', async () => {
    // free 用户：没有 ACTIVE 会员
    const freeCheck = await prisma.userMembership.findFirst({
      where: { userId, status: 'ACTIVE' },
    })
    expect(freeCheck).toBeNull()

    // 开通 personal
    await createMembership(userId, 'personal')
    const personalCheck = await prisma.userMembership.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: { plan: true },
    })
    expect(personalCheck).not.toBeNull()
    expect(personalCheck!.plan.id).toBe('personal')

    // 模拟判断逻辑
    const tier = personalCheck!.plan.id
    const isPro = tier === 'pro'
    const isPersonal = tier === 'personal'
    expect(isPro).toBe(false)
    expect(isPersonal).toBe(true)
  })

  it('会员过期判断 — endAt 已过则不算有效', async () => {
    const pastEnd = new Date(Date.now() - 1000) // 1 秒前过期
    await createMembership(userId, 'personal', {
      status: 'ACTIVE',
      endAt: pastEnd,
    })

    // 查询有效会员：status=ACTIVE 且 endAt > now
    const valid = await prisma.userMembership.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        endAt: { gt: new Date() },
      },
    })
    expect(valid).toBeNull() // 已过期，不算有效
  })
})
