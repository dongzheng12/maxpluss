import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { cleanStandardExecutionData } from './seClean.js'
import { cleanAll, createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerEnterpriseRoutes(app)
})

beforeEach(async () => {
  await cleanStandardExecutionData()
  await cleanAll()
  for (const id of ['ENT_A', 'ENT_B']) {
    await prisma.enterprise.upsert({
      where: { id },
      update: { name: id === 'ENT_A' ? 'A 企业' : 'B 企业', status: 'ACTIVE' },
      create: { id, name: id === 'ENT_A' ? 'A 企业' : 'B 企业', code: id, status: 'ACTIVE' },
    })
  }
})

async function enterpriseUser(enterpriseId = 'ENT_A', enterpriseRole = 'ADMIN') {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({ where: { id: user.id }, data: { enterpriseId, enterpriseRole } })
  return { user, token: getTestToken(user.id, 'user') }
}

async function seedRequirement(createdBy: string, enterpriseId = 'ENT_A', title = '温控记录') {
  const source = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId,
      title: `${enterpriseId} 食品安全标准`,
      sourceType: 'PRODUCT_STANDARD',
      sourceNo: `${enterpriseId}-GB`,
      status: 'ACTIVE',
      createdBy,
    },
  })
  const requirement = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId,
      sourceId: source.id,
      clauseNo: '5.1',
      title,
      requirementText: `${title} 要求正文`,
      recommendedTaskType: 'INSPECTION_FILL',
      status: 'ACTIVE',
      createdBy,
    },
  })
  return { source, requirement }
}

describe('SE compliance cycles', () => {
  it('企业 reviewer+ 可创建模板、启动周期、生成任务并导出报告', async () => {
    const { user: admin, token } = await enterpriseUser('ENT_A', 'ADMIN')
    const { user: reviewer } = await enterpriseUser('ENT_A', 'REVIEWER')
    const { user: assignee } = await enterpriseUser('ENT_A', 'EMPLOYEE')
    const req1 = await seedRequirement(admin.id, 'ENT_A', '温控记录')
    const req2 = await seedRequirement(admin.id, 'ENT_A', '清洁消毒')

    const created = await request(app)
      .post('/api/enterprise/standard-execution/cycle-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: '食品安全季度检查',
        cycleType: 'QUARTERLY',
        requirementIds: [req1.requirement.id, req2.requirement.id],
        taskConfig: {
          reviewerId: reviewer.id,
          assigneeIds: [assignee.id],
          taskStatus: 'DRAFT',
          deadlineMode: 'AFTER_APPROVAL_DAYS',
          deadlineDaysAfterApproval: 7,
        },
      })
    expect(created.status).toBe(201)
    expect(created.body.data.requirementIds).toHaveLength(2)

    const started = await request(app)
      .post(`/api/enterprise/standard-execution/cycle-templates/${created.body.data.id}/start`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: '2026 Q3 食品安全检查',
        startDate: '2026-07-01T00:00:00.000Z',
        endDate: '2026-09-30T23:59:59.000Z',
      })
    expect(started.status).toBe(201)
    expect(started.body.data.status).toBe('ACTIVE')
    expect(started.body.plan.complianceCycleId).toBe(started.body.data.id)
    expect(started.body.createdItems).toBe(2)

    const tasks = await prisma.standardExecutionTask.findMany({
      where: { enterpriseId: 'ENT_A', planId: started.body.plan.id },
      include: { items: true, assignees: true },
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].items).toHaveLength(2)
    expect(tasks[0].assignees[0].assigneeId).toBe(assignee.id)

    const detail = await request(app)
      .get(`/api/enterprise/standard-execution/cycles/${started.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(detail.status).toBe(200)
    expect(detail.body.stats.totalRequirements).toBe(2)
    expect(detail.body.stats.totalTasks).toBe(1)
    expect(detail.body.requirements).toHaveLength(2)

    const report = await request(app)
      .post(`/api/enterprise/standard-execution/cycles/${started.body.data.id}/report`)
      .set('Authorization', `Bearer ${token}`)
    expect(report.status).toBe(200)
    expect(report.body.fileUrl).toMatch(/\.pdf$/)
    expect(report.body.data.reportStatus).toBe('READY')
  })

  it('普通企业员工不能创建周期模板', async () => {
    const { token } = await enterpriseUser('ENT_A', 'EMPLOYEE')
    const res = await request(app)
      .post('/api/enterprise/standard-execution/cycle-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '员工模板', cycleType: 'MONTHLY', requirementIds: ['req-1'] })
    expect(res.status).toBe(403)
  })

  it('跨企业控制点不能保存到周期模板', async () => {
    const { user: admin, token } = await enterpriseUser('ENT_A', 'ADMIN')
    const other = await seedRequirement(admin.id, 'ENT_B', 'B 企业控制点')
    const res = await request(app)
      .post('/api/enterprise/standard-execution/cycle-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '越权模板', cycleType: 'ANNUAL', requirementIds: [other.requirement.id] })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('不属于当前企业')
  })
})
