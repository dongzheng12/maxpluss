import { describe, expect, it } from 'vitest'
import {
  applyCardEdit,
  applyRepolishedCards,
  applyRewrittenCard,
  buildModelFromPreview,
  cardStats,
  deadlineLabel,
  deleteCard,
  fallbackCardFromDraft,
  findCard,
  mergeCards,
  promoteCandidateToCard,
  splitCard,
} from './model'
import type { TaskCardV2, TaskGenerationPreviewV2Resp } from '../../../api/standardExecution'
import type { WorkbenchModel } from './model'

const source: TaskGenerationPreviewV2Resp['source'] = {
  id: 'src_1',
  title: '设备维护标准',
  sourceNo: 'EQ-2026',
  sourceType: 'PRODUCT_STANDARD',
  version: '2026',
}

function previewWithCards(): TaskGenerationPreviewV2Resp {
  return {
    source,
    requestedMode: 'OCR_AI',
    parseMode: 'OCR_AI',
    degraded: false,
    degradedReason: null,
    warnings: [],
    rejectedCount: 0,
    polish: {
      enabled: true,
      status: 'SUCCEEDED',
      degraded: false,
      degradedReason: null,
      warnings: [],
      stats: { inputDrafts: 1, outputCards: 1, aiCards: 1, fallbackCards: 0, batches: 1, failedBatches: 0, durationMs: 10 },
    },
    drafts: [
      {
        draftId: 'draft-1',
        groupId: 'draft-1',
        clauseNo: '5.2',
        title: '检查设备完好率',
        requirementText: '5.2 应每月检查关键设备完好率并形成记录。',
        recommendedTaskType: 'INSPECTION_FILL',
        executionDescription: '每月核查关键设备是否完好。',
        submitRequirement: '上传设备检查表。',
        requiredMaterials: ['设备检查表'],
        taskDrafts: [
          {
            taskDraftId: 'task-draft-1',
            groupId: 'draft-1',
            title: '每月检查关键设备完好率',
            description: '核查关键设备是否处于可用状态。',
            taskType: 'INSPECTION_FILL',
            submitRequirement: '上传设备检查表或台账截图。',
          },
        ],
      },
    ],
    taskCards: [
      {
        id: 'task-draft-1',
        draftId: 'draft-1',
        taskDraftId: 'task-draft-1',
        groupId: 'draft-1',
        title: '每月检查关键设备完好率',
        description: '核查关键设备是否处于可用状态。',
        submitRequirement: '上传设备检查表或台账截图。',
        taskType: 'INSPECTION_FILL',
        requiredMaterials: ['设备检查表', '异常整改记录'],
        deadlineSuggestion: {
          mode: 'AFTER_APPROVAL_DAYS',
          daysAfterApproval: 30,
          fixedAt: null,
          label: '审核通过后 30 天内完成',
          reason: '条款要求按月确认设备状态',
        },
        basis: { sourceId: 'src_1', sourceTitle: '设备维护标准', clauseNo: '5.2', excerpt: '5.2 应每月检查关键设备完好率并形成记录。' },
        polishStatus: 'AI_POLISHED',
        warnings: [],
      },
    ],
  }
}

/** polish 降级：只有 drafts、没有 taskCards */
function previewWithoutCards(): TaskGenerationPreviewV2Resp {
  const base = previewWithCards()
  return { ...base, taskCards: undefined, polish: { ...base.polish!, status: 'DEGRADED', degraded: true, degradedReason: 'POLISH_AI_FAILED' } }
}

