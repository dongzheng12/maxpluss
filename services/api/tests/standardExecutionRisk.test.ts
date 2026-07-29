/**
 * standard-execution / 风险看板 — 4 类实时计算 + handle 占位
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

async function makeAdminToken() {
  const admin = await createUser({ role: 'admin' })
  return { admin, token: getTestToken(admin.id, 'admin') }
}

const FOUR_DAYS = 4 * 24 * 3600 * 1000
const TWO_DAYS = 2 * 24 * 3600 * 1000
const TWELVE_HOURS = 12 * 3600 * 1000
const FIFTY_HOURS = 50 * 3600 * 1000

describe('GET /risks — 实时计算 4 类风险', () => {
  it('REQUIREMENT_NO_TASK：ACTIVE ≥ 3 天 + 无 task → HIGH', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await prisma.standardExecutionSource.create({
      data: { enterpriseId: 'DEFAULT', title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
    })
    // 老 ACTIVE 要求项无 task
    await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: '旧要求', requirementText: 'x', status: 'ACTIVE', createdAt: new Date(Date.now() - FOUR_DAYS), createdBy: admin.id },
    })
    // 新 ACTIVE 要求项（< 3 天）— 不应进入
    await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: '新要求', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id },
    })
    // DRAFT 要求项 — 不应进入
    await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: '草稿', requirementText: 'x', status: 'DRAFT', createdAt: new Date(Date.now() - FOUR_DAYS), createdBy: admin.id },
    })

    const r = await request(app).get('/api/admin/standard-execution/risks').set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(200)
    const matches = r.body.data.filter((x: { riskType: string }) => x.riskType === 'REQUIREMENT_NO_TASK')
    expect(matches.length).toBe(1)
    expect(matches[0].riskLevel).toBe('HIGH')
    expect(matches[0].title).toContain('旧要求')
  })

  it('TASK_OVERDUE：PUBLISHED + deadline 已过 → HIGH', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await prisma.standardExecutionSource.create({ data: { enterpriseId: 'DEFAULT', title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id } })
    const req = await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'r', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id } })
    await prisma.standardExecutionTask.create({
      data: { enterpriseId: 'DEFAULT', requirementId: req.id, title: '已逾期', submitRequirement: 'x', deadlineAt: new Date(Date.now() - TWO_DAYS), reviewerId: admin.id, status: 'PUBLISHED', publishedAt: new Date(), createdBy: admin.id },
    })
    // DRAFT 逾期：不应进入
    await prisma.standardExecutionTask.create({
      data: { enterpriseId: 'DEFAULT', requirementId: req.id, title: '草稿逾期', submitRequirement: 'x', deadlineAt: new Date(Date.now() - TWO_DAYS), reviewerId: admin.id, status: 'DRAFT', createdBy: admin.id },
    })

    const r = await request(app).get('/api/admin/standard-execution/risks').set('Authorization', `Bearer ${token}`)
    const matches = r.body.data.filter((x: { riskType: string }) => x.riskType === 'TASK_OVERDUE')
    expect(matches.length).toBe(1)
    expect(matches[0].riskLevel).toBe('HIGH')
  })

  it('ASSIGNEE_NOT_SUBMITTED：deadline < now+24h + assignee 状态未提交 → MEDIUM', async () => {
    const { admin, token } = await makeAdminToken()
    const u = await createUser({ role: 'user' })
    const src = await prisma.standardExecutionSource.create({ data: { enterpriseId: 'DEFAULT', title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id } })
    const req = await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'r', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id } })
    const task = await prisma.standardExecutionTask.create({
      data: { enterpriseId: 'DEFAULT', requirementId: req.id, title: '即将到期', submitRequirement: 'x', deadlineAt: new Date(Date.now() + TWELVE_HOURS), reviewerId: admin.id, status: 'PUBLISHED', publishedAt: new Date(), createdBy: admin.id },
    })
    await prisma.standardExecutionTaskAssignee.create({
      data: { enterpriseId: 'DEFAULT', taskId: task.id, assigneeId: u.id, status: 'PENDING' },
    })

    const r = await request(app).get('/api/admin/standard-execution/risks').set('Authorization', `Bearer ${token}`)
    const matches = r.body.data.filter((x: { riskType: string }) => x.riskType === 'ASSIGNEE_NOT_SUBMITTED')
    expect(matches.length).toBe(1)
    expect(matches[0].riskLevel).toBe('MEDIUM')
  })

  it('REVIEW_PENDING：SUBMITTED ≥ 48h → MEDIUM', async () => {
    const { admin, token } = await makeAdminToken()
    const u = await createUser({ role: 'user' })
    const src = await prisma.standardExecutionSource.create({ data: { enterpriseId: 'DEFAULT', title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id } })
    const req = await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'r', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id } })
    const task = await prisma.standardExecutionTask.create({
      data: { enterpriseId: 'DEFAULT', requirementId: req.id, title: 't', submitRequirement: 'x', deadlineAt: new Date(Date.now() + 86400000), reviewerId: admin.id, status: 'PUBLISHED', createdBy: admin.id },
    })
    await prisma.standardExecutionSubmission.create({
      data: { enterpriseId: 'DEFAULT', taskId: task.id, assigneeId: u.id, submitText: 'x', status: 'SUBMITTED', version: 1, isLatest: true, submittedAt: new Date(Date.now() - FIFTY_HOURS) },
    })

    const r = await request(app).get('/api/admin/standard-execution/risks').set('Authorization', `Bearer ${token}`)
    const matches = r.body.data.filter((x: { riskType: string }) => x.riskType === 'REVIEW_PENDING')
    expect(matches.length).toBe(1)
    expect(matches[0].riskLevel).toBe('MEDIUM')
  })

  it('排序：HIGH 在前，同 level 按 createdAt asc', async () => {
    const { admin, token } = await makeAdminToken()
    // 造一条 HIGH（REQUIREMENT_NO_TASK）+ 一条 MEDIUM（REVIEW_PENDING）
    const src = await prisma.standardExecutionSource.create({ data: { enterpriseId: 'DEFAULT', title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id } })
    await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: '旧要求', requirementText: 'x', status: 'ACTIVE', createdAt: new Date(Date.now() - FOUR_DAYS), createdBy: admin.id },
    })
    const req = await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'r2', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id } })
    const u = await createUser({ role: 'user' })
    const task = await prisma.standardExecutionTask.create({
      data: { enterpriseId: 'DEFAULT', requirementId: req.id, title: 't', submitRequirement: 'x', deadlineAt: new Date(Date.now() + 86400000), reviewerId: admin.id, status: 'PUBLISHED', createdBy: admin.id },
    })
    await prisma.standardExecutionSubmission.create({
      data: { enterpriseId: 'DEFAULT', taskId: task.id, assigneeId: u.id, submitText: 'x', status: 'SUBMITTED', version: 1, isLatest: true, submittedAt: new Date(Date.now() - FIFTY_HOURS) },
    })

    const r = await request(app).get('/api/admin/standard-execution/risks').set('Authorization', `Bearer ${token}`)
    expect(r.body.data[0].riskLevel).toBe('HIGH')
  })

  it('enterpriseId 隔离', async () => {
    const { admin, token } = await makeAdminToken()
    const otherSrc = await prisma.standardExecutionSource.create({ data: { enterpriseId: 'OTHER', title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id } })
    await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'OTHER', sourceId: otherSrc.id, title: '其他企业老要求', requirementText: 'x', status: 'ACTIVE', createdAt: new Date(Date.now() - FOUR_DAYS), createdBy: admin.id },
    })
    const r = await request(app).get('/api/admin/standard-execution/risks').set('Authorization', `Bearer ${token}`)
    expect(r.body.total).toBe(0)
  })

  it('user role → 403', async () => {
    const u = await createUser({ role: 'user' })
    const token = getTestToken(u.id, 'user')
    const r = await request(app).get('/api/admin/standard-execution/risks').set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(403)
  })
})

describe('POST /risks/:id/handle', () => {
  it('占位返回 noop=true（一期不落库）', async () => {
    const { token } = await makeAdminToken()
    const r = await request(app)
      .post('/api/admin/standard-execution/risks/TASK_OVERDUE:fake-id/handle')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(r.status).toBe(200)
    expect(r.body.noop).toBe(true)
  })
})
