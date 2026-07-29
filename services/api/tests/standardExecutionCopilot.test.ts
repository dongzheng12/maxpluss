import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerStandardExecutionReviewRoutes } from '../src/standard-execution/reviewRoutes.js'
import seChatRouter, { resetSEContextCache } from '../src/routes/seChat.js'
import { cleanStandardExecutionData } from './seClean.js'
import { cleanAll, createUser, getTestToken } from './factory.js'

const ORIGINAL_SE_AI_MOCK = process.env.SE_AI_MOCK

const app = express()
app.use(express.json())
registerStandardExecutionReviewRoutes(app)
app.use('/api/app/se-chat', seChatRouter)

beforeEach(async () => {
  process.env.SE_AI_MOCK = '1'
  resetSEContextCache()
  await cleanStandardExecutionData()
  await cleanAll()
  await prisma.enterprise.upsert({
    where: { id: 'ENT_COPILOT_A' },
    update: { name: 'Copilot 企业', status: 'ACTIVE' },
    create: { id: 'ENT_COPILOT_A', name: 'Copilot 企业', code: 'ENT_COPILOT_A', status: 'ACTIVE' },
  })
})

afterAll(() => {
  if (ORIGINAL_SE_AI_MOCK === undefined) delete process.env.SE_AI_MOCK
  else process.env.SE_AI_MOCK = ORIGINAL_SE_AI_MOCK
})

async function enterpriseUser(enterpriseRole: string) {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: user.id },
    data: { enterpriseId: 'ENT_COPILOT_A', enterpriseRole, name: `copilot-${enterpriseRole}` },
  })
  return {
    user,
    token: getTestToken(user.id, 'user', { enterpriseId: 'ENT_COPILOT_A', enterpriseRole }),
  }
}

async function seedReviewSubmission(reviewerId: string, assigneeId: string, submitText = '已完成') {
  const source = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId: 'ENT_COPILOT_A',
      title: '仓储温控规范',
      sourceNo: 'TEMP-01',
      sourceType: 'INTERNAL_POLICY',
      createdBy: reviewerId,
    },
  })
  const requirement = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId: 'ENT_COPILOT_A',
      sourceId: source.id,
      clauseNo: '4.2',
      title: '仓储温控记录',
      requirementText: '每日留存仓储温控记录和现场照片。',
      requiredMaterials: ['温控记录表', '现场照片'],
      status: 'ACTIVE',
      createdBy: reviewerId,
    },
  })
  const task = await prisma.standardExecutionTask.create({
    data: {
      enterpriseId: 'ENT_COPILOT_A',
      requirementId: requirement.id,
      title: '每日温控检查',
      submitRequirement: '提交温控记录表和现场照片',
      status: 'PUBLISHED',
      reviewerId,
      createdBy: reviewerId,
    },
  })
  await prisma.standardExecutionTaskAssignee.create({
    data: {
      enterpriseId: 'ENT_COPILOT_A',
      taskId: task.id,
      assigneeId,
      reviewerId,
      status: 'PENDING_REVIEW',
      submittedAt: new Date(),
    },
  })
  const submission = await prisma.standardExecutionSubmission.create({
    data: {
      enterpriseId: 'ENT_COPILOT_A',
      taskId: task.id,
      assigneeId,
      submitText,
      status: 'SUBMITTED',
      isLatest: true,
      version: 1,
      submittedAt: new Date(),
    },
  })
  return { source, requirement, task, submission }
}

async function seedCoveredRequirement(userId: string) {
  const source = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId: 'ENT_COPILOT_A',
      title: '培训规范',
      sourceNo: 'TRAIN-01',
      sourceType: 'INTERNAL_POLICY',
      createdBy: userId,
    },
  })
  const requirement = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId: 'ENT_COPILOT_A',
      sourceId: source.id,
      clauseNo: '5.1',
      title: '已覆盖培训记录',
      requirementText: '保存培训记录。',
      status: 'ACTIVE',
      createdBy: userId,
    },
  })
  const task = await prisma.standardExecutionTask.create({
    data: {
      enterpriseId: 'ENT_COPILOT_A',
      requirementId: requirement.id,
      title: '培训归档',
      status: 'COMPLETED',
      reviewerId: userId,
      createdBy: userId,
    },
  })
  const submission = await prisma.standardExecutionSubmission.create({
    data: {
      enterpriseId: 'ENT_COPILOT_A',
      taskId: task.id,
      assigneeId: userId,
      submitText: '培训记录已归档。',
      status: 'APPROVED',
      isLatest: true,
      version: 1,
      reviewerId: userId,
      reviewedAt: new Date(),
    },
  })
  await prisma.standardExecutionRecord.create({
    data: {
      enterpriseId: 'ENT_COPILOT_A',
      sourceId: source.id,
      requirementId: requirement.id,
      taskId: task.id,
      submissionId: submission.id,
      assigneeId: userId,
      title: '培训记录',
      status: 'VALID',
      recordDate: new Date(),
    },
  })
  return { source, requirement }
}

describe('SE Compliance Copilot', () => {
  it('审核 AI 分析能识别明显缺材料提交并给出驳回建议', async () => {
    const reviewer = await enterpriseUser('REVIEWER')
    const assignee = await enterpriseUser('EMPLOYEE')
    const seeded = await seedReviewSubmission(reviewer.user.id, assignee.user.id, '今日温控已处理。')

    const res = await request(app)
      .post(`/api/enterprise/standard-execution/reviews/${seeded.submission.id}/ai-analysis`)
      .set('Authorization', `Bearer ${reviewer.token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.recommendation).toBe('REJECT')
    expect(res.body.data.checks.completeness.missingMaterials).toContain('温控记录表')
    expect(res.body.data.suggestedComment).toContain('仅供参考，最终以人工审核为准')
    expect(JSON.stringify(res.body.data)).not.toContain('ENT_COPILOT_A')
  })

  it('非管理员且非任务审核人不能查看 AI 分析', async () => {
    const reviewer = await enterpriseUser('REVIEWER')
    const otherReviewer = await enterpriseUser('REVIEWER')
    const assignee = await enterpriseUser('EMPLOYEE')
    const seeded = await seedReviewSubmission(reviewer.user.id, assignee.user.id)

    const res = await request(app)
      .post(`/api/enterprise/standard-execution/reviews/${seeded.submission.id}/ai-analysis`)
      .set('Authorization', `Bearer ${otherReviewer.token}`)

    expect(res.status).toBe(403)
  })

  it('问小智能基于实时 DB 上下文回答未覆盖控制点', async () => {
    const manager = await enterpriseUser('MANAGER')
    const assignee = await enterpriseUser('EMPLOYEE')
    await seedReviewSubmission(manager.user.id, assignee.user.id)
    await seedCoveredRequirement(manager.user.id)

    const res = await request(app)
      .post('/api/app/se-chat/stream')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ message: '本企业未覆盖的控制点有哪些？' })

    expect(res.status).toBe(200)
    expect(res.text).toContain('仓储温控记录')
    expect(res.text).not.toContain('已覆盖培训记录')
    expect(res.text).toContain('仅供参考，最终以人工审核为准')
  })
})
