import { describe, expect, it } from 'vitest'
import { parseByRule } from '../src/standard-execution/parseRule.js'
import { ruleDraftsToCandidateRequirements } from '../src/standard-execution/ruleCandidateAdapter.js'

describe('T14-4 rule candidate adapter', () => {
  it('把 RULE drafts 转成 candidate-like 输入，并保留默认高分与合并理由', () => {
    const drafts = parseByRule(`
4.1 门岗值守人员应每日检查访客登记记录并留存门岗系统截图。
4.2 保安员应每季度参加岗位培训和应急处置考核，考核记录应保存不少于一年。
4.3 发现隐患后应及时整改并复查闭环。
`)

    const candidates = ruleDraftsToCandidateRequirements(drafts)

    expect(candidates).toHaveLength(3)
    expect(candidates[0]).toMatchObject({
      clauseNo: '4.1',
      responsibleRole: '门岗值守人员',
      suggestedTaskType: 'INSPECTION_FILL',
      frequency: '每日',
      mergeable: true,
    })
    expect(candidates[1]).toMatchObject({
      suggestedTaskType: 'TRAINING',
      frequency: '每季度',
    })
    expect(candidates[2]).toMatchObject({
      suggestedTaskType: 'RECTIFICATION',
      riskLevel: 'HIGH',
    })
    expect(candidates.every((candidate) => candidate.score >= 75)).toBe(true)
    expect(candidates.every((candidate) => candidate.mergeReason?.includes('覆盖报告'))).toBe(true)
  })
})
