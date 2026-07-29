/**
 * 要求项批量生成任务 — admin + 企业版端点
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerStandardExecutionRoutes } from '../src/standard-execution/sourceRoutes.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
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

async function createActiveRequirement(
  enterpriseId: string,
  userId: string,
  title: string,
  opts: Partial<{
    sourceId: string
    recommendedTaskType: string
    clauseNo: string
    executionDescription: string
    submitRequirement: string
  }> = {},
) {
  const source = await prisma.standardExecutionSource.create({
    data: { id: opts.sourceId, enterpriseId, title: `${title} 来源`, sourceType: 'PRODUCT_STANDARD', status: 'ACTIVE', createdBy: userId },
  })
  return prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId,
      sourceId: source.id,
      clauseNo: opts.clauseNo ?? null,
      title,
      requirementText: `${title} 的执行要求`,
      status: 'ACTIVE',
      recommendedTaskType: opts.recommendedTaskType ?? null,
      executionDescription: opts.executionDescription ?? null,
      submitRequirement: opts.submitRequirement ?? null,
      createdBy: userId,
    },
  })
}

describe('POST /requirements/batch-create-tasks', () => {
  it('admin 可按多个 ACTIVE 要求项批量生成 DRAFT 任务', async () => {
    const admin = await createUser({ role: 'admin' })
    const reviewer = await createUser({ role: 'user' })
    const assignee = await createUser({ role: 'user' })
    const reqA = await createActiveRequirement('DEFAULT', admin.id, '外观检查')
    const reqB = await createActiveRequirement('DEFAULT', admin.id, '尺寸测量')

    const res = await request(app)
      .post('/api/admin/standard-execution/requirements/batch-create-tasks')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        requirementIds: [reqA.id, reqB.id],
        titlePrefix: '5月内审',
        taskType: 'ARCHIVE_MATERIAL',
        submitRequirement: '提交执行记录',
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [assignee.id],
      })

    expect(res.status).toBe(201)
    expect(res.body.createdCount).toBe(2)
    expect(res.body.data[0].status).toBe('DRAFT')
    expect(res.body.data[0].taskType).toBe('ARCHIVE_MATERIAL')
    expect(res.body.data[0].title).toContain('5月内审')

    const assigneeCount = await prisma.standardExecutionTaskAssignee.count({
      where: { enterpriseId: 'DEFAULT' },
    })
    expect(assigneeCount).toBe(2)
  })

  it('batch-create 带 quizBankId → 生成的 TRAINING 任务挂上题库（bug 回归）', async () => {
    const admin = await createUser({ role: 'admin' })
    const reviewer = await createUser({ role: 'user' })
    const assignee = await createUser({ role: 'user' })
    const req = await createActiveRequirement('DEFAULT', admin.id, '培训确认')
    const bank = await prisma.sEQuestionBank.create({
      data: {
        enterpriseId: 'DEFAULT', title: '考核题库', createdBy: admin.id,
        questions: [{ id: 'q1', type: 'single', text: '?', opts: ['a', 'b'], answer: [0], score: 100 }] as never,
      },
    })
    const res = await request(app)
      .post('/api/admin/standard-execution/requirements/batch-create-tasks')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        requirementIds: [req.id],
        taskType: 'TRAINING',
        submitRequirement: '完成答题',
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [assignee.id],
        quizBankId: bank.id,
      })
    expect(res.status).toBe(201)
    expect(res.body.data[0].quizBankId).toBe(bank.id)
  })

  it('企业版只允许本企业要求项参与批量生成', async () => {
    const enterpriseId = 'ENT_BATCH_A'
    const otherEnterpriseId = 'ENT_BATCH_B'
    await prisma.enterprise.upsert({
      where: { id: enterpriseId },
      update: {},
      create: { id: enterpriseId, name: '批量任务 A', code: enterpriseId, status: 'ACTIVE' },
    })
    await prisma.enterprise.upsert({
      where: { id: otherEnterpriseId },
      update: {},
      create: { id: otherEnterpriseId, name: '批量任务 B', code: otherEnterpriseId, status: 'ACTIVE' },
    })

    const admin = await createUser({ role: 'user' })
    const assignee = await createUser({ role: 'user' })
    await prisma.appUser.updateMany({
      where: { id: { in: [admin.id, assignee.id] } },
      data: { enterpriseId, enterpriseRole: 'ADMIN' },
    })
    const ownReq = await createActiveRequirement(enterpriseId, admin.id, '本企业要求')
    const otherReq = await createActiveRequirement(otherEnterpriseId, admin.id, '其他企业要求')

    const res = await request(app)
      .post('/api/enterprise/standard-execution/requirements/batch-create-tasks')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'user')}`)
      .send({
        requirementIds: [ownReq.id, otherReq.id],
        taskType: 'OTHER',
        submitRequirement: '提交执行记录',
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: admin.id,
        assigneeIds: [assignee.id],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('不属于当前企业')
  })

  it('企业版批量生成拒绝其他企业审核人或执行人', async () => {
    const enterpriseId = 'ENT_BATCH_USER_A'
    const otherEnterpriseId = 'ENT_BATCH_USER_B'
    await prisma.enterprise.upsert({
      where: { id: enterpriseId },
      update: {},
      create: { id: enterpriseId, name: '批量任务用户 A', code: enterpriseId, status: 'ACTIVE' },
    })
    await prisma.enterprise.upsert({
      where: { id: otherEnterpriseId },
      update: {},
      create: { id: otherEnterpriseId, name: '批量任务用户 B', code: otherEnterpriseId, status: 'ACTIVE' },
    })

    const admin = await createUser({ role: 'user' })
    const otherAssignee = await createUser({ role: 'user' })
    await prisma.appUser.update({
      where: { id: admin.id },
      data: { enterpriseId, enterpriseRole: 'ADMIN' },
    })
    await prisma.appUser.update({
      where: { id: otherAssignee.id },
      data: { enterpriseId: otherEnterpriseId, enterpriseRole: 'EMPLOYEE' },
    })
    const req = await createActiveRequirement(enterpriseId, admin.id, '本企业要求')

    const res = await request(app)
      .post('/api/enterprise/standard-execution/requirements/batch-create-tasks')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'user')}`)
      .send({
        requirementIds: [req.id],
        taskType: 'OTHER',
        submitRequirement: '提交执行记录',
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: admin.id,
        assigneeIds: [otherAssignee.id],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('本企业')
  })

  it('企业版批量生成（去 Plan）按 recommendedTaskType 合并 Task + 多个 TaskItem', async () => {
    const enterpriseId = 'ENT_BATCH_GROUP'
    await prisma.enterprise.upsert({
      where: { id: enterpriseId },
      update: {},
      create: { id: enterpriseId, name: '批量任务分组', code: enterpriseId, status: 'ACTIVE' },
    })

    const admin = await createUser({ role: 'user' })
    const reviewer = await createUser({ role: 'user' })
    const assigneeA = await createUser({ role: 'user' })
    const assigneeB = await createUser({ role: 'user' })
    await prisma.appUser.updateMany({
      where: { id: { in: [admin.id, reviewer.id, assigneeA.id, assigneeB.id] } },
      data: { enterpriseId, enterpriseRole: 'ADMIN' },
    })

    const reqA1 = await createActiveRequirement(enterpriseId, admin.id, '培训检查点 A1', {
      recommendedTaskType: 'TRAINING',
      clauseNo: '4.1',
      executionDescription: '组织岗位培训并留存签到',
      submitRequirement: '上传签到表',
    })
    const reqA2 = await createActiveRequirement(enterpriseId, admin.id, '培训检查点 A2', {
      recommendedTaskType: 'TRAINING',
      clauseNo: '4.2',
      executionDescription: '完成培训考核',
      submitRequirement: '上传考核结果',
    })
    const reqB = await createActiveRequirement(enterpriseId, admin.id, '整改检查点 B', {
      recommendedTaskType: 'RECTIFICATION',
      clauseNo: '5.1',
      executionDescription: '整改不符合项',
    })

    const res = await request(app)
      .post('/api/enterprise/standard-execution/requirements/batch-create-tasks')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'user')}`)
      .send({
        requirementIds: [reqA1.id, reqA2.id, reqB.id],
        titlePrefix: '本轮执行',
        submitRequirement: '提交执行证明',
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [assigneeA.id, assigneeB.id],
      })

    expect(res.status).toBe(201)
    expect(res.body.planId).toBeNull()
    expect(res.body.createdCount).toBe(2)
    expect(res.body.createdItems).toBe(3)
    expect(res.body.groups.map((g: { taskType: string }) => g.taskType).sort()).toEqual(['RECTIFICATION', 'TRAINING'])

    // 去 Plan 后任务不再挂 planId，按企业维度回查
    const tasks = await prisma.standardExecutionTask.findMany({
      where: { enterpriseId },
      include: { items: { include: { requirement: true } }, assignees: true },
      orderBy: { taskType: 'asc' },
    })
    expect(tasks.every((t) => t.planId === null)).toBe(true)
    const training = tasks.find((t) => t.taskType === 'TRAINING')!
    const rectification = tasks.find((t) => t.taskType === 'RECTIFICATION')!
    expect(training.items.map((i) => i.requirement.title).sort()).toEqual(['培训检查点 A1', '培训检查点 A2'])
    expect(training.items[0].requirement.executionDescription).toBeTruthy()
    expect(training.assignees.length).toBe(2)
    expect(training.basisSnapshots).toEqual([
      expect.objectContaining({ requirementId: reqA1.id, title: '培训检查点 A1', clauseNo: '4.1' }),
      expect.objectContaining({ requirementId: reqA2.id, title: '培训检查点 A2', clauseNo: '4.2' }),
    ])
    expect(rectification.items.map((i) => i.requirementId)).toEqual([reqB.id])
  })

  it('企业版手动 taskType 覆盖推荐类型，统一生成一个任务组', async () => {
    const enterpriseId = 'ENT_BATCH_FORCE'
    await prisma.enterprise.upsert({
      where: { id: enterpriseId },
      update: {},
      create: { id: enterpriseId, name: '批量任务覆盖', code: enterpriseId, status: 'ACTIVE' },
    })
    const admin = await createUser({ role: 'user' })
    const assignee = await createUser({ role: 'user' })
    await prisma.appUser.updateMany({
      where: { id: { in: [admin.id, assignee.id] } },
      data: { enterpriseId, enterpriseRole: 'ADMIN' },
    })
    const reqA = await createActiveRequirement(enterpriseId, admin.id, '培训项', { recommendedTaskType: 'TRAINING' })
    const reqB = await createActiveRequirement(enterpriseId, admin.id, '整改项', { recommendedTaskType: 'RECTIFICATION' })

    const res = await request(app)
      .post('/api/enterprise/standard-execution/requirements/batch-create-tasks')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'user')}`)
      .send({
        requirementIds: [reqA.id, reqB.id],
        taskType: 'ARCHIVE_MATERIAL',
        submitRequirement: '归档材料',
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: admin.id,
        assigneeIds: [assignee.id],
      })

    expect(res.status).toBe(201)
    expect(res.body.createdCount).toBe(1)
    expect(res.body.createdItems).toBe(2)
    expect(res.body.data[0].taskType).toBe('ARCHIVE_MATERIAL')
  })

  it('不传 taskType → 继承检查点 recommendedTaskType', async () => {
    const admin = await createUser({ role: 'admin' })
    const reviewer = await createUser({ role: 'user' })
    const assignee = await createUser({ role: 'user' })
    const source = await prisma.standardExecutionSource.create({
      data: { enterpriseId: 'DEFAULT', title: '培训来源', sourceType: 'PRODUCT_STANDARD', status: 'ACTIVE', createdBy: admin.id },
    })
    const req = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: source.id, title: '培训检查点', requirementText: '应组织年度培训', status: 'ACTIVE', recommendedTaskType: 'TRAINING', createdBy: admin.id },
    })
    const res = await request(app)
      .post('/api/admin/standard-execution/requirements/batch-create-tasks')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        requirementIds: [req.id],
        submitRequirement: '完成培训',
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [assignee.id],
      })
    expect(res.status).toBe(201)
    expect(res.body.data[0].taskType).toBe('TRAINING')
  })

  it('显式传 taskType 优先于检查点推荐类型', async () => {
    const admin = await createUser({ role: 'admin' })
    const reviewer = await createUser({ role: 'user' })
    const assignee = await createUser({ role: 'user' })
    const source = await prisma.standardExecutionSource.create({
      data: { enterpriseId: 'DEFAULT', title: '来源X', sourceType: 'PRODUCT_STANDARD', status: 'ACTIVE', createdBy: admin.id },
    })
    const req = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: source.id, title: '检查点X', requirementText: '应检查记录', status: 'ACTIVE', recommendedTaskType: 'TRAINING', createdBy: admin.id },
    })
    const res = await request(app)
      .post('/api/admin/standard-execution/requirements/batch-create-tasks')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        requirementIds: [req.id],
        taskType: 'INSPECTION_FILL',
        submitRequirement: '填检查表',
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [assignee.id],
      })
    expect(res.status).toBe(201)
    expect(res.body.data[0].taskType).toBe('INSPECTION_FILL')
  })

  it('不传 taskType 且检查点无推荐类型 → 兜底 OTHER', async () => {
    const admin = await createUser({ role: 'admin' })
    const reviewer = await createUser({ role: 'user' })
    const assignee = await createUser({ role: 'user' })
    const req = await createActiveRequirement('DEFAULT', admin.id, '无推荐类型检查点')
    const res = await request(app)
      .post('/api/admin/standard-execution/requirements/batch-create-tasks')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        requirementIds: [req.id],
        submitRequirement: '提交执行记录',
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [assignee.id],
      })
    expect(res.status).toBe(201)
    expect(res.body.data[0].taskType).toBe('OTHER')
  })

  it('P1-1 回归：平台超管(admin)走企业版批量生成，DEFAULT 企业无 Enterprise 记录也不撞 Plan FK', async () => {
    // resolveEnterpriseId 对 role=admin 直接返回 'DEFAULT'，而 Enterprise 表无 'DEFAULT' 记录。
    // 旧实现先建 StandardExecutionPlan(enterpriseId='DEFAULT') → FK P2003 → 整事务回滚 500（生产 2026-05-29 实证）。
    // 去 Plan 化后应 201，planId=null，任务正常生成，且全程不创建任何 Plan。
    const admin = await createUser({ role: 'admin' })
    const reviewer = await createUser({ role: 'admin' })
    const assignee = await createUser({ role: 'admin' })
    const reqA = await createActiveRequirement('DEFAULT', admin.id, '回归检查点A', { recommendedTaskType: 'TRAINING' })
    const reqB = await createActiveRequirement('DEFAULT', admin.id, '回归检查点B', { recommendedTaskType: 'TRAINING' })

    const res = await request(app)
      .post('/api/enterprise/standard-execution/requirements/batch-create-tasks')
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'admin')}`)
      .send({
        requirementIds: [reqA.id, reqB.id],
        submitRequirement: '提交执行证明',
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [assignee.id],
      })

    expect(res.status).toBe(201)
    expect(res.body.planId).toBeNull()
    expect(res.body.createdCount).toBe(1) // 两个 TRAINING 合并为 1 个 Task
    expect(res.body.createdItems).toBe(2)

    const planCount = await prisma.standardExecutionPlan.count()
    expect(planCount).toBe(0)

    const tasks = await prisma.standardExecutionTask.findMany({ where: { enterpriseId: 'DEFAULT' } })
    expect(tasks.length).toBe(1)
    expect(tasks[0].planId).toBeNull()
  })
})
