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
  await prisma.enterprise.upsert({
    where: { id: 'DEFAULT' },
    update: { name: 'DEFAULT', status: 'ACTIVE' },
    create: { id: 'DEFAULT', name: 'DEFAULT', code: 'DEFAULT', status: 'ACTIVE' },
  })
})

async function adminCtx() {
  const admin = await createUser({ role: 'admin' })
  return { admin, token: getTestToken(admin.id, 'admin') }
}

async function makeRecord(adminId: string, opts: {
  enterpriseId?: string
  sourceId?: string
  requirementId?: string
  taskId?: string
  planId?: string
  status?: 'VALID' | 'VOID' | 'EXPIRED'
} = {}) {
  const enterpriseId = opts.enterpriseId ?? 'DEFAULT'
  const user = await createUser({ role: 'user' })
  const source = opts.sourceId
    ? await prisma.standardExecutionSource.findUniqueOrThrow({ where: { id: opts.sourceId } })
    : await prisma.standardExecutionSource.create({
        data: { enterpriseId, title: 'source', sourceType: 'PRODUCT_STANDARD', createdBy: adminId },
      })
  const requirement = opts.requirementId
    ? await prisma.standardExecutionRequirement.findUniqueOrThrow({ where: { id: opts.requirementId } })
    : await prisma.standardExecutionRequirement.create({
        data: { enterpriseId, sourceId: source.id, title: 'requirement', requirementText: 'x', status: 'ACTIVE', createdBy: adminId },
      })
  const task = opts.taskId
    ? await prisma.standardExecutionTask.findUniqueOrThrow({ where: { id: opts.taskId } })
    : await prisma.standardExecutionTask.create({
        data: {
          enterpriseId,
          requirementId: requirement.id,
          planId: opts.planId ?? null,
          title: 'task',
          submitRequirement: 'x',
          deadlineAt: new Date(Date.now() + 86400000),
          reviewerId: adminId,
          status: 'PUBLISHED',
          createdBy: adminId,
        },
      })
  const submission = await prisma.standardExecutionSubmission.create({
    data: { enterpriseId, taskId: task.id, assigneeId: user.id, submitText: 'ok', status: 'APPROVED', version: 1, isLatest: true },
  })
  const record = await prisma.standardExecutionRecord.create({
    data: {
      enterpriseId,
      sourceId: source.id,
      requirementId: requirement.id,
      taskId: task.id,
      submissionId: submission.id,
      assigneeId: user.id,
      title: `${opts.status ?? 'VALID'} record`,
      status: opts.status ?? 'VALID',
    },
  })
  return { source, requirement, task, submission, record }
}

async function createPackage(token: string, body: Record<string, unknown>) {
  return request(app)
    .post('/api/admin/standard-execution/packages')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: '多级选择包', packageScene: 'INTERNAL_CHECK', ...body })
}

async function packageRecordIds(packageId: string) {
  const items = await prisma.standardExecutionPackageItem.findMany({
    where: { packageId },
    orderBy: { sortNo: 'asc' },
  })
  return items.map((i) => i.recordId)
}

describe('Package multi-level selection', () => {
  it('recordIds only：按记录直接创建', async () => {
    const { admin, token } = await adminCtx()
    const a = await makeRecord(admin.id)
    const b = await makeRecord(admin.id)

    const res = await createPackage(token, { recordIds: [a.record.id, b.record.id] })
    expect(res.status).toBe(201)
    await expect(packageRecordIds(res.body.data.id)).resolves.toEqual([a.record.id, b.record.id])
  })

  it('requirementIds only：解析该要求项下全部 VALID Record', async () => {
    const { admin, token } = await adminCtx()
    const valid = await makeRecord(admin.id)
    const invalid = await makeRecord(admin.id, {
      sourceId: valid.source.id,
      requirementId: valid.requirement.id,
      taskId: valid.task.id,
      status: 'VOID',
    })

    const res = await createPackage(token, { requirementIds: [valid.requirement.id] })
    expect(res.status).toBe(201)
    const ids = await packageRecordIds(res.body.data.id)
    expect(ids).toEqual([valid.record.id])
    expect(ids).not.toContain(invalid.record.id)
  })

  it('taskIds only：解析该任务下全部 VALID Record', async () => {
    const { admin, token } = await adminCtx()
    const valid = await makeRecord(admin.id)
    const expired = await makeRecord(admin.id, {
      sourceId: valid.source.id,
      requirementId: valid.requirement.id,
      taskId: valid.task.id,
      status: 'EXPIRED',
    })

    const res = await createPackage(token, { taskIds: [valid.task.id] })
    expect(res.status).toBe(201)
    const ids = await packageRecordIds(res.body.data.id)
    expect(ids).toEqual([valid.record.id])
    expect(ids).not.toContain(expired.record.id)
  })

  it('planId only：解析计划下任务关联的全部 VALID Record', async () => {
    const { admin, token } = await adminCtx()
    const source = await prisma.standardExecutionSource.create({
      data: { enterpriseId: 'DEFAULT', title: 'plan source', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
    })
    const plan = await prisma.standardExecutionPlan.create({
      data: { enterpriseId: 'DEFAULT', sourceId: source.id, title: '执行计划', createdBy: admin.id },
    })
    const a = await makeRecord(admin.id, { sourceId: source.id, planId: plan.id })
    const b = await makeRecord(admin.id, { sourceId: source.id, planId: plan.id })
    await makeRecord(admin.id, { sourceId: source.id })

    const res = await createPackage(token, { planId: plan.id })
    expect(res.status).toBe(201)
    await expect(packageRecordIds(res.body.data.id)).resolves.toEqual([a.record.id, b.record.id])
  })

  it('无任一级选择 → 400', async () => {
    const { token } = await adminCtx()
    const res = await createPackage(token, {})
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('至少提供一项')
  })
})
