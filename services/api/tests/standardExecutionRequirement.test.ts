/**
 * standard-execution / Requirement — Admin 端 CRUD + 状态机测试
 *
 * 覆盖：
 *  - happy path: create → list → get（含 source）→ update → activate → disable → activate → archive
 *  - 权限：无 token 401 / user 403 / sales 403
 *  - 边界：必填缺失 400 / sourceId 不存在 400 / id 不存在 404
 *  - 状态机：
 *      REVIEW_PENDING → ACTIVE  (activate ok)
 *      DISABLED → ACTIVE  (activate ok，重启用)
 *      ACTIVE → DISABLED (disable ok)
 *      DRAFT → DISABLED  (ok，POC M2 放开「忽略」→ DISABLED)
 *      DRAFT → ARCHIVED  (非法 409；doc §五.1 不允许)
 *      ACTIVE → ARCHIVED / DISABLED → ARCHIVED (ok)
 *      ARCHIVED → 任何  (非法 409)
 *      ARCHIVED 编辑 → 409
 *      幂等：当前状态 == 目标状态 → noop=true
 *  - enterpriseId 隔离：跨企业 list/get/update/transition 都 404
 *  - FK：跨企业 sourceId → 400
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
  // FK 顺序：packageItem → package → reviewLog → attachment → record → submission → assignee → task → requirement → source
  await cleanStandardExecutionData()
})

async function makeAdminToken() {
  const admin = await createUser({ role: 'admin' })
  return { admin, token: getTestToken(admin.id, 'admin') }
}

async function makeSource(adminId: string, overrides: Partial<{ enterpriseId: string; title: string }> = {}) {
  return prisma.standardExecutionSource.create({
    data: {
      enterpriseId: overrides.enterpriseId ?? 'DEFAULT',
      title: overrides.title ?? '测试标准',
      sourceType: 'PRODUCT_STANDARD',
      createdBy: adminId,
    },
  })
}

function validBody(sourceId: string) {
  return {
    sourceId,
    clauseNo: '5.1.2',
    title: '消防器材定期巡检',
    requirementText: '消防器材应每月至少巡检一次，记录留存不少于 3 年',
  }
}

async function makeTask(adminId: string, requirement: { id: string; enterpriseId: string; sourceId: string }) {
  return prisma.standardExecutionTask.create({
    data: {
      enterpriseId: requirement.enterpriseId,
      requirementId: requirement.id,
      title: `任务-${requirement.id}`,
      submitRequirement: '提交执行记录',
      deadlineAt: new Date(Date.now() + 7 * 86400000),
      reviewerId: adminId,
      status: 'COMPLETED',
      publishedAt: new Date(),
      completedAt: new Date(),
      createdBy: adminId,
    },
  })
}

async function makeValidRecord(
  adminId: string,
  requirement: { id: string; enterpriseId: string; sourceId: string },
  opts: { validUntil?: Date | null; recordDate?: Date } = {},
) {
  const task = await makeTask(adminId, requirement)
  const submission = await prisma.standardExecutionSubmission.create({
    data: {
      enterpriseId: requirement.enterpriseId,
      taskId: task.id,
      assigneeId: adminId,
      submitText: 'ok',
      status: 'APPROVED',
      reviewedAt: new Date(),
      reviewerId: adminId,
    },
  })
  return prisma.standardExecutionRecord.create({
    data: {
      enterpriseId: requirement.enterpriseId,
      sourceId: requirement.sourceId,
      requirementId: requirement.id,
      taskId: task.id,
      submissionId: submission.id,
      assigneeId: adminId,
      title: `记录-${requirement.id}`,
      status: 'VALID',
      recordDate: opts.recordDate ?? new Date(),
      validUntil: opts.validUntil === undefined ? new Date(Date.now() + 60 * 86400000) : opts.validUntil,
    },
  })
}

// ─── 新建 ────────────────────────────────────────────

describe('POST /api/admin/standard-execution/requirements', () => {
  it('happy path — 创建 201 + 默认 REVIEW_PENDING + MANUAL', async () => {
    const { admin, token } = await makeAdminToken()
    const source = await makeSource(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/requirements')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(source.id))
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('REVIEW_PENDING')
    expect(res.body.data.generateMode).toBe('MANUAL')
    expect(res.body.data.enterpriseId).toBe('DEFAULT')
    expect(res.body.data.createdBy).toBe(admin.id)
  })

  it('人工确认入库可显式创建 DRAFT', async () => {
    const { admin, token } = await makeAdminToken()
    const source = await makeSource(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/requirements')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody(source.id), generateMode: 'AI', status: 'DRAFT' })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('DRAFT')
    expect(res.body.data.generateMode).toBe('AI')
  })

  it('无 token → 401', async () => {
    const res = await request(app)
      .post('/api/admin/standard-execution/requirements')
      .send(validBody('whatever'))
    expect(res.status).toBe(401)
  })

  it('user role → 403', async () => {
    const user = await createUser({ role: 'user' })
    const token = getTestToken(user.id, 'user')
    const res = await request(app)
      .post('/api/admin/standard-execution/requirements')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody('whatever'))
    expect(res.status).toBe(403)
  })

  it('sales role → 403', async () => {
    const sales = await createUser({ role: 'sales' })
    const token = getTestToken(sales.id, 'sales')
    const res = await request(app)
      .post('/api/admin/standard-execution/requirements')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody('whatever'))
    expect(res.status).toBe(403)
  })

  it('title 空 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const source = await makeSource(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/requirements')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody(source.id), title: '' })
    expect(res.status).toBe(400)
  })

  it('requirementText 空 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const source = await makeSource(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/requirements')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody(source.id), requirementText: '' })
    expect(res.status).toBe(400)
  })

  it('sourceId 不存在 → 400', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .post('/api/admin/standard-execution/requirements')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody('no-such-source'))
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('标准来源不存在')
  })

  it('跨企业 sourceId → 400（enterpriseId 隔离）', async () => {
    const { admin, token } = await makeAdminToken()
    const otherSource = await makeSource(admin.id, { enterpriseId: 'OTHER' })
    const res = await request(app)
      .post('/api/admin/standard-execution/requirements')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(otherSource.id))
    expect(res.status).toBe(400)
  })
})

// ─── 列表 ────────────────────────────────────────────

describe('GET /api/admin/standard-execution/requirements', () => {
  it('list 分页 + enterpriseId 隔离', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const otherSrc = await makeSource(admin.id, { enterpriseId: 'OTHER' })

    await prisma.standardExecutionRequirement.createMany({
      data: [
        { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'A', requirementText: 'a', createdBy: admin.id },
        { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'B', requirementText: 'b', createdBy: admin.id },
        { enterpriseId: 'OTHER', sourceId: otherSrc.id, title: 'X', requirementText: 'x', createdBy: admin.id },
      ],
    })

    const res = await request(app)
      .get('/api/admin/standard-execution/requirements')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(2)
  })

  it('按 sourceId / status / keyword 筛选', async () => {
    const { admin, token } = await makeAdminToken()
    const srcA = await makeSource(admin.id, { title: '标准 A' })
    const srcB = await makeSource(admin.id, { title: '标准 B' })

    await prisma.standardExecutionRequirement.createMany({
      data: [
        { enterpriseId: 'DEFAULT', sourceId: srcA.id, title: '消防器材巡检', requirementText: 'x', status: 'ACTIVE', clauseNo: '5.1', createdBy: admin.id },
        { enterpriseId: 'DEFAULT', sourceId: srcA.id, title: '设备性能测试', requirementText: 'y', status: 'DRAFT', createdBy: admin.id },
        { enterpriseId: 'DEFAULT', sourceId: srcB.id, title: 'B 标准要求', requirementText: 'z', createdBy: admin.id },
      ],
    })

    const r1 = await request(app)
      .get(`/api/admin/standard-execution/requirements?sourceId=${srcA.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(r1.body.total).toBe(2)

    const r2 = await request(app)
      .get('/api/admin/standard-execution/requirements?status=ACTIVE')
      .set('Authorization', `Bearer ${token}`)
    expect(r2.body.total).toBe(1)

    const r4 = await request(app)
      .get('/api/admin/standard-execution/requirements?keyword=5.1')
      .set('Authorization', `Bearer ${token}`)
    expect(r4.body.total).toBe(1)
    expect(r4.body.data[0].clauseNo).toBe('5.1')
  })

  it('附加控制点健康状态：已覆盖 / 即将到期 / 未覆盖 / 无任务 / 非 ACTIVE', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const now = Date.now()
    const createReq = (title: string, status = 'ACTIVE') =>
      prisma.standardExecutionRequirement.create({
        data: { enterpriseId: 'DEFAULT', sourceId: src.id, title, requirementText: 'x', status, createdBy: admin.id },
      })

    const noTask = await createReq('无任务')
    const uncovered = await createReq('未覆盖')
    const expiring = await createReq('即将到期')
    const staleNoExpiry = await createReq('无有效期超期')
    const covered = await createReq('已覆盖')
    const disabled = await createReq('停用', 'DISABLED')

    await makeTask(admin.id, uncovered)
    await makeValidRecord(admin.id, expiring, { validUntil: new Date(now + 5 * 86400000) })
    await makeValidRecord(admin.id, staleNoExpiry, {
      validUntil: null,
      recordDate: new Date(now - 366 * 86400000),
    })
    await makeValidRecord(admin.id, covered, { validUntil: new Date(now + 60 * 86400000) })

    const otherSrc = await makeSource(admin.id, { enterpriseId: 'OTHER' })
    const otherReq = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'OTHER', sourceId: otherSrc.id, title: '其他企业已覆盖', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id },
    })
    await makeValidRecord(admin.id, otherReq, { validUntil: new Date(now + 60 * 86400000) })

    const res = await request(app)
      .get('/api/admin/standard-execution/requirements?status=ACTIVE,DISABLED&pageSize=20')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const byId = new Map(res.body.data.map((item: { id: string; health: { status: string; taskCount: number; validRecordCount: number } }) => [item.id, item.health]))
    expect(byId.get(noTask.id)).toMatchObject({ status: 'NO_TASK', taskCount: 0, validRecordCount: 0 })
    expect(byId.get(uncovered.id)).toMatchObject({ status: 'UNCOVERED', taskCount: 1, validRecordCount: 0 })
    expect(byId.get(expiring.id)).toMatchObject({ status: 'EXPIRING', taskCount: 1, validRecordCount: 1 })
    expect(byId.get(staleNoExpiry.id)).toMatchObject({ status: 'EXPIRING', taskCount: 1, validRecordCount: 1 })
    expect(byId.get(covered.id)).toMatchObject({ status: 'COVERED', taskCount: 1, validRecordCount: 1 })
    expect(byId.get(disabled.id)).toMatchObject({ status: 'NA' })
    expect(byId.has(otherReq.id)).toBe(false)
  })

  it('100 条控制点健康状态批量计算响应 < 500ms', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    await prisma.standardExecutionRequirement.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        enterpriseId: 'DEFAULT',
        sourceId: src.id,
        title: `批量控制点 ${index + 1}`,
        requirementText: 'x',
        status: 'ACTIVE',
        createdBy: admin.id,
      })),
    })

    const startedAt = Date.now()
    const res = await request(app)
      .get('/api/admin/standard-execution/requirements?status=ACTIVE&pageSize=100')
      .set('Authorization', `Bearer ${token}`)
    const elapsed = Date.now() - startedAt
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(100)
    expect(res.body.data.every((item: { health?: { status: string } }) => item.health?.status === 'NO_TASK')).toBe(true)
    expect(elapsed).toBeLessThan(500)
  })
})

// ─── 详情 ────────────────────────────────────────────

describe('GET /api/admin/standard-execution/requirements/:id', () => {
  it('返回详情 + source 关联', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id, { title: 'GB 标准' })
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', createdBy: admin.id },
    })
    const res = await request(app)
      .get(`/api/admin/standard-execution/requirements/${r.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.source.title).toBe('GB 标准')
  })

  it('返回详情合规状态侧栏所需字段', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id, { title: 'GB 标准' })
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id },
    })
    await makeValidRecord(admin.id, r, { validUntil: new Date(Date.now() + 5 * 86400000) })
    const res = await request(app)
      .get(`/api/admin/standard-execution/requirements/${r.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.health).toMatchObject({
      status: 'EXPIRING',
      taskCount: 1,
      validRecordCount: 1,
    })
    expect(res.body.data.health.latestValidRecordDate).toBeTruthy()
    expect(res.body.data.health.validUntil).toBeTruthy()
    expect(res.body.data.source.title).toBe('GB 标准')
  })

  it('id 不存在 → 404', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .get('/api/admin/standard-execution/requirements/no-such-id')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })

  it('跨企业 id → 404', async () => {
    const { admin, token } = await makeAdminToken()
    const otherSrc = await makeSource(admin.id, { enterpriseId: 'OTHER' })
    const otherR = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'OTHER', sourceId: otherSrc.id, title: 'X', requirementText: 'x', createdBy: admin.id },
    })
    const res = await request(app)
      .get(`/api/admin/standard-execution/requirements/${otherR.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })
})

// ─── 编辑 ────────────────────────────────────────────

describe('PATCH /api/admin/standard-execution/requirements/:id', () => {
  it('happy path — 修改 title + requirementText', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'old', requirementText: 'a', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'new', requirementText: 'b' })
    expect(res.status).toBe(200)
    expect(res.body.data.title).toBe('new')
    expect(res.body.data.requirementText).toBe('b')
    expect(res.body.data.updatedBy).toBe(admin.id)
  })

  it('ARCHIVED 编辑 → 409', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'ARCHIVED', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'new' })
    expect(res.status).toBe(409)
  })

  it('id 不存在 → 404', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .patch('/api/admin/standard-execution/requirements/no-such-id')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'x' })
    expect(res.status).toBe(404)
  })

  it('title 空字符串 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '' })
    expect(res.status).toBe(400)
  })
})

// ─── 状态机：activate / disable / archive ──────────────

describe('PATCH .../requirements/:id/activate', () => {
  it('REVIEW_PENDING → ACTIVE (ok)', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'REVIEW_PENDING', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}/activate`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('ACTIVE')
  })

  it('DRAFT → ACTIVE 非法 → 409（需先进入审核态）', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'DRAFT', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}/activate`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('DISABLED → ACTIVE (ok，重启用)', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'DISABLED', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}/activate`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('ACTIVE')
  })

  it('ACTIVE → ACTIVE 幂等 (noop=true)', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}/activate`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.noop).toBe(true)
  })

  it('ARCHIVED → ACTIVE 非法 → 409', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'ARCHIVED', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}/activate`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('id 不存在 → 404', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .patch('/api/admin/standard-execution/requirements/no-such-id/activate')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })
})

describe('PATCH .../requirements/:id/disable', () => {
  it('ACTIVE → DISABLED (ok)', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}/disable`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('DISABLED')
  })

  it('DRAFT → DISABLED (ok，POC M2 放开「忽略」)', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'DRAFT', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}/disable`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('DISABLED')
  })

  it('完整路径 DRAFT → disable(DISABLED) → activate(ACTIVE)（POC M2「忽略」可恢复）', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'DRAFT', createdBy: admin.id },
    })
    const disabled = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}/disable`)
      .set('Authorization', `Bearer ${token}`)
    expect(disabled.status).toBe(200)
    expect(disabled.body.data.status).toBe('DISABLED')
    const reactivated = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}/activate`)
      .set('Authorization', `Bearer ${token}`)
    expect(reactivated.status).toBe(200)
    expect(reactivated.body.data.status).toBe('ACTIVE')
  })

  it('DISABLED → DISABLED 幂等 (noop=true)', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'DISABLED', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}/disable`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.noop).toBe(true)
  })
})

describe('PATCH .../requirements/:id/archive', () => {
  it('ACTIVE → ARCHIVED (ok)', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('ARCHIVED')
  })

  it('DISABLED → ARCHIVED (ok)', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'DISABLED', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('ARCHIVED')
  })

  it('DRAFT → ARCHIVED 非法 → 409（doc §五.1 不允许）', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'DRAFT', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('ARCHIVED → ARCHIVED 幂等 (noop=true)', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'ARCHIVED', createdBy: admin.id },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${r.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.noop).toBe(true)
  })
})

// ─── 完整生命周期 ─────────────────────────────────────

describe('生命周期 — REVIEW_PENDING → ACTIVE → DISABLED → ACTIVE → ARCHIVED', () => {
  it('完整跑通五段跃迁', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'X', requirementText: 'x', status: 'REVIEW_PENDING', createdBy: admin.id },
    })
    const url = (action: string) =>
      `/api/admin/standard-execution/requirements/${r.id}/${action}`
    const hit = (action: string) =>
      request(app).patch(url(action)).set('Authorization', `Bearer ${token}`)

    expect((await hit('activate')).body.data.status).toBe('ACTIVE')
    expect((await hit('disable')).body.data.status).toBe('DISABLED')
    expect((await hit('activate')).body.data.status).toBe('ACTIVE')
    expect((await hit('archive')).body.data.status).toBe('ARCHIVED')

    // ARCHIVED 后所有跃迁都拒绝
    expect((await hit('activate')).status).toBe(409)
    expect((await hit('disable')).status).toBe(409)
  })
})

describe('POST /api/admin/standard-execution/requirements/batch-archive', () => {
  const PATH = '/api/admin/standard-execution/requirements/batch-archive'
  async function makeReq(adminId: string, status: 'DRAFT' | 'ACTIVE' | 'DISABLED' | 'ARCHIVED', enterpriseId = 'DEFAULT') {
    const src = await makeSource(adminId, { enterpriseId })
    return prisma.standardExecutionRequirement.create({
      data: { enterpriseId, sourceId: src.id, title: 'r', requirementText: 'x', status, createdBy: adminId },
    })
  }

  it('ACTIVE/DISABLED → ARCHIVED；DRAFT/ARCHIVED 落入 skipped', async () => {
    const { admin, token } = await makeAdminToken()
    const active = await makeReq(admin.id, 'ACTIVE')
    const disabled = await makeReq(admin.id, 'DISABLED')
    const draft = await makeReq(admin.id, 'DRAFT')
    const archived = await makeReq(admin.id, 'ARCHIVED')
    const res = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [active.id, disabled.id, draft.id, archived.id] })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(2)
    expect(res.body.skipped).toBe(2)
    const d = await prisma.standardExecutionRequirement.findUnique({ where: { id: draft.id } })
    expect(d?.status).toBe('DRAFT')
    const a = await prisma.standardExecutionRequirement.findUnique({ where: { id: active.id } })
    expect(a?.status).toBe('ARCHIVED')
  })

  it('user role → 403', async () => {
    const u = await createUser({ role: 'user' })
    const res = await request(app).post(PATH).set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`).send({ ids: ['x'] })
    expect(res.status).toBe(403)
  })
})

describe('要求项批量 启用/停用/删除', () => {
  it('batch-activate: REVIEW_PENDING → ACTIVE', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r1 = await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'a', requirementText: 'x', status: 'REVIEW_PENDING', createdBy: admin.id } })
    const res = await request(app).post('/api/admin/standard-execution/requirements/batch-activate').set('Authorization', `Bearer ${token}`).send({ ids: [r1.id] })
    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(1)
    const after = await prisma.standardExecutionRequirement.findUnique({ where: { id: r1.id } })
    expect(after?.status).toBe('ACTIVE')
  })
  it('batch-disable: ACTIVE → DISABLED', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r1 = await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'a', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id } })
    const res = await request(app).post('/api/admin/standard-execution/requirements/batch-disable').set('Authorization', `Bearer ${token}`).send({ ids: [r1.id] })
    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(1)
    const after = await prisma.standardExecutionRequirement.findUnique({ where: { id: r1.id } })
    expect(after?.status).toBe('DISABLED')
  })
  it('batch-delete: 删除无引用要求项 → deleted', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r1 = await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'a', requirementText: 'x', status: 'DRAFT', createdBy: admin.id } })
    const res = await request(app).post('/api/admin/standard-execution/requirements/batch-delete').set('Authorization', `Bearer ${token}`).send({ ids: [r1.id] })
    expect(res.status).toBe(200)
    expect(res.body.deleted).toBe(1)
    expect(res.body.archived).toBe(0)
    expect(res.body.requested).toBe(1)
    expect(res.body.details[0].action).toBe('deleted')
    const after = await prisma.standardExecutionRequirement.findUnique({ where: { id: r1.id } })
    expect(after).toBeNull()
  })
  it('batch-delete: 有任务引用时保留历史并软删除，不清理任务', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id)
    const r1 = await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'a', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id } })
    const task = await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'DEFAULT',
        requirementId: r1.id,
        title: 'linked task',
        submitRequirement: 'submit',
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: admin.id,
        createdBy: admin.id,
      },
    })
    const res = await request(app).post('/api/admin/standard-execution/requirements/batch-delete').set('Authorization', `Bearer ${token}`).send({ ids: [r1.id] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ requested: 1, deleted: 0, archived: 1, skipped: 0 })
    expect(res.body.details[0]).toMatchObject({ id: r1.id, action: 'archived', associations: { tasks: 1 } })
    const after = await prisma.standardExecutionRequirement.findUnique({ where: { id: r1.id } })
    expect(after?.status).toBe('ARCHIVED')
    const taskAfter = await prisma.standardExecutionTask.findUnique({ where: { id: task.id } })
    expect(taskAfter?.requirementId).toBe(r1.id)
  })
  it('非 admin → 403', async () => {
    const u = await createUser({ role: 'user' })
    const res = await request(app).post('/api/admin/standard-execution/requirements/batch-activate').set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`).send({ ids: ['x'] })
    expect(res.status).toBe(403)
  })
})
