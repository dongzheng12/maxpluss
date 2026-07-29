/**
 * standard-execution / Record list/get/void 测试
 *
 * 覆盖：
 *  - list: 默认 / status / sourceId / requirementId / taskId / assigneeId / departmentId / keyword + 分页 + enterpriseId 隔离
 *  - get: 含 submission/task/requirement/source/attachments/reviewLogs / 404 / 跨企业 404
 *  - void: VALID → VOID + 同步刷 Package.hasInvalidRecord / 非 VALID → 409 / 重复 noop / 404 / 权限
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

async function setupRecord(opts: { enterpriseId?: string; status?: 'VALID' | 'VOID' | 'EXPIRED'; recordTitle?: string } = {}) {
  const enterpriseId = opts.enterpriseId ?? 'DEFAULT'
  const admin = await createUser({ role: 'admin' })
  const user = await createUser({ role: 'user' })
  const src = await prisma.standardExecutionSource.create({
    data: { enterpriseId, title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
  })
  const req = await prisma.standardExecutionRequirement.create({
    data: { enterpriseId, sourceId: src.id, title: 'r', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id },
  })
  const task = await prisma.standardExecutionTask.create({
    data: { enterpriseId, requirementId: req.id, title: 't', submitRequirement: 'x', deadlineAt: new Date(Date.now() + 86400000), reviewerId: admin.id, status: 'PUBLISHED', createdBy: admin.id },
  })
  const sub = await prisma.standardExecutionSubmission.create({
    data: { enterpriseId, taskId: task.id, assigneeId: user.id, submitText: 'x', status: 'APPROVED', version: 1, isLatest: true },
  })
  const rec = await prisma.standardExecutionRecord.create({
    data: {
      enterpriseId,
      sourceId: src.id,
      requirementId: req.id,
      taskId: task.id,
      submissionId: sub.id,
      assigneeId: user.id,
      title: opts.recordTitle ?? 'rec title',
      summary: 'rec summary',
      status: opts.status ?? 'VALID',
    },
  })
  return { admin, user, src, req, task, sub, rec, enterpriseId }
}

describe('GET /records', () => {
  it('admin list — 默认分页 + recordDate desc + enterpriseId 隔离', async () => {
    const { token } = await makeAdminToken()
    await setupRecord({ recordTitle: 'mine' })
    await setupRecord({ enterpriseId: 'OTHER', recordTitle: 'other' })
    const r = await request(app)
      .get('/api/admin/standard-execution/records')
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(200)
    expect(r.body.total).toBe(1)
    expect(r.body.data[0].title).toBe('mine')
  })

  it('keyword 搜 title + summary', async () => {
    const { token } = await makeAdminToken()
    const a = await setupRecord({ recordTitle: 'aaa unique' })
    // 直接覆盖 summary
    await prisma.standardExecutionRecord.update({ where: { id: a.rec.id }, data: { summary: 'shared 巡检' } })

    const r1 = await request(app)
      .get('/api/admin/standard-execution/records?keyword=unique')
      .set('Authorization', `Bearer ${token}`)
    expect(r1.body.total).toBe(1)

    const r2 = await request(app)
      .get('/api/admin/standard-execution/records?keyword=巡检')
      .set('Authorization', `Bearer ${token}`)
    expect(r2.body.total).toBe(1)
  })

  it('按 status / taskId 筛选', async () => {
    const { token } = await makeAdminToken()
    await setupRecord({ status: 'VALID' })
    const b = await setupRecord({ status: 'EXPIRED' })

    const r1 = await request(app)
      .get('/api/admin/standard-execution/records?status=VALID')
      .set('Authorization', `Bearer ${token}`)
    expect(r1.body.total).toBe(1)

    const r2 = await request(app)
      .get(`/api/admin/standard-execution/records?taskId=${b.task.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(r2.body.total).toBe(1)
  })

  it('无 token → 401', async () => {
    const r = await request(app).get('/api/admin/standard-execution/records')
    expect(r.status).toBe(401)
  })
})

describe('GET /records/:id', () => {
  it('详情含 submission/task/requirement/source/attachments/reviewLogs', async () => {
    const { token } = await makeAdminToken()
    const s = await setupRecord()
    await prisma.standardExecutionAttachment.create({
      data: { enterpriseId: 'DEFAULT', bizType: 'SUBMISSION', bizId: s.sub.id, fileName: 'a.jpg', fileUrl: '/x', uploadedBy: s.user.id },
    })
    await prisma.standardExecutionReviewLog.create({
      data: {
        enterpriseId: 'DEFAULT',
        submissionId: s.sub.id,
        taskId: s.task.id,
        action: 'APPROVE',
        fromStatus: 'SUBMITTED',
        toStatus: 'APPROVED',
        reviewerId: s.admin.id,
        comment: '材料齐全，审核通过',
      },
    })
    const r = await request(app)
      .get(`/api/admin/standard-execution/records/${s.rec.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(200)
    expect(r.body.data.task.requirement.source).toBeTruthy()
    expect(r.body.data.submission).toBeTruthy()
    expect(r.body.data.attachments.length).toBe(1)
    expect(r.body.data.reviewLogs).toHaveLength(1)
    expect(r.body.data.reviewLogs[0].action).toBe('APPROVE')
  })

  it('id 不存在 → 404', async () => {
    const { token } = await makeAdminToken()
    const r = await request(app)
      .get('/api/admin/standard-execution/records/no-such')
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(404)
  })

  it('跨企业 → 404', async () => {
    const { token } = await makeAdminToken()
    const s = await setupRecord({ enterpriseId: 'OTHER' })
    const r = await request(app)
      .get(`/api/admin/standard-execution/records/${s.rec.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(404)
  })
})

describe('POST /records/:id/void', () => {
  it('VALID → VOID + 同步刷 Package.hasInvalidRecord=true', async () => {
    const { token } = await makeAdminToken()
    const s = await setupRecord()
    // 建一个含该 record 的 package
    const pkg = await prisma.standardExecutionPackage.create({
      data: { enterpriseId: 'DEFAULT', title: 'p', packageScene: 'INTERNAL_CHECK', createdBy: s.admin.id },
    })
    await prisma.standardExecutionPackageItem.create({
      data: { enterpriseId: 'DEFAULT', packageId: pkg.id, recordId: s.rec.id, requirementId: s.req.id, taskId: s.task.id, submissionId: s.sub.id },
    })

    const r = await request(app)
      .post(`/api/admin/standard-execution/records/${s.rec.id}/void`)
      .set('Authorization', `Bearer ${token}`)
      .send({ voidReason: '测试作废' })
    expect(r.status).toBe(200)
    expect(r.body.data.status).toBe('VOID')
    expect(r.body.affectedPackageIds).toContain(pkg.id)

    const updatedPkg = await prisma.standardExecutionPackage.findUnique({ where: { id: pkg.id } })
    expect(updatedPkg?.hasInvalidRecord).toBe(true)
  })

  it('EXPIRED → VOID（doc §五.5 合法跃迁）', async () => {
    const { token } = await makeAdminToken()
    const s = await setupRecord({ status: 'EXPIRED' })
    const r = await request(app)
      .post(`/api/admin/standard-execution/records/${s.rec.id}/void`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(r.status).toBe(200)
    expect(r.body.data.status).toBe('VOID')
  })

  it('VOID → 重复 noop', async () => {
    const { token } = await makeAdminToken()
    const s = await setupRecord({ status: 'VOID' })
    const r = await request(app)
      .post(`/api/admin/standard-execution/records/${s.rec.id}/void`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(r.status).toBe(200)
    expect(r.body.noop).toBe(true)
  })

  it('id 不存在 → 404', async () => {
    const { token } = await makeAdminToken()
    const r = await request(app)
      .post('/api/admin/standard-execution/records/no-such/void')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(r.status).toBe(404)
  })

  it('user role → 403', async () => {
    const u = await createUser({ role: 'user' })
    const token = getTestToken(u.id, 'user')
    const r = await request(app)
      .post('/api/admin/standard-execution/records/x/void')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(r.status).toBe(403)
  })
})

describe('POST /api/admin/standard-execution/records/batch-void', () => {
  const PATH = '/api/admin/standard-execution/records/batch-void'

  it('VALID/EXPIRED → VOID；VOID 落入 skipped + 同步刷 Package.hasInvalidRecord', async () => {
    const { token } = await makeAdminToken()
    const valid = await setupRecord({ status: 'VALID' })
    const expired = await setupRecord({ status: 'EXPIRED' })
    const already = await setupRecord({ status: 'VOID' })
    // valid.rec 放进一个 READY 材料包，验证作废后 hasInvalidRecord 被刷脏
    const pkg = await prisma.standardExecutionPackage.create({
      data: { enterpriseId: 'DEFAULT', title: 'pkg', packageScene: 'INTERNAL_CHECK', status: 'READY', createdBy: valid.admin.id },
    })
    await prisma.standardExecutionPackageItem.create({
      data: {
        enterpriseId: 'DEFAULT',
        packageId: pkg.id,
        recordId: valid.rec.id,
        requirementId: valid.req.id,
        taskId: valid.task.id,
        submissionId: valid.sub.id,
      },
    })
    const res = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [valid.rec.id, expired.rec.id, already.rec.id] })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(2)
    expect(res.body.skipped).toBe(1)
    const v = await prisma.standardExecutionRecord.findUnique({ where: { id: valid.rec.id } })
    expect(v?.status).toBe('VOID')
    const p = await prisma.standardExecutionPackage.findUnique({ where: { id: pkg.id } })
    expect(p?.hasInvalidRecord).toBe(true)
  })

  it('user role → 403', async () => {
    const u = await createUser({ role: 'user' })
    const r = await request(app).post(PATH).set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`).send({ ids: ['x'] })
    expect(r.status).toBe(403)
  })
})
