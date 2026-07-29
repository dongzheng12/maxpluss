/**
 * standard-execution / Task — Admin 端 CRUD + 状态机 + Assignee 管理测试
 *
 * 覆盖：
 *  - happy path: create（DRAFT + Assignee）→ list/get → update → submit approval → approve → progress → cancel
 *  - 创建规则（doc §七.2）：
 *      requirement 不存在 400
 *      requirement DRAFT/DISABLED/ARCHIVED → 400
 *      reviewerId 不存在 400
 *      assigneeIds 含不存在用户 400
 *      assigneeIds 重复 400
 *      assigneeIds 空可保存草稿；提交审核时拦截
 *  - update：仅 DRAFT 可改；其他 409；全量替换 assignees；reviewer 重新校验
 *  - task approval：DRAFT→PENDING_APPROVAL→PUBLISHED；reject→DRAFT；旧 publish 409
 *  - cancel：DRAFT→CANCELLED / PUBLISHED→CANCELLED；COMPLETED→CANCELLED 409；CANCELLED→CANCELLED noop
 *  - progress：状态聚合 + isOverdue 字段
 *  - list：isOverdue 字段；按 status/reviewerId/assigneeId/keyword 过滤
 *  - 便捷端点：requirements/:id/create-task
 *  - 权限：401 / user 403 / sales 403
 *  - enterpriseId 隔离
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

async function makeAdminToken() {
  const admin = await createUser({ role: 'admin' })
  return { admin, token: getTestToken(admin.id, 'admin') }
}

async function makeActiveRequirement(adminId: string, opts: { enterpriseId?: string; status?: 'DRAFT' | 'ACTIVE' | 'DISABLED' | 'ARCHIVED' } = {}) {
  const src = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId: opts.enterpriseId ?? 'DEFAULT',
      title: '测试标准',
      sourceType: 'PRODUCT_STANDARD',
      createdBy: adminId,
    },
  })
  return prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId: opts.enterpriseId ?? 'DEFAULT',
      sourceId: src.id,
      title: '测试要求项',
      requirementText: '应每月检查',
      status: opts.status ?? 'ACTIVE',
      createdBy: adminId,
    },
  })
}

function validBody(requirementId: string, reviewerId: string, assigneeIds: string[]) {
  const deadline = new Date(Date.now() + 7 * 24 * 3600 * 1000) // 7 天后
  return {
    requirementId,
    title: '消防器材巡检任务',
    description: '本月巡检全部消防器材',
    submitRequirement: '提交检查照片 + 文字说明',
    deadlineAt: deadline.toISOString(),
    reviewerId,
    assigneeIds,
  }
}

const POST = '/api/admin/standard-execution/tasks'

// ═══════════════════════════════════════════════════════
// 创建
// ═══════════════════════════════════════════════════════

describe('POST /tasks — 创建', () => {
  it('happy path — 创建 DRAFT + N 条 Assignee PENDING', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const e1 = await createUser({ role: 'user' })
    const e2 = await createUser({ role: 'user' })
    const reviewer = await createUser({ role: 'user' })

    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, [e1.id, e2.id]))
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('DRAFT')
    expect(res.body.data.reviewerId).toBe(reviewer.id)
    expect(res.body.data.enterpriseId).toBe('DEFAULT')
    expect(res.body.data.isOverdue).toBe(false)

    const assignees = await prisma.standardExecutionTaskAssignee.findMany({
      where: { taskId: res.body.data.id },
    })
    expect(assignees.length).toBe(2)
    expect(assignees.every((a) => a.status === 'PENDING')).toBe(true)

    const task = await prisma.standardExecutionTask.findUnique({ where: { id: res.body.data.id } })
    expect(task?.basisSnapshots).toEqual([
      expect.objectContaining({
        requirementId: req.id,
        sourceId: req.sourceId,
        sourceTitle: '测试标准',
        sourceType: 'PRODUCT_STANDARD',
        title: '测试要求项',
        requirementText: '应每月检查',
      }),
    ])
  })

  it('T12 contract：创建 PHOTO 任务返回附件必传提交形式配置', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({
        ...validBody(req.id, reviewer.id, []),
        taskType: 'PHOTO',
        submitRequirement: '上传门岗巡查现场照片并填写时间地点',
      })

    expect(res.status).toBe(201)
    expect(res.body.data.submitFormConfig).toEqual(expect.objectContaining({
      version: 'T12_SUBMIT_FORM_V1',
      modes: expect.arrayContaining(['TEXT', 'ATTACHMENT']),
      attachment: expect.objectContaining({ required: true, minCount: 1 }),
      structured: expect.objectContaining({ type: null, itemCount: 0 }),
    }))
    expect(res.body.data.submitFormConfig.employeeHint).toContain('上传必需附件')
  })

  it('requirement 不存在 → 400', async () => {
    const { token } = await makeAdminToken()
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody('no-such', reviewer.id, [e1.id]))
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('执行要求不存在')
  })

  it('requirement DRAFT → 400（仅 ACTIVE 可创建）', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id, { status: 'DRAFT' })
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, [e1.id]))
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('ACTIVE')
  })

  it('requirement ARCHIVED → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id, { status: 'ARCHIVED' })
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, [e1.id]))
    expect(res.status).toBe(400)
  })

  it('reviewerId 不存在 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const e1 = await createUser({ role: 'user' })
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, 'no-such-reviewer', [e1.id]))
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('reviewerId')
  })

  it('assigneeIds 含不存在用户 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, [e1.id, 'ghost']))
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('ghost')
  })

  it('assigneeIds 重复 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, [e1.id, e1.id]))
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('重复')
  })

  it('assigneeIds 空 → 可保存草稿', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, []))
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('DRAFT')
  })

  it('跨企业 requirement → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const otherReq = await makeActiveRequirement(admin.id, { enterpriseId: 'OTHER' })
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(otherReq.id, reviewer.id, [e1.id]))
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════
// 便捷端点
// ═══════════════════════════════════════════════════════

describe('POST /requirements/:id/create-task — 便捷', () => {
  it('happy — requirementId 来自路径', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const body = validBody(req.id, reviewer.id, [e1.id])
    // body 里不传 requirementId
    const { requirementId: _ignored, ...rest } = body
    const res = await request(app)
      .post(`/api/admin/standard-execution/requirements/${req.id}/create-task`)
      .set('Authorization', `Bearer ${token}`)
      .send(rest)
    expect(res.status).toBe(201)
    expect(res.body.data.requirementId).toBe(req.id)
  })

  it('路径 requirementId 不存在 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const res = await request(app)
      .post('/api/admin/standard-execution/requirements/no-such/create-task')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'X',
        submitRequirement: 'X',
        deadlineAt: new Date(Date.now() + 86400000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [e1.id],
      })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════
// 列表 / 详情
// ═══════════════════════════════════════════════════════

describe('GET /tasks — 列表', () => {
  it('list + isOverdue 字段', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    // PUBLISHED + 过去 deadline → isOverdue=true
    await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'DEFAULT',
        requirementId: req.id,
        title: '已逾期',
        submitRequirement: 'x',
        deadlineAt: new Date(Date.now() - 86400000),
        reviewerId: admin.id,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        createdBy: admin.id,
      },
    })
    // DRAFT + 未来 deadline → isOverdue=false
    await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'DEFAULT',
        requirementId: req.id,
        title: '未到期',
        submitRequirement: 'x',
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: admin.id,
        createdBy: admin.id,
      },
    })

    const res = await request(app)
      .get('/api/admin/standard-execution/tasks')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.total).toBe(2)
    const overdue = res.body.data.find((t: { title: string }) => t.title === '已逾期')
    const onTime = res.body.data.find((t: { title: string }) => t.title === '未到期')
    expect(overdue.isOverdue).toBe(true)
    expect(onTime.isOverdue).toBe(false)
  })

  it('按 status / reviewerId / assigneeId / keyword 筛选', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })

    const tk = await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'DEFAULT',
        requirementId: req.id,
        title: 'GB 19001 巡检',
        submitRequirement: 'x',
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: reviewer.id,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        createdBy: admin.id,
      },
    })
    await prisma.standardExecutionTaskAssignee.create({
      data: { enterpriseId: 'DEFAULT', taskId: tk.id, assigneeId: e1.id },
    })

    await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'DEFAULT',
        requirementId: req.id,
        title: '其他任务',
        submitRequirement: 'x',
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: admin.id,
        createdBy: admin.id,
      },
    })

    const r1 = await request(app)
      .get('/api/admin/standard-execution/tasks?status=PUBLISHED')
      .set('Authorization', `Bearer ${token}`)
    expect(r1.body.total).toBe(1)

    const r2 = await request(app)
      .get(`/api/admin/standard-execution/tasks?reviewerId=${reviewer.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(r2.body.total).toBe(1)

    const r3 = await request(app)
      .get(`/api/admin/standard-execution/tasks?assigneeId=${e1.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(r3.body.total).toBe(1)

    const r4 = await request(app)
      .get('/api/admin/standard-execution/tasks?keyword=19001')
      .set('Authorization', `Bearer ${token}`)
    expect(r4.body.total).toBe(1)
  })

  it('enterpriseId 隔离', async () => {
    const { admin, token } = await makeAdminToken()
    const myReq = await makeActiveRequirement(admin.id)
    const otherReq = await makeActiveRequirement(admin.id, { enterpriseId: 'OTHER' })
    await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'DEFAULT',
        requirementId: myReq.id,
        title: 'mine',
        submitRequirement: 'x',
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: admin.id,
        createdBy: admin.id,
      },
    })
    await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'OTHER',
        requirementId: otherReq.id,
        title: 'other',
        submitRequirement: 'x',
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: admin.id,
        createdBy: admin.id,
      },
    })

    const res = await request(app)
      .get('/api/admin/standard-execution/tasks')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].title).toBe('mine')
  })
})

describe('GET /tasks/:id — 详情', () => {
  it('详情含 assignees / requirement / source', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const create = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, [e1.id]))
    const id = create.body.data.id

    const res = await request(app)
      .get(`/api/admin/standard-execution/tasks/${id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.assignees.length).toBe(1)
    expect(res.body.data.requirement.id).toBe(req.id)
    expect(res.body.data.requirement.source).toBeTruthy()
  })

  it('id 不存在 → 404', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .get('/api/admin/standard-execution/tasks/no-such')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════
// 编辑
// ═══════════════════════════════════════════════════════

describe('PATCH /tasks/:id — 编辑', () => {
  it('happy — 改 title + 全量替换 assignees', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const e2 = await createUser({ role: 'user' })
    const e3 = await createUser({ role: 'user' })
    const create = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, [e1.id, e2.id]))
    const id = create.body.data.id

    const res = await request(app)
      .patch(`/api/admin/standard-execution/tasks/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'new title', assigneeIds: [e3.id] })
    expect(res.status).toBe(200)
    expect(res.body.data.title).toBe('new title')
    const assignees = await prisma.standardExecutionTaskAssignee.findMany({ where: { taskId: id } })
    expect(assignees.length).toBe(1)
    expect(assignees[0].assigneeId).toBe(e3.id)
  })

  it('PUBLISHED 编辑 → 409', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const t = await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'DEFAULT',
        requirementId: req.id,
        title: 'X',
        submitRequirement: 'x',
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: admin.id,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        createdBy: admin.id,
      },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/tasks/${t.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'new' })
    expect(res.status).toBe(200) // P0-1: PUBLISHED 可改安全字段(标题)
  })

  it('id 不存在 → 404', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .patch('/api/admin/standard-execution/tasks/no-such')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'x' })
    expect(res.status).toBe(404)
  })

  it('改 reviewerId 不存在 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const create = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, [e1.id]))
    const res = await request(app)
      .patch(`/api/admin/standard-execution/tasks/${create.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reviewerId: 'ghost' })
    expect(res.status).toBe(400)
  })

  it('改 assigneeIds 含重复 → 400 (zod refine)', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const create = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, [e1.id]))
    const res = await request(app)
      .patch(`/api/admin/standard-execution/tasks/${create.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assigneeIds: [e1.id, e1.id] })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════
// 状态机：task approval / cancel
// ═══════════════════════════════════════════════════════

describe('任务审核：submit-approval / approve / reject', () => {
  it('旧 /publish 接口返回 409，防止绕过任务审核', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const create = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, [e1.id]))
    const res = await request(app)
      .post(`/api/admin/standard-execution/tasks/${create.body.data.id}/publish`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('请先提交审核')
  })

  it('DRAFT → PENDING_APPROVAL，写 submittedForApprovalAt + SUBMIT_APPROVAL 日志', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const create = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, [e1.id]))
    const res = await request(app)
      .post(`/api/admin/standard-execution/tasks/${create.body.data.id}/submit-approval`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('PENDING_APPROVAL')
    expect(res.body.data.submittedForApprovalAt).toBeTruthy()
    const log = await prisma.standardExecutionTaskApprovalLog.findFirstOrThrow({ where: { taskId: create.body.data.id } })
    expect(log.action).toBe('SUBMIT_APPROVAL')
    expect(log.fromStatus).toBe('DRAFT')
    expect(log.toStatus).toBe('PENDING_APPROVAL')
  })

  it('PENDING_APPROVAL → PUBLISHED，员工端审核通过后才可见', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const create = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, [e1.id]))
    const employeeToken = getTestToken(e1.id, 'user', { enterpriseId: 'DEFAULT' })
    const beforeVisible = await request(app)
      .get('/api/app/standard-execution/tasks?tab=todo')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(beforeVisible.body.total).toBe(0)

    await request(app)
      .post(`/api/admin/standard-execution/tasks/${create.body.data.id}/submit-approval`)
      .set('Authorization', `Bearer ${token}`)
    const res = await request(app)
      .post(`/api/admin/standard-execution/tasks/${create.body.data.id}/approval/approve`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('PUBLISHED')
    expect(res.body.data.publishedAt).toBeTruthy()
    expect(res.body.data.approvedAt).toBeTruthy()

    const afterVisible = await request(app)
      .get('/api/app/standard-execution/tasks?tab=todo')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(afterVisible.body.total).toBe(1)
  })

  it('PENDING_APPROVAL → DRAFT 驳回', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const create = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, [e1.id]))
    await request(app)
      .post(`/api/admin/standard-execution/tasks/${create.body.data.id}/submit-approval`)
      .set('Authorization', `Bearer ${token}`)
    const res = await request(app)
      .post(`/api/admin/standard-execution/tasks/${create.body.data.id}/approval/reject`)
      .set('Authorization', `Bearer ${token}`)
      .send({ comment: '资料不完整' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('DRAFT')
    expect(res.body.data.submittedForApprovalAt).toBeNull()
    const rejectLog = await prisma.standardExecutionTaskApprovalLog.findFirstOrThrow({
      where: { taskId: create.body.data.id, action: 'REJECT' },
    })
    expect(rejectLog.comment).toBe('资料不完整')
  })

  it('FIXED 截止已过：审核通过时按原工期自动顺延并返回 deadlineAdjusted', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const create = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, [e1.id]))
    await request(app)
      .post(`/api/admin/standard-execution/tasks/${create.body.data.id}/submit-approval`)
      .set('Authorization', `Bearer ${token}`)
    const submittedForApprovalAt = new Date(Date.now() - 2 * 86400000)
    const oldDeadlineAt = new Date(Date.now() - 86400000)
    await prisma.standardExecutionTask.update({
      where: { id: create.body.data.id },
      data: { submittedForApprovalAt, deadlineAt: oldDeadlineAt },
    })
    const res = await request(app)
      .post(`/api/admin/standard-execution/tasks/${create.body.data.id}/approval/approve`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.deadlineAdjusted).toBe(true)
    expect(new Date(res.body.newDeadlineAt).getTime()).toBeGreaterThan(Date.now())
    expect(res.body.oldDeadlineAt).toBeTruthy()
  })

  it('AFTER_APPROVAL_DAYS：审核通过时按 N 天计算 deadlineAt', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const create = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({
        ...validBody(req.id, reviewer.id, [e1.id]),
        deadlineMode: 'AFTER_APPROVAL_DAYS',
        deadlineDaysAfterApproval: 3,
      })
    await request(app)
      .post(`/api/admin/standard-execution/tasks/${create.body.data.id}/submit-approval`)
      .set('Authorization', `Bearer ${token}`)
    const res = await request(app)
      .post(`/api/admin/standard-execution/tasks/${create.body.data.id}/approval/approve`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const deltaDays = (new Date(res.body.newDeadlineAt).getTime() - Date.now()) / 86400000
    expect(deltaDays).toBeGreaterThan(2.9)
    expect(deltaDays).toBeLessThan(3.1)
  })

  it('assignees=0 提交审核 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const t = await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'DEFAULT',
        requirementId: req.id,
        title: 'X',
        submitRequirement: 'x',
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: admin.id,
        createdBy: admin.id,
      },
    })
    const res = await request(app)
      .post(`/api/admin/standard-execution/tasks/${t.id}/submit-approval`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('执行人')
  })
})

describe('POST /tasks/:id/cancel', () => {
  it('DRAFT → CANCELLED', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const reviewer = await createUser({ role: 'user' })
    const e1 = await createUser({ role: 'user' })
    const create = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(req.id, reviewer.id, [e1.id]))
    const res = await request(app)
      .post(`/api/admin/standard-execution/tasks/${create.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data.status).toBe('CANCELLED')
    expect(res.body.data.cancelledAt).toBeTruthy()
  })

  it('PUBLISHED → CANCELLED', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const t = await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'DEFAULT',
        requirementId: req.id,
        title: 'X',
        submitRequirement: 'x',
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: admin.id,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        createdBy: admin.id,
      },
    })
    const res = await request(app)
      .post(`/api/admin/standard-execution/tasks/${t.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data.status).toBe('CANCELLED')
  })

  it('COMPLETED → CANCELLED 非法 409', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const t = await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'DEFAULT',
        requirementId: req.id,
        title: 'X',
        submitRequirement: 'x',
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: admin.id,
        status: 'COMPLETED',
        publishedAt: new Date(),
        completedAt: new Date(),
        createdBy: admin.id,
      },
    })
    const res = await request(app)
      .post(`/api/admin/standard-execution/tasks/${t.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('CANCELLED → CANCELLED 幂等 noop', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const t = await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'DEFAULT',
        requirementId: req.id,
        title: 'X',
        submitRequirement: 'x',
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: admin.id,
        status: 'CANCELLED',
        cancelledAt: new Date(),
        createdBy: admin.id,
      },
    })
    const res = await request(app)
      .post(`/api/admin/standard-execution/tasks/${t.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.noop).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════
// 进度
// ═══════════════════════════════════════════════════════

describe('GET /tasks/:id/progress', () => {
  it('返回 byStatus 聚合 + isOverdue', async () => {
    const { admin, token } = await makeAdminToken()
    const req = await makeActiveRequirement(admin.id)
    const u1 = await createUser({ role: 'user' })
    const u2 = await createUser({ role: 'user' })
    const u3 = await createUser({ role: 'user' })
    const t = await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'DEFAULT',
        requirementId: req.id,
        title: 'X',
        submitRequirement: 'x',
        deadlineAt: new Date(Date.now() - 86400000), // 已逾期
        reviewerId: admin.id,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        createdBy: admin.id,
      },
    })
    await prisma.standardExecutionTaskAssignee.createMany({
      data: [
        { enterpriseId: 'DEFAULT', taskId: t.id, assigneeId: u1.id, status: 'PENDING' },
        { enterpriseId: 'DEFAULT', taskId: t.id, assigneeId: u2.id, status: 'COMPLETED' },
        { enterpriseId: 'DEFAULT', taskId: t.id, assigneeId: u3.id, status: 'PENDING_REVIEW' },
      ],
    })
    const res = await request(app)
      .get(`/api/admin/standard-execution/tasks/${t.id}/progress`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(3)
    expect(res.body.data.byStatus.PENDING).toBe(1)
    expect(res.body.data.byStatus.COMPLETED).toBe(1)
    expect(res.body.data.byStatus.PENDING_REVIEW).toBe(1)
    expect(res.body.data.isOverdue).toBe(true)
    // COMPLETED assignee 不算逾期
    const completed = res.body.data.assignees.find((a: { assigneeId: string }) => a.assigneeId === u2.id)
    expect(completed.isOverdue).toBe(false)
    const pending = res.body.data.assignees.find((a: { assigneeId: string }) => a.assigneeId === u1.id)
    expect(pending.isOverdue).toBe(true)
  })

  it('id 不存在 → 404', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .get('/api/admin/standard-execution/tasks/no-such/progress')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════
// 权限
// ═══════════════════════════════════════════════════════

describe('权限', () => {
  it('无 token → 401', async () => {
    const res = await request(app).get('/api/admin/standard-execution/tasks')
    expect(res.status).toBe(401)
  })

  it('user role → 403', async () => {
    const u = await createUser({ role: 'user' })
    const token = getTestToken(u.id, 'user')
    const res = await request(app)
      .get('/api/admin/standard-execution/tasks')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('sales role → 403', async () => {
    const u = await createUser({ role: 'sales' })
    const token = getTestToken(u.id, 'sales')
    const res = await request(app)
      .get('/api/admin/standard-execution/tasks')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })
})

describe('Task 批量操作 — batch-cancel / batch-publish / batch-assign', () => {
  async function makeTask(
    adminId: string,
    opts: { status?: 'DRAFT' | 'PENDING_APPROVAL' | 'PUBLISHED' | 'COMPLETED' | 'CANCELLED'; withAssignee?: boolean; enterpriseId?: string } = {},
  ) {
    const ent = opts.enterpriseId ?? 'DEFAULT'
    const req = await makeActiveRequirement(adminId, { enterpriseId: ent })
    const task = await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: ent,
        requirementId: req.id,
        title: '批量任务',
        submitRequirement: '提交照片',
        deadlineAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        reviewerId: adminId,
        status: opts.status ?? 'DRAFT',
        createdBy: adminId,
      },
    })
    if (opts.withAssignee) {
      await prisma.standardExecutionTaskAssignee.create({
        data: { enterpriseId: ent, taskId: task.id, assigneeId: adminId },
      })
    }
    return task
  }

  describe('POST /tasks/batch-cancel', () => {
    const PATH = '/api/admin/standard-execution/tasks/batch-cancel'
    it('DRAFT/PENDING_APPROVAL/PUBLISHED → CANCELLED；COMPLETED 落入 skipped', async () => {
      const { admin, token } = await makeAdminToken()
      const draft = await makeTask(admin.id, { status: 'DRAFT' })
      const pending = await makeTask(admin.id, { status: 'PENDING_APPROVAL' })
      const published = await makeTask(admin.id, { status: 'PUBLISHED' })
      const completed = await makeTask(admin.id, { status: 'COMPLETED' })
      const res = await request(app)
        .post(PATH)
        .set('Authorization', `Bearer ${token}`)
        .send({ ids: [draft.id, pending.id, published.id, completed.id] })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(3)
      expect(res.body.skipped).toBe(1)
      const d = await prisma.standardExecutionTask.findUnique({ where: { id: draft.id } })
      expect(d?.status).toBe('CANCELLED')
      expect(d?.cancelledAt).not.toBeNull()
      const p = await prisma.standardExecutionTask.findUnique({ where: { id: pending.id } })
      expect(p?.status).toBe('CANCELLED')
      const c = await prisma.standardExecutionTask.findUnique({ where: { id: completed.id } })
      expect(c?.status).toBe('COMPLETED')
    })
    it('user role → 403', async () => {
      const u = await createUser({ role: 'user' })
      const res = await request(app)
        .post(PATH)
        .set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`)
        .send({ ids: ['x'] })
      expect(res.status).toBe(403)
    })
  })

  describe('POST /tasks/batch-publish', () => {
    const PATH = '/api/admin/standard-execution/tasks/batch-publish'
    it('旧批量发布接口返回 409，防止绕过任务审核', async () => {
      const { admin, token } = await makeAdminToken()
      const ok = await makeTask(admin.id, { status: 'DRAFT', withAssignee: true })
      const res = await request(app)
        .post(PATH)
        .set('Authorization', `Bearer ${token}`)
        .send({ ids: [ok.id] })
      expect(res.status).toBe(409)
      expect(res.body.error).toContain('请先提交审核')
      const o = await prisma.standardExecutionTask.findUnique({ where: { id: ok.id } })
      expect(o?.status).toBe('DRAFT')
    })
  })

  describe('POST /tasks/batch-assign', () => {
    const PATH = '/api/admin/standard-execution/tasks/batch-assign'
    it('给 DRAFT 任务统一改派 reviewer+执行人；非 DRAFT 落入 skipped', async () => {
      const { admin, token } = await makeAdminToken()
      const reviewer = await createUser({ role: 'user' })
      const assignee = await createUser({ role: 'user' })
      const draft = await makeTask(admin.id, { status: 'DRAFT' })
      const published = await makeTask(admin.id, { status: 'PUBLISHED' })
      const res = await request(app)
        .post(PATH)
        .set('Authorization', `Bearer ${token}`)
        .send({ ids: [draft.id, published.id], reviewerId: reviewer.id, assigneeIds: [assignee.id] })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(1)
      expect(res.body.skipped).toBe(1)
      const d = await prisma.standardExecutionTask.findUnique({ where: { id: draft.id } })
      expect(d?.reviewerId).toBe(reviewer.id)
      const ass = await prisma.standardExecutionTaskAssignee.findMany({ where: { taskId: draft.id } })
      expect(ass.length).toBe(1)
      expect(ass[0]!.assigneeId).toBe(assignee.id)
    })
    it('reviewerId 不存在 → 400', async () => {
      const { admin, token } = await makeAdminToken()
      const draft = await makeTask(admin.id, { status: 'DRAFT' })
      const assignee = await createUser({ role: 'user' })
      const res = await request(app)
        .post(PATH)
        .set('Authorization', `Bearer ${token}`)
        .send({ ids: [draft.id], reviewerId: 'no-such-user', assigneeIds: [assignee.id] })
      expect(res.status).toBe(400)
    })
  })
})
