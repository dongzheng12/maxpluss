import { describe, expect, it } from 'vitest'
import { polishTaskGenerationDrafts } from '../src/standard-execution/taskPolishService.js'

const drafts = [
  {
    clauseNo: '5.1',
    title: '检查设备完好率',
    requirementText: '应每月检查关键设备完好率并记录异常处理情况。',
    executionDescription: '检查关键设备完好率并记录结果。',
    recommendedTaskType: 'INSPECTION_FILL',
    suggestedFrequency: 'MONTHLY',
    submitRequirement: '提交设备检查记录。',
    requiredMaterials: ['设备检查表'],
  },
  {
    clauseNo: '5.2',
    title: '留存整改记录',
    requirementText: '应留存整改记录和复查证明。',
    executionDescription: '确认整改记录完整归档。',
    recommendedTaskType: 'ARCHIVE_MATERIAL',
    submitRequirement: '提交整改台账。',
    requiredMaterials: ['整改台账'],
  },
]

describe('polishTaskGenerationDrafts', () => {
  it('AI 少返回某条 → 部分降级并保留 fallback taskDraft', async () => {
    const result = await polishTaskGenerationDrafts(drafts, {
      source: { id: 'source-1', title: '设备管理标准' },
      aiCaller: async () =>
        JSON.stringify([
          {
            draftId: 'draft-1',
            title: '每月检查关键设备完好率',
            description: '核查关键设备完好率并记录异常处理情况。',
            submitRequirement: '提交设备检查记录和异常处理说明。',
            taskType: 'INSPECTION_FILL',
            requiredMaterials: ['设备检查表'],
            deadlineSuggestion: {
              mode: 'AFTER_APPROVAL_DAYS',
              daysAfterApproval: 30,
              label: '审核通过后 30 天内完成',
              reason: '按月度频率推荐',
            },
          },
        ]),
    })

    expect(result.polish.status).toBe('DEGRADED')
    expect(result.polish.degradedReason).toBe('POLISH_PARTIAL_FAILED')
    expect(result.polish.warnings.some((warning) => warning.includes('不完整'))).toBe(true)
    expect(result.polish.stats.aiCards).toBe(1)
    expect(result.polish.stats.fallbackCards).toBe(1)
    expect(result.taskCards).toHaveLength(2)
    expect(result.taskCards[0].polishStatus).toBe('AI_POLISHED')
    expect(result.taskCards[1]).toMatchObject({
      polishStatus: 'FALLBACK_ORIGINAL',
      basis: { sourceId: 'source-1', sourceTitle: '设备管理标准', clauseNo: '5.2' },
    })
    expect(result.drafts[1].taskDrafts[0].title).toBe(result.taskCards[1].title)
  })

  it('解析阶段已降级 → 润色跳过 LLM 并返回原始 fallback', async () => {
    let calls = 0
    const result = await polishTaskGenerationDrafts(drafts.slice(0, 1), {
      source: null,
      forceFallbackReason: 'POLISH_AI_FAILED',
      aiCaller: async () => {
        calls++
        return '[]'
      },
    })

    expect(calls).toBe(0)
    expect(result.polish.status).toBe('DEGRADED')
    expect(result.polish.degradedReason).toBe('POLISH_AI_FAILED')
    expect(result.taskCards[0].polishStatus).toBe('FALLBACK_ORIGINAL')
    expect(result.drafts[0].taskDrafts).toHaveLength(1)
  })
})
