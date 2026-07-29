import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'http'
import express from 'express'
import request from 'supertest'
import xlsx from 'xlsx'
import { prisma } from '../src/db.js'
import { registerStandardExecutionDashboardRoutes } from '../src/standard-execution/dashboardRoutes.js'
import { cleanStandardExecutionData } from './seClean.js'
import { cleanAll, createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionDashboardRoutes(app)
})

beforeEach(async () => {
  await cleanStandardExecutionData()
  await cleanAll()
  for (const id of ['ENT_INT_A', 'ENT_INT_B']) {
    await prisma.enterprise.upsert({
      where: { id },
      update: { name: id, status: 'ACTIVE' },
      create: { id, name: id, code: id, status: 'ACTIVE' },
    })
  }
})

function binaryParser(res: IncomingMessage, callback: (err: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = []
  res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
  res.on('end', () => callback(null, Buffer.concat(chunks)))
}

async function enterpriseUser(enterpriseId: string, enterpriseRole: string, name: string) {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: user.id },
    data: { enterpriseId, enterpriseRole, name },
  })
  return { user, token: getTestToken(user.id, 'user') }
}

async function seedIntelligenceData(enterpriseId: string, managerId: string, assigneeId: string) {
  const now = new Date()
  const oneHourAgo = new Date(now.getTime() - 3600_000)
  const yesterday = new Date(now.getTime() - 24 * 3600_000)
  const source = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId,
      title: `${enterpriseId} 数据看板标准`,
      sourceType: 'PRODUCT_STANDARD',
      createdBy: managerId,
    },
  })
  const coveredReq = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId,
      sourceId: source.id,
      clauseNo: '1.1',
      title: '已覆盖控制点',
      requirementText: '留存执行记录。',
      status: 'ACTIVE',
      createdBy: managerId,
    },
  })
  const uncoveredReq = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId,
      sourceId: source.id,
      clauseNo: '1.2',
      title: '未覆盖控制点',
      requirementText: '按期执行。',
      status: 'ACTIVE',
      createdBy: managerId,
    },
  })
  const completedTask = await prisma.standardExecutionTask.create({
    data: {
      enterpriseId,
      requirementId: coveredReq.id,
      title: '完成任务',
      submitRequirement: '提交记录',
      deadlineAt: new Date(now.getTime() + 24 * 3600_000),
      reviewerId: managerId,
      status: 'COMPLETED',
      publishedAt: oneHourAgo,
      completedAt: now,
      createdBy: managerId,
    },
  })
  await prisma.standardExecutionTaskAssignee.create({
    data: {
      enterpriseId,
      taskId: completedTask.id,
      assigneeId,
      departmentId: 'QA',
      reviewerId: managerId,
      status: 'COMPLETED',
      submittedAt: oneHourAgo,
      reviewedAt: now,
    },
  })
  const approvedSubmission = await prisma.standardExecutionSubmission.create({
    data: {
      enterpriseId,
      taskId: completedTask.id,
      assigneeId,
      submitText: 'ok',
      status: 'APPROVED',
      version: 1,
      isLatest: true,
      submittedAt: oneHourAgo,
      reviewedAt: now,
      reviewerId: managerId,
    },
  })
  await prisma.standardExecutionRecord.create({
    data: {
      enterpriseId,
      sourceId: source.id,
      requirementId: coveredReq.id,
      taskId: completedTask.id,
      submissionId: approvedSubmission.id,
      assigneeId,
      departmentId: 'QA',
      title: '有效证据',
      status: 'VALID',
      recordDate: now,
    },
  })
  const overdueTask = await prisma.standardExecutionTask.create({
    data: {
      enterpriseId,
      requirementId: uncoveredReq.id,
      title: '逾期任务',
      submitRequirement: '提交记录',
      deadlineAt: yesterday,
      reviewerId: managerId,
      status: 'PUBLISHED',
      publishedAt: oneHourAgo,
      createdBy: managerId,
    },
  })
  await prisma.standardExecutionTaskAssignee.create({
    data: {
      enterpriseId,
      taskId: overdueTask.id,
      assigneeId,
      departmentId: 'QA',
      reviewerId: managerId,
      status: 'PENDING',
    },
  })
  await prisma.standardExecutionSubmission.create({
    data: {
      enterpriseId,
      taskId: overdueTask.id,
      assigneeId,
      submitText: 'bad',
      status: 'REJECTED',
      version: 1,
      isLatest: true,
      submittedAt: oneHourAgo,
      reviewedAt: now,
      reviewerId: managerId,
    },
  })
  return { source, coveredReq, uncoveredReq, completedTask, overdueTask }
}