function previewWithCandidates(): TaskGenerationPreviewV2Resp {
  return {
    ...previewWithCards(),
    candidateV2Enabled: true,
    candidateRequirements: [
      {
        clauseNo: '5.2',
        sourceText: '5.2 应每月检查关键设备完好率并形成记录。',
        action: '每月核查关键设备是否完好',
        responsibleRole: '设备主管',
        evidenceType: '设备检查表',
        frequency: 'MONTHLY',
        riskLevel: 'MEDIUM',
        suggestedTaskType: 'INSPECTION_FILL',
        score: 88,
        mergeable: true,
        mergeReason: '同类检查要求可聚合',
      },
      {
        clauseNo: '5.3',
        sourceText: '5.3 可定期复盘设备异常趋势。',
        action: '复盘设备异常趋势',
        responsibleRole: '设备主管',
        evidenceType: '异常趋势分析',
        frequency: 'MONTHLY',
        riskLevel: 'LOW',
        suggestedTaskType: 'ARCHIVE_MATERIAL',
        score: 66,
        mergeable: true,
        mergeReason: '仅作关联要求',
      },
    ],
    candidateScoreDistribution: {
      total: 2,
      belowTaskThreshold: 0,
      associatedOnly: 1,
      taskEligible: 1,
      buckets: { lt60: 0, s60to74: 1, gte75: 1 },
    },
    candidateThresholds: { candidateMinScore: 60, taskMinScore: 75 },
    taskPackages: [
      {
        packageId: 'pkg-1',
        groupId: 'draft-1',
        key: { taskType: 'INSPECTION_FILL', responsibleRole: '设备主管', evidenceType: '设备检查表' },
        title: '每月检查关键设备完好率',
        description: '核查关键设备是否处于可用状态。',
        submitRequirement: '上传设备检查表。',
        taskType: 'INSPECTION_FILL',
        responsibleRole: '设备主管',
        evidenceType: '设备检查表',
        frequency: 'MONTHLY',
        riskLevel: 'MEDIUM',
        score: 88,
        candidateCount: 1,
        candidateIndexes: [0],
        clauseNos: ['5.2'],
        draftIds: ['draft-1'],
        requiredMaterials: ['设备检查表'],
        mergeMode: 'DETERMINISTIC',
        warnings: [],
      },
    ],
    coverageReport: {
      totalCandidates: 2,
      taskPackageCount: 1,
      candidateOnlyCount: 1,
      entries: [
        {
          candidateIndex: 0,
          clauseNo: '5.2',
          sourceText: '5.2 应每月检查关键设备完好率并形成记录。',
          score: 88,
          destination: 'TASK_PACKAGE',
          packageId: 'pkg-1',
          reason: '进入同硬键任务包',
        },
        {
          candidateIndex: 1,
          clauseNo: '5.3',
          sourceText: '5.3 可定期复盘设备异常趋势。',
          score: 66,
          destination: 'ASSOCIATED_CANDIDATE',
          packageId: null,
          reason: 'score 66 位于关联要求区间',
        },
      ],
    },
  }
}

describe('deadlineLabel', () => {
  it('AFTER_APPROVAL_DAYS 用天数', () => {
    expect(deadlineLabel('AFTER_APPROVAL_DAYS', 30, null)).toBe('审核通过后 30 天内完成')
  })
  it('AFTER_APPROVAL_DAYS 缺天数兜底 7', () => {
    expect(deadlineLabel('AFTER_APPROVAL_DAYS', null, null)).toBe('审核通过后 7 天内完成')
  })
  it('FIXED 有时间显示截止', () => {
    expect(deadlineLabel('FIXED', null, '2026-07-01')).toBe('截止 2026-07-01')
  })
})

describe('buildModelFromPreview', () => {
  it('优先用后端 taskCards', () => {
    const model = buildModelFromPreview(previewWithCards())
    expect(model.cards).toHaveLength(1)
    expect(model.cards[0].polishStatus).toBe('AI_POLISHED')
    expect(model.cards[0].title).toBe('每月检查关键设备完好率')
    expect(model.draftMeta['draft-1'].clauseNo).toBe('5.2')
    expect(model.polish?.status).toBe('SUCCEEDED')
  })

  it('缺 taskCards 时由 drafts 合成 fallback 卡', () => {
    const model = buildModelFromPreview(previewWithoutCards())
    expect(model.cards).toHaveLength(1)
    expect(model.cards[0].polishStatus).toBe('FALLBACK_ORIGINAL')
    expect(model.cards[0].basis.clauseNo).toBe('5.2')
    // fallback title 取 taskDraft.title
    expect(model.cards[0].title).toBe('每月检查关键设备完好率')
  })

  it('补齐 deadlineSuggestion.label 当后端缺失', () => {
    const resp = previewWithCards()
    resp.taskCards![0].deadlineSuggestion.label = ''
    const model = buildModelFromPreview(resp)
    expect(model.cards[0].deadlineSuggestion.label).toBe('审核通过后 30 天内完成')
  })

  it('保留候选要求、任务包和覆盖报告证据', () => {
    const model = buildModelFromPreview(previewWithCandidates())
    expect(model.candidateV2Enabled).toBe(true)
    expect(model.candidateRequirements).toHaveLength(2)
    expect(model.candidateScoreDistribution?.buckets.s60to74).toBe(1)
    expect(model.candidateThresholds?.taskMinScore).toBe(75)
    expect(model.taskPackages[0].packageId).toBe('pkg-1')
    expect(model.coverageReport?.candidateOnlyCount).toBe(1)
  })
})

describe('fallbackCardFromDraft', () => {
  it('submitRequirement 缺失走默认兜底文案', () => {
    const card = fallbackCardFromDraft(
      { draftId: 'd9', title: '标题', requirementText: '正文', taskDrafts: [] },
      source,
      0,
    )
    expect(card.submitRequirement).toContain('记录、照片、台账')
    expect(card.taskType).toBe('OTHER')
    expect(card.basis.excerpt).toBe('正文')
  })
})

