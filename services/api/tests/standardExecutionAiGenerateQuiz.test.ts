/**
 * standard-execution / 题库 AI 出题端点（P1-9）supertest
 * POST /api/enterprise/standard-execution/question-banks/ai-generate
 *
 * 注入技巧：beforeAll 用闭包 aiCaller 注册一次 app；每个用例直接重赋 aiCallerImpl，
 * 无需重建 app，也不真调 DeepSeek。
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { createUser, getTestToken } from './factory.js'
import { AiNotConfiguredError, AiCallFailedError } from '../src/standard-execution/aiClient.js'

// 合法 2 题（count=3 时满分由最后一题补齐到 100）
const OK_JSON = JSON.stringify([
  { text: 'Q1 安全档案应含？', opts: ['责任人', '颜色', '页数', '字体'], answer: [0], exp: 'e1' },
  { text: 'Q2 记录保存期限？', opts: ['1 月', '1 年', '3 年'], answer: [1], exp: 'e2' },
])

let aiCallerImpl: (prompt: string) => Promise<string> = async () => OK_JSON
const aiCaller = (p: string) => aiCallerImpl(p)

const app = express()
app.use(express.json())
beforeAll(() => { registerEnterpriseRoutes(app, aiCaller) })

beforeEach(async () => {
  aiCallerImpl = async () => OK_JSON
  // 完整 FK 拓扑序清理：CI 并发共享 PG，缺表（如 TaskItem）会因其他文件残留 FK 致 deleteMany(Task) 失败 → 全 case 崩
  await cleanStandardExecutionData()
})

const AIGEN = '/api/enterprise/standard-execution/question-banks/ai-generate'
const BASE = { count: 3, questionType: 'SINGLE' as const, difficulty: 'BASIC' as const }

async function adminToken() {
  const admin = await createUser({ role: 'admin' })
  return { admin, token: getTestToken(admin.id, 'admin') }
}
async function employeeToken() {
  await prisma.enterprise.upsert({
    where: { id: 'ENT_AI_EMP' },
    update: { status: 'ACTIVE' },
    create: { id: 'ENT_AI_EMP', name: 'ENT_AI_EMP', code: 'ENT_AI_EMP', status: 'ACTIVE' },
  })
  const employee = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: employee.id },
    data: { enterpriseId: 'ENT_AI_EMP', enterpriseRole: 'EMPLOYEE' },
  })
  return { employee, token: getTestToken(employee.id, 'user') }
}
function post(token: string, body: Record<string, unknown>) {
  return request(app).post(AIGEN).set('Authorization', `Bearer ${token}`).send(body)
}

describe('POST question-banks/ai-generate (P1-9)', () => {
  it('200 — requirementText 直传，questions 字段齐全 + 满分补齐到 100', async () => {
    const { token } = await adminToken()
    const res = await post(token, { ...BASE, requirementText: '企业应建立安全生产记录档案' })
    expect(res.status).toBe(200)
    const qs = res.body.data.questions
    expect(qs.length).toBe(2)
    expect(qs[0]).toMatchObject({ type: 'single' })
    expect(qs[0].id).toBeTruthy()
    expect(qs[0].opts.length).toBeGreaterThanOrEqual(2)
    expect(qs[0].answer).toHaveLength(1)
    expect(qs[0].score).toBeGreaterThan(0)
    expect(qs.reduce((s: number, q: { score: number }) => s + q.score, 0)).toBe(100)
  })

  it('200 — requirementId 拼 title+requirementText+executionDescription，注入 relatedRequirementId', async () => {
    const { admin, token } = await adminToken()
    const src = await prisma.standardExecutionSource.create({ data: { enterpriseId: 'DEFAULT', title: 'src', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id } })
    const reqRow = await prisma.standardExecutionRequirement.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: '检查点A', requirementText: '应每月检查并记录', executionDescription: '核查台账与签字', status: 'ACTIVE', createdBy: admin.id },
    })
    let seenPrompt = ''
    aiCallerImpl = async (p) => { seenPrompt = p; return OK_JSON }
    const res = await post(token, { ...BASE, requirementId: reqRow.id })
    expect(res.status).toBe(200)
    expect(seenPrompt).toContain('检查点A')
    expect(seenPrompt).toContain('应每月检查并记录')
    expect(seenPrompt).toContain('核查台账与签字')
    expect(res.body.data.questions[0].relatedRequirementId).toBe(reqRow.id)
  })

  it('401 — 未登录', async () => {
    const res = await request(app).post(AIGEN).send({ ...BASE, requirementText: 'x' })
    expect(res.status).toBe(401)
  })

  it('403 — EMPLOYEE 无权生成题目', async () => {
    const { token } = await employeeToken()
    const res = await post(token, { ...BASE, requirementText: 'x' })
    expect(res.status).toBe(403)
  })

  it('400 — requirementId / requirementText 都缺', async () => {
    const { token } = await adminToken()
    const res = await post(token, { ...BASE })
    expect(res.status).toBe(400)
  })

  it('400 — count 超过 20', async () => {
    const { token } = await adminToken()
    const res = await post(token, { ...BASE, count: 21, requirementText: 'x' })
    expect(res.status).toBe(400)
  })

  it('400 — questionType 非法值', async () => {
    const { token } = await adminToken()
    const res = await post(token, { ...BASE, questionType: 'ESSAY', requirementText: 'x' })
    expect(res.status).toBe(400)
  })

  it('404 — requirementId 不属于当前企业', async () => {
    const { admin, token } = await adminToken()
    const src = await prisma.standardExecutionSource.create({ data: { enterpriseId: 'OTHER_ENT', title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id } })
    const reqRow = await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'OTHER_ENT', sourceId: src.id, title: 't', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id } })
    const res = await post(token, { ...BASE, requirementId: reqRow.id })
    expect(res.status).toBe(404)
  })

  it('422 — AI 返回非法 JSON', async () => {
    aiCallerImpl = async () => '这不是 JSON'
    const { token } = await adminToken()
    const res = await post(token, { ...BASE, requirementText: 'x' })
    expect(res.status).toBe(422)
  })

  it('422 — opts 空数组（schema 不合法）', async () => {
    aiCallerImpl = async () => JSON.stringify([{ text: 'q', opts: [], answer: [0] }])
    const { token } = await adminToken()
    const res = await post(token, { ...BASE, requirementText: 'x' })
    expect(res.status).toBe(422)
  })

  it('422 — answer 全越界，过滤后无有效题目', async () => {
    aiCallerImpl = async () => JSON.stringify([{ text: 'q', opts: ['A', 'B'], answer: [9] }])
    const { token } = await adminToken()
    const res = await post(token, { ...BASE, requirementText: 'x' })
    expect(res.status).toBe(422)
  })

  it('422 — AI 返回空数组', async () => {
    aiCallerImpl = async () => '[]'
    const { token } = await adminToken()
    const res = await post(token, { ...BASE, requirementText: 'x' })
    expect(res.status).toBe(422)
  })

  it('503 — AI 服务未配置', async () => {
    aiCallerImpl = async () => { throw new AiNotConfiguredError() }
    const { token } = await adminToken()
    const res = await post(token, { ...BASE, requirementText: 'x' })
    expect(res.status).toBe(503)
  })

  it('502 — AI 调用失败', async () => {
    aiCallerImpl = async () => { throw new AiCallFailedError('boom') }
    const { token } = await adminToken()
    const res = await post(token, { ...BASE, requirementText: 'x' })
    expect(res.status).toBe(502)
  })

  it('MULTI — 保留多个正确答案，type=multi', async () => {
    aiCallerImpl = async () => JSON.stringify([{ text: 'q', opts: ['A', 'B', 'C', 'D'], answer: [0, 2] }])
    const { token } = await adminToken()
    const res = await post(token, { ...BASE, questionType: 'MULTI', requirementText: 'x' })
    expect(res.status).toBe(200)
    expect(res.body.data.questions[0].type).toBe('multi')
    expect(res.body.data.questions[0].answer).toEqual([0, 2])
  })

  it('TRUEFALSE — 兜底成 single', async () => {
    aiCallerImpl = async () => JSON.stringify([{ text: '判断题', opts: ['正确', '错误'], answer: [0] }])
    const { token } = await adminToken()
    const res = await post(token, { ...BASE, questionType: 'TRUEFALSE', requirementText: 'x' })
    expect(res.status).toBe(200)
    expect(res.body.data.questions[0].type).toBe('single')
  })

  it('边界 — 单选部分 answer 越界时取首个有效索引', async () => {
    aiCallerImpl = async () => JSON.stringify([{ text: 'q', opts: ['A', 'B', 'C'], answer: [9, 1] }])
    const { token } = await adminToken()
    const res = await post(token, { ...BASE, questionType: 'SINGLE', requirementText: 'x' })
    expect(res.status).toBe(200)
    expect(res.body.data.questions[0].answer).toEqual([1])
  })
})
