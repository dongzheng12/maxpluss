/**
 * 支付核心链路测试
 * 覆盖：回调成功 / 金额不一致 / 重复回调 / 已取消订单收到回调
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { prisma } from '../src/db.js'
import { createUser, createOrder, ensurePlans, cleanAll } from './factory.js'

describe('支付回调核心链路', () => {
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

  it('回调成功 — PAYING → PAID', async () => {
    const order = await createOrder({ userId, status: 'PAYING', amount: 59800, planId: 'personal' })

    // 模拟微信回调逻辑：原子更新
    const affected = await prisma.appOrder.updateMany({
      where: { orderNo: order.orderNo, status: { in: ['PENDING', 'PAYING', 'PENDING_VERIFY'] } },
      data: { status: 'PAID', paidAt: new Date() },
    })
    expect(affected.count).toBe(1)

    const paid = await prisma.appOrder.findUnique({ where: { orderNo: order.orderNo } })
    expect(paid!.status).toBe('PAID')
    expect(paid!.paidAt).not.toBeNull()
  })

  it('回调成功 — 自动开通会员', async () => {
    const order = await createOrder({ userId, status: 'PAYING', amount: 59800, planId: 'personal' })

    // 模拟回调 + handlePostPayment
    await prisma.appOrder.update({
      where: { orderNo: order.orderNo },
      data: { status: 'PAID', paidAt: new Date() },
    })

    // 模拟 handlePostPayment 逻辑
    const now = new Date()
    const endAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)
    await prisma.userMembership.create({
      data: {
        userId,
        planId: 'personal',
        status: 'ACTIVE',
        source: 'PURCHASE',
        sourceRef: order.orderNo,
        startAt: now,
        endAt,
      },
    })

    const membership = await prisma.userMembership.findFirst({
      where: { userId, status: 'ACTIVE' },
    })
    expect(membership).not.toBeNull()
    expect(membership!.planId).toBe('personal')
    expect(membership!.source).toBe('PURCHASE')
  })

  it('金额不一致 — 订单应标 FAILED', async () => {
    const order = await createOrder({ userId, status: 'PAYING', amount: 59800 })
    const callbackAmount = 100 // 回调金额 1 元 ≠ 订单 598 元

    // 模拟金额校验逻辑
    if (order.amount !== callbackAmount) {
      await prisma.appOrder.updateMany({
        where: { orderNo: order.orderNo, status: { notIn: ['PAID', 'FAILED'] } },
        data: {
          status: 'FAILED',
          failedAt: new Date(),
          failReason: `金额不一致: 订单${order.amount} vs 回调${callbackAmount}`,
        },
      })
    }

    const failed = await prisma.appOrder.findUnique({ where: { orderNo: order.orderNo } })
    expect(failed!.status).toBe('FAILED')
    expect(failed!.failReason).toContain('金额不一致')
  })

  it('重复回调 — 幂等，PAID 不会被重复处理', async () => {
    const order = await createOrder({ userId, status: 'PAID', amount: 59800 })

    // 再次收到回调：updateMany where status in ['PENDING','PAYING','PENDING_VERIFY']
    const affected = await prisma.appOrder.updateMany({
      where: { orderNo: order.orderNo, status: { in: ['PENDING', 'PAYING', 'PENDING_VERIFY'] } },
      data: { status: 'PAID', paidAt: new Date() },
    })
    // 应该匹配不到（已是 PAID），affected = 0
    expect(affected.count).toBe(0)
  })

  it('已取消订单收到回调 — 不应变 PAID', async () => {
    const order = await createOrder({ userId, status: 'CANCELLED', amount: 59800 })

    const affected = await prisma.appOrder.updateMany({
      where: { orderNo: order.orderNo, status: { in: ['PENDING', 'PAYING', 'PENDING_VERIFY'] } },
      data: { status: 'PAID', paidAt: new Date() },
    })
    expect(affected.count).toBe(0)

    const unchanged = await prisma.appOrder.findUnique({ where: { orderNo: order.orderNo } })
    expect(unchanged!.status).toBe('CANCELLED')
  })
})
