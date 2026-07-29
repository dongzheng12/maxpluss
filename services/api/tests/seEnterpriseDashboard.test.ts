/**
 * 企业版 standard-execution Dashboard — counts + enterpriseId 隔离 + 权限
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerStandardExecutionDashboardRoutes } from '../src/standard-execution/dashboardRoutes.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionDashboardRoutes(app)
})

beforeEach(async () => {
  await cleanStandardExecutionData()

  for (const id of ['ENT_DASH_A', 'ENT_DASH_B']) {
    await prisma.enterprise.upsert({
      where: { id },
      update: { name: id, status: 'ACTIVE' },
      create: { id, name: id, code: id, status: 'ACTIVE' },
    })
  }
})

async function seedDashboardData(enterpriseId: string, userId: string) {
  const src = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId,
      title: `${enterpriseId} 标准来源`,
      sourceType: 'PRODUCT_STANDARD',
      createdBy: userId,
    },
  })
  const req = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId,
      sourceId: src.id,
      title: `${enterpriseId} 要求项`,
      requirementText: '执行要求',
      status: 'ACTIVE',
      createdBy: userId,
    },
  })
  const task = await prisma.standardExecutionTask.create({
    data: {
      enterpriseId,
      requirementId: req.id,
      title: `${enterpriseId} 任务`,
      submitRequirement: '提交记录',
      deadlineAt: new Date(Date.now() - 3600_000),
      reviewerId: userId,
      status: 'PUBLISHED',
      publishedAt: new Date(),
      createdBy: userId,
    },
  })
  await prisma.standardExecutionTaskAssignee.create({
    data: {
      enterpriseId,
      taskId: task.id,
      assigneeId: userId,
      reviewerId: userId,
      status: 'PENDING',
    },
  })
  await prisma.standardExecutionPackage.create({
    data: {
      enterpriseId,
      title: `${enterpriseId} 材料包`,
      packageScene: 'INTERNAL_CHECK',
      status: 'READY',
      generatedAt: new Date(),
      createdBy: userId,
    },
  })
  return { src, req, task }
}

describe('GET /api/enterprise/standard-execution/dashboard', () => {
  it('企业成员返回本企业 counts/recent 数据', async () => {
    const user = await createUser({ role: 'user' })
    await prisma.appUser.update({
      where: { id: user.id },
      data: { enterpriseId: 'ENT_DASH_A', enterpriseRole: 'MANAGER' },
    })
    const token = getTestToken(user.id, 'user')
    const seeded = await seedDashboardData('ENT_DASH_A', user.id)

    const res = await request(app)
      .get('/api/enterprise/standard-execution/dashboard')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.counts.sources).toBe(1)
    expect(res.body.data.counts.requirements).toBe(1)
    expect(res.body.data.counts.requirementsActive).toBe(1)
    expect(res.body.data.counts.tasks).toBe(1)
    expect(res.body.data.counts.tasksPublished).toBe(1)
    expect(res.body.data.counts.tasksOverdue).toBe(1)
    expect(res.body.data.counts.assigneesPending).toBe(1)
    expect(res.body.data.counts.packages).toBe(1)
    expect(res.body.data.counts.packagesReady).toBe(1)
    expect(res.body.data.counts.risks).toBe(2)
    expect(res.body.data.complianceRadar.metrics.controlPointCoverage).toEqual({ covered: 0, total: 1, rate: 0 })
    expect(res.body.data.complianceRadar.metrics.overdueTasks.count).toBe(1)
    expect(res.body.data.complianceRadar.heatmap).toEqual([
      expect.objectContaining({
        sourceId: seeded.src.id,
        controlPointCount: 1,
        coveredCount: 0,
        coverageRate: 0,
        overdueTaskCount: 1,
      }),
    ])
    expect(res.body.data.recentTasks).toHaveLength(1)
    expect(res.body.data.recentTasks[0].id).toBe(seeded.task.id)
  })

  it('按当前 enterpriseId 隔离其他企业数据', async () => {
    const user = await createUser({ role: 'user' })
    await prisma.appUser.update({
      where: { id: user.id },
      data: { enterpriseId: 'ENT_DASH_A', enterpriseRole: 'ADMIN' },
    })
    const other = await createUser({ role: 'user' })
    await seedDashboardData('ENT_DASH_B', other.id)

    const res = await request(app)
      .get('/api/enterprise/standard-execution/dashboard')
      .set('Authorization', `Bearer ${getTestToken(user.id, 'user')}`)

    expect(res.status).toBe(200)
    expect(res.body.data.counts.sources).toBe(0)
    expect(res.body.data.counts.tasks).toBe(0)
    expect(res.body.data.complianceRadar.metrics.controlPointCoverage.total).toBe(0)
    expect(res.body.data.complianceRadar.heatmap).toEqual([])
    expect(res.body.data.recentTasks).toEqual([])
  })

  it('无企业绑定普通用户返回 403', async () => {
    const user = await createUser({ role: 'user' })
    const res = await request(app)
      .get('/api/enterprise/standard-execution/dashboard')
      .set('Authorization', `Bearer ${getTestToken(user.id, 'user')}`)

    expect(res.status).toBe(403)
  })
})
