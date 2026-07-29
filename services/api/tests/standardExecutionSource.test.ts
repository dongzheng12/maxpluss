/**
 * standard-execution / Source — Admin 端 CRUD 测试
 *
 * 覆盖：
 *  - happy path: create → list → get → update → disable
 *  - 权限：无 token 401 / user role 403 / sales role 403
 *  - 边界：title 空 400 / sourceType 非法 400 / id 不存在 404 / 重复 disable 幂等
 *  - enterpriseId 隔离：admin 默认 DEFAULT 企业，看不到 OTHER 企业的数据
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

const validBody = {
  title: 'GB/T 19001-2016 质量管理体系',
  sourceType: 'PRODUCT_STANDARD',
  sourceNo: 'GB/T 19001-2016',
  version: '2016',
  rawText: '本标准规定了质量管理体系的要求……',
}

async function makeAdminToken() {
  const admin = await createUser({ role: 'admin' })
  return { admin, token: getTestToken(admin.id, 'admin') }
}

describe('POST /api/admin/standard-execution/sources', () => {
  it('happy path — admin 创建 201 + DB 写入 + 默认 DEFAULT enterprise', async () => {
    const { admin, token } = await makeAdminToken()
    const res = await request(app)
      .post('/api/admin/standard-execution/sources')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
    expect(res.status).toBe(201)
    expect(res.body.data.title).toBe(validBody.title)
    expect(res.body.data.enterpriseId).toBe('DEFAULT')
    expect(res.body.data.status).toBe('ACTIVE')
    expect(res.body.data.createdBy).toBe(admin.id)

    const rows = await prisma.standardExecutionSource.findMany()
    expect(rows.length).toBe(1)
  })

  it('无 token → 401', async () => {
    const res = await request(app)
      .post('/api/admin/standard-execution/sources')
      .send(validBody)
    expect(res.status).toBe(401)
  })

  it('user role → 403', async () => {
    const user = await createUser({ role: 'user' })
    const token = getTestToken(user.id, 'user')
    const res = await request(app)
      .post('/api/admin/standard-execution/sources')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
    expect(res.status).toBe(403)
  })

  it('sales role → 403（standard-execution admin 接口不放行 sales）', async () => {
    const sales = await createUser({ role: 'sales' })
    const token = getTestToken(sales.id, 'sales')
    const res = await request(app)
      .post('/api/admin/standard-execution/sources')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
    expect(res.status).toBe(403)
  })

  it('title 空 → 400', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .post('/api/admin/standard-execution/sources')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, title: '' })
    expect(res.status).toBe(400)
  })

  it('sourceType 非法 → 400', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .post('/api/admin/standard-execution/sources')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, sourceType: 'BOGUS' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/admin/uploads/standard-file', () => {
  it('接受 TXT 标准文件并返回 rawText', async () => {
    const { token } = await makeAdminToken()
    const txt = [
      '5.1 企业应建立质量管理记录，并明确责任人员、记录时间、检查内容和保存期限。',
      '5.2 生产现场必须定期开展设备点检，异常情况应形成处置闭环并保留证明材料。',
      '5.3 检验报告应完整、真实、可追溯，相关记录保存期限不少于三年。',
    ].join('\n')

    const res = await request(app)
      .post('/api/admin/uploads/standard-file')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(txt, 'utf-8'), 'standard.txt')

    expect(res.status).toBe(200)
    expect(res.body.fileUrl).toMatch(/^\/uploads\/standard-sources\/.+\.txt$/)
    expect(res.body.rawText).toContain('质量管理记录')
  })
})

describe('GET /api/admin/standard-execution/sources', () => {
  it('list 返回分页 + 按 enterpriseId 隔离（不返回 OTHER 企业数据）', async () => {
    const { admin, token } = await makeAdminToken()
    // DEFAULT 企业：admin 创建一条
    await prisma.standardExecutionSource.create({
      data: {
        enterpriseId: 'DEFAULT',
        title: '默认企业 — 标准 A',
        sourceType: 'PRODUCT_STANDARD',
        createdBy: admin.id,
      },
    })
    // OTHER 企业：直接 prisma 写一条
    await prisma.standardExecutionSource.create({
      data: {
        enterpriseId: 'OTHER',
        title: '其他企业 — 不应被看到',
        sourceType: 'PRODUCT_STANDARD',
        createdBy: admin.id,
      },
    })

    const res = await request(app)
      .get('/api/admin/standard-execution/sources')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].title).toBe('默认企业 — 标准 A')
  })

  it('按 sourceType / status / keyword 过滤', async () => {
    const { admin, token } = await makeAdminToken()
    await prisma.standardExecutionSource.createMany({
      data: [
        { enterpriseId: 'DEFAULT', title: 'GB 19001 质量管理', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
        { enterpriseId: 'DEFAULT', title: '内部制度手册', sourceType: 'INTERNAL_POLICY', createdBy: admin.id },
        { enterpriseId: 'DEFAULT', title: '已停用标准', sourceType: 'PRODUCT_STANDARD', status: 'DISABLED', createdBy: admin.id },
      ],
    })

    const r1 = await request(app)
      .get('/api/admin/standard-execution/sources?sourceType=PRODUCT_STANDARD')
      .set('Authorization', `Bearer ${token}`)
    expect(r1.body.total).toBe(2)

    const r2 = await request(app)
      .get('/api/admin/standard-execution/sources?status=DISABLED')
      .set('Authorization', `Bearer ${token}`)
    expect(r2.body.total).toBe(1)

    const r3 = await request(app)
      .get('/api/admin/standard-execution/sources?keyword=19001')
      .set('Authorization', `Bearer ${token}`)
    expect(r3.body.total).toBe(1)
    expect(r3.body.data[0].title).toBe('GB 19001 质量管理')
  })

  it('无 token → 401', async () => {
    const res = await request(app).get('/api/admin/standard-execution/sources')
    expect(res.status).toBe(401)
  })
})

describe('GET /api/admin/standard-execution/sources/:id', () => {
  it('返回详情', async () => {
    const { admin, token } = await makeAdminToken()
    const created = await prisma.standardExecutionSource.create({
      data: {
        enterpriseId: 'DEFAULT',
        title: 'X',
        sourceType: 'PRODUCT_STANDARD',
        createdBy: admin.id,
      },
    })
    const res = await request(app)
      .get(`/api/admin/standard-execution/sources/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(created.id)
  })

  it('id 不存在 → 404', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .get('/api/admin/standard-execution/sources/no-such-id')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })

  it('其他企业的 id → 404（enterpriseId 隔离）', async () => {
    const { admin, token } = await makeAdminToken()
    const other = await prisma.standardExecutionSource.create({
      data: {
        enterpriseId: 'OTHER',
        title: 'X',
        sourceType: 'PRODUCT_STANDARD',
        createdBy: admin.id,
      },
    })
    const res = await request(app)
      .get(`/api/admin/standard-execution/sources/${other.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/admin/standard-execution/sources/:id', () => {
  it('happy path — 修改 title + version + 写入 updatedBy', async () => {
    const { admin, token } = await makeAdminToken()
    const created = await prisma.standardExecutionSource.create({
      data: {
        enterpriseId: 'DEFAULT',
        title: 'old',
        sourceType: 'PRODUCT_STANDARD',
        createdBy: admin.id,
      },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/sources/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'new', version: '2024' })
    expect(res.status).toBe(200)
    expect(res.body.data.title).toBe('new')
    expect(res.body.data.version).toBe('2024')
    expect(res.body.data.updatedBy).toBe(admin.id)
  })

  it('id 不存在 → 404', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .patch('/api/admin/standard-execution/sources/no-such-id')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'x' })
    expect(res.status).toBe(404)
  })

  it('title 设为空字符串 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const created = await prisma.standardExecutionSource.create({
      data: {
        enterpriseId: 'DEFAULT',
        title: 'X',
        sourceType: 'PRODUCT_STANDARD',
        createdBy: admin.id,
      },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/sources/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '' })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/admin/standard-execution/sources/:id/disable', () => {
  it('happy path — status 变 DISABLED', async () => {
    const { admin, token } = await makeAdminToken()
    const created = await prisma.standardExecutionSource.create({
      data: {
        enterpriseId: 'DEFAULT',
        title: 'X',
        sourceType: 'PRODUCT_STANDARD',
        createdBy: admin.id,
      },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/sources/${created.id}/disable`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('DISABLED')
  })

  it('重复 disable → 200 + alreadyDisabled=true（幂等）', async () => {
    const { admin, token } = await makeAdminToken()
    const created = await prisma.standardExecutionSource.create({
      data: {
        enterpriseId: 'DEFAULT',
        title: 'X',
        sourceType: 'PRODUCT_STANDARD',
        status: 'DISABLED',
        createdBy: admin.id,
      },
    })
    const res = await request(app)
      .patch(`/api/admin/standard-execution/sources/${created.id}/disable`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.alreadyDisabled).toBe(true)
  })

  it('id 不存在 → 404', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .patch('/api/admin/standard-execution/sources/no-such-id/disable')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })
})

describe('POST /api/admin/standard-execution/sources/batch-disable', () => {
  const PATH = '/api/admin/standard-execution/sources/batch-disable'

  it('happy path — 批量停用 ACTIVE，返回 ok/requested/skipped', async () => {
    const { admin, token } = await makeAdminToken()
    const s1 = await prisma.standardExecutionSource.create({
      data: { enterpriseId: 'DEFAULT', title: 'A', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
    })
    const s2 = await prisma.standardExecutionSource.create({
      data: { enterpriseId: 'DEFAULT', title: 'B', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
    })
    const res = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [s1.id, s2.id] })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(2)
    expect(res.body.requested).toBe(2)
    expect(res.body.skipped).toBe(0)
    const rows = await prisma.standardExecutionSource.findMany({ where: { id: { in: [s1.id, s2.id] } } })
    expect(rows.every((r) => r.status === 'DISABLED')).toBe(true)
  })

  it('已 DISABLED / 不存在 / 跨企业 id 落入 skipped，不误伤 OTHER 企业', async () => {
    const { admin, token } = await makeAdminToken()
    const active = await prisma.standardExecutionSource.create({
      data: { enterpriseId: 'DEFAULT', title: 'active', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
    })
    const disabled = await prisma.standardExecutionSource.create({
      data: { enterpriseId: 'DEFAULT', title: 'disabled', sourceType: 'PRODUCT_STANDARD', status: 'DISABLED', createdBy: admin.id },
    })
    const other = await prisma.standardExecutionSource.create({
      data: { enterpriseId: 'OTHER', title: 'other', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
    })
    const res = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [active.id, disabled.id, other.id, 'no-such-id'] })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(1)
    expect(res.body.requested).toBe(4)
    expect(res.body.skipped).toBe(3)
    const o = await prisma.standardExecutionSource.findUnique({ where: { id: other.id } })
    expect(o?.status).toBe('ACTIVE')
  })

  it('ids 空 → 400', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app).post(PATH).set('Authorization', `Bearer ${token}`).send({ ids: [] })
    expect(res.status).toBe(400)
  })

  it('无 token → 401', async () => {
    const res = await request(app).post(PATH).send({ ids: ['x'] })
    expect(res.status).toBe(401)
  })

  it('user role → 403', async () => {
    const user = await createUser({ role: 'user' })
    const token = getTestToken(user.id, 'user')
    const res = await request(app).post(PATH).set('Authorization', `Bearer ${token}`).send({ ids: ['x'] })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/admin/standard-execution/sources/batch-delete', () => {
  const PATH = '/api/admin/standard-execution/sources/batch-delete'
  it('happy — 删除无引用来源 → deleted', async () => {
    const { admin, token } = await makeAdminToken()
    const s1 = await prisma.standardExecutionSource.create({ data: { enterpriseId: 'DEFAULT', title: 'd1', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id } })
    const s2 = await prisma.standardExecutionSource.create({ data: { enterpriseId: 'DEFAULT', title: 'd2', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id } })
    const res = await request(app).post(PATH).set('Authorization', `Bearer ${token}`).send({ ids: [s1.id, s2.id] })
    expect(res.status).toBe(200)
    expect(res.body.deleted).toBe(2)
  })
  it('user role → 403', async () => {
    const user = await createUser({ role: 'user' })
    const res = await request(app).post(PATH).set('Authorization', `Bearer ${getTestToken(user.id, 'user')}`).send({ ids: ['x'] })
    expect(res.status).toBe(403)
  })
})
