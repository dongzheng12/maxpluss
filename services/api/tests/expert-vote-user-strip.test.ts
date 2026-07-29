/**
 * 用户端字段裁剪 + 审计日志补全 测试
 *
 * 覆盖：
 *   - 用户端 list / detail 不返回 USER_STRIP_FIELDS（密码 / 内部路径 / 操作员 userId / 内部通知标记）
 *   - admin 端 list / detail 仍返回完整字段（不受裁剪影响）
 *   - 审计 sign log 在以下节点被写入：
 *       EXPERT_ASSIGN（EXPERT_ARRANGING 阶段录入专家）
 *       START_VOTING（MEETING_SCHEDULED → VOTING）
 *       VOTING_RESULTS_UPDATED（每次保存投票）
 *       CLOSE_VOTING（VOTING → VOTED）
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerExpertVoteRoutes } from '../src/expertVoteRoutes.js'
import {
  ensureExpertVoteSettings, makeExpertVoteRequestNo,
} from '../src/services/expertVote.js'
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

const SENSITIVE = [
  'tencentMeetingPwd',
  'resultPdfPath',
  'resultDocxPath',
  'finalDeliverablePath',
  'signedPdfPath',
  'expertSignatureMaterialPath',
  'meetingArrangedBy',
  'voteClosedBy',
  'cancelledBy',
  'deliveredBy',
  'signedBy',
  'notifiedBy',
  'notifiedAt',
] as const

async function seedFullRequest(userId: string, overrides: Record<string, any> = {}) {
  return prisma.expertVoteRequest.create({
    data: {
      requestNo: makeExpertVoteRequestNo(),
      userId, status: 'COMPLETED',
      contactName: '联系人', contactPhone: '13900008888',
      projectName: '泄露测试项目', targetName: 'T/STRIP 1-2026',
      projectType: '标准评审', standardType: '团体标准', standardStatus: '送审稿',
      backgroundDesc: 'x',
      expertSourceType: 'PLATFORM', expertCount: 5,
      desiredDate: new Date(Date.now() + 20 * 86400_000), desiredSlot: 'AFTERNOON',
      acceptReschedule: true,
      unitPrice: 200000, totalAmount: 1000000,
      paidAt: new Date(),
      meetingTitle: '会议',
      meetingStartAt: new Date(Date.now() + 21 * 86400_000),
      meetingEndAt: new Date(Date.now() + 21 * 86400_000 + 3600_000),
      tencentMeetingId: '111-222', tencentMeetingUrl: 'https://meet/x',
      tencentMeetingPwd: 'TOPSECRET',
      meetingArrangedAt: new Date(), meetingArrangedBy: 'admin-id',
      voteClosedAt: new Date(), voteClosedBy: 'admin-id',
      voteResultJson: '{"PASS":5,"REJECT":0,"PASS_WITH_MOD":0,"ABSTAIN":0,"total":5}',
      conclusion: 'PASS',
      resultPdfPath: '/secret/path/result.docx',
      finalDeliverablePath: '/secret/path/final.docx',
      finalDeliverableHash: 'a'.repeat(64),
      deliveryMode: 'PLATFORM_GENERATED',
      deliveredBy: 'admin-id', deliveredAt: new Date(),
      signedPdfPath: '/secret/path/final.docx',
      signedPdfHash: 'a'.repeat(64),
      signedAt: new Date(), signedBy: 'admin-id',
      notifiedAt: new Date(), notifiedBy: 'admin-id',
      ...overrides,
    },
  })
}

// ─── 用户端字段裁剪 ──────────────────────────────────────────

describe('用户端 list 字段裁剪', () => {
  it('不返回 USER_STRIP_FIELDS 中的任何字段', async () => {
    const u = await createUser()
    await seedFullRequest(u.id)
    const res = await request(app)
      .get('/api/app/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
    expect(res.status).toBe(200)
    expect(res.body.items.length).toBe(1)
    const item = res.body.items[0]
    for (const k of SENSITIVE) {
      expect(item, `字段 ${k} 不应在用户端 list 出现`).not.toHaveProperty(k)
    }
    // 关键展示字段仍在
    expect(item.requestNo).toBeTruthy()
    expect(item.status).toBe('COMPLETED')
    expect(item.finalDeliverableReady).toBe(true)
    expect(item.finalDeliverableFileName).toBe(`${item.requestNo}_专家评审最终交付文件.docx`)
    // tencentMeetingUrl / Id 保留（用户需要看链接进会议），仅密码 Pwd 被裁
    expect(item.tencentMeetingUrl).toBe('https://meet/x')
    expect(item.tencentMeetingId).toBe('111-222')
  })
})

describe('用户端 detail 字段裁剪', () => {
  it('不返回 USER_STRIP_FIELDS 中的任何字段', async () => {
    const u = await createUser()
    const r = await seedFullRequest(u.id)
    const res = await request(app)
      .get(`/api/app/expert-votes/${r.requestNo}`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
    expect(res.status).toBe(200)
    for (const k of SENSITIVE) {
      expect(res.body, `字段 ${k} 不应在用户端 detail 出现`).not.toHaveProperty(k)
    }
    expect(res.body.finalDeliverableReady).toBe(true)
    expect(res.body.finalDeliverableFileName).toBe(`${r.requestNo}_专家评审最终交付文件.docx`)
    // experts 仍走旧白名单（select 限制）
    expect(Array.isArray(res.body.experts)).toBe(true)
  })

  it('Hash / 时间戳类元数据保留（非敏感）', async () => {
    const u = await createUser()
    const r = await seedFullRequest(u.id)
    const res = await request(app)
      .get(`/api/app/expert-votes/${r.requestNo}`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
    expect(res.body.finalDeliverableHash).toBeTruthy()
    expect(res.body.signedPdfHash).toBeTruthy()
    expect(res.body.deliveredAt).toBeTruthy()
    expect(res.body.paidAt).toBeTruthy()
  })

  it('REFUNDED 状态下仍不返回 USER_STRIP_FIELDS', async () => {
    const u = await createUser()
    const r = await seedFullRequest(u.id, { status: 'REFUNDED' })
    const res = await request(app)
      .get(`/api/app/expert-votes/${r.requestNo}`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('REFUNDED')
    for (const k of SENSITIVE) {
      expect(res.body, `字段 ${k} 不应在 REFUNDED detail 出现`).not.toHaveProperty(k)
    }
    expect(res.body.finalDeliverableReady).toBe(false)
    expect(res.body.finalDeliverableFileName).toBeUndefined()
  })
})

describe('admin 端字段不受裁剪影响', () => {
  it('admin list 返回 tencentMeetingPwd / 内部路径 / 操作员 userId', async () => {
    const u = await createUser()
    await seedFullRequest(u.id)
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .get('/api/admin/expert-votes')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.status).toBe(200)
    const item = res.body.items[0]
    expect(item.tencentMeetingPwd).toBe('TOPSECRET')
    expect(item.finalDeliverablePath).toBe('/secret/path/final.docx')
    expect(item.meetingArrangedBy).toBe('admin-id')
    expect(item.notifiedBy).toBe('admin-id')
  })

  it('admin detail 返回 tencentMeetingPwd / 内部路径', async () => {
    const u = await createUser()
    const r = await seedFullRequest(u.id)
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .get(`/api/admin/expert-votes/${r.requestNo}`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.body.tencentMeetingPwd).toBe('TOPSECRET')
    expect(res.body.resultPdfPath).toBe('/secret/path/result.docx')
  })
})

// ─── 审计日志补全 ────────────────────────────────────────────

async function seedAtStatus(adminId: string, status: string, expertCount = 3) {
  const u = await createUser()
  const r = await prisma.expertVoteRequest.create({
    data: {
      requestNo: makeExpertVoteRequestNo(),
      userId: u.id, status,
      projectName: 'p', targetName: 't', projectType: '标准评审',
      standardType: '团体标准', standardStatus: '送审稿', backgroundDesc: 'x',
      expertSourceType: 'PLATFORM', expertCount,
      desiredDate: new Date(Date.now() + 20 * 86400_000), desiredSlot: 'AFTERNOON',
      unitPrice: 200000, totalAmount: 200000 * expertCount,
      paidAt: new Date(),
      meetingTitle: '会议',
      meetingStartAt: new Date(Date.now() + 21 * 86400_000),
      meetingEndAt: new Date(Date.now() + 21 * 86400_000 + 3600_000),
      tencentMeetingId: 'mid', tencentMeetingUrl: 'https://m',
    },
  })
  return { user: u, r }
}

describe('审计日志：EXPERT_ASSIGN（EXPERT_ARRANGING 录入）', () => {
  it('PUT /experts 在 EXPERT_ARRANGING 阶段写 EXPERT_ASSIGN，不写 EXPERT_CHANGE', async () => {
    const a = await createUser({ role: 'admin' })
    const { r } = await seedAtStatus(a.id, 'EXPERT_ARRANGING', 3)
    const res = await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/experts`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({ experts: [{ expertName: 'A' }, { expertName: 'B' }, { expertName: 'C' }] })
    expect(res.status).toBe(200)
    const logs = await prisma.expertVoteSignLog.findMany({ where: { requestId: r.id } })
    expect(logs.map((l) => l.action)).toContain('EXPERT_ASSIGN')
    expect(logs.map((l) => l.action)).not.toContain('EXPERT_CHANGE')
    const log = logs.find((l) => l.action === 'EXPERT_ASSIGN')!
    expect(JSON.parse(log.payloadJson!)).toEqual({ count: 3 })
  })

  it('PUT /experts 在 MEETING_SCHEDULED 阶段仍写 EXPERT_CHANGE（不退化）', async () => {
    const a = await createUser({ role: 'admin' })
    const { r } = await seedAtStatus(a.id, 'MEETING_SCHEDULED', 3)
    // 先建初始专家（绕过路由，直接 DB 写）
    await prisma.expertAssignment.createMany({
      data: [
        { requestId: r.id, expertName: 'X1' },
        { requestId: r.id, expertName: 'X2' },
        { requestId: r.id, expertName: 'X3' },
      ],
    })
    const res = await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/experts`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({
        experts: [{ expertName: 'Y1' }, { expertName: 'Y2' }, { expertName: 'Y3' }],
        changeReason: '更换理由',
      })
    expect(res.status).toBe(200)
    const logs = await prisma.expertVoteSignLog.findMany({ where: { requestId: r.id } })
    expect(logs.map((l) => l.action)).toContain('EXPERT_CHANGE')
    expect(logs.map((l) => l.action)).not.toContain('EXPERT_ASSIGN')
  })
})

describe('审计日志：START_VOTING / VOTING_RESULTS_UPDATED / CLOSE_VOTING', () => {
  it('POST /start-voting 写 START_VOTING（含 expertCount）', async () => {
    const a = await createUser({ role: 'admin' })
    const { r } = await seedAtStatus(a.id, 'MEETING_SCHEDULED', 3)
    await prisma.expertAssignment.createMany({
      data: [
        { requestId: r.id, expertName: 'A' },
        { requestId: r.id, expertName: 'B' },
        { requestId: r.id, expertName: 'C' },
      ],
    })
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/start-voting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(200)
    const log = await prisma.expertVoteSignLog.findFirst({
      where: { requestId: r.id, action: 'START_VOTING' },
    })
    expect(log).not.toBeNull()
    expect(JSON.parse(log!.payloadJson!).expertCount).toBe(3)
  })

  it('PUT /voting-results 写 VOTING_RESULTS_UPDATED（含 recordCount + summary）', async () => {
    const a = await createUser({ role: 'admin' })
    const { r } = await seedAtStatus(a.id, 'VOTING', 3)
    const aids: string[] = []
    for (const name of ['A', 'B', 'C']) {
      const e = await prisma.expertAssignment.create({ data: { requestId: r.id, expertName: name } })
      aids.push(e.id)
    }
    const res = await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/voting-results`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({
        conclusion: 'PASS',
        votes: aids.map((aid) => ({ assignmentId: aid, voteResult: 'PASS', reviewOpinion: 'OK' })),
      })
    expect(res.status).toBe(200)
    const log = await prisma.expertVoteSignLog.findFirst({
      where: { requestId: r.id, action: 'VOTING_RESULTS_UPDATED' },
    })
    expect(log).not.toBeNull()
    const pl = JSON.parse(log!.payloadJson!)
    expect(pl.recordCount).toBe(3)
    expect(pl.summary.PASS).toBe(3)
    expect(pl.summary.total).toBe(3)
  })

  it('POST /close-voting 写 CLOSE_VOTING（含 conclusion）', async () => {
    const a = await createUser({ role: 'admin' })
    const { r } = await seedAtStatus(a.id, 'VOTING', 2)
    const e1 = await prisma.expertAssignment.create({ data: { requestId: r.id, expertName: 'A' } })
    const e2 = await prisma.expertAssignment.create({ data: { requestId: r.id, expertName: 'B' } })
    for (const aid of [e1.id, e2.id]) {
      await prisma.expertVoteRecord.create({
        data: {
          requestId: r.id, assignmentId: aid,
          voteResult: 'PASS', reviewOpinion: '同意', agreeConclusion: 'YES',
          submittedBy: a.id, confirmFlag: true,
        },
      })
    }
    await prisma.expertVoteRequest.update({
      where: { id: r.id },
      data: { conclusion: 'PASS', voteResultJson: '{"PASS":2,"total":2}' },
    })
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/close-voting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(200)
    const log = await prisma.expertVoteSignLog.findFirst({
      where: { requestId: r.id, action: 'CLOSE_VOTING' },
    })
    expect(log).not.toBeNull()
    const pl = JSON.parse(log!.payloadJson!)
    expect(pl.conclusion).toBe('PASS')
  })
})
