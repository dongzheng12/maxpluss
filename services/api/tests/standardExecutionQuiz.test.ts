/**
 * standard-execution / 员工小程序端 — 在线答题（SEQuizResult）测试
 *
 * 端点（registerStandardExecutionMpTaskRoutes，requireAuth）：
 *   GET  /api/app/standard-execution/tasks/:id/quiz         — 拉题（answer/exp 已剥除，防作弊）
 *   POST /api/app/standard-execution/tasks/:id/quiz/submit  — 提交，计算得分 + 写 SEQuizResult
 *
 * 覆盖：
 *  - GET  返回题目，answer / exp 字段已剥除
 *  - GET  非指派用户 → 403
 *  - GET  任务未关联题库 → 404
 *  - POST 全对 → score=满分 + passed=true + correctCount/wrongCount + DB 写入
 *  - POST 半对（<60%）→ passed=false
 *  - POST 提交后返回 correctAnswers（含正确答案 + 解析）
 *  - POST 非指派用户 → 403
 *  - POST 参数格式错误 → 400
 *  - 无 token → 401
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerStandardExecutionMpTaskRoutes } from '../src/standard-execution/mpTaskRoutes.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionMpTaskRoutes(app)
})

beforeEach(async () => {
  // 完整 FK 拓扑序：CI 并发下其他文件残留的 submission/record/reviewLog 会撞 task FK，必须全删
  await cleanStandardExecutionData()
})

// 两题各 50 分，满分 100
const sampleQuestions = [
  { id: 'q1', type: 'single', text: '1+1=?', opts: ['1', '2', '3'], answer: [1], score: 50, exp: '等于 2' },
  { id: 'q2', type: 'multi', text: '选出偶数', opts: ['1', '2', '4', '5'], answer: [1, 2], score: 50, exp: '2 和 4' },
]

/** 造：题库 + 关联题库的 PUBLISHED 培训任务 + 把 me 指派进去 */
async function setupQuizTask(meId: string, adminId: string, enterpriseId = 'DEFAULT') {
  const bank = await prisma.sEQuestionBank.create({
    data: { enterpriseId, title: '安全培训', questions: sampleQuestions as never, createdBy: adminId },
  })
  const src = await prisma.standardExecutionSource.create({
    data: { enterpriseId, title: '培训标准', sourceType: 'PRODUCT_STANDARD', createdBy: adminId },
  })
  const requirement = await prisma.standardExecutionRequirement.create({
    data: { enterpriseId, sourceId: src.id, title: '培训要求项', requirementText: '应完成培训考核', status: 'ACTIVE', createdBy: adminId },
  })
  const task = await prisma.standardExecutionTask.create({
    data: {
      enterpriseId,
      requirementId: requirement.id,
      title: '培训任务',
      taskType: 'TRAINING',
      quizBankId: bank.id,
      deadlineAt: new Date(Date.now() + 86400000),
      reviewerId: adminId,
      createdBy: adminId,
      status: 'PUBLISHED',
    },
  })
  await prisma.standardExecutionTaskAssignee.create({
    data: { enterpriseId, taskId: task.id, assigneeId: meId, status: 'IN_PROGRESS' },
  })
  return { bank, task }
}

const QUIZ = (id: string) => `/api/app/standard-execution/tasks/${id}/quiz`
const SUBMIT = (id: string) => `/api/app/standard-execution/tasks/${id}/quiz/submit`

describe('GET /api/app/standard-execution/tasks/:id/quiz — 拉题', () => {
  it('返回题目，answer / exp 已剥除', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const { task } = await setupQuizTask(me.id, admin.id)
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })

    const res = await request(app).get(QUIZ(task.id)).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.questions.length).toBe(2)
    for (const q of res.body.questions) {
      expect(q).toHaveProperty('opts')
      expect(q).toHaveProperty('text')
      expect(q).not.toHaveProperty('answer')
      expect(q).not.toHaveProperty('exp')
    }
  })

  it('非指派用户 → 403', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const other = await createUser({ role: 'user' })
    const { task } = await setupQuizTask(me.id, admin.id)
    const token = getTestToken(other.id, 'user', { enterpriseId: 'DEFAULT' })

    const res = await request(app).get(QUIZ(task.id)).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('任务未关联题库 → 404', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const task = await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'DEFAULT',
        title: '无题库任务',
        taskType: 'TRAINING',
        deadlineAt: new Date(Date.now() + 86400000),
        reviewerId: admin.id,
        createdBy: admin.id,
        status: 'PUBLISHED',
      },
    })
    await prisma.standardExecutionTaskAssignee.create({
      data: { enterpriseId: 'DEFAULT', taskId: task.id, assigneeId: me.id, status: 'IN_PROGRESS' },
    })
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app).get(QUIZ(task.id)).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })

  it('无 token → 401', async () => {
    const res = await request(app).get(QUIZ('any'))
    expect(res.status).toBe(401)
  })
})

