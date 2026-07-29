/**
 * standard-execution / 员工小程序端 — 我的任务 + view + records
 *
 * 覆盖：
 *  - list:
 *      todo tab: 含 PENDING + IN_PROGRESS
 *      review tab: PENDING_REVIEW
 *      done tab: COMPLETED
 *      closed tab: CANCELLED task
 *      仅自己被指派的（assigneeId=me 硬过滤）
 *      task.status 隐藏 DRAFT / CANCELLED；显示 PUBLISHED / COMPLETED / OVERDUE
 *      enterpriseId 隔离
 *      按 deadlineAt 升序
 *      isOverdue 字段（PUBLISHED + 过期 + 非 COMPLETED）
 *      isRejected 字段
 *  - detail:
 *      自己任务可看，含 task + requirement+source + myAssignee + mySubmissions
 *      不返回其他 assignee 的提交（隐私）
 *      非自己任务 → 403
 *      DRAFT / CANCELLED 任务 → 404（不暴露）
 *  - view:
 *      PENDING → IN_PROGRESS
 *      IN_PROGRESS → noop
 *      COMPLETED → noop
 *      task.status=DRAFT → 不可见（先 403）
 *      task.status=CANCELLED → 409
 *      非自己任务 → 403
 *  - records: 只返自己的 VALID 记录
 *  - 权限: 无 token → 401（所有端点）
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
  // FK 顺序：packageItem → package → reviewLog → attachment → record → submission → assignee → task → requirement → source
  await cleanStandardExecutionData()
})

async function mkActiveReq(adminId: string, enterpriseId = 'DEFAULT') {
  const src = await prisma.standardExecutionSource.create({
    data: { enterpriseId, title: '测试标准', sourceType: 'PRODUCT_STANDARD', createdBy: adminId },
  })
  return prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId,
      sourceId: src.id,
      title: '测试要求项',
      requirementText: '应每月检查',
      status: 'ACTIVE',
      createdBy: adminId,
    },
  })
}

async function mkTask(opts: {
  requirementId: string
  reviewerId: string
  createdBy: string
  enterpriseId?: string
  status?: 'DRAFT' | 'PENDING_APPROVAL' | 'PUBLISHED' | 'COMPLETED' | 'OVERDUE' | 'CANCELLED'
  deadlineOffsetMs?: number
  title?: string
  taskType?: string | null
}) {
  return prisma.standardExecutionTask.create({
    data: {
      enterpriseId: opts.enterpriseId ?? 'DEFAULT',
      requirementId: opts.requirementId,
      title: opts.title ?? '任务',
      taskType: opts.taskType ?? null,
      submitRequirement: '提交照片',
      deadlineAt: new Date(Date.now() + (opts.deadlineOffsetMs ?? 86400000)),
      reviewerId: opts.reviewerId,
      status: opts.status ?? 'PUBLISHED',
      publishedAt: opts.status === 'DRAFT' || opts.status === 'PENDING_APPROVAL' ? null : new Date(),
      createdBy: opts.createdBy,
    },
  })
}

async function mkAssignee(taskId: string, assigneeId: string, status: 'PENDING' | 'IN_PROGRESS' | 'PENDING_REVIEW' | 'REJECTED' | 'COMPLETED' | 'OVERDUE' = 'PENDING', enterpriseId = 'DEFAULT') {
  return prisma.standardExecutionTaskAssignee.create({
    data: { enterpriseId, taskId, assigneeId, status },
  })
}

// ═══════════════════════════════════════════════════════
// list
// ═══════════════════════════════════════════════════════

describe('GET /api/app/standard-execution/tasks — 我的任务列表', () => {
  it('todo tab：返回 PENDING + IN_PROGRESS', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t1 = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, title: 't1', taskType: 'TRAINING' })
    const t2 = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, title: 't2', deadlineOffsetMs: 2 * 86400000 })
    const t3 = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, title: 't3' })
    await mkAssignee(t1.id, me.id, 'PENDING')
    await mkAssignee(t2.id, me.id, 'IN_PROGRESS')
    await mkAssignee(t3.id, me.id, 'COMPLETED')

    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get('/api/app/standard-execution/tasks?tab=todo')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(2)
    const titles = res.body.data.map((r: { task: { title: string } }) => r.task.title)
    expect(titles).toContain('t1')
    expect(titles).toContain('t2')
    expect(titles).not.toContain('t3')
    expect(res.body.data.find((r: { task: { title: string } }) => r.task.title === 't1').task.taskType).toBe('TRAINING')
  })

  it('review tab：仅 PENDING_REVIEW', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id })
    await mkAssignee(t.id, me.id, 'PENDING_REVIEW')
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get('/api/app/standard-execution/tasks?tab=review')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.total).toBe(1)
  })

  it('done tab：仅 COMPLETED', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, status: 'COMPLETED' })
    await mkAssignee(t.id, me.id, 'COMPLETED')
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get('/api/app/standard-execution/tasks?tab=done')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.total).toBe(1)
  })

  it('todo tab 含 REJECTED（驳回归入待处理，可重新提交）', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id })
    await mkAssignee(t.id, me.id, 'REJECTED')
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get('/api/app/standard-execution/tasks?tab=todo')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].isRejected).toBe(true)
  })

  it('closed tab：CANCELLED 任务（不依赖 assignee status）', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, status: 'CANCELLED' })
    await mkAssignee(t.id, me.id, 'PENDING')
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get('/api/app/standard-execution/tasks?tab=closed')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].task.status).toBe('CANCELLED')
  })

  it('硬过滤 assigneeId=me，不会看到别人的任务', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const other = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const tMine = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, title: 'mine' })
    const tOther = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, title: 'other' })
    await mkAssignee(tMine.id, me.id, 'PENDING')
    await mkAssignee(tOther.id, other.id, 'PENDING')

    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get('/api/app/standard-execution/tasks?tab=todo')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].task.title).toBe('mine')
  })

  it('DRAFT/PENDING_APPROVAL 任务不显示，PUBLISHED/COMPLETED/OVERDUE 显示', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const tDraft = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, status: 'DRAFT', title: 'draft' })
    const tPendingApproval = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, status: 'PENDING_APPROVAL', title: 'pending-approval' })
    const tPub = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, status: 'PUBLISHED', title: 'pub' })
    const tOverdue = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, status: 'OVERDUE', title: 'overdue', deadlineOffsetMs: -86400000 })
    await mkAssignee(tDraft.id, me.id, 'PENDING')
    await mkAssignee(tPendingApproval.id, me.id, 'PENDING')
    await mkAssignee(tPub.id, me.id, 'PENDING')
    await mkAssignee(tOverdue.id, me.id, 'PENDING')

    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get('/api/app/standard-execution/tasks?tab=todo')
      .set('Authorization', `Bearer ${token}`)
    const titles = res.body.data.map((r: { task: { title: string } }) => r.task.title)
    expect(titles).not.toContain('draft')
    expect(titles).not.toContain('pending-approval')
    expect(titles).toContain('pub')
    expect(titles).toContain('overdue')
  })

  it('CANCELLED 任务不显示', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, status: 'CANCELLED' })
    await mkAssignee(t.id, me.id, 'PENDING')
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get('/api/app/standard-execution/tasks?tab=todo')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.total).toBe(0)
  })

  it('按 deadlineAt 升序', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const tLater = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, title: 'later', deadlineOffsetMs: 7 * 86400000 })
    const tSooner = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, title: 'sooner', deadlineOffsetMs: 2 * 86400000 })
    await mkAssignee(tLater.id, me.id, 'PENDING')
    await mkAssignee(tSooner.id, me.id, 'PENDING')
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get('/api/app/standard-execution/tasks?tab=todo')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data[0].task.title).toBe('sooner')
    expect(res.body.data[1].task.title).toBe('later')
  })

  it('isOverdue 字段：PUBLISHED + 过期 + 非 COMPLETED', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, deadlineOffsetMs: -86400000 })
    await mkAssignee(t.id, me.id, 'PENDING')
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get('/api/app/standard-execution/tasks?tab=todo')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data[0].isOverdue).toBe(true)
  })

  it('enterpriseId 隔离', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const otherReq = await mkActiveReq(admin.id, 'OTHER')
    const tMine = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, title: 'mine' })
    const tOther = await mkTask({ requirementId: otherReq.id, reviewerId: admin.id, createdBy: admin.id, title: 'other', enterpriseId: 'OTHER' })
    await mkAssignee(tMine.id, me.id, 'PENDING', 'DEFAULT')
    await mkAssignee(tOther.id, me.id, 'PENDING', 'OTHER')

    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get('/api/app/standard-execution/tasks?tab=todo')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].task.title).toBe('mine')
  })

  it('无 token → 401', async () => {
    const res = await request(app).get('/api/app/standard-execution/tasks')
    expect(res.status).toBe(401)
  })

  it('tab 缺省 → todo', async () => {
    const me = await createUser({ role: 'user' })
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get('/api/app/standard-execution/tasks')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════
// detail
// ═══════════════════════════════════════════════════════

describe('GET /api/app/standard-execution/tasks/:id — 详情', () => {
  it('happy — 含 task / requirement.source / myAssignee / mySubmissions', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id })
    await mkAssignee(t.id, me.id, 'PENDING')
    // 一条历史 submission
    await prisma.standardExecutionSubmission.create({
      data: {
        enterpriseId: 'DEFAULT',
        taskId: t.id,
        assigneeId: me.id,
        submitText: '提交内容',
        version: 1,
        isLatest: true,
      },
    })

    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get(`/api/app/standard-execution/tasks/${t.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.task.id).toBe(t.id)
    expect(res.body.data.requirement.source).toBeTruthy()
    expect(res.body.data.myAssignee.status).toBe('PENDING')
    expect(res.body.data.mySubmissions.length).toBe(1)
    expect(res.body.data.task.submitFormConfig).toEqual(expect.objectContaining({
      version: 'T12_SUBMIT_FORM_V1',
      modes: expect.arrayContaining(['TEXT', 'ATTACHMENT']),
      text: expect.objectContaining({ required: true }),
      attachment: expect.objectContaining({ maxCount: 20 }),
    }))
  })

  it('非自己被指派的任务 → 403', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const other = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id })
    await mkAssignee(t.id, other.id, 'PENDING')

    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get(`/api/app/standard-execution/tasks/${t.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('DRAFT 任务 → 404（不暴露 DRAFT）', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, status: 'DRAFT' })
    await mkAssignee(t.id, me.id, 'PENDING')

    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get(`/api/app/standard-execution/tasks/${t.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })

  it('PENDING_APPROVAL 任务 → 404（审核通过前不暴露）', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, status: 'PENDING_APPROVAL' })
    await mkAssignee(t.id, me.id, 'PENDING')
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get(`/api/app/standard-execution/tasks/${t.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })

  it('CANCELLED 任务详情 → 200 只读可看（P0-4 已关闭 tab 点进）', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, status: 'CANCELLED' })
    await mkAssignee(t.id, me.id, 'PENDING')

    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get(`/api/app/standard-execution/tasks/${t.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.task.status).toBe('CANCELLED')
  })

  it('mySubmissions 仅返自己的，不返其他 assignee 的', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const other = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id })
    await mkAssignee(t.id, me.id, 'PENDING')
    await mkAssignee(t.id, other.id, 'PENDING')
    await prisma.standardExecutionSubmission.create({
      data: { enterpriseId: 'DEFAULT', taskId: t.id, assigneeId: me.id, submitText: 'mine', version: 1 },
    })
    await prisma.standardExecutionSubmission.create({
      data: { enterpriseId: 'DEFAULT', taskId: t.id, assigneeId: other.id, submitText: 'other', version: 1 },
    })

    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get(`/api/app/standard-execution/tasks/${t.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data.mySubmissions.length).toBe(1)
    expect(res.body.data.mySubmissions[0].submitText).toBe('mine')
  })

  it('无 token → 401', async () => {
    const res = await request(app).get('/api/app/standard-execution/tasks/x')
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════
// view
// ═══════════════════════════════════════════════════════

describe('POST /api/app/standard-execution/tasks/:id/view — 进入任务', () => {
  it('PENDING → IN_PROGRESS', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id })
    await mkAssignee(t.id, me.id, 'PENDING')

    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${t.id}/view`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('IN_PROGRESS')
  })

  it('IN_PROGRESS → noop', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id })
    await mkAssignee(t.id, me.id, 'IN_PROGRESS')
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${t.id}/view`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.noop).toBe(true)
  })

  it('COMPLETED → noop', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, status: 'COMPLETED' })
    await mkAssignee(t.id, me.id, 'COMPLETED')
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${t.id}/view`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.noop).toBe(true)
  })

  it('task.status=DRAFT → 409', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, status: 'DRAFT' })
    await mkAssignee(t.id, me.id, 'PENDING')
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${t.id}/view`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('task.status=CANCELLED → 409', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id, status: 'CANCELLED' })
    await mkAssignee(t.id, me.id, 'PENDING')
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${t.id}/view`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('非自己被指派的任务 → 403', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const other = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id })
    await mkAssignee(t.id, other.id, 'PENDING')
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${t.id}/view`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })
})

// ═══════════════════════════════════════════════════════
// records
// ═══════════════════════════════════════════════════════

describe('GET /api/app/standard-execution/records — 我的完成记录', () => {
  it('只返自己的 VALID 记录', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const other = await createUser({ role: 'user' })
    const req = await mkActiveReq(admin.id)
    const t = await mkTask({ requirementId: req.id, reviewerId: admin.id, createdBy: admin.id })

    const sub1 = await prisma.standardExecutionSubmission.create({
      data: { enterpriseId: 'DEFAULT', taskId: t.id, assigneeId: me.id, submitText: 'm1', version: 1 },
    })
    const sub2 = await prisma.standardExecutionSubmission.create({
      data: { enterpriseId: 'DEFAULT', taskId: t.id, assigneeId: me.id, submitText: 'm2', version: 2 },
    })
    const sub3 = await prisma.standardExecutionSubmission.create({
      data: { enterpriseId: 'DEFAULT', taskId: t.id, assigneeId: other.id, submitText: 'o1', version: 1 },
    })

    await prisma.standardExecutionRecord.createMany({
      data: [
        { enterpriseId: 'DEFAULT', sourceId: req.sourceId, requirementId: req.id, taskId: t.id, submissionId: sub1.id, assigneeId: me.id, title: 'mine valid', status: 'VALID' },
        { enterpriseId: 'DEFAULT', sourceId: req.sourceId, requirementId: req.id, taskId: t.id, submissionId: sub2.id, assigneeId: me.id, title: 'mine void', status: 'VOID' },
        { enterpriseId: 'DEFAULT', sourceId: req.sourceId, requirementId: req.id, taskId: t.id, submissionId: sub3.id, assigneeId: other.id, title: 'other', status: 'VALID' },
      ],
    })

    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get('/api/app/standard-execution/records')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].title).toBe('mine valid')
  })

  it('空列表 → 0', async () => {
    const me = await createUser({ role: 'user' })
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get('/api/app/standard-execution/records')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.total).toBe(0)
    expect(res.body.data).toEqual([])
  })

  it('无 token → 401', async () => {
    const res = await request(app).get('/api/app/standard-execution/records')
    expect(res.status).toBe(401)
  })
})
