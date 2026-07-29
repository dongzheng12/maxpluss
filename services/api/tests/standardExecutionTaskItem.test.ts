/**
 * standard-execution / TaskItem e2e 测试
 *
 * 覆盖：
 *  - GET  /api/app/standard-execution/tasks/:taskId/items — 获取 TaskItem 列表
 *  - PATCH /api/app/standard-execution/tasks/:taskId/items/:itemId — 暂存
 *  - 完整 e2e：generate-tasks → GET items → PATCH 暂存 → submit → approve
 *    → 验证按 DONE item 生成多条 Record（含 taskItemId/requirementId）
 *  - 权限：非 assignee → 403
 *  - itemId 不存在 → 404
 *  - SKIPPED item 不建 Record（仅 DONE item 建）
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerStandardExecutionRoutes } from '../src/standard-execution/sourceRoutes.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { registerEnterpriseMytasksRoutes } from '../src/standard-execution/enterpriseMytasksRoutes.js'
import { createUser, getTestToken } from './factory.js'

// ─── App setup ─────────────────────────────────────────────
const seApp = express()
seApp.use(express.json())

const enterpriseApp = express()
enterpriseApp.use(express.json())

beforeAll(() => {
  registerStandardExecutionRoutes(seApp)
  registerEnterpriseRoutes(enterpriseApp)
  registerEnterpriseMytasksRoutes(enterpriseApp)
})

// ─── beforeEach：清 SE + Enterprise + AppUser ──────────────
beforeEach(async () => {
  await cleanStandardExecutionData()
  await prisma.adminUserRole.deleteMany()
  await prisma.salesProfile.deleteMany()
  await prisma.userCoupon.deleteMany()
  await prisma.userMembership.deleteMany()
  await prisma.notification.deleteMany()
  await prisma.conversation.deleteMany()
  await prisma.appUser.deleteMany()

  for (const id of ['DEFAULT', 'ENT_A', 'ENT_B']) {
    await prisma.enterprise.upsert({
      where: { id },
      update: { name: id, status: 'ACTIVE' },
      create: { id, name: id, code: id, status: 'ACTIVE' },
    })
  }
})

// ─── helpers ─────────────────────────────────────────────────

async function makeAdminUser() {
  const admin = await createUser({ role: 'admin' })
  return { admin, adminToken: getTestToken(admin.id, 'admin') }
}

async function makeReviewer(enterpriseId = 'DEFAULT') {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: user.id },
    data: { enterpriseId, enterpriseRole: 'REVIEWER' },
  })
  return { user, token: getTestToken(user.id, 'user', { enterpriseId: 'DEFAULT' }) }
}

async function makeEmployee(enterpriseId = 'DEFAULT') {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: user.id },
    data: { enterpriseId, enterpriseRole: 'EMPLOYEE' },
  })
  return { user, token: getTestToken(user.id, 'user', { enterpriseId: 'DEFAULT' }) }
}

async function makeSource(adminId: string, enterpriseId = 'DEFAULT') {
  return prisma.standardExecutionSource.create({
    data: { enterpriseId, title: '测试标准', sourceType: 'PRODUCT_STANDARD', createdBy: adminId },
  })
}

async function makeRequirement(adminId: string, sourceId: string, enterpriseId = 'DEFAULT') {
  return prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId,
      sourceId,
      title: '测试要求',
      requirementText: '测试要求文本',
      status: 'ACTIVE',
      generateMode: 'MANUAL',
      createdBy: adminId,
    },
  })
}

/**
 * 完整场景：创建 Plan + generate-tasks → 返回 task 及其 items
 * assigneeCount=1 时每个 task 只有 1 个 assignee
 */
