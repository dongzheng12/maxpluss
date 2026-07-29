/**
 * 企业版 /api/enterprise/standard-execution/sources CRUD — 端到端测试
 *
 * 覆盖：
 *  - POST  /sources                  — 创建
 *  - PATCH /sources/:id              — 编辑
 *  - PATCH /sources/:id/disable      — 软停用
 *  - 权限拦截：未登录 / 无 enterpriseId → 401 / 403
 *  - 跨企业隔离：A 企业用户不能改 B 企业的来源
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { createUser, getTestToken } from './factory.js'
import { OWNED_SOURCE_DECLARATION_DRAFT } from '../src/standard-execution/sourceOwnership.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerEnterpriseRoutes(app)
})

let employeeToken: string
let reviewerToken: string
let managerToken: string
let plainToken: string
let otherEntSourceId: string

beforeEach(async () => {
  await cleanStandardExecutionData()

  for (const id of ['DEFAULT', 'ENT_A', 'ENT_B']) {
    await prisma.enterprise.upsert({
      where: { id },
      update: { name: id, status: 'ACTIVE' },
      create: { id, name: id, code: id, status: 'ACTIVE' },
    })
  }

  const employee = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: employee.id },
    data: { enterpriseId: 'ENT_A', enterpriseRole: 'MANAGER' },
  })
  employeeToken = getTestToken(employee.id, 'user')
  managerToken = employeeToken

  const reviewer = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: reviewer.id },
    data: { enterpriseId: 'ENT_A', enterpriseRole: 'REVIEWER' },
  })
  reviewerToken = getTestToken(reviewer.id, 'user')

  const employeeOnly = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: employeeOnly.id },
    data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' },
  })
  employeeToken = getTestToken(employeeOnly.id, 'user')

  const plain = await createUser({ role: 'user' })
  plainToken = getTestToken(plain.id, 'user')

  // ENT_B 一个 source，验证隔离
  const otherSrc = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId: 'ENT_B',
      title: 'other-ent-source',
      sourceType: 'PRODUCT_STANDARD',
      status: 'ACTIVE',
      createdBy: 'other-creator',
    },
  })
  otherEntSourceId = otherSrc.id
})

describe('POST /api/enterprise/standard-execution/sources', () => {
  const body = {
    title: '新标准来源',
    sourceType: 'PRODUCT_STANDARD',
    sourceNo: 'GB/T 0001',
  }

  it('未登录 → 401', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/sources')
      .send(body)
    expect(res.status).toBe(401)
  })

  it('企业 MANAGER → 201 + enterpriseId=ENT_A', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/sources')
      .set('Authorization', `Bearer ${managerToken}`)
      .send(body)
    expect(res.status).toBe(201)
    expect(res.body.data.enterpriseId).toBe('ENT_A')
    expect(res.body.data.title).toBe(body.title)
    expect(res.body.data.ownershipTier).toBe('R')
  })

  it('title 缺失 → 400', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/sources')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ sourceType: 'PRODUCT_STANDARD' })
    expect(res.status).toBe(400)
  })

  it('普通 user → 403', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/sources')
      .set('Authorization', `Bearer ${plainToken}`)
      .send(body)
    expect(res.status).toBe(403)
  })
})

describe('PATCH /api/enterprise/standard-execution/sources/:id', () => {
  it('编辑本企业 source → 200', async () => {
    const created = await request(app)
      .post('/api/enterprise/standard-execution/sources')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ title: 'orig', sourceType: 'PRODUCT_STANDARD' })
    const id = created.body.data.id
    const res = await request(app)
      .patch(`/api/enterprise/standard-execution/sources/${id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ title: 'updated' })
    expect(res.status).toBe(200)
    expect(res.body.data.title).toBe('updated')
  })

  it('跨企业编辑（ENT_A 用户改 ENT_B 的 source）→ 404', async () => {
    const res = await request(app)
      .patch(`/api/enterprise/standard-execution/sources/${otherEntSourceId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ title: 'hack' })
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/enterprise/standard-execution/sources/:id/disable', () => {
  it('停用本企业 source → 200 + status=DISABLED', async () => {
    const created = await request(app)
      .post('/api/enterprise/standard-execution/sources')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ title: 'to-disable', sourceType: 'PRODUCT_STANDARD' })
    const id = created.body.data.id
    const res = await request(app)
      .patch(`/api/enterprise/standard-execution/sources/${id}/disable`)
      .set('Authorization', `Bearer ${managerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('DISABLED')
  })

  it('已 DISABLED 再调用 → 200 + alreadyDisabled', async () => {
    const created = await request(app)
      .post('/api/enterprise/standard-execution/sources')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ title: 'twice', sourceType: 'PRODUCT_STANDARD' })
    const id = created.body.data.id
    await request(app)
      .patch(`/api/enterprise/standard-execution/sources/${id}/disable`)
      .set('Authorization', `Bearer ${managerToken}`)
    const res = await request(app)
      .patch(`/api/enterprise/standard-execution/sources/${id}/disable`)
      .set('Authorization', `Bearer ${managerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.alreadyDisabled).toBe(true)
  })

  it('跨企业 disable → 404', async () => {
    const res = await request(app)
      .patch(`/api/enterprise/standard-execution/sources/${otherEntSourceId}/disable`)
      .set('Authorization', `Bearer ${managerToken}`)
    expect(res.status).toBe(404)
  })
})

describe('POST /api/enterprise/standard-execution/sources/batch-disable', () => {
  const PATH = '/api/enterprise/standard-execution/sources/batch-disable'

  it('批量停用本企业 ACTIVE source；跨企业 id 落入 skipped（不误伤 ENT_B）', async () => {
    const c1 = await request(app)
      .post('/api/enterprise/standard-execution/sources')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ title: 's1', sourceType: 'PRODUCT_STANDARD' })
    const c2 = await request(app)
      .post('/api/enterprise/standard-execution/sources')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ title: 's2', sourceType: 'PRODUCT_STANDARD' })
    const res = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ ids: [c1.body.data.id, c2.body.data.id, otherEntSourceId] })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(2)
    expect(res.body.requested).toBe(3)
    expect(res.body.skipped).toBe(1)
    // ENT_B 的 source 不被跨企业批量误伤
    const other = await prisma.standardExecutionSource.findUnique({ where: { id: otherEntSourceId } })
    expect(other?.status).toBe('ACTIVE')
  })

  it('未登录 → 401', async () => {
    const res = await request(app).post(PATH).send({ ids: ['x'] })
    expect(res.status).toBe(401)
  })

  it('普通 user（无企业）→ 403', async () => {
    const res = await request(app).post(PATH).set('Authorization', `Bearer ${plainToken}`).send({ ids: ['x'] })
    expect(res.status).toBe(403)
  })

  it('ids 空 → 400', async () => {
    const res = await request(app).post(PATH).set('Authorization', `Bearer ${managerToken}`).send({ ids: [] })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/enterprise/standard-execution/sources/:id/ownership', () => {
  async function createSource(enterpriseId = 'ENT_A') {
    return prisma.standardExecutionSource.create({
      data: {
        enterpriseId,
        title: `${enterpriseId}-source`,
        sourceType: 'INTERNAL_POLICY',
        rawText: '第 3 条：门岗每日核验访客登记并留存截图。',
        createdBy: 'creator',
      },
    })
  }

  it('MANAGER 声明确认后可升 O 档，并写入声明留痕', async () => {
    const source = await createSource()
    const res = await request(app)
      .patch(`/api/enterprise/standard-execution/sources/${source.id}/ownership`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('User-Agent', 'vitest-owned-source')
      .send({
        ownershipTier: 'O',
        declarationAccepted: true,
        declarationText: OWNED_SOURCE_DECLARATION_DRAFT,
      })

    expect(res.status).toBe(200)
    expect(res.body.data.ownershipTier).toBe('O')
    const declarations = await prisma.standardExecutionSourceDeclaration.findMany({
      where: { enterpriseId: 'ENT_A', sourceId: source.id },
    })
    expect(declarations).toHaveLength(1)
    expect(declarations[0].declarationText).toBe(OWNED_SOURCE_DECLARATION_DRAFT)
    expect(declarations[0].declaredBy).toBeTruthy()
    expect(declarations[0].userAgent).toContain('vitest-owned-source')
  })

  it('无声明升 O 档 → 422，且 Source 保持 R 档', async () => {
    const source = await createSource()
    const res = await request(app)
      .patch(`/api/enterprise/standard-execution/sources/${source.id}/ownership`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ ownershipTier: 'O' })

    expect(res.status).toBe(422)
    const row = await prisma.standardExecutionSource.findUnique({ where: { id: source.id } })
    expect(row?.ownershipTier).toBe('R')
  })

  it('EMPLOYEE/REVIEWER 升档 → 403', async () => {
    const source = await createSource()
    const reviewerRes = await request(app)
      .patch(`/api/enterprise/standard-execution/sources/${source.id}/ownership`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({
        ownershipTier: 'O',
        declarationAccepted: true,
        declarationText: OWNED_SOURCE_DECLARATION_DRAFT,
      })
    const employeeRes = await request(app)
      .patch(`/api/enterprise/standard-execution/sources/${source.id}/ownership`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        ownershipTier: 'O',
        declarationAccepted: true,
        declarationText: OWNED_SOURCE_DECLARATION_DRAFT,
      })

    expect(reviewerRes.status).toBe(403)
    expect(employeeRes.status).toBe(403)
  })

  it('跨企业调整他企 Source → 404', async () => {
    const res = await request(app)
      .patch(`/api/enterprise/standard-execution/sources/${otherEntSourceId}/ownership`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        ownershipTier: 'O',
        declarationAccepted: true,
        declarationText: OWNED_SOURCE_DECLARATION_DRAFT,
      })
    expect(res.status).toBe(404)
  })

  it('O→R 降档立即生效，但不删除历史声明', async () => {
    const source = await createSource()
    await request(app)
      .patch(`/api/enterprise/standard-execution/sources/${source.id}/ownership`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        ownershipTier: 'O',
        declarationAccepted: true,
        declarationText: OWNED_SOURCE_DECLARATION_DRAFT,
      })

    const res = await request(app)
      .patch(`/api/enterprise/standard-execution/sources/${source.id}/ownership`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ ownershipTier: 'R' })

    expect(res.status).toBe(200)
    expect(res.body.data.ownershipTier).toBe('R')
    const declarations = await prisma.standardExecutionSourceDeclaration.findMany({
      where: { enterpriseId: 'ENT_A', sourceId: source.id },
    })
    expect(declarations).toHaveLength(1)
  })
})