describe('applyCardEdit', () => {
  it('改标题/类型不可变更新，不影响原对象', () => {
    const model = buildModelFromPreview(previewWithCards())
    const next = applyCardEdit(model, 'task-draft-1', { title: '改后标题', taskType: 'TRAINING' })
    expect(next.cards[0].title).toBe('改后标题')
    expect(next.cards[0].taskType).toBe('TRAINING')
    expect(model.cards[0].title).toBe('每月检查关键设备完好率') // 原对象不变
    expect(next).not.toBe(model)
  })

  it('改截止模式重算 label', () => {
    const model = buildModelFromPreview(previewWithCards())
    const next = applyCardEdit(model, 'task-draft-1', {
      deadlineSuggestion: { mode: 'AFTER_APPROVAL_DAYS', daysAfterApproval: 15 },
    })
    expect(next.cards[0].deadlineSuggestion.label).toBe('审核通过后 15 天内完成')
  })

  it('未命中 cardId 时原样返回', () => {
    const model = buildModelFromPreview(previewWithCards())
    const next = applyCardEdit(model, 'nope', { title: 'x' })
    expect(next.cards[0].title).toBe('每月检查关键设备完好率')
  })
})

describe('deleteCard', () => {
  it('删卡并清理无引用 draftMeta', () => {
    const model = buildModelFromPreview(previewWithCards())
    const next = deleteCard(model, 'task-draft-1')
    expect(next.cards).toHaveLength(0)
    expect(Object.keys(next.draftMeta)).toHaveLength(0) // draft-1 无 card 引用被清
  })

  it('同 draft 多卡时删一张不清 draftMeta', () => {
    const model = buildModelFromPreview(previewWithCards())
    // 手动加一张同 draft 的卡
    const extra = { ...model.cards[0], id: 'task-draft-2', taskDraftId: 'task-draft-2' }
    const two = { ...model, cards: [...model.cards, extra] }
    const next = deleteCard(two, 'task-draft-1')
    expect(next.cards).toHaveLength(1)
    expect(next.draftMeta['draft-1']).toBeDefined()
  })
})

function mkCard(id: string, draftId: string, over: Partial<TaskCardV2> = {}): TaskCardV2 {
  return {
    id,
    draftId,
    taskDraftId: id,
    groupId: draftId,
    title: `任务${id}`,
    description: `说明${id}`,
    submitRequirement: `提交${id}`,
    taskType: 'INSPECTION_FILL',
    requiredMaterials: [`材料${id}`],
    deadlineSuggestion: { mode: 'AFTER_APPROVAL_DAYS', daysAfterApproval: 30, fixedAt: null, label: '', reason: null },
    basis: { sourceId: 's', sourceTitle: 't', clauseNo: '1.1', excerpt: '' },
    polishStatus: 'AI_POLISHED',
    warnings: [],
    ...over,
  }
}

function mkModel(cards: TaskCardV2[]): WorkbenchModel {
  const draftMeta: WorkbenchModel['draftMeta'] = {}
  for (const c of cards) {
    draftMeta[c.draftId] = {
      draftId: c.draftId,
      title: `要求${c.draftId}`,
      clauseNo: '1.1',
      requirementText: `正文${c.draftId}`,
      recommendedTaskType: null,
      executionDescription: null,
      requiredMaterials: [],
    }
  }
  return {
    source: null,
    requestedMode: 'OCR_AI',
    parseMode: 'OCR_AI',
    degraded: false,
    degradedReason: null,
    warnings: [],
    cards,
    draftMeta,
    polish: null,
    candidateV2Enabled: false,
    candidateRequirements: [],
    candidateScoreDistribution: null,
    candidateThresholds: null,
    taskPackages: [],
    coverageReport: null,
  }
}

describe('mergeCards', () => {
  it('合并 ≥2 张：说明换行拼接、材料并集，落到首卡位置', () => {
    const m = mkModel([mkCard('a', 'd1'), mkCard('b', 'd2'), mkCard('c', 'd3')])
    const next = mergeCards(m, ['a', 'c'])
    expect(next.cards.map((x) => x.id)).toEqual(['a', 'b']) // c 合入 a
    const merged = next.cards[0]
    expect(merged.description).toBe('说明a\n说明c')
    expect(merged.requiredMaterials).toEqual(['材料a', '材料c'])
  })

  it('合并清理无引用 draftMeta（d3 被并掉）', () => {
    const m = mkModel([mkCard('a', 'd1'), mkCard('c', 'd3')])
    const next = mergeCards(m, ['a', 'c'])
    expect(next.cards).toHaveLength(1)
    expect(next.draftMeta['d3']).toBeUndefined()
    expect(next.draftMeta['d1']).toBeDefined()
  })

  it('任一为 fallback 则合并卡 polishStatus=FALLBACK', () => {
    const m = mkModel([mkCard('a', 'd1'), mkCard('b', 'd2', { polishStatus: 'FALLBACK_ORIGINAL' })])
    expect(mergeCards(m, ['a', 'b']).cards[0].polishStatus).toBe('FALLBACK_ORIGINAL')
  })

  it('<2 张原样返回', () => {
    const m = mkModel([mkCard('a', 'd1')])
    expect(mergeCards(m, ['a'])).toBe(m)
  })
})