async function setupFullScene(opts: {
  requirementCount?: number
  adminToken?: string
  adminId?: string
} = {}) {
  const { admin, adminToken } = await makeAdminUser()
  const { user: reviewer, token: reviewerToken } = await makeReviewer('DEFAULT')
  const { user: employee, token: empToken } = await makeEmployee('DEFAULT')

  const source = await makeSource(admin.id, 'DEFAULT')
  const reqCount = opts.requirementCount ?? 2
  const requirements = []
  for (let i = 0; i < reqCount; i++) {
    requirements.push(await makeRequirement(admin.id, source.id, 'DEFAULT'))
  }

  // create plan（enterprise 端）
  const planRes = await request(enterpriseApp)
    .post('/api/enterprise/standard-execution/plans')
    .set('Authorization', `Bearer ${reviewerToken}`)
    .send({ sourceId: source.id, title: 'TaskItem 测试计划' })
  const planId = planRes.body.data.id

  // generate-tasks
  const genRes = await request(enterpriseApp)
    .post(`/api/enterprise/standard-execution/plans/${planId}/generate-tasks`)
    .set('Authorization', `Bearer ${reviewerToken}`)
    .send({
      requirementIds: requirements.map((r) => r.id),
      taskType: 'INSPECTION_FILL',
      reviewerId: reviewer.id,
      assigneeIds: [employee.id],
      deadlineAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
  expect(genRes.status).toBe(201)

  // 找到 task（1 个 assignee → 1 个 task）
  const tasks = await prisma.standardExecutionTask.findMany({ where: { planId } })
  expect(tasks.length).toBe(1)
  const task = tasks[0]

  // publish task，让 employee 可以提交
  await prisma.standardExecutionTask.update({
    where: { id: task.id },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  })

  return {
    admin,
    adminToken,
    reviewer,
    reviewerToken,
    employee,
    empToken,
    source,
    requirements,
    planId,
    task,
  }
}

// ═══════════════════════════════════════════════════════
// GET /items
// ═══════════════════════════════════════════════════════

describe('GET /api/app/standard-execution/tasks/:taskId/items', () => {
  it('happy path — 返回 TaskItem 列表含 requirement 信息', async () => {
    const { empToken, task, requirements } = await setupFullScene({ requirementCount: 2 })

    const res = await request(seApp)
      .get(`/api/app/standard-execution/tasks/${task.id}/items`)
      .set('Authorization', `Bearer ${empToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(2)
    const reqIds = res.body.data.map((i: { requirementId: string }) => i.requirementId).sort()
    expect(reqIds).toEqual(requirements.map((r) => r.id).sort())
    // 含 requirement 字段
    expect(res.body.data[0].requirement).toBeTruthy()
    expect(res.body.data[0].requirement.title).toBeTruthy()
  })

  it('非 assignee → 403', async () => {
    const { task } = await setupFullScene()
    // 另一个普通用户，不是 assignee
    const other = await createUser({ role: 'user' })
    const otherToken = getTestToken(other.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(seApp)
      .get(`/api/app/standard-execution/tasks/${task.id}/items`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(403)
  })

  it('无 token → 401', async () => {
    const { task } = await setupFullScene()
    const res = await request(seApp)
      .get(`/api/app/standard-execution/tasks/${task.id}/items`)
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════
// PATCH /items/:itemId
// ═══════════════════════════════════════════════════════

describe('PATCH /api/app/standard-execution/tasks/:taskId/items/:itemId', () => {
  it('happy path — 暂存 status/note/fileUrls', async () => {
    const { empToken, employee, task } = await setupFullScene()
    const items = await prisma.standardExecutionTaskItem.findMany({ where: { taskId: task.id } })
    const item = items[0]

    const res = await request(seApp)
      .patch(`/api/app/standard-execution/tasks/${task.id}/items/${item.id}`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({ status: 'DONE', note: '已完成巡检', fileUrls: ['/uploads/se/a.jpg'] })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('DONE')
    expect(res.body.data.note).toBe('已完成巡检')
    expect(res.body.data.fileUrls).toEqual(['/uploads/se/a.jpg'])

    const templateItem = await prisma.standardExecutionTaskItem.findUnique({ where: { id: item.id } })
    expect(templateItem?.status).toBe('PENDING')
    const progress = await prisma.standardExecutionTaskItemProgress.findUnique({
      where: { taskItemId_assigneeId: { taskItemId: item.id, assigneeId: employee.id } },
    })
    expect(progress?.status).toBe('DONE')
  })

  it('仅传 note，status 不变', async () => {
    const { empToken, employee, task } = await setupFullScene()
    const items = await prisma.standardExecutionTaskItem.findMany({ where: { taskId: task.id } })
    const item = items[0]

    await request(seApp)
      .patch(`/api/app/standard-execution/tasks/${task.id}/items/${item.id}`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({ note: '备注信息' })

    const updated = await prisma.standardExecutionTaskItemProgress.findUnique({
      where: { taskItemId_assigneeId: { taskItemId: item.id, assigneeId: employee.id } },
    })
    expect(updated?.note).toBe('备注信息')
    expect(updated?.status).toBe('PENDING') // status 不变
  })

  it('SKIPPED 状态也能暂存', async () => {
    const { empToken, task } = await setupFullScene()
    const items = await prisma.standardExecutionTaskItem.findMany({ where: { taskId: task.id } })
    const item = items[0]

    const res = await request(seApp)
      .patch(`/api/app/standard-execution/tasks/${task.id}/items/${item.id}`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({ status: 'SKIPPED', note: '不适用' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('SKIPPED')
  })

  it('同一 TaskItem 的暂存状态按执行人隔离', async () => {
    const { empToken, employee, task } = await setupFullScene()
    const other = await createUser({ role: 'user' })
    await prisma.appUser.update({
      where: { id: other.id },
      data: { enterpriseId: 'DEFAULT', enterpriseRole: 'EMPLOYEE' },
    })
    await prisma.standardExecutionTaskAssignee.create({
      data: { enterpriseId: 'DEFAULT', taskId: task.id, assigneeId: other.id, status: 'PENDING' },
    })
    const otherToken = getTestToken(other.id, 'user', { enterpriseId: 'DEFAULT' })
    const item = (await prisma.standardExecutionTaskItem.findMany({ where: { taskId: task.id } }))[0]

    await request(seApp)
      .patch(`/api/app/standard-execution/tasks/${task.id}/items/${item.id}`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({ status: 'DONE', note: '员工A完成' })

    const otherBefore = await request(seApp)
      .get(`/api/app/standard-execution/tasks/${task.id}/items`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(otherBefore.body.data[0].status).toBe('PENDING')

    await request(seApp)
      .patch(`/api/app/standard-execution/tasks/${task.id}/items/${item.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ status: 'SKIPPED', note: '员工B跳过' })

    const progressA = await prisma.standardExecutionTaskItemProgress.findUnique({
      where: { taskItemId_assigneeId: { taskItemId: item.id, assigneeId: employee.id } },
    })
    const progressB = await prisma.standardExecutionTaskItemProgress.findUnique({
      where: { taskItemId_assigneeId: { taskItemId: item.id, assigneeId: other.id } },
    })
    expect(progressA?.status).toBe('DONE')
    expect(progressB?.status).toBe('SKIPPED')
  })

  it('非 assignee → 403', async () => {
    const { task } = await setupFullScene()
    const items = await prisma.standardExecutionTaskItem.findMany({ where: { taskId: task.id } })
    const item = items[0]

    const other = await createUser({ role: 'user' })
    const otherToken = getTestToken(other.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(seApp)
      .patch(`/api/app/standard-execution/tasks/${task.id}/items/${item.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ status: 'DONE' })
    expect(res.status).toBe(403)
  })

  it('itemId 不存在 → 404', async () => {
    const { empToken, task } = await setupFullScene()
    const res = await request(seApp)
      .patch(`/api/app/standard-execution/tasks/${task.id}/items/non-existent-item-id`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({ status: 'DONE' })
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════
// 完整 e2e：generate-tasks → GET → PATCH → submit → approve → 多 Record
// ═══════════════════════════════════════════════════════

describe('TaskItem 完整 e2e 流程', () => {
  it('generate-tasks → PATCH items → submit → approve → DONE item 生成 Record / SKIPPED 不生成', async () => {
    const { adminToken, empToken, employee, task, requirements } = await setupFullScene({ requirementCount: 3 })

    // 1. GET items，获取 item id
    const itemsRes = await request(seApp)
      .get(`/api/app/standard-execution/tasks/${task.id}/items`)
      .set('Authorization', `Bearer ${empToken}`)
    expect(itemsRes.status).toBe(200)
    const items: Array<{ id: string; requirementId: string; status: string }> = itemsRes.body.data
    expect(items.length).toBe(3)

    // 2. PATCH：item[0]=DONE, item[1]=SKIPPED, item[2]=PENDING（不改）
    await request(seApp)
      .patch(`/api/app/standard-execution/tasks/${task.id}/items/${items[0].id}`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({ status: 'DONE', note: '已完成' })
    await request(seApp)
      .patch(`/api/app/standard-execution/tasks/${task.id}/items/${items[1].id}`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({ status: 'SKIPPED', note: '本期不适用' })

    // 3. submit（新模型路径：task.planId != null）
    const submitRes = await request(seApp)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({
        submitText: '本轮巡检完成',
        attachments: [{ fileName: 'proof.jpg', fileUrl: '/uploads/se/proof.jpg' }],
        submitDataJson: {
          requirementForms: {
            [items[0].id]: { text: '门岗照片已上传', attachmentCount: 1 },
            [items[1].id]: { text: '本期不适用原因已说明' },
          },
        },
      })
    expect(submitRes.status).toBe(201)
    const submissionId = submitRes.body.data.id

    // 验证 submitDataJson 含 items 快照
    const submission = await prisma.standardExecutionSubmission.findUnique({ where: { id: submissionId } })
    expect(submission?.submitDataJson).toBeTruthy()
    const submitJson = submission?.submitDataJson as {
      items: Array<{ taskItemId: string; status: string }>
      requirementForms?: Record<string, { text: string; attachmentCount?: number }>
    }
    expect(Array.isArray(submitJson.items)).toBe(true)
    // 含 DONE + SKIPPED（所有 item 都快照进去）
    expect(submitJson.items.length).toBe(3)
    expect(submitJson.requirementForms?.[items[0].id]).toEqual({ text: '门岗照片已上传', attachmentCount: 1 })
    expect(submitJson.requirementForms?.[items[1].id]).toEqual({ text: '本期不适用原因已说明' })

    // 4. approve
    const approveRes = await request(seApp)
      .post(`/api/admin/standard-execution/reviews/${submissionId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(approveRes.status).toBe(200)
    expect(approveRes.body.data.taskCompleted).toBe(true)

    // 5. 验证 Record：只有 DONE 的 item[0] 生成 1 条 Record
    const records = await prisma.standardExecutionRecord.findMany({
      where: { submissionId },
      orderBy: { createdAt: 'asc' },
    })
    expect(records.length).toBe(1)
    expect(records[0].taskItemId).toBe(items[0].id)
    expect(records[0].requirementId).toBe(items[0].requirementId)
    expect(records[0].assigneeId).toBe(employee.id)
    expect(records[0].status).toBe('VALID')
    expect(records[0].createdFrom).toBe('REVIEW_APPROVE')
    expect(records[0].taskItemId).not.toBeNull()

    // 6. HTTP response 含 records 数组
    expect(approveRes.body.data.records.length).toBe(1)
    expect(approveRes.body.data.record).toBeTruthy() // 向后兼容
  })

  it('全部 DONE：生成 N 条 Record', async () => {
    const { adminToken, empToken, task } = await setupFullScene({ requirementCount: 3 })

    const items: Array<{ id: string }> = (await request(seApp)
      .get(`/api/app/standard-execution/tasks/${task.id}/items`)
      .set('Authorization', `Bearer ${empToken}`)).body.data

    // 全部 DONE
    for (const item of items) {
      await request(seApp)
        .patch(`/api/app/standard-execution/tasks/${task.id}/items/${item.id}`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({ status: 'DONE' })
    }

    const submitRes = await request(seApp)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({ submitText: '全部完成', attachments: [{ fileName: 'a.jpg', fileUrl: '/uploads/a.jpg' }] })
    expect(submitRes.status).toBe(201)

    const approveRes = await request(seApp)
      .post(`/api/admin/standard-execution/reviews/${submitRes.body.data.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(approveRes.status).toBe(200)

    const records = await prisma.standardExecutionRecord.findMany({ where: { submissionId: submitRes.body.data.id } })
    expect(records.length).toBe(3)
    expect(records.every((r) => r.taskItemId !== null)).toBe(true)
    expect(approveRes.body.data.records.length).toBe(3)
  })

  it('全部 SKIPPED：approve 不建 Record', async () => {
    const { adminToken, empToken, task } = await setupFullScene({ requirementCount: 2 })

    const items: Array<{ id: string }> = (await request(seApp)
      .get(`/api/app/standard-execution/tasks/${task.id}/items`)
      .set('Authorization', `Bearer ${empToken}`)).body.data

    for (const item of items) {
      await request(seApp)
        .patch(`/api/app/standard-execution/tasks/${task.id}/items/${item.id}`)
        .set('Authorization', `Bearer ${empToken}`)
        .send({ status: 'SKIPPED' })
    }

    const submitRes = await request(seApp)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({ submitText: '均不适用', attachments: [{ fileName: 'a.jpg', fileUrl: '/uploads/a.jpg' }] })
    expect(submitRes.status).toBe(201)

    const approveRes = await request(seApp)
      .post(`/api/admin/standard-execution/reviews/${submitRes.body.data.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(approveRes.status).toBe(200)

    const records = await prisma.standardExecutionRecord.findMany({ where: { submissionId: submitRes.body.data.id } })
    expect(records.length).toBe(0)
    expect(approveRes.body.data.records.length).toBe(0)
    expect(approveRes.body.data.record).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════
// 旧路径（无 TaskItem）不受影响
// ═══════════════════════════════════════════════════════

describe('旧路径（requirementId task）不受影响', () => {
  it('旧 task（有 requirementId, 无 planId）approve → 1 条 Record，taskItemId=null', async () => {
    const { admin, adminToken } = await makeAdminUser()
    const src = await prisma.standardExecutionSource.create({
      data: { enterpriseId: 'DEFAULT', title: 'src', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
    })
    const req = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'req', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id },
    })
    const reviewer = await createUser({ role: 'user' })
    const employee = await createUser({ role: 'user' })
    const empToken = getTestToken(employee.id, 'user', { enterpriseId: 'DEFAULT' })

    const task = await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'DEFAULT',
        requirementId: req.id,
        title: '旧路径任务',
        submitRequirement: 'x',
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: reviewer.id,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        createdBy: admin.id,
      },
    })
    await prisma.standardExecutionTaskAssignee.create({
      data: { enterpriseId: 'DEFAULT', taskId: task.id, assigneeId: employee.id, status: 'PENDING_REVIEW', submittedAt: new Date() },
    })
    const sub = await prisma.standardExecutionSubmission.create({
      data: { enterpriseId: 'DEFAULT', taskId: task.id, assigneeId: employee.id, submitText: '完成', status: 'SUBMITTED', version: 1, isLatest: true },
    })

    const approveRes = await request(seApp)
      .post(`/api/admin/standard-execution/reviews/${sub.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(approveRes.status).toBe(200)

    const records = await prisma.standardExecutionRecord.findMany({ where: { submissionId: sub.id } })
    expect(records.length).toBe(1)
    expect(records[0].taskItemId).toBeNull()
    expect(records[0].requirementId).toBe(req.id)
  })
})

// ═══════════════════════════════════════════════════════
// web 企业端 submit（enterpriseMytasksRoutes）TaskItem 路径
// ═══════════════════════════════════════════════════════

describe('web /api/enterprise/my-tasks/:id/submit — TaskItem 路径', () => {
  it('web 提交走 TaskItem 模式：completedAt + submitDataJson.items 快照 + approve 拆 Record', async () => {
    const { adminToken, empToken, task } = await setupFullScene({ requirementCount: 2 })
    const items = await prisma.standardExecutionTaskItem.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: 'asc' },
    })

    // 暂存 item[0]=DONE（走 app 端 PATCH）
    await request(seApp)
      .patch(`/api/app/standard-execution/tasks/${task.id}/items/${items[0].id}`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({ status: 'DONE', note: 'web 完成' })

    // web 端提交（enterpriseMytasksRoutes，非小程序 mpSubmit）
    const submitRes = await request(enterpriseApp)
      .post(`/api/enterprise/my-tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({
        submitText: 'web 端提交',
        attachments: [{ fileName: 'a.jpg', fileUrl: '/uploads/se/a.jpg' }],
        submitDataJson: {
          requirementForms: {
            [items[0].id]: { text: 'web 逐要求项填写', structuredFields: { checkResult: '合格' } },
          },
        },
      })
    expect(submitRes.status).toBe(201)
    const submissionId = submitRes.body.data.id

    // submitDataJson 含 items 快照（2 条）
    const submission = await prisma.standardExecutionSubmission.findUnique({ where: { id: submissionId } })
    const submitJson = submission?.submitDataJson as {
      items: Array<{ taskItemId: string; status: string }>
      requirementForms?: Record<string, { text: string; structuredFields?: Record<string, string> }>
    } | null
    expect(submitJson && Array.isArray(submitJson.items)).toBe(true)
    expect(submitJson!.items.length).toBe(2)
    expect(submitJson!.requirementForms?.[items[0].id]).toEqual({
      text: 'web 逐要求项填写',
      structuredFields: { checkResult: '合格' },
    })

    // DONE item 的当前执行人 progress.completedAt 已写入，模板 TaskItem 不被污染
    const doneProgress = await prisma.standardExecutionTaskItemProgress.findUnique({
      where: { taskItemId_assigneeId: { taskItemId: items[0].id, assigneeId: submitRes.body.data.assigneeId } },
    })
    expect(doneProgress?.completedAt).not.toBeNull()

    // approve 后按 DONE item 拆 1 条 Record
    const approveRes = await request(seApp)
      .post(`/api/admin/standard-execution/reviews/${submissionId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(approveRes.status).toBe(200)
    const records = await prisma.standardExecutionRecord.findMany({ where: { submissionId } })
    expect(records.length).toBe(1)
    expect(records[0].taskItemId).toBe(items[0].id)
    expect(records[0].requirementId).toBe(items[0].requirementId)
  })
})
