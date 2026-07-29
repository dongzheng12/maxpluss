/**
 * StandardExecutionPlan — 创建接口测试
 *
 * 覆盖：
 *  - admin  POST /api/admin/standard-execution/plans
 *    - happy path → 201 + data.status==='DRAFT' + roundNumber===1
 *    - 无 token → 401
 *    - user role → 403
 *    - sales role → 403
 *    - 跨企业 sourceId（source 属于别的 enterprise）→ 400
 *    - 参数缺失 → 400
 *  - enterprise POST /api/enterprise/standard-execution/plans
 *    - 企业成员创建 → 201
 *    - 普通 user（无 enterpriseId）→ 403
 *    - 跨企业 sourceId → 400
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerStandardExecutionRoutes } from '../src/standard-execution/sourceRoutes.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { createUser, getTestToken } from './factory.js'
import { computeNextPlanRunAt, runDueStandardExecutionPlans } from '../src/jobs/sePlanRun.job.js'

// ─── App setup ─────────────────────────────────────────────
const adminApp = express()
adminApp.use(express.json())
const enterpriseApp = express()
enterpriseApp.use(express.json())

beforeAll(() => {
  registerStandardExecutionRoutes(adminApp)
  registerEnterpriseRoutes(enterpriseApp)
})

// ─── beforeEach：清 SE 数据 + 准备 Enterprise 记录 ──────────
beforeEach(async () => {
  // FK 顺序：子表先删
  await cleanStandardExecutionData()
  // AppUser 清理（测试全局共用一个 DB）——先清所有 userId RESTRICT FK 再删 user
  await prisma.adminUserRole.deleteMany()
  await prisma.salesProfile.deleteMany()
  await prisma.userCoupon.deleteMany()
  await prisma.userMembership.deleteMany()
  await prisma.notification.deleteMany()
  await prisma.chatMessage.deleteMany()
  await prisma.conversation.deleteMany()
  await prisma.appUser.deleteMany()

  // 企业准备：DEFAULT（admin 通配）+ ENT_A（企业成员）+ ENT_B（跨企业拦截）
  for (const id of ['DEFAULT', 'ENT_A', 'ENT_B']) {
    await prisma.enterprise.upsert({
      where: { id },
      update: { name: id, status: 'ACTIVE' },
      create: { id, name: id, code: id, status: 'ACTIVE' },
    })
  }
})

// ─── helpers ─────────────────────────────────────────────────

async function makeAdminToken() {
  const admin = await createUser({ role: 'admin' })
  return { admin, token: getTestToken(admin.id, 'admin') }
}

async function makeSource(
  adminId: string,
  overrides: Partial<{ enterpriseId: string; title: string }> = {},
) {
  return prisma.standardExecutionSource.create({
    data: {
      enterpriseId: overrides.enterpriseId ?? 'DEFAULT',
      title: overrides.title ?? '测试标准',
      sourceType: 'PRODUCT_STANDARD',
      createdBy: adminId,
    },
  })
}

async function makeEnterpriseUser(
  enterpriseId: string,
  enterpriseRole: 'ADMIN' | 'MANAGER' | 'REVIEWER' | 'EMPLOYEE',
) {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: user.id },
    data: { enterpriseId, enterpriseRole },
  })
  return { user, token: getTestToken(user.id, 'user') }
}

function validBody(sourceId: string, overrides: Record<string, unknown> = {}) {
  return {
    sourceId,
    title: '2024 年第一轮执行计划',
    ...overrides,
  }
}

// ─── Admin 端：POST /api/admin/standard-execution/plans ──────

describe('POST /api/admin/standard-execution/plans', () => {
  it('happy path — 201 + status=DRAFT + roundNumber=1 + createdBy=admin', async () => {
    const { admin, token } = await makeAdminToken()
    const source = await makeSource(admin.id)
    const res = await request(adminApp)
      .post('/api/admin/standard-execution/plans')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(source.id))
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('DRAFT')
    expect(res.body.data.roundNumber).toBe(1)
    expect(res.body.data.enterpriseId).toBe('DEFAULT')
    expect(res.body.data.sourceId).toBe(source.id)
    expect(res.body.data.createdBy).toBe(admin.id)
    expect(res.body.data.title).toBe('2024 年第一轮执行计划')
  })

  it('roundNumber 自定义 + scheduledAt 传递', async () => {
    const { admin, token } = await makeAdminToken()
    const source = await makeSource(admin.id)
    const scheduledAt = new Date('2025-09-01T09:00:00.000Z').toISOString()
    const res = await request(adminApp)
      .post('/api/admin/standard-execution/plans')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(source.id, { roundNumber: 3, scheduledAt }))
    expect(res.status).toBe(201)
    expect(res.body.data.roundNumber).toBe(3)
    expect(res.body.data.scheduledAt).toBeTruthy()
  })

  it('无 token → 401', async () => {
    const { admin } = await makeAdminToken()
    const source = await makeSource(admin.id)
    const res = await request(adminApp)
      .post('/api/admin/standard-execution/plans')
      .send(validBody(source.id))
    expect(res.status).toBe(401)
  })

  it('user role → 403', async () => {
    const { admin } = await makeAdminToken()
    const source = await makeSource(admin.id)
    const user = await createUser({ role: 'user' })
    const userToken = getTestToken(user.id, 'user')
    const res = await request(adminApp)
      .post('/api/admin/standard-execution/plans')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validBody(source.id))
    expect(res.status).toBe(403)
  })

  it('sales role → 403', async () => {
    const { admin } = await makeAdminToken()
    const source = await makeSource(admin.id)
    const sales = await createUser({ role: 'sales' })
    const salesToken = getTestToken(sales.id, 'sales')
    const res = await request(adminApp)
      .post('/api/admin/standard-execution/plans')
      .set('Authorization', `Bearer ${salesToken}`)
      .send(validBody(source.id))
    expect(res.status).toBe(403)
  })

  it('跨企业 sourceId（source 属于 ENT_B）→ 400', async () => {
    const { admin, token } = await makeAdminToken()
    // admin 通配 DEFAULT，但 source 属于 ENT_B
    const otherSource = await makeSource(admin.id, { enterpriseId: 'ENT_B' })
    const res = await request(adminApp)
      .post('/api/admin/standard-execution/plans')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(otherSource.id))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/不存在|不属于/)
  })

  it('sourceId 不存在 → 400', async () => {
    const { token } = await makeAdminToken()
    const res = await request(adminApp)
      .post('/api/admin/standard-execution/plans')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody('non-existent-source-id'))
    expect(res.status).toBe(400)
  })

  it('缺少 title → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const source = await makeSource(admin.id)
    const res = await request(adminApp)
      .post('/api/admin/standard-execution/plans')
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: source.id }) // 缺 title
    expect(res.status).toBe(400)
  })

  it('缺少 sourceId → 400', async () => {
    const { token } = await makeAdminToken()
    const res = await request(adminApp)
      .post('/api/admin/standard-execution/plans')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '无 sourceId' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/enterprise/standard-execution/plans/:id/generate-tasks', () => {
  async function setupGenerateScene() {
    const reviewer = await makeEnterpriseUser('ENT_A', 'REVIEWER')
    const employee = await makeEnterpriseUser('ENT_A', 'EMPLOYEE')
    const source = await makeSource(reviewer.user.id, { enterpriseId: 'ENT_A' })
    const requirements = [
      await makeRequirement(reviewer.user.id, source.id, 'ENT_A', { title: '设备巡检 A' }),
      await makeRequirement(reviewer.user.id, source.id, 'ENT_A', { title: '设备巡检 B' }),
    ]
    const plan = await prisma.standardExecutionPlan.create({
      data: {
        enterpriseId: 'ENT_A',
        sourceId: source.id,
        title: '第一轮执行计划',
        roundNumber: 1,
        scheduledAt: new Date('2026-06-05T10:00:00.000Z'),
        createdBy: reviewer.user.id,
      },
    })
    return { reviewer, employee, source, requirements, plan }
  }

  it('发起本轮执行 happy：生成 DRAFT Task + TaskItem', async () => {
    const { reviewer, employee, requirements, plan } = await setupGenerateScene()
    const res = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${plan.id}/generate-tasks`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({
        requirementIds: requirements.map((r) => r.id),
        taskType: 'INSPECTION_FILL',
        taskStatus: 'DRAFT',
        reviewerId: reviewer.user.id,
        assigneeIds: [employee.user.id],
      })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ ok: true, createdTasks: 1, createdItems: 2, skippedExisting: 0, taskStatus: 'DRAFT' })
    const task = await prisma.standardExecutionTask.findFirstOrThrow({ where: { planId: plan.id } })
    expect(task.status).toBe('DRAFT')
    expect(await prisma.standardExecutionTaskItem.count({ where: { taskId: task.id } })).toBe(2)
  })

  it('提交审核：生成待审核 Task + submittedForApprovalAt', async () => {
    const { reviewer, employee, requirements, plan } = await setupGenerateScene()
    const res = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${plan.id}/generate-tasks`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({
        requirementIds: requirements.map((r) => r.id),
        taskType: 'INSPECTION_FILL',
        taskStatus: 'PENDING_APPROVAL',
        reviewerId: reviewer.user.id,
        assigneeIds: [employee.user.id],
      })
    expect(res.status).toBe(201)
    expect(res.body.taskStatus).toBe('PENDING_APPROVAL')
    const task = await prisma.standardExecutionTask.findFirstOrThrow({ where: { planId: plan.id } })
    expect(task.status).toBe('PENDING_APPROVAL')
    expect(task.submittedForApprovalAt).toBeTruthy()
    expect(task.publishedAt).toBeNull()
  })

  it('重复发起同一批执行要求幂等：不重复创建任务', async () => {
    const { reviewer, employee, requirements, plan } = await setupGenerateScene()
    const body = {
      requirementIds: requirements.map((r) => r.id),
      taskType: 'INSPECTION_FILL',
      reviewerId: reviewer.user.id,
      assigneeIds: [employee.user.id],
    }
    const first = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${plan.id}/generate-tasks`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send(body)
    expect(first.status).toBe(201)

    const second = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${plan.id}/generate-tasks`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send(body)
    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({ ok: true, createdTasks: 0, createdItems: 0, skippedExisting: 2 })
    expect(await prisma.standardExecutionTask.count({ where: { planId: plan.id } })).toBe(1)
  })

  it('跨企业 planId → 404', async () => {
    const { reviewer, employee, requirements } = await setupGenerateScene()
    const bSource = await makeSource(reviewer.user.id, { enterpriseId: 'ENT_B' })
    const bPlan = await prisma.standardExecutionPlan.create({
      data: { enterpriseId: 'ENT_B', sourceId: bSource.id, title: '其他企业计划', createdBy: reviewer.user.id },
    })
    const res = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${bPlan.id}/generate-tasks`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({
        requirementIds: requirements.map((r) => r.id),
        taskType: 'INSPECTION_FILL',
        reviewerId: reviewer.user.id,
        assigneeIds: [employee.user.id],
      })
    expect(res.status).toBe(404)
  })

  it('EMPLOYEE 无权发起本轮执行 → 403', async () => {
    const { employee, reviewer, requirements, plan } = await setupGenerateScene()
    const res = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${plan.id}/generate-tasks`)
      .set('Authorization', `Bearer ${employee.token}`)
      .send({
        requirementIds: requirements.map((r) => r.id),
        taskType: 'INSPECTION_FILL',
        reviewerId: reviewer.user.id,
        assigneeIds: [employee.user.id],
      })
    expect(res.status).toBe(403)
  })
})

// ─── Enterprise 端：POST /api/enterprise/standard-execution/plans ──

describe('POST /api/enterprise/standard-execution/plans (enterprise)', () => {
  it('企业成员 REVIEWER（ENT_A）创建 → 201 + enterpriseId=ENT_A', async () => {
    const { admin } = await makeAdminToken()
    const source = await makeSource(admin.id, { enterpriseId: 'ENT_A' })

    const reviewer = await createUser({ role: 'user' })
    await prisma.appUser.update({
      where: { id: reviewer.id },
      data: { enterpriseId: 'ENT_A', enterpriseRole: 'REVIEWER' },
    })
    const reviewerToken = getTestToken(reviewer.id, 'user')

    const res = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send(validBody(source.id))
    expect(res.status).toBe(201)
    expect(res.body.data.enterpriseId).toBe('ENT_A')
    expect(res.body.data.status).toBe('DRAFT')
    expect(res.body.data.createdBy).toBe(reviewer.id)
  })

  it('企业成员创建周期计划 → 保存频率与默认派发参数', async () => {
    const { admin } = await makeAdminToken()
    const source = await makeSource(admin.id, { enterpriseId: 'ENT_A' })
    const reviewer = await makeEnterpriseUser('ENT_A', 'REVIEWER')
    const employee = await makeEnterpriseUser('ENT_A', 'EMPLOYEE')
    const nextRunAt = '2026-06-10T02:00:00.000Z'

    const res = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send(validBody(source.id, {
        frequency: 'weekly',
        startAt: '2026-06-04T00:00:00.000Z',
        endAt: '2026-12-31T23:59:59.000Z',
        nextRunAt,
        defaultReviewerId: reviewer.user.id,
        defaultAssigneeIds: [employee.user.id],
        defaultTaskType: 'INSPECTION_FILL',
        defaultDeadlineMode: 'AFTER_APPROVAL_DAYS',
        defaultDeadlineDaysAfterApproval: 7,
      }))
    expect(res.status).toBe(201)
    expect(res.body.data.frequency).toBe('weekly')
    expect(res.body.data.nextRunAt).toBeTruthy()
    expect(res.body.data.defaultReviewerId).toBe(reviewer.user.id)
    expect(res.body.data.defaultAssigneeIds).toEqual([employee.user.id])
    expect(res.body.data.defaultDeadlineMode).toBe('AFTER_APPROVAL_DAYS')
    expect(res.body.data.defaultDeadlineDaysAfterApproval).toBe(7)
  })

  it('普通 user（无 enterpriseId）→ 403', async () => {
    const { admin } = await makeAdminToken()
    const source = await makeSource(admin.id, { enterpriseId: 'ENT_A' })
    const plain = await createUser({ role: 'user' })
    const plainToken = getTestToken(plain.id, 'user')
    const res = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${plainToken}`)
      .send(validBody(source.id))
    expect(res.status).toBe(403)
  })

  it('跨企业 sourceId（source 属于 ENT_B，用户属于 ENT_A）→ 400', async () => {
    const { admin } = await makeAdminToken()
    const bSource = await makeSource(admin.id, { enterpriseId: 'ENT_B' })

    const reviewer = await createUser({ role: 'user' })
    await prisma.appUser.update({
      where: { id: reviewer.id },
      data: { enterpriseId: 'ENT_A', enterpriseRole: 'REVIEWER' },
    })
    const reviewerToken = getTestToken(reviewer.id, 'user')

    const res = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send(validBody(bSource.id))
    expect(res.status).toBe(400)
  })

  it('EMPLOYEE 角色 POST /plans → 403', async () => {
    const { admin } = await makeAdminToken()
    const source = await makeSource(admin.id, { enterpriseId: 'ENT_A' })

    const employee = await createUser({ role: 'user' })
    await prisma.appUser.update({
      where: { id: employee.id },
      data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' },
    })
    const empToken = getTestToken(employee.id, 'user')

    const res = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${empToken}`)
      .send(validBody(source.id))
    expect(res.status).toBe(403)
  })
})

// ─── Step2：Plan CRUD + Task 绑定 ─────────────────────────────────

// helper：创建 requirement
async function makeRequirement(
  adminId: string,
  sourceId: string,
  enterpriseId = 'ENT_A',
  overrides: Partial<{ title: string; recommendedTaskType: string; clauseNo: string; executionDescription: string }> = {},
) {
  return prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId,
      sourceId,
      title: overrides.title ?? '测试要求',
      clauseNo: overrides.clauseNo ?? null,
      requirementText: '测试要求文本',
      status: 'ACTIVE',
      generateMode: 'MANUAL',
      recommendedTaskType: overrides.recommendedTaskType ?? null,
      executionDescription: overrides.executionDescription ?? null,
      createdBy: adminId,
    },
  })
}

// helper：创建 task（直接入库，planId nullable）
async function makeTask(
  adminId: string,
  requirementId: string,
  reviewerId: string,
  overrides: Partial<{ enterpriseId: string; planId: string | null }> = {},
) {
  return prisma.standardExecutionTask.create({
    data: {
      enterpriseId: overrides.enterpriseId ?? 'ENT_A',
      requirementId,
      planId: overrides.planId ?? null,
      title: '测试任务',
      deadlineAt: new Date('2030-01-01T00:00:00Z'),
      reviewerId,
      status: 'DRAFT',
      createdBy: adminId,
    },
  })
}

// helper：创建 REVIEWER token
async function makeReviewerToken(enterpriseId = 'ENT_A') {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: user.id },
    data: { enterpriseId, enterpriseRole: 'REVIEWER' },
  })
  return { user, token: getTestToken(user.id, 'user') }
}

// helper：创建 EMPLOYEE token（用于只读测试）
async function makeEmployeeToken(enterpriseId = 'ENT_A') {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: user.id },
    data: { enterpriseId, enterpriseRole: 'EMPLOYEE' },
  })
  return { user, token: getTestToken(user.id, 'user') }
}

describe('Plan CRUD + Task 绑定 — happy path e2e', () => {
  it('创建 Plan → 绑定多个 Task → GET 详情含 tasks → 解绑单个 → DELETE plan 软删 CANCELLED', async () => {
    const { admin } = await makeAdminToken()
    const { user: reviewer, token: reviewerToken } = await makeReviewerToken('ENT_A')

    const source = await makeSource(admin.id, { enterpriseId: 'ENT_A' })
    const req1 = await makeRequirement(admin.id, source.id, 'ENT_A')
    const req2 = await makeRequirement(admin.id, source.id, 'ENT_A')
    const task1 = await makeTask(admin.id, req1.id, reviewer.id, { enterpriseId: 'ENT_A' })
    const task2 = await makeTask(admin.id, req2.id, reviewer.id, { enterpriseId: 'ENT_A' })

    // 1. 创建 Plan
    const createRes = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ sourceId: source.id, title: 'E2E 测试计划' })
    expect(createRes.status).toBe(201)
    const planId = createRes.body.data.id
    expect(planId).toBeTruthy()
    expect(createRes.body.data.status).toBe('DRAFT')

    // 2. 绑定两个 task
    const bindRes = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${planId}/tasks`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ taskIds: [task1.id, task2.id] })
    expect(bindRes.status).toBe(200)
    expect(bindRes.body.ok).toBe(true)
    expect(bindRes.body.bound).toBe(2)

    // 3. GET 详情含 tasks
    const detailRes = await request(enterpriseApp)
      .get(`/api/enterprise/standard-execution/plans/${planId}`)
      .set('Authorization', `Bearer ${reviewerToken}`)
    expect(detailRes.status).toBe(200)
    expect(detailRes.body.data.tasks).toHaveLength(2)

    // 4. DELETE 解绑 task1
    const unbindRes = await request(enterpriseApp)
      .delete(`/api/enterprise/standard-execution/plans/${planId}/tasks/${task1.id}`)
      .set('Authorization', `Bearer ${reviewerToken}`)
    expect(unbindRes.status).toBe(200)
    expect(unbindRes.body.ok).toBe(true)
    const t1After = await prisma.standardExecutionTask.findUnique({ where: { id: task1.id } })
    expect(t1After?.planId).toBeNull()

    // 5. DELETE plan（软删）→ status=CANCELLED，plan 记录仍在，关联 task.planId 保留
    const deleteRes = await request(enterpriseApp)
      .delete(`/api/enterprise/standard-execution/plans/${planId}`)
      .set('Authorization', `Bearer ${reviewerToken}`)
    expect(deleteRes.status).toBe(200)
    expect(deleteRes.body.data.status).toBe('CANCELLED')
    const planAfter = await prisma.standardExecutionPlan.findUnique({ where: { id: planId } })
    expect(planAfter?.status).toBe('CANCELLED')
    const t2After = await prisma.standardExecutionTask.findUnique({ where: { id: task2.id } })
    expect(t2After?.planId).toBe(planId)
  })
})

describe('GET /api/enterprise/standard-execution/plans — 列表', () => {
  it('EMPLOYEE 可读列表 → 200', async () => {
    const { admin } = await makeAdminToken()
    const { token: reviewerToken } = await makeReviewerToken('ENT_A')
    const { token: empToken } = await makeEmployeeToken('ENT_A')
    const source = await makeSource(admin.id, { enterpriseId: 'ENT_A' })
    await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ sourceId: source.id, title: '计划1' })

    const res = await request(enterpriseApp)
      .get('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${empToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBeGreaterThanOrEqual(1)
    expect(res.body.total).toBeGreaterThanOrEqual(1)
  })

  it('无 enterpriseId 普通 user → 403', async () => {
    const plain = await createUser({ role: 'user' })
    const plainToken = getTestToken(plain.id, 'user')
    const res = await request(enterpriseApp)
      .get('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${plainToken}`)
    expect(res.status).toBe(403)
  })
})

describe('GET /api/enterprise/standard-execution/plans/:id — 详情', () => {
  it('不存在 planId → 404', async () => {
    const { token: reviewerToken } = await makeReviewerToken('ENT_A')
    const res = await request(enterpriseApp)
      .get('/api/enterprise/standard-execution/plans/non-existent-plan-id')
      .set('Authorization', `Bearer ${reviewerToken}`)
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/enterprise/standard-execution/plans/:id — 更新', () => {
  it('REVIEWER 更新 title/status → 200', async () => {
    const { admin } = await makeAdminToken()
    const { token: reviewerToken } = await makeReviewerToken('ENT_A')
    const source = await makeSource(admin.id, { enterpriseId: 'ENT_A' })
    const createRes = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ sourceId: source.id, title: '原始标题' })
    const planId = createRes.body.data.id

    const res = await request(enterpriseApp)
      .patch(`/api/enterprise/standard-execution/plans/${planId}`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ title: '新标题', status: 'ACTIVE' })
    expect(res.status).toBe(200)
    expect(res.body.data.title).toBe('新标题')
    expect(res.body.data.status).toBe('ACTIVE')
  })

  it('EMPLOYEE 做 PATCH → 403', async () => {
    const { admin } = await makeAdminToken()
    const { token: reviewerToken } = await makeReviewerToken('ENT_A')
    const { token: empToken } = await makeEmployeeToken('ENT_A')
    const source = await makeSource(admin.id, { enterpriseId: 'ENT_A' })
    const createRes = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ sourceId: source.id, title: '测试计划' })
    const planId = createRes.body.data.id

    const res = await request(enterpriseApp)
      .patch(`/api/enterprise/standard-execution/plans/${planId}`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({ title: '尝试修改' })
    expect(res.status).toBe(403)
  })

  it('不存在 planId PATCH → 404', async () => {
    const { token: reviewerToken } = await makeReviewerToken('ENT_A')
    const res = await request(enterpriseApp)
      .patch('/api/enterprise/standard-execution/plans/non-existent-id')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ title: '无效' })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/enterprise/standard-execution/plans/:id — 删除', () => {
  it('EMPLOYEE 做 DELETE → 403', async () => {
    const { admin } = await makeAdminToken()
    const { token: reviewerToken } = await makeReviewerToken('ENT_A')
    const { token: empToken } = await makeEmployeeToken('ENT_A')
    const source = await makeSource(admin.id, { enterpriseId: 'ENT_A' })
    const createRes = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ sourceId: source.id, title: '删除测试' })
    const planId = createRes.body.data.id

    const res = await request(enterpriseApp)
      .delete(`/api/enterprise/standard-execution/plans/${planId}`)
      .set('Authorization', `Bearer ${empToken}`)
    expect(res.status).toBe(403)
  })

  it('不存在 planId DELETE → 404', async () => {
    const { token: reviewerToken } = await makeReviewerToken('ENT_A')
    const res = await request(enterpriseApp)
      .delete('/api/enterprise/standard-execution/plans/no-such-plan')
      .set('Authorization', `Bearer ${reviewerToken}`)
    expect(res.status).toBe(404)
  })
})

describe('POST /api/enterprise/standard-execution/plans/:id/tasks — 绑定', () => {
  it('绑定属于别的 Enterprise 的 taskId → 宽松跳过（200，bound=0，task 未绑定）', async () => {
    const { admin } = await makeAdminToken()
    const { user: reviewer, token: reviewerToken } = await makeReviewerToken('ENT_A')

    // ENT_A source + plan
    const sourceA = await makeSource(admin.id, { enterpriseId: 'ENT_A' })
    const createRes = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ sourceId: sourceA.id, title: '计划A' })
    const planId = createRes.body.data.id

    // ENT_B 的 task
    const sourceB = await makeSource(admin.id, { enterpriseId: 'ENT_B' })
    const reqB = await makeRequirement(admin.id, sourceB.id, 'ENT_B')
    const taskB = await makeTask(admin.id, reqB.id, reviewer.id, { enterpriseId: 'ENT_B' })

    const res = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${planId}/tasks`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ taskIds: [taskB.id] })
    // updateMany where 带 enterpriseId，跨企业 task 不被绑定
    expect(res.status).toBe(200)
    expect(res.body.bound).toBe(0)
    const tb = await prisma.standardExecutionTask.findUnique({ where: { id: taskB.id } })
    expect(tb?.planId).toBeNull()
  })

  it('重复绑定同一 task 幂等（再 POST 不报错）', async () => {
    const { admin } = await makeAdminToken()
    const { user: reviewer, token: reviewerToken } = await makeReviewerToken('ENT_A')
    const source = await makeSource(admin.id, { enterpriseId: 'ENT_A' })
    const req1 = await makeRequirement(admin.id, source.id, 'ENT_A')
    const task1 = await makeTask(admin.id, req1.id, reviewer.id, { enterpriseId: 'ENT_A' })

    const createRes = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ sourceId: source.id, title: '幂等测试计划' })
    const planId = createRes.body.data.id

    // 第一次绑定
    const r1 = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${planId}/tasks`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ taskIds: [task1.id] })
    expect(r1.status).toBe(200)

    // 第二次重复绑定 → 幂等，不报错
    const r2 = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${planId}/tasks`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ taskIds: [task1.id] })
    expect(r2.status).toBe(200)

    const t = await prisma.standardExecutionTask.findUnique({ where: { id: task1.id } })
    expect(t?.planId).toBe(planId)
  })

  it('不存在 planId 绑定 → 404', async () => {
    const { token: reviewerToken } = await makeReviewerToken('ENT_A')
    const res = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans/non-existent/tasks')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ taskIds: ['some-id'] })
    expect(res.status).toBe(404)
  })

  it('EMPLOYEE 绑定 task → 403', async () => {
    const { admin } = await makeAdminToken()
    const { token: reviewerToken } = await makeReviewerToken('ENT_A')
    const { token: empToken } = await makeEmployeeToken('ENT_A')
    const source = await makeSource(admin.id, { enterpriseId: 'ENT_A' })
    const createRes = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ sourceId: source.id, title: '权限测试' })
    const planId = createRes.body.data.id

    const res = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${planId}/tasks`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({ taskIds: ['some-id'] })
    expect(res.status).toBe(403)
  })
})

describe('DELETE /api/enterprise/standard-execution/plans/:id/tasks/:taskId — 解绑', () => {
  it('task 不存在或不属于当前企业 → 404', async () => {
    const { admin } = await makeAdminToken()
    const { token: reviewerToken } = await makeReviewerToken('ENT_A')
    const source = await makeSource(admin.id, { enterpriseId: 'ENT_A' })
    const createRes = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ sourceId: source.id, title: '解绑测试' })
    const planId = createRes.body.data.id

    const res = await request(enterpriseApp)
      .delete(`/api/enterprise/standard-execution/plans/${planId}/tasks/non-existent-task`)
      .set('Authorization', `Bearer ${reviewerToken}`)
    expect(res.status).toBe(404)
  })
})

// ─── POST /api/enterprise/standard-execution/plans/:id/generate-tasks ────

describe('POST /plans/:id/generate-tasks — 生成任务', () => {
  async function makeReviewer2(enterpriseId = 'ENT_A') {
    const user = await createUser({ role: 'user' })
    await prisma.appUser.update({
      where: { id: user.id },
      data: { enterpriseId, enterpriseRole: 'REVIEWER' },
    })
    return { user, token: getTestToken(user.id, 'user') }
  }

  async function makeEmployee2(enterpriseId = 'ENT_A') {
    const user = await createUser({ role: 'user' })
    await prisma.appUser.update({
      where: { id: user.id },
      data: { enterpriseId, enterpriseRole: 'EMPLOYEE' },
    })
    return { user, token: getTestToken(user.id, 'user') }
  }

  async function setupScene() {
    const { admin } = await makeAdminToken()
    const { user: reviewer, token: reviewerToken } = await makeReviewer2('ENT_A')
    const source = await makeSource(admin.id, { enterpriseId: 'ENT_A' })

    // 创建 plan（ENT_A）
    const planRes = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ sourceId: source.id, title: '生成任务测试计划' })
    const planId = planRes.body.data.id

    // 创建 2 个 requirement（ENT_A, ACTIVE）
    const req1 = await makeRequirement(admin.id, source.id, 'ENT_A')
    const req2 = await makeRequirement(admin.id, source.id, 'ENT_A')

    return { admin, reviewer, reviewerToken, source, planId, req1, req2 }
  }

  it('happy path：显式 taskType 覆盖推荐类型 → 1 Task + 2 TaskItem + 2 Assignee', async () => {
    const { admin, reviewer, reviewerToken, planId, req1, req2 } = await setupScene()

    // 再建一个 assignee 用户
    const emp1 = await createUser({ role: 'user' })
    await prisma.appUser.update({ where: { id: emp1.id }, data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' } })
    const emp2 = await createUser({ role: 'user' })
    await prisma.appUser.update({ where: { id: emp2.id }, data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' } })

    const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
    const res = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${planId}/generate-tasks`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({
        requirementIds: [req1.id, req2.id],
        taskType: 'INSPECTION_FILL',
        reviewerId: reviewer.id,
        assigneeIds: [emp1.id, emp2.id],
        deadlineAt: deadline,
        titlePrefix: 'Q2',
      })
    expect(res.status).toBe(201)
    expect(res.body.ok).toBe(true)
    expect(res.body.createdTasks).toBe(1)
    expect(res.body.createdItems).toBe(2)

    // 验证 DB：显式 taskType 时统一成一个任务组
    const tasks = await prisma.standardExecutionTask.findMany({ where: { planId }, orderBy: { createdAt: 'asc' } })
    expect(tasks.length).toBe(1)
    expect(tasks[0].planId).toBe(planId)
    expect(tasks[0].requirementId).toBeNull()
    expect(tasks[0].title).toBe('Q2 - INSPECTION_FILL')
    expect(tasks[0].taskType).toBe('INSPECTION_FILL')

    const items = await prisma.standardExecutionTaskItem.findMany({ where: { taskId: tasks[0].id } })
    expect(items.length).toBe(2)
    expect(items.map((i) => i.requirementId).sort()).toEqual([req1.id, req2.id].sort())
    expect(items.every((i) => i.status === 'PENDING')).toBe(true)

    const assignees = await prisma.standardExecutionTaskAssignee.findMany({ where: { taskId: tasks[0].id } })
    expect(assignees.map((a) => a.assigneeId).sort()).toEqual([emp1.id, emp2.id].sort())
  })

  it('不传 taskType → 按 recommendedTaskType 自动分组', async () => {
    const { admin, reviewer, reviewerToken, source, planId } = await setupScene()
    const reqA1 = await makeRequirement(admin.id, source.id, 'ENT_A', { title: '培训 A1', recommendedTaskType: 'TRAINING' })
    const reqA2 = await makeRequirement(admin.id, source.id, 'ENT_A', { title: '培训 A2', recommendedTaskType: 'TRAINING' })
    const reqB = await makeRequirement(admin.id, source.id, 'ENT_A', { title: '整改 B', recommendedTaskType: 'RECTIFICATION' })
    const emp = await createUser({ role: 'user' })
    await prisma.appUser.update({ where: { id: emp.id }, data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' } })

    const res = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${planId}/generate-tasks`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({
        requirementIds: [reqA1.id, reqA2.id, reqB.id],
        reviewerId: reviewer.id,
        assigneeIds: [emp.id],
      })
    expect(res.status).toBe(201)
    expect(res.body.createdTasks).toBe(2)
    expect(res.body.createdItems).toBe(3)
    expect(res.body.groups.map((g: { taskType: string }) => g.taskType).sort()).toEqual(['RECTIFICATION', 'TRAINING'])

    const tasks = await prisma.standardExecutionTask.findMany({
      where: { planId },
      include: { items: { include: { requirement: true } } },
    })
    const training = tasks.find((t) => t.taskType === 'TRAINING')!
    const rectification = tasks.find((t) => t.taskType === 'RECTIFICATION')!
    expect(training.items.map((i) => i.requirement.title).sort()).toEqual(['培训 A1', '培训 A2'])
    expect(rectification.items.map((i) => i.requirement.title)).toEqual(['整改 B'])
  })

  it('deadlineAt 缺省 → 默认 now()+7天（任务 deadline 在未来 6-8 天内）', async () => {
    const { reviewer, reviewerToken, planId, req1 } = await setupScene()
    const emp = await createUser({ role: 'user' })
    await prisma.appUser.update({ where: { id: emp.id }, data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' } })

    const before = Date.now()
    await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${planId}/generate-tasks`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({
        requirementIds: [req1.id],
        taskType: 'OTHER',
        reviewerId: reviewer.id,
        assigneeIds: [emp.id],
      })
    const after = Date.now()

    const tasks = await prisma.standardExecutionTask.findMany({ where: { planId } })
    expect(tasks.length).toBe(1)
    const deadlineMs = tasks[0].deadlineAt.getTime()
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
    // deadline 在 before+7天 到 after+7天 之间
    expect(deadlineMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000)
    expect(deadlineMs).toBeLessThanOrEqual(after + sevenDaysMs + 1000)
  })

  it('EMPLOYEE 角色 → 403', async () => {
    const { planId, req1 } = await setupScene()
    const { user: emp, token: empToken } = await makeEmployee2('ENT_A')
    const res = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${planId}/generate-tasks`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({ requirementIds: [req1.id], taskType: 'OTHER', reviewerId: emp.id, assigneeIds: [emp.id] })
    expect(res.status).toBe(403)
  })

  it('plan 不存在 → 404', async () => {
    const { reviewer, reviewerToken, req1 } = await setupScene()
    const emp = await createUser({ role: 'user' })
    await prisma.appUser.update({ where: { id: emp.id }, data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' } })
    const res = await request(enterpriseApp)
      .post('/api/enterprise/standard-execution/plans/non-existent-plan/generate-tasks')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ requirementIds: [req1.id], taskType: 'OTHER', reviewerId: reviewer.id, assigneeIds: [emp.id] })
    expect(res.status).toBe(404)
  })

  it('requirementId 不存在 → 400', async () => {
    const { reviewer, reviewerToken, planId } = await setupScene()
    const emp = await createUser({ role: 'user' })
    await prisma.appUser.update({ where: { id: emp.id }, data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' } })
    const res = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${planId}/generate-tasks`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ requirementIds: ['non-existent-req-id'], taskType: 'OTHER', reviewerId: reviewer.id, assigneeIds: [emp.id] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/不存在|不属于/)
  })

  it('requirementId 跨企业（属于 ENT_B）→ 400', async () => {
    const { admin } = await makeAdminToken()
    const { reviewer, reviewerToken, planId } = await setupScene()
    const emp = await createUser({ role: 'user' })
    await prisma.appUser.update({ where: { id: emp.id }, data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' } })

    // ENT_B 的 requirement
    const sourceB = await makeSource(admin.id, { enterpriseId: 'ENT_B' })
    const reqB = await makeRequirement(admin.id, sourceB.id, 'ENT_B')

    const res = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${planId}/generate-tasks`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ requirementIds: [reqB.id], taskType: 'OTHER', reviewerId: reviewer.id, assigneeIds: [emp.id] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/不存在|不属于/)
  })

  it('非 ACTIVE requirement（DRAFT）→ 400', async () => {
    const { admin } = await makeAdminToken()
    const { reviewer, reviewerToken, planId, source } = await setupScene()
    const emp = await createUser({ role: 'user' })
    await prisma.appUser.update({ where: { id: emp.id }, data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' } })

    const draftReq = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'ENT_A', sourceId: source.id, title: 'draft req', requirementText: 'x', status: 'DRAFT', createdBy: admin.id },
    })
    const res = await request(enterpriseApp)
      .post(`/api/enterprise/standard-execution/plans/${planId}/generate-tasks`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ requirementIds: [draftReq.id], taskType: 'OTHER', reviewerId: reviewer.id, assigneeIds: [emp.id] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/ACTIVE/)
  })
})

describe('StandardExecutionPlan cron runner — 周期任务派发', () => {
  async function setupDuePlan(overrides: Partial<{
    enterpriseId: string
    sourceEnterpriseId: string
    frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly'
    nextRunAt: Date
    endAt: Date | null
    defaultReviewerId: string | null
    defaultAssigneeIds: string[]
    defaultTaskType: string | null
    defaultDeadlineMode: string
    defaultDeadlineDaysAfterApproval: number | null
  }> = {}) {
    const enterpriseId = overrides.enterpriseId ?? 'ENT_A'
    const { admin } = await makeAdminToken()
    const reviewer = await createUser({ role: 'user' })
    await prisma.appUser.update({
      where: { id: reviewer.id },
      data: { enterpriseId, enterpriseRole: 'REVIEWER' },
    })
    const employee = await createUser({ role: 'user' })
    await prisma.appUser.update({
      where: { id: employee.id },
      data: { enterpriseId, enterpriseRole: 'EMPLOYEE' },
    })
    const source = await makeSource(admin.id, { enterpriseId: overrides.sourceEnterpriseId ?? enterpriseId })
    const req1 = await makeRequirement(admin.id, source.id, enterpriseId, {
      title: '巡检消防通道',
      recommendedTaskType: 'INSPECTION_FILL',
      executionDescription: '检查消防通道是否畅通并拍照留存',
    })
    const req2 = await makeRequirement(admin.id, source.id, enterpriseId, {
      title: '归档培训记录',
      recommendedTaskType: 'ARCHIVE_MATERIAL',
      executionDescription: '整理并上传本轮培训签到记录',
    })
    const nextRunAt = overrides.nextRunAt ?? new Date('2026-01-01T09:00:00.000Z')
    const plan = await prisma.standardExecutionPlan.create({
      data: {
        enterpriseId,
        sourceId: source.id,
        title: '周期计划',
        status: 'ACTIVE',
        frequency: overrides.frequency ?? 'weekly',
        startAt: new Date('2026-01-01T00:00:00.000Z'),
        endAt: overrides.endAt === undefined ? null : overrides.endAt,
        nextRunAt,
        defaultReviewerId: overrides.defaultReviewerId === undefined ? reviewer.id : overrides.defaultReviewerId,
        defaultAssigneeIds: overrides.defaultAssigneeIds === undefined ? [employee.id] : overrides.defaultAssigneeIds,
        defaultTaskType: overrides.defaultTaskType ?? null,
        defaultDeadlineMode: overrides.defaultDeadlineMode ?? 'AFTER_APPROVAL_DAYS',
        defaultDeadlineDaysAfterApproval: overrides.defaultDeadlineDaysAfterApproval === undefined ? 7 : overrides.defaultDeadlineDaysAfterApproval,
        createdBy: admin.id,
      },
    })
    return { admin, reviewer, employee, source, req1, req2, plan, nextRunAt }
  }

  it('cron happy：到期 ACTIVE plan 生成 PENDING_APPROVAL 任务、TaskItem、Assignee 和 PlanRun', async () => {
    const now = new Date('2026-01-10T10:00:00.000Z')
    const { plan, employee } = await setupDuePlan()

    const result = await runDueStandardExecutionPlans(now)

    expect(result.checked).toBe(1)
    expect(result.createdRuns).toBe(1)
    expect(result.createdTasks).toBe(2)
    const tasks = await prisma.standardExecutionTask.findMany({
      where: { planId: plan.id },
      include: { assignees: true, items: true, approvalLogs: true },
      orderBy: { taskType: 'asc' },
    })
    expect(tasks).toHaveLength(2)
    expect(tasks.every((task) => task.status === 'PENDING_APPROVAL')).toBe(true)
    expect(tasks.every((task) => task.submittedForApprovalAt !== null)).toBe(true)
    expect(tasks.every((task) => task.deadlineMode === 'AFTER_APPROVAL_DAYS')).toBe(true)
    expect(tasks.flatMap((task) => task.assignees.map((assignee) => assignee.assigneeId))).toEqual([employee.id, employee.id])
    expect(tasks.flatMap((task) => task.items)).toHaveLength(2)
    expect(tasks.every((task) => task.approvalLogs.some((log) => log.action === 'SUBMIT_APPROVAL'))).toBe(true)

    const planRun = await prisma.standardExecutionPlanRun.findFirst({ where: { planId: plan.id } })
    expect(planRun?.status).toBe('CREATED')
    expect(new Set(planRun?.createdTaskIds as string[])).toEqual(new Set(tasks.map((task) => task.id)))
    const updatedPlan = await prisma.standardExecutionPlan.findUnique({ where: { id: plan.id } })
    expect(updatedPlan?.lastRunAt?.toISOString()).toBe(now.toISOString())
    expect(updatedPlan?.nextRunAt?.toISOString()).toBe('2026-01-08T09:00:00.000Z')
    expect(updatedPlan?.roundNumber).toBe(2)
  })

  it('重复执行同一 runDate 幂等：不重复生成任务，只推进 nextRunAt', async () => {
    const now = new Date('2026-01-10T10:00:00.000Z')
    const { plan, nextRunAt } = await setupDuePlan()

    await runDueStandardExecutionPlans(now)
    await prisma.standardExecutionPlan.update({
      where: { id: plan.id },
      data: { nextRunAt },
    })
    const retry = await runDueStandardExecutionPlans(new Date('2026-01-10T10:05:00.000Z'))

    expect(retry.checked).toBe(1)
    expect(retry.skippedRuns).toBe(1)
    expect(retry.createdTasks).toBe(0)
    expect(await prisma.standardExecutionTask.count({ where: { planId: plan.id } })).toBe(2)
    expect(await prisma.standardExecutionPlanRun.count({ where: { planId: plan.id } })).toBe(1)
    const updatedPlan = await prisma.standardExecutionPlan.findUnique({ where: { id: plan.id } })
    expect(updatedPlan?.nextRunAt?.toISOString()).toBe('2026-01-08T09:00:00.000Z')
  })

  it('漏跑补偿：nextRunAt 早于 now 时启动扫描会补一轮', async () => {
    const { plan } = await setupDuePlan({
      frequency: 'monthly',
      nextRunAt: new Date('2025-12-15T08:00:00.000Z'),
    })

    const result = await runDueStandardExecutionPlans(new Date('2026-01-20T08:00:00.000Z'))

    expect(result.checked).toBe(1)
    expect(result.createdRuns).toBe(1)
    expect(await prisma.standardExecutionTask.count({ where: { planId: plan.id } })).toBe(2)
    const updatedPlan = await prisma.standardExecutionPlan.findUnique({ where: { id: plan.id } })
    expect(updatedPlan?.nextRunAt?.toISOString()).toBe('2026-01-15T08:00:00.000Z')
  })

  it('跨企业隔离：只扫描同 enterpriseId + sourceId 的 ACTIVE 执行要求', async () => {
    const now = new Date('2026-01-10T10:00:00.000Z')
    const { admin, source, plan } = await setupDuePlan()
    const bSource = await makeSource(admin.id, { enterpriseId: 'ENT_B' })
    await makeRequirement(admin.id, bSource.id, 'ENT_B', { title: 'ENT_B 不应入任务' })

    await runDueStandardExecutionPlans(now)

    const tasks = await prisma.standardExecutionTask.findMany({
      where: { planId: plan.id },
      include: { items: { include: { requirement: true } } },
    })
    expect(tasks.flatMap((task) => task.items.map((item) => item.requirement.sourceId))).toEqual([source.id, source.id])
    expect(tasks.flatMap((task) => task.items.map((item) => item.requirement.enterpriseId))).toEqual(['ENT_A', 'ENT_A'])
  })

  it('缺默认审核人或执行人时跳过本轮并记录 SKIPPED，不生成任务', async () => {
    const { plan } = await setupDuePlan({ defaultReviewerId: null })

    const result = await runDueStandardExecutionPlans(new Date('2026-01-10T10:00:00.000Z'))

    expect(result.skippedRuns).toBe(1)
    expect(await prisma.standardExecutionTask.count({ where: { planId: plan.id } })).toBe(0)
    const planRun = await prisma.standardExecutionPlanRun.findFirst({ where: { planId: plan.id } })
    expect(planRun?.status).toBe('SKIPPED')
    expect(planRun?.errorMessage).toContain('默认审核人或执行人')
  })

  it('computeNextPlanRunAt 覆盖 daily/weekly/monthly/quarterly/yearly 与 endAt 截止', () => {
    const base = new Date('2026-01-31T09:00:00.000Z')
    expect(computeNextPlanRunAt(base, 'daily', null)?.toISOString()).toBe('2026-02-01T09:00:00.000Z')
    expect(computeNextPlanRunAt(base, 'weekly', null)?.toISOString()).toBe('2026-02-07T09:00:00.000Z')
    expect(computeNextPlanRunAt(base, 'monthly', null)?.toISOString()).toBe('2026-02-28T09:00:00.000Z')
    expect(computeNextPlanRunAt(base, 'quarterly', null)?.toISOString()).toBe('2026-04-30T09:00:00.000Z')
    expect(computeNextPlanRunAt(base, 'yearly', null)?.toISOString()).toBe('2027-01-31T09:00:00.000Z')
    expect(computeNextPlanRunAt(base, 'monthly', new Date('2026-02-01T00:00:00.000Z'))).toBeNull()
  })
})
