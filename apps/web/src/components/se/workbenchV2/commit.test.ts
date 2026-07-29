import { describe, expect, it } from 'vitest'
import {
  batchToCommitBody,
  buildCommitBatches,
  buildDraftPayload,
  buildDraftsFromCards,
  dispatchGroupKey,
  type DispatchConfig,
} from './commit'
import type { WorkbenchModel, DraftMetaEntry } from './model'
import type { TaskCardV2 } from '../../../api/standardExecution'

function card(id: string, draftId: string, overrides: Partial<TaskCardV2> = {}): TaskCardV2 {
  return {
    id,
    draftId,
    taskDraftId: id,
    groupId: draftId,
    title: `任务 ${id}`,
    description: `说明 ${id}`,
    submitRequirement: `提交 ${id}`,
    taskType: 'INSPECTION_FILL',
    requiredMaterials: [],
    deadlineSuggestion: { mode: 'AFTER_APPROVAL_DAYS', daysAfterApproval: 30, fixedAt: null, label: '', reason: null },
    basis: { sourceId: 'src', sourceTitle: '标准', clauseNo: '1.1', excerpt: `原文 ${id}` },
    polishStatus: 'AI_POLISHED',
    warnings: [],
    ...overrides,
  }
}

function meta(draftId: string): DraftMetaEntry {
  return {
    draftId,
    title: `要求 ${draftId}`,
    clauseNo: '1.1',
    requirementText: `要求正文 ${draftId}`,
    recommendedTaskType: 'INSPECTION_FILL',
    executionDescription: null,
    requiredMaterials: [],
  }
}

