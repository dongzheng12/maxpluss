/**
 * 专家评审投票 — 后台管理接口测试（P0-2A）
 *
 * 覆盖：
 *   - 鉴权（普通 user / admin）
 *   - GET /api/admin/expert-votes 列表过滤（默认排除 DRAFT / status / q）
 *   - GET /api/admin/expert-votes/:no 详情（带申请人 + 附件 + 专家 + 订单）
 *   - PUT /experts 录入名单（DRAFT 拦截 / EXPERT_ARRANGING 通过 / 替换语义）
 *   - PATCH /meeting 部分字段更新
 *   - POST /confirm-meeting：必填校验 / CAS 状态迁移 EXPERT_ARRANGING → MEETING_SCHEDULED
 *   - confirm-meeting 触发 Notification 写入（站内消息）
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerExpertVoteRoutes } from '../src/expertVoteRoutes.js'
import { ensureExpertVoteSettings, makeExpertVoteRequestNo } from '../src/services/expertVote.js'
import { createUser, getTestToken, cleanAll, ensurePlans } from './factory.js'

const app = express()
app.use(express.json())
registerExpertVoteRoutes(app)

beforeAll(async () => {
  await ensurePlans()
  await ensureExpertVoteSettings()
})

beforeEach(async () => {
  await cleanAll()
  await ensureExpertVoteSettings()
})

async function seedRequest(userId: string, overrides: Record<string, any> = {}) {
  return prisma.expertVoteRequest.create({
    data: {
      requestNo: makeExpertVoteRequestNo(),
      userId,
      status: 'EXPERT_ARRANGING',
      projectName: '某团体标准送审会',
      targetName: 'T/ABC 1234-2026',
      projectType: '标准评审',
      standardType: '团体标准',
      standardStatus: '送审稿',
      backgroundDesc: '需要专家评审',
      expertSourceType: 'PLATFORM',
      expertCount: 5,
      desiredDate: new Date(Date.now() + 20 * 86400_000),
      desiredSlot: 'AFTERNOON',
      acceptReschedule: true,
      unitPrice: 200000,
      totalAmount: 1000000,
      paidAt: new Date(),
      ...overrides,
    },
  })
}

// ═══════════════════════════════════════════════════════════════
// 1. 鉴权
// ═══════════════════════════════════════════════════════════════

describe('admin 鉴权', () => {
  it('未登录 → 401', async () => {
    const res = await request(app).get('/api/admin/expert-votes')
    expect(res.status).toBe(401)
  })

  it('普通用户 → 403', async () => {
    const u = await createUser()
    const res = await request(app)
      .get('/api/admin/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
    expect(res.status).toBe(403)
  })

  it('admin → 200', async () => {
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.items)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// 2. 列表过滤
// ═══════════════════════════════════════════════════════════════

describe('GET /api/admin/expert-votes 列表', () => {
  it('默认隐藏 DRAFT', async () => {
    const u = await createUser()
    await seedRequest(u.id, { status: 'DRAFT', paidAt: null })
    await seedRequest(u.id, { status: 'EXPERT_ARRANGING' })

    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.items.length).toBe(1)
    expect(res.body.items[0].status).toBe('EXPERT_ARRANGING')
  })

  it('?includeDraft=true 包含 DRAFT', async () => {
    const u = await createUser()
    await seedRequest(u.id, { status: 'DRAFT', paidAt: null })
    await seedRequest(u.id, { status: 'EXPERT_ARRANGING' })

    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/expert-votes?includeDraft=true')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.body.items.length).toBe(2)
  })

  it('按 status 精确过滤', async () => {
    const u = await createUser()
    await seedRequest(u.id, { status: 'EXPERT_ARRANGING' })
    await seedRequest(u.id, { status: 'MEETING_SCHEDULED' })

    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/expert-votes?status=MEETING_SCHEDULED')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.body.items.length).toBe(1)
    expect(res.body.items[0].status).toBe('MEETING_SCHEDULED')
  })

  it('携带申请人简要信息', async () => {
    const u = await createUser({ role: 'user' })
    await prisma.appUser.update({
      where: { id: u.id },
      data: { name: '李某', organization: '示例公司' },
    })
    await seedRequest(u.id)

    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.body.items[0].applicant.name).toBe('李某')
    expect(res.body.items[0].applicant.organization).toBe('示例公司')
  })
})

// ═══════════════════════════════════════════════════════════════
// 3. 详情
// ═══════════════════════════════════════════════════════════════

describe('GET /api/admin/expert-votes/:no 详情', () => {
  it('返回申请 + 申请人 + 订单 + 附件 + 专家', async () => {
    const u = await createUser({ role: 'user' })
    const r = await seedRequest(u.id)
    // 关联订单
    const order = await prisma.appOrder.create({
      data: {
        orderNo: `ORD-${Date.now()}`,
        userId: u.id,
        productType: 'EXPERT_VOTE',
        productRef: r.requestNo,
        title: 't',
        amount: 1000000,
        status: 'PAID',
        paidAt: new Date(),
      },
    })
    await prisma.expertVoteRequest.update({
      where: { requestNo: r.requestNo },
      data: { orderNo: order.orderNo },
    })
    await prisma.expertAssignment.create({
      data: { requestId: r.id, expertName: '张三' },
    })

    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .get(`/api/admin/expert-votes/${r.requestNo}`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.requestNo).toBe(r.requestNo)
    expect(res.body.applicant.id).toBe(u.id)
    expect(res.body.order.orderNo).toBe(order.orderNo)
    expect(res.body.experts.length).toBe(1)
    expect(res.body.experts[0].expertName).toBe('张三')
  })

  it('不存在 → 404', async () => {
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/expert-votes/EVR-NOT-EXIST')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
// 4. PUT /experts 录入名单
// ═══════════════════════════════════════════════════════════════

describe('PUT /api/admin/expert-votes/:no/experts', () => {
  it('EXPERT_ARRANGING 状态可录入', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'EXPERT_ARRANGING' })
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/experts`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({
        experts: [
          { expertName: '张三', expertOrg: 'A 院', expertTitle: '教授' },
          { expertName: '李四', expertOrg: 'B 所' },
        ],
      })
    expect(res.status).toBe(200)
    expect(res.body.items.length).toBe(2)
    expect(res.body.items[0].confirmStatus).toBe('PENDING')
  })

  it('替换语义：第二次 PUT 覆盖第一次', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id)
    const a = await createUser({ role: 'admin' })
    await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/experts`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({ experts: [{ expertName: '张三' }, { expertName: '李四' }] })
    const res = await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/experts`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({ experts: [{ expertName: '王五' }] })
    expect(res.status).toBe(200)
    expect(res.body.items.length).toBe(1)
    expect(res.body.items[0].expertName).toBe('王五')
  })

  it('PAYING 阶段拒绝（status 未达可编辑窗口）', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'PAYING' })
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/experts`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({ experts: [{ expertName: '张三' }] })
    expect(res.status).toBe(409)
  })

  it('experts 为空数组拒绝', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id)
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/experts`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({ experts: [] })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════
// 5. PATCH /meeting 字段更新
// ═══════════════════════════════════════════════════════════════

describe('PATCH /api/admin/expert-votes/:no/meeting', () => {
  it('部分字段更新，其他字段保持', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id)
    const a = await createUser({ role: 'admin' })
    const r1 = await request(app)
      .patch(`/api/admin/expert-votes/${r.requestNo}/meeting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({ meetingTitle: '第一稿', tencentMeetingId: '111-222-333' })
    expect(r1.status).toBe(200)
    expect(r1.body.meetingTitle).toBe('第一稿')
    expect(r1.body.tencentMeetingId).toBe('111-222-333')

    const r2 = await request(app)
      .patch(`/api/admin/expert-votes/${r.requestNo}/meeting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({ tencentMeetingId: '444-555-666' })
    expect(r2.status).toBe(200)
    expect(r2.body.meetingTitle).toBe('第一稿') // 没传，保持
    expect(r2.body.tencentMeetingId).toBe('444-555-666')
  })

  it('PAYING 阶段拒绝', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'PAYING' })
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .patch(`/api/admin/expert-votes/${r.requestNo}/meeting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({ meetingTitle: 'x' })
    expect(res.status).toBe(409)
  })

  it('腾讯会议链接格式错误 → 400', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id)
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .patch(`/api/admin/expert-votes/${r.requestNo}/meeting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({ tencentMeetingUrl: 'meeting.tencent.com/dm/no-protocol' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('腾讯会议链接')
  })
})

describe('PATCH /api/admin/expert-votes/:no/arrangement', () => {
  it('统一保存专家名单 + 会议字段，且不迁移状态', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'EXPERT_ARRANGING', expertCount: 3 })
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .patch(`/api/admin/expert-votes/${r.requestNo}/arrangement`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({
        experts: [{ expertName: '专家A' }, { expertName: '专家B' }, { expertName: '专家C' }],
        meetingTitle: '专家评审会',
        meetingStartAt: new Date(Date.now() + 21 * 86400_000).toISOString(),
        meetingEndAt: new Date(Date.now() + 21 * 86400_000 + 3600_000).toISOString(),
        tencentMeetingId: '123-456-789',
        tencentMeetingUrl: 'https://meeting.tencent.com/dm/abc',
      })
    expect(res.status).toBe(200)
    expect(res.body.request.status).toBe('EXPERT_ARRANGING')
    expect(res.body.request.meetingTitle).toBe('专家评审会')
    expect(res.body.experts.map((e: any) => e.expertName)).toEqual(['专家A', '专家B', '专家C'])

    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.status).toBe('EXPERT_ARRANGING')
    const log = await prisma.expertVoteSignLog.findFirst({ where: { requestId: r.id, action: 'EXPERT_ASSIGN' } })
    expect(log).not.toBeNull()
  })

  it('统一保存的腾讯会议链接格式错误 → 400，且不写专家名单', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'EXPERT_ARRANGING', expertCount: 3 })
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .patch(`/api/admin/expert-votes/${r.requestNo}/arrangement`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({
        experts: [{ expertName: '专家A' }, { expertName: '专家B' }, { expertName: '专家C' }],
        tencentMeetingUrl: 'ftp://meeting.tencent.com/dm/abc',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('腾讯会议链接')
    await expect(prisma.expertAssignment.count({ where: { requestId: r.id } })).resolves.toBe(0)
  })

  it('MEETING_SCHEDULED 下统一保存缺 changeReason → 400', async () => {
    const u = await createUser()
    const { r, admin } = await (async () => {
      const r = await seedRequest(u.id, { status: 'MEETING_SCHEDULED', expertCount: 3 })
      const admin = await createUser({ role: 'admin' })
      await prisma.expertAssignment.createMany({
        data: Array.from({ length: 3 }, (_, i) => ({ requestId: r.id, expertName: `专家${i + 1}` })),
      })
      return { r, admin }
    })()
    const res = await request(app)
      .patch(`/api/admin/expert-votes/${r.requestNo}/arrangement`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        experts: [{ expertName: '新专家A' }, { expertName: '新专家B' }, { expertName: '新专家C' }],
        meetingNotes: '更新注意事项',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('变更原因')
  })

  it('MEETING_SCHEDULED 下统一保存携带 changeReason → 200 + 写两类审计', async () => {
    const u = await createUser()
    const { r, admin } = await (async () => {
      const r = await seedRequest(u.id, { status: 'MEETING_SCHEDULED', expertCount: 3 })
      const admin = await createUser({ role: 'admin' })
      await prisma.expertAssignment.createMany({
        data: Array.from({ length: 3 }, (_, i) => ({ requestId: r.id, expertName: `专家${i + 1}` })),
      })
      return { r, admin }
    })()
    const res = await request(app)
      .patch(`/api/admin/expert-votes/${r.requestNo}/arrangement`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        experts: [{ expertName: '新专家A' }, { expertName: '新专家B' }, { expertName: '新专家C' }],
        meetingNotes: '更新注意事项',
        changeReason: '专家临时调整',
      })
    expect(res.status).toBe(200)
    expect(res.body.request.status).toBe('MEETING_SCHEDULED')

    const logs = await prisma.expertVoteSignLog.findMany({
      where: { requestId: r.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(logs.map((l) => l.action)).toEqual(['EXPERT_CHANGE', 'MEETING_CHANGE'])
  })
})

// ═══════════════════════════════════════════════════════════════
// 6. POST /confirm-meeting CAS + 通知
// ═══════════════════════════════════════════════════════════════

// 测试辅助：先录足专家，再去测会议字段必填
async function seedFullExperts(requestId: string, count: number) {
  for (let i = 0; i < count; i++) {
    await prisma.expertAssignment.create({
      data: { requestId, expertName: `专家${i + 1}` },
    })
  }
}

describe('POST /api/admin/expert-votes/:no/confirm-meeting', () => {
  it('必填字段缺失 → 400', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id)
    await seedFullExperts(r.id, r.expertCount)
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/confirm-meeting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({}) // 全空
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/缺少必填会议字段/)
  })

  it('齐全后 CAS EXPERT_ARRANGING → MEETING_SCHEDULED + 写 Notification', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'EXPERT_ARRANGING' })
    await seedFullExperts(r.id, r.expertCount)
    const a = await createUser({ role: 'admin' })

    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/confirm-meeting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({
        meetingTitle: '某标准评审会',
        meetingStartAt: new Date(Date.now() + 21 * 86400_000).toISOString(),
        meetingEndAt: new Date(Date.now() + 21 * 86400_000 + 90 * 60_000).toISOString(),
        tencentMeetingId: '123-456-789',
        tencentMeetingUrl: 'https://meeting.tencent.com/dm/abc',
      })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('MEETING_SCHEDULED')
    expect(res.body.meetingArrangedAt).toBeTruthy()
    expect(res.body.meetingArrangedBy).toBe(a.id)

    const notif = await prisma.notification.findFirst({
      where: { userId: u.id, type: 'EXPERT_VOTE' },
      orderBy: { createdAt: 'desc' },
    })
    expect(notif).not.toBeNull()
    expect(notif!.title).toContain('会议')
    expect(notif!.link).toBe(`/pages/expert-vote/meeting/index?no=${r.requestNo}`)
    // 站内消息正文不应暴露完整链接 / 密码（与 PRD §10 安全要求一致）
    expect(notif!.body).not.toContain('https://meeting.tencent.com')
    expect(notif!.body).not.toContain('123-456-789')
  })

  it('非 EXPERT_ARRANGING 拒绝（如 MEETING_SCHEDULED）', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'MEETING_SCHEDULED' })
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/confirm-meeting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({
        meetingTitle: 'x',
        meetingStartAt: new Date().toISOString(),
        meetingEndAt: new Date(Date.now() + 60_000).toISOString(),
        tencentMeetingId: 'x', tencentMeetingUrl: 'https://meeting.tencent.com/dm/status-guard',
      })
    expect(res.status).toBe(409)
  })

  it('腾讯会议链接格式错误 → 400，不迁移状态', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'EXPERT_ARRANGING' })
    await seedFullExperts(r.id, r.expertCount)
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/confirm-meeting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({
        meetingTitle: '会议',
        meetingStartAt: new Date(Date.now() + 20 * 86400_000).toISOString(),
        meetingEndAt: new Date(Date.now() + 20 * 86400_000 + 3600_000).toISOString(),
        tencentMeetingId: '999',
        tencentMeetingUrl: 'not-a-url',
      })
    expect(res.status).toBe(400)
    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.status).toBe('EXPERT_ARRANGING')
  })

  it('混合姿势：先 PATCH 部分字段，再 confirm-meeting 不传字段也能确认', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'EXPERT_ARRANGING' })
    await seedFullExperts(r.id, r.expertCount)
    const a = await createUser({ role: 'admin' })
    await request(app)
      .patch(`/api/admin/expert-votes/${r.requestNo}/meeting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({
        meetingTitle: '会议名',
        meetingStartAt: new Date(Date.now() + 21 * 86400_000).toISOString(),
        meetingEndAt: new Date(Date.now() + 21 * 86400_000 + 60 * 60_000).toISOString(),
        tencentMeetingId: '111',
        tencentMeetingUrl: 'https://x',
      })
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/confirm-meeting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('MEETING_SCHEDULED')
  })

  it('confirm-meeting：专家数不足时返回 400', async () => {
    const u = await createUser()
    // expertCount=5 但只录入 3 位专家
    const r = await seedRequest(u.id, { status: 'EXPERT_ARRANGING', expertCount: 5 })
    const a = await createUser({ role: 'admin' })
    // 录入 3 位专家（不足 5）
    await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/experts`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({ experts: [
        { expertName: '专家A' }, { expertName: '专家B' }, { expertName: '专家C' },
      ]})
    expect((await request(app).put(`/api/admin/expert-votes/${r.requestNo}/experts`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({ experts: [{ expertName: 'A' }, { expertName: 'B' }, { expertName: 'C' }] })).status).toBe(200)

    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/confirm-meeting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({
        meetingTitle: '会议', meetingStartAt: new Date(Date.now() + 20 * 86400_000).toISOString(),
        meetingEndAt: new Date(Date.now() + 20 * 86400_000 + 3600_000).toISOString(),
        tencentMeetingId: '999', tencentMeetingUrl: 'https://x',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('专家名单不完整')
  })
})

// ═══════════════════════════════════════════════════════════════
// MEETING_SCHEDULED 保护（changeReason）
// ═══════════════════════════════════════════════════════════════
describe('MEETING_SCHEDULED 修改保护', () => {
  async function seedWithExperts(userId: string, expertCount = 3) {
    const r = await seedRequest(userId, { status: 'MEETING_SCHEDULED', expertCount })
    const admin = await createUser({ role: 'admin' })
    // 直接写入 expertCount 个专家（绕过状态限制，直接 DB 写）
    await prisma.expertAssignment.createMany({
      data: Array.from({ length: expertCount }, (_, i) => ({
        requestId: r.id,
        expertName: `专家${i + 1}`,
      })),
    })
    return { r, admin }
  }

  it('MEETING_SCHEDULED 下 PUT experts 缺 changeReason → 400', async () => {
    const u = await createUser()
    const { r, admin } = await seedWithExperts(u.id)
    const res = await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/experts`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ experts: [{ expertName: '新专家A' }, { expertName: '新专家B' }, { expertName: '新专家C' }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('变更原因')
  })

  it('MEETING_SCHEDULED 下 PUT experts 携带 changeReason → 200', async () => {
    const u = await createUser()
    const { r, admin } = await seedWithExperts(u.id, 3)
    const res = await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/experts`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        experts: [{ expertName: '新专家A' }, { expertName: '新专家B' }, { expertName: '新专家C' }],
        changeReason: '某专家临时有事无法出席',
      })
    expect(res.status).toBe(200)
  })

  it('MEETING_SCHEDULED 下 PATCH meeting 缺 changeReason → 400', async () => {
    const u = await createUser()
    const { r, admin } = await seedWithExperts(u.id)
    const res = await request(app)
      .patch(`/api/admin/expert-votes/${r.requestNo}/meeting`)
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({ meetingNotes: '更新了注意事项' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('变更原因')
  })
})

// ═══════════════════════════════════════════════════════════════
// 通知接口
// ═══════════════════════════════════════════════════════════════
describe('通知文本 & mark-notified', () => {
  it('GET notification-texts 返回三套文案', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, {
      status: 'MEETING_SCHEDULED',
      meetingTitle: '测试评审会',
      tencentMeetingId: '888-888-888',
      tencentMeetingUrl: 'https://meeting.tencent.com/test',
      meetingStartAt: new Date(Date.now() + 20 * 86400_000),
      meetingEndAt: new Date(Date.now() + 20 * 86400_000 + 7200_000),
    })
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .get(`/api/admin/expert-votes/${r.requestNo}/notification-texts`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.texts.expert_invite).toContain(r.projectName)
    expect(res.body.texts.meeting_confirm).toContain('888-888-888')
    expect(res.body.texts.vote_remind).toContain(r.requestNo)
    expect(res.body.notifiedAt).toBeNull()
  })

  it('mark-notified 幂等：第一次 200，第二次 409', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'MEETING_SCHEDULED' })
    const a = await createUser({ role: 'admin' })
    const first = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/mark-notified`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(first.status).toBe(200)
    expect(first.body.notifiedAt).toBeTruthy()
    expect(first.body.notifiedBy).toBe(a.id)

    const second = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/mark-notified`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(second.status).toBe(409)
    expect(second.body.error).toContain('重复标记')
  })
})
