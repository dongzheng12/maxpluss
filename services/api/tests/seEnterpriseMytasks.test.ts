/**
 * 企业版 PC 端「我的任务」提交 + 上传 — 端到端测试
 *
 * 覆盖：
 *  - submit: happy（201 + isLatest + assignee→PENDING_REVIEW）/ 重新提交 version+1 / 校验 / 权限
 *  - upload: 图片上传 200 + fileUrl / 非 assignee 403
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerEnterpriseMytasksRoutes } from '../src/standard-execution/enterpriseMytasksRoutes.js'
import { registerStandardExecutionRoutes } from '../src/standard-execution/sourceRoutes.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionRoutes(app)
  registerEnterpriseMytasksRoutes(app)
})

let employeeId: string
let employeeToken: string
let reviewerToken: string
let plainToken: string
let taskId: string

beforeEach(async () => {
  await cleanStandardExecutionData()
  await prisma.enterprise.upsert({
    where: { id: 'ENT_MT' },
    update: { name: 'ENT_MT', status: 'ACTIVE' },
    create: { id: 'ENT_MT', name: 'ENT_MT', code: 'ENT_MT', status: 'ACTIVE' },
  })

  const emp = await createUser({ role: 'user' })
  await prisma.appUser.update({ where: { id: emp.id }, data: { enterpriseId: 'ENT_MT', enterpriseRole: 'EMPLOYEE' } })
  employeeId = emp.id
  employeeToken = getTestToken(emp.id, 'user')

  const reviewer = await createUser({ role: 'user' })
  await prisma.appUser.update({ where: { id: reviewer.id }, data: { enterpriseId: 'ENT_MT', enterpriseRole: 'REVIEWER' } })
  reviewerToken = getTestToken(reviewer.id, 'user', { enterpriseId: 'ENT_MT', enterpriseRole: 'REVIEWER' })

  const plain = await createUser({ role: 'user' })
  plainToken = getTestToken(plain.id, 'user')

  const src = await prisma.standardExecutionSource.create({
    data: { enterpriseId: 'ENT_MT', title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: emp.id },
  })
  const req = await prisma.standardExecutionRequirement.create({
    data: { enterpriseId: 'ENT_MT', sourceId: src.id, title: 'r', requirementText: 'x', status: 'ACTIVE', createdBy: emp.id },
  })
  const task = await prisma.standardExecutionTask.create({
    data: { enterpriseId: 'ENT_MT', requirementId: req.id, title: 't', submitRequirement: 'sr', deadlineAt: new Date(Date.now() + 86400000), reviewerId: reviewer.id, status: 'PUBLISHED', createdBy: emp.id },
  })
  taskId = task.id
  await prisma.standardExecutionTaskAssignee.create({
    data: { enterpriseId: 'ENT_MT', taskId: task.id, assigneeId: emp.id, status: 'PENDING' },
  })
})

describe('POST /api/enterprise/my-tasks/:taskId/submit', () => {
  const body = { submitText: '已完成巡检', attachments: [{ fileName: 'a.png', fileUrl: '/uploads/x/a.png' }] }

  it('happy：提交 → 201 + isLatest + assignee=PENDING_REVIEW + reviewer 可在企业审核台看到', async () => {
    const res = await request(app)
      .post(`/api/enterprise/my-tasks/${taskId}/submit`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send(body)
    expect(res.status).toBe(201)
    expect(res.body.data.version).toBe(1)
    expect(res.body.data.isLatest).toBe(true)
    expect(res.body.data.attachments.length).toBe(1)
    const a = await prisma.standardExecutionTaskAssignee.findFirst({ where: { taskId, assigneeId: employeeId } })
    expect(a?.status).toBe('PENDING_REVIEW')

    const reviewRes = await request(app)
      .get('/api/enterprise/standard-execution/reviews')
      .set('Authorization', `Bearer ${reviewerToken}`)
    expect(reviewRes.status).toBe(200)
    expect(reviewRes.body.total).toBe(1)
    expect(reviewRes.body.data[0].task.id).toBe(taskId)
    expect(reviewRes.body.data[0].submission.status).toBe('SUBMITTED')
    expect(reviewRes.body.data[0].assignee.status).toBe('PENDING_REVIEW')
  })

  it('重新提交：version+1，旧 isLatest=false', async () => {
    await request(app).post(`/api/enterprise/my-tasks/${taskId}/submit`).set('Authorization', `Bearer ${employeeToken}`).send(body)
    const res2 = await request(app).post(`/api/enterprise/my-tasks/${taskId}/submit`).set('Authorization', `Bearer ${employeeToken}`).send({ ...body, submitText: '重新提交' })
    expect(res2.status).toBe(201)
    expect(res2.body.data.version).toBe(2)
    const all = await prisma.standardExecutionSubmission.findMany({ where: { taskId }, orderBy: { version: 'asc' } })
    expect(all.length).toBe(2)
    expect(all[0]?.isLatest).toBe(false)
    expect(all[1]?.isLatest).toBe(true)
  })

  it('submitText 空 → 400', async () => {
    const res = await request(app).post(`/api/enterprise/my-tasks/${taskId}/submit`).set('Authorization', `Bearer ${employeeToken}`).send({ submitText: '', attachments: body.attachments })
    expect(res.status).toBe(400)
  })

  it('无附件 → 400', async () => {
    const res = await request(app).post(`/api/enterprise/my-tasks/${taskId}/submit`).set('Authorization', `Bearer ${employeeToken}`).send({ submitText: 'x', attachments: [] })
    expect(res.status).toBe(400)
  })

  it('非企业成员 → 403', async () => {
    const res = await request(app).post(`/api/enterprise/my-tasks/${taskId}/submit`).set('Authorization', `Bearer ${plainToken}`).send(body)
    expect(res.status).toBe(403)
  })

  it('未登录 → 401', async () => {
    const res = await request(app).post(`/api/enterprise/my-tasks/${taskId}/submit`).send(body)
    expect(res.status).toBe(401)
  })
})

describe('POST /api/enterprise/my-tasks/:taskId/upload', () => {
  it('上传图片 → 200 + fileUrl', async () => {
    const res = await request(app)
      .post(`/api/enterprise/my-tasks/${taskId}/upload`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'photo.png', contentType: 'image/png' })
    expect(res.status).toBe(200)
    expect(res.body.data.fileUrl).toContain(`/uploads/standard-execution/${taskId}/`)
    expect(res.body.data.fileName).toBe('photo.png')
  })

  it('非企业成员上传 → 403', async () => {
    const res = await request(app)
      .post(`/api/enterprise/my-tasks/${taskId}/upload`)
      .set('Authorization', `Bearer ${plainToken}`)
      .attach('file', Buffer.from([0x89, 0x50]), { filename: 'x.png', contentType: 'image/png' })
    expect(res.status).toBe(403)
  })
})
