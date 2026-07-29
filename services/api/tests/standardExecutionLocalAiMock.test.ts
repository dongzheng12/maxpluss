import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { callStandardAI } from '../src/standard-execution/aiClient.js'
import { parseByAi } from '../src/standard-execution/parseAi.js'
import { generateQuizQuestions } from '../src/standard-execution/quizGenerate.js'
import { buildLocalSEChatReply, isLocalAiMockEnabled } from '../src/standard-execution/localAiMock.js'

const ORIGINAL_ENV = {
  SE_AI_MOCK: process.env.SE_AI_MOCK,
  NODE_ENV: process.env.NODE_ENV,
  STANDARD_AI_CANDIDATE_V2: process.env.STANDARD_AI_CANDIDATE_V2,
}

beforeEach(() => {
  process.env.SE_AI_MOCK = '1'
  process.env.NODE_ENV = 'development'
})

afterEach(() => {
  if (ORIGINAL_ENV.SE_AI_MOCK === undefined) delete process.env.SE_AI_MOCK
  else process.env.SE_AI_MOCK = ORIGINAL_ENV.SE_AI_MOCK
  if (ORIGINAL_ENV.NODE_ENV === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV
  if (ORIGINAL_ENV.STANDARD_AI_CANDIDATE_V2 === undefined) delete process.env.STANDARD_AI_CANDIDATE_V2
  else process.env.STANDARD_AI_CANDIDATE_V2 = ORIGINAL_ENV.STANDARD_AI_CANDIDATE_V2
})

describe('SE local AI mock', () => {
  it('AI 解析 mock 返回可执行检查点字段', async () => {
    const drafts = await parseByAi('企业应建立记录并培训人员', callStandardAI)
    expect(drafts.length).toBeGreaterThanOrEqual(2)
    expect(drafts[0].executionDescription).toContain('上传')
    expect(drafts[0].recommendedTaskType).toBe('INSPECTION_FILL')
    expect(drafts[0].submitRequirement).toBeTruthy()
    expect(drafts[0].requiredMaterials?.length).toBeGreaterThan(0)
  })

  it('candidate v2 mock 只在总开关打开时返回候选评分路径', async () => {
    process.env.STANDARD_AI_CANDIDATE_V2 = '1'
    const drafts = await parseByAi('门岗值守人员应核验来访人员身份', callStandardAI)
    expect(drafts.length).toBeGreaterThanOrEqual(2)
    expect(drafts[0].executionDescription).toContain('门岗')
    expect(drafts[0].recommendedTaskType).toBe('INSPECTION_FILL')
  })

  it('题库 AI mock 返回可预览题目', async () => {
    const questions = await generateQuizQuestions(
      '企业应保存执行记录并完成培训。',
      { count: 3, questionType: 'SINGLE', difficulty: 'BASIC' },
      callStandardAI,
    )
    expect(questions.length).toBe(3)
    expect(questions[0].opts.length).toBeGreaterThanOrEqual(3)
    expect(questions.reduce((sum, q) => sum + q.score, 0)).toBe(100)
  })

  it('SE 问小智 mock 带本地免责声明，生产环境强制关闭', () => {
    const reply = buildLocalSEChatReply('如何审核这条任务？', '任务概况：共 1 个任务')
    expect(reply).toContain('仅供参考，最终以人工审核为准')
    expect(isLocalAiMockEnabled()).toBe(true)

    process.env.NODE_ENV = 'production'
    expect(isLocalAiMockEnabled()).toBe(false)
  })
})