describe('POST /api/app/standard-execution/tasks/:id/quiz/submit — 提交', () => {
  it('全对 → 满分 + passed=true + DB 写入 SEQuizResult', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const { task, bank } = await setupQuizTask(me.id, admin.id)
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })

    const res = await request(app)
      .post(SUBMIT(task.id))
      .set('Authorization', `Bearer ${token}`)
      .send({
        answers: [
          { questionId: 'q1', selected: [1] },
          { questionId: 'q2', selected: [1, 2] },
        ],
        timeUsedSec: 42,
      })
    expect(res.status).toBe(200)
    expect(res.body.score).toBe(100)
    expect(res.body.totalScore).toBe(100)
    expect(res.body.correctCount).toBe(2)
    expect(res.body.wrongCount).toBe(0)
    expect(res.body.passed).toBe(true)
    // 提交后下发正确答案 + 解析
    expect(Array.isArray(res.body.correctAnswers)).toBe(true)
    expect(res.body.correctAnswers[0]).toHaveProperty('answer')

    const rows = await prisma.sEQuizResult.findMany({ where: { taskId: task.id, assigneeId: me.id } })
    expect(rows.length).toBe(1)
    expect(rows[0].score).toBe(100)
    expect(rows[0].quizBankId).toBe(bank.id)
    expect(rows[0].timeUsedSec).toBe(42)

    // 答题通过 → assignee 直接 COMPLETED + submittedAt + reviewedAt（跳过人工审核）
    const a = await prisma.standardExecutionTaskAssignee.findFirst({ where: { taskId: task.id, assigneeId: me.id } })
    expect(a?.status).toBe('COMPLETED')
    expect(a?.submittedAt).not.toBeNull()
    expect(a?.reviewedAt).not.toBeNull()

    // 答题通过生成执行记录(Record，进执行记录池) + task 完成
    const recs = await prisma.standardExecutionRecord.findMany({ where: { taskId: task.id } })
    expect(recs.length).toBe(1)
    expect(recs[0].createdFrom).toBe('QUIZ_PASS')
    expect(recs[0].status).toBe('VALID')
    const t = await prisma.standardExecutionTask.findUnique({ where: { id: task.id } })
    expect(t?.status).toBe('COMPLETED')
  })

  it('半对（50% < 60%）→ passed=false', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const { task } = await setupQuizTask(me.id, admin.id)
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })

    const res = await request(app)
      .post(SUBMIT(task.id))
      .set('Authorization', `Bearer ${token}`)
      .send({
        answers: [
          { questionId: 'q1', selected: [1] }, // 对
          { questionId: 'q2', selected: [0] }, // 错
        ],
        timeUsedSec: 20,
      })
    expect(res.status).toBe(200)
    expect(res.body.score).toBe(50)
    expect(res.body.correctCount).toBe(1)
    expect(res.body.wrongCount).toBe(1)
    expect(res.body.passed).toBe(false)

    // 不及格 → assignee 状态不变（仍 IN_PROGRESS），可重新答题
    const a = await prisma.standardExecutionTaskAssignee.findFirst({ where: { taskId: task.id, assigneeId: me.id } })
    expect(a?.status).toBe('IN_PROGRESS')
  })

  it('非指派用户 → 403', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const other = await createUser({ role: 'user' })
    const { task } = await setupQuizTask(me.id, admin.id)
    const token = getTestToken(other.id, 'user', { enterpriseId: 'DEFAULT' })

    const res = await request(app)
      .post(SUBMIT(task.id))
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: [], timeUsedSec: 1 })
    expect(res.status).toBe(403)
  })

  it('参数格式错误（answers 非数组）→ 400', async () => {
    const admin = await createUser({ role: 'admin' })
    const me = await createUser({ role: 'user' })
    const { task } = await setupQuizTask(me.id, admin.id)
    const token = getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' })

    const res = await request(app)
      .post(SUBMIT(task.id))
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: 'oops', timeUsedSec: 1 })
    expect(res.status).toBe(400)
  })

  it('无 token → 401', async () => {
    const res = await request(app).post(SUBMIT('any')).send({ answers: [], timeUsedSec: 1 })
    expect(res.status).toBe(401)
  })
})
