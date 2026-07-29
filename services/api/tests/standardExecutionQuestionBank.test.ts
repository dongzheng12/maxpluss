/**
 * standard-execution / 题库（SEQuestionBank）— Admin 端 CRUD 测试
 *
 * 覆盖：
 *  - POST   创建题库（含 questions[]）→ 201 + DB 写入 + 默认 DEFAULT enterprise
 *  - GET    列表（keyword 搜索 / 分页，仅返回 questionCount 不返回全量题目）
 *  - GET    详情 → 200 / 不存在 404
 *  - PATCH  更新（title / questions）→ 200
 *  - DELETE 软删除（无关联任务）→ 200 + deletedAt 写入 + 详情转 404
 *  - DELETE 有关联任务（DRAFT/PUBLISHED）→ 409（拒绝删除）
 *  - 权限：无 token 401 / user role 403 / sales role 403
 *  - enterpriseId 隔离：admin 默认 DEFAULT，看不到 OTHER 企业
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerQuestionBankRoutes } from '../src/standard-execution/questionBankRoutes.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerQuestionBankRoutes(app)
})

beforeEach(async () => {
  // 完整 FK 拓扑序：CI 并发下其他文件残留的 submission/record/reviewLog 会撞 task FK，必须全删
  await cleanStandardExecutionData()
})

const sampleQuestions = [
  { id: 'q1', type: 'single', text: '1+1=?', opts: ['1', '2', '3'], answer: [1], score: 50, exp: '等于 2' },
  { id: 'q2', type: 'multi', text: '选出偶数', opts: ['1', '2', '4', '5'], answer: [1, 2], score: 50, exp: '2 和 4' },
]

const validBody = {
  title: '安全生产培训题库',
  description: '入职必考',
  questions: sampleQuestions,
}

async function makeAdminToken() {
  const admin = await createUser({ role: 'admin' })
  return { admin, token: getTestToken(admin.id, 'admin') }
}

const BASE = '/api/admin/standard-execution/question-banks'

describe('POST /api/admin/standard-execution/question-banks', () => {
  it('happy path — admin 创建 201 + DB 写入 + DEFAULT enterprise', async () => {
    const { admin, token } = await makeAdminToken()
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${token}`).send(validBody)
    expect(res.status).toBe(201)
    expect(res.body.title).toBe(validBody.title)
    expect(res.body.enterpriseId).toBe('DEFAULT')
    expect(res.body.createdBy).toBe(admin.id)
    expect(Array.isArray(res.body.questions)).toBe(true)
    expect(res.body.questions.length).toBe(2)

    const rows = await prisma.sEQuestionBank.findMany()
    expect(rows.length).toBe(1)
  })

  it('无 token → 401', async () => {
    const res = await request(app).post(BASE).send(validBody)
    expect(res.status).toBe(401)
  })

  it('user role → 403', async () => {
    const user = await createUser({ role: 'user' })
    const token = getTestToken(user.id, 'user')
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${token}`).send(validBody)
    expect(res.status).toBe(403)
  })

  it('sales role → 403', async () => {
    const sales = await createUser({ role: 'sales' })
    const token = getTestToken(sales.id, 'sales')
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${token}`).send(validBody)
    expect(res.status).toBe(403)
  })

  it('title 空 → 400', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${token}`).send({ ...validBody, title: '' })
    expect(res.status).toBe(400)
  })

  it('questions 空数组 → 400', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${token}`).send({ ...validBody, questions: [] })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/admin/standard-execution/question-banks', () => {
  it('list 分页 + 仅返回 questionCount（不含全量 questions）+ enterpriseId 隔离', async () => {
    const { admin, token } = await makeAdminToken()
    await prisma.sEQuestionBank.create({
      data: { enterpriseId: 'DEFAULT', title: '题库 A', questions: sampleQuestions as never, createdBy: admin.id },
    })
    await prisma.sEQuestionBank.create({
      data: { enterpriseId: 'OTHER', title: '其他企业题库', questions: sampleQuestions as never, createdBy: admin.id },
    })
    const res = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].title).toBe('题库 A')
    expect(res.body.data[0].questionCount).toBe(2)
    expect(res.body.data[0]).not.toHaveProperty('questions')
  })

  it('keyword 搜 title', async () => {
    const { admin, token } = await makeAdminToken()
    await prisma.sEQuestionBank.createMany({
      data: [
        { enterpriseId: 'DEFAULT', title: '消防安全题库', questions: sampleQuestions as never, createdBy: admin.id },
        { enterpriseId: 'DEFAULT', title: '质量管理题库', questions: sampleQuestions as never, createdBy: admin.id },
      ],
    })
    const res = await request(app).get(`${BASE}?keyword=消防`).set('Authorization', `Bearer ${token}`)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].title).toBe('消防安全题库')
  })

  it('无 token → 401', async () => {
    const res = await request(app).get(BASE)
    expect(res.status).toBe(401)
  })
})

describe('GET /api/admin/standard-execution/question-banks/:id', () => {
  it('详情返回完整 questions', async () => {
    const { admin, token } = await makeAdminToken()
    const bank = await prisma.sEQuestionBank.create({
      data: { enterpriseId: 'DEFAULT', title: 'X', questions: sampleQuestions as never, createdBy: admin.id },
    })
    const res = await request(app).get(`${BASE}/${bank.id}`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(bank.id)
    expect(res.body.questions.length).toBe(2)
  })

  it('id 不存在 → 404', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app).get(`${BASE}/no-such-id`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })

  it('其他企业题库 → 404（隔离）', async () => {
    const { admin, token } = await makeAdminToken()
    const other = await prisma.sEQuestionBank.create({
      data: { enterpriseId: 'OTHER', title: 'X', questions: sampleQuestions as never, createdBy: admin.id },
    })
    const res = await request(app).get(`${BASE}/${other.id}`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/admin/standard-execution/question-banks/:id', () => {
  it('happy path — 改 title + questions', async () => {
    const { admin, token } = await makeAdminToken()
    const bank = await prisma.sEQuestionBank.create({
      data: { enterpriseId: 'DEFAULT', title: 'old', questions: sampleQuestions as never, createdBy: admin.id },
    })
    const newQuestions = [{ id: 'q1', type: 'single', text: '改后', opts: ['A', 'B'], answer: [0], score: 100 }]
    const res = await request(app)
      .patch(`${BASE}/${bank.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'new', questions: newQuestions })
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('new')
    expect(res.body.questions.length).toBe(1)
  })

  it('id 不存在 → 404', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app).patch(`${BASE}/no-such-id`).set('Authorization', `Bearer ${token}`).send({ title: 'x' })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/admin/standard-execution/question-banks/:id', () => {
  it('无关联任务 → 200 + 软删除（deletedAt 写入，详情转 404）', async () => {
    const { admin, token } = await makeAdminToken()
    const bank = await prisma.sEQuestionBank.create({
      data: { enterpriseId: 'DEFAULT', title: 'X', questions: sampleQuestions as never, createdBy: admin.id },
    })
    const res = await request(app).delete(`${BASE}/${bank.id}`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const row = await prisma.sEQuestionBank.findUnique({ where: { id: bank.id } })
    expect(row?.deletedAt).not.toBeNull()

    // 软删后详情拿不到
    const detail = await request(app).get(`${BASE}/${bank.id}`).set('Authorization', `Bearer ${token}`)
    expect(detail.status).toBe(404)
  })

  it('有关联任务（PUBLISHED）→ 409（拒绝删除）', async () => {
    const { admin, token } = await makeAdminToken()
    const bank = await prisma.sEQuestionBank.create({
      data: { enterpriseId: 'DEFAULT', title: 'X', questions: sampleQuestions as never, createdBy: admin.id },
    })
    await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'DEFAULT',
        title: '培训任务',
        taskType: 'TRAINING',
        quizBankId: bank.id,
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: admin.id,
        createdBy: admin.id,
        status: 'PUBLISHED',
      },
    })
    const res = await request(app).delete(`${BASE}/${bank.id}`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
  })

  it('user role → 403', async () => {
    const user = await createUser({ role: 'user' })
    const token = getTestToken(user.id, 'user')
    const res = await request(app).delete(`${BASE}/some-id`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })
})
