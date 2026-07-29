/**
 * 企业版 /api/enterprise/standard-execution/packages — 端到端测试
 *
 * 覆盖：
 *  - GET  /packages                — 列表 + 企业隔离 + filter
 *  - POST /packages                — 创建 DRAFT（仅 VALID 记录）
 *  - GET  /packages/:id            — 详情 + tree 结构
 *  - POST /packages/:id/generate   — DRAFT|READY → READY
 *  - POST /packages/:id/void       — DRAFT|READY → VOID
 *  - 权限拦截：未登录 / 无 enterpriseId → 401 / 403
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import JSZip from 'jszip'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerEnterpriseRoutes(app)
})

let employeeToken: string
let readonlyEmployeeToken: string
let plainToken: string
let recordId: string
let voidRecordId: string

beforeEach(async () => {
  await cleanStandardExecutionData()

  for (const id of ['DEFAULT', 'ENT_A']) {
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

  const readonlyEmployee = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: readonlyEmployee.id },
    data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' },
  })
  readonlyEmployeeToken = getTestToken(readonlyEmployee.id, 'user')

  const plain = await createUser({ role: 'user' })
  plainToken = getTestToken(plain.id, 'user')

  const source = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId: 'ENT_A',
      title: 'src-1',
      sourceType: 'PRODUCT_STANDARD',
      status: 'ACTIVE',
      createdBy: employee.id,
    },
  })
  const req = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId: 'ENT_A',
      sourceId: source.id,
      title: 'req-1',
      requirementText: 'do it',
      status: 'ACTIVE',
      generateMode: 'MANUAL',
      createdBy: employee.id,
    },
  })
  const task = await prisma.standardExecutionTask.create({
    data: {
      enterpriseId: 'ENT_A',
      requirementId: req.id,
      title: 'task-1',
      submitRequirement: 'sr',
      deadlineAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      reviewerId: employee.id,
      status: 'PUBLISHED',
      createdBy: employee.id,
    },
  })
  const sub1 = await prisma.standardExecutionSubmission.create({
    data: { enterpriseId: 'ENT_A', taskId: task.id, assigneeId: employee.id, submitText: 'done', status: 'APPROVED' },
  })
  const sub2 = await prisma.standardExecutionSubmission.create({
    data: { enterpriseId: 'ENT_A', taskId: task.id, assigneeId: employee.id, submitText: 'done2', status: 'APPROVED' },
  })
  const r1 = await prisma.standardExecutionRecord.create({
    data: {
      enterpriseId: 'ENT_A',
      sourceId: source.id,
      requirementId: req.id,
      taskId: task.id,
      submissionId: sub1.id,
      assigneeId: employee.id,
      title: 'rec-1',
      status: 'VALID',
    },
  })
  const r2 = await prisma.standardExecutionRecord.create({
    data: {
      enterpriseId: 'ENT_A',
      sourceId: source.id,
      requirementId: req.id,
      taskId: task.id,
      submissionId: sub2.id,
      assigneeId: employee.id,
      title: 'rec-void',
      status: 'VOID',
    },
  })
  recordId = r1.id
  voidRecordId = r2.id
})

async function createPkgViaApi(token: string, recordIds: string[]) {
  return request(app)
    .post('/api/enterprise/standard-execution/packages')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'pkg', packageScene: 'CUSTOMER_AUDIT', recordIds })
}

function binaryParser(res: NodeJS.ReadableStream, cb: (err: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = []
  res.on('data', (chunk) => chunks.push(chunk as Buffer))
  res.on('end', () => cb(null, Buffer.concat(chunks)))
}

describe('POST /packages', () => {
  it('未登录 → 401', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/packages')
      .send({ title: 'p', packageScene: 'CUSTOMER_AUDIT', recordIds: [recordId] })
    expect(res.status).toBe(401)
  })

  it('happy → 201 + DRAFT', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/packages')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        title: 'pkg',
        packageScene: 'CUSTOMER_AUDIT',
        description: '客户审厂留档说明',
        dateFrom: '2026-06-01T00:00:00.000Z',
        dateTo: '2026-06-30T23:59:59.000Z',
        recordIds: [recordId],
      })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('DRAFT')
    expect(res.body.data.description).toBe('客户审厂留档说明')
    expect(new Date(res.body.data.dateFrom).toISOString()).toBe('2026-06-01T00:00:00.000Z')
    expect(new Date(res.body.data.dateTo).toISOString()).toBe('2026-06-30T23:59:59.000Z')
  })

  it('含 VOID 记录 → 400', async () => {
    const res = await createPkgViaApi(employeeToken, [recordId, voidRecordId])
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('VALID')
  })

  it('recordId 不存在 → 400', async () => {
    const res = await createPkgViaApi(employeeToken, [recordId, 'no-such-rec'])
    expect(res.status).toBe(400)
  })

  it('普通 user → 403', async () => {
    const res = await createPkgViaApi(plainToken, [recordId])
    expect(res.status).toBe(403)
  })
})

describe('GET /packages 列表 + 隔离', () => {
  it('企业成员列表为空（未建）', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/packages')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })

  it('建后列表返回该包', async () => {
    await createPkgViaApi(employeeToken, [recordId])
    const res = await request(app)
      .get('/api/enterprise/standard-execution/packages')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.body.data).toHaveLength(1)
  })
})

describe('GET /packages/:id 详情 tree', () => {
  it('返回 tree 树状结构', async () => {
    const c = await createPkgViaApi(employeeToken, [recordId])
    const id = c.body.data.id
    const res = await request(app)
      .get(`/api/enterprise/standard-execution/packages/${id}`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data.tree)).toBe(true)
    expect(res.body.data.tree.length).toBeGreaterThanOrEqual(1)
  })

  it('id 不存在 → 404', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/packages/no-such')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(404)
  })
})

describe('POST /packages/:id/generate + void', () => {
  it('preview + generate → 200 + status=READY + 多文件 README', async () => {
    const c = await createPkgViaApi(employeeToken, [recordId])
    const id = c.body.data.id
    const preview = await request(app)
      .post(`/api/enterprise/standard-execution/packages/${id}/preview`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ includeManifest: true })
    expect(preview.status).toBe(200)
    expect(preview.body.data.stats.recordCount).toBe(1)
    expect(preview.body.data.cover).toMatchObject({
      enterpriseName: 'ENT_A',
      packageSceneLabel: '客户审厂',
    })
    expect(preview.body.data.outputFileTree.map((f: { path: string }) => f.path)).toContain('manifest.json')
    const recordDir = `records/01-${recordId.slice(0, 8)}`
    expect(preview.body.data.outputFileTree.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining([
      '封面.pdf',
      '目录.pdf',
      `${recordDir}/提交内容.pdf`,
      '汇总.pdf',
    ]))

    const res = await request(app)
      .post(`/api/enterprise/standard-execution/packages/${id}/generate`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ includeManifest: true })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('READY')
    expect(res.body.data.format).toBe('FOLDER')
    expect(res.body.data.generationStatus).toBe('READY')
    expect(res.body.data.generatedAt).toBeTruthy()
    expect(res.body.data.fileUrl).toMatch(/^\/uploads\/se-packages\/.+\/README\.txt$/)

    const download = await request(app)
      .get(`/api/enterprise/standard-execution/packages/${id}/files`)
      .query({ path: 'README.txt' })
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(download.status).toBe(200)
    expect(download.headers['content-disposition']).toContain('attachment')

    const cover = await request(app)
      .get(`/api/enterprise/standard-execution/packages/${id}/files`)
      .query({ path: '封面.pdf' })
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(cover.status).toBe(200)
    expect(cover.headers['content-type']).toContain('application/pdf')

    const zipRes = await request(app)
      .get(`/api/enterprise/standard-execution/packages/${id}/download-zip`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .buffer(true)
      .parse(binaryParser)
    expect(zipRes.status).toBe(200)
    const zip = await JSZip.loadAsync(zipRes.body)
    expect(zip.file('封面.pdf')).toBeTruthy()
    expect(zip.file('目录.pdf')).toBeTruthy()
    expect(zip.file(`${recordDir}/提交内容.pdf`)).toBeTruthy()
    expect(zip.file('全部材料.zip')).toBeNull()
  })

  it('EMPLOYEE 不能 preview / generate 材料包', async () => {
    const c = await createPkgViaApi(employeeToken, [recordId])
    const id = c.body.data.id
    const preview = await request(app)
      .post(`/api/enterprise/standard-execution/packages/${id}/preview`)
      .set('Authorization', `Bearer ${readonlyEmployeeToken}`)
    expect(preview.status).toBe(403)
    const generate = await request(app)
      .post(`/api/enterprise/standard-execution/packages/${id}/generate`)
      .set('Authorization', `Bearer ${readonlyEmployeeToken}`)
    expect(generate.status).toBe(403)
  })

  it('跨企业 package preview → 404', async () => {
    const other = await prisma.standardExecutionPackage.create({
      data: { enterpriseId: 'DEFAULT', title: 'other', packageScene: 'INTERNAL_CHECK', createdBy: 'admin' },
    })
    const res = await request(app)
      .post(`/api/enterprise/standard-execution/packages/${other.id}/preview`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(404)
  })

  it('void → 200 + status=VOID', async () => {
    const c = await createPkgViaApi(employeeToken, [recordId])
    const id = c.body.data.id
    const res = await request(app)
      .post(`/api/enterprise/standard-execution/packages/${id}/void`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('VOID')
  })

  it('重复 void → noop=true', async () => {
    const c = await createPkgViaApi(employeeToken, [recordId])
    const id = c.body.data.id
    await request(app)
      .post(`/api/enterprise/standard-execution/packages/${id}/void`)
      .set('Authorization', `Bearer ${employeeToken}`)
    const res = await request(app)
      .post(`/api/enterprise/standard-execution/packages/${id}/void`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.body.noop).toBe(true)
  })

  it('VOID 不能再 generate → 409', async () => {
    const c = await createPkgViaApi(employeeToken, [recordId])
    const id = c.body.data.id
    await request(app)
      .post(`/api/enterprise/standard-execution/packages/${id}/void`)
      .set('Authorization', `Bearer ${employeeToken}`)
    const res = await request(app)
      .post(`/api/enterprise/standard-execution/packages/${id}/generate`)
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(409)
  })
})
