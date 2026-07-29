/**
 * 营销自动化埋点补齐测试
 *
 * 覆盖：
 *  - trackScanSuccess：首扫幂等（只打一次 first_scan + 每次都打 scan_success）
 *  - POST /api/app/orders：创建订单打 order_created
 *  - 支付成功链路：membership_activated 由 handlePostPayment 触发
 *
 * 不依赖 dedup 服务（只测 tracker 层行为 + 订单接口）
 */
import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { trackScanSuccess, trackSearchSuccess } from '../src/tracker.js'
import { registerAppRoutes, ensureAppSeed, handlePostPayment } from '../src/appRoutes.js'
import { createUser, getTestToken, ensurePlans } from './factory.js'

const app = express()
app.use(express.json())

let userId: string
let token: string

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

async function findEvents(event: string, uid: string) {
  return prisma.analyticsEvent.findMany({
    where: { event, userId: uid },
    orderBy: { id: 'desc' },
  })
}

describe('营销自动化埋点', () => {
  beforeAll(async () => {
    await ensurePlans()
    registerAppRoutes(app)
    await ensureAppSeed()
    const user = await createUser({ phone: '13877777701', password: 'Track123456' })
    userId = user.id
    token = getTestToken(userId)
  })

  it('trackScanSuccess 首次调用：写入 firstScanAt + lastActiveAt + 打 first_scan + scan_success', async () => {
    await trackScanSuccess(userId, { endpoint: 'test' })
    // 埋点是 fire-and-forget，给一点时间落库
    await sleep(150)

    const user = await prisma.appUser.findUnique({ where: { id: userId } })
    expect(user?.firstScanAt).toBeTruthy()
    expect(user?.lastActiveAt).toBeTruthy()

    const firstScanEvts = await findEvents('first_scan', userId)
    const scanSuccessEvts = await findEvents('scan_success', userId)
    expect(firstScanEvts.length).toBe(1)
    expect(scanSuccessEvts.length).toBe(1)
  })

  it('trackScanSuccess 第二次调用：first_scan 不再重复，scan_success 累加', async () => {
    await trackScanSuccess(userId, { endpoint: 'test-2' })
    await sleep(150)

    const firstScanEvts = await findEvents('first_scan', userId)
    const scanSuccessEvts = await findEvents('scan_success', userId)
    expect(firstScanEvts.length).toBe(1) // 仍是 1
    expect(scanSuccessEvts.length).toBe(2)
  })

  it('trackScanSuccess 无 userId：只打 scan_success，不写 firstScanAt', async () => {
    const before = await prisma.analyticsEvent.count({ where: { event: 'scan_success', userId: null } })
    await trackScanSuccess(null, { endpoint: 'anon' })
    await sleep(150)
    const after = await prisma.analyticsEvent.count({ where: { event: 'scan_success', userId: null } })
    expect(after - before).toBe(1)
  })

  it('POST /api/app/orders 创建订单：打 order_created 事件', async () => {
    const res = await request(app)
      .post('/api/app/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ productType: 'MEMBERSHIP', planId: 'personal', title: '个人会员', channel: 'WECHAT' })
    expect(res.status).toBe(200)
    const orderNo = res.body.orderNo
    expect(orderNo).toBeTruthy()

    await sleep(150)
    const evts = await findEvents('order_created', userId)
    const match = evts.find((e) => e.props && e.props.includes(orderNo))
    expect(match).toBeTruthy()
    const props = JSON.parse(match!.props!)
    expect(props.productType).toBe('MEMBERSHIP')
    expect(props.planId).toBe('personal')
    expect(typeof props.amount).toBe('number')
  })

  it('handlePostPayment MEMBERSHIP 订单：打 membership_activated 事件', async () => {
    // 用另一个用户，避免与上一个测试的会员状态互相影响
    const u = await createUser({ phone: '13877777702', password: 'Track123456' })
    const orderNo = `ORD-TRACK-${Date.now()}`
    await prisma.appOrder.create({
      data: {
        orderNo,
        userId: u.id,
        planId: 'personal',
        productType: 'MEMBERSHIP',
        title: '个人会员',
        amount: 59800,
        status: 'PAID',
        paidAt: new Date(),
      },
    })
    await handlePostPayment({
      orderNo,
      productType: 'MEMBERSHIP',
      userId: u.id,
      planId: 'personal',
      productRef: null,
    })
    await sleep(150)

    const evts = await findEvents('membership_activated', u.id)
    expect(evts.length).toBe(1)
    const props = JSON.parse(evts[0].props!)
    expect(props.planId).toBe('personal')
    expect(props.orderNo).toBe(orderNo)
    expect(props.source).toBe('PURCHASE')
    expect(props.endAt).toBeTruthy()
    // 首次开通 = isRenewal false（PURCHASE 路径无旧 ACTIVE 会员被 EXPIRE）
    expect(props.isRenewal).toBe(false)
    // 会员开通后 lastActiveAt 也应被刷新
    const refreshed = await prisma.appUser.findUnique({ where: { id: u.id } })
    expect(refreshed?.lastActiveAt).toBeTruthy()
  })

  it('handlePostPayment 同用户再买一次：isRenewal = true', async () => {
    const u = await createUser({ phone: '13877777703', password: 'Track123456' })
    // 先开通一次
    const firstOrder = `ORD-TRACK-A-${Date.now()}`
    await prisma.appOrder.create({
      data: { orderNo: firstOrder, userId: u.id, planId: 'personal', productType: 'MEMBERSHIP', title: '个人会员', amount: 59800, status: 'PAID', paidAt: new Date() },
    })
    await handlePostPayment({ orderNo: firstOrder, productType: 'MEMBERSHIP', userId: u.id, planId: 'personal', productRef: null })
    await sleep(100)

    // 再买一次（续费）
    const secondOrder = `ORD-TRACK-B-${Date.now()}`
    await prisma.appOrder.create({
      data: { orderNo: secondOrder, userId: u.id, planId: 'personal', productType: 'MEMBERSHIP', title: '个人会员', amount: 59800, status: 'PAID', paidAt: new Date() },
    })
    await handlePostPayment({ orderNo: secondOrder, productType: 'MEMBERSHIP', userId: u.id, planId: 'personal', productRef: null })
    await sleep(150)

    const evts = await findEvents('membership_activated', u.id)
    expect(evts.length).toBe(2)
    const latest = evts[0] // orderBy id desc
    const props = JSON.parse(latest.props!)
    expect(props.orderNo).toBe(secondOrder)
    expect(props.isRenewal).toBe(true)
  })

  it('trackSearchSuccess 首次：写入 firstSearchAt + 打 first_search + search_success + 刷 lastActiveAt', async () => {
    const u = await createUser({ phone: '13877777704', password: 'Track123456' })
    await trackSearchSuccess(u.id, { keyword: 'GB 1886', resultCount: 3, matchQuality: 'exact' })
    await sleep(150)

    const user = await prisma.appUser.findUnique({ where: { id: u.id } })
    expect(user?.firstSearchAt).toBeTruthy()
    expect(user?.lastActiveAt).toBeTruthy()
    expect((await findEvents('first_search', u.id)).length).toBe(1)
    expect((await findEvents('search_success', u.id)).length).toBe(1)

    // 第二次：first_search 不重复，search_success 累加
    await trackSearchSuccess(u.id, { keyword: 'GB 1887', resultCount: 2, matchQuality: 'related' })
    await sleep(150)
    expect((await findEvents('first_search', u.id)).length).toBe(1)
    expect((await findEvents('search_success', u.id)).length).toBe(2)
  })
})
