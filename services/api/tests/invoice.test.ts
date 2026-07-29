/**
 * 发票申请测试
 * 路由：
 *   GET  /api/app/invoices                           — 列表（按 userId 隔离）
 *   POST /api/app/invoices                           — 申请发票
 *   GET  /api/app/invoices/:invoiceNo                — 详情
 *   GET  /api/app/orders/:orderNo/invoice-status     — 状态查询（前端是否可申请）
 *
 * 锁定项（必读/MEMORY.md「业务规则」+「退款 / 协议 / 联系客服」）：
 *   - 发票入口条件：paidAt + 7 天 ≤ now（不在退款窗口内）
 *   - 已开发票订单禁止退款 ↔ 退款窗口内禁止开票（invoicedAt 锁对称保护）
 *   - 申请成功后：order.invoiceStatus=REQUESTED + invoicedAt 写入
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { createUser, getTestToken, ensurePlans, cleanAll } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  await ensureAppSeed()
})

beforeEach(async () => {
  await cleanAll()
  await ensurePlans()
})

// ─── 工具 ───────────────────────────────────────

async function createNormalUser() {
  const u = await createUser({ role: 'user' })
  return { user: u, token: getTestToken(u.id, 'user') }
}

async function createPaidOrderForInvoice(userId: string, opts: {
  orderNo?: string
  amount?: number
  paidAtDaysAgo?: number  // > 7 才出退款窗口
  invoiceStatus?: string
} = {}) {
  const orderNo = opts.orderNo ?? `ORD-INV-${Math.random().toString(36).slice(2, 10)}`
  const paidAt = opts.paidAtDaysAgo !== undefined
    ? new Date(Date.now() - opts.paidAtDaysAgo * 24 * 60 * 60 * 1000)
    : new Date()
  return prisma.appOrder.create({
    data: {
      orderNo, userId, planId: 'personal',
      productType: 'MEMBERSHIP', title: '会员订单',
      amount: opts.amount ?? 59800,
      status: 'PAID',
      paidAt,
      invoiceStatus: opts.invoiceStatus ?? 'NOT_REQUESTED',
    },
  })
}

const MIN_REGULAR_BODY = {
  type: 'NORMAL', titleType: 'COMPANY',
  title: '通标中研', taxNo: '91110000123456789X',
  email: 'finance@example.com',
}

// ════════════════════════════════════════════════════════════
// GET /api/app/invoices 列表
// ════════════════════════════════════════════════════════════

describe('GET /api/app/invoices 列表', () => {
  it('无 token → 401', async () => {
    const res = await request(app).get('/api/app/invoices')
    expect(res.status).toBe(401)
  })

  it('happy：仅返回 userId 的发票（隔离）', async () => {
    const a = await createNormalUser()
    const b = await createNormalUser()
    await prisma.invoiceRequest.create({
      data: {
        invoiceNo: 'INV-A-1', userId: a.user.id, orderNo: 'ORD-A',
        type: 'NORMAL', titleType: 'COMPANY', title: 'A 公司',
        email: 'a@x.com', amount: 59800,
      },
    })
    await prisma.invoiceRequest.create({
      data: {
        invoiceNo: 'INV-B-1', userId: b.user.id, orderNo: 'ORD-B',
        type: 'NORMAL', titleType: 'COMPANY', title: 'B 公司',
        email: 'b@x.com', amount: 59800,
      },
    })
    const res = await request(app).get('/api/app/invoices')
      .set('Authorization', `Bearer ${a.token}`)
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].invoiceNo).toBe('INV-A-1')
  })

  it('按 createdAt desc 返回', async () => {
    const u = await createNormalUser()
    await prisma.invoiceRequest.create({
      data: {
        invoiceNo: 'INV-OLD', userId: u.user.id, orderNo: 'O1',
        type: 'NORMAL', titleType: 'COMPANY', title: 't1',
        email: 'a@x.com', amount: 100,
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      },
    })
    await prisma.invoiceRequest.create({
      data: {
        invoiceNo: 'INV-NEW', userId: u.user.id, orderNo: 'O2',
        type: 'NORMAL', titleType: 'COMPANY', title: 't2',
        email: 'a@x.com', amount: 100,
      },
    })
    const res = await request(app).get('/api/app/invoices')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.body.items[0].invoiceNo).toBe('INV-NEW')
    expect(res.body.items[1].invoiceNo).toBe('INV-OLD')
  })
})

// ════════════════════════════════════════════════════════════
// POST /api/app/invoices 申请
// ════════════════════════════════════════════════════════════

describe('POST /api/app/invoices 状态机校验', () => {
  let user: { user: any; token: string }

  beforeEach(async () => {
    user = await createNormalUser()
  })

  it('无 token → 401', async () => {
    const res = await request(app).post('/api/app/invoices').send({})
    expect(res.status).toBe(401)
  })

  it('订单不存在 → 404', async () => {
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orderNo: 'ORD-NOPE-NO', ...MIN_REGULAR_BODY })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/订单不存在/)
  })

  it('PENDING 订单 → 400「订单未支付」', async () => {
    const order = await prisma.appOrder.create({
      data: {
        orderNo: 'ORD-PENDING-INV', userId: user.user.id, planId: 'personal',
        productType: 'MEMBERSHIP', title: 't', amount: 59800, status: 'PENDING',
      },
    })
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orderNo: order.orderNo, ...MIN_REGULAR_BODY })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/未支付/)
  })

  it('0 元订单 → 400「无需开票」', async () => {
    const order = await createPaidOrderForInvoice(user.user.id, { amount: 0, paidAtDaysAgo: 10 })
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orderNo: order.orderNo, ...MIN_REGULAR_BODY })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/无需开票/)
  })

  it('已申请过（invoiceStatus=REQUESTED）→ 400「已申请过」', async () => {
    const order = await createPaidOrderForInvoice(user.user.id, {
      paidAtDaysAgo: 10, invoiceStatus: 'REQUESTED',
    })
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orderNo: order.orderNo, ...MIN_REGULAR_BODY })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/已申请过/)
  })

  it('已开（invoiceStatus=ISSUED）→ 400「已申请过」', async () => {
    const order = await createPaidOrderForInvoice(user.user.id, {
      paidAtDaysAgo: 10, invoiceStatus: 'ISSUED',
    })
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orderNo: order.orderNo, ...MIN_REGULAR_BODY })
    expect(res.status).toBe(400)
  })

  // ── 退款窗口锁（MEMORY 锁定项）─────────────

  it('退款窗口内（paidAt 仅 1 天前）→ 400「退款期内」', async () => {
    const order = await createPaidOrderForInvoice(user.user.id, { paidAtDaysAgo: 1 })
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orderNo: order.orderNo, ...MIN_REGULAR_BODY })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/退款期/)
  })

  it('退款窗口边界（paidAt 6.5 天前）→ 400 仍拒', async () => {
    const order = await createPaidOrderForInvoice(user.user.id, { paidAtDaysAgo: 6.5 })
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orderNo: order.orderNo, ...MIN_REGULAR_BODY })
    expect(res.status).toBe(400)
  })

  it('退款窗口已过（paidAt 8 天前）→ 200 接受', async () => {
    const order = await createPaidOrderForInvoice(user.user.id, { paidAtDaysAgo: 8 })
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orderNo: order.orderNo, ...MIN_REGULAR_BODY })
    expect(res.status).toBe(200)
    expect(res.body.invoiceNo).toMatch(/^INV-/)
  })
})

describe('POST /api/app/invoices schema 校验', () => {
  let user: { user: any; token: string }
  let order: any

  beforeEach(async () => {
    user = await createNormalUser()
    order = await createPaidOrderForInvoice(user.user.id, { paidAtDaysAgo: 10 })
  })

  it('缺 orderNo → 400', async () => {
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ ...MIN_REGULAR_BODY })
    expect(res.status).toBe(400)
  })

  it('缺 title → 400（zod schema 拦截）', async () => {
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orderNo: order.orderNo, type: 'NORMAL', titleType: 'COMPANY',
              taxNo: '91X', email: 'a@x.com' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
  })

  it('title="" 空字符串 → 400「请填写发票抬头」（min(1) 自定义文案）', async () => {
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orderNo: order.orderNo, type: 'NORMAL', titleType: 'COMPANY',
              title: '', taxNo: '91X', email: 'a@x.com' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/抬头/)
  })

  it('email 格式错误 → 400', async () => {
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orderNo: order.orderNo, ...MIN_REGULAR_BODY, email: 'not-an-email' })
    expect(res.status).toBe(400)
  })

  it('企业发票（COMPANY）缺 taxNo → 400「请填写纳税人识别号」', async () => {
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orderNo: order.orderNo, type: 'NORMAL', titleType: 'COMPANY',
              title: 'T', email: 'a@x.com' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/纳税人识别号/)
  })

  it('个人发票（PERSONAL）可不填 taxNo → 200', async () => {
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orderNo: order.orderNo, type: 'NORMAL', titleType: 'PERSONAL',
              title: '张三', email: 'zs@x.com' })
    expect(res.status).toBe(200)
  })

  it('专用发票（SPECIAL）缺 bank/bankAccount → 400', async () => {
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        orderNo: order.orderNo, type: 'SPECIAL', titleType: 'COMPANY',
        title: '通标', taxNo: '91X', email: 'a@x.com',
        // 缺 bank、bankAccount、address、phone
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/开户银行|账号/)
  })

  it('专用发票（SPECIAL）缺 address/phone → 400', async () => {
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        orderNo: order.orderNo, type: 'SPECIAL', titleType: 'COMPANY',
        title: '通标', taxNo: '91X', email: 'a@x.com',
        bank: '工行', bankAccount: '6222...',
        // 缺 address / phone
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/注册地址|电话/)
  })

  it('专用发票全字段齐 → 200', async () => {
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        orderNo: order.orderNo, type: 'SPECIAL', titleType: 'COMPANY',
        title: '通标', taxNo: '91X', email: 'a@x.com',
        bank: '工行', bankAccount: '6222000000001234',
        address: '北京市海淀区中关村',
        phone: '010-12345678',
      })
    expect(res.status).toBe(200)
  })
})

describe('POST /api/app/invoices happy path 副作用', () => {
  it('成功后 → AppOrder.invoiceStatus=REQUESTED + invoicedAt 写入（锁定项「invoicedAt 锁」）', async () => {
    const u = await createNormalUser()
    const order = await createPaidOrderForInvoice(u.user.id, { paidAtDaysAgo: 10 })
    expect(order.invoicedAt).toBeNull()

    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ orderNo: order.orderNo, ...MIN_REGULAR_BODY })
    expect(res.status).toBe(200)
    expect(res.body.invoiceNo).toMatch(/^INV-/)
    expect(res.body.userId).toBe(u.user.id)
    expect(res.body.amount).toBe(59800)
    expect(res.body.message).toMatch(/已提交/)

    const updated = await prisma.appOrder.findUnique({ where: { orderNo: order.orderNo } })
    expect(updated!.invoiceStatus).toBe('REQUESTED')
    expect(updated!.invoicedAt).not.toBeNull()
  })

  it('InvoiceRequest 落库字段完整：amount 取自 order，status 默认 PENDING', async () => {
    const u = await createNormalUser()
    const order = await createPaidOrderForInvoice(u.user.id, {
      amount: 99800, paidAtDaysAgo: 10,
    })
    const res = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ orderNo: order.orderNo, ...MIN_REGULAR_BODY })
    expect(res.status).toBe(200)

    const inv = await prisma.invoiceRequest.findUnique({ where: { invoiceNo: res.body.invoiceNo } })
    expect(inv!.amount).toBe(99800) // 从 order 取
    expect(inv!.status).toBe('PENDING')
    expect(inv!.title).toBe('通标中研')
    expect(inv!.taxNo).toBe('91110000123456789X')
    expect(inv!.email).toBe('finance@example.com')
  })

  it('再次申请同订单 → 400（依赖 invoiceStatus=REQUESTED 拦截）', async () => {
    const u = await createNormalUser()
    const order = await createPaidOrderForInvoice(u.user.id, { paidAtDaysAgo: 10 })
    const r1 = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ orderNo: order.orderNo, ...MIN_REGULAR_BODY })
    expect(r1.status).toBe(200)
    const r2 = await request(app).post('/api/app/invoices')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ orderNo: order.orderNo, ...MIN_REGULAR_BODY })
    expect(r2.status).toBe(400)
    expect(r2.body.error).toMatch(/已申请过/)
  })
})

// ════════════════════════════════════════════════════════════
// GET /api/app/invoices/:invoiceNo 详情
// ════════════════════════════════════════════════════════════

describe('GET /api/app/invoices/:invoiceNo 详情', () => {
  it('无 token → 401', async () => {
    const res = await request(app).get('/api/app/invoices/INV-X')
    expect(res.status).toBe(401)
  })

  it('不存在 → 404', async () => {
    const u = await createNormalUser()
    const res = await request(app).get('/api/app/invoices/INV-NO-SUCH')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(404)
  })

  it('happy → 200 + 完整字段', async () => {
    const u = await createNormalUser()
    await prisma.invoiceRequest.create({
      data: {
        invoiceNo: 'INV-DETAIL-1', userId: u.user.id, orderNo: 'ORD-X',
        type: 'NORMAL', titleType: 'COMPANY', title: 'T',
        email: 't@x.com', amount: 12345,
      },
    })
    const res = await request(app).get('/api/app/invoices/INV-DETAIL-1')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(200)
    expect(res.body.invoiceNo).toBe('INV-DETAIL-1')
    expect(res.body.amount).toBe(12345)
  })

  it('ownership 拦截：其他用户拿 invoiceNo → 404（防 PII 跨用户泄露）', async () => {
    const owner = await createNormalUser()
    const stranger = await createNormalUser()
    await prisma.invoiceRequest.create({
      data: {
        invoiceNo: 'INV-OTHER-1', userId: owner.user.id, orderNo: 'ORD-Y',
        type: 'NORMAL', titleType: 'COMPANY', title: '别人的发票',
        email: 'other@x.com', amount: 100,
      },
    })
    const res = await request(app).get('/api/app/invoices/INV-OTHER-1')
      .set('Authorization', `Bearer ${stranger.token}`)
    expect(res.status).toBe(404)
  })

  it('admin 越权可查（财务对账场景）', async () => {
    const owner = await createNormalUser()
    const admin = await createUser({ role: 'admin' })
    const adminToken = getTestToken(admin.id, 'admin')
    await prisma.invoiceRequest.create({
      data: {
        invoiceNo: 'INV-ADM-1', userId: owner.user.id, orderNo: 'ORD-Z',
        type: 'NORMAL', titleType: 'COMPANY', title: '公司',
        email: 'a@x.com', amount: 100,
      },
    })
    const res = await request(app).get('/api/app/invoices/INV-ADM-1')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('公司')
  })
})

// ════════════════════════════════════════════════════════════
// GET /api/app/orders/:orderNo/invoice-status
// ════════════════════════════════════════════════════════════

describe('GET /api/app/orders/:orderNo/invoice-status', () => {
  it('无 token → 401', async () => {
    const res = await request(app).get('/api/app/orders/X/invoice-status')
    expect(res.status).toBe(401)
  })

  it('订单不存在 → 404', async () => {
    const u = await createNormalUser()
    const res = await request(app).get('/api/app/orders/ORD-NO-SUCH/invoice-status')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(404)
  })

  it('PAID + 退款窗口已过 + NOT_REQUESTED → canApply=true + refundWindowClosed=true', async () => {
    const u = await createNormalUser()
    const order = await createPaidOrderForInvoice(u.user.id, { paidAtDaysAgo: 10 })
    const res = await request(app).get(`/api/app/orders/${order.orderNo}/invoice-status`)
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(200)
    expect(res.body.canApply).toBe(true)
    expect(res.body.refundWindowClosed).toBe(true)
    expect(res.body.invoiceStatus).toBe('NOT_REQUESTED')
    expect(res.body.existingInvoice).toBeNull()
  })

  it('PAID + 退款窗口内 → canApply=false + refundWindowClosed=false', async () => {
    const u = await createNormalUser()
    const order = await createPaidOrderForInvoice(u.user.id, { paidAtDaysAgo: 3 })
    const res = await request(app).get(`/api/app/orders/${order.orderNo}/invoice-status`)
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.body.canApply).toBe(false)
    expect(res.body.refundWindowClosed).toBe(false)
  })

  it('已申请过 → canApply=false + existingInvoice 非空', async () => {
    const u = await createNormalUser()
    const order = await createPaidOrderForInvoice(u.user.id, {
      paidAtDaysAgo: 10, invoiceStatus: 'REQUESTED',
    })
    await prisma.invoiceRequest.create({
      data: {
        invoiceNo: 'INV-EX-1', userId: u.user.id, orderNo: order.orderNo,
        type: 'NORMAL', titleType: 'COMPANY', title: '公司', email: 'a@x.com',
        amount: 59800, status: 'PENDING',
      },
    })
    const res = await request(app).get(`/api/app/orders/${order.orderNo}/invoice-status`)
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.body.canApply).toBe(false)
    expect(res.body.existingInvoice).toMatchObject({
      invoiceNo: 'INV-EX-1',
      status: 'PENDING',
      title: '公司',
    })
  })

  it('0 元订单 → canApply=false', async () => {
    const u = await createNormalUser()
    const order = await createPaidOrderForInvoice(u.user.id, { amount: 0, paidAtDaysAgo: 10 })
    const res = await request(app).get(`/api/app/orders/${order.orderNo}/invoice-status`)
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.body.canApply).toBe(false)
  })

  it('PENDING 订单 → canApply=false', async () => {
    const u = await createNormalUser()
    const order = await prisma.appOrder.create({
      data: {
        orderNo: 'ORD-PENDING-IS', userId: u.user.id, planId: 'personal',
        productType: 'MEMBERSHIP', title: 't', amount: 59800, status: 'PENDING',
      },
    })
    const res = await request(app).get(`/api/app/orders/${order.orderNo}/invoice-status`)
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.body.canApply).toBe(false)
  })

  it('ownership 拦截：其他用户查别人订单状态 → 404', async () => {
    const owner = await createNormalUser()
    const stranger = await createNormalUser()
    const order = await createPaidOrderForInvoice(owner.user.id, { paidAtDaysAgo: 10 })
    const res = await request(app).get(`/api/app/orders/${order.orderNo}/invoice-status`)
      .set('Authorization', `Bearer ${stranger.token}`)
    expect(res.status).toBe(404)
  })

  it('admin 越权可查任何订单状态', async () => {
    const owner = await createNormalUser()
    const admin = await createUser({ role: 'admin' })
    const adminToken = getTestToken(admin.id, 'admin')
    const order = await createPaidOrderForInvoice(owner.user.id, { paidAtDaysAgo: 10 })
    const res = await request(app).get(`/api/app/orders/${order.orderNo}/invoice-status`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.canApply).toBe(true)
  })
})
