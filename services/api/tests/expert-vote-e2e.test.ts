/**
 * 专家评审投票 — 完整状态机 E2E 测试
 *
 * 覆盖全流程 DRAFT → PAYING → EXPERT_ARRANGING → MEETING_SCHEDULED
 *          → VOTING → VOTED → SIGNING → COMPLETED
 *
 * 每个阶段验证：
 *   A. 当前状态下合法操作 → 成功
 *   B. 错误状态下操作 → 被守卫拒绝
 *   C. 跨用户 / 无权限 → 被鉴权拒绝
 *   D. 字段裁剪：用户端不暴露 tencentMeetingPwd / 服务器内部路径 / 操作员 userId（contactName/Phone 是申请人本人填写的联系信息，保留可见）
 *   E. 待处理 Tab：MEETING_SCHEDULED 出现在 pendingStatuses 列表
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import {
  EXPERT_VOTE_SETTING_KEYS,
  transitionStatus,
  ensureExpertVoteSettings,
  makeExpertVoteRequestNo,
} from '../src/services/expertVote.js'
import { registerExpertVoteRoutes } from '../src/expertVoteRoutes.js'
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
    projectName: 'E2E 全流程测试标准',
    targetName: 'T/E2E 0001-2026',
    projectType: '标准评审',
    standardType: '团体标准',
    standardStatus: '送审稿',
    industries: ['测试行业'],
    backgroundDesc: '全流程 E2E 测试用例，覆盖所有状态机节点。',
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
})

beforeEach(async () => {
  await cleanAll()
  await ensureExpertVoteSettings()
  await setPathAEnabled(false)
})

// ══════════════════════════════════════════════════════════════════════════════
// 完整状态机 E2E — 单一 describe 按顺序执行所有阶段
// ══════════════════════════════════════════════════════════════════════════════
describe('专家评审投票 完整状态机 E2E（用户端发起 → 管理后台全流程）', () => {

  // ─────────────────────────────────────────────
  // Phase 0：用户创建草稿
  // ─────────────────────────────────────────────
  describe('Phase 0: 草稿创建与编辑（DRAFT）', () => {
    it('未登录创建草稿 → 401', async () => {
      const res = await request(app).post('/api/app/expert-votes').send(draftPayload())
      expect(res.status).toBe(401)
    })

    it('用户创建草稿 → 200 + status=DRAFT + requestNo', async () => {
      const user = await createUser()
      const res = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('DRAFT')
      expect(res.body.requestNo).toMatch(/^EVR-/)
    })

    it('用户编辑草稿 → 200 + 字段已更新', async () => {
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      const no = create.body.requestNo

      const edit = await request(app)
        .patch(`/api/app/expert-votes/${no}`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload({ projectName: '修改后的标准名称' }))
      expect(edit.status).toBe(200)
      expect(edit.body.projectName).toBe('修改后的标准名称')
    })

    it('跨用户编辑草稿 → 403', async () => {
      const user = await createUser()
      const attacker = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      const no = create.body.requestNo

      const res = await request(app)
        .patch(`/api/app/expert-votes/${no}`)
        .set('Authorization', `Bearer ${getTestToken(attacker.id)}`)
        .send(draftPayload({ projectName: '攻击者改名' }))
      expect(res.status).toBe(403)
    })

    it('用户删除草稿 → 200；再次获取 → 404', async () => {
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      const no = create.body.requestNo

      const del = await request(app)
        .delete(`/api/app/expert-votes/${no}`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
      expect(del.status).toBe(200)

      const get = await request(app)
        .get(`/api/app/expert-votes/${no}`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
      expect(get.status).toBe(404)
    })

    it('用户端详情字段裁剪：保留申请人本人填写的 contactName / contactPhone；裁掉密码/内部路径/操作员 userId', async () => {
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload({ contactName: '王五', contactPhone: '13900009999' }))
      const no = create.body.requestNo

      const detail = await request(app)
        .get(`/api/app/expert-votes/${no}`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
      expect(detail.status).toBe(200)
      // 申请人本人需要看到自己填的联系信息（用于核对/编辑）
      expect(detail.body.contactName).toBe('王五')
      expect(detail.body.contactPhone).toBe('13900009999')
      // 但敏感/内部字段必须裁掉（PRD §10）
      expect(detail.body).not.toHaveProperty('tencentMeetingPwd')
      expect(detail.body).not.toHaveProperty('resultPdfPath')
      expect(detail.body).not.toHaveProperty('finalDeliverablePath')
      expect(detail.body).not.toHaveProperty('signedPdfPath')
      expect(detail.body).not.toHaveProperty('meetingArrangedBy')
      expect(detail.body).not.toHaveProperty('voteClosedBy')
      expect(detail.body).not.toHaveProperty('deliveredBy')
      expect(detail.body).not.toHaveProperty('signedBy')
      expect(detail.body).not.toHaveProperty('notifiedBy')
      expect(detail.body).not.toHaveProperty('notifiedAt')
    })
  })

  // ─────────────────────────────────────────────
  // Phase 1：用户提交 → PAYING
  // ─────────────────────────────────────────────
  describe('Phase 1: 用户提交（DRAFT → PAYING）', () => {
    it('提交草稿 → PAYING + AppOrder 生成', async () => {
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      const no = create.body.requestNo

      const submit = await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})
      expect(submit.status).toBe(200)
      expect(submit.body.request.status).toBe('PAYING')
      expect(submit.body.order).toBeTruthy()
      expect(submit.body.order.productType).toBe('EXPERT_VOTE')
    })

    it('非 DRAFT 状态提交 → 409', async () => {
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      const no = create.body.requestNo

      await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})

      // 再次提交（已是 PAYING）→ 409
      const retry = await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})
      expect(retry.status).toBe(409)
    })

    it('用户取消（PAYING → CANCELLED）', async () => {
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      const no = create.body.requestNo

      await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})

      const cancel = await request(app)
        .post(`/api/app/expert-votes/${no}/cancel`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})
      expect(cancel.status).toBe(200)
      expect(cancel.body.ok).toBe(true)
      // API 返回简洁 {ok:true}，状态变更通过 DB 复读校验
      const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: no } })
      expect(fresh!.status).toBe('CANCELLED')
      expect(fresh!.cancelReason).toBe('用户取消')
    })

    // 回归：apps/web/src/pages/expert-vote/new.tsx 早期 buildPayload 漏 contactName/contactPhone，
    // 草稿创建落库 null，提交时被 assertDraftSubmittable 拦下 → 必须返 400 提示具体缺哪个字段
    it('草稿缺 contactName（模拟前端 buildPayload 漏字段）→ submit 返回 400', async () => {
      const user = await createUser()
      // 用裸 payload 创建（不带 contactName），DB 落库 null
      const { contactName: _omit, ...payloadWithoutContactName } = draftPayload()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(payloadWithoutContactName)
      expect(create.status).toBe(200)
      const no = create.body.requestNo

      const submit = await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})
      expect(submit.status).toBe(400)
      expect(submit.body.error).toMatch('contactName')
    })

    it('草稿缺 contactPhone → submit 返回 400', async () => {
      const user = await createUser()
      const { contactPhone: _omit, ...payloadWithoutContactPhone } = draftPayload()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(payloadWithoutContactPhone)
      expect(create.status).toBe(200)
      const no = create.body.requestNo

      const submit = await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})
      expect(submit.status).toBe(400)
      expect(submit.body.error).toMatch('contactPhone')
    })
  })

  // ─────────────────────────────────────────────
  // Phase 2：支付完成 → EXPERT_ARRANGING
  // ─────────────────────────────────────────────
  describe('Phase 2: 支付完成（PAYING → EXPERT_ARRANGING）', () => {
    it('模拟支付回调：PAYING → EXPERT_ARRANGING', async () => {
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      const no = create.body.requestNo

      await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})

      const moved = await transitionStatus(prisma, no, 'PAYING', 'EXPERT_ARRANGING', {
        paidAt: new Date(),
      })
      expect(moved).toBe(true)

      const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: no } })
      expect(fresh!.status).toBe('EXPERT_ARRANGING')
      expect(fresh!.paidAt).not.toBeNull()
    })

    it('管理后台列表可见（status=EXPERT_ARRANGING）', async () => {
      const admin = await createUser({ role: 'admin' })
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      const no = create.body.requestNo

      await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})
      await transitionStatus(prisma, no, 'PAYING', 'EXPERT_ARRANGING', { paidAt: new Date() })

      const list = await request(app)
        .get('/api/admin/expert-votes?status=EXPERT_ARRANGING')
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      expect(list.status).toBe(200)
      expect(list.body.items.some((r: any) => r.requestNo === no)).toBe(true)
    })

    it('管理后台详情：contactName / contactPhone 可见（未裁剪）', async () => {
      const admin = await createUser({ role: 'admin' })
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload({ contactName: '张三', contactPhone: '13800001234' }))
      const no = create.body.requestNo

      await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})
      await transitionStatus(prisma, no, 'PAYING', 'EXPERT_ARRANGING', { paidAt: new Date() })

      const detail = await request(app)
        .get(`/api/admin/expert-votes/${no}`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      expect(detail.status).toBe(200)
      expect(detail.body.contactName).toBe('张三')
      expect(detail.body.contactPhone).toBe('13800001234')
    })
  })

  // ─────────────────────────────────────────────
  // Phase 3：管理后台录入专家 + 设置会议
  // ─────────────────────────────────────────────
  describe('Phase 3: 专家录入与会议设置（EXPERT_ARRANGING）', () => {
    async function setupArranging() {
      const admin = await createUser({ role: 'admin' })
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      const no = create.body.requestNo
      await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})
      await transitionStatus(prisma, no, 'PAYING', 'EXPERT_ARRANGING', { paidAt: new Date() })
      return { admin, user, no }
    }

    it('录入专家（PUT /experts）→ 200 + 返回专家列表', async () => {
      const { admin, no } = await setupArranging()
      const res = await request(app)
        .put(`/api/admin/expert-votes/${no}/experts`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          experts: [
            { expertName: '李教授', expertOrg: '清华大学', expertTitle: '教授' },
            { expertName: '王研究员', expertOrg: '中科院', expertTitle: '研究员' },
            { expertName: '陈工程师', expertOrg: '中国标准化研究院', expertTitle: '高级工程师' },
          ],
        })
      expect(res.status).toBe(200)
      expect(res.body.items.length).toBe(3)
    })

    it('专家数不足时 confirm-meeting → 400 提示专家名单不完整', async () => {
      const { admin, no } = await setupArranging()
      // 只录 1 个专家（需要 3 个）
      await request(app)
        .put(`/api/admin/expert-votes/${no}/experts`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({ experts: [{ expertName: '孤独专家', expertOrg: '某机构' }] })

      const confirm = await request(app)
        .post(`/api/admin/expert-votes/${no}/confirm-meeting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          meetingTitle: '评审会',
          meetingStartAt: isoAfterDays(20),
          meetingEndAt: isoAfterDays(20),
          tencentMeetingId: '123-456-789',
          tencentMeetingUrl: 'https://meeting.tencent.com/test',
        })
      expect(confirm.status).toBe(400)
      expect(confirm.body.error).toMatch(/专家/)
    })

    it('设置会议信息（PATCH /meeting）→ 200', async () => {
      const { admin, no } = await setupArranging()
      const res = await request(app)
        .patch(`/api/admin/expert-votes/${no}/meeting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          meetingTitle: '《E2E测试标准》专家评审会',
          meetingStartAt: isoAfterDays(20),
          meetingEndAt: isoAfterDays(20),
          tencentMeetingId: '888-888-888',
          tencentMeetingUrl: 'https://meeting.tencent.com/e2e',
          meetingHost: '李主持',
        })
      expect(res.status).toBe(200)
    })

    it('录满专家 + confirm-meeting → MEETING_SCHEDULED + 站内通知', async () => {
      const { admin, user, no } = await setupArranging()
      await request(app)
        .put(`/api/admin/expert-votes/${no}/experts`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          experts: [
            { expertName: '专家A', expertOrg: '机构A' },
            { expertName: '专家B', expertOrg: '机构B' },
            { expertName: '专家C', expertOrg: '机构C' },
          ],
        })

      const res = await request(app)
        .post(`/api/admin/expert-votes/${no}/confirm-meeting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          meetingTitle: '《E2E测试标准》专家评审会',
          meetingStartAt: isoAfterDays(20),
          meetingEndAt: isoAfterDays(20),
          tencentMeetingId: '888-888-888',
          tencentMeetingUrl: 'https://meeting.tencent.com/e2e',
        })
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('MEETING_SCHEDULED')

      // 站内通知已发
      const notif = await prisma.notification.findFirst({
        where: { userId: user.id, type: 'EXPERT_VOTE' },
        orderBy: { createdAt: 'desc' },
      })
      expect(notif).not.toBeNull()
      expect(notif!.title).toMatch(/会议/)
    })

    it('MEETING_SCHEDULED 出现在用户端待处理列表', async () => {
      const { admin, user, no } = await setupArranging()
      await request(app)
        .put(`/api/admin/expert-votes/${no}/experts`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          experts: [
            { expertName: '专家A', expertOrg: '机构A' },
            { expertName: '专家B', expertOrg: '机构B' },
            { expertName: '专家C', expertOrg: '机构C' },
          ],
        })
      await request(app)
        .post(`/api/admin/expert-votes/${no}/confirm-meeting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          meetingTitle: '评审会',
          meetingStartAt: isoAfterDays(20),
          meetingEndAt: isoAfterDays(20),
          tencentMeetingId: '888-888-888',
          tencentMeetingUrl: 'https://meeting.tencent.com/e2e',
        })

      const list = await request(app)
        .get('/api/app/expert-votes?tab=pending')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
      expect(list.status).toBe(200)
      expect(list.body.items.some((r: any) => r.requestNo === no)).toBe(true)
    })

    it('mark expert notified（行级通知标记）→ 200 + notifiedAt 写入', async () => {
      const { admin, no } = await setupArranging()
      const putRes = await request(app)
        .put(`/api/admin/expert-votes/${no}/experts`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          experts: [
            { expertName: '专家A', expertOrg: '机构A' },
            { expertName: '专家B', expertOrg: '机构B' },
            { expertName: '专家C', expertOrg: '机构C' },
          ],
        })
      const aid = putRes.body.items[0].id

      await request(app)
        .post(`/api/admin/expert-votes/${no}/confirm-meeting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          meetingTitle: '评审会',
          meetingStartAt: isoAfterDays(20),
          meetingEndAt: isoAfterDays(20),
          tencentMeetingId: '888-888-888',
          tencentMeetingUrl: 'https://meeting.tencent.com/e2e',
        })

      const notify = await request(app)
        .patch(`/api/admin/expert-votes/${no}/experts/${aid}/notify`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      expect(notify.status).toBe(200)
      expect(notify.body.notifiedBy).toBe(admin.id)

      const fresh = await prisma.expertAssignment.findUnique({ where: { id: aid } })
      expect(fresh!.notifiedAt).not.toBeNull()
    })

    it('普通用户无法访问管理后台接口 → 403', async () => {
      const { user, no } = await setupArranging()
      const res = await request(app)
        .put(`/api/admin/expert-votes/${no}/experts`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({ experts: [{ expertName: '越权专家' }] })
      expect(res.status).toBe(403)
    })
  })

  // ─────────────────────────────────────────────
  // Phase 4：会议已定 → 启动投票（VOTING）
  // ─────────────────────────────────────────────
  describe('Phase 4: 会后录入开始（MEETING_SCHEDULED → VOTING）', () => {
    async function setupMeetingScheduled() {
      const admin = await createUser({ role: 'admin' })
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      const no = create.body.requestNo
      await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})
      await transitionStatus(prisma, no, 'PAYING', 'EXPERT_ARRANGING', { paidAt: new Date() })
      const putRes = await request(app)
        .put(`/api/admin/expert-votes/${no}/experts`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          experts: [
            { expertName: '专家A', expertOrg: '机构A' },
            { expertName: '专家B', expertOrg: '机构B' },
            { expertName: '专家C', expertOrg: '机构C' },
          ],
        })
      const expertIds = putRes.body.items.map((e: any) => e.id)
      await request(app)
        .post(`/api/admin/expert-votes/${no}/confirm-meeting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          meetingTitle: '评审会',
          meetingStartAt: isoAfterDays(20),
          meetingEndAt: isoAfterDays(20),
          tencentMeetingId: '888-888-888',
          tencentMeetingUrl: 'https://meeting.tencent.com/e2e',
        })
      return { admin, user, no, expertIds }
    }

    it('start-voting → MEETING_SCHEDULED → VOTING + voteStartedAt 写入', async () => {
      const { admin, no } = await setupMeetingScheduled()
      const res = await request(app)
        .post(`/api/admin/expert-votes/${no}/start-voting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('VOTING')

      const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: no } })
      expect(fresh!.voteStartedAt).not.toBeNull()
    })

    it('非 MEETING_SCHEDULED 状态 start-voting → 409', async () => {
      const { admin, no } = await setupMeetingScheduled()
      // 先转到 VOTING
      await request(app)
        .post(`/api/admin/expert-votes/${no}/start-voting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      // 再次 start-voting → 409
      const res = await request(app)
        .post(`/api/admin/expert-votes/${no}/start-voting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      expect(res.status).toBe(409)
    })
  })

  // ─────────────────────────────────────────────
  // Phase 5：录入专家意见与投票结果（VOTING）
  // ─────────────────────────────────────────────
  describe('Phase 5: 录入投票结果（VOTING）', () => {
    async function setupVoting() {
      const admin = await createUser({ role: 'admin' })
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      const no = create.body.requestNo
      await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})
      await transitionStatus(prisma, no, 'PAYING', 'EXPERT_ARRANGING', { paidAt: new Date() })
      const putRes = await request(app)
        .put(`/api/admin/expert-votes/${no}/experts`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          experts: [
            { expertName: '专家A', expertOrg: '机构A' },
            { expertName: '专家B', expertOrg: '机构B' },
            { expertName: '专家C', expertOrg: '机构C' },
          ],
        })
      const expertIds = putRes.body.items.map((e: any) => e.id)
      await request(app)
        .post(`/api/admin/expert-votes/${no}/confirm-meeting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          meetingTitle: '评审会',
          meetingStartAt: isoAfterDays(20),
          meetingEndAt: isoAfterDays(20),
          tencentMeetingId: '888-888-888',
          tencentMeetingUrl: 'https://meeting.tencent.com/e2e',
        })
      await request(app)
        .post(`/api/admin/expert-votes/${no}/start-voting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      return { admin, user, no, expertIds }
    }

    it('PUT voting-results → 200 + upsert + 汇总写入', async () => {
      const { admin, no, expertIds } = await setupVoting()
      const res = await request(app)
        .put(`/api/admin/expert-votes/${no}/voting-results`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          conclusion: 'PASS',
          conclusionRemark: '专家组一致通过',
          votes: [
            { assignmentId: expertIds[0], voteResult: 'PASS', reviewOpinion: '标准内容完整，建议通过' },
            { assignmentId: expertIds[1], voteResult: 'PASS_WITH_MOD', reviewOpinion: '建议修改第3章', modificationSuggestion: '删除 §3.4.2 冗余条款' },
            { assignmentId: expertIds[2], voteResult: 'PASS', reviewOpinion: '同意，无异议' },
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

    it('投票结果保存后再次 GET 详情，votes 字段已回填', async () => {
      const { admin, no, expertIds } = await setupVoting()
      await request(app)
        .put(`/api/admin/expert-votes/${no}/voting-results`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          conclusion: 'PASS',
          votes: [
            { assignmentId: expertIds[0], voteResult: 'PASS', reviewOpinion: '通过' },
            { assignmentId: expertIds[1], voteResult: 'PASS', reviewOpinion: '通过' },
            { assignmentId: expertIds[2], voteResult: 'PASS', reviewOpinion: '通过' },
          ],
        })

      const detail = await request(app)
        .get(`/api/admin/expert-votes/${no}`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      expect(detail.status).toBe(200)
      expect(Array.isArray(detail.body.votes)).toBe(true)
      expect(detail.body.votes.length).toBe(3)
    })

    it('非法 assignmentId → 400', async () => {
      const { admin, no } = await setupVoting()
      const res = await request(app)
        .put(`/api/admin/expert-votes/${no}/voting-results`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          votes: [{ assignmentId: 'fake-id', voteResult: 'PASS', reviewOpinion: '...' }],
        })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/非法的 assignmentId/)
    })

    it('非 VOTING 状态录入结果 → 409', async () => {
      const admin = await createUser({ role: 'admin' })
      const user = await createUser()
      const r = await prisma.expertVoteRequest.create({
        data: {
          requestNo: makeExpertVoteRequestNo(),
          userId: user.id,
          status: 'MEETING_SCHEDULED',
          projectName: 'p', targetName: 't', projectType: '标准评审',
          standardType: '团体标准', standardStatus: '送审稿', backgroundDesc: '.',
          expertSourceType: 'PLATFORM', expertCount: 3,
          desiredDate: new Date(Date.now() + 20 * 86400_000),
          desiredSlot: 'AFTERNOON', acceptReschedule: true,
          unitPrice: 200000, totalAmount: 600000, paidAt: new Date(),
          meetingTitle: '评审会',
          meetingStartAt: new Date(Date.now() + 21 * 86400_000),
          meetingEndAt: new Date(Date.now() + 21 * 86400_000 + 3600_000),
          tencentMeetingId: '888-888-888',
          tencentMeetingUrl: 'https://meeting.tencent.com/test',
        },
      })
      const res = await request(app)
        .put(`/api/admin/expert-votes/${r.requestNo}/voting-results`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({ votes: [] })
      expect(res.status).toBe(409)
    })
  })

  // ─────────────────────────────────────────────
  // Phase 6：关闭投票（VOTING → VOTED）
  // ─────────────────────────────────────────────
  describe('Phase 6: 关闭投票（VOTING → VOTED）', () => {
    async function setupVotingWithResults() {
      const admin = await createUser({ role: 'admin' })
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      const no = create.body.requestNo
      await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})
      await transitionStatus(prisma, no, 'PAYING', 'EXPERT_ARRANGING', { paidAt: new Date() })
      const putRes = await request(app)
        .put(`/api/admin/expert-votes/${no}/experts`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          experts: [
            { expertName: '专家A', expertOrg: '机构A' },
            { expertName: '专家B', expertOrg: '机构B' },
            { expertName: '专家C', expertOrg: '机构C' },
          ],
        })
      const expertIds = putRes.body.items.map((e: any) => e.id)
      await request(app)
        .post(`/api/admin/expert-votes/${no}/confirm-meeting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          meetingTitle: '评审会',
          meetingStartAt: isoAfterDays(20),
          meetingEndAt: isoAfterDays(20),
          tencentMeetingId: '888-888-888',
          tencentMeetingUrl: 'https://meeting.tencent.com/e2e',
        })
      await request(app)
        .post(`/api/admin/expert-votes/${no}/start-voting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      await request(app)
        .put(`/api/admin/expert-votes/${no}/voting-results`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          conclusion: 'PASS',
          votes: expertIds.map((id: string) => ({
            assignmentId: id, voteResult: 'PASS', reviewOpinion: '同意通过',
          })),
        })
      return { admin, user, no, expertIds }
    }

    it('缺 conclusion 时 close-voting → 400', async () => {
      // 先录入但不带 conclusion
      const { admin, user, no, expertIds } = await setupVotingWithResults()
      // 把 conclusion 清掉
      await prisma.expertVoteRequest.update({
        where: { requestNo: no }, data: { conclusion: null },
      })
      const res = await request(app)
        .post(`/api/admin/expert-votes/${no}/close-voting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/最终结论/)
    })

    it('所有专家意见齐全 close-voting → VOTED + voteClosedAt 写入', async () => {
      const { admin, no } = await setupVotingWithResults()
      const res = await request(app)
        .post(`/api/admin/expert-votes/${no}/close-voting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('VOTED')

      const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: no } })
      expect(fresh!.voteClosedAt).not.toBeNull()
      expect(fresh!.voteClosedBy).toBe(admin.id)
    })
  })

  // ─────────────────────────────────────────────
  // Phase 7：生成 Word 确认文件（VOTED → SIGNING）
  // ─────────────────────────────────────────────
  describe('Phase 7: 生成 Word 确认文件（VOTED → SIGNING）', () => {
    async function setupVoted() {
      const admin = await createUser({ role: 'admin' })
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      const no = create.body.requestNo
      await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})
      await transitionStatus(prisma, no, 'PAYING', 'EXPERT_ARRANGING', { paidAt: new Date() })
      const putRes = await request(app)
        .put(`/api/admin/expert-votes/${no}/experts`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          experts: [
            { expertName: '专家A', expertOrg: '机构A' },
            { expertName: '专家B', expertOrg: '机构B' },
            { expertName: '专家C', expertOrg: '机构C' },
          ],
        })
      const expertIds = putRes.body.items.map((e: any) => e.id)
      await request(app)
        .post(`/api/admin/expert-votes/${no}/confirm-meeting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          meetingTitle: '评审会',
          meetingStartAt: isoAfterDays(20),
          meetingEndAt: isoAfterDays(20),
          tencentMeetingId: '888-888-888',
          tencentMeetingUrl: 'https://meeting.tencent.com/e2e',
        })
      await request(app)
        .post(`/api/admin/expert-votes/${no}/start-voting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      await request(app)
        .put(`/api/admin/expert-votes/${no}/voting-results`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          conclusion: 'PASS',
          votes: expertIds.map((id: string) => ({
            assignmentId: id, voteResult: 'PASS', reviewOpinion: '审查通过',
          })),
        })
      await request(app)
        .post(`/api/admin/expert-votes/${no}/close-voting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      return { admin, user, no }
    }

    it('generate-result-doc → VOTED → SIGNING + resultPdfPath 写入 + sign log', async () => {
      const { admin, no } = await setupVoted()
      const res = await request(app)
        .post(`/api/admin/expert-votes/${no}/generate-result-doc`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)

      const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: no } })
      expect(fresh!.status).toBe('SIGNING')
      expect(fresh!.resultPdfPath).toBeTruthy()

      const log = await prisma.expertVoteSignLog.findFirst({
        where: { requestId: fresh!.id, action: 'GENERATE_PDF' },
      })
      expect(log).not.toBeNull()
    })

    it('非 VOTED 状态 generate-result-doc → 409', async () => {
      const admin = await createUser({ role: 'admin' })
      const user = await createUser()
      const r = await prisma.expertVoteRequest.create({
        data: {
          requestNo: makeExpertVoteRequestNo(),
          userId: user.id,
          status: 'VOTING',
          projectName: 'p', targetName: 't', projectType: '标准评审',
          standardType: '团体标准', standardStatus: '送审稿', backgroundDesc: '.',
          expertSourceType: 'PLATFORM', expertCount: 3,
          desiredDate: new Date(Date.now() + 20 * 86400_000),
          desiredSlot: 'AFTERNOON', acceptReschedule: true,
          unitPrice: 200000, totalAmount: 600000, paidAt: new Date(),
          meetingTitle: '评审会',
          meetingStartAt: new Date(Date.now() + 21 * 86400_000),
          meetingEndAt: new Date(Date.now() + 21 * 86400_000 + 3600_000),
          tencentMeetingId: '888-888-888',
          tencentMeetingUrl: 'https://meeting.tencent.com/test',
        },
      })
      const res = await request(app)
        .post(`/api/admin/expert-votes/${r.requestNo}/generate-result-doc`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      expect(res.status).toBe(409)
    })
  })

  // ─────────────────────────────────────────────
  // Phase 8：交付（SIGNING → COMPLETED）路径二：上传 PDF
  // ─────────────────────────────────────────────
  describe('Phase 8A: 线下上传最终 PDF（SIGNING → COMPLETED）', () => {
    async function setupSigning() {
      const admin = await createUser({ role: 'admin' })
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      const no = create.body.requestNo
      await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})
      await transitionStatus(prisma, no, 'PAYING', 'EXPERT_ARRANGING', { paidAt: new Date() })
      const putRes = await request(app)
        .put(`/api/admin/expert-votes/${no}/experts`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          experts: [
            { expertName: '专家A', expertOrg: '机构A' },
            { expertName: '专家B', expertOrg: '机构B' },
            { expertName: '专家C', expertOrg: '机构C' },
          ],
        })
      const expertIds = putRes.body.items.map((e: any) => e.id)
      await request(app)
        .post(`/api/admin/expert-votes/${no}/confirm-meeting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          meetingTitle: '评审会',
          meetingStartAt: isoAfterDays(20),
          meetingEndAt: isoAfterDays(20),
          tencentMeetingId: '888-888-888',
          tencentMeetingUrl: 'https://meeting.tencent.com/e2e',
        })
      await request(app)
        .post(`/api/admin/expert-votes/${no}/start-voting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      await request(app)
        .put(`/api/admin/expert-votes/${no}/voting-results`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          conclusion: 'PASS',
          votes: expertIds.map((id: string) => ({
            assignmentId: id, voteResult: 'PASS', reviewOpinion: '审查通过',
          })),
        })
      await request(app)
        .post(`/api/admin/expert-votes/${no}/close-voting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      await request(app)
        .post(`/api/admin/expert-votes/${no}/generate-result-doc`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      return { admin, user, no }
    }

    it('upload-final-deliverable → SIGNING → COMPLETED + OFFLINE_UPLOAD + hash', async () => {
      const { admin, no } = await setupSigning()
      const buf = Buffer.from('%PDF-1.4 mock final deliverable content for E2E test')
      const res = await request(app)
        .post(`/api/admin/expert-votes/${no}/upload-final-deliverable`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .attach('file', buf, { filename: 'final-signed.pdf', contentType: 'application/pdf' })
      expect(res.status).toBe(200)
      expect(res.body.deliveryMode).toBe('OFFLINE_UPLOAD')
      expect(res.body.sha256).toMatch(/^[a-f0-9]{64}$/)

      const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: no } })
      expect(fresh!.status).toBe('COMPLETED')
      expect(fresh!.finalDeliverablePath).toBeTruthy()
      expect(fresh!.finalDeliverableHash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('非 SIGNING 上传 → 409', async () => {
      const admin = await createUser({ role: 'admin' })
      const user = await createUser()
      const r = await prisma.expertVoteRequest.create({
        data: {
          requestNo: makeExpertVoteRequestNo(),
          userId: user.id,
          status: 'VOTED',
          projectName: 'p', targetName: 't', projectType: '标准评审',
          standardType: '团体标准', standardStatus: '送审稿', backgroundDesc: '.',
          expertSourceType: 'PLATFORM', expertCount: 3,
          desiredDate: new Date(Date.now() + 20 * 86400_000),
          desiredSlot: 'AFTERNOON', acceptReschedule: true,
          unitPrice: 200000, totalAmount: 600000, paidAt: new Date(),
          meetingTitle: '评审会',
          meetingStartAt: new Date(Date.now() + 21 * 86400_000),
          meetingEndAt: new Date(Date.now() + 21 * 86400_000 + 3600_000),
          tencentMeetingId: '888-888-888',
          tencentMeetingUrl: 'https://meeting.tencent.com/test',
        },
      })
      const buf = Buffer.from('x')
      const res = await request(app)
        .post(`/api/admin/expert-votes/${r.requestNo}/upload-final-deliverable`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .attach('file', buf, { filename: 'f.pdf', contentType: 'application/pdf' })
      expect(res.status).toBe(409)
    })
  })

  // ─────────────────────────────────────────────
  // Phase 8B：Path A 平台内生成（默认关闭；测试显式打开）
  // ─────────────────────────────────────────────
  describe('Phase 8B: Path A 平台内生成最终交付文件（SIGNING → COMPLETED）', () => {
    it('flag=true 时 generate-final-deliverable → COMPLETED + PLATFORM_GENERATED + 站内通知', async () => {
      await setPathAEnabled(true)
      const admin = await createUser({ role: 'admin' })
      const user = await createUser()

      // 直接构造 VOTED 状态并生成 docx
      const r = await prisma.expertVoteRequest.create({
        data: {
          requestNo: makeExpertVoteRequestNo(),
          userId: user.id,
          status: 'VOTED',
          projectName: 'E2E Path A 测试',
          targetName: 'T/E2E Path A',
          projectType: '标准评审',
          standardType: '团体标准',
          standardStatus: '送审稿',
          backgroundDesc: '...',
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
          conclusion: 'PASS',
          voteResultJson: JSON.stringify({ PASS: 3, REJECT: 0, PASS_WITH_MOD: 0, ABSTAIN: 0, total: 3 }),
        },
      })
      const experts = await Promise.all([1, 2, 3].map((i) =>
        prisma.expertAssignment.create({
          data: { requestId: r.id, expertName: `专家${i}`, expertOrg: `机构${i}` },
        })
      ))
      for (const e of experts) {
        await prisma.expertVoteRecord.create({
          data: {
            requestId: r.id,
            assignmentId: e.id,
            voteResult: 'PASS',
            reviewOpinion: '同意',
            agreeConclusion: 'YES',
            submittedBy: admin.id,
            confirmFlag: true,
          },
        })
      }

      // generate-result-doc → SIGNING
      const gen = await request(app)
        .post(`/api/admin/expert-votes/${r.requestNo}/generate-result-doc`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      expect(gen.status).toBe(200)

      // generate-final-deliverable → COMPLETED
      const final = await request(app)
        .post(`/api/admin/expert-votes/${r.requestNo}/generate-final-deliverable`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      expect(final.status).toBe(200)
      expect(final.body.deliveryMode).toBe('PLATFORM_GENERATED')
      expect(final.body.sha256).toMatch(/^[a-f0-9]{64}$/)

      const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo: r.requestNo } })
      expect(fresh!.status).toBe('COMPLETED')

      // 站内通知
      const notif = await prisma.notification.findFirst({
        where: { userId: user.id, type: 'EXPERT_VOTE' },
        orderBy: { createdAt: 'desc' },
      })
      expect(notif).not.toBeNull()
    })
  })

  // ─────────────────────────────────────────────
  // Phase 9：COMPLETED — 用户端下载 + sign-logs + 操作记录
  // ─────────────────────────────────────────────
  describe('Phase 9: COMPLETED — 用户下载与操作记录', () => {
    async function setupCompleted() {
      const admin = await createUser({ role: 'admin' })
      const user = await createUser()
      const create = await request(app)
        .post('/api/app/expert-votes')
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send(draftPayload())
      const no = create.body.requestNo
      await request(app)
        .post(`/api/app/expert-votes/${no}/submit`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
        .send({})
      await transitionStatus(prisma, no, 'PAYING', 'EXPERT_ARRANGING', { paidAt: new Date() })
      const putRes = await request(app)
        .put(`/api/admin/expert-votes/${no}/experts`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          experts: [
            { expertName: '专家A', expertOrg: '机构A' },
            { expertName: '专家B', expertOrg: '机构B' },
            { expertName: '专家C', expertOrg: '机构C' },
          ],
        })
      const expertIds = putRes.body.items.map((e: any) => e.id)
      await request(app)
        .post(`/api/admin/expert-votes/${no}/confirm-meeting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          meetingTitle: '评审会',
          meetingStartAt: isoAfterDays(20),
          meetingEndAt: isoAfterDays(20),
          tencentMeetingId: '888-888-888',
          tencentMeetingUrl: 'https://meeting.tencent.com/e2e',
        })
      await request(app)
        .post(`/api/admin/expert-votes/${no}/start-voting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      await request(app)
        .put(`/api/admin/expert-votes/${no}/voting-results`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({
          conclusion: 'PASS',
          votes: expertIds.map((id: string) => ({
            assignmentId: id, voteResult: 'PASS', reviewOpinion: '审查通过',
          })),
        })
      await request(app)
        .post(`/api/admin/expert-votes/${no}/close-voting`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      await request(app)
        .post(`/api/admin/expert-votes/${no}/generate-result-doc`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .send({})
      const buf = Buffer.from('%PDF-1.4 signed final content')
      await request(app)
        .post(`/api/admin/expert-votes/${no}/upload-final-deliverable`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
        .attach('file', buf, { filename: 'final-signed.pdf', contentType: 'application/pdf' })
      return { admin, user, no }
    }

    it('用户端 GET 详情：状态为 COMPLETED', async () => {
      const { user, no } = await setupCompleted()
      const res = await request(app)
        .get(`/api/app/expert-votes/${no}`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('COMPLETED')
    })

    it('用户端下载最终交付文件 → 200 + 文件内容', async () => {
      const { user, no } = await setupCompleted()
      const res = await request(app)
        .get(`/api/app/expert-votes/${no}/download-final`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
      expect(res.status).toBe(200)
    })

    it('跨用户下载 → 403', async () => {
      const { no } = await setupCompleted()
      const stranger = await createUser()
      const res = await request(app)
        .get(`/api/app/expert-votes/${no}/download-final`)
        .set('Authorization', `Bearer ${getTestToken(stranger.id)}`)
      expect(res.status).toBe(403)
    })

    it('未完成状态下载 → 409', async () => {
      const user = await createUser()
      const r = await prisma.expertVoteRequest.create({
        data: {
          requestNo: makeExpertVoteRequestNo(),
          userId: user.id,
          status: 'SIGNING',
          projectName: 'p', targetName: 't', projectType: '标准评审',
          standardType: '团体标准', standardStatus: '送审稿', backgroundDesc: '.',
          expertSourceType: 'PLATFORM', expertCount: 3,
          desiredDate: new Date(Date.now() + 20 * 86400_000),
          desiredSlot: 'AFTERNOON', acceptReschedule: true,
          unitPrice: 200000, totalAmount: 600000, paidAt: new Date(),
          meetingTitle: '评审会',
          meetingStartAt: new Date(Date.now() + 21 * 86400_000),
          meetingEndAt: new Date(Date.now() + 21 * 86400_000 + 3600_000),
          tencentMeetingId: '888-888-888',
          tencentMeetingUrl: 'https://meeting.tencent.com/test',
        },
      })
      const res = await request(app)
        .get(`/api/app/expert-votes/${r.requestNo}/download-final`)
        .set('Authorization', `Bearer ${getTestToken(user.id)}`)
      expect(res.status).toBe(409)
    })

    it('GET sign-logs → 包含 GENERATE_PDF + UPLOAD_FINAL_DELIVERABLE 两条记录', async () => {
      const { admin, no } = await setupCompleted()
      const res = await request(app)
        .get(`/api/admin/expert-votes/${no}/sign-logs`)
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      expect(res.status).toBe(200)
      const actions = res.body.items.map((l: any) => l.action)
      expect(actions).toContain('GENERATE_PDF')
      expect(actions).toContain('UPLOAD_FINAL_DELIVERABLE')
    })

    it('管理后台列表按 status=COMPLETED 可查到该申请', async () => {
      const { admin, no } = await setupCompleted()
      const res = await request(app)
        .get('/api/admin/expert-votes?status=COMPLETED')
        .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      expect(res.status).toBe(200)
      expect(res.body.items.some((r: any) => r.requestNo === no)).toBe(true)
    })
  })
})
