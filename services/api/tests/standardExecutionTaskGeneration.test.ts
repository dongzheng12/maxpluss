/**
 * standard-execution / Task Generation Workbench (3C-lite)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerStandardExecutionRoutes } from '../src/standard-execution/sourceRoutes.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { AiCallFailedError } from '../src/standard-execution/aiClient.js'
import { clearTaskGenerationPreviewJobsForTests } from '../src/standard-execution/taskGenerationJobStore.js'
import { createUser, getTestToken } from './factory.js'

let currentAiCaller: (prompt: string) => Promise<string> = async () => '[]'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionRoutes(app)
  registerEnterpriseRoutes(app, (prompt) => currentAiCaller(prompt))
})

beforeEach(async () => {
  await cleanStandardExecutionData()
  clearTaskGenerationPreviewJobsForTests()
  currentAiCaller = async () => '[]'
  delete process.env.STANDARD_AI_CANDIDATE_V2
})

async function makeAdminToken() {
  const admin = await createUser({ role: 'admin' })
  return { admin, token: getTestToken(admin.id, 'admin') }
}

async function makeSource(userId: string, enterpriseId = 'DEFAULT') {
  return prisma.standardExecutionSource.create({
    data: {
      enterpriseId,
      title: '任务生成标准',
      sourceType: 'PRODUCT_STANDARD',
      sourceNo: 'TG-001',
      version: '2026',
      rawText: '1.1 应建立培训制度。\n1.2 必须留存整改记录。',
      createdBy: userId,
    },
  })
}

function draft(title: string, overrides: Record<string, unknown> = {}) {
  return {
    title,
    clauseNo: '1.1',
    requirementText: `${title} 的执行要求`,
    recommendedTaskType: 'TRAINING',
    executionDescription: `${title} 的执行描述`,
    submitRequirement: '提交执行证明',
    requiredMaterials: ['证明材料'],
    ...overrides,
  }
}

function taskCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-draft-1',
    draftId: 'draft-1',
    taskDraftId: 'task-draft-1',
    groupId: 'draft-1',
    title: '检查培训制度执行情况',
    description: '核查培训制度是否建立并执行。',
    submitRequirement: '提交培训制度和培训记录。',
    taskType: 'TRAINING',
    requiredMaterials: ['培训制度'],
    deadlineSuggestion: {
      mode: 'AFTER_APPROVAL_DAYS',
      daysAfterApproval: 7,
      fixedAt: null,
      label: '审核通过后 7 天内完成',
      reason: '默认周期',
    },
    basis: {
      sourceId: null,
      sourceTitle: '任务生成标准',
      clauseNo: '1.1',
      excerpt: '1.1 应建立培训制度。',
    },
    polishStatus: 'AI_POLISHED',
    warnings: [],
    ...overrides,
  }
}

async function makeEnterpriseUser(enterpriseId: string, enterpriseRole: 'ADMIN' | 'MANAGER' | 'REVIEWER' | 'EMPLOYEE') {
  await prisma.enterprise.upsert({
    where: { id: enterpriseId },
    update: {},
    create: { id: enterpriseId, name: enterpriseId, code: enterpriseId, status: 'ACTIVE' },
  })
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: user.id },
    data: { enterpriseId, enterpriseRole },
  })
  return user
}

async function waitForJob(path: string, token: string, jobId: string) {
  for (let i = 0; i < 20; i++) {
    const res = await request(app)
      .get(`${path}/${jobId}`)
      .set('Authorization', `Bearer ${token}`)
    if (res.body.data?.status === 'SUCCEEDED' || res.body.data?.status === 'FAILED') return res
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('job did not finish')
}

describe('POST /task-generation/preview/jobs', () => {
  it('admin happy: 202 创建内存级 job，轮询成功返回 preview result 且不写库', async () => {
    const { admin, token } = await makeAdminToken()
    const source = await makeSource(admin.id)

    const create = await request(app)
      .post('/api/admin/standard-execution/task-generation/preview/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: source.id, parseMode: 'RULE' })

    expect(create.status).toBe(202)
    expect(create.body.data).toMatchObject({
      status: expect.stringMatching(/QUEUED|RUNNING|SUCCEEDED/),
      volatile: true,
      result: null,
      error: null,
    })
    expect(create.body.data.id).toEqual(expect.any(String))

    const done = await waitForJob('/api/admin/standard-execution/task-generation/preview/jobs', token, create.body.data.id)
    expect(done.status).toBe(200)
    expect(done.body.data).toMatchObject({
      id: create.body.data.id,
      status: 'SUCCEEDED',
      error: null,
    })
    expect(done.body.data.result).toMatchObject({
      requestedMode: 'RULE',
      parseMode: 'RULE',
      degraded: false,
    })
    expect(done.body.data.result.drafts.length).toBeGreaterThan(0)
    expect(await prisma.standardExecutionRequirement.count()).toBe(0)
    expect(await prisma.standardExecutionTask.count()).toBe(0)
  })

  it('enterprise manager can poll own async preview job', async () => {
    const enterpriseId = 'ENT_TG_ASYNC'
    const manager = await makeEnterpriseUser(enterpriseId, 'MANAGER')
    const source = await makeSource(manager.id, enterpriseId)
    const token = getTestToken(manager.id, 'user')

    const create = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/preview/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: source.id, parseMode: 'RULE' })

    expect(create.status).toBe(202)
    const done = await waitForJob('/api/enterprise/standard-execution/task-generation/preview/jobs', token, create.body.data.id)
    expect(done.status).toBe(200)
    expect(done.body.data.status).toBe('SUCCEEDED')
    expect(done.body.data.result.source).toMatchObject({ id: source.id, title: source.title })
  })

  it('missing source becomes FAILED in job result instead of blocking 202 creation', async () => {
    const { token } = await makeAdminToken()

    const create = await request(app)
      .post('/api/admin/standard-execution/task-generation/preview/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: 'missing-source', parseMode: 'RULE' })

    expect(create.status).toBe(202)
    const done = await waitForJob('/api/admin/standard-execution/task-generation/preview/jobs', token, create.body.data.id)
    expect(done.status).toBe(200)
    expect(done.body.data).toMatchObject({
      status: 'FAILED',
      result: null,
      error: {
        status: 404,
        message: '标准来源不存在或无权访问',
      },
    })
  })

  it('admin can list own recent async preview jobs by source for page recovery', async () => {
    const { admin, token } = await makeAdminToken()
    const source = await makeSource(admin.id)

    const create = await request(app)
      .post('/api/admin/standard-execution/task-generation/preview/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: source.id, parseMode: 'RULE' })

    expect(create.status).toBe(202)
    await waitForJob('/api/admin/standard-execution/task-generation/preview/jobs', token, create.body.data.id)

    const list = await request(app)
      .get('/api/admin/standard-execution/task-generation/preview/jobs')
      .query({ sourceId: source.id, limit: 5 })
      .set('Authorization', `Bearer ${token}`)

    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0]).toMatchObject({
      id: create.body.data.id,
      status: 'SUCCEEDED',
      volatile: true,
      result: {
        source: { id: source.id, title: source.title },
        parseMode: 'RULE',
      },
    })
  })

  it('async preview job list is scoped to the current user', async () => {
    const first = await makeAdminToken()
    const second = await makeAdminToken()
    const source = await makeSource(first.admin.id)

    const create = await request(app)
      .post('/api/admin/standard-execution/task-generation/preview/jobs')
      .set('Authorization', `Bearer ${first.token}`)
      .send({ sourceId: source.id, parseMode: 'RULE' })

    expect(create.status).toBe(202)
    await waitForJob('/api/admin/standard-execution/task-generation/preview/jobs', first.token, create.body.data.id)

    const list = await request(app)
      .get('/api/admin/standard-execution/task-generation/preview/jobs')
      .query({ sourceId: source.id })
      .set('Authorization', `Bearer ${second.token}`)

    expect(list.status).toBe(200)
    expect(list.body.data).toEqual([])
  })
})

describe('POST /task-generation/card-rewrite', () => {
  it('enterprise happy: 单卡 AI 重写保留 id 并返回 taskDraft', async () => {
    const enterpriseId = 'ENT_TG_REWRITE'
    const manager = await makeEnterpriseUser(enterpriseId, 'MANAGER')
    const source = await makeSource(manager.id, enterpriseId)
    currentAiCaller = async () => JSON.stringify([{
      draftId: 'draft-1',
      title: '每月检查培训制度落实情况',
      description: '核查培训制度是否更新、员工是否完成培训，并记录异常。',
      submitRequirement: '提交制度文件、培训签到表和异常整改说明。',
      taskType: 'INSPECTION_FILL',
      requiredMaterials: ['制度文件', '培训签到表'],
      deadlineSuggestion: { mode: 'AFTER_APPROVAL_DAYS', daysAfterApproval: 30, label: '审核通过后 30 天内完成', reason: '按月度检查推荐' },
    }])

    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/card-rewrite')
      .set('Authorization', `Bearer ${getTestToken(manager.id, 'user')}`)
      .send({
        sourceId: source.id,
        card: taskCard({ basis: { sourceId: source.id, sourceTitle: source.title, clauseNo: '1.1', excerpt: '1.1 应建立培训制度。' } }),
        instruction: '更具体一点',
      })

    expect(res.status).toBe(200)
    expect(res.body.data.operation).toBe('CARD_REWRITE')
    expect(res.body.data.polish).toMatchObject({ status: 'SUCCEEDED', degraded: false })
    expect(res.body.data.taskCard).toMatchObject({
      id: 'task-draft-1',
      draftId: 'draft-1',
      taskDraftId: 'task-draft-1',
      groupId: 'draft-1',
      title: '每月检查培训制度落实情况',
      taskType: 'INSPECTION_FILL',
      polishStatus: 'AI_POLISHED',
    })
    expect(res.body.data.taskDraft).toMatchObject({
      taskDraftId: 'task-draft-1',
      groupId: 'draft-1',
      title: '每月检查培训制度落实情况',
    })
    expect(await prisma.standardExecutionRequirement.count()).toBe(0)
  })

  it('enterprise card rewrite LLM 失败 → 200 降级并保留原卡', async () => {
    const manager = await makeEnterpriseUser('ENT_TG_REWRITE_FAIL', 'MANAGER')
    currentAiCaller = async () => {
      throw new AiCallFailedError('LLM overloaded timeout')
    }

    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/card-rewrite')
      .set('Authorization', `Bearer ${getTestToken(manager.id, 'user')}`)
      .send({ card: taskCard() })

    expect(res.status).toBe(200)
    expect(res.body.data.polish).toMatchObject({
      status: 'DEGRADED',
      degraded: true,
      degradedReason: 'POLISH_AI_OVERLOADED',
    })
    expect(res.body.data.taskCard).toMatchObject({
      title: '检查培训制度执行情况',
      polishStatus: 'FALLBACK_ORIGINAL',
    })
    expect(res.body.data.taskCard.warnings.join('\n')).toContain('AI 重写失败')
  })

  it('enterprise card rewrite EMPLOYEE → 403', async () => {
    const employee = await makeEnterpriseUser('ENT_TG_REWRITE_EMP', 'EMPLOYEE')
    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/card-rewrite')
      .set('Authorization', `Bearer ${getTestToken(employee.id, 'user')}`)
      .send({ card: taskCard() })
    expect(res.status).toBe(403)
  })

  it('card rewrite 缺 card → 400', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/card-rewrite')
      .set('Authorization', `Bearer ${token}`)
      .send({ instruction: '重写' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('card 必填')
  })
})

describe('POST /task-generation/cards/repolish', () => {
  it('enterprise happy: 批量重润色保序返回 taskCards/taskDrafts', async () => {
    const manager = await makeEnterpriseUser('ENT_TG_REPOLISH', 'MANAGER')
    currentAiCaller = async () => JSON.stringify([
      {
        draftId: 'draft-1',
        title: '每月检查培训制度落实情况',
        description: '核查培训制度是否持续执行。',
        submitRequirement: '提交培训记录。',
        taskType: 'INSPECTION_FILL',
        requiredMaterials: ['培训记录'],
        deadlineSuggestion: { mode: 'AFTER_APPROVAL_DAYS', daysAfterApproval: 30, label: '审核通过后 30 天内完成', reason: '按月度推荐' },
      },
      {
        draftId: 'draft-2',
        title: '检查整改记录归档情况',
        description: '核查整改记录是否完整留存。',
        submitRequirement: '提交整改台账。',
        taskType: 'ARCHIVE_MATERIAL',
        requiredMaterials: ['整改台账'],
        deadlineSuggestion: { mode: 'AFTER_APPROVAL_DAYS', daysAfterApproval: 7, label: '审核通过后 7 天内完成', reason: '默认周期' },
      },
    ])

    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/cards/repolish')
      .set('Authorization', `Bearer ${getTestToken(manager.id, 'user')}`)
      .send({ cards: [taskCard(), taskCard({ id: 'task-draft-2', taskDraftId: 'task-draft-2', draftId: 'draft-2', groupId: 'draft-2' })] })

    expect(res.status).toBe(200)
    expect(res.body.data.operation).toBe('BATCH_REPOLISH')
    expect(res.body.data.taskCards.map((card: { id: string }) => card.id)).toEqual(['task-draft-1', 'task-draft-2'])
    expect(res.body.data.taskCards.map((card: { title: string }) => card.title)).toEqual(['每月检查培训制度落实情况', '检查整改记录归档情况'])
    expect(res.body.data.taskDrafts).toHaveLength(2)
  })

  it('enterprise batch repolish 部分缺失 → 200 部分降级并保序', async () => {
    const manager = await makeEnterpriseUser('ENT_TG_REPOLISH_PARTIAL', 'MANAGER')
    currentAiCaller = async () => JSON.stringify([{
      draftId: 'draft-1',
      title: '每月检查培训制度落实情况',
      description: '核查培训制度是否持续执行。',
      submitRequirement: '提交培训记录。',
      taskType: 'INSPECTION_FILL',
      requiredMaterials: ['培训记录'],
      deadlineSuggestion: { mode: 'AFTER_APPROVAL_DAYS', daysAfterApproval: 30, label: '审核通过后 30 天内完成', reason: '按月度推荐' },
    }])

    const second = taskCard({ id: 'task-draft-2', taskDraftId: 'task-draft-2', draftId: 'draft-2', groupId: 'draft-2', title: '原始整改记录任务' })
    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/cards/repolish')
      .set('Authorization', `Bearer ${getTestToken(manager.id, 'user')}`)
      .send({ cards: [taskCard(), second] })

    expect(res.status).toBe(200)
    expect(res.body.data.polish).toMatchObject({
      status: 'DEGRADED',
      degradedReason: 'POLISH_PARTIAL_FAILED',
    })
    expect(res.body.data.taskCards[0].polishStatus).toBe('AI_POLISHED')
    expect(res.body.data.taskCards[1]).toMatchObject({
      id: 'task-draft-2',
      title: '原始整改记录任务',
      polishStatus: 'FALLBACK_ORIGINAL',
    })
  })

  it('enterprise batch repolish LLM 失败 → 全部 fallback', async () => {
    const manager = await makeEnterpriseUser('ENT_TG_REPOLISH_FAIL', 'MANAGER')
    currentAiCaller = async () => {
      throw new AiCallFailedError('LLM overloaded timeout')
    }
    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/cards/repolish')
      .set('Authorization', `Bearer ${getTestToken(manager.id, 'user')}`)
      .send({ cards: [taskCard()] })
    expect(res.status).toBe(200)
    expect(res.body.data.polish.degradedReason).toBe('POLISH_AI_OVERLOADED')
    expect(res.body.data.taskCards[0].polishStatus).toBe('FALLBACK_ORIGINAL')
  })

  it('batch repolish cards 空数组 → 400', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/cards/repolish')
      .set('Authorization', `Bearer ${token}`)
      .send({ cards: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('cards 数量必须在 1..24')
  })

  it('batch repolish cards 超过 24 张 → 400', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/cards/repolish')
      .set('Authorization', `Bearer ${token}`)
      .send({ cards: Array.from({ length: 25 }, (_, index) => taskCard({ id: `task-draft-${index}`, taskDraftId: `task-draft-${index}`, draftId: `draft-${index}`, groupId: `draft-${index}` })) })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('cards 数量必须在 1..24')
  })

  it('batch repolish EMPLOYEE → 403', async () => {
    const employee = await makeEnterpriseUser('ENT_TG_REPOLISH_EMP', 'EMPLOYEE')
    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/cards/repolish')
      .set('Authorization', `Bearer ${getTestToken(employee.id, 'user')}`)
      .send({ cards: [taskCard()] })
    expect(res.status).toBe(403)
  })
})

describe('POST /task-generation/re-extract', () => {
  it('enterprise happy: 整体重新提取返回 preview 同形 + operation', async () => {
    const enterpriseId = 'ENT_TG_REEXTRACT'
    const manager = await makeEnterpriseUser(enterpriseId, 'MANAGER')
    const source = await makeSource(manager.id, enterpriseId)
    currentAiCaller = async () => JSON.stringify([
      {
        draftId: 'draft-1',
        title: '每月检查培训制度落实情况',
        description: '核查培训制度是否持续执行。',
        submitRequirement: '提交培训记录。',
        taskType: 'INSPECTION_FILL',
        requiredMaterials: ['培训记录'],
        deadlineSuggestion: { mode: 'AFTER_APPROVAL_DAYS', daysAfterApproval: 30, label: '审核通过后 30 天内完成', reason: '按月度推荐' },
      },
      {
        draftId: 'draft-2',
        title: '检查整改记录归档情况',
        description: '核查整改记录是否完整留存。',
        submitRequirement: '提交整改台账。',
        taskType: 'ARCHIVE_MATERIAL',
        requiredMaterials: ['整改台账'],
        deadlineSuggestion: { mode: 'AFTER_APPROVAL_DAYS', daysAfterApproval: 7, label: '审核通过后 7 天内完成', reason: '默认周期' },
      },
    ])

    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/re-extract')
      .set('Authorization', `Bearer ${getTestToken(manager.id, 'user')}`)
      .send({ sourceId: source.id, parseMode: 'RULE', polish: true, previousCardCount: 2 })

    expect(res.status).toBe(200)
    expect(res.body.data.operation).toBe('RE_EXTRACT')
    expect(res.body.data.source.id).toBe(source.id)
    expect(res.body.data.taskCards).toHaveLength(2)
    expect(res.body.data.drafts[0].taskDrafts[0].title).toBe('每月检查培训制度落实情况')
    expect(await prisma.standardExecutionRequirement.count()).toBe(0)
  })

  it('enterprise re-extract 润色 LLM 失败 → 200 降级 fallback', async () => {
    const enterpriseId = 'ENT_TG_REEXTRACT_FAIL'
    const manager = await makeEnterpriseUser(enterpriseId, 'MANAGER')
    const source = await makeSource(manager.id, enterpriseId)
    currentAiCaller = async () => {
      throw new AiCallFailedError('LLM overloaded timeout')
    }

    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/re-extract')
      .set('Authorization', `Bearer ${getTestToken(manager.id, 'user')}`)
      .send({ sourceId: source.id, parseMode: 'RULE', polish: true })

    expect(res.status).toBe(200)
    expect(res.body.data.operation).toBe('RE_EXTRACT')
    expect(res.body.data.polish.degradedReason).toBe('POLISH_AI_OVERLOADED')
    expect(res.body.data.taskCards.every((card: { polishStatus: string }) => card.polishStatus === 'FALLBACK_ORIGINAL')).toBe(true)
  })

  it('re-extract 缺 sourceId/rawText → 400', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/re-extract')
      .set('Authorization', `Bearer ${token}`)
      .send({ parseMode: 'RULE', polish: true })
    expect(res.status).toBe(400)
  })

  it('re-extract EMPLOYEE → 403', async () => {
    const enterpriseId = 'ENT_TG_REEXTRACT_EMP'
    const employee = await makeEnterpriseUser(enterpriseId, 'EMPLOYEE')
    const source = await makeSource(employee.id, enterpriseId)
    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/re-extract')
      .set('Authorization', `Bearer ${getTestToken(employee.id, 'user')}`)
      .send({ sourceId: source.id, parseMode: 'RULE', polish: true })
    expect(res.status).toBe(403)
  })
})

describe('POST /task-generation/preview', () => {
  it('admin happy: sourceId + RULE 只预览，不写 Requirement', async () => {
    const { admin, token } = await makeAdminToken()
    const source = await makeSource(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: source.id, parseMode: 'RULE' })
    expect(res.status).toBe(200)
    expect(res.body.data.source.id).toBe(source.id)
    expect(res.body.data.parseMode).toBe('RULE')
    expect(Array.isArray(res.body.data.drafts)).toBe(true)
    expect(res.body.data.candidateV2Enabled).toBeUndefined()
    expect(await prisma.standardExecutionRequirement.count()).toBe(0)
  })

  it('OCR_AI 默认关闭 candidate v2，沿用旧 prompt 和旧响应形态', async () => {
    const enterpriseId = 'ENT_TG_CANDIDATE_OFF'
    const manager = await makeEnterpriseUser(enterpriseId, 'MANAGER')
    const token = getTestToken(manager.id, 'user')
    const source = await makeSource(manager.id, enterpriseId)
    let promptSeen = ''
    currentAiCaller = async (prompt) => {
      promptSeen = prompt
      return JSON.stringify([
        {
          clauseNo: '4.1',
          title: '门岗检查',
          requirementText: '门岗值守人员应每日检查访客登记记录并留存门岗系统截图。',
        },
      ])
    }

    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: source.id, parseMode: 'OCR_AI' })

    expect(res.status).toBe(200)
    expect(promptSeen).toContain('请从中提取所有可执行的要求项')
    expect(promptSeen).not.toContain('candidateRequirements')
    expect(res.body.data.candidateV2Enabled).toBeUndefined()
    expect(res.body.data.candidateRequirements).toBeUndefined()
    expect(res.body.data.drafts).toHaveLength(1)
  })

  it('RULE 在 candidate v2 开关打开时走确定性聚合并返回覆盖报告', async () => {
    process.env.STANDARD_AI_CANDIDATE_V2 = '1'
    const enterpriseId = 'ENT_TG_RULE_CANDIDATE'
    const manager = await makeEnterpriseUser(enterpriseId, 'MANAGER')
    const token = getTestToken(manager.id, 'user')
    const source = await makeSource(manager.id, enterpriseId)
    let calls = 0
    currentAiCaller = async () => {
      calls++
      throw new Error('RULE should not call AI')
    }

    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: source.id, parseMode: 'RULE' })

    expect(res.status).toBe(200)
    expect(calls).toBe(0)
    expect(res.body.data.parseMode).toBe('RULE')
    expect(res.body.data.candidateV2Enabled).toBe(true)
    expect(res.body.data.candidateRequirements.length).toBeGreaterThan(0)
    expect(res.body.data.taskPackages.length).toBeGreaterThan(0)
    expect(res.body.data.taskPackages.every((pkg: { mergeMode: string }) => pkg.mergeMode === 'DETERMINISTIC')).toBe(true)
    expect(res.body.data.coverageReport.totalCandidates).toBe(res.body.data.candidateRequirements.length)
    expect(res.body.data.coverageReport.entries.every((entry: { sourceText: string }) => entry.sourceText)).toBe(true)
    expect(res.body.data.warnings.join('\n')).toContain('规则候选要求')
    expect(await prisma.standardExecutionRequirement.count()).toBe(0)
  })

  it('OCR_AI 返回 candidateRequirements + score 分布，只有高分候选进入 drafts', async () => {
    process.env.STANDARD_AI_CANDIDATE_V2 = '1'
    const enterpriseId = 'ENT_TG_CANDIDATE_SCORE'
    const manager = await makeEnterpriseUser(enterpriseId, 'MANAGER')
    const token = getTestToken(manager.id, 'user')
    const source = await makeSource(manager.id, enterpriseId)
    const prompts: string[] = []
    currentAiCaller = async (prompt) => {
      prompts.push(prompt)
      return JSON.stringify({
        candidateRequirements: [
          {
            clauseNo: '4.1',
            sourceText: '门岗值守人员应每日检查访客登记记录并留存门岗系统截图。',
            action: '门岗值守人员每日检查访客登记记录',
            responsibleRole: '门岗值守人员',
            evidenceType: '访客登记台账、门岗系统截图',
            frequency: '每日',
            riskLevel: 'MEDIUM',
            suggestedTaskType: 'INSPECTION_FILL',
            score: 75,
            mergeable: true,
            mergeReason: '同属门岗记录检查要求',
          },
          {
            clauseNo: '4.2',
            sourceText: '巡逻记录应保存不少于一年。',
            action: '保存巡逻记录',
            responsibleRole: '巡逻队长',
            evidenceType: '巡逻记录归档清单',
            frequency: '持续留存',
            riskLevel: 'LOW',
            suggestedTaskType: 'ARCHIVE_MATERIAL',
            score: 70,
            mergeable: true,
            mergeReason: '适合作为巡逻任务的关联依据',
          },
          {
            clauseNo: '2.1',
            sourceText: '固定岗是指在指定位置执行守护任务的岗位。',
            action: '理解固定岗定义',
            responsibleRole: '安保主管',
            evidenceType: null,
            frequency: null,
            riskLevel: 'LOW',
            suggestedTaskType: 'INSPECTION_FILL',
            score: 45,
            mergeable: false,
            mergeReason: '定义条款不应独立成任务',
          },
        ],
      })
    }

    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: source.id, parseMode: 'OCR_AI' })

    expect(res.status).toBe(200)
    expect(prompts[0]).toContain('candidateRequirements')
    expect(prompts[0]).toContain('评分锚点')
    expect(res.body.data.parseMode).toBe('OCR_AI')
    expect(res.body.data.candidateV2Enabled).toBe(true)
    expect(res.body.data.candidateRequirements).toHaveLength(3)
    expect(res.body.data.candidateThresholds).toEqual({ candidateMinScore: 60, taskMinScore: 75 })
    expect(res.body.data.candidateScoreDistribution).toMatchObject({
      total: 3,
      belowTaskThreshold: 1,
      associatedOnly: 1,
      taskEligible: 1,
      buckets: { lt60: 1, s60to74: 1, gte75: 1 },
    })
    expect(res.body.data.drafts).toHaveLength(1)
    expect(res.body.data.drafts[0]).toMatchObject({
      clauseNo: '4.1',
      recommendedTaskType: 'INSPECTION_FILL',
      suggestedDepartment: '门岗值守人员',
    })
    expect(res.body.data.taskPackages).toHaveLength(1)
    expect(res.body.data.coverageReport.entries.map((item: { destination: string }) => item.destination)).toEqual([
      'TASK_PACKAGE',
      'ASSOCIATED_CANDIDATE',
      'LOW_SCORE_CANDIDATE',
    ])
    expect(res.body.data.warnings.join('\n')).toContain('AI 候选要求 3 条，其中 1 条超过任务阈值，聚合为 1 个任务包')
    expect(await prisma.standardExecutionRequirement.count()).toBe(0)
  })

  it('OCR_AI candidate score boundaries: >=75 成任务，60-74 关联，<60 仅候选', async () => {
    process.env.STANDARD_AI_CANDIDATE_V2 = '1'
    const enterpriseId = 'ENT_TG_CANDIDATE_BOUNDARIES'
    const manager = await makeEnterpriseUser(enterpriseId, 'MANAGER')
    const token = getTestToken(manager.id, 'user')
    const source = await makeSource(manager.id, enterpriseId)
    currentAiCaller = async () => JSON.stringify({
      candidateRequirements: [
        {
          clauseNo: '2.1',
          sourceText: '固定岗是指在指定位置执行守护任务的岗位。',
          action: '理解固定岗定义',
          responsibleRole: '安保主管',
          evidenceType: null,
          frequency: null,
          riskLevel: 'LOW',
          suggestedTaskType: 'INSPECTION_FILL',
          score: 59,
          mergeable: false,
          mergeReason: '定义条款不成任务',
        },
        {
          clauseNo: '4.2',
          sourceText: '巡逻记录应保存不少于一年。',
          action: '保存巡逻记录',
          responsibleRole: '巡逻队长',
          evidenceType: '巡逻记录归档清单',
          frequency: '持续留存',
          riskLevel: 'LOW',
          suggestedTaskType: 'ARCHIVE_MATERIAL',
          score: 60,
          mergeable: true,
          mergeReason: '仅作巡逻任务关联依据',
        },
        {
          clauseNo: '4.3',
          sourceText: '交接班记录应由班组留存备查。',
          action: '留存交接班记录',
          responsibleRole: '班组长',
          evidenceType: '交接班记录',
          frequency: '每班次',
          riskLevel: 'MEDIUM',
          suggestedTaskType: 'ARCHIVE_MATERIAL',
          score: 74,
          mergeable: true,
          mergeReason: '适合并入交接班任务包',
        },
        {
          clauseNo: '4.4',
          sourceText: '巡逻人员应每日按路线巡查并上传巡更签到表。',
          action: '巡逻人员每日按路线巡查并上传巡更签到表',
          responsibleRole: '巡逻人员',
          evidenceType: '巡更签到表',
          frequency: '每日',
          riskLevel: 'HIGH',
          suggestedTaskType: 'INSPECTION_FILL',
          score: 75,
          mergeable: true,
          mergeReason: '可独立形成巡逻检查任务',
        },
      ],
    })

    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: source.id, parseMode: 'OCR_AI' })

    expect(res.status).toBe(200)
    expect(res.body.data.candidateScoreDistribution).toMatchObject({
      total: 4,
      belowTaskThreshold: 1,
      associatedOnly: 2,
      taskEligible: 1,
      buckets: { lt60: 1, s60to74: 2, gte75: 1 },
    })
    expect(res.body.data.drafts).toHaveLength(1)
    expect(res.body.data.drafts[0]).toMatchObject({ clauseNo: '4.4' })
    expect(res.body.data.coverageReport.entries.map((item: { destination: string }) => item.destination)).toEqual([
      'LOW_SCORE_CANDIDATE',
      'ASSOCIATED_CANDIDATE',
      'ASSOCIATED_CANDIDATE',
      'TASK_PACKAGE',
    ])
    expect(res.body.data.candidateRequirements.map((item: { score: number }) => item.score)).toEqual([59, 60, 74, 75])
  })

  it('enterprise polish happy: 返回 v2 任务卡 + 可提交 taskDrafts，不写库', async () => {
    const enterpriseId = 'ENT_TG_POLISH'
    const manager = await makeEnterpriseUser(enterpriseId, 'MANAGER')
    const source = await makeSource(manager.id, enterpriseId)
    let promptSeen = ''
    currentAiCaller = async (prompt) => {
      promptSeen = prompt
      return JSON.stringify([
        {
          draftId: 'draft-1',
          title: '每月检查培训制度执行情况',
          description: '核查培训制度是否建立、更新，并确认责任人已执行。',
          submitRequirement: '提交培训制度、培训记录和责任人确认截图。',
          taskType: 'INSPECTION_FILL',
          requiredMaterials: ['培训制度', '培训记录'],
          deadlineSuggestion: {
            mode: 'AFTER_APPROVAL_DAYS',
            daysAfterApproval: 30,
            label: '审核通过后 30 天内完成',
            reason: '按月度检查推荐',
          },
        },
        {
          draftId: 'draft-2',
          title: '检查整改记录留存情况',
          description: '核查整改记录是否完整留存，并补齐缺失材料。',
          submitRequirement: '提交整改台账和现场整改证明。',
          taskType: 'ARCHIVE_MATERIAL',
          requiredMaterials: ['整改台账'],
          deadlineSuggestion: {
            mode: 'AFTER_APPROVAL_DAYS',
            daysAfterApproval: 7,
            label: '审核通过后 7 天内完成',
            reason: '按默认周期推荐',
          },
        },
      ])
    }

    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/preview')
      .set('Authorization', `Bearer ${getTestToken(manager.id, 'user')}`)
      .send({ sourceId: source.id, parseMode: 'RULE', polish: true })

    expect(res.status).toBe(200)
    expect(promptSeen).toContain('企业标准执行顾问')
    expect(res.body.data.polish).toMatchObject({
      enabled: true,
      status: 'SUCCEEDED',
      degraded: false,
      degradedReason: null,
    })
    expect(res.body.data.taskCards).toHaveLength(2)
    expect(res.body.data.taskCards[0]).toMatchObject({
      title: '每月检查培训制度执行情况',
      taskType: 'INSPECTION_FILL',
      polishStatus: 'AI_POLISHED',
      basis: { sourceId: source.id, sourceTitle: '任务生成标准', clauseNo: '1.1' },
    })
    expect(res.body.data.drafts[0].taskDrafts[0]).toMatchObject({
      title: '每月检查培训制度执行情况',
      taskType: 'INSPECTION_FILL',
      submitRequirement: '提交培训制度、培训记录和责任人确认截图。',
    })
    expect(await prisma.standardExecutionRequirement.count()).toBe(0)
  })

  it('enterprise polish LLM 失败 → 200 降级 fallback，不阻塞主流程', async () => {
    const enterpriseId = 'ENT_TG_POLISH_FAIL'
    const manager = await makeEnterpriseUser(enterpriseId, 'MANAGER')
    const source = await makeSource(manager.id, enterpriseId)
    currentAiCaller = async () => {
      throw new AiCallFailedError('LLM qwen timeout after 30000ms')
    }

    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/preview')
      .set('Authorization', `Bearer ${getTestToken(manager.id, 'user')}`)
      .send({ sourceId: source.id, parseMode: 'RULE', polish: { enabled: true, target: 'TASK_CARD_V2' } })

    expect(res.status).toBe(200)
    expect(res.body.data.polish).toMatchObject({
      enabled: true,
      status: 'DEGRADED',
      degraded: true,
      degradedReason: 'POLISH_AI_OVERLOADED',
    })
    expect(res.body.data.taskCards).toHaveLength(2)
    expect(res.body.data.taskCards.every((card: { polishStatus: string }) => card.polishStatus === 'FALLBACK_ORIGINAL')).toBe(true)
    expect(res.body.data.drafts.every((item: { taskDrafts?: unknown[] }) => item.taskDrafts?.length === 1)).toBe(true)
    expect(await prisma.standardExecutionRequirement.count()).toBe(0)
  })

  it('polish 参数缺 sourceId/rawText → 400，不触发解析或润色', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ parseMode: 'RULE', polish: true })
    expect(res.status).toBe(400)
  })
})

describe('POST /task-generation/commit', () => {
  it('admin happy: 创建 ACTIVE Requirement + DRAFT Task + basisSnapshots', async () => {
    const { admin, token } = await makeAdminToken()
    const reviewer = await createUser({ role: 'user' })
    const assignee = await createUser({ role: 'user' })
    const source = await makeSource(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceId: source.id,
        parseMode: 'RULE',
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [assignee.id],
        drafts: [draft('培训制度')],
      })
    expect(res.status).toBe(201)
    expect(res.body.data.summary).toEqual({ requirements: 1, tasks: 1, taskStatus: 'DRAFT' })
    const req = await prisma.standardExecutionRequirement.findUniqueOrThrow({ where: { id: res.body.data.created.requirementIds[0] } })
    expect(req.status).toBe('ACTIVE')
    expect(req.executionDescription).toBe('培训制度 的执行描述')
    const task = await prisma.standardExecutionTask.findUniqueOrThrow({ where: { id: res.body.data.created.taskIds[0] } })
    expect(task.status).toBe('DRAFT')
    expect(task.requirementId).toBe(req.id)
    expect(task.basisSnapshots).toEqual([expect.objectContaining({ requirementId: req.id, sourceTitle: '任务生成标准' })])
  })

  it('admin draft commit: 保存草稿不要求审核人/执行人/截止时间', async () => {
    const { admin, token } = await makeAdminToken()
    const source = await makeSource(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceId: source.id,
        parseMode: 'RULE',
        taskStatus: 'DRAFT',
        drafts: [draft('纯草稿任务')],
      })
    expect(res.status).toBe(201)
    expect(res.body.data.summary).toEqual({ requirements: 1, tasks: 1, taskStatus: 'DRAFT' })
    const task = await prisma.standardExecutionTask.findUniqueOrThrow({ where: { id: res.body.data.created.taskIds[0] } })
    expect(task.status).toBe('DRAFT')
    expect(task.reviewerId).toBeNull()
    expect(task.deadlineAt).toBeNull()
    expect(task.deadlineDaysAfterApproval).toBeNull()
    await expect(prisma.standardExecutionTaskAssignee.count({ where: { taskId: task.id } })).resolves.toBe(0)
  })

  it('admin draft commit: cardIds 白名单只落选中的草稿卡', async () => {
    const { admin, token } = await makeAdminToken()
    const source = await makeSource(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceId: source.id,
        parseMode: 'RULE',
        taskStatus: 'DRAFT',
        cardIds: ['card-a'],
        drafts: [
          draft('选中的任务', { draftId: 'draft-a', taskDrafts: [{ taskDraftId: 'card-a', groupId: 'card-a', title: '选中的任务卡' }] }),
          draft('未选中的任务', { draftId: 'draft-b', taskDrafts: [{ taskDraftId: 'card-b', groupId: 'card-b', title: '未选中的任务卡' }] }),
        ],
      })

    expect(res.status).toBe(201)
    expect(res.body.data.summary).toEqual({ requirements: 1, tasks: 1, taskStatus: 'DRAFT' })
    await expect(prisma.standardExecutionRequirement.count({ where: { sourceId: source.id } })).resolves.toBe(1)
    await expect(prisma.standardExecutionTask.count({ where: { enterpriseId: 'DEFAULT' } })).resolves.toBe(1)
    const task = await prisma.standardExecutionTask.findFirstOrThrow({ where: { enterpriseId: 'DEFAULT' } })
    expect(task.title).toBe('选中的任务卡')
    await expect(prisma.standardExecutionRequirement.findFirst({ where: { title: '未选中的任务' } })).resolves.toBeNull()
  })

  it('admin draft commit: cardIds 多选白名单只落选中集合', async () => {
    const { admin, token } = await makeAdminToken()
    const source = await makeSource(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceId: source.id,
        parseMode: 'RULE',
        taskStatus: 'DRAFT',
        cardIds: ['card-a', 'card-c'],
        drafts: [
          draft('选中 A', { draftId: 'draft-a', taskDrafts: [{ taskDraftId: 'card-a', groupId: 'card-a', title: '任务 A' }] }),
          draft('未选中 B', { draftId: 'draft-b', taskDrafts: [{ taskDraftId: 'card-b', groupId: 'card-b', title: '任务 B' }] }),
          draft('选中 C', { draftId: 'draft-c', taskDrafts: [{ taskDraftId: 'card-c', groupId: 'card-c', title: '任务 C' }] }),
        ],
      })

    expect(res.status).toBe(201)
    expect(res.body.data.summary).toEqual({ requirements: 2, tasks: 2, taskStatus: 'DRAFT' })
    const reqTitles = (await prisma.standardExecutionRequirement.findMany({
      where: { sourceId: source.id },
      orderBy: { title: 'asc' },
    })).map((item) => item.title)
    expect(reqTitles).toEqual(['选中 A', '选中 C'])
    const taskTitles = (await prisma.standardExecutionTask.findMany({
      where: { enterpriseId: 'DEFAULT' },
      orderBy: { title: 'asc' },
    })).map((item) => item.title)
    expect(taskTitles).toEqual(['任务 A', '任务 C'])
  })

  it('admin draft commit: cardIds 过滤后为空 → 400 且不写库', async () => {
    const { admin, token } = await makeAdminToken()
    const source = await makeSource(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceId: source.id,
        parseMode: 'RULE',
        taskStatus: 'DRAFT',
        cardIds: ['missing-card'],
        drafts: [
          draft('未命中任务', { draftId: 'draft-a', taskDrafts: [{ taskDraftId: 'card-a', groupId: 'card-a', title: '未命中任务卡' }] }),
        ],
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('草稿不能为空')
    await expect(prisma.standardExecutionRequirement.count({ where: { sourceId: source.id } })).resolves.toBe(0)
    await expect(prisma.standardExecutionTask.count({ where: { enterpriseId: 'DEFAULT' } })).resolves.toBe(0)
  })

  it('admin submit approval: 创建待审核 Task + 审批日志', async () => {
    const { admin, token } = await makeAdminToken()
    const reviewer = await createUser({ role: 'user' })
    const assignee = await createUser({ role: 'user' })
    const source = await makeSource(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceId: source.id,
        parseMode: 'RULE',
        taskStatus: 'PENDING_APPROVAL',
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [assignee.id],
        drafts: [draft('培训制度')],
      })
    expect(res.status).toBe(201)
    expect(res.body.data.summary).toEqual({ requirements: 1, tasks: 1, taskStatus: 'PENDING_APPROVAL' })
    const task = await prisma.standardExecutionTask.findUniqueOrThrow({ where: { id: res.body.data.created.taskIds[0] } })
    expect(task.status).toBe('PENDING_APPROVAL')
    expect(task.submittedForApprovalAt).toBeTruthy()
    expect(task.publishedAt).toBeNull()
    const log = await prisma.standardExecutionTaskApprovalLog.findFirstOrThrow({ where: { taskId: task.id } })
    expect(log.action).toBe('SUBMIT_APPROVAL')
  })

  it('drafts 空数组 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const reviewer = await createUser({ role: 'user' })
    const assignee = await createUser({ role: 'user' })
    const source = await makeSource(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceId: source.id,
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [assignee.id],
        drafts: [],
      })
    expect(res.status).toBe(400)
  })

  it('drafts 101 条 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const reviewer = await createUser({ role: 'user' })
    const assignee = await createUser({ role: 'user' })
    const source = await makeSource(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceId: source.id,
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [assignee.id],
        drafts: Array.from({ length: 101 }, (_, i) => draft(`草稿 ${i}`)),
      })
    expect(res.status).toBe(400)
  })

  it('合并形态: 多草稿同 groupId → 1 Task + 多 TaskItem', async () => {
    const { admin, token } = await makeAdminToken()
    const reviewer = await createUser({ role: 'user' })
    const assignee = await createUser({ role: 'user' })
    const source = await makeSource(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceId: source.id,
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [assignee.id],
        drafts: [
          draft('培训制度', { taskDrafts: [{ groupId: 'merged', title: '合并任务' }] }),
          draft('整改记录', { clauseNo: '1.2', taskDrafts: [{ groupId: 'merged', title: '合并任务' }] }),
        ],
      })
    expect(res.status).toBe(201)
    expect(res.body.data.summary).toEqual({ requirements: 2, tasks: 1, taskStatus: 'DRAFT' })
    const task = await prisma.standardExecutionTask.findUniqueOrThrow({ where: { id: res.body.data.created.taskIds[0] } })
    expect(task.requirementId).toBeNull()
    expect((task.basisSnapshots as unknown[]).length).toBe(2)
    expect(await prisma.standardExecutionTaskItem.count({ where: { taskId: task.id } })).toBe(2)
  })

  it('拆分形态: 同一草稿多个 taskDrafts → 多 Task，共享 Requirement', async () => {
    const { admin, token } = await makeAdminToken()
    const reviewer = await createUser({ role: 'user' })
    const assignee = await createUser({ role: 'user' })
    const source = await makeSource(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceId: source.id,
        deadlineAt: new Date(Date.now() + 86400_000).toISOString(),
        reviewerId: reviewer.id,
        assigneeIds: [assignee.id],
        drafts: [draft('培训制度', {
          splitFromId: 'source-draft-1',
          taskDrafts: [
            { groupId: 'split-a', title: '学习任务' },
            { groupId: 'split-b', title: '记录任务', taskType: 'ARCHIVE_MATERIAL' },
          ],
        })],
      })
    expect(res.status).toBe(201)
    expect(res.body.data.summary).toEqual({ requirements: 1, tasks: 2, taskStatus: 'DRAFT' })
    const tasks = await prisma.standardExecutionTask.findMany({
      where: { id: { in: res.body.data.created.taskIds } },
      orderBy: { title: 'asc' },
    })
    expect(new Set(tasks.map((task) => task.requirementId)).size).toBe(1)
    expect(tasks.map((task) => task.title).sort()).toEqual(['学习任务', '记录任务'])
  })

  it('admin commit 普通 user → 403，不写库', async () => {
    const user = await createUser({ role: 'user' })
    const source = await makeSource(user.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/task-generation/commit')
      .set('Authorization', `Bearer ${getTestToken(user.id, 'user')}`)
      .send({
        sourceId: source.id,
        parseMode: 'RULE',
        taskStatus: 'DRAFT',
        drafts: [draft('越权草稿')],
      })

    expect(res.status).toBe(403)
    await expect(prisma.standardExecutionRequirement.count({ where: { sourceId: source.id } })).resolves.toBe(0)
    await expect(prisma.standardExecutionTask.count({ where: { enterpriseId: 'DEFAULT' } })).resolves.toBe(0)
  })

  it('enterprise EMPLOYEE → 403', async () => {
    const enterpriseId = 'ENT_TG_EMP'
    const employee = await makeEnterpriseUser(enterpriseId, 'EMPLOYEE')
    const source = await makeSource(employee.id, enterpriseId)
    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/preview')
      .set('Authorization', `Bearer ${getTestToken(employee.id, 'user')}`)
      .send({ sourceId: source.id, parseMode: 'RULE', polish: true })
    expect(res.status).toBe(403)
  })

  it('enterprise 跨企业 sourceId → 404', async () => {
    const adminA = await makeEnterpriseUser('ENT_TG_A', 'ADMIN')
    const adminB = await makeEnterpriseUser('ENT_TG_B', 'ADMIN')
    const otherSource = await makeSource(adminB.id, 'ENT_TG_B')
    const res = await request(app)
      .post('/api/enterprise/standard-execution/task-generation/preview')
      .set('Authorization', `Bearer ${getTestToken(adminA.id, 'user')}`)
      .send({ sourceId: otherSource.id, parseMode: 'RULE' })
    expect(res.status).toBe(404)
  })
})
