import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { existsSync } from 'node:fs'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerStandardExecutionRoutes } from '../src/standard-execution/sourceRoutes.js'
import { createUser, getTestToken } from './factory.js'
import { packageArtifactPath } from '../src/standard-execution/packageArtifacts.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionRoutes(app)
})

beforeEach(async () => {
  await cleanStandardExecutionData()
})

async function adminCtx() {
  const admin = await createUser({ role: 'admin' })
  return { admin, token: getTestToken(admin.id, 'admin') }
}

async function makeRecord(adminId: string) {
  const user = await createUser({ role: 'user' })
  const source = await prisma.standardExecutionSource.create({
    data: { enterpriseId: 'DEFAULT', title: 'PDF/Word 来源', sourceType: 'PRODUCT_STANDARD', sourceNo: 'GB-T6', createdBy: adminId },
  })
  const requirement = await prisma.standardExecutionRequirement.create({
    data: { enterpriseId: 'DEFAULT', sourceId: source.id, title: '格式执行要求', requirementText: '应保存执行记录。', status: 'ACTIVE', createdBy: adminId },
  })
  const task = await prisma.standardExecutionTask.create({
    data: { enterpriseId: 'DEFAULT', requirementId: requirement.id, title: '格式任务', submitRequirement: '提交记录', deadlineAt: new Date(Date.now() + 86400000), reviewerId: adminId, status: 'PUBLISHED', createdBy: adminId },
  })
  const submission = await prisma.standardExecutionSubmission.create({
    data: { enterpriseId: 'DEFAULT', taskId: task.id, assigneeId: user.id, submitText: '已完成记录整理。', status: 'APPROVED', version: 1, isLatest: true },
  })
  const record = await prisma.standardExecutionRecord.create({
    data: { enterpriseId: 'DEFAULT', sourceId: source.id, requirementId: requirement.id, taskId: task.id, submissionId: submission.id, assigneeId: user.id, title: '格式记录', status: 'VALID' },
  })
  return record
}

async function createAndGenerate(format: 'ZIP' | 'PDF' | 'DOCX') {
  const { admin, token } = await adminCtx()
  const record = await makeRecord(admin.id)
  const create = await request(app)
    .post('/api/admin/standard-execution/packages')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: `${format} 材料包`, packageScene: 'INTERNAL_CHECK', format, recordIds: [record.id] })
  expect(create.status).toBe(201)

  const generated = await request(app)
    .post(`/api/admin/standard-execution/packages/${create.body.data.id}/generate`)
    .set('Authorization', `Bearer ${token}`)
    .send({ format })
  expect(generated.status).toBe(200)
  return { token, pkg: generated.body.data }
}

describe('Package formats', () => {
  it.each(['ZIP', 'PDF', 'DOCX'] as const)('legacy %s input is normalized to previewable FOLDER output', async (legacyFormat) => {
    const { token, pkg } = await createAndGenerate(legacyFormat)
    expect(pkg.format).toBe('FOLDER')
    expect(pkg.fileUrl).toMatch(/\/README\.txt$/)
    expect(existsSync(packageArtifactPath(pkg.id, 'README.txt')!)).toBe(true)
    expect(existsSync(packageArtifactPath(pkg.id, '主报告.docx')!)).toBe(true)
    expect(existsSync(packageArtifactPath(pkg.id, '证据附件索引.xlsx')!)).toBe(true)

    const download = await request(app)
      .get(`/api/admin/standard-execution/packages/${pkg.id}/download`)
      .set('Authorization', `Bearer ${token}`)
    expect(download.status).toBe(200)
    expect(download.headers['content-type']).toContain('text/plain')
  })
})
