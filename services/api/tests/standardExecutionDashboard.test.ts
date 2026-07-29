/**
 * standard-execution / Dashboard — counts 聚合 + recent 列表 + risks 总数
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

describe('GET /dashboard', () => {
  it('空库 → 全 0', async () => {
    const admin = await createUser({ role: 'admin' })
    const token = getTestToken(admin.id, 'admin')
    const r = await request(app)
      .get('/api/admin/standard-execution/dashboard')
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(200)
    const c = r.body.data.counts
    expect(c.sources).toBe(0)
    expect(c.tasks).toBe(0)
    expect(c.records).toBe(0)
    expect(c.packages).toBe(0)
    expect(c.risks).toBe(0)
    expect(r.body.data.recentTasks).toEqual([])
    expect(r.body.data.recentReviews).toEqual([])
    expect(r.body.data.recentRecords).toEqual([])
    expect(r.body.data.complianceRadar.metrics.controlPointCoverage).toEqual({ covered: 0, total: 0, rate: 0 })
    expect(r.body.data.complianceRadar.heatmap).toEqual([])
    expect(r.body.data.complianceRadar.expiringRecords).toEqual([])
  })

  it('合规雷达指标 + 标准来源热力图 + 到期预警计算正确', async () => {
    const admin = await createUser({ role: 'admin' })
    const u = await createUser({ role: 'user' })
    const token = getTestToken(admin.id, 'admin')
    const now = Date.now()

    const sourceA = await prisma.standardExecutionSource.create({ data: { enterpriseId: 'DEFAULT', title: 'A 标准', sourceNo: 'A-001', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id } })
    const sourceB = await prisma.standardExecutionSource.create({ data: { enterpriseId: 'DEFAULT', title: 'B 标准', sourceNo: 'B-001', sourceType: 'TECH_STANDARD', createdBy: admin.id } })
    const reqA1 = await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'DEFAULT', sourceId: sourceA.id, title: 'A1', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id } })
    const reqA2 = await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'DEFAULT', sourceId: sourceA.id, title: 'A2', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id } })
    const reqB1 = await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'DEFAULT', sourceId: sourceB.id, title: 'B1', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id } })

    const taskA1 = await prisma.standardExecutionTask.create({ data: { enterpriseId: 'DEFAULT', requirementId: reqA1.id, title: 'A1 完成任务', submitRequirement: 'x', deadlineAt: new Date(now + 86400000), reviewerId: admin.id, status: 'COMPLETED', publishedAt: new Date(now), completedAt: new Date(now), createdBy: admin.id } })
    const taskA2 = await prisma.standardExecutionTask.create({ data: { enterpriseId: 'DEFAULT', requirementId: reqA2.id, title: 'A2 逾期任务', submitRequirement: 'x', deadlineAt: new Date(now - 86400000), reviewerId: admin.id, status: 'OVERDUE', publishedAt: new Date(now), createdBy: admin.id } })
    const taskB1 = await prisma.standardExecutionTask.create({ data: { enterpriseId: 'DEFAULT', requirementId: reqB1.id, title: 'B1 完成任务', submitRequirement: 'x', deadlineAt: new Date(now + 86400000), reviewerId: admin.id, status: 'COMPLETED', publishedAt: new Date(now), completedAt: new Date(now), createdBy: admin.id } })

    const subA1 = await prisma.standardExecutionSubmission.create({ data: { enterpriseId: 'DEFAULT', taskId: taskA1.id, assigneeId: u.id, submitText: 'ok', status: 'APPROVED', version: 1, isLatest: true, reviewedAt: new Date(now), reviewerId: admin.id } })
    await prisma.standardExecutionSubmission.create({ data: { enterpriseId: 'DEFAULT', taskId: taskA2.id, assigneeId: u.id, submitText: 'reject', status: 'REJECTED', version: 1, isLatest: true, reviewedAt: new Date(now), reviewerId: admin.id } })
    const subB1 = await prisma.standardExecutionSubmission.create({ data: { enterpriseId: 'DEFAULT', taskId: taskB1.id, assigneeId: u.id, submitText: 'ok', status: 'APPROVED', version: 1, isLatest: true, reviewedAt: new Date(now), reviewerId: admin.id } })

    await prisma.standardExecutionRecord.create({
      data: { enterpriseId: 'DEFAULT', sourceId: sourceA.id, requirementId: reqA1.id, taskId: taskA1.id, submissionId: subA1.id, assigneeId: u.id, title: '5 天后到期', status: 'VALID', validUntil: new Date(now + 5 * 86400000) },
    })
    await prisma.standardExecutionRecord.create({
      data: { enterpriseId: 'DEFAULT', sourceId: sourceB.id, requirementId: reqB1.id, taskId: taskB1.id, submissionId: subB1.id, assigneeId: u.id, title: '已过期仍有效', status: 'VALID', validUntil: new Date(now - 86400000) },
    })
    const r = await request(app)
      .get('/api/admin/standard-execution/dashboard')
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(200)
    const radar = r.body.data.complianceRadar
    expect(radar.metrics.controlPointCoverage).toEqual({ covered: 2, total: 3, rate: 67 })
    expect(radar.metrics.monthlyTaskCompletion).toEqual({ completed: 2, total: 3, rate: 67 })
    expect(radar.metrics.reviewPassRate).toEqual({ approved: 2, total: 3, rate: 67 })
    expect(radar.metrics.overdueTasks.count).toBe(1)
    expect(radar.heatmap).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: sourceA.id, controlPointCount: 2, coveredCount: 1, coverageRate: 50, overdueTaskCount: 1 }),
      expect.objectContaining({ sourceId: sourceB.id, controlPointCount: 1, coveredCount: 1, coverageRate: 100, overdueTaskCount: 0 }),
    ]))
    expect(radar.expiringRecords.map((item: { severity: string }) => item.severity)).toEqual(['ERROR', 'RED'])
    expect(radar.riskEvents.some((item: { riskType: string; relatedId: string }) => item.riskType === 'TASK_OVERDUE' && item.relatedId === taskA2.id)).toBe(true)
  })

  it('多数据 → 各 count 正确 + tasksOverdue 实时算', async () => {
    const admin = await createUser({ role: 'admin' })
    const u = await createUser({ role: 'user' })
    const token = getTestToken(admin.id, 'admin')

    const src = await prisma.standardExecutionSource.create({ data: { enterpriseId: 'DEFAULT', title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id } })
    const reqActive = await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'r', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id } })
    await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'r2', requirementText: 'x', status: 'DRAFT', createdBy: admin.id } })

    // 1 DRAFT task
    await prisma.standardExecutionTask.create({ data: { enterpriseId: 'DEFAULT', requirementId: reqActive.id, title: 't1', submitRequirement: 'x', deadlineAt: new Date(Date.now() + 86400000), reviewerId: admin.id, status: 'DRAFT', createdBy: admin.id } })
    // 1 PUBLISHED 未逾期
    await prisma.standardExecutionTask.create({ data: { enterpriseId: 'DEFAULT', requirementId: reqActive.id, title: 't2', submitRequirement: 'x', deadlineAt: new Date(Date.now() + 86400000), reviewerId: admin.id, status: 'PUBLISHED', publishedAt: new Date(), createdBy: admin.id } })
    // 1 PUBLISHED 逾期
    const overdueT = await prisma.standardExecutionTask.create({ data: { enterpriseId: 'DEFAULT', requirementId: reqActive.id, title: 't3', submitRequirement: 'x', deadlineAt: new Date(Date.now() - 86400000), reviewerId: admin.id, status: 'PUBLISHED', publishedAt: new Date(), createdBy: admin.id } })
    // 1 COMPLETED
    await prisma.standardExecutionTask.create({ data: { enterpriseId: 'DEFAULT', requirementId: reqActive.id, title: 't4', submitRequirement: 'x', deadlineAt: new Date(Date.now() + 86400000), reviewerId: admin.id, status: 'COMPLETED', completedAt: new Date(), publishedAt: new Date(), createdBy: admin.id } })

    // 1 assignee PENDING
    await prisma.standardExecutionTaskAssignee.create({ data: { enterpriseId: 'DEFAULT', taskId: overdueT.id, assigneeId: u.id, status: 'PENDING' } })

    // 1 SUBMITTED submission
    const sub = await prisma.standardExecutionSubmission.create({ data: { enterpriseId: 'DEFAULT', taskId: overdueT.id, assigneeId: u.id, submitText: 'x', status: 'SUBMITTED', version: 1, isLatest: true } })

    // 1 VALID record
    await prisma.standardExecutionRecord.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, requirementId: reqActive.id, taskId: overdueT.id, submissionId: sub.id, assigneeId: u.id, title: 'rec', status: 'VALID' },
    })

    // 1 DRAFT + 1 READY package
    await prisma.standardExecutionPackage.create({ data: { enterpriseId: 'DEFAULT', title: 'p1', packageScene: 'INTERNAL_CHECK', createdBy: admin.id } })
    await prisma.standardExecutionPackage.create({ data: { enterpriseId: 'DEFAULT', title: 'p2', packageScene: 'INTERNAL_CHECK', status: 'READY', generatedAt: new Date(), createdBy: admin.id } })

    const r = await request(app)
      .get('/api/admin/standard-execution/dashboard')
      .set('Authorization', `Bearer ${token}`)
    const c = r.body.data.counts
    expect(c.sources).toBe(1)
    expect(c.requirements).toBe(2)
    expect(c.requirementsActive).toBe(1)
    expect(c.tasks).toBe(4)
    expect(c.tasksDraft).toBe(1)
    expect(c.tasksPublished).toBe(2)
    expect(c.tasksCompleted).toBe(1)
    expect(c.tasksOverdue).toBe(1)
    expect(c.assigneesPending).toBe(1)
    expect(c.submissionsPending).toBe(1)
    expect(c.packages).toBe(2)
    expect(c.packagesReady).toBe(1)
    expect(c.records).toBe(1)
    expect(c.recordsValid).toBe(1)

    expect(r.body.data.recentTasks.length).toBe(3) // PUBLISHED + COMPLETED + OVERDUE (DRAFT 不算)
    expect(r.body.data.recentReviews.length).toBe(1)
    expect(r.body.data.recentRecords.length).toBe(1)
  })

  it('enterpriseId 隔离', async () => {
    const admin = await createUser({ role: 'admin' })
    const token = getTestToken(admin.id, 'admin')
    await prisma.standardExecutionSource.create({ data: { enterpriseId: 'OTHER', title: 'x', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id } })
    const r = await request(app)
      .get('/api/admin/standard-execution/dashboard')
      .set('Authorization', `Bearer ${token}`)
    expect(r.body.data.counts.sources).toBe(0)
  })

  it('user role → 403', async () => {
    const u = await createUser({ role: 'user' })
    const token = getTestToken(u.id, 'user')
    const r = await request(app)
      .get('/api/admin/standard-execution/dashboard')
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(403)
  })

  it('无 token → 401', async () => {
    const r = await request(app).get('/api/admin/standard-execution/dashboard')
    expect(r.status).toBe(401)
  })
})
