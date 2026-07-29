/**
 * standard-execution / Task 软删除 — DELETE + batch-delete
 *
 * 覆盖：
 *  - DRAFT 可删：200 + deletedAt 设置（非物理删）+ 列表/详情过滤
 *  - PUBLISHED 不可删：403
 *  - 删后历史 Record 仍存在（软删不级联删 record）
 *  - 非 admin → 403 / 不存在 id → 404
 *  - batch-delete：多 DRAFT 软删，非 DRAFT skipped
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
beforeAll(() => { registerStandardExecutionRoutes(app) })

beforeEach(async () => {
  await cleanStandardExecutionData()
})

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

async function setup(status: string = 'DRAFT') {
  const admin = await createUser({ role: 'admin' })
  const token = getTestToken(admin.id, 'admin')
  const reviewer = await createUser({ role: 'user' })
  const assignee = await createUser({ role: 'user' })
  const src = await prisma.standardExecutionSource.create({
    data: { enterpriseId: 'DEFAULT', title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
  })
  const req = await prisma.standardExecutionRequirement.create({
    data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'r', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id },
  })
  const task = await prisma.standardExecutionTask.create({
    data: {
      enterpriseId: 'DEFAULT', requirementId: req.id, title: 't',
      submitRequirement: 'x', deadlineAt: new Date(Date.now() + 86400000),
      reviewerId: reviewer.id, status, createdBy: admin.id,
      ...(status === 'PUBLISHED' ? { publishedAt: new Date() } : {}),
    },
  })
  return { admin, token, reviewer, assignee, src, req, task }
}

describe('DELETE /api/admin/standard-execution/tasks/:id（软删除）', () => {
  it('DRAFT 可删：200 + deletedAt 设置 + 列表/详情过滤', async () => {
    const { token, task } = await setup('DRAFT')
    const res = await request(app).delete(`/api/admin/standard-execution/tasks/${task.id}`).set(auth(token))
    expect(res.status).toBe(200)

    const db = await prisma.standardExecutionTask.findUnique({ where: { id: task.id } })
    expect(db).not.toBeNull()         // 行还在（软删非物理删）
    expect(db?.deletedAt).not.toBeNull()

    const list = await request(app).get('/api/admin/standard-execution/tasks').set(auth(token))
    expect(list.body.data.find((t: { id: string }) => t.id === task.id)).toBeUndefined()

    const detail = await request(app).get(`/api/admin/standard-execution/tasks/${task.id}`).set(auth(token))
    expect(detail.status).toBe(404)
  })

  it('PUBLISHED 不可删：403', async () => {
    const { token, task } = await setup('PUBLISHED')
    const res = await request(app).delete(`/api/admin/standard-execution/tasks/${task.id}`).set(auth(token))
    expect(res.status).toBe(403)
    const db = await prisma.standardExecutionTask.findUnique({ where: { id: task.id } })
    expect(db?.deletedAt).toBeNull()
  })

  it('删后历史 Record 仍存在', async () => {
    const { token, assignee, src, req, task } = await setup('DRAFT')
    const sub = await prisma.standardExecutionSubmission.create({
      data: { enterpriseId: 'DEFAULT', taskId: task.id, assigneeId: assignee.id, submitText: '完成', status: 'SUBMITTED', version: 1, isLatest: true, submittedAt: new Date() },
    })
    const rec = await prisma.standardExecutionRecord.create({
      data: { enterpriseId: 'DEFAULT', sourceId: src.id, requirementId: req.id, taskId: task.id, submissionId: sub.id, assigneeId: assignee.id, title: '历史记录' },
    })

    const res = await request(app).delete(`/api/admin/standard-execution/tasks/${task.id}`).set(auth(token))
    expect(res.status).toBe(200)

    const recDb = await prisma.standardExecutionRecord.findUnique({ where: { id: rec.id } })
    expect(recDb).not.toBeNull()
    expect(recDb?.status).toBe('VALID')
  })

  it('非 admin → 403', async () => {
    const { task } = await setup('DRAFT')
    const user = await createUser({ role: 'user' })
    const res = await request(app).delete(`/api/admin/standard-execution/tasks/${task.id}`).set(auth(getTestToken(user.id, 'user')))
    expect(res.status).toBe(403)
  })

  it('不存在 id → 404', async () => {
    const { token } = await setup('DRAFT')
    const res = await request(app).delete('/api/admin/standard-execution/tasks/nonexistent-id').set(auth(token))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/admin/standard-execution/tasks/batch-delete', () => {
  it('多个 DRAFT 软删，非 DRAFT skipped', async () => {
    const { token, admin, reviewer } = await setup('DRAFT')
    const src = await prisma.standardExecutionSource.create({ data: { enterpriseId: 'DEFAULT', title: 's2', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id } })
    const r2 = await prisma.standardExecutionRequirement.create({ data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: 'r2', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id } })
    await prisma.standardExecutionTask.create({ data: { enterpriseId: 'DEFAULT', requirementId: r2.id, title: 'd2', submitRequirement: 'x', deadlineAt: new Date(Date.now() + 86400000), reviewerId: reviewer.id, status: 'DRAFT', createdBy: admin.id } })
    const pub = await prisma.standardExecutionTask.create({ data: { enterpriseId: 'DEFAULT', requirementId: r2.id, title: 'p', submitRequirement: 'x', deadlineAt: new Date(Date.now() + 86400000), reviewerId: reviewer.id, status: 'PUBLISHED', publishedAt: new Date(), createdBy: admin.id } })

    const allDraft = await prisma.standardExecutionTask.findMany({ where: { status: 'DRAFT', deletedAt: null }, select: { id: true } })
    const ids = [...allDraft.map((t) => t.id), pub.id]
    const res = await request(app).post('/api/admin/standard-execution/tasks/batch-delete').set(auth(token)).send({ ids })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(allDraft.length) // DRAFT 全删
    expect(res.body.skipped).toBe(1)           // PUBLISHED skipped

    const pubDb = await prisma.standardExecutionTask.findUnique({ where: { id: pub.id } })
    expect(pubDb?.deletedAt).toBeNull()
  })
})
