/**
 * 企业版 /api/enterprise/standard-execution/records — 端到端测试
 *
 * 覆盖：
 *  - GET  /api/enterprise/standard-execution/records           — 列表 + enterprise 隔离 + keyword 过滤
 *  - GET  /api/enterprise/standard-execution/records/:id       — 详情 + reviewLogs
 *  - POST /api/enterprise/standard-execution/records/:id/void  — MANAGER+ 可作废、EMPLOYEE 拒绝
 *  - 权限拦截：未登录 / 无 enterpriseId 普通 user → 401 / 403
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerEnterpriseRoutes(app)
})

let adminToken: string
let managerToken: string
let employeeToken: string
let plainToken: string
let recordId: string
let sourceId: string

beforeEach(async () => {
  await cleanStandardExecutionData()

  for (const id of ['DEFAULT', 'ENT_A']) {
    await prisma.enterprise.upsert({
      where: { id },
      update: { name: id, status: 'ACTIVE' },
      create: { id, name: id, code: id, status: 'ACTIVE' },
    })
  }

  const admin = await createUser({ role: 'admin' })
  adminToken = getTestToken(admin.id, 'admin')

  const manager = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: manager.id },
    data: { enterpriseId: 'ENT_A', enterpriseRole: 'MANAGER' },
  })
  managerToken = getTestToken(manager.id, 'user')

  const employee = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: employee.id },
    data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' },
  })
  employeeToken = getTestToken(employee.id, 'user')

  const plain = await createUser({ role: 'user' })
  plainToken = getTestToken(plain.id, 'user')

  // ENT_A 完整链路：source → requirement → task → submission → record
  const source = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId: 'ENT_A',
      title: '测试标准 GB/T 9999',
      sourceType: 'PRODUCT_STANDARD',
      sourceNo: 'GB/T 9999-2025',
      status: 'ACTIVE',
      createdBy: manager.id,
    },
  })
  sourceId = source.id
  const req = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId: 'ENT_A',
      sourceId: source.id,
      clauseNo: '4.1',
      title: '检验',
      requirementText: '外观无瑕疵',
      status: 'ACTIVE',
      generateMode: 'MANUAL',
      createdBy: manager.id,
    },
  })
  const task = await prisma.standardExecutionTask.create({
    data: {
      enterpriseId: 'ENT_A',
      requirementId: req.id,
      title: '外观检验任务',
      submitRequirement: '提交照片',
      deadlineAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      reviewerId: manager.id,
      status: 'PUBLISHED',
      createdBy: manager.id,
    },
  })
  const sub = await prisma.standardExecutionSubmission.create({
    data: {
      enterpriseId: 'ENT_A',
      taskId: task.id,
      assigneeId: employee.id,
      submitText: '已完成检验',
      status: 'APPROVED',
      reviewerId: manager.id,
      reviewedAt: new Date(),
      reviewComment: '材料齐全，审核通过',
    },
  })
  const rec = await prisma.standardExecutionRecord.create({
    data: {
      enterpriseId: 'ENT_A',
      sourceId: source.id,
      requirementId: req.id,
      taskId: task.id,
      submissionId: sub.id,
      assigneeId: employee.id,
      departmentId: 'dept-quality',
      title: '检验记录-A',
      summary: '外观合格',
      status: 'VALID',
    },
  })
  await prisma.standardExecutionReviewLog.create({
    data: {
      enterpriseId: 'ENT_A',
      submissionId: sub.id,
      taskId: task.id,
      action: 'APPROVE',
      fromStatus: 'SUBMITTED',
      toStatus: 'APPROVED',
      reviewerId: manager.id,
      comment: '材料齐全，审核通过',
    },
  })
  recordId = rec.id
})

describe('GET /api/enterprise/standard-execution/records', () => {
  it('未登录 → 401', async () => {
    const res = await request(app).get('/api/enterprise/standard-execution/records')
    expect(res.status).toBe(401)
  })

  it('企业成员 → 200 + 返回本企业 1 条', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/records')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe(recordId)
    expect(res.body.data[0].task.title).toBe('外观检验任务')
    expect(res.body.data[0].task.requirement.title).toBe('检验')
    expect(res.body.data[0].task.requirement.source.title).toBe('测试标准 GB/T 9999')
  })

  it('admin → DEFAULT 企业 → 空', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/records')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })

  it('keyword 命中', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/records?keyword=外观')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })

  it('支持按标准来源 / 部门 / 记录日期范围筛选', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const res = await request(app)
      .get(`/api/enterprise/standard-execution/records?sourceId=${sourceId}&departmentId=dept-quality&recordDateFrom=${today}T00:00:00.000Z&recordDateTo=${today}T23:59:59.999Z`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].task.requirement.clauseNo).toBe('4.1')
    expect(res.body.data[0].task.requirement.source.sourceNo).toBe('GB/T 9999-2025')
    expect(res.body.data[0].submission.reviewerId).toBeTruthy()
  })

  it('无 enterpriseId 普通 user → 403', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/records')
      .set('Authorization', `Bearer ${plainToken}`)
    expect(res.status).toBe(403)
  })
})

describe('GET /api/enterprise/standard-execution/records/:id', () => {
  it('企业成员 → 200 + 含 attachments / task / submission / reviewLogs', async () => {
    const res = await request(app)
      .get(`/api/enterprise/standard-execution/records/${recordId}`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(recordId)
    expect(res.body.data.submission).toBeTruthy()
    expect(res.body.data.task).toBeTruthy()
    expect(Array.isArray(res.body.data.attachments)).toBe(true)
    expect(res.body.data.reviewLogs).toHaveLength(1)
    expect(res.body.data.reviewLogs[0].action).toBe('APPROVE')
  })

  it('不存在 → 404', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/records/no-such-id')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(404)
  })
})

describe('GET /api/enterprise/standard-execution/records/:id/evidence-chain', () => {
  it('企业成员 → 200 + 返回 Source 到 Record 全链路', async () => {
    const res = await request(app)
      .get(`/api/enterprise/standard-execution/records/${recordId}/evidence-chain`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.source.sourceNo).toBe('GB/T 9999-2025')
    expect(res.body.data.requirement.clauseNo).toBe('4.1')
    expect(res.body.data.task.title).toBe('外观检验任务')
    expect(res.body.data.submission.version).toBe(1)
    expect(res.body.data.review.reviewerId).toBeTruthy()
    expect(res.body.data.record.id).toBe(recordId)
  })

  it('跨企业记录 → 404', async () => {
    await prisma.enterprise.upsert({
      where: { id: 'ENT_B' },
      update: { name: 'ENT_B', status: 'ACTIVE' },
      create: { id: 'ENT_B', name: 'ENT_B', code: 'ENT_B', status: 'ACTIVE' },
    })
    const source = await prisma.standardExecutionSource.create({
      data: { enterpriseId: 'ENT_B', title: 'B 标准', sourceType: 'PRODUCT_STANDARD', createdBy: 'tester' },
    })
    const req = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'ENT_B', sourceId: source.id, title: 'B 控制点', requirementText: 'B', status: 'ACTIVE', createdBy: 'tester' },
    })
    const task = await prisma.standardExecutionTask.create({
      data: { enterpriseId: 'ENT_B', requirementId: req.id, title: 'B 任务', submitRequirement: 'B', deadlineAt: new Date(), status: 'PUBLISHED', createdBy: 'tester' },
    })
    const sub = await prisma.standardExecutionSubmission.create({
      data: { enterpriseId: 'ENT_B', taskId: task.id, assigneeId: 'other-employee', submitText: 'B', status: 'APPROVED' },
    })
    const rec = await prisma.standardExecutionRecord.create({
      data: {
        enterpriseId: 'ENT_B',
        sourceId: source.id,
        requirementId: req.id,
        taskId: task.id,
        submissionId: sub.id,
        assigneeId: 'other-employee',
        title: 'B 记录',
        status: 'VALID',
      },
    })

    const res = await request(app)
      .get(`/api/enterprise/standard-execution/records/${rec.id}/evidence-chain`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(404)
  })
})

describe('GET /api/enterprise/standard-execution/records/:id/export-pdf', () => {
  it('企业成员 → 200 + application/pdf 附件', async () => {
    const res = await request(app)
      .get(`/api/enterprise/standard-execution/records/${recordId}/export-pdf`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => callback(null, Buffer.concat(chunks)))
      })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(Buffer.isBuffer(res.body)).toBe(true)
    expect(res.body.subarray(0, 4).toString()).toBe('%PDF')
  })
})

describe('POST /api/enterprise/standard-execution/records/:id/void', () => {
  it('MANAGER → 200 + status=VOID', async () => {
    const res = await request(app)
      .post(`/api/enterprise/standard-execution/records/${recordId}/void`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ voidReason: '数据错误' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('VOID')
  })

  it('EMPLOYEE → 403（权限不足）', async () => {
    const res = await request(app)
      .post(`/api/enterprise/standard-execution/records/${recordId}/void`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(403)
  })

  it('admin → 200 + DEFAULT 企业内 404（隔离）', async () => {
    const res = await request(app)
      .post(`/api/enterprise/standard-execution/records/${recordId}/void`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(404)
  })

  it('重复 void → noop=true', async () => {
    await request(app)
      .post(`/api/enterprise/standard-execution/records/${recordId}/void`)
      .set('Authorization', `Bearer ${managerToken}`)
    const res = await request(app)
      .post(`/api/enterprise/standard-execution/records/${recordId}/void`)
      .set('Authorization', `Bearer ${managerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.noop).toBe(true)
  })

  it('void 后含此记录的 Package.hasInvalidRecord=true', async () => {
    const pkg = await prisma.standardExecutionPackage.create({
      data: {
        enterpriseId: 'ENT_A',
        title: 'pkg-x',
        packageScene: 'CUSTOMER_AUDIT',
        createdBy: 'someuser',
      },
    })
    const rec = await prisma.standardExecutionRecord.findUnique({ where: { id: recordId } })
    await prisma.standardExecutionPackageItem.create({
      data: {
        enterpriseId: 'ENT_A',
        packageId: pkg.id,
        recordId,
        requirementId: rec!.requirementId,
        taskId: rec!.taskId,
        submissionId: rec!.submissionId,
        sortNo: 0,
      },
    })
    const res = await request(app)
      .post(`/api/enterprise/standard-execution/records/${recordId}/void`)
      .set('Authorization', `Bearer ${managerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.affectedPackageIds).toContain(pkg.id)
    const updated = await prisma.standardExecutionPackage.findUnique({ where: { id: pkg.id } })
    expect(updated?.hasInvalidRecord).toBe(true)
  })
})
