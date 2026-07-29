import { describe, expect, it } from 'vitest'
import {
  aggregateCandidateRequirements,
  type CandidateAggregationResult,
} from '../src/standard-execution/candidateAggregation.js'
import type { CandidateRequirement } from '../src/standard-execution/types.js'

function candidate(overrides: Partial<CandidateRequirement> = {}): CandidateRequirement {
  return {
    clauseNo: '4.1',
    sourceText: '门岗值守人员应每日检查访客登记记录并留存门岗系统截图。',
    action: '门岗值守人员每日检查访客登记记录',
    responsibleRole: '门岗值守人员',
    evidenceType: '访客登记台账、门岗系统截图',
    frequency: '每日',
    riskLevel: 'MEDIUM',
    suggestedTaskType: 'INSPECTION_FILL',
    score: 80,
    mergeable: true,
    mergeReason: '同属门岗记录检查要求',
    ...overrides,
  }
}

function packageIdsFromPrompt(prompt: string) {
  return Array.from(prompt.matchAll(/"packageId"\s*:\s*"([^"]+)"/g)).map((match) => match[1])
}

describe('T14-2 candidate aggregation', () => {
  it('按任务类型+责任角色+证据类型硬键分组，60-74 作为关联要求并入任务包', async () => {
    const result = await aggregateCandidateRequirements([
      candidate({ clauseNo: '4.1', score: 86 }),
      candidate({
        clauseNo: '4.2',
        sourceText: '访客登记台账应保存不少于一年。',
        action: '保存访客登记台账不少于一年',
        score: 68,
      }),
      candidate({
        clauseNo: '2.1',
        sourceText: '固定岗是指在指定位置执行守护任务的岗位。',
        action: '理解固定岗定义',
        score: 45,
      }),
    ], { candidateMinScore: 60, taskMinScore: 75, maxPackages: 12 })

    expect(result.taskPackages).toHaveLength(1)
    expect(result.taskPackages[0]).toMatchObject({
      candidateCount: 2,
      candidateIndexes: [0, 1],
      mergeMode: 'DETERMINISTIC',
    })
    expect(result.drafts).toHaveLength(2)
    expect(new Set(result.drafts.map((draft) => draft.groupId)).size).toBe(1)
    expect(result.drafts.every((draft) => draft.taskDrafts[0].groupId === result.taskPackages[0].groupId)).toBe(true)
    expect(result.coverageReport.entries.map((entry) => entry.destination)).toEqual([
      'TASK_PACKAGE',
      'TASK_PACKAGE',
      'LOW_SCORE_CANDIDATE',
    ])
  })

  it('数量控制保留高分任务包，超出上限的候选进入 coverageReport overflow', async () => {
    const result = await aggregateCandidateRequirements([
      candidate({ clauseNo: '4.1', responsibleRole: '门岗值守人员', score: 91 }),
      candidate({ clauseNo: '5.1', responsibleRole: '巡逻队长', evidenceType: '巡逻记录', score: 88 }),
      candidate({ clauseNo: '6.1', responsibleRole: '培训负责人', evidenceType: '培训签到表', suggestedTaskType: 'TRAINING', score: 82 }),
    ], { candidateMinScore: 60, taskMinScore: 75, maxPackages: 2 })

    expect(result.taskPackages).toHaveLength(2)
    expect(result.taskPackages.map((pkg) => pkg.score)).toEqual([91, 88])
    expect(result.coverageReport.taskPackageCount).toBe(2)
    expect(result.coverageReport.candidateOnlyCount).toBe(1)
    expect(result.coverageReport.entries[2]).toMatchObject({
      destination: 'OVERFLOW_CANDIDATE',
      packageId: null,
    })
  })

  it('LLM 组内合并通过可注入 aiCaller 改写任务包措辞且不改变分组', async () => {
    let mergePrompt = ''
    const result: CandidateAggregationResult = await aggregateCandidateRequirements([
      candidate({ clauseNo: '4.1', score: 90 }),
      candidate({ clauseNo: '4.2', action: '门岗值守人员每班核对访客登记完整性', score: 78 }),
    ], {
      candidateMinScore: 60,
      taskMinScore: 75,
      maxPackages: 12,
      aiCaller: async (prompt) => {
        mergePrompt = prompt
        return JSON.stringify({
          taskPackages: packageIdsFromPrompt(prompt).map((packageId) => ({
            packageId,
            title: '门岗访客登记核验工作包',
            description: '门岗值守人员每日核验访客身份、登记进出信息，并按班次检查记录完整性。',
            submitRequirement: '提交访客登记台账和门岗系统截图。',
            taskType: 'INSPECTION_FILL',
            requiredMaterials: ['访客登记台账', '门岗系统截图'],
          })),
        })
      },
    })

    expect(mergePrompt).toContain('candidateRequirements')
    expect(mergePrompt).toContain('严禁改变 packageId')
    expect(result.taskPackages).toHaveLength(1)
    expect(result.taskPackages[0]).toMatchObject({
      title: '门岗访客登记核验工作包',
      mergeMode: 'LLM_MERGED',
      candidateIndexes: [0, 1],
    })
    expect(result.drafts).toHaveLength(2)
    expect(new Set(result.drafts.map((draft) => draft.taskDrafts[0].title))).toEqual(new Set(['门岗访客登记核验工作包']))
  })
})
