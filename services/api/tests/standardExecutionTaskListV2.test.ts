import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerStandardExecutionRoutes } from '../src/standard-execution/sourceRoutes.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { cleanStandardExecutionData } from './seClean.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionRoutes(app)
  registerEnterpriseRoutes(app)
})

beforeEach(async () => {
  await cleanStandardExecutionData()
})

async function makeAdminToken() {
  const admin = await createUser({ role: 'admin' })
  return { admin, token: getTestToken(admin.id, 'admin') }
}

async function makeRequirement(createdBy: string, title: string, opts: { sourceTitle?: string; clauseNo?: string } = {}) {
  const source = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId: 'DEFAULT',
      title: opts.sourceTitle ?? 'v2 测试标准',
      sourceType: 'PRODUCT_STANDARD',
      sourceNo: 'STD-V2',
      createdBy,
    },
  })
  return prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId: 'DEFAULT',
      sourceId: source.id,
      clauseNo: opts.clauseNo ?? '1.1',
      title,
      requirementText: `${title} 的执行要求`,
      status: 'ACTIVE',
      createdBy,
    },
    include: { source: true },
  })
}

async function makeTask(opts: {
  createdBy: string
  title: string
  requirementId?: string
  reviewerId?: string | null
  status?: string
  deadlineAt?: Date | null
  taskType?: string | null
  basisSnapshots?: unknown
  planId?: string | null
}) {
  return prisma.standardExecutionTask.create({
    data: {
      enterpriseId: 'DEFAULT',
      requirementId: opts.requirementId ?? null,
      planId: opts.planId ?? null,
      title: opts.title,
      taskType: opts.taskType ?? null,
      submitRequirement: '提交材料',
      reviewerId: opts.reviewerId ?? null,
      status: opts.status ?? 'DRAFT',
      deadlineAt: opts.deadlineAt === undefined ? new Date(Date.now() + 86400000) : opts.deadlineAt,
      publishedAt: ['PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE'].includes(opts.status ?? '') ? new Date() : null,
      basisSnapshots: opts.basisSnapshots as never,
      createdBy: opts.createdBy,
    },
  })
}

async function makeAssignee(taskId: string, assigneeId: string, status: string) {
  return prisma.standardExecutionTaskAssignee.create({
    data: { enterpriseId: 'DEFAULT', taskId, assigneeId, status },
  })
}

