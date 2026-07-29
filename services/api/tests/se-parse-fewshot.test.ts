import { describe, expect, it } from 'vitest'
import { buildAiPrompt, FEW_SHOT_EXAMPLES } from '../src/standard-execution/parseAi.js'
import { normalizeStandardTextForParsing } from '../src/standard-execution/parseRule.js'

describe('standard-execution parseAi few-shot prompt', () => {
  it('buildAiPrompt defaults to the legacy prompt when candidate v2 is off', () => {
    delete process.env.STANDARD_AI_CANDIDATE_V2
    const prompt = buildAiPrompt('9.1 企业应保存检测报告。')
    expect(prompt).toContain('请从中提取所有可执行的要求项')
    expect(prompt).not.toContain('candidateRequirements')
  })

  it('buildAiPrompt includes candidate v2 few-shot and score anchors when enabled', () => {
    process.env.STANDARD_AI_CANDIDATE_V2 = '1'
    const rawText = '9.1 企业应保存检测报告。'
    const normalizedRawText = normalizeStandardTextForParsing(rawText)
    const prompt = buildAiPrompt(rawText)

    expect(FEW_SHOT_EXAMPLES).toContain('门岗值守人员应核验来访人员身份')
    expect(FEW_SHOT_EXAMPLES).toContain('"suggestedTaskType": "TRAINING"')
    expect(prompt).toContain('candidateRequirements')
    expect(prompt).toContain('评分锚点')
    expect(prompt).toContain('score 60')
    expect(prompt).toContain('score 75')
    expect(prompt).toContain(FEW_SHOT_EXAMPLES)
    expect(prompt.indexOf(FEW_SHOT_EXAMPLES)).toBeLessThan(prompt.indexOf(normalizedRawText))
    expect(prompt).toContain(normalizedRawText)
    delete process.env.STANDARD_AI_CANDIDATE_V2
  })
})
