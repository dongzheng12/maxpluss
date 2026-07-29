/**
 * 专家评审投票 — 会后整理 → 确认文件 → 最终交付 全流程状态机测试
 *
 * 覆盖（fe99c55 之前未覆盖的 admin 接口）：
 *   - start-voting：MEETING_SCHEDULED → VOTING；状态守卫 / 鉴权
 *   - voting-results：upsert + summary + conclusion 写入；非 VOTING 拒绝；非法 assignmentId
 *   - close-voting：缺 conclusion / 专家未录意见 / happy → VOTED
 *   - generate-result-doc：VOTED → SIGNING + resultPdfPath 写入 + sign log；旧 generate-pdf alias
 *   - generate-final-deliverable（Path A）：默认关闭 403；flag=true 时 SIGNING → COMPLETED
 *   - upload-final-deliverable（Path B）：SIGNING → COMPLETED + OFFLINE_UPLOAD
 *   - experts/:aid/notify：行级通知标记
 *   - sign-logs：操作记录返回
 *   - 用户端 download-final：鉴权 / 跨用户 / 状态守卫
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { existsSync, readFileSync } from 'node:fs'
import JSZip from 'jszip'
import { prisma } from '../src/db.js'
import { registerExpertVoteRoutes } from '../src/expertVoteRoutes.js'
import {
  EXPERT_VOTE_SETTING_KEYS,
  ensureExpertVoteSettings,
  makeExpertVoteRequestNo,
  transitionStatus,
} from '../src/services/expertVote.js'
import { createUser, getTestToken, cleanAll, ensurePlans } from './factory.js'

const app = express()
app.use(express.json())
registerExpertVoteRoutes(app)

async function setPathAEnabled(enabled: boolean) {
  await prisma.systemSetting.upsert({
    where: { key: EXPERT_VOTE_SETTING_KEYS.PATH_A_ENABLED },
    update: { value: String(enabled) },
    create: { key: EXPERT_VOTE_SETTING_KEYS.PATH_A_ENABLED, value: String(enabled) },
  })
}

beforeAll(async () => {
  await ensurePlans()
  await ensureExpertVoteSettings()
})

beforeEach(async () => {
  await cleanAll()
  await ensureExpertVoteSettings()
  await setPathAEnabled(false)
})

async function seedRequest(userId: string, overrides: Record<string, any> = {}) {
  return prisma.expertVoteRequest.create({
    data: {
      requestNo: makeExpertVoteRequestNo(),
      userId,
      status: 'MEETING_SCHEDULED',
      projectName: '某团体标准送审会',
      targetName: 'T/ABC 1234-2026',
      projectType: '标准评审',
      standardType: '团体标准',
      standardStatus: '送审稿',
      backgroundDesc: '需要专家评审',
      expertSourceType: 'PLATFORM',
      expertCount: 3,
      desiredDate: new Date(Date.now() + 20 * 86400_000),
      desiredSlot: 'AFTERNOON',
      acceptReschedule: true,
      unitPrice: 200000,
      totalAmount: 600000,
      paidAt: new Date(),
      meetingTitle: '评审会',
      meetingStartAt: new Date(Date.now() + 21 * 86400_000),
      meetingEndAt: new Date(Date.now() + 21 * 86400_000 + 3600_000),
      tencentMeetingId: '888-888-888',
      tencentMeetingUrl: 'https://meeting.tencent.com/test',
      ...overrides,
    },
  })
}

async function seedExperts(requestId: string, count: number) {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const e = await prisma.expertAssignment.create({
      data: {
        requestId,
        expertName: `专家${i + 1}`,
        expertOrg: `机构${i + 1}`,
        expertTitle: '教授',
      },
    })
    ids.push(e.id)
  }
  return ids
}

// ═════════════════════════════════════════════════════════════
// 1. start-voting
// ═════════════════════════════════════════════════════════════
describe('POST /api/admin/expert-votes/:no/start-voting', () => {
  it('普通用户访问 → 403', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id)
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/start-voting`)
      .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
      .send({})
    expect(res.status).toBe(403)
  })

  it('MEETING_SCHEDULED → VOTING + voteStartedAt 写入', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id)
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/start-voting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('VOTING')
    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.status).toBe('VOTING')
    expect(fresh!.voteStartedAt).not.toBeNull()
    const log = await prisma.expertVoteSignLog.findFirst({
      where: { requestId: r.id, action: 'START_VOTING' },
    })
    expect(log).not.toBeNull()
    expect(log!.operatorId).toBe(a.id)
  })

  it('会议时间已过时 GET 详情不自动推进真实状态', async () => {
    const u = await createUser()
    const a = await createUser({ role: 'admin' })
    const r = await seedRequest(u.id, {
      meetingStartAt: new Date(Date.now() - 2 * 3600_000),
      meetingEndAt: new Date(Date.now() - 3600_000),
    })
    const res = await request(app)
      .get(`/api/admin/expert-votes/${r.requestNo}`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('MEETING_SCHEDULED')
    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.status).toBe('MEETING_SCHEDULED')
    const log = await prisma.expertVoteSignLog.findFirst({
      where: { requestId: r.id, action: 'START_VOTING' },
    })
    expect(log).toBeNull()
  })

  it('非 MEETING_SCHEDULED → 409', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'EXPERT_ARRANGING' })
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/start-voting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(409)
  })

  it('不存在 → 404', async () => {
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .post('/api/admin/expert-votes/EVR-NOPE/start-voting')
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(404)
  })
})

describe('CLOSED 状态已移除', () => {
  it('DRAFT → CLOSED 返回 400（非法迁移）', async () => {
    const probe = express()
    probe.use(express.json())
    probe.post('/__test/expert-votes/:no/close', async (req, res) => {
      try {
        await transitionStatus(prisma, req.params.no, 'DRAFT', 'CLOSED' as any)
        res.json({ ok: true })
      } catch (e: any) {
        res.status(400).json({ error: e.message })
      }
    })

    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'DRAFT' })
    const res = await request(probe).post(`/__test/expert-votes/${r.requestNo}/close`).send({})

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/非法状态迁移/)
    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.status).toBe('DRAFT')
  })
})

// ═════════════════════════════════════════════════════════════
// 2. voting-results
// ═════════════════════════════════════════════════════════════
describe('PUT /api/admin/expert-votes/:no/voting-results', () => {
  it('VOTING 状态：upsert 投票记录 + 汇总 + conclusion 写入', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'VOTING' })
    const aids = await seedExperts(r.id, 3)
    const a = await createUser({ role: 'admin' })

    const res = await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/voting-results`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({
        conclusion: 'PASS',
        conclusionRemark: '一致通过',
        votes: [
          { assignmentId: aids[0], voteResult: 'PASS', reviewOpinion: '好' },
          { assignmentId: aids[1], voteResult: 'PASS_WITH_MOD', reviewOpinion: '建议小改', modificationSuggestion: '加 §3.4' },
          { assignmentId: aids[2], voteResult: 'PASS', reviewOpinion: '同意' },
        ],
      })
    expect(res.status).toBe(200)
    expect(res.body.conclusion).toBe('PASS')
    expect(res.body.records.length).toBe(3)
    const summary = JSON.parse(res.body.voteResultJson)
    expect(summary.PASS).toBe(2)
    expect(summary.PASS_WITH_MOD).toBe(1)
    expect(summary.total).toBe(3)
  })

  it('非 VOTING 拒绝 → 409', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'MEETING_SCHEDULED' })
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/voting-results`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({ votes: [] })
    expect(res.status).toBe(409)
  })

  it('非法 assignmentId → 400', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'VOTING' })
    await seedExperts(r.id, 2)
    const a = await createUser({ role: 'admin' })
    const res = await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/voting-results`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({
        votes: [{ assignmentId: 'fake-id', voteResult: 'PASS', reviewOpinion: 'x' }],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/非法的 assignmentId/)
  })

  it('两次提交同一 assignment：第二次 update（不重复 create）', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'VOTING' })
    const aids = await seedExperts(r.id, 1)
    const a = await createUser({ role: 'admin' })

    await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/voting-results`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({ votes: [{ assignmentId: aids[0], voteResult: 'PASS', reviewOpinion: 'v1' }] })
    const res2 = await request(app)
      .put(`/api/admin/expert-votes/${r.requestNo}/voting-results`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({ votes: [{ assignmentId: aids[0], voteResult: 'REJECT', reviewOpinion: 'v2' }] })
    expect(res2.status).toBe(200)
    const records = await prisma.expertVoteRecord.findMany({ where: { requestId: r.id } })
    expect(records.length).toBe(1)
    expect(records[0].voteResult).toBe('REJECT')
    expect(records[0].reviewOpinion).toBe('v2')
  })
})

// ═════════════════════════════════════════════════════════════
// 3. close-voting
// ═════════════════════════════════════════════════════════════
describe('POST /api/admin/expert-votes/:no/close-voting', () => {
  async function setupVotingWithRecords(adminId: string, count: number, allRecorded: boolean, conclusion: string | null) {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'VOTING', expertCount: count, ...(conclusion ? { conclusion } : {}) })
    const aids = await seedExperts(r.id, count)
    const recordCount = allRecorded ? count : Math.max(0, count - 1)
    for (let i = 0; i < recordCount; i++) {
      await prisma.expertVoteRecord.create({
        data: {
          requestId: r.id,
          assignmentId: aids[i],
          voteResult: 'PASS',
          reviewOpinion: '同意',
          agreeConclusion: 'YES',
          submittedBy: adminId,
          submittedByMode: 'ADMIN_PROXY',
          confirmFlag: true,
        },
      })
    }
    return { r, aids }
  }

  it('缺 conclusion → 400', async () => {
    const a = await createUser({ role: 'admin' })
    const { r } = await setupVotingWithRecords(a.id, 3, true, null)
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/close-voting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/最终结论/)
  })

  it('部分专家未录意见 → 400 列出缺失人名', async () => {
    const a = await createUser({ role: 'admin' })
    const { r } = await setupVotingWithRecords(a.id, 3, false, 'PASS')
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/close-voting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/专家3/)
  })

  it('齐全：VOTING → VOTED + voteClosedAt/By 写入', async () => {
    const a = await createUser({ role: 'admin' })
    const { r } = await setupVotingWithRecords(a.id, 3, true, 'PASS')
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/close-voting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('VOTED')
    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.voteClosedAt).not.toBeNull()
    expect(fresh!.voteClosedBy).toBe(a.id)
  })

  it('非 VOTING → 409', async () => {
    const a = await createUser({ role: 'admin' })
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'EXPERT_ARRANGING' })
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/close-voting`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(409)
  })
})

// ═════════════════════════════════════════════════════════════
// 4. generate-result-doc（旧 generate-pdf alias 兼容）
// ═════════════════════════════════════════════════════════════
describe('POST /api/admin/expert-votes/:no/generate-result-doc', () => {
  async function setupVoted(adminId: string) {
    const u = await createUser()
    const r = await seedRequest(u.id, {
      status: 'VOTED',
      contactName: '测试申请人',
      contactPhone: '13800000001',
      draftingOrgs: '测试申请单位',
      conclusion: 'PASS',
      conclusionRemark: '综合意见一致通过',
      voteResultJson: JSON.stringify({ PASS: 3, REJECT: 0, PASS_WITH_MOD: 0, ABSTAIN: 0, total: 3 }),
    })
    const aids = await seedExperts(r.id, 3)
    for (const aid of aids) {
      await prisma.expertVoteRecord.create({
        data: {
          requestId: r.id, assignmentId: aid,
          voteResult: 'PASS', reviewOpinion: '同意本项目', agreeConclusion: 'YES',
          submittedBy: adminId, confirmFlag: true,
        },
      })
    }
    return { user: u, r }
  }

  async function postGenerateResultDoc(requestNo: string, adminId: string, path: 'generate-result-doc' | 'generate-pdf' = 'generate-result-doc') {
    return request(app)
      .post(`/api/admin/expert-votes/${requestNo}/${path}`)
      .set('Authorization', `Bearer ${getTestToken(adminId, 'admin')}`)
      .send({})
  }

  it('VOTED → SIGNING + resultPdfPath 写入 + sign log', async () => {
    const a = await createUser({ role: 'admin' })
    const { r } = await setupVoted(a.id)
    const res = await postGenerateResultDoc(r.requestNo, a.id)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.resultDocUrl).toBe(`/api/admin/expert-votes/${r.requestNo}/download-result-doc`)
    expect(res.body.pdfUrl).toBe(`/api/admin/expert-votes/${r.requestNo}/download-result-pdf`)
    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.status).toBe('SIGNING')
    expect(fresh!.resultPdfPath).toBeTruthy()
    expect(fresh!.resultDocxPath).toBe(fresh!.resultPdfPath)
    expect(existsSync(fresh!.resultPdfPath!)).toBe(true)
    const log = await prisma.expertVoteSignLog.findFirst({
      where: { requestId: r.id, action: 'GENERATE_PDF' },
    })
    expect(log).not.toBeNull()
  })

  it('有会议 / 专家 / 投票数据时生成的 Word 确认文件包含关键字段', async () => {
    const a = await createUser({ role: 'admin' })
    const { r } = await setupVoted(a.id)
    const res = await postGenerateResultDoc(r.requestNo, a.id)
    expect(res.status).toBe(200)

    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.resultDocxPath).toBeTruthy()
    const zip = await JSZip.loadAsync(readFileSync(fresh!.resultDocxPath!))
    const xml = await zip.file('word/document.xml')!.async('string')
    for (const key of [
      '某团体标准送审会',
      '测试申请单位',
      '测试申请人',
      '13800000001',
      '评审会',
      '专家1',
      '机构1',
      '通过',
      '同意本项目',
      '综合意见一致通过',
    ]) {
      expect(xml).toContain(key)
    }
    for (const forbidden of ['reviewOpinion', 'voteResult', 'resultPdfPath', 'resultDocxPath', 'undefined', 'null', '[object Object]']) {
      expect(xml).not.toContain(forbidden)
    }
  })

  it('缺少投票数据时 generate-result-doc 返回 400 且不生成空文件', async () => {
    const a = await createUser({ role: 'admin' })
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'VOTED', conclusion: 'PASS' })
    await seedExperts(r.id, 3)
    const res = await postGenerateResultDoc(r.requestNo, a.id)
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('确认文件缺少必要数据')
    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.status).toBe('VOTED')
    expect(fresh!.resultDocxPath).toBeNull()
    expect(fresh!.resultPdfPath).toBeNull()
  })

  it('generate-pdf alias 与 generate-result-doc 行为一致', async () => {
    const a = await createUser({ role: 'admin' })
    const canonical = await setupVoted(a.id)
    const alias = await setupVoted(a.id)

    const canonicalRes = await postGenerateResultDoc(canonical.r.requestNo, a.id, 'generate-result-doc')
    const aliasRes = await postGenerateResultDoc(alias.r.requestNo, a.id, 'generate-pdf')

    expect(canonicalRes.status).toBe(200)
    expect(aliasRes.status).toBe(200)
    expect(canonicalRes.body.ok).toBe(true)
    expect(aliasRes.body.ok).toBe(true)
    expect(canonicalRes.body.resultDocUrl.replace(canonical.r.requestNo, ':no'))
      .toBe(aliasRes.body.resultDocUrl.replace(alias.r.requestNo, ':no'))
    expect(canonicalRes.body.pdfUrl.replace(canonical.r.requestNo, ':no'))
      .toBe(aliasRes.body.pdfUrl.replace(alias.r.requestNo, ':no'))

    const canonicalFresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: canonical.r.requestNo } })
    const aliasFresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: alias.r.requestNo } })
    expect(canonicalFresh!.status).toBe('SIGNING')
    expect(aliasFresh!.status).toBe('SIGNING')
    expect(Boolean(canonicalFresh!.resultPdfPath)).toBe(Boolean(aliasFresh!.resultPdfPath))
  })

  it('download-result-doc 与 download-result-pdf alias 均可下载同一 Word 确认件', async () => {
    const a = await createUser({ role: 'admin' })
    const { r } = await setupVoted(a.id)
    const gen = await postGenerateResultDoc(r.requestNo, a.id)
    expect(gen.status).toBe(200)
    const beforeLogCount = await prisma.expertVoteSignLog.count({ where: { requestId: r.id } })

    const canonical = await request(app)
      .get(`/api/admin/expert-votes/${r.requestNo}/download-result-doc`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    const alias = await request(app)
      .get(`/api/admin/expert-votes/${r.requestNo}/download-result-pdf`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)

    expect(canonical.status).toBe(200)
    expect(alias.status).toBe(200)
    expect(canonical.headers['content-disposition']).toContain('.docx')
    expect(alias.headers['content-disposition']).toContain('.docx')
    expect(canonical.headers['content-type']).toBe(alias.headers['content-type'])
    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.status).toBe('SIGNING')
    const afterLogCount = await prisma.expertVoteSignLog.count({ where: { requestId: r.id } })
    expect(afterLogCount).toBe(beforeLogCount)
  })

  it('非 VOTED 拒绝 → 409', async () => {
    const a = await createUser({ role: 'admin' })
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'MEETING_SCHEDULED' })
    const res = await postGenerateResultDoc(r.requestNo, a.id)
    expect(res.status).toBe(409)
  })
})

// ═════════════════════════════════════════════════════════════
// 5. generate-final-deliverable (Path A，默认关闭)
// ═════════════════════════════════════════════════════════════
describe('POST /api/admin/expert-votes/:no/generate-final-deliverable', () => {
  it('flag=false 时返回 403 + 本功能暂未开放', async () => {
    const a = await createUser({ role: 'admin' })
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'SIGNING' })
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/generate-final-deliverable`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: '本功能暂未开放' })
    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.status).toBe('SIGNING')
    expect(fresh!.finalDeliverablePath).toBeNull()
    const log = await prisma.expertVoteSignLog.findFirst({
      where: { requestId: r.id, action: 'GENERATE_FINAL_DELIVERABLE' },
    })
    expect(log).toBeNull()
  })

  it('flag=true 时 SIGNING + resultPdfPath 存在 → COMPLETED + hash + 站内通知', async () => {
    await setPathAEnabled(true)
    const a = await createUser({ role: 'admin' })
    const u = await createUser()
    // 先准备一个 VOTED 状态并生成 Word 确认件，以拿到 resultPdfPath
    const r = await seedRequest(u.id, {
      status: 'VOTED',
      conclusion: 'PASS',
      voteResultJson: JSON.stringify({ PASS: 3, REJECT: 0, PASS_WITH_MOD: 0, ABSTAIN: 0, total: 3 }),
    })
    const aids = await seedExperts(r.id, 3)
    for (const aid of aids) {
      await prisma.expertVoteRecord.create({
        data: {
          requestId: r.id, assignmentId: aid,
          voteResult: 'PASS', reviewOpinion: '同意', agreeConclusion: 'YES',
          submittedBy: a.id, confirmFlag: true,
        },
      })
    }
    const gen = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/generate-result-doc`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(gen.status).toBe(200)

    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/generate-final-deliverable`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.deliveryMode).toBe('PLATFORM_GENERATED')
    expect(res.body.sha256).toMatch(/^[a-f0-9]{64}$/)

    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.status).toBe('COMPLETED')
    expect(fresh!.deliveryMode).toBe('PLATFORM_GENERATED')
    expect(fresh!.finalDeliverablePath).toBeTruthy()
    expect(fresh!.finalDeliverableHash).toMatch(/^[a-f0-9]{64}$/)
    // 双写：旧字段同步
    expect(fresh!.signedPdfPath).toBe(fresh!.finalDeliverablePath)
    expect(fresh!.signedPdfHash).toBe(fresh!.finalDeliverableHash)

    const notif = await prisma.notification.findFirst({
      where: { userId: u.id, type: 'EXPERT_VOTE' },
      orderBy: { createdAt: 'desc' },
    })
    expect(notif).not.toBeNull()
    expect(notif!.title).toContain('确认文件')
  })

  it('非 SIGNING 拒绝 → 409', async () => {
    await setPathAEnabled(true)
    const a = await createUser({ role: 'admin' })
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'VOTED' })
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/generate-final-deliverable`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(409)
  })

  it('SIGNING 但缺 resultDocxPath/resultPdfPath → 400', async () => {
    await setPathAEnabled(true)
    const a = await createUser({ role: 'admin' })
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'SIGNING' })
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/generate-final-deliverable`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/确认文件/)
  })
})

// ═════════════════════════════════════════════════════════════
// 6. upload-final-deliverable (Path B)
// ═════════════════════════════════════════════════════════════
describe('POST /api/admin/expert-votes/:no/upload-final-deliverable', () => {
  it('SIGNING → COMPLETED + OFFLINE_UPLOAD + hash', async () => {
    const a = await createUser({ role: 'admin' })
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'SIGNING' })
    const buf = Buffer.from('PDF mock content here')
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/upload-final-deliverable`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .attach('file', buf, { filename: 'final.pdf', contentType: 'application/pdf' })
    expect(res.status).toBe(200)
    expect(res.body.deliveryMode).toBe('OFFLINE_UPLOAD')
    expect(res.body.sha256).toMatch(/^[a-f0-9]{64}$/)
    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.status).toBe('COMPLETED')
    expect(fresh!.deliveryMode).toBe('OFFLINE_UPLOAD')
    expect(fresh!.finalDeliverablePath).toBeTruthy()
    expect(existsSync(fresh!.finalDeliverablePath!)).toBe(true)
    const att = await prisma.expertVoteAttachment.findFirst({
      where: { requestId: r.id, category: 'FINAL_DELIVERABLE' },
    })
    expect(att).not.toBeNull()
  })

  it('非 SIGNING 拒绝 → 409', async () => {
    const a = await createUser({ role: 'admin' })
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'VOTED' })
    const buf = Buffer.from('x')
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/upload-final-deliverable`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .attach('file', buf, { filename: 'final.pdf', contentType: 'application/pdf' })
    expect(res.status).toBe(409)
  })

  it('旧别名 upload-signed-pdf 仍走同一 handler', async () => {
    const a = await createUser({ role: 'admin' })
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'SIGNING' })
    const buf = Buffer.from('legacy alias content')
    const res = await request(app)
      .post(`/api/admin/expert-votes/${r.requestNo}/upload-signed-pdf`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .attach('file', buf, { filename: 'final.pdf', contentType: 'application/pdf' })
    expect(res.status).toBe(200)
    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
    expect(fresh!.status).toBe('COMPLETED')
    expect(fresh!.deliveryMode).toBe('OFFLINE_UPLOAD')
  })
})

// ═════════════════════════════════════════════════════════════
// 7. experts/:aid/notify
// ═════════════════════════════════════════════════════════════
describe('PATCH /api/admin/expert-votes/:no/experts/:aid/notify', () => {
  it('行级标记 notifiedAt + notifiedBy', async () => {
    const a = await createUser({ role: 'admin' })
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'EXPERT_ARRANGING' })
    const [aid] = await seedExperts(r.id, 1)
    const res = await request(app)
      .patch(`/api/admin/expert-votes/${r.requestNo}/experts/${aid}/notify`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.notifiedBy).toBe(a.id)
    const fresh = await prisma.expertAssignment.findUnique({ where: { id: aid } })
    expect(fresh!.notifiedAt).not.toBeNull()
  })

  it('aid 不属于此申请 → 404', async () => {
    const a = await createUser({ role: 'admin' })
    const u1 = await createUser()
    const u2 = await createUser()
    const r1 = await seedRequest(u1.id)
    const r2 = await seedRequest(u2.id)
    const [aidR2] = await seedExperts(r2.id, 1)
    const res = await request(app)
      .patch(`/api/admin/expert-votes/${r1.requestNo}/experts/${aidR2}/notify`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
      .send({})
    expect(res.status).toBe(404)
  })
})

// ═════════════════════════════════════════════════════════════
// 8. sign-logs
// ═════════════════════════════════════════════════════════════
describe('GET /api/admin/expert-votes/:no/sign-logs', () => {
  it('返回该申请所有 ExpertVoteSignLog（按 createdAt desc）', async () => {
    const a = await createUser({ role: 'admin' })
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'SIGNING' })
    await prisma.expertVoteSignLog.create({
      data: { requestId: r.id, action: 'GENERATE_PDF', operatorId: a.id, payloadJson: '{}' },
    })
    // 同 ms 时 createdAt desc 排序不稳定（PG TIMESTAMPTZ(3) ms 精度），sleep 让两条记录错开
    await new Promise((resolve) => setTimeout(resolve, 5))
    await prisma.expertVoteSignLog.create({
      data: { requestId: r.id, action: 'UPLOAD_SIGNATURE_MATERIAL', operatorId: a.id, payloadJson: '{}' },
    })
    const res = await request(app)
      .get(`/api/admin/expert-votes/${r.requestNo}/sign-logs`)
      .set('Authorization', `Bearer ${getTestToken(a.id, 'admin')}`)
    expect(res.status).toBe(200)
    expect(res.body.items.length).toBe(2)
    expect(res.body.items[0].action).toBe('UPLOAD_SIGNATURE_MATERIAL')
  })
})

// ═════════════════════════════════════════════════════════════
// 9. 用户端 download-final 鉴权
// ═════════════════════════════════════════════════════════════
describe('GET /api/app/expert-votes/:no/download-final', () => {
  async function setupCompleted() {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'COMPLETED' })
    // 写入一个真实文件
    const dir = `${process.cwd()}/uploads/expert-votes/${r.requestNo}`
    const { mkdirSync, writeFileSync } = await import('fs')
    mkdirSync(dir, { recursive: true })
    const fpath = `${dir}/final-test.pdf`
    writeFileSync(fpath, 'final-pdf-content')
    await prisma.expertVoteRequest.update({
      where: { id: r.id },
      data: {
        finalDeliverablePath: fpath,
        finalDeliverableHash: 'a'.repeat(64),
        deliveryMode: 'OFFLINE_UPLOAD',
        signedPdfPath: fpath,
      },
    })
    return { user: u, r, fpath }
  }

  it('owner 200 返回文件', async () => {
    const { user, r } = await setupCompleted()
    const res = await request(app)
      .get(`/api/app/expert-votes/${r.requestNo}/download-final`)
      .set('Authorization', `Bearer ${getTestToken(user.id)}`)
    expect(res.status).toBe(200)
    // supertest body 是 Buffer 时长度 > 0
    expect(res.body.length || (res as any).text?.length || 0).toBeGreaterThan(0)
  })

  it('非 owner 403', async () => {
    const { r } = await setupCompleted()
    const stranger = await createUser()
    const res = await request(app)
      .get(`/api/app/expert-votes/${r.requestNo}/download-final`)
      .set('Authorization', `Bearer ${getTestToken(stranger.id)}`)
    expect(res.status).toBe(403)
  })

  it('状态非 COMPLETED → 409', async () => {
    const u = await createUser()
    const r = await seedRequest(u.id, { status: 'SIGNING' })
    const res = await request(app)
      .get(`/api/app/expert-votes/${r.requestNo}/download-final`)
      .set('Authorization', `Bearer ${getTestToken(u.id)}`)
    expect(res.status).toBe(409)
  })

  it('旧别名 download-signed 行为一致', async () => {
    const { user, r } = await setupCompleted()
    const res = await request(app)
      .get(`/api/app/expert-votes/${r.requestNo}/download-signed`)
      .set('Authorization', `Bearer ${getTestToken(user.id)}`)
    expect(res.status).toBe(200)
  })
})
