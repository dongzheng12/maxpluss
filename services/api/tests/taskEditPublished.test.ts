/**
 * P0-1 PUBLISHED 任务安全字段编辑 — admin 端
 * DRAFT 全改 / PUBLISHED 仅安全字段(标题/说明/提交要求/截止/审核人)+执行人追加 / COMPLETED 等拒
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerStandardExecutionTaskRoutes } from '../src/standard-execution/taskRoutes.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())
beforeAll(() => { registerStandardExecutionTaskRoutes(app) })

beforeEach(async () => {
  await cleanStandardExecutionData()
})

async function setup(status = 'PUBLISHED') {
  const admin = await createUser({ role: 'admin' })
  const reviewer = await createUser({ role: 'user' })
  const a1 = await createUser({ role: 'user' })
  const src = await prisma.standardExecutionSource.create({ data: { enterpriseId: 'DEFAULT', title: 'S', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id } })
  const req = await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'R', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id } })
  const bank = await prisma.sEQuestionBank.create({ data: { enterpriseId: 'DEFAULT', title: 'B', questions: [{ id: 'q1', type: 'single', text: '?', opts: ['a', 'b'], answer: [0], score: 100 }] as never, createdBy: admin.id } })
  const task = await prisma.standardExecutionTask.create({
    data: {
      enterpriseId: 'DEFAULT', requirementId: req.id, title: '原标题', taskType: 'TRAINING',
      quizBankId: bank.id, submitRequirement: 'x', deadlineAt: new Date(Date.now() + 86400000),
      reviewerId: reviewer.id, createdBy: admin.id, status, publishedAt: status === 'DRAFT' ? null : new Date(),
    },
  })
  await prisma.standardExecutionTaskAssignee.create({ data: { enterpriseId: 'DEFAULT', taskId: task.id, assigneeId: a1.id, status: 'IN_PROGRESS' } })
  return { admin, reviewer, a1, task, bank, req }
}
const PATCH = (id: string) => `/api/admin/standard-execution/tasks/${id}`
const auth = (id: string) => ({ Authorization: `Bearer ${getTestToken(id, 'admin')}` })

describe('P0-1 PUBLISHED 任务安全字段编辑', () => {
  it('PUBLISHED 改安全字段(标题/截止/提交要求) → 200 生效', async () => {
    const { admin, task } = await setup('PUBLISHED')
    const res = await request(app).patch(PATCH(task.id)).set(auth(admin.id))
      .send({ title: '新标题', submitRequirement: '新要求', deadlineAt: new Date(Date.now() + 172800000).toISOString() })
    expect(res.status).toBe(200)
    const t = await prisma.standardExecutionTask.findUnique({ where: { id: task.id } })
    expect(t?.title).toBe('新标题')
    expect(t?.submitRequirement).toBe('新要求')
  })

  it('PUBLISHED 改任务类型/题库 → 被忽略(保持原值)', async () => {
    const { admin, task, bank } = await setup('PUBLISHED')
    const res = await request(app).patch(PATCH(task.id)).set(auth(admin.id))
      .send({ taskType: 'INSPECTION_FILL', quizBankId: null })
    expect(res.status).toBe(200)
    const t = await prisma.standardExecutionTask.findUnique({ where: { id: task.id } })
    expect(t?.taskType).toBe('TRAINING')   // 忽略，不变
    expect(t?.quizBankId).toBe(bank.id)     // 忽略，不变
  })

  it('PUBLISHED 追加执行人 → 新增不删已有', async () => {
    const { admin, task, a1 } = await setup('PUBLISHED')
    const a2 = await createUser({ role: 'user' })
    const res = await request(app).patch(PATCH(task.id)).set(auth(admin.id)).send({ assigneeIds: [a2.id] })
    expect(res.status).toBe(200)
    const rows = await prisma.standardExecutionTaskAssignee.findMany({ where: { taskId: task.id } })
    const ids = rows.map((r) => r.assigneeId)
    expect(ids).toContain(a1.id)  // 已有保留
    expect(ids).toContain(a2.id)  // 新增
    expect(rows.length).toBe(2)
  })

  it('COMPLETED 任务编辑 → 409', async () => {
    const { admin, task } = await setup('COMPLETED')
    const res = await request(app).patch(PATCH(task.id)).set(auth(admin.id)).send({ title: 'x' })
    expect(res.status).toBe(409)
  })

  it('DRAFT 仍可改任务类型(全字段)', async () => {
    const { admin, task } = await setup('DRAFT')
    const res = await request(app).patch(PATCH(task.id)).set(auth(admin.id)).send({ taskType: 'INSPECTION_FILL' })
    expect(res.status).toBe(200)
    const t = await prisma.standardExecutionTask.findUnique({ where: { id: task.id } })
    expect(t?.taskType).toBe('INSPECTION_FILL')
  })
})
