/**
 * standard-execution 完整闭环 E2E 回归测试
 *
 * 覆盖 doc §十四 验收 1-21 项可自动化部分：
 *   完整业务链路：来源 → 解析 → 启用 → 任务 → 提交 → 驳回 → 重提 → 通过 → 记录 → 材料包 → 作废 → 重生成 → 风险 → Dashboard
 *
 * Phase 分段（便于 CI 报错定位）：
 *   Phase 1: 来源 + 规则解析
 *   Phase 2: 要求项启用 + 任务创建发布
 *   Phase 3: 员工提交 + 审核驳回 + 重提
 *   Phase 4: 审核通过 → 记录池 + Task COMPLETED
 *   Phase 5: 材料包 + Record 作废 + 重新生成
 *   Phase 6: 风险 + Dashboard 全量断言
 *
 * 额外覆盖：
 *   - DRAFT 要求项不允许创建任务（doc 验收 3）
 *   - enterpriseId 隔离
 *   - 跨模块状态一致性（assignee.status 在 list/detail/review 各处一致）
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { existsSync, rmSync } from 'fs'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerStandardExecutionRoutes } from '../src/standard-execution/sourceRoutes.js'
import { STANDARD_EXECUTION_UPLOAD_DIR } from '../src/standard-execution/mpSubmitRoutes.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionRoutes(app)
})

beforeEach(async () => {
  await cleanStandardExecutionData()
})

afterAll(() => {
  if (existsSync(STANDARD_EXECUTION_UPLOAD_DIR)) {
    rmSync(STANDARD_EXECUTION_UPLOAD_DIR, { recursive: true, force: true })
  }
})

describe('standard-execution E2E — doc §十四 验收闭环', () => {
  it('25 步完整业务闭环全跑通', async () => {
    // ─── Phase 1: 来源 + 规则解析 ─────────────────────
    const admin = await createUser({ role: 'admin' })
    const reviewer = await createUser({ role: 'user' })
    const empA = await createUser({ role: 'user' })
    const empB = await createUser({ role: 'user' })
    const adminToken = getTestToken(admin.id, 'admin')
    const reviewerToken = getTestToken(reviewer.id, 'user', { enterpriseId: 'DEFAULT' })
    const empAToken = getTestToken(empA.id, 'user', { enterpriseId: 'DEFAULT' })
    const empBToken = getTestToken(empB.id, 'user', { enterpriseId: 'DEFAULT' })

    // step 1: admin 新建标准来源 + rawText（含 3 条带强约束词的条款）
    const rawText = `
5.1.1 消防器材应每月定期检查一次，记录留存不少于3年
5.1.2 操作人员必须经过培训后上岗
5.1.3 设备说明（仅说明，无约束动作）
5.1.4 应定期对应急通道进行检查并归档
`
    const sourceRes = await request(app)
      .post('/api/admin/standard-execution/sources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'GB/T 测试标准', sourceType: 'PRODUCT_STANDARD', sourceNo: 'GB-TEST-001', rawText })
    expect(sourceRes.status).toBe(201)
    const sourceId = sourceRes.body.data.id

    // step 2: 调用规则解析，生成 REVIEW_PENDING 要求项
    const parseRes = await request(app)
      .post('/api/admin/standard-execution/requirements/auto-generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ sourceId, parseMode: 'RULE' })
    expect(parseRes.status).toBe(200)
    expect(parseRes.body.data.parseMode).toBe('RULE')
    expect(parseRes.body.data.createdCount).toBeGreaterThanOrEqual(2) // 至少 5.1.1 / 5.1.2 / 5.1.4 命中强约束词

    const draftReqs = await prisma.standardExecutionRequirement.findMany({
      where: { sourceId, status: 'REVIEW_PENDING' },
    })
    expect(draftReqs.length).toBeGreaterThanOrEqual(2)
    const targetReq = draftReqs[0]

    // ─── Phase 2: 要求项启用 + 任务创建发布 ──────────────
    // step 3: 待审核要求项尝试创建任务 → 400
    const taskOnDraftRes = await request(app)
      .post('/api/admin/standard-execution/tasks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        requirementId: targetReq.id,
        title: 't1',
        submitRequirement: '提交照片',
        deadlineAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [empA.id, empB.id],
      })
    expect(taskOnDraftRes.status).toBe(400)
    expect(taskOnDraftRes.body.error).toContain('ACTIVE')

    // step 4: activate 要求项
    const activateRes = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${targetReq.id}/activate`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(activateRes.status).toBe(200)
    expect(activateRes.body.data.status).toBe('ACTIVE')

    // step 5: 从 ACTIVE 创建任务（含 2 个 assignee）
    const taskRes = await request(app)
      .post('/api/admin/standard-execution/tasks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        requirementId: targetReq.id,
        title: '消防器材月度巡检',
        description: '本月对所有消防器材进行巡检',
        submitRequirement: '提交检查照片 + 文字说明',
        deadlineAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [empA.id, empB.id],
      })
    expect(taskRes.status).toBe(201)
    expect(taskRes.body.data.status).toBe('DRAFT')
    const taskId = taskRes.body.data.id

    const hiddenBeforeApproval = await request(app)
      .get('/api/app/standard-execution/tasks?tab=todo')
      .set('Authorization', `Bearer ${empAToken}`)
    expect(hiddenBeforeApproval.status).toBe(200)
    expect(hiddenBeforeApproval.body.data.length).toBe(0)

    // step 6: 提交任务审核 + 审核通过，下发后验证 publishedAt
    const submitApprovalRes = await request(app)
      .post(`/api/admin/standard-execution/tasks/${taskId}/submit-approval`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(submitApprovalRes.status).toBe(200)
    expect(submitApprovalRes.body.data.status).toBe('PENDING_APPROVAL')
    const approveTaskRes = await request(app)
      .post(`/api/admin/standard-execution/tasks/${taskId}/approval/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(approveTaskRes.status).toBe(200)
    expect(approveTaskRes.body.data.status).toBe('PUBLISHED')
    expect(approveTaskRes.body.data.publishedAt).toBeTruthy()

    // ─── Phase 3: 员工提交 + 审核驳回 + 重提 ───────────
    // step 7: 员工 A 调 list → 看见任务在 todo Tab
    const empAListRes = await request(app)
      .get('/api/app/standard-execution/tasks?tab=todo')
      .set('Authorization', `Bearer ${empAToken}`)
    expect(empAListRes.status).toBe(200)
    expect(empAListRes.body.data.length).toBe(1)
    expect(empAListRes.body.data[0].task.id).toBe(taskId)

    // step 8: 员工 A view（PENDING → IN_PROGRESS）+ upload + submit
    await request(app)
      .post(`/api/app/standard-execution/tasks/${taskId}/view`)
      .set('Authorization', `Bearer ${empAToken}`)

    const uploadRes = await request(app)
      .post(`/api/app/standard-execution/tasks/${taskId}/upload`)
      .set('Authorization', `Bearer ${empAToken}`)
      .attach('file', Buffer.from('fake jpg content'), { filename: 'evidence.jpg', contentType: 'image/jpeg' })
    expect(uploadRes.status).toBe(200)
    const att1 = uploadRes.body.data

    const submitV1Res = await request(app)
      .post(`/api/app/standard-execution/tasks/${taskId}/submit`)
      .set('Authorization', `Bearer ${empAToken}`)
      .send({
        submitText: '员工A首次提交：本月已巡检消防器材 20 件，全部正常',
        attachments: [att1],
      })
    expect(submitV1Res.status).toBe(201)
    expect(submitV1Res.body.data.version).toBe(1)
    expect(submitV1Res.body.data.isLatest).toBe(true)
    expect(submitV1Res.body.data.status).toBe('SUBMITTED')
    const subV1Id = submitV1Res.body.data.id

    // 验证 Attachment + Assignee 状态
    const submitV1Attachments = await prisma.standardExecutionAttachment.findMany({ where: { bizId: subV1Id } })
    expect(submitV1Attachments.length).toBe(1)
    const empAAssigneeAfterSubmit = await prisma.standardExecutionTaskAssignee.findFirst({ where: { taskId, assigneeId: empA.id } })
    expect(empAAssigneeAfterSubmit?.status).toBe('PENDING_REVIEW')

    // step 9: reviewer 调 reviews list（scope=mine）看到员工 A 待审
    const reviewListRes = await request(app)
      .get('/api/admin/standard-execution/reviews?scope=mine')
      .set('Authorization', `Bearer ${reviewerToken}`)
    expect(reviewListRes.status).toBe(200)
    expect(reviewListRes.body.data.length).toBe(1)
    expect(reviewListRes.body.data[0].submission.id).toBe(subV1Id)
    // 跨模块一致性：assignee.status 在 list 里也是 PENDING_REVIEW
    expect(reviewListRes.body.data[0].assignee.status).toBe('PENDING_REVIEW')

    // step 10: reviewer 驳回员工 A
    const rejectRes = await request(app)
      .post(`/api/admin/standard-execution/reviews/${subV1Id}/reject`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ reviewComment: '附件不清晰，请重新拍摄' })
    expect(rejectRes.status).toBe(200)
    const v1AfterReject = await prisma.standardExecutionSubmission.findUnique({ where: { id: subV1Id } })
    expect(v1AfterReject?.status).toBe('REJECTED')
    expect(v1AfterReject?.reviewComment).toContain('附件不清晰')
    const empAAfterReject = await prisma.standardExecutionTaskAssignee.findFirst({ where: { taskId, assigneeId: empA.id } })
    expect(empAAfterReject?.status).toBe('REJECTED')
    const rejectLogs = await prisma.standardExecutionReviewLog.findMany({ where: { submissionId: subV1Id } })
    expect(rejectLogs.length).toBe(1)
    expect(rejectLogs[0].action).toBe('REJECT')
    // 不写 Record
    const noRecordYet = await prisma.standardExecutionRecord.count({ where: { submissionId: subV1Id } })
    expect(noRecordYet).toBe(0)

    // step 11: 员工 A 重新提交
    const upload2Res = await request(app)
      .post(`/api/app/standard-execution/tasks/${taskId}/upload`)
      .set('Authorization', `Bearer ${empAToken}`)
      .attach('file', Buffer.from('clearer jpg'), { filename: 'evidence-v2.jpg', contentType: 'image/jpeg' })
    const att2 = upload2Res.body.data

    const submitV2Res = await request(app)
      .post(`/api/app/standard-execution/tasks/${taskId}/submit`)
      .set('Authorization', `Bearer ${empAToken}`)
      .send({
        submitText: '员工A第二次提交：附件已重新拍摄，画面清晰',
        attachments: [att2],
      })
    expect(submitV2Res.status).toBe(201)
    expect(submitV2Res.body.data.version).toBe(2)
    expect(submitV2Res.body.data.parentSubmissionId).toBe(subV1Id)
    expect(submitV2Res.body.data.isLatest).toBe(true)
    const subV2Id = submitV2Res.body.data.id

    // 旧 submission isLatest = false
    const oldV1 = await prisma.standardExecutionSubmission.findUnique({ where: { id: subV1Id } })
    expect(oldV1?.isLatest).toBe(false)
    // assignee 状态回到 PENDING_REVIEW
    const empAAfterReSubmit = await prisma.standardExecutionTaskAssignee.findFirst({ where: { taskId, assigneeId: empA.id } })
    expect(empAAfterReSubmit?.status).toBe('PENDING_REVIEW')

    // ─── Phase 4: 审核通过 → 记录池 + Task COMPLETED ──
    // step 12: reviewer 通过员工 A v2
    const approveAResRaw = await request(app)
      .post(`/api/admin/standard-execution/reviews/${subV2Id}/approve`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ reviewComment: '材料合格' })
    expect(approveAResRaw.status).toBe(200)
    expect(approveAResRaw.body.data.submission.status).toBe('APPROVED')
    // 单 assignee 完成时 task 还未 COMPLETED（员工 B 未交）
    expect(approveAResRaw.body.data.taskCompleted).toBe(false)
    const taskAfterA = await prisma.standardExecutionTask.findUnique({ where: { id: taskId } })
    expect(taskAfterA?.status).toBe('PUBLISHED')

    // 验证 Record 写入 + 追溯字段
    const recordA = await prisma.standardExecutionRecord.findFirst({ where: { submissionId: subV2Id } })
    expect(recordA).toBeTruthy()
    expect(recordA?.status).toBe('VALID')
    expect(recordA?.createdFrom).toBe('REVIEW_APPROVE')
    expect(recordA?.sourceId).toBe(sourceId)
    expect(recordA?.requirementId).toBe(targetReq.id)
    expect(recordA?.taskId).toBe(taskId)
    expect(recordA?.submissionId).toBe(subV2Id)
    expect(recordA?.assigneeId).toBe(empA.id)
    expect(recordA?.title).toBe('消防器材月度巡检') // 来自 task.title
    expect(recordA?.summary).toContain('员工A第二次提交')

    // step 13: 员工 B 提交并被通过 → task COMPLETED
    const uploadB = await request(app)
      .post(`/api/app/standard-execution/tasks/${taskId}/upload`)
      .set('Authorization', `Bearer ${empBToken}`)
      .attach('file', Buffer.from('B jpg'), { filename: 'b.jpg', contentType: 'image/jpeg' })
    const submitB = await request(app)
      .post(`/api/app/standard-execution/tasks/${taskId}/submit`)
      .set('Authorization', `Bearer ${empBToken}`)
      .send({ submitText: '员工B提交：完成巡检', attachments: [uploadB.body.data] })
    const subBId = submitB.body.data.id

    const approveBRes = await request(app)
      .post(`/api/admin/standard-execution/reviews/${subBId}/approve`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({})
    expect(approveBRes.body.data.taskCompleted).toBe(true)
    const taskAfterB = await prisma.standardExecutionTask.findUnique({ where: { id: taskId } })
    expect(taskAfterB?.status).toBe('COMPLETED')
    expect(taskAfterB?.completedAt).toBeTruthy()

    // step 14: admin records list 看见 2 条 VALID 记录
    const recordsRes = await request(app)
      .get('/api/admin/standard-execution/records')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(recordsRes.body.total).toBe(2)
    expect(recordsRes.body.data.every((r: { status: string }) => r.status === 'VALID')).toBe(true)
    const recordIds = recordsRes.body.data.map((r: { id: string }) => r.id)

    // ─── Phase 5: 材料包 + Record 作废 + 重新生成 ──────
    // step 15: admin 创建材料包 包含 2 条 record（DRAFT）
    const pkgRes = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: '客户审核材料包',
        packageScene: 'CUSTOMER_AUDIT',
        description: '本月巡检完整证据链',
        recordIds,
      })
    expect(pkgRes.status).toBe(201)
    expect(pkgRes.body.data.status).toBe('DRAFT')
    expect(pkgRes.body.data.hasInvalidRecord).toBe(false)
    const pkgId = pkgRes.body.data.id

    // step 16: Package get 树状目录 = 1 source → 1 requirement → 1 task → 2 submissions
    const treeRes = await request(app)
      .get(`/api/admin/standard-execution/packages/${pkgId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(treeRes.body.data.tree.length).toBe(1)
    expect(treeRes.body.data.tree[0].requirements.length).toBe(1)
    expect(treeRes.body.data.tree[0].requirements[0].tasks.length).toBe(1)
    const subsInTree = treeRes.body.data.tree[0].requirements[0].tasks[0].submissions
    expect(subsInTree.length).toBe(2)
    // reviewLogs 挂在 submission 节点（员工 A v2 有 APPROVE 日志）
    const empASubInTree = subsInTree.find((s: { record: { assigneeId: string } }) => s.record.assigneeId === empA.id)
    expect(empASubInTree.reviewLogs.length).toBeGreaterThanOrEqual(1)
    expect(empASubInTree.attachments.length).toBeGreaterThanOrEqual(1)

    // step 17: generate 材料包 DRAFT → READY + generatedAt
    const genRes = await request(app)
      .post(`/api/admin/standard-execution/packages/${pkgId}/generate`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(genRes.status).toBe(200)
    expect(genRes.body.data.status).toBe('READY')
    expect(genRes.body.data.generatedAt).toBeTruthy()
    const firstGenAt = new Date(genRes.body.data.generatedAt).getTime()

    // step 18: 作废其中一条 record → Package.hasInvalidRecord=true
    const voidRecRes = await request(app)
      .post(`/api/admin/standard-execution/records/${recordIds[0]}/void`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ voidReason: '材料过期' })
    expect(voidRecRes.status).toBe(200)
    expect(voidRecRes.body.data.status).toBe('VOID')
    expect(voidRecRes.body.affectedPackageIds).toContain(pkgId)
    const pkgAfterVoid = await prisma.standardExecutionPackage.findUnique({ where: { id: pkgId } })
    expect(pkgAfterVoid?.hasInvalidRecord).toBe(true)

    // step 19: 重新 generate（READY → READY，doc §五.6 重生成版本）
    await new Promise((r) => setTimeout(r, 10))
    const regenRes = await request(app)
      .post(`/api/admin/standard-execution/packages/${pkgId}/generate`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(regenRes.status).toBe(200)
    expect(regenRes.body.data.status).toBe('READY')
    const secondGenAt = new Date(regenRes.body.data.generatedAt).getTime()
    expect(secondGenAt).toBeGreaterThanOrEqual(firstGenAt)

    // ─── Phase 6: Dashboard + enterpriseId 隔离 ────────
    // step 20-21: dashboard 各 count 正确
    const dashRes = await request(app)
      .get('/api/admin/standard-execution/dashboard')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(dashRes.status).toBe(200)
    const c = dashRes.body.data.counts
    expect(c.sources).toBe(1)
    expect(c.requirementsActive).toBe(1)
    expect(c.tasksCompleted).toBe(1)
    expect(c.assigneesCompleted).toBe(2)
    expect(c.submissionsPending).toBe(0)
    expect(c.packagesReady).toBe(1)
    // Record：1 VALID + 1 VOID
    expect(c.records).toBe(2)
    expect(c.recordsValid).toBe(1)
    // recentTasks 包含已 COMPLETED 任务
    expect(dashRes.body.data.recentTasks.length).toBe(1)
    expect(dashRes.body.data.recentTasks[0].status).toBe('COMPLETED')

    // step 22: enterpriseId 隔离 — 用 prisma 直接造 OTHER 企业数据，admin 看不到
    const otherSrc = await prisma.standardExecutionSource.create({
      data: { enterpriseId: 'OTHER', title: 'other-source', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
    })
    const sourcesAfterOther = await request(app)
      .get('/api/admin/standard-execution/sources')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(sourcesAfterOther.body.total).toBe(1)
    expect(sourcesAfterOther.body.data[0].id).toBe(sourceId)
    expect(sourcesAfterOther.body.data[0].id).not.toBe(otherSrc.id)
  }, 60_000) // 长测，超时给 60s
})

// ─── 独立小测试：单独场景 ────────────────────────────

describe('standard-execution E2E — 独立场景断言', () => {
  it('DRAFT 任务对员工不可见（list + detail 都拦）', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const src = await prisma.standardExecutionSource.create({
      data: { enterpriseId: 'DEFAULT', title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
    })
    const req = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'r', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id },
    })
    const draftTask = await prisma.standardExecutionTask.create({
      data: { enterpriseId: 'DEFAULT', requirementId: req.id, title: 't', submitRequirement: 'x', deadlineAt: new Date(Date.now() + 86400000), reviewerId: admin.id, status: 'DRAFT', createdBy: admin.id },
    })
    await prisma.standardExecutionTaskAssignee.create({
      data: { enterpriseId: 'DEFAULT', taskId: draftTask.id, assigneeId: me.id, status: 'PENDING' },
    })

    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const listRes = await request(app).get('/api/app/standard-execution/tasks?tab=todo').set('Authorization', `Bearer ${token}`)
    expect(listRes.body.total).toBe(0)

    const detailRes = await request(app).get(`/api/app/standard-execution/tasks/${draftTask.id}`).set('Authorization', `Bearer ${token}`)
    expect(detailRes.status).toBe(404)
  })

  it('REVIEW_PENDING 风险触发（提交超 48h 未审）', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const src = await prisma.standardExecutionSource.create({
      data: { enterpriseId: 'DEFAULT', title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
    })
    const req = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'r', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id },
    })
    const task = await prisma.standardExecutionTask.create({
      data: { enterpriseId: 'DEFAULT', requirementId: req.id, title: 't', submitRequirement: 'x', deadlineAt: new Date(Date.now() + 86400000), reviewerId: admin.id, status: 'PUBLISHED', createdBy: admin.id },
    })
    await prisma.standardExecutionSubmission.create({
      data: {
        enterpriseId: 'DEFAULT', taskId: task.id, assigneeId: me.id, submitText: 'x',
        status: 'SUBMITTED', version: 1, isLatest: true,
        submittedAt: new Date(Date.now() - 50 * 3600 * 1000), // 50h ago
      },
    })

    const token = getTestToken(admin.id, 'admin')
    const r = await request(app).get('/api/admin/standard-execution/risks').set('Authorization', `Bearer ${token}`)
    const reviewPending = r.body.data.filter((x: { riskType: string }) => x.riskType === 'REVIEW_PENDING')
    expect(reviewPending.length).toBe(1)
    expect(reviewPending[0].riskLevel).toBe('MEDIUM')
  })

  it('跨企业 sourceId 创建任务 → 400', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const otherSrc = await prisma.standardExecutionSource.create({
      data: { enterpriseId: 'OTHER', title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
    })
    const otherReq = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'OTHER', sourceId: otherSrc.id, title: 'r', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id },
    })
    const token = getTestToken(admin.id, 'admin')
    const r = await request(app)
      .post('/api/admin/standard-execution/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        requirementId: otherReq.id,
        title: 't',
        submitRequirement: 'x',
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        reviewerId: admin.id,
        assigneeIds: [me.id],
      })
    expect(r.status).toBe(400)
  })
})
