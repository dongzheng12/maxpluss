/**
 * 企业版 standard-execution 端点 — 端到端测试
 *
 * 覆盖：
 *  - GET  /api/enterprise/members
 *  - GET  /api/enterprise/standard-execution/sources
 *  - GET  /api/enterprise/standard-execution/requirements
 *  - GET  /api/enterprise/standard-execution/tasks
 *  - POST /api/enterprise/standard-execution/tasks
 *  - PATCH /api/enterprise/standard-execution/tasks/:id
 *  - POST /api/enterprise/standard-execution/tasks/:id/submit-approval
 *  - POST /api/enterprise/standard-execution/tasks/:id/approval/approve
 *  - POST /api/enterprise/standard-execution/tasks/:id/cancel
 *  - GET  /api/enterprise/standard-execution/tasks/:id/progress
 *
 * 三类身份：
 *  - admin（role='admin'） → enterpriseId=DEFAULT 通配
 *  - 企业成员（enterpriseId=ENT_A + enterpriseRole=EMPLOYEE）
 *  - 普通 user（无 enterpriseId/enterpriseRole）→ 应被 403 拦截
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { createUser, getTestToken, cleanAll } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerEnterpriseRoutes(app)
})

let adminToken: string
let employeeToken: string
let employeeId: string
let plainToken: string
let reviewerId: string
let assigneeId: string
let activeSourceId: string
let activeRequirementId: string
let draftRequirementId: string

beforeEach(async () => {
  // 清 SE 业务数据（按 FK 顺序：子表先删）
  await cleanStandardExecutionData()

  // 清残留 appUser（其他测试文件可能残留 enterpriseId='DEFAULT' 的成员，污染 admin members 断言）
  await cleanAll()

  // 企业准备：DEFAULT（admin 通配用）+ ENT_A（企业成员用）+ ENT_B（跨企业拦截用）
  for (const id of ['DEFAULT', 'ENT_A', 'ENT_B']) {
    await prisma.enterprise.upsert({
      where: { id },
      update: { name: id === 'DEFAULT' ? '默认企业' : id === 'ENT_A' ? 'A 企业' : 'B 企业', status: 'ACTIVE' },
      create: { id, name: id === 'DEFAULT' ? '默认企业' : id === 'ENT_A' ? 'A 企业' : 'B 企业', code: id, status: 'ACTIVE' },
    })
  }

  // 三类用户
  const adminUser = await createUser({ role: 'admin' })
  adminToken = getTestToken(adminUser.id, 'admin')

  const employee = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: employee.id },
    data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' },
  })
  employeeId = employee.id
  employeeToken = getTestToken(employee.id, 'user')

  const plain = await createUser({ role: 'user' })
  plainToken = getTestToken(plain.id, 'user')

  // 同企业的 reviewer / assignee
  const reviewer = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: reviewer.id },
    data: { enterpriseId: 'ENT_A', enterpriseRole: 'REVIEWER' },
  })
  reviewerId = reviewer.id

  const assignee = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: assignee.id },
    data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' },
  })
  assigneeId = assignee.id

  // ENT_A 一个 source + 一个 ACTIVE / 一个 DRAFT requirement
  const source = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId: 'ENT_A',
      title: 'GB/T 1234-2025 测试用产品标准',
      sourceType: 'PRODUCT_STANDARD',
      sourceNo: 'GB/T 1234-2025',
      status: 'ACTIVE',
      createdBy: employee.id,
    },
  })
  activeSourceId = source.id

  const activeReq = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId: 'ENT_A',
      sourceId: source.id,
      title: '5.1 外观检验',
      requirementText: '产品外观无划痕、磕碰',
      status: 'ACTIVE',
      generateMode: 'MANUAL',
      createdBy: employee.id,
    },
  })
  activeRequirementId = activeReq.id

  const draftReq = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId: 'ENT_A',
      sourceId: source.id,
      title: '5.2 尺寸测量（草稿）',
      requirementText: '长×宽×高 = 100×50×20mm（草稿）',
      status: 'DRAFT',
      generateMode: 'MANUAL',
      createdBy: employee.id,
    },
  })
  draftRequirementId = draftReq.id
})

async function createOtherEnterpriseUser(enterpriseRole: 'ADMIN' | 'REVIEWER' | 'EMPLOYEE' = 'EMPLOYEE') {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: user.id },
    data: { enterpriseId: 'ENT_B', enterpriseRole },
  })
  return user
}

describe('GET /api/enterprise/members', () => {
  it('未登录 → 401', async () => {
    const res = await request(app).get('/api/enterprise/members')
    expect(res.status).toBe(401)
  })

  it('admin → 返回自身一条', async () => {
    const res = await request(app)
      .get('/api/enterprise/members')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })

  it('企业成员 → 返回同企业全部', async () => {
    const res = await request(app)
      .get('/api/enterprise/members')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    // ENT_A 有 employee + reviewer + assignee 三个
    expect(res.body.data.length).toBeGreaterThanOrEqual(3)
  })

  it('已绑定企业的 admin → 返回绑定企业成员（兼容旧 token 无 enterpriseId）', async () => {
    const boundAdmin = await createUser({ role: 'admin' })
    await prisma.appUser.update({
      where: { id: boundAdmin.id },
      data: { enterpriseId: 'ENT_A', enterpriseRole: 'ADMIN' },
    })
    const tokenWithoutEnterpriseClaims = getTestToken(boundAdmin.id, 'admin')
    const res = await request(app)
      .get('/api/enterprise/members')
      .set('Authorization', `Bearer ${tokenWithoutEnterpriseClaims}`)
    expect(res.status).toBe(200)
    const phones = res.body.data.map((item: { phone: string }) => item.phone)
    expect(phones).toContain(boundAdmin.phone)
    expect(res.body.data.length).toBeGreaterThanOrEqual(4)
  })

  it('无 enterpriseId 普通 user → 403', async () => {
    const res = await request(app)
      .get('/api/enterprise/members')
      .set('Authorization', `Bearer ${plainToken}`)
    expect(res.status).toBe(403)
  })
})

describe('GET /api/enterprise/standard-execution/sources', () => {
  it('admin 用 DEFAULT enterpriseId → 200 + 空列表（DEFAULT 无 source）', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/sources')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })

  it('企业成员 → 200 + 返回本企业 source', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/sources')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe(activeSourceId)
  })

  it('已绑定企业的 admin → 200 + 返回绑定企业 source（兼容旧 token 无 enterpriseId）', async () => {
    const boundAdmin = await createUser({ role: 'admin' })
    await prisma.appUser.update({
      where: { id: boundAdmin.id },
      data: { enterpriseId: 'ENT_A', enterpriseRole: 'ADMIN' },
    })
    const tokenWithoutEnterpriseClaims = getTestToken(boundAdmin.id, 'admin')
    const res = await request(app)
      .get('/api/enterprise/standard-execution/sources')
      .set('Authorization', `Bearer ${tokenWithoutEnterpriseClaims}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe(activeSourceId)
  })

  it('keyword 过滤命中', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/sources?keyword=1234')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })

  it('无 enterpriseId 普通 user → 403', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/sources')
      .set('Authorization', `Bearer ${plainToken}`)
    expect(res.status).toBe(403)
  })
})

describe('GET /api/enterprise/standard-execution/requirements', () => {
  it('已绑定企业的 admin → 200 + 返回绑定企业 requirements', async () => {
    const boundAdmin = await createUser({ role: 'admin' })
    await prisma.appUser.update({
      where: { id: boundAdmin.id },
      data: { enterpriseId: 'ENT_A', enterpriseRole: 'ADMIN' },
    })
    const tokenWithoutEnterpriseClaims = getTestToken(boundAdmin.id, 'admin')
    const res = await request(app)
      .get('/api/enterprise/standard-execution/requirements')
      .set('Authorization', `Bearer ${tokenWithoutEnterpriseClaims}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
  })

  it('企业成员 → 200 + 两条（ACTIVE + DRAFT）', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/requirements')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
  })

  it('status=ACTIVE 过滤 → 1 条', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/requirements?status=ACTIVE')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe(activeRequirementId)
    expect(res.body.data[0].health).toMatchObject({
      status: 'NO_TASK',
      taskCount: 0,
      validRecordCount: 0,
    })
  })

  it('status=ACTIVE,DRAFT 逗号多值过滤 → 2 条', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/requirements?status=ACTIVE,DRAFT')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    const ids = res.body.data.map((item: { id: string }) => item.id).sort()
    expect(ids).toEqual([activeRequirementId, draftRequirementId].sort())
  })

  it('无 enterpriseId 普通 user → 403', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/requirements')
      .set('Authorization', `Bearer ${plainToken}`)
    expect(res.status).toBe(403)
  })
})

describe('PATCH /api/enterprise/standard-execution/requirements/:id/disable（POC M2：DRAFT 可「忽略」）', () => {
  it('企业成员 DRAFT → DISABLED (ok 200)', async () => {
    const res = await request(app)
      .patch(`/api/enterprise/standard-execution/requirements/${draftRequirementId}/disable`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('DISABLED')
  })

  it('企业成员 DRAFT → disable → activate 完整路径回到 ACTIVE', async () => {
    const disabled = await request(app)
      .patch(`/api/enterprise/standard-execution/requirements/${draftRequirementId}/disable`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(disabled.status).toBe(200)
    expect(disabled.body.data.status).toBe('DISABLED')
    const reactivated = await request(app)
      .patch(`/api/enterprise/standard-execution/requirements/${draftRequirementId}/activate`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(reactivated.status).toBe(200)
    expect(reactivated.body.data.status).toBe('ACTIVE')
  })
})

describe('POST /api/enterprise/standard-execution/tasks', () => {
  const validBody = () => ({
    requirementId: activeRequirementId,
    title: '5.1 外观批量检验任务',
    taskType: 'QUALIFICATION_MATERIAL',
    submitRequirement: '提交检验照片 + 记录表',
    deadlineAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    reviewerId,
    assigneeIds: [assigneeId],
  })

  it('happy path → 201 + DRAFT 状态 + isOverdue false', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send(validBody())
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('DRAFT')
    expect(res.body.data.taskType).toBe('QUALIFICATION_MATERIAL')
    expect(res.body.data.isOverdue).toBe(false)
    // 落库校验
    const cnt = await prisma.standardExecutionTaskAssignee.count({
      where: { taskId: res.body.data.id },
    })
    expect(cnt).toBe(1)
  })

  it('requirementId 不存在 → 400', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ ...validBody(), requirementId: 'no-such-req' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('不存在')
  })

  it('requirement 非 ACTIVE（DRAFT）→ 400', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ ...validBody(), requirementId: draftRequirementId })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('ACTIVE')
  })

  it('reviewerId 用户不存在 → 400', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ ...validBody(), reviewerId: 'no-such-user' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('reviewer')
  })

  it('reviewerId 属于其他企业 → 400', async () => {
    const otherReviewer = await createOtherEnterpriseUser('REVIEWER')
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ ...validBody(), reviewerId: otherReviewer.id })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('本企业')
  })

  it('assigneeIds 含不存在 → 400', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ ...validBody(), assigneeIds: [assigneeId, 'no-such-assignee'] })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('assignee')
  })

  it('assigneeIds 含其他企业用户 → 400', async () => {
    const otherAssignee = await createOtherEnterpriseUser('EMPLOYEE')
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ ...validBody(), assigneeIds: [assigneeId, otherAssignee.id] })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('本企业')
  })

  it('无 enterpriseId 普通 user → 403', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${plainToken}`)
      .send(validBody())
    expect(res.status).toBe(403)
  })

  // admin 通配：role='admin' 用户 enterpriseId 可能为 NULL，但应允许任何企业把他选为
  // reviewer/assignee（与 GET /enterprise/members 把 admin 展示为 ADMIN 的契约对齐）
  it('admin 用户（enterpriseId=NULL）当 reviewer → 201（通配）', async () => {
    const adminReviewer = await createUser({ role: 'admin' })
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ ...validBody(), reviewerId: adminReviewer.id })
    expect(res.status).toBe(201)
    expect(res.body.data.reviewerId).toBe(adminReviewer.id)
  })

  it('admin 用户当 assignee → 201（通配）', async () => {
    const adminAssignee = await createUser({ role: 'admin' })
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ ...validBody(), assigneeIds: [adminAssignee.id] })
    expect(res.status).toBe(201)
    const cnt = await prisma.standardExecutionTaskAssignee.count({
      where: { taskId: res.body.data.id, assigneeId: adminAssignee.id },
    })
    expect(cnt).toBe(1)
  })
})

describe('Task 生命周期：PATCH / submit-approval / approve / cancel / progress', () => {
  async function createDraftTask() {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        requirementId: activeRequirementId,
        title: 't1',
        submitRequirement: 'sr',
        deadlineAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        reviewerId,
        assigneeIds: [assigneeId],
      })
    return res.body.data.id as string
  }

  async function submitAndApprove(id: string) {
    const reviewerToken = getTestToken(reviewerId, 'user')
    await request(app)
      .post(`/api/enterprise/standard-execution/tasks/${id}/submit-approval`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200)
    return request(app)
      .post(`/api/enterprise/standard-execution/tasks/${id}/approval/approve`)
      .set('Authorization', `Bearer ${reviewerToken}`)
  }

  it('PATCH DRAFT 任务 → 200 + 字段更新', async () => {
    const id = await createDraftTask()
    const res = await request(app)
      .patch(`/api/enterprise/standard-execution/tasks/${id}`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ title: 't1-edited' })
    expect(res.status).toBe(200)
    expect(res.body.data.title).toBe('t1-edited')
  })

  it('PATCH reviewerId 属于其他企业 → 400', async () => {
    const id = await createDraftTask()
    const otherReviewer = await createOtherEnterpriseUser('REVIEWER')
    const res = await request(app)
      .patch(`/api/enterprise/standard-execution/tasks/${id}`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ reviewerId: otherReviewer.id })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('本企业')
  })

  it('PATCH assigneeIds 含其他企业用户 → 400', async () => {
    const id = await createDraftTask()
    const otherAssignee = await createOtherEnterpriseUser('EMPLOYEE')
    const res = await request(app)
      .patch(`/api/enterprise/standard-execution/tasks/${id}`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ assigneeIds: [assigneeId, otherAssignee.id] })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('本企业')
  })

  it('PATCH 已 PUBLISHED 任务改安全字段(标题)→ 200（P0-1）', async () => {
    const id = await createDraftTask()
    await submitAndApprove(id)
    const res = await request(app)
      .patch(`/api/enterprise/standard-execution/tasks/${id}`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ title: '改后标题' })
    expect(res.status).toBe(200)
  })

  it('旧 publish 接口 → 409', async () => {
    const id = await createDraftTask()
    const res = await request(app)
      .post(`/api/enterprise/standard-execution/tasks/${id}/publish`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('请先提交审核')
  })

  it('submit approval + approve happy → 200 + status=PUBLISHED', async () => {
    const id = await createDraftTask()
    const submit = await request(app)
      .post(`/api/enterprise/standard-execution/tasks/${id}/submit-approval`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(submit.status).toBe(200)
    expect(submit.body.data.status).toBe('PENDING_APPROVAL')

    const res = await request(app)
      .post(`/api/enterprise/standard-execution/tasks/${id}/approval/approve`)
      .set('Authorization', `Bearer ${getTestToken(reviewerId, 'user')}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('PUBLISHED')
    expect(res.body.data.publishedAt).toBeTruthy()
  })

  it('submit approval 无 assignee → 400', async () => {
    const id = await createDraftTask()
    await prisma.standardExecutionTaskAssignee.deleteMany({ where: { taskId: id } })
    const res = await request(app)
      .post(`/api/enterprise/standard-execution/tasks/${id}/submit-approval`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('执行人')
  })

  it('cancel happy → 200 + status=CANCELLED', async () => {
    const id = await createDraftTask()
    const res = await request(app)
      .post(`/api/enterprise/standard-execution/tasks/${id}/cancel`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('CANCELLED')
  })

  it('cancel 已 CANCELLED → 200 + noop=true', async () => {
    const id = await createDraftTask()
    await request(app)
      .post(`/api/enterprise/standard-execution/tasks/${id}/cancel`)
      .set('Authorization', `Bearer ${employeeToken}`)
    const res = await request(app)
      .post(`/api/enterprise/standard-execution/tasks/${id}/cancel`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.noop).toBe(true)
  })

  it('progress → 200 + byStatus 含 6 个状态键', async () => {
    const id = await createDraftTask()
    await submitAndApprove(id)
    const res = await request(app)
      .get(`/api/enterprise/standard-execution/tasks/${id}/progress`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.taskStatus).toBe('PUBLISHED')
    expect(res.body.data.total).toBe(1)
    expect(Object.keys(res.body.data.byStatus).sort()).toEqual(
      ['COMPLETED', 'IN_PROGRESS', 'OVERDUE', 'PENDING', 'PENDING_REVIEW', 'REJECTED'].sort(),
    )
    expect(res.body.data.assignees).toHaveLength(1)
  })
})

describe('GET /api/enterprise/standard-execution/tasks', () => {
  it('企业成员 → 列表为空（无任务）', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
    expect(res.body.total).toBe(0)
  })

  it('创建后列表返回该任务', async () => {
    await request(app)
      .post('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        requirementId: activeRequirementId,
        title: 't-list',
        submitRequirement: 'sr',
        deadlineAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        reviewerId,
        assigneeIds: [assigneeId],
      })
    const res = await request(app)
      .get('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].title).toBe('t-list')
  })

  it('无 enterpriseId 普通 user → 403', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${plainToken}`)
    expect(res.status).toBe(403)
  })
})

describe('企业版 Task 批量操作 — batch-cancel / batch-publish / batch-assign', () => {
  async function mkDraftTask() {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        requirementId: activeRequirementId,
        title: 'batch-t',
        submitRequirement: 'sr',
        deadlineAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        reviewerId,
        assigneeIds: [assigneeId],
      })
    return res.body.data.id as string
  }

  it('batch-cancel：DRAFT → CANCELLED', async () => {
    const id1 = await mkDraftTask()
    const id2 = await mkDraftTask()
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks/batch-cancel')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ ids: [id1, id2] })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(2)
    const t = await prisma.standardExecutionTask.findUnique({ where: { id: id1 } })
    expect(t?.status).toBe('CANCELLED')
  })

  it('batch-publish：旧批量发布接口返回 409', async () => {
    const id = await mkDraftTask()
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks/batch-publish')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ ids: [id] })
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('请先提交审核')
    const t = await prisma.standardExecutionTask.findUnique({ where: { id } })
    expect(t?.status).toBe('DRAFT')
  })

  it('batch-assign：DRAFT 任务统一改派 reviewer+执行人', async () => {
    const id = await mkDraftTask()
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks/batch-assign')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ ids: [id], reviewerId, assigneeIds: [assigneeId] })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(1)
  })

  it('batch-assign：reviewerId 属于其他企业 → 400', async () => {
    const id = await mkDraftTask()
    const otherReviewer = await createOtherEnterpriseUser('REVIEWER')
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks/batch-assign')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ ids: [id], reviewerId: otherReviewer.id, assigneeIds: [assigneeId] })
    expect(res.status).toBe(400)
  })

  it('未登录 → 401', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks/batch-cancel')
      .send({ ids: ['x'] })
    expect(res.status).toBe(401)
  })

  it('普通 user（无企业）→ 403', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/tasks/batch-cancel')
      .set('Authorization', `Bearer ${plainToken}`)
      .send({ ids: ['x'] })
    expect(res.status).toBe(403)
  })
})

// 占位：unused 引用规避（防止 lint 报 employeeId unused）
void employeeId