function model(cards: TaskCardV2[]): WorkbenchModel {
  const draftMeta: Record<string, DraftMetaEntry> = {}
  for (const c of cards) draftMeta[c.draftId] = meta(c.draftId)
  return {
    source: { id: 'src', title: '标准', sourceNo: null, sourceType: 'X', version: null },
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

const AAD = (reviewerId: string | null, days: number): DispatchConfig => ({
  reviewerId,
  deadlineMode: 'AFTER_APPROVAL_DAYS',
  deadlineDaysAfterApproval: days,
  deadlineAt: null,
})
const FIX = (reviewerId: string | null, at: string): DispatchConfig => ({
  reviewerId,
  deadlineMode: 'FIXED',
  deadlineDaysAfterApproval: null,
  deadlineAt: at,
})

describe('buildDraftsFromCards', () => {
  it('同 draft 多卡聚合，taskDrafts 只含传入卡，保持顺序', () => {
    const m = model([card('a', 'd1'), card('b', 'd1'), card('c', 'd2')])
    const drafts = buildDraftsFromCards(m, m.cards)
    expect(drafts).toHaveLength(2)
    expect(drafts[0].draftId).toBe('d1')
    expect(drafts[0].taskDrafts).toHaveLength(2)
    expect(drafts[0].taskDrafts!.map((t) => t.taskDraftId)).toEqual(['a', 'b'])
    expect(drafts[0].title).toBe('要求 d1') // 取 draftMeta.title
    expect(drafts[1].draftId).toBe('d2')
  })

  it('只传部分卡时，taskDrafts 不含未传卡', () => {
    const m = model([card('a', 'd1'), card('b', 'd1')])
    const drafts = buildDraftsFromCards(m, [m.cards[0]])
    expect(drafts[0].taskDrafts).toHaveLength(1)
    expect(drafts[0].taskDrafts![0].taskDraftId).toBe('a')
  })

  it('requirementText 缺 meta 时兜底 excerpt，不为空', () => {
    const m = model([card('a', 'd1')])
    m.draftMeta = {} // 抹掉 meta
    const drafts = buildDraftsFromCards(m, m.cards)
    expect(drafts[0].requirementText).toBe('原文 a')
    expect(drafts[0].title).toBe('任务 a')
  })
})

describe('buildCommitBatches —— 分组难点', () => {
  it('空选 → 空 batches + warning', () => {
    const m = model([card('a', 'd1')])
    const r = buildCommitBatches(m, [], {}, { assigneeIds: ['u1'] })
    expect(r.batches).toHaveLength(0)
    expect(r.warnings).toContain('未选择任何任务卡')
  })

  it('跨组多选：不同审核人 + 不同截止 → 拆成多 batch', () => {
    const m = model([card('a', 'd1'), card('b', 'd2'), card('c', 'd3')])
    const dispatch = {
      a: AAD('r1', 30),
      b: AAD('r1', 30), // 与 a 同组
      c: AAD('r2', 30), // 不同审核人 → 另一组
    }
    const r = buildCommitBatches(m, ['a', 'b', 'c'], dispatch, { assigneeIds: ['u1'] })
    expect(r.batches).toHaveLength(2)
    const g1 = r.batches.find((b) => b.reviewerId === 'r1')!
    const g2 = r.batches.find((b) => b.reviewerId === 'r2')!
    expect(g1.cardIds.sort()).toEqual(['a', 'b'])
    expect(g2.cardIds).toEqual(['c'])
    expect(g1.taskStatus).toBe('PENDING_APPROVAL')
  })

  it('同审核人但不同截止 → 拆两组', () => {
    const m = model([card('a', 'd1'), card('b', 'd2')])
    const r = buildCommitBatches(m, ['a', 'b'], { a: AAD('r1', 30), b: AAD('r1', 90) }, { assigneeIds: ['u1'] })
    expect(r.batches).toHaveLength(2)
  })

  it('FIXED 截止按 fixedAt 分组', () => {
    const m = model([card('a', 'd1'), card('b', 'd2')])
    const r = buildCommitBatches(m, ['a', 'b'], { a: FIX('r1', '2026-07-01'), b: FIX('r1', '2026-08-01') }, { assigneeIds: ['u1'] })
    expect(r.batches).toHaveLength(2)
    expect(r.batches[0].deadlineMode).toBe('FIXED')
    expect(r.batches[0].deadlineAt).toBe('2026-07-01')
    expect(r.batches[0].deadlineDaysAfterApproval).toBeNull()
  })

  it('单卡多执行人：assigneeIds 原样进每个 batch', () => {
    const m = model([card('a', 'd1')])
    const r = buildCommitBatches(m, ['a'], { a: AAD('r1', 30) }, { assigneeIds: ['u1', 'u2', 'u3'] })
    expect(r.batches[0].assigneeIds).toEqual(['u1', 'u2', 'u3'])
  })

  it('缺审核人的卡不纳入派发并 warning（空组场景）', () => {
    const m = model([card('a', 'd1'), card('b', 'd2')])
    // a 有审核人，b 无 dispatch 且无 default
    const r = buildCommitBatches(m, ['a', 'b'], { a: AAD('r1', 30) }, { assigneeIds: ['u1'] })
    expect(r.batches).toHaveLength(1)
    expect(r.batches[0].cardIds).toEqual(['a'])
    expect(r.warnings.some((w) => w.includes('未设置审核人'))).toBe(true)
  })

  it('全部缺审核人 → 空 batches', () => {
    const m = model([card('a', 'd1')])
    const r = buildCommitBatches(m, ['a'], {}, { assigneeIds: ['u1'] })
    expect(r.batches).toHaveLength(0)
    expect(r.warnings.some((w) => w.includes('未设置审核人'))).toBe(true)
  })

  it('defaultDispatch 兜底无 per-card 配置的卡', () => {
    const m = model([card('a', 'd1'), card('b', 'd2')])
    const r = buildCommitBatches(m, ['a', 'b'], {}, { assigneeIds: ['u1'], defaultDispatch: AAD('r9', 30) })
    expect(r.batches).toHaveLength(1)
    expect(r.batches[0].reviewerId).toBe('r9')
    expect(r.batches[0].cardIds.sort()).toEqual(['a', 'b'])
  })

  it('执行人为空 → warning（调用方拦截）', () => {
    const m = model([card('a', 'd1')])
    const r = buildCommitBatches(m, ['a'], { a: AAD('r1', 30) }, { assigneeIds: [] })
    expect(r.warnings).toContain('未选择执行人')
  })

  it('同一 draft 的两卡被拆到不同组 → 契约 §9 warning + 两组各带该 draft', () => {
    const m = model([card('a', 'd1'), card('b', 'd1')]) // 同 draft d1
    const r = buildCommitBatches(m, ['a', 'b'], { a: AAD('r1', 30), b: AAD('r2', 30) }, { assigneeIds: ['u1'] })
    expect(r.batches).toHaveLength(2)
    expect(r.batches[0].drafts[0].draftId).toBe('d1')
    expect(r.batches[1].drafts[0].draftId).toBe('d1')
    expect(r.warnings.some((w) => w.includes('§9'))).toBe(true)
  })

  it('忽略不存在的 cardId', () => {
    const m = model([card('a', 'd1')])
    const r = buildCommitBatches(m, ['a', 'ghost'], { a: AAD('r1', 30) }, { assigneeIds: ['u1'] })
    expect(r.batches).toHaveLength(1)
    expect(r.batches[0].cardIds).toEqual(['a'])
  })
})

describe('buildDraftPayload', () => {
  it('全部卡一次 DRAFT，无审核人/执行人', () => {
    const m = model([card('a', 'd1'), card('b', 'd2')])
    const p = buildDraftPayload(m)!
    expect(p.taskStatus).toBe('DRAFT')
    expect(p.reviewerId).toBeNull()
    expect(p.assigneeIds).toEqual([])
    expect(p.drafts).toHaveLength(2)
    expect(p.cardIds).toEqual(['a', 'b'])
  })
  it('显式选 1 张 → DRAFT payload 只含该卡', () => {
    const m = model([card('a', 'd1'), card('b', 'd1'), card('c', 'd2')])
    const p = buildDraftPayload(m, ['b'])!
    expect(p.cardIds).toEqual(['b'])
    expect(p.drafts).toHaveLength(1)
    expect(p.drafts[0].draftId).toBe('d1')
    expect(p.drafts[0].taskDrafts!.map((t) => t.taskDraftId)).toEqual(['b'])
  })
  it('显式选多张 → DRAFT payload 只含选中集', () => {
    const m = model([card('a', 'd1'), card('b', 'd1'), card('c', 'd2')])
    const p = buildDraftPayload(m, ['b', 'c'])!
    expect(p.cardIds).toEqual(['b', 'c'])
    expect(p.drafts).toHaveLength(2)
    expect(p.drafts.flatMap((d) => d.taskDrafts!.map((t) => t.taskDraftId))).toEqual(['b', 'c'])
  })
  it('显式空选 → null，不回退全量', () => {
    expect(buildDraftPayload(model([card('a', 'd1')]), [])).toBeNull()
  })
  it('无卡 → null', () => {
    expect(buildDraftPayload(model([]))).toBeNull()
  })
})

describe('batchToCommitBody', () => {
  it('DRAFT 不带审核人/执行人/截止', () => {
    const body = batchToCommitBody(buildDraftPayload(model([card('a', 'd1')]))!)
    expect(body.taskStatus).toBe('DRAFT')
    expect(body.reviewerId).toBeUndefined()
    expect(body.assigneeIds).toBeUndefined()
    expect(body.deadlineMode).toBeUndefined()
    expect(body.drafts).toBeDefined()
    expect(body.cardIds).toEqual(['a'])
  })
  it('PENDING_APPROVAL 带审核人/执行人/截止', () => {
    const m = model([card('a', 'd1')])
    const r = buildCommitBatches(m, ['a'], { a: AAD('r1', 45) }, { assigneeIds: ['u1', 'u2'] })
    const body = batchToCommitBody(r.batches[0])
    expect(body.reviewerId).toBe('r1')
    expect(body.assigneeIds).toEqual(['u1', 'u2'])
    expect(body.deadlineMode).toBe('AFTER_APPROVAL_DAYS')
    expect(body.deadlineDaysAfterApproval).toBe(45)
  })
})

describe('dispatchGroupKey', () => {
  it('同审核人同截止键相同，不同截止键不同', () => {
    expect(dispatchGroupKey(AAD('r1', 30))).toBe(dispatchGroupKey(AAD('r1', 30)))
    expect(dispatchGroupKey(AAD('r1', 30))).not.toBe(dispatchGroupKey(AAD('r1', 60)))
    expect(dispatchGroupKey(AAD('r1', 30))).not.toBe(dispatchGroupKey(AAD('r2', 30)))
  })
})