describe('splitCard', () => {
  it('拆出副本：新 id/新 groupId、同 draftId、紧随原卡', () => {
    const m = mkModel([mkCard('a', 'd1'), mkCard('b', 'd2')])
    const next = splitCard(m, 'a')
    expect(next.cards).toHaveLength(3)
    expect(next.cards[0].id).toBe('a')
    const copy = next.cards[1]
    expect(copy.id).not.toBe('a')
    expect(copy.draftId).toBe('d1') // 同执行要求
    expect(copy.groupId).not.toBe('d1') // 独立任务
    expect(copy.title).toContain('拆分')
  })

  it('不存在的卡原样返回', () => {
    const m = mkModel([mkCard('a', 'd1')])
    expect(splitCard(m, 'x')).toBe(m)
  })

  it('副本 id 不与现有冲突', () => {
    const m = mkModel([mkCard('a', 'd1'), mkCard('a-s2', 'd2')])
    const next = splitCard(m, 'a')
    const ids = next.cards.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length) // 全唯一
  })
})

describe('applyRewrittenCard', () => {
  it('按 id 替换同位置卡，不动其它卡', () => {
    const m = mkModel([mkCard('a', 'd1'), mkCard('b', 'd2')])
    const rewritten = mkCard('a', 'd1', { title: 'AI 重写后', polishStatus: 'AI_POLISHED' })
    const next = applyRewrittenCard(m, rewritten)
    expect(next.cards[0].title).toBe('AI 重写后')
    expect(next.cards[1].title).toBe('任务b') // 其它卡不变
    expect(next.cards.map((c) => c.id)).toEqual(['a', 'b']) // 位置不变
  })
  it('未命中 id 时全卡不变', () => {
    const m = mkModel([mkCard('a', 'd1')])
    const next = applyRewrittenCard(m, mkCard('x', 'd9', { title: 'no' }))
    expect(next.cards[0].title).toBe('任务a')
  })
})

describe('applyRepolishedCards', () => {
  it('按 id 批量替换，顺序不变，未命中保持原样', () => {
    const m = mkModel([mkCard('a', 'd1'), mkCard('b', 'd2'), mkCard('c', 'd3')])
    const next = applyRepolishedCards(m, [
      mkCard('a', 'd1', { title: '优化a' }),
      mkCard('c', 'd3', { title: '优化c' }),
    ])
    expect(next.cards.map((c) => c.title)).toEqual(['优化a', '任务b', '优化c'])
    expect(next.cards.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('promoteCandidateToCard', () => {
  it('把未成任务候选提升为本地任务卡，并补 draftMeta', () => {
    const model = buildModelFromPreview(previewWithCandidates())
    const next = promoteCandidateToCard(model, 1)
    expect(next.cards).toHaveLength(model.cards.length + 1)
    const promoted = next.cards[next.cards.length - 1]
    expect(promoted.draftId).toBe('candidate-2')
    expect(promoted.title).toBe('复盘设备异常趋势')
    expect(promoted.taskType).toBe('ARCHIVE_MATERIAL')
    expect(promoted.requiredMaterials).toEqual(['异常趋势分析'])
    expect(promoted.basis.clauseNo).toBe('5.3')
    expect(next.draftMeta['candidate-2'].requirementText).toContain('异常趋势')
  })

  it('同一候选重复提升时不生成重复卡', () => {
    const model = buildModelFromPreview(previewWithCandidates())
    const once = promoteCandidateToCard(model, 1)
    const twice = promoteCandidateToCard(once, 1)
    expect(twice.cards).toHaveLength(once.cards.length)
  })

  it('候选索引不存在时原样返回', () => {
    const model = buildModelFromPreview(previewWithCandidates())
    expect(promoteCandidateToCard(model, 99)).toBe(model)
  })
})

describe('findCard / cardStats', () => {
  it('findCard 命中', () => {
    const model = buildModelFromPreview(previewWithCards())
    expect(findCard(model, 'task-draft-1')?.title).toBe('每月检查关键设备完好率')
    expect(findCard(model, 'x')).toBeUndefined()
  })
  it('cardStats 统计 AI/fallback', () => {
    const model = buildModelFromPreview(previewWithCards())
    const extra = { ...model.cards[0], id: 'c2', polishStatus: 'FALLBACK_ORIGINAL' as const }
    const stats = cardStats([...model.cards, extra])
    expect(stats).toEqual({ total: 2, aiPolished: 1, fallback: 1 })
  })
})
