/**
 * standard-execution / 题库 — 企业版端点测试
 *
 * 端点(registerEnterpriseRoutes, requireAuth + resolveEnterpriseId):
 *   GET/POST/PATCH/DELETE /api/enterprise/standard-execution/question-banks[/:id]
 *
 * 覆盖:
 *  - 企业成员创建/列表/详情/更新/删除(enterpriseId=本企业)
 *  - 跨企业隔离: ENT_A 看不到 ENT_B 的题库(list total / detail 404)
 *  - admin → DEFAULT 通配
 *  - 无 enterprise 绑定的 user → 403(resolveEnterpriseId)
 *  - 删除有关联任务 → 409
 *  - 无 token → 401
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { createUser, getTestToken, cleanAll } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerEnterpriseRoutes(app)
})

const sampleQuestions = [
  { id: 'q1', type: 'single', text: '1+1=?', opts: ['1', '2', '3'], answer: [1], score: 50, exp: '等于 2' },
  { id: 'q2', type: 'multi', text: '选出偶数', opts: ['1', '2', '4', '5'], answer: [1, 2], score: 50 },
]
const validBody = { title: '企业安全培训题库', description: '入职必考', questions: sampleQuestions }
const BASE = '/api/enterprise/standard-execution/question-banks'

let empAId: string, empAToken: string
let empBToken: string
let employeeToken: string
let adminToken: string
let plainToken: string

beforeEach(async () => {
  // 完整 FK 拓扑序：CI 并发下其他文件残留的 submission/record/reviewLog 会撞 task FK，必须全删
  await cleanStandardExecutionData()
  await cleanAll()

  for (const id of ['DEFAULT', 'ENT_A', 'ENT_B']) {
    await prisma.enterprise.upsert({
      where: { id },
      update: { status: 'ACTIVE' },
      create: { id, name: id, code: id, status: 'ACTIVE' },
    })
  }

  const admin = await createUser({ role: 'admin' })
  adminToken = getTestToken(admin.id, 'admin')

  const empA = await createUser({ role: 'user' })
  await prisma.appUser.update({ where: { id: empA.id }, data: { enterpriseId: 'ENT_A', enterpriseRole: 'ADMIN' } })
  empAId = empA.id
  empAToken = getTestToken(empA.id, 'user')

  const empB = await createUser({ role: 'user' })
  await prisma.appUser.update({ where: { id: empB.id }, data: { enterpriseId: 'ENT_B', enterpriseRole: 'ADMIN' } })
  empBToken = getTestToken(empB.id, 'user')

  const employee = await createUser({ role: 'user' })
  await prisma.appUser.update({ where: { id: employee.id }, data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' } })
  employeeToken = getTestToken(employee.id, 'user')

  const plain = await createUser({ role: 'user' })
  plainToken = getTestToken(plain.id, 'user')
})

describe('POST /api/enterprise/standard-execution/question-banks', () => {
  it('企业成员创建 → 201 + enterpriseId=本企业 + createdBy', async () => {
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${empAToken}`).send(validBody)
    expect(res.status).toBe(201)
    expect(res.body.title).toBe(validBody.title)
    expect(res.body.enterpriseId).toBe('ENT_A')
    expect(res.body.createdBy).toBe(empAId)
  })

  it('admin → enterpriseId=DEFAULT 通配', async () => {
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${adminToken}`).send(validBody)
    expect(res.status).toBe(201)
    expect(res.body.enterpriseId).toBe('DEFAULT')
  })

  it('无 enterprise 绑定的 user → 403', async () => {
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${plainToken}`).send(validBody)
    expect(res.status).toBe(403)
  })

  it('EMPLOYEE → 403', async () => {
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${employeeToken}`).send(validBody)
    expect(res.status).toBe(403)
  })

  it('无 token → 401', async () => {
    const res = await request(app).post(BASE).send(validBody)
    expect(res.status).toBe(401)
  })

  it('title 空 → 400', async () => {
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${empAToken}`).send({ ...validBody, title: '' })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/enterprise/standard-execution/question-banks', () => {
  it('列表 enterpriseId 隔离 — ENT_A 看不到 ENT_B 的题库', async () => {
    await prisma.sEQuestionBank.create({ data: { enterpriseId: 'ENT_A', title: 'A 的题库', questions: sampleQuestions as never, createdBy: empAId } })
    await prisma.sEQuestionBank.create({ data: { enterpriseId: 'ENT_B', title: 'B 的题库', questions: sampleQuestions as never, createdBy: empAId } })
    const res = await request(app).get(BASE).set('Authorization', `Bearer ${empAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].title).toBe('A 的题库')
    expect(res.body.data[0].questionCount).toBe(2)
  })

  it('admin → 只看 DEFAULT 题库', async () => {
    await prisma.sEQuestionBank.create({ data: { enterpriseId: 'DEFAULT', title: '默认题库', questions: sampleQuestions as never, createdBy: empAId } })
    await prisma.sEQuestionBank.create({ data: { enterpriseId: 'ENT_A', title: 'A 的题库', questions: sampleQuestions as never, createdBy: empAId } })
    const res = await request(app).get(BASE).set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].title).toBe('默认题库')
  })

  it('EMPLOYEE → 403', async () => {
    const res = await request(app).get(BASE).set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(403)
  })

  it('无 enterprise 绑定 user → 403', async () => {
    const res = await request(app).get(BASE).set('Authorization', `Bearer ${plainToken}`)
    expect(res.status).toBe(403)
  })
})

describe('GET/PATCH/DELETE /api/enterprise/standard-execution/question-banks/:id', () => {
  it('详情 — 本企业 200 / 跨企业 404', async () => {
    const a = await prisma.sEQuestionBank.create({ data: { enterpriseId: 'ENT_A', title: 'A', questions: sampleQuestions as never, createdBy: empAId } })
    const ok = await request(app).get(`${BASE}/${a.id}`).set('Authorization', `Bearer ${empAToken}`)
    expect(ok.status).toBe(200)
    // ENT_B 用户访问 ENT_A 题库 → 404
    const cross = await request(app).get(`${BASE}/${a.id}`).set('Authorization', `Bearer ${empBToken}`)
    expect(cross.status).toBe(404)
  })

  it('详情 EMPLOYEE → 403', async () => {
    const a = await prisma.sEQuestionBank.create({ data: { enterpriseId: 'ENT_A', title: 'A', questions: sampleQuestions as never, createdBy: empAId } })
    const res = await request(app).get(`${BASE}/${a.id}`).set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(403)
  })

  it('更新 → 200', async () => {
    const a = await prisma.sEQuestionBank.create({ data: { enterpriseId: 'ENT_A', title: 'old', questions: sampleQuestions as never, createdBy: empAId } })
    const res = await request(app).patch(`${BASE}/${a.id}`).set('Authorization', `Bearer ${empAToken}`).send({ title: 'new' })
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('new')
  })

  it('更新跨企业 → 404；EMPLOYEE → 403', async () => {
    const a = await prisma.sEQuestionBank.create({ data: { enterpriseId: 'ENT_A', title: 'A', questions: sampleQuestions as never, createdBy: empAId } })
    const cross = await request(app).patch(`${BASE}/${a.id}`).set('Authorization', `Bearer ${empBToken}`).send({ title: 'x' })
    expect(cross.status).toBe(404)
    const employee = await request(app).patch(`${BASE}/${a.id}`).set('Authorization', `Bearer ${employeeToken}`).send({ title: 'x' })
    expect(employee.status).toBe(403)
  })

  it('删除无关联 → 200 软删除', async () => {
    const a = await prisma.sEQuestionBank.create({ data: { enterpriseId: 'ENT_A', title: 'A', questions: sampleQuestions as never, createdBy: empAId } })
    const res = await request(app).delete(`${BASE}/${a.id}`).set('Authorization', `Bearer ${empAToken}`)
    expect(res.status).toBe(200)
    const row = await prisma.sEQuestionBank.findUnique({ where: { id: a.id } })
    expect(row?.deletedAt).not.toBeNull()
  })

  it('删除跨企业 → 404；EMPLOYEE → 403', async () => {
    const a = await prisma.sEQuestionBank.create({ data: { enterpriseId: 'ENT_A', title: 'A', questions: sampleQuestions as never, createdBy: empAId } })
    const cross = await request(app).delete(`${BASE}/${a.id}`).set('Authorization', `Bearer ${empBToken}`)
    expect(cross.status).toBe(404)
    const employee = await request(app).delete(`${BASE}/${a.id}`).set('Authorization', `Bearer ${employeeToken}`)
    expect(employee.status).toBe(403)
  })

  it('删除有关联任务(PUBLISHED) → 409', async () => {
    const a = await prisma.sEQuestionBank.create({ data: { enterpriseId: 'ENT_A', title: 'A', questions: sampleQuestions as never, createdBy: empAId } })
    await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'ENT_A',
        title: '培训任务',
        taskType: 'TRAINING',
        quizBankId: a.id,
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: empAId,
        createdBy: empAId,
        status: 'PUBLISHED',
      },
    })
    const res = await request(app).delete(`${BASE}/${a.id}`).set('Authorization', `Bearer ${empAToken}`)
    expect(res.status).toBe(409)
  })
})