describe('SE intelligence dashboard', () => {
  it('计算企业级覆盖、趋势、部门排行和人员维度', async () => {
    const manager = await enterpriseUser('ENT_INT_A', 'MANAGER', '经理')
    const assignee = await enterpriseUser('ENT_INT_A', 'EMPLOYEE', '执行人')
    await seedIntelligenceData('ENT_INT_A', manager.user.id, assignee.user.id)

    const res = await request(app)
      .get('/api/enterprise/standard-execution/intelligence-dashboard?range=30')
      .set('Authorization', `Bearer ${manager.token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.overview).toMatchObject({
      totalRequirements: 2,
      coveredRequirements: 1,
      uncoveredRequirements: 1,
      coverageRate: 50,
      tasksTotal: 2,
      tasksCompleted: 1,
      taskCompletionRate: 50,
      reviewsTotal: 2,
      reviewsApproved: 1,
      reviewPassRate: 50,
      overdueTasks: 1,
    })
    expect(res.body.data.trends.taskCompletion.some((row: { total: number; completed: number }) => row.total >= 2 && row.completed >= 1)).toBe(true)
    expect(res.body.data.trends.reviewPass.some((row: { total: number; approved: number }) => row.total >= 2 && row.approved >= 1)).toBe(true)
    expect(res.body.data.trends.overdue.some((row: { overdue: number }) => row.overdue >= 1)).toBe(true)
    expect(res.body.data.department).toMatchObject({
      visible: true,
      rows: [expect.objectContaining({ departmentId: 'QA', controlPointCount: 2, coveredCount: 1, coverageRate: 50, overdueTaskCount: 1 })],
    })
    expect(res.body.data.people.visible).toBe(true)
    expect(res.body.data.people.topExecutors[0]).toMatchObject({ name: '执行人', totalTasks: 2, completedTasks: 1, completionRate: 50 })
    expect(res.body.data.people.reviewEfficiency[0]).toMatchObject({ name: '经理', reviewedCount: 2, approvedCount: 1, passRate: 50 })
  })

  it('员工可看企业指标但隐藏人员排行', async () => {
    const manager = await enterpriseUser('ENT_INT_A', 'MANAGER', '经理')
    const employee = await enterpriseUser('ENT_INT_A', 'EMPLOYEE', '员工')
    await seedIntelligenceData('ENT_INT_A', manager.user.id, employee.user.id)

    const res = await request(app)
      .get('/api/enterprise/standard-execution/intelligence-dashboard')
      .set('Authorization', `Bearer ${employee.token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.overview.totalRequirements).toBe(2)
    expect(res.body.data.people.visible).toBe(false)
    expect(res.body.data.people.topExecutors).toEqual([])
    expect(res.body.data.people.reviewEfficiency).toEqual([])
  })

  it('按 enterpriseId 隔离数据', async () => {
    const managerA = await enterpriseUser('ENT_INT_A', 'MANAGER', 'A 经理')
    const managerB = await enterpriseUser('ENT_INT_B', 'MANAGER', 'B 经理')
    const employeeB = await enterpriseUser('ENT_INT_B', 'EMPLOYEE', 'B 员工')
    await seedIntelligenceData('ENT_INT_B', managerB.user.id, employeeB.user.id)

    const res = await request(app)
      .get('/api/enterprise/standard-execution/intelligence-dashboard')
      .set('Authorization', `Bearer ${managerA.token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.overview.totalRequirements).toBe(0)
    expect(res.body.data.department.rows).toEqual([])
    expect(res.body.data.people.topExecutors).toEqual([])
  })

  it('导出 Excel 包含核心 Sheet', async () => {
    const manager = await enterpriseUser('ENT_INT_A', 'MANAGER', '经理')
    const employee = await enterpriseUser('ENT_INT_A', 'EMPLOYEE', '员工')
    await seedIntelligenceData('ENT_INT_A', manager.user.id, employee.user.id)

    const res = await request(app)
      .get('/api/enterprise/standard-execution/intelligence-dashboard/export?range=30')
      .set('Authorization', `Bearer ${manager.token}`)
      .buffer(true)
      .parse(binaryParser)

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    const workbook = xlsx.read(res.body as Buffer, { type: 'buffer' })
    expect(workbook.SheetNames).toEqual(expect.arrayContaining(['总览', '任务完成率趋势', '审核通过率趋势', '部门排行', '执行完成率TOP10']))
  })
})
