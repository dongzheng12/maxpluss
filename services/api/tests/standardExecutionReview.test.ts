/**
 * standard-execution / 审核（approve / reject）— 完整事务测试
 *
 * 覆盖：
 *  - list:
 *      默认 status=SUBMITTED
 *      显式 status=APPROVED/REJECTED 过滤
 *      scope=mine 仅显示 task.reviewerId=me 的
 *      非 admin 用户自动限制 scope=mine
 *      enterpriseId 隔离
 *  - detail:
 *      admin 可看任意
 *      reviewer 可看自己的
 *      非 admin 非 reviewer → 403
 *      含 attachments + reviewLogs + assignee + canApprove
 *  - approve 事务：
 *      Submission APPROVED + reviewerId + reviewedAt
 *      Assignee COMPLETED + reviewedAt
 *      ReviewLog APPROVE 写入
 *      Record 写入：sourceId/requirementId/taskId/submissionId/assigneeId/title=task.title/summary≤200
 *      最后一个 assignee → Task COMPLETED + completedAt
 *      非最后一个 assignee → Task 保持 PUBLISHED
 *      reviewComment 透传
 *      recordTitle / recordSummary 覆盖默认
 *  - reject 事务：
 *      Submission REJECTED + reviewComment
 *      Assignee REJECTED
 *      ReviewLog REJECT 写入（comment 非空）
 *      Record 不写入
 *  - 状态机：
 *      APPROVED 再 approve → 409
 *      REJECTED 再 approve → 409
 *      非 latest submission → 409
 *  - 权限：
 *      admin approve ok
 *      reviewer approve ok
 *      其他用户 → 403
 *  - 边界：
 *      reject 缺 reviewComment → 400
 *      submissionId 不存在 → 404
 *      无 token → 401
 *  - 完整流程：员工提交 → 驳回 → 重新提交 → 通过 → Record 写入 + Task COMPLETED
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerStandardExecutionRoutes } from '../src/standard-execution/sourceRoutes.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionRoutes(app)
})

beforeEach(async () => {
  await cleanStandardExecutionData()
})

async function setupScene(opts: { assigneeCount?: number; reviewerIsAdmin?: boolean; enterpriseId?: string } = {}) {
  const enterpriseId = opts.enterpriseId ?? 'DEFAULT'
  const admin = await createUser({ role: 'admin' })
  const reviewer = opts.reviewerIsAdmin ? admin : await createUser({ role: 'user' })
  const assigneeCount = opts.assigneeCount ?? 1
  const assignees: { id: string; phone: string; passwordHash: string | null; role: string; email: string | null }[] = []
  for (let i = 0; i < assigneeCount; i++) {
    const u = await createUser({ role: 'user' })
    assignees.push(u)
  }

  const src = await prisma.standardExecutionSource.create({
    data: { enterpriseId, title: 'src', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
  })
  const req = await prisma.standardExecutionRequirement.create({
    data: { enterpriseId, sourceId: src.id, title: 'req', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id },
  })
  const task = await prisma.standardExecutionTask.create({
    data: {
      enterpriseId,
      requirementId: req.id,
      title: 'task title',
      submitRequirement: 'x',
      deadlineAt: new Date(Date.now() + 86400000),
      reviewerId: reviewer.id,
      status: 'PUBLISHED',
      publishedAt: new Date(),
      createdBy: admin.id,
    },
  })

  const assigneeRows: { id: string; assigneeId: string }[] = []
  for (const a of assignees) {
    const row = await prisma.standardExecutionTaskAssignee.create({
      data: {
        enterpriseId,
        taskId: task.id,
        assigneeId: a.id,
        status: 'PENDING_REVIEW',
        submittedAt: new Date(),
      },
    })
    assigneeRows.push({ id: row.id, assigneeId: a.id })
  }

  // 每个 assignee 一条 SUBMITTED submission
  const submissions: { id: string; assigneeId: string }[] = []
  for (const a of assignees) {
    const s = await prisma.standardExecutionSubmission.create({
      data: {
        enterpriseId,
        taskId: task.id,
        assigneeId: a.id,
        submitText: `提交内容 ${a.id} 巡检完成，记录留存`,
        status: 'SUBMITTED',
        version: 1,
        isLatest: true,
        submittedAt: new Date(),
      },
    })
    submissions.push({ id: s.id, assigneeId: a.id })
  }

  return {
    admin,
    reviewer,
    assignees,
    src,
    requirement: req,
    task,
    assigneeRows,
    submissions,
    adminToken: getTestToken(admin.id, 'admin'),
    reviewerToken: getTestToken(reviewer.id, reviewer.role, { enterpriseId }),
    enterpriseId,
  }
}

// ═══════════════════════════════════════════════════════
// list
// ═══════════════════════════════════════════════════════

describe('GET /reviews — 列表', () => {
  it('admin 默认看全部 SUBMITTED', async () => {
    const s = await setupScene({ assigneeCount: 2 })
    const res = await request(app)
      .get('/api/admin/standard-execution/reviews')
      .set('Authorization', `Bearer ${s.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(2)
  })

  it('显式 status=APPROVED 仅返已通过', async () => {
    const s = await setupScene({ reviewerIsAdmin: true })
    // 先 approve 一条
    await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/approve`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({})
    const r = await request(app)
      .get('/api/admin/standard-execution/reviews?status=APPROVED')
      .set('Authorization', `Bearer ${s.adminToken}`)
    expect(r.body.total).toBe(1)
  })

  it('非 admin user 自动限制 scope=mine', async () => {
    const s = await setupScene()
    const other = await createUser({ role: 'user' })
    const otherToken = getTestToken(other.id, 'user', { enterpriseId: 'DEFAULT' })
    const r = await request(app)
      .get('/api/admin/standard-execution/reviews')
      .set('Authorization', `Bearer ${otherToken}`)
    expect(r.status).toBe(200)
    expect(r.body.total).toBe(0)
  })

  it('reviewer 看到自己作为审核人的', async () => {
    const s = await setupScene()
    const r = await request(app)
      .get('/api/admin/standard-execution/reviews')
      .set('Authorization', `Bearer ${s.reviewerToken}`)
    expect(r.body.total).toBe(1)
  })

  it('status=all 返回所有状态（含 APPROVED + REJECTED + SUBMITTED）', async () => {
    const s = await setupScene({ assigneeCount: 3, reviewerIsAdmin: true })
    // s.submissions[0] 通过；s.submissions[1] 驳回；s.submissions[2] 仍是 SUBMITTED
    await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/approve`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({})
    await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[1].id}/reject`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({ reviewComment: 'x' })
    const r = await request(app)
      .get('/api/admin/standard-execution/reviews?status=all')
      .set('Authorization', `Bearer ${s.adminToken}`)
    expect(r.body.total).toBe(3)
  })

  it('list 每条带 assignee.status', async () => {
    const s = await setupScene()
    const r = await request(app)
      .get('/api/admin/standard-execution/reviews')
      .set('Authorization', `Bearer ${s.adminToken}`)
    expect(r.body.data[0].assignee.status).toBe('PENDING_REVIEW')
  })

  it('enterpriseId 隔离', async () => {
    const a = await setupScene()
    await setupScene({ enterpriseId: 'OTHER' })
    const r = await request(app)
      .get('/api/admin/standard-execution/reviews')
      .set('Authorization', `Bearer ${a.adminToken}`)
    expect(r.body.total).toBe(1)
  })

  it('无 token → 401', async () => {
    const r = await request(app).get('/api/admin/standard-execution/reviews')
    expect(r.status).toBe(401)
  })
})

describe('GET /api/enterprise/standard-execution/reviews — 企业审核中心权限', () => {
  it('REVIEWER 只能看到本企业指派给自己的审核', async () => {
    const s = await setupScene({ enterpriseId: 'ENT_A', assigneeCount: 2 })
    const otherReviewer = await createUser({ role: 'user' })
    await prisma.standardExecutionTask.update({
      where: { id: s.task.id },
      data: { reviewerId: otherReviewer.id },
    })
    const mine = await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'ENT_A',
        requirementId: s.requirement.id,
        title: 'my review task',
        submitRequirement: 'x',
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: s.reviewer.id,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        createdBy: s.admin.id,
      },
    })
    await prisma.standardExecutionSubmission.create({
      data: {
        enterpriseId: 'ENT_A',
        taskId: mine.id,
        assigneeId: s.assignees[0].id,
        submitText: 'mine',
        status: 'SUBMITTED',
        version: 1,
        isLatest: true,
        submittedAt: new Date(),
      },
    })

    const r = await request(app)
      .get('/api/enterprise/standard-execution/reviews')
      .set('Authorization', `Bearer ${getTestToken(s.reviewer.id, 'user', { enterpriseId: 'ENT_A', enterpriseRole: 'REVIEWER' })}`)
    expect(r.status).toBe(200)
    expect(r.body.total).toBe(1)
    expect(r.body.data[0].task.title).toBe('my review task')
  })

  it('MANAGER 可看本企业全部审核，但看不到其他企业数据', async () => {
    const a = await setupScene({ enterpriseId: 'ENT_A', assigneeCount: 2 })
    await setupScene({ enterpriseId: 'ENT_B', assigneeCount: 1 })
    const manager = await createUser({ role: 'user' })
    const r = await request(app)
      .get('/api/enterprise/standard-execution/reviews')
      .set('Authorization', `Bearer ${getTestToken(manager.id, 'user', { enterpriseId: 'ENT_A', enterpriseRole: 'MANAGER' })}`)
    expect(r.status).toBe(200)
    expect(r.body.total).toBe(2)
    expect(r.body.data.every((x: { assigneeId: string }) => a.assignees.some((u) => u.id === x.assigneeId))).toBe(true)
  })

  it('EMPLOYEE 不能进入企业审核中心', async () => {
    await setupScene({ enterpriseId: 'ENT_A' })
    const employee = await createUser({ role: 'user' })
    const r = await request(app)
      .get('/api/enterprise/standard-execution/reviews')
      .set('Authorization', `Bearer ${getTestToken(employee.id, 'user', { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' })}`)
    expect(r.status).toBe(403)
  })

  it('企业 REVIEWER 可通过自己负责的提交', async () => {
    const s = await setupScene({ enterpriseId: 'ENT_A' })
    const r = await request(app)
      .post(`/api/enterprise/standard-execution/reviews/${s.submissions[0].id}/approve`)
      .set('Authorization', `Bearer ${getTestToken(s.reviewer.id, 'user', { enterpriseId: 'ENT_A', enterpriseRole: 'REVIEWER' })}`)
      .send({})
    expect(r.status).toBe(200)
    expect(r.body.data.submission.status).toBe('APPROVED')
  })
})

// ═══════════════════════════════════════════════════════
// detail
// ═══════════════════════════════════════════════════════

describe('GET /reviews/:id — 详情', () => {
  it('admin 可看任意 + 含 attachments / reviewLogs / canApprove', async () => {
    const s = await setupScene()
    await prisma.standardExecutionAttachment.create({
      data: { enterpriseId: 'DEFAULT', bizType: 'SUBMISSION', bizId: s.submissions[0].id, fileName: 'a.jpg', fileUrl: '/x', uploadedBy: s.assignees[0].id },
    })
    const r = await request(app)
      .get(`/api/admin/standard-execution/reviews/${s.submissions[0].id}`)
      .set('Authorization', `Bearer ${s.adminToken}`)
    expect(r.status).toBe(200)
    expect(r.body.data.attachments.length).toBe(1)
    expect(r.body.data.reviewLogs).toEqual([])
    expect(r.body.data.canApprove).toBe(true)
    expect(r.body.data.requirement.source).toBeTruthy()
  })

  it('非 admin 非 reviewer → 403', async () => {
    const s = await setupScene()
    const other = await createUser({ role: 'user' })
    const token = getTestToken(other.id, 'user', { enterpriseId: 'DEFAULT' })
    const r = await request(app)
      .get(`/api/admin/standard-execution/reviews/${s.submissions[0].id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(403)
  })

  it('reviewer 可看自己的', async () => {
    const s = await setupScene()
    const r = await request(app)
      .get(`/api/admin/standard-execution/reviews/${s.submissions[0].id}`)
      .set('Authorization', `Bearer ${s.reviewerToken}`)
    expect(r.status).toBe(200)
  })

  it('id 不存在 → 404', async () => {
    const s = await setupScene()
    const r = await request(app)
      .get('/api/admin/standard-execution/reviews/no-such')
      .set('Authorization', `Bearer ${s.adminToken}`)
    expect(r.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════
// approve 事务
// ═══════════════════════════════════════════════════════

describe('POST /reviews/:id/approve — 通过事务', () => {
  it('happy：4 张表原子写入 + 单 assignee task COMPLETED', async () => {
    const s = await setupScene()
    const r = await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/approve`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({})
    expect(r.status).toBe(200)
    expect(r.body.data.submission.status).toBe('APPROVED')
    expect(r.body.data.taskCompleted).toBe(true)

    const sub = await prisma.standardExecutionSubmission.findUnique({ where: { id: s.submissions[0].id } })
    expect(sub?.status).toBe('APPROVED')
    expect(sub?.reviewerId).toBe(s.admin.id)
    expect(sub?.reviewedAt).toBeTruthy()

    const assignee = await prisma.standardExecutionTaskAssignee.findUnique({ where: { id: s.assigneeRows[0].id } })
    expect(assignee?.status).toBe('COMPLETED')
    expect(assignee?.reviewedAt).toBeTruthy()

    const logs = await prisma.standardExecutionReviewLog.findMany({ where: { submissionId: s.submissions[0].id } })
    expect(logs.length).toBe(1)
    expect(logs[0].action).toBe('APPROVE')
    expect(logs[0].fromStatus).toBe('SUBMITTED')
    expect(logs[0].toStatus).toBe('APPROVED')

    const records = await prisma.standardExecutionRecord.findMany({ where: { submissionId: s.submissions[0].id } })
    expect(records.length).toBe(1)
    expect(records[0].title).toBe('task title')
    expect(records[0].sourceId).toBe(s.src.id)
    expect(records[0].requirementId).toBe(s.requirement.id)
    expect(records[0].taskId).toBe(s.task.id)
    expect(records[0].assigneeId).toBe(s.assignees[0].id)
    expect(records[0].status).toBe('VALID')
    expect(records[0].createdFrom).toBe('REVIEW_APPROVE')

    const task = await prisma.standardExecutionTask.findUnique({ where: { id: s.task.id } })
    expect(task?.status).toBe('COMPLETED')
    expect(task?.completedAt).toBeTruthy()
  })

  it('多 assignee 时仅最后一个通过才把 task 设 COMPLETED', async () => {
    const s = await setupScene({ assigneeCount: 2 })
    const r1 = await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/approve`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({})
    expect(r1.body.data.taskCompleted).toBe(false)
    let task = await prisma.standardExecutionTask.findUnique({ where: { id: s.task.id } })
    expect(task?.status).toBe('PUBLISHED')

    const r2 = await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[1].id}/approve`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({})
    expect(r2.body.data.taskCompleted).toBe(true)
    task = await prisma.standardExecutionTask.findUnique({ where: { id: s.task.id } })
    expect(task?.status).toBe('COMPLETED')
  })

  it('reviewer 自己 approve ok', async () => {
    const s = await setupScene()
    const r = await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/approve`)
      .set('Authorization', `Bearer ${s.reviewerToken}`)
      .send({})
    expect(r.status).toBe(200)
  })

  it('非 admin 非 reviewer → 403', async () => {
    const s = await setupScene()
    const other = await createUser({ role: 'user' })
    const token = getTestToken(other.id, 'user', { enterpriseId: 'DEFAULT' })
    const r = await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(r.status).toBe(403)
  })

  it('reviewComment 透传写入 Submission + ReviewLog', async () => {
    const s = await setupScene()
    await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/approve`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({ reviewComment: '材料齐全' })
    const sub = await prisma.standardExecutionSubmission.findUnique({ where: { id: s.submissions[0].id } })
    expect(sub?.reviewComment).toBe('材料齐全')
    const log = await prisma.standardExecutionReviewLog.findFirst({ where: { submissionId: s.submissions[0].id } })
    expect(log?.comment).toBe('材料齐全')
  })

  it('recordTitle / recordSummary 覆盖默认', async () => {
    const s = await setupScene()
    await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/approve`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({ recordTitle: '自定义标题', recordSummary: '自定义摘要' })
    const rec = await prisma.standardExecutionRecord.findFirst({ where: { submissionId: s.submissions[0].id } })
    expect(rec?.title).toBe('自定义标题')
    expect(rec?.summary).toBe('自定义摘要')
  })

  it('summary 默认截前 200 字', async () => {
    const s = await setupScene()
    const longText = '巡' .repeat(300)
    await prisma.standardExecutionSubmission.update({ where: { id: s.submissions[0].id }, data: { submitText: longText } })
    await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/approve`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({})
    const rec = await prisma.standardExecutionRecord.findFirst({ where: { submissionId: s.submissions[0].id } })
    expect(rec?.summary?.length).toBe(200)
  })

  it('APPROVED 后再 approve → 409', async () => {
    const s = await setupScene()
    await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/approve`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({})
    const r = await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/approve`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({})
    expect(r.status).toBe(409)
  })

  it('非 latest submission → 409', async () => {
    const s = await setupScene()
    await prisma.standardExecutionSubmission.update({
      where: { id: s.submissions[0].id },
      data: { isLatest: false },
    })
    const r = await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/approve`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({})
    expect(r.status).toBe(409)
  })

  it('submissionId 不存在 → 404', async () => {
    const s = await setupScene()
    const r = await request(app)
      .post('/api/admin/standard-execution/reviews/no-such/approve')
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({})
    expect(r.status).toBe(404)
  })

  it('无 token → 401', async () => {
    const r = await request(app)
      .post('/api/admin/standard-execution/reviews/x/approve')
      .send({})
    expect(r.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════
// reject 事务
// ═══════════════════════════════════════════════════════

describe('POST /reviews/:id/reject — 驳回事务', () => {
  it('happy：Submission REJECTED + Assignee REJECTED + ReviewLog REJECT + Record 不写', async () => {
    const s = await setupScene()
    const r = await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/reject`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({ reviewComment: '附件不清晰，请重新提交' })
    expect(r.status).toBe(200)
    const sub = await prisma.standardExecutionSubmission.findUnique({ where: { id: s.submissions[0].id } })
    expect(sub?.status).toBe('REJECTED')
    expect(sub?.reviewComment).toBe('附件不清晰，请重新提交')

    const assignee = await prisma.standardExecutionTaskAssignee.findUnique({ where: { id: s.assigneeRows[0].id } })
    expect(assignee?.status).toBe('REJECTED')

    const logs = await prisma.standardExecutionReviewLog.findMany({ where: { submissionId: s.submissions[0].id } })
    expect(logs.length).toBe(1)
    expect(logs[0].action).toBe('REJECT')
    expect(logs[0].comment).toBe('附件不清晰，请重新提交')

    const rec = await prisma.standardExecutionRecord.count({ where: { submissionId: s.submissions[0].id } })
    expect(rec).toBe(0)
  })

  it('reviewComment 缺失 → 400', async () => {
    const s = await setupScene()
    const r = await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/reject`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({})
    expect(r.status).toBe(400)
  })

  it('reviewComment 空字符串 → 400', async () => {
    const s = await setupScene()
    const r = await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/reject`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({ reviewComment: '   ' })
    expect(r.status).toBe(400)
  })

  it('REJECTED 后再 reject → 409', async () => {
    const s = await setupScene()
    await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/reject`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({ reviewComment: 'x' })
    const r = await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/reject`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({ reviewComment: 'y' })
    expect(r.status).toBe(409)
  })

  it('非 admin 非 reviewer → 403', async () => {
    const s = await setupScene()
    const other = await createUser({ role: 'user' })
    const token = getTestToken(other.id, 'user', { enterpriseId: 'DEFAULT' })
    const r = await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/reject`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reviewComment: 'x' })
    expect(r.status).toBe(403)
  })

  it('reviewer 自己 reject ok', async () => {
    const s = await setupScene()
    const r = await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/reject`)
      .set('Authorization', `Bearer ${s.reviewerToken}`)
      .send({ reviewComment: 'x' })
    expect(r.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════
// 完整流程：驳回 → 重新提交 → 通过
// ═══════════════════════════════════════════════════════

describe('完整流程：提交 → 驳回 → 重新提交 → 通过 → Record + Task COMPLETED', () => {
  it('跑通所有事务衔接', async () => {
    const s = await setupScene()
    const me = s.assignees[0]
    const meToken = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })

    // 1. 驳回首次提交
    await request(app)
      .post(`/api/admin/standard-execution/reviews/${s.submissions[0].id}/reject`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({ reviewComment: '需要补充材料' })

    // 2. 员工重新提交（走 mp submit 路由）
    const newSubmit = await request(app)
      .post(`/api/app/standard-execution/tasks/${s.task.id}/submit`)
      .set('Authorization', `Bearer ${meToken}`)
      .send({
        submitText: '已补充材料',
        attachments: [{ fileName: 'b.jpg', fileUrl: '/uploads/standard-execution/x/y/b.jpg' }],
      })
    expect(newSubmit.status).toBe(201)
    expect(newSubmit.body.data.version).toBe(2)
    const newSubId = newSubmit.body.data.id

    // 3. 通过新提交
    const approve = await request(app)
      .post(`/api/admin/standard-execution/reviews/${newSubId}/approve`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({})
    expect(approve.status).toBe(200)
    expect(approve.body.data.taskCompleted).toBe(true)

    // 4. 验证最终状态
    const oldSub = await prisma.standardExecutionSubmission.findUnique({ where: { id: s.submissions[0].id } })
    expect(oldSub?.status).toBe('REJECTED')
    expect(oldSub?.isLatest).toBe(false)

    const newSub = await prisma.standardExecutionSubmission.findUnique({ where: { id: newSubId } })
    expect(newSub?.status).toBe('APPROVED')
    expect(newSub?.isLatest).toBe(true)

    const records = await prisma.standardExecutionRecord.findMany({ where: { taskId: s.task.id } })
    expect(records.length).toBe(1)
    expect(records[0].submissionId).toBe(newSubId)

    const logs = await prisma.standardExecutionReviewLog.findMany({
      where: { taskId: s.task.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(logs.length).toBe(2)
    expect(logs[0].action).toBe('REJECT')
    expect(logs[1].action).toBe('APPROVE')

    const task = await prisma.standardExecutionTask.findUnique({ where: { id: s.task.id } })
    expect(task?.status).toBe('COMPLETED')
  })
})
