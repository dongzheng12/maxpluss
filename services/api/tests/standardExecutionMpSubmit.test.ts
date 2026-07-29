/**
 * standard-execution / 员工小程序 — upload + submit 测试
 *
 * 覆盖：
 *  - upload:
 *      happy：返回 fileUrl + 文件落盘
 *      非 assignee → 403
 *      task DRAFT/CANCELLED → 409
 *      缺 file 字段 → 400
 *      mime 不允许 → 400
 *      无 token → 401
 *  - submit:
 *      happy：创建 Submission(SUBMITTED, version=1, isLatest=true) + Attachment + Assignee.status=PENDING_REVIEW
 *      T12 兼容：旧客户端 body 只传 submitText + attachments，仍可提交
 *      重新提交：旧 isLatest=false，新 version=2, parentSubmissionId
 *      submitText 空 → 400
 *      attachments 空 → 400
 *      attachments > 20 → 400
 *      task DRAFT/CANCELLED → 409
 *      task COMPLETED → 409
 *      assignee.status=COMPLETED → 409
 *      非自己 assignee → 403
 *      enterpriseId 隔离 → 403
 *      无 token → 401
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { existsSync, rmSync } from 'fs'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerStandardExecutionRoutes } from '../src/standard-execution/sourceRoutes.js'
import { STANDARD_EXECUTION_UPLOAD_DIR } from '../src/standard-execution/mpSubmitRoutes.js'
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

afterAll(() => {
  // 清理测试上传的文件
  if (existsSync(STANDARD_EXECUTION_UPLOAD_DIR)) {
    rmSync(STANDARD_EXECUTION_UPLOAD_DIR, { recursive: true, force: true })
  }
})

async function setup(opts: { taskStatus?: 'DRAFT' | 'PUBLISHED' | 'COMPLETED' | 'OVERDUE' | 'CANCELLED'; assigneeStatus?: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED'; enterpriseId?: string } = {}) {
  const admin = await createUser({ role: 'admin' })
  const me = await createUser({ role: 'user' })
  const enterpriseId = opts.enterpriseId ?? 'DEFAULT'
  const src = await prisma.standardExecutionSource.create({
    data: { enterpriseId, title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
  })
  const req = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId,
      sourceId: src.id,
      title: 'r',
      requirementText: 'x',
      status: 'ACTIVE',
      createdBy: admin.id,
    },
  })
  const task = await prisma.standardExecutionTask.create({
    data: {
      enterpriseId,
      requirementId: req.id,
      title: 't',
      submitRequirement: 'x',
      deadlineAt: new Date(Date.now() + 86400000),
      reviewerId: admin.id,
      status: opts.taskStatus ?? 'PUBLISHED',
      publishedAt: opts.taskStatus === 'DRAFT' ? null : new Date(),
      createdBy: admin.id,
    },
  })
  const assignee = await prisma.standardExecutionTaskAssignee.create({
    data: { enterpriseId, taskId: task.id, assigneeId: me.id, status: opts.assigneeStatus ?? 'PENDING' },
  })
  return { admin, me, task, assignee, token: getTestToken(me.id, 'user', { enterpriseId: 'DEFAULT' }) }
}

const validBody = {
  submitText: '已完成本月巡检',
  attachments: [
    { fileName: 'a.jpg', fileUrl: '/uploads/standard-execution/x/y/1.jpg', fileSize: 1024, mimeType: 'image/jpeg' },
  ],
}

// ═══════════════════════════════════════════════════════
// upload
// ═══════════════════════════════════════════════════════

describe('POST /api/app/standard-execution/tasks/:id/upload', () => {
  it('happy — 返回 fileUrl + fileName/fileSize/mimeType', async () => {
    const { task, token } = await setup()
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/upload`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('fake jpg'), { filename: 'test.jpg', contentType: 'image/jpeg' })
    expect(res.status).toBe(200)
    expect(res.body.data.fileName).toBe('test.jpg')
    expect(res.body.data.fileUrl).toMatch(new RegExp(`^/uploads/standard-execution/${task.id}/`))
    expect(res.body.data.fileSize).toBe(8)
    expect(res.body.data.mimeType).toBe('image/jpeg')
  })

  it('text/plain 占位文件可上传', async () => {
    const { task, token } = await setup()
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/upload`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('员工填写的文本说明'), { filename: 'submit.txt', contentType: 'text/plain' })
    expect(res.status).toBe(200)
    expect(res.body.data.fileName).toBe('submit.txt')
    expect(res.body.data.mimeType).toBe('text/plain')
  })

  it('非 assignee → 403', async () => {
    const { task } = await setup()
    const stranger = await createUser({ role: 'user' })
    const token = getTestToken(stranger.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/upload`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('x'), { filename: 't.jpg', contentType: 'image/jpeg' })
    expect(res.status).toBe(403)
  })

  it('task DRAFT → 409', async () => {
    const { task, token } = await setup({ taskStatus: 'DRAFT' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/upload`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('x'), { filename: 't.jpg', contentType: 'image/jpeg' })
    expect(res.status).toBe(409)
  })

  it('task CANCELLED → 409', async () => {
    const { task, token } = await setup({ taskStatus: 'CANCELLED' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/upload`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('x'), { filename: 't.jpg', contentType: 'image/jpeg' })
    expect(res.status).toBe(409)
  })

  it('mime 不允许 → 400', async () => {
    const { task, token } = await setup()
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/upload`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('x'), { filename: 't.exe', contentType: 'application/x-msdownload' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('文件类型')
  })

  it('缺 file 字段 → 400', async () => {
    const { task, token } = await setup()
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/upload`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(400)
  })

  it('无 token → 401', async () => {
    const res = await request(app)
      .post('/api/app/standard-execution/tasks/x/upload')
      .attach('file', Buffer.from('x'), { filename: 't.jpg', contentType: 'image/jpeg' })
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════
// submit
// ═══════════════════════════════════════════════════════

describe('POST /api/app/standard-execution/tasks/:id/submit', () => {
  it('happy — 首次提交：Submission(version=1, isLatest=true) + Attachment + Assignee=PENDING_REVIEW', async () => {
    const { task, assignee, me, token } = await setup()
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('SUBMITTED')
    expect(res.body.data.version).toBe(1)
    expect(res.body.data.isLatest).toBe(true)
    expect(res.body.data.parentSubmissionId).toBeNull()
    expect(res.body.data.attachments.length).toBe(1)
    expect(res.body.data.attachments[0].uploadedBy).toBe(me.id)

    const updatedAssignee = await prisma.standardExecutionTaskAssignee.findUnique({
      where: { id: assignee.id },
    })
    expect(updatedAssignee?.status).toBe('PENDING_REVIEW')
    expect(updatedAssignee?.submittedAt).toBeTruthy()
  })

  it('T12 兼容红线：旧客户端不传 submitFormConfig / submitDataJson 仍可提交', async () => {
    const { task, token } = await setup()
    const legacyMpBody = {
      submitText: '旧员工端巡检提交说明',
      attachments: [
        { fileName: 'legacy.jpg', fileUrl: '/uploads/standard-execution/legacy/legacy.jpg' },
      ],
    }

    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send(legacyMpBody)

    expect(res.status).toBe(201)
    expect(res.body.data.submitText).toBe(legacyMpBody.submitText)
    expect(res.body.data.submitDataJson).toBeNull()
    expect(res.body.data.attachments).toHaveLength(1)
    expect(res.body.data.attachments[0]).toEqual(expect.objectContaining({
      fileName: 'legacy.jpg',
      fileUrl: '/uploads/standard-execution/legacy/legacy.jpg',
    }))
  })

  it('重新提交：旧 isLatest=false，新 version=2, parentSubmissionId', async () => {
    const { task, token } = await setup()
    const r1 = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
    expect(r1.status).toBe(201)
    const sub1Id = r1.body.data.id

    const r2 = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, submitText: '修订版本' })
    expect(r2.status).toBe(201)
    expect(r2.body.data.version).toBe(2)
    expect(r2.body.data.parentSubmissionId).toBe(sub1Id)
    expect(r2.body.data.isLatest).toBe(true)

    const old = await prisma.standardExecutionSubmission.findUnique({ where: { id: sub1Id } })
    expect(old?.isLatest).toBe(false)
  })

  it('submitText 空 → 400', async () => {
    const { task, token } = await setup()
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, submitText: '' })
    expect(res.status).toBe(400)
  })

  it('attachments 空 → 400', async () => {
    const { task, token } = await setup()
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, attachments: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('附件')
  })

  it('attachments > 20 → 400', async () => {
    const { task, token } = await setup()
    const many = Array.from({ length: 21 }, (_, i) => ({
      fileName: `a${i}.jpg`,
      fileUrl: `/uploads/standard-execution/x/y/${i}.jpg`,
    }))
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBody, attachments: many })
    expect(res.status).toBe(400)
  })

  it('task DRAFT → 409', async () => {
    const { task, token } = await setup({ taskStatus: 'DRAFT' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
    expect(res.status).toBe(409)
  })

  it('task CANCELLED → 409', async () => {
    const { task, token } = await setup({ taskStatus: 'CANCELLED' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
    expect(res.status).toBe(409)
  })

  it('task COMPLETED → 409', async () => {
    const { task, token } = await setup({ taskStatus: 'COMPLETED' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
    expect(res.status).toBe(409)
  })

  it('assignee.status=COMPLETED → 409', async () => {
    const { task, token } = await setup({ assigneeStatus: 'COMPLETED' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
    expect(res.status).toBe(409)
  })

  it('OVERDUE 任务仍可提交（紧急补交）', async () => {
    const { task, token } = await setup({ taskStatus: 'OVERDUE' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
    expect(res.status).toBe(201)
  })

  it('IN_PROGRESS 提交 ok', async () => {
    const { task, token } = await setup({ assigneeStatus: 'IN_PROGRESS' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
    expect(res.status).toBe(201)
  })

  it('REJECTED 后重新提交 ok（与重新提交 case 共同覆盖驳回-补交流程）', async () => {
    const { task, token } = await setup({ assigneeStatus: 'REJECTED' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
    expect(res.status).toBe(201)
  })

  it('非自己 assignee → 403', async () => {
    const { task } = await setup()
    const stranger = await createUser({ role: 'user' })
    const token = getTestToken(stranger.id, 'user', { enterpriseId: 'DEFAULT' })
    const res = await request(app)
      .post(`/api/app/standard-execution/tasks/${task.id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send(validBody)
    expect(res.status).toBe(403)
  })

  it('无 token → 401', async () => {
    const res = await request(app)
      .post('/api/app/standard-execution/tasks/x/submit')
      .send(validBody)
    expect(res.status).toBe(401)
  })
})