describe('GET /api/admin/standard-execution/tasks/list-v2', () => {
  it('按管理端 read-model tab 返回任务，counts 生效，并兼容旧 requirement 与新 TaskItem basis', async () => {
    const { admin, token } = await makeAdminToken()
    const reviewer = await createUser({ role: 'user' })
    const assignee = await createUser({ role: 'user' })
    const reqA = await makeRequirement(admin.id, '年度培训制度', { clauseNo: '1.1' })
    const reqB = await makeRequirement(admin.id, '季度整改记录', { clauseNo: '2.1' })
    const draft = await makeTask({
      createdBy: admin.id,
      title: '旧单要求草稿',
      requirementId: reqA.id,
      status: 'DRAFT',
      reviewerId: reviewer.id,
    })
    const active = await makeTask({
      createdBy: admin.id,
      title: '多要求执行任务',
      status: 'PUBLISHED',
      reviewerId: reviewer.id,
    })
    await prisma.standardExecutionTaskItem.createMany({
      data: [
        { taskId: active.id, requirementId: reqA.id },
        { taskId: active.id, requirementId: reqB.id },
      ],
    })
    await makeAssignee(active.id, assignee.id, 'IN_PROGRESS')
    await prisma.enterprise.upsert({
      where: { id: 'DEFAULT' },
      update: {},
      create: { id: 'DEFAULT', name: '默认企业', code: 'DEFAULT' },
    })
    const plan = await prisma.standardExecutionPlan.create({
      data: {
        enterpriseId: 'DEFAULT',
        sourceId: reqA.sourceId,
        title: '月度执行计划',
        status: 'ACTIVE',
        createdBy: admin.id,
      },
    })
    const planTask = await makeTask({
      createdBy: admin.id,
      title: '计划生成任务',
      requirementId: reqA.id,
      planId: plan.id,
      status: 'PUBLISHED',
      reviewerId: reviewer.id,
    })

    const activeRes = await request(app)
      .get(`/api/admin/standard-execution/tasks/list-v2?tab=requirement&status=PUBLISHED&requirementId=${reqB.id}&includeCounts=true`)
      .set('Authorization', `Bearer ${token}`)
    expect(activeRes.status).toBe(200)
    expect(activeRes.body.total).toBe(1)
    expect(activeRes.body.counts).toMatchObject({ all: 1, todo: 0, executing: 1, ended: 0, overdue: 0, plan: 0, requirement: 1, mine: 1, closed: 0 })
    expect(activeRes.body.data[0]).toMatchObject({
      id: active.id,
      hasTaskItems: true,
      requirementCount: 2,
      assigneeCount: 1,
      assigneeSummary: { total: 1 },
      pendingReviewCount: 0,
      completedCount: 0,
      overdueCount: 0,
      reviewer: { id: reviewer.id },
      reviewerName: reviewer.phone,
      submitFormConfig: {
        version: 'T12_SUBMIT_FORM_V1',
        modes: expect.arrayContaining(['TEXT', 'ATTACHMENT', 'TASK_ITEMS']),
        structured: { type: 'TASK_ITEMS', itemCount: 2 },
        attachment: expect.objectContaining({ required: false, minCount: 0 }),
      },
    })
    expect(activeRes.body.data[0].requirementSummary).toEqual([
      expect.objectContaining({ requirementId: reqA.id, title: '年度培训制度' }),
      expect.objectContaining({ requirementId: reqB.id, title: '季度整改记录' }),
    ])
    expect(activeRes.body.data[0].basis.map((item: { requirementId: string }) => item.requirementId)).toEqual([
      reqA.id,
      reqB.id,
    ])

    const draftRes = await request(app)
      .get(`/api/admin/standard-execution/tasks/list-v2?tab=all&status=DRAFT&requirementId=${reqA.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(draftRes.status).toBe(200)
    expect(draftRes.body.data).toHaveLength(1)
    expect(draftRes.body.data[0].id).toBe(draft.id)
    expect(draftRes.body.data[0].basis[0]).toMatchObject({ requirementId: reqA.id, title: '年度培训制度' })

    const planRes = await request(app)
      .get('/api/admin/standard-execution/tasks/list-v2?tab=plan&status=PUBLISHED')
      .set('Authorization', `Bearer ${token}`)
    expect(planRes.status).toBe(200)
    expect(planRes.body.data.map((item: { id: string }) => item.id)).toContain(planTask.id)
    expect(planRes.body.data.find((item: { id: string }) => item.id === planTask.id)).toMatchObject({
      planId: plan.id,
      planTitle: '月度执行计划',
    })
  })

  it('支持 reviewer / assignee / assigneeStatus / deadline / keyword 组合过滤', async () => {
    const { admin, token } = await makeAdminToken()
    const reviewer = await createUser({ role: 'user' })
    const assignee = await createUser({ role: 'user' })
    const other = await createUser({ role: 'user' })
    const req = await makeRequirement(admin.id, '超期检查项')
    const overdue = await makeTask({
      createdBy: admin.id,
      title: '本周必查任务',
      requirementId: req.id,
      reviewerId: reviewer.id,
      status: 'PUBLISHED',
      deadlineAt: new Date(Date.now() - 3600000),
    })
    const future = await makeTask({
      createdBy: admin.id,
      title: '未来任务',
      requirementId: req.id,
      reviewerId: other.id,
      status: 'PUBLISHED',
      deadlineAt: new Date(Date.now() + 86400000),
    })
    const overdueStatus = await makeTask({
      createdBy: admin.id,
      title: '系统已标记逾期',
      requirementId: req.id,
      reviewerId: reviewer.id,
      status: 'OVERDUE',
      deadlineAt: null,
    })
    const reviewTask = await makeTask({
      createdBy: admin.id,
      title: '执行人待审核任务',
      requirementId: req.id,
      reviewerId: reviewer.id,
      status: 'PUBLISHED',
      deadlineAt: new Date(Date.now() + 86400000),
    })
    const taskApprovalOnly = await makeTask({
      createdBy: admin.id,
      title: '任务待审核但无人提交',
      requirementId: req.id,
      reviewerId: reviewer.id,
      status: 'PENDING_APPROVAL',
      deadlineAt: new Date(Date.now() + 86400000),
    })
    const draftAdminAction = await makeTask({
      createdBy: admin.id,
      title: '管理员待处理草稿',
      requirementId: req.id,
      reviewerId: reviewer.id,
      status: 'DRAFT',
      deadlineAt: new Date(Date.now() + 86400000),
    })
    const allAssigneesDone = await makeTask({
      createdBy: admin.id,
      title: '已发布但执行人都完成',
      requirementId: req.id,
      reviewerId: reviewer.id,
      status: 'PUBLISHED',
      deadlineAt: new Date(Date.now() + 86400000),
    })
    const completed = await makeTask({
      createdBy: admin.id,
      title: '已完成任务',
      requirementId: req.id,
      reviewerId: reviewer.id,
      status: 'COMPLETED',
      deadlineAt: new Date(Date.now() + 86400000),
    })
    await makeAssignee(overdue.id, assignee.id, 'IN_PROGRESS')
    await makeAssignee(future.id, other.id, 'PENDING')
    await makeAssignee(overdueStatus.id, assignee.id, 'OVERDUE')
    await makeAssignee(reviewTask.id, assignee.id, 'PENDING_REVIEW')
    await makeAssignee(taskApprovalOnly.id, assignee.id, 'PENDING')
    await makeAssignee(draftAdminAction.id, assignee.id, 'PENDING')
    await makeAssignee(allAssigneesDone.id, assignee.id, 'COMPLETED')
    await makeAssignee(completed.id, assignee.id, 'COMPLETED')

    const res = await request(app)
      .get(`/api/admin/standard-execution/tasks/list-v2?deadline=overdue&reviewerId=${reviewer.id}&assigneeId=${assignee.id}&assigneeStatus=IN_PROGRESS&keyword=本周`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].id).toBe(overdue.id)
    expect(res.body.data[0].isOverdue).toBe(true)

    const overdueRes = await request(app)
      .get('/api/admin/standard-execution/tasks/list-v2?tab=all&deadline=overdue')
      .set('Authorization', `Bearer ${token}`)
    expect(overdueRes.status).toBe(200)
    expect(overdueRes.body.data.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([overdue.id, overdueStatus.id]))

    const pendingReviewRes = await request(app)
      .get('/api/admin/standard-execution/tasks/list-v2?tab=all&status=PENDING_REVIEW')
      .set('Authorization', `Bearer ${token}`)
    expect(pendingReviewRes.status).toBe(200)
    const pendingReviewIds = pendingReviewRes.body.data.map((item: { id: string }) => item.id)
    expect(pendingReviewIds).toContain(reviewTask.id)
    expect(pendingReviewIds).not.toContain(taskApprovalOnly.id)
    expect(pendingReviewRes.body.data[0]).toMatchObject({
      pendingReviewCount: 1,
      assigneeSummary: { byStatus: { PENDING_REVIEW: 1 } },
    })

    const executingRes = await request(app)
      .get('/api/admin/standard-execution/tasks/list-v2?tab=all&status=EXECUTING')
      .set('Authorization', `Bearer ${token}`)
    expect(executingRes.status).toBe(200)
    const executingIds = executingRes.body.data.map((item: { id: string }) => item.id)
    expect(executingIds).toEqual(expect.arrayContaining([overdue.id, future.id, reviewTask.id]))
    expect(executingIds).not.toContain(allAssigneesDone.id)
    expect(executingIds).not.toContain(completed.id)

    const todoTabRes = await request(app)
      .get('/api/admin/standard-execution/tasks/list-v2?tab=todo&includeCounts=true')
      .set('Authorization', `Bearer ${token}`)
    expect(todoTabRes.status).toBe(200)
    const todoIds = todoTabRes.body.data.map((item: { id: string }) => item.id)
    expect(todoIds).toEqual(expect.arrayContaining([taskApprovalOnly.id, reviewTask.id]))
    expect(todoIds).not.toContain(draftAdminAction.id)
    expect(todoIds).not.toContain(future.id)
    expect(todoTabRes.body.counts).toMatchObject({
      all: 8,
      todo: 2,
      executing: 5,
      ended: 1,
      overdue: 2,
      closed: 1,
    })

    const executingTabRes = await request(app)
      .get('/api/admin/standard-execution/tasks/list-v2?tab=executing&includeCounts=true')
      .set('Authorization', `Bearer ${token}`)
    expect(executingTabRes.status).toBe(200)
    const executingTabIds = executingTabRes.body.data.map((item: { id: string }) => item.id)
    expect(executingTabIds).toEqual(expect.arrayContaining([overdue.id, overdueStatus.id, future.id, reviewTask.id, allAssigneesDone.id]))
    expect(executingTabIds).not.toContain(taskApprovalOnly.id)
    expect(executingTabIds).not.toContain(completed.id)

    const endedTabRes = await request(app)
      .get('/api/admin/standard-execution/tasks/list-v2?tab=ended')
      .set('Authorization', `Bearer ${token}`)
    expect(endedTabRes.status).toBe(200)
    expect(endedTabRes.body.data.map((item: { id: string }) => item.id)).toEqual([completed.id])
  })
})

describe('GET /api/enterprise/standard-execution/tasks/list-v2', () => {
  it('企业版管理入口复用 v2 read model', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeRequirement(admin.id, '企业版任务依据')
    const task = await makeTask({
      createdBy: admin.id,
      title: '企业版 v2 列表任务',
      requirementId: req.id,
      status: 'PENDING_APPROVAL',
    })

    const res = await request(app)
      .get('/api/enterprise/standard-execution/tasks/list-v2?tab=all&status=PENDING_APPROVAL&includeCounts=true')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].id).toBe(task.id)
    expect(res.body.counts.all).toBe(1)
  })
})

describe('GET /api/app/standard-execution/tasks/list-v2', () => {
  it('员工/个人端按 todo/review/done/closed 分组，隐藏未指派和未发布任务', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const other = await createUser({ role: 'user' })
    const req = await makeRequirement(admin.id, '个人端任务依据')
    const todo = await makeTask({ createdBy: admin.id, title: '待处理', requirementId: req.id, status: 'PUBLISHED' })
    const review = await makeTask({ createdBy: admin.id, title: '审核中', requirementId: req.id, status: 'PUBLISHED' })
    const done = await makeTask({ createdBy: admin.id, title: '已完成', requirementId: req.id, status: 'COMPLETED' })
    const closed = await makeTask({ createdBy: admin.id, title: '已关闭', requirementId: req.id, status: 'CANCELLED' })
    const draft = await makeTask({ createdBy: admin.id, title: '草稿不可见', requirementId: req.id, status: 'DRAFT' })
    const approval = await makeTask({ createdBy: admin.id, title: '待审不可见', requirementId: req.id, status: 'PENDING_APPROVAL' })
    const unassigned = await makeTask({ createdBy: admin.id, title: '未指派不可见', requirementId: req.id, status: 'PUBLISHED' })
    await makeAssignee(todo.id, me.id, 'PENDING')
    await makeAssignee(review.id, me.id, 'PENDING_REVIEW')
    await makeAssignee(done.id, me.id, 'COMPLETED')
    await makeAssignee(closed.id, me.id, 'PENDING')
    await makeAssignee(draft.id, me.id, 'PENDING')
    await makeAssignee(approval.id, me.id, 'PENDING')
    await makeAssignee(unassigned.id, other.id, 'PENDING')

    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const todoRes = await request(app)
      .get('/api/app/standard-execution/tasks/list-v2?tab=todo&includeCounts=true')
      .set('Authorization', `Bearer ${token}`)
    expect(todoRes.status).toBe(200)
    expect(todoRes.body.total).toBe(1)
    expect(todoRes.body.counts).toMatchObject({ todo: 1, review: 1, done: 1, closed: 1 })
    expect(todoRes.body.data[0]).toMatchObject({
      assigneeUserId: me.id,
      assigneeStatus: 'PENDING',
      task: { id: todo.id, title: '待处理' },
    })
    expect(todoRes.body.data[0].availableActions).toEqual(['start'])
    expect(todoRes.body.data[0].task.basis[0]).toMatchObject({ requirementId: req.id, title: '个人端任务依据' })

    const reviewRes = await request(app)
      .get('/api/app/standard-execution/tasks/list-v2?tab=review')
      .set('Authorization', `Bearer ${token}`)
    expect(reviewRes.status).toBe(200)
    expect(reviewRes.body.data).toHaveLength(1)
    expect(reviewRes.body.data[0]).toMatchObject({
      assigneeStatus: 'PENDING_REVIEW',
      availableActions: ['viewReview'],
      task: { id: review.id },
    })

    const doneRes = await request(app)
      .get('/api/app/standard-execution/tasks/list-v2?tab=done')
      .set('Authorization', `Bearer ${token}`)
    expect(doneRes.status).toBe(200)
    expect(doneRes.body.data).toHaveLength(1)
    expect(doneRes.body.data[0]).toMatchObject({
      assigneeStatus: 'COMPLETED',
      availableActions: ['viewResult'],
      task: { id: done.id },
    })

    const closedRes = await request(app)
      .get('/api/app/standard-execution/tasks/list-v2?tab=closed')
      .set('Authorization', `Bearer ${token}`)
    expect(closedRes.status).toBe(200)
    expect(closedRes.body.data).toHaveLength(1)
    expect(closedRes.body.data[0]).toMatchObject({
      assigneeStatus: 'PENDING',
      availableActions: ['view'],
      task: { id: closed.id, status: 'CANCELLED' },
    })
  })

  it('支持 taskType、keyword、deadline 过滤', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const req = await makeRequirement(admin.id, '培训确认要求')
    const target = await makeTask({
      createdBy: admin.id,
      title: '年度培训任务',
      requirementId: req.id,
      status: 'PUBLISHED',
      taskType: 'TRAINING',
      deadlineAt: new Date(Date.now() + 3600000),
    })
    const other = await makeTask({
      createdBy: admin.id,
      title: '材料归档任务',
      requirementId: req.id,
      status: 'PUBLISHED',
      taskType: 'ARCHIVE_MATERIAL',
      deadlineAt: new Date(Date.now() + 3600000),
    })
    await makeAssignee(target.id, me.id, 'PENDING')
    await makeAssignee(other.id, me.id, 'PENDING')

    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .get('/api/app/standard-execution/tasks/list-v2?tab=todo&taskType=TRAINING&keyword=年度&deadline=dueSoon')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].task.id).toBe(target.id)
    expect(res.body.data[0].availableActions).toEqual(['start'])
  })
})
