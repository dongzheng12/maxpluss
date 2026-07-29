/**
 * 专家评审投票 — 从「我的订单」取消 → expert vote 联动测试
 *
 * 覆盖：
 *   - 用户在订单列表取消 PAYING 状态的 EXPERT_VOTE 订单
 *     → ExpertVoteRequest 同步变为 CANCELLED（原来的 bug：只改 order，没改 vote）
 *   - 取消已 PAID 订单（EXPERT_VOTE）→ 403/409，vote 状态不变
 *   - 取消非 EXPERT_VOTE 订单 → 只改 order，不影响任何 vote
 *   - 跨用户取消 → 403
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { registerExpertVoteRoutes } from '../src/expertVoteRoutes.js'
import { ensureExpertVoteSettings, makeExpertVoteRequestNo } from '../src/services/expertVote.js'
import { createUser, getTestToken, cleanAll, ensurePlans } from './factory.js'

const app = express()
app.use(express.json())
registerAppRoutes(app)
registerExpertVoteRoutes(app)

function isoAfterDays(days: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + days)
  return d.toISOString()
}

function draftPayload(overrides: Record<string, any> = {}) {
  return {
    contactName: '张三',
    contactPhone: '13800001234',
    projectName: '订单页取消测试-专家审查会',
    targetName: 'T/ORDER-CANCEL-001-2026',
    projectType: '标准评审',
    standardType: '团体标准',
    standardStatus: '送审稿',
    industries: ['化工'],
    backgroundDesc: '订单取消联动测试用例。',
    expertSourceType: 'PLATFORM',
    expertCategories: ['行业技术专家'],
    expertCount: 3,
    desiredDate: isoAfterDays(15),
    desiredSlot: 'AFTERNOON',
    acceptReschedule: true,
    confidentialLevel: 'NONE',
    ...overrides,
  }
}

beforeAll(async () => {
  await ensurePlans()
  await ensureExpertVoteSettings()
  await ensureAppSeed()
})

beforeEach(async () => {
  await cleanAll()
  await ensurePlans()
  await ensureExpertVoteSettings()
})

describe('订单列表取消 → ExpertVoteRequest 联动', () => {
  it('从订单页取消 EXPERT_VOTE 订单 → vote 同步变 CANCELLED', async () => {
    const u = await createUser()
    const token = getTestToken(u.id)

    // 1. 创建草稿
    const draftRes = await request(app)
      .post('/api/app/expert-votes')
      .set('Authorization', `Bearer ${token}`)
      .send(draftPayload())
    expect(draftRes.status).toBe(200)
    const requestNo = draftRes.body.requestNo

    // 2. 提交 → PAYING，生成订单
    const submitRes = await request(app)
      .post(`/api/app/expert-votes/${requestNo}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(submitRes.status).toBe(200)
    const orderNo = submitRes.body.order.orderNo
    expect(orderNo).toBeTruthy()

    // 3. 从订单页取消（模拟用户在"我的订单"点取消）
    const cancelRes = await request(app)
      .post(`/api/app/orders/${orderNo}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(cancelRes.status).toBe(200)
    expect(cancelRes.body.status).toBe('CANCELLED')

    // 4. 断言：order 和 expert vote 都改为 CANCELLED
    const order = await prisma.appOrder.findUnique({ where: { orderNo } })
    expect(order!.status).toBe('CANCELLED')

    const vote = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    expect(vote!.status).toBe('CANCELLED')
  })

  it('取消已 PAID 的 EXPERT_VOTE 订单 → 409，vote 状态不变', async () => {
    const u = await createUser()
    const token = getTestToken(u.id)

    // 直接在 DB 构造 PAID 状态的 vote + order
    const requestNo = makeExpertVoteRequestNo()
    const orderNo = `ORD-TEST-PAID-${Date.now()}`
    await prisma.expertVoteRequest.create({
      data: {
        requestNo, userId: u.id, status: 'EXPERT_ARRANGING',
        orderNo,
        projectName: 'P', targetName: 'T', projectType: '标准评审',
        standardType: '团体标准', standardStatus: '送审稿',
        backgroundDesc: '...', expertSourceType: 'PLATFORM', expertCount: 3,
      },
    })
    await prisma.appOrder.create({
      data: {
        orderNo, userId: u.id, status: 'PAID',
        productType: 'EXPERT_VOTE', productRef: requestNo,
        title: '测试', amount: 300000, paidAt: new Date(),
      },
    })

    const res = await request(app)
      .post(`/api/app/orders/${orderNo}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(409)

    // vote 仍为 EXPERT_ARRANGING，没被联动取消
    const vote = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    expect(vote!.status).toBe('EXPERT_ARRANGING')
  })

  it('取消非 EXPERT_VOTE 订单 → 只改 order，不影响任何 vote', async () => {
    const u = await createUser()
    const token = getTestToken(u.id)

    // 创建一个 MEMBERSHIP 类型的 PAYING 订单
    const orderNo = `ORD-TEST-MEM-${Date.now()}`
    await prisma.appOrder.create({
      data: {
        orderNo, userId: u.id, status: 'PAYING',
        productType: 'MEMBERSHIP', planId: 'personal',
        title: '会员订单', amount: 59800,
      },
    })

    // 同时有一个无关的 vote
    const requestNo = makeExpertVoteRequestNo()
    await prisma.expertVoteRequest.create({
      data: {
        requestNo, userId: u.id, status: 'PAYING',
        projectName: 'P', targetName: 'T', projectType: '标准评审',
        standardType: '团体标准', standardStatus: '送审稿',
        backgroundDesc: '...', expertSourceType: 'PLATFORM', expertCount: 3,
      },
    })

    const res = await request(app)
      .post(`/api/app/orders/${orderNo}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(200)

    const order = await prisma.appOrder.findUnique({ where: { orderNo } })
    expect(order!.status).toBe('CANCELLED')

    // 无关 vote 不受影响，仍为 PAYING
    const vote = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    expect(vote!.status).toBe('PAYING')
  })

  it('跨用户取消订单 → 403，vote 不变', async () => {
    const owner = await createUser()
    const attacker = await createUser()

    const requestNo = makeExpertVoteRequestNo()
    const orderNo = `ORD-TEST-XUSER-${Date.now()}`
    await prisma.expertVoteRequest.create({
      data: {
        requestNo, userId: owner.id, status: 'PAYING',
        orderNo,
        projectName: 'P', targetName: 'T', projectType: '标准评审',
        standardType: '团体标准', standardStatus: '送审稿',
        backgroundDesc: '...', expertSourceType: 'PLATFORM', expertCount: 3,
      },
    })
    await prisma.appOrder.create({
      data: {
        orderNo, userId: owner.id, status: 'PAYING',
        productType: 'EXPERT_VOTE', productRef: requestNo,
        title: '测试', amount: 300000,
      },
    })

    const res = await request(app)
      .post(`/api/app/orders/${orderNo}/cancel`)
      .set('Authorization', `Bearer ${getTestToken(attacker.id)}`)
      .send({})
    expect(res.status).toBe(403)

    const vote = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    expect(vote!.status).toBe('PAYING')
  })
})
