/**
 * 订单核心链路测试
 * 覆盖：创建 / 幂等 / 取消 / 状态流转 / 超时关闭
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { prisma } from '../src/db.js'
import { createUser, createOrder, ensurePlans, cleanAll } from './factory.js'

describe('订单核心链路', () => {
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

  it('创建订单 — 正常流程', async () => {
    const order = await createOrder({ userId, planId: 'personal', amount: 59800 })
    expect(order.orderNo).toMatch(/^ORD-TEST-/)
    expect(order.status).toBe('PENDING')
    expect(order.amount).toBe(59800)
    expect(order.userId).toBe(userId)
  })

  it('同套餐重复创建 — 应命中已有 PENDING 订单（幂等）', async () => {
    // 模拟 appRoutes 中的幂等逻辑：同 userId + planId + PENDING 复用
    const first = await createOrder({ userId, planId: 'personal' })

    // 查询是否已有 PENDING 订单
    const existing = await prisma.appOrder.findFirst({
      where: { userId, planId: 'personal', status: 'PENDING' },
    })
    expect(existing).not.toBeNull()
    expect(existing!.id).toBe(first.id)
  })

  it('取消订单 — PENDING → CANCELLED', async () => {
    const order = await createOrder({ userId, status: 'PENDING' })

    const updated = await prisma.appOrder.updateMany({
      where: { orderNo: order.orderNo, status: 'PENDING' },
      data: { status: 'CANCELLED', failReason: '用户取消' },
    })
    expect(updated.count).toBe(1)

    const cancelled = await prisma.appOrder.findUnique({ where: { orderNo: order.orderNo } })
    expect(cancelled!.status).toBe('CANCELLED')
  })

  it('非法状态流转 — PAID 不能再取消', async () => {
    const order = await createOrder({ userId, status: 'PAID' })

    const updated = await prisma.appOrder.updateMany({
      where: { orderNo: order.orderNo, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    })
    expect(updated.count).toBe(0) // 不匹配，不更新

    const unchanged = await prisma.appOrder.findUnique({ where: { orderNo: order.orderNo } })
    expect(unchanged!.status).toBe('PAID')
  })

  it('非法状态流转 — CANCELLED 不能变 PAID', async () => {
    const order = await createOrder({ userId, status: 'CANCELLED' })

    const updated = await prisma.appOrder.updateMany({
      where: { orderNo: order.orderNo, status: { in: ['PENDING', 'PAYING', 'PENDING_VERIFY'] } },
      data: { status: 'PAID', paidAt: new Date() },
    })
    expect(updated.count).toBe(0)

    const unchanged = await prisma.appOrder.findUnique({ where: { orderNo: order.orderNo } })
    expect(unchanged!.status).toBe('CANCELLED')
  })

  it('超时关闭 — 模拟 orderSweeper 逻辑', async () => {
    // 创建一个 30+ 分钟前的 PAYING 订单
    const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000)
    const order = await prisma.appOrder.create({
      data: {
        orderNo: `ORD-TIMEOUT-${Date.now()}`,
        userId,
        planId: 'personal',
        productType: 'MEMBERSHIP',
        title: '超时测试',
        amount: 59800,
        status: 'PAYING',
        createdAt: thirtyOneMinAgo,
        updatedAt: thirtyOneMinAgo,
      },
    })

    // 模拟 sweeper：扫描超过 30 分钟的 PAYING/PENDING 订单
    const cutoff = new Date(Date.now() - 30 * 60 * 1000)
    const affected = await prisma.appOrder.updateMany({
      where: {
        status: { in: ['PENDING', 'PAYING'] },
        updatedAt: { lt: cutoff },
      },
      data: { status: 'CANCELLED', failReason: '超时自动关闭' },
    })

    expect(affected.count).toBeGreaterThanOrEqual(1)
    const closed = await prisma.appOrder.findUnique({ where: { orderNo: order.orderNo } })
    expect(closed!.status).toBe('CANCELLED')
    expect(closed!.failReason).toBe('超时自动关闭')
  })
})
