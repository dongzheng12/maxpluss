/**
 * 工作台 v2 派发/草稿的 commit payload 构建（纯逻辑，vitest 重点覆盖）。
 *
 * 难点：现有 commit 端点一次只能携带一组 reviewerId / assigneeIds / deadline（契约 §9）。
 * 多选派发时，选中卡可能带不同（审核人, 截止），需按该元组分组，每组拆一次 commit。
 * 执行人（assigneeIds）在本批次按"派发时统一指定"处理（单卡可多执行人）。
 */
import type { SeDeadlineMode, TaskCardV2, TaskGenerationDraft } from '../../../api/standardExecution'
import type { WorkbenchModel } from './model'

/** 单卡派发配置（审核人 + 截止）；执行人在 shared 里统一指定 */
export interface DispatchConfig {
  reviewerId: string | null
  deadlineMode: SeDeadlineMode
  deadlineDaysAfterApproval: number | null
  deadlineAt: string | null
}

export interface CommitBatch {
  sourceId: string | null
  parseMode: string
  taskStatus: 'DRAFT' | 'PENDING_APPROVAL'
  reviewerId: string | null
  assigneeIds: string[]
  deadlineMode: SeDeadlineMode
  deadlineDaysAfterApproval: number | null
  deadlineAt: string | null
  drafts: TaskGenerationDraft[]
  /** 溯源：本批包含哪些卡 */
  cardIds: string[]
}

export interface BuildCommitResult {
  batches: CommitBatch[]
  warnings: string[]
}

function cardToTaskDraft(card: TaskCardV2) {
  return {
    taskDraftId: card.taskDraftId,
    groupId: card.groupId,
    title: card.title,
    description: card.description,
    taskType: card.taskType,
    submitRequirement: card.submitRequirement,
  }
}

/** 把若干卡按所属 draft 聚合回 commit 用的 drafts（taskDrafts 只含这些卡） */
export function buildDraftsFromCards(model: WorkbenchModel, cards: TaskCardV2[]): TaskGenerationDraft[] {
  const order: string[] = []
  const byDraft = new Map<string, TaskCardV2[]>()
  for (const c of cards) {
    if (!byDraft.has(c.draftId)) {
      byDraft.set(c.draftId, [])
      order.push(c.draftId)
    }
    byDraft.get(c.draftId)!.push(c)
  }
  return order.map((draftId) => {
    const cs = byDraft.get(draftId)!
    const meta = model.draftMeta[draftId]
    const first = cs[0]
    return {
      draftId,
      clauseNo: meta?.clauseNo ?? first.basis.clauseNo ?? null,
      title: (meta?.title || first.title || '未命名要求').trim(),
      requirementText: (meta?.requirementText || first.basis.excerpt || first.title || '—').trim(),
      recommendedTaskType: meta?.recommendedTaskType ?? null,
      executionDescription: meta?.executionDescription ?? null,
      requiredMaterials: meta?.requiredMaterials ?? null,
      taskDrafts: cs.map(cardToTaskDraft),
    }
  })
}

function deadlineKey(d: DispatchConfig): string {
  return d.deadlineMode === 'AFTER_APPROVAL_DAYS'
    ? `AAD:${d.deadlineDaysAfterApproval ?? ''}`
    : `FIX:${d.deadlineAt ?? ''}`
}

/** 分组键 = (审核人, 截止)。assigneeIds 派发时统一，不进键。 */
export function dispatchGroupKey(d: DispatchConfig): string {
  return `${d.reviewerId ?? ''}|${deadlineKey(d)}`
}

/**
 * 多选派发：按 (审核人, 截止) 分组，每组拆一次 PENDING_APPROVAL commit。
 * - 未选卡 → 空 batches + warning
 * - 选中卡缺审核人（无 dispatch 且无 defaultDispatch.reviewerId）→ 不纳入，记 warning
 * - assigneeIds 为空 → warning（调用方据此拦截）
 * - 同一 draft 的卡被拆到不同组 → warning（契约 §9：会生成多条执行要求）
 */
export function buildCommitBatches(
  model: WorkbenchModel,
  cardIds: string[],
  dispatchByCardId: Record<string, DispatchConfig>,
  shared: { assigneeIds: string[]; defaultDispatch?: DispatchConfig },
): BuildCommitResult {
  const warnings: string[] = []
  const selected = cardIds
    .map((id) => model.cards.find((c) => c.id === id))
    .filter((c): c is TaskCardV2 => !!c)

  if (selected.length === 0) {
    return { batches: [], warnings: ['未选择任何任务卡'] }
  }
  if (shared.assigneeIds.length === 0) {
    warnings.push('未选择执行人')
  }

  const order: string[] = []
  const groups = new Map<string, { dispatch: DispatchConfig; cards: TaskCardV2[] }>()
  let missingReviewer = 0

  for (const card of selected) {
    const dispatch = dispatchByCardId[card.id] ?? shared.defaultDispatch
    if (!dispatch || !dispatch.reviewerId) {
      missingReviewer += 1
      continue
    }
    const key = dispatchGroupKey(dispatch)
    if (!groups.has(key)) {
      groups.set(key, { dispatch, cards: [] })
      order.push(key)
    }
    groups.get(key)!.cards.push(card)
  }

  if (missingReviewer > 0) {
    warnings.push(`${missingReviewer} 张卡未设置审核人，未纳入派发`)
  }

  const batches: CommitBatch[] = order.map((key) => {
    const g = groups.get(key)!
    return {
      sourceId: model.source?.id ?? null,
      parseMode: model.parseMode,
      taskStatus: 'PENDING_APPROVAL',
      reviewerId: g.dispatch.reviewerId,
      assigneeIds: shared.assigneeIds,
      deadlineMode: g.dispatch.deadlineMode,
      deadlineDaysAfterApproval:
        g.dispatch.deadlineMode === 'AFTER_APPROVAL_DAYS' ? g.dispatch.deadlineDaysAfterApproval : null,
      deadlineAt: g.dispatch.deadlineMode === 'FIXED' ? g.dispatch.deadlineAt : null,
      drafts: buildDraftsFromCards(model, g.cards),
      cardIds: g.cards.map((c) => c.id),
    }
  })

  // 契约 §9：同一 draft 的卡被拆到不同审核人/截止分组 → 会生成多条执行要求
  const draftToBatch = new Map<string, Set<number>>()
  batches.forEach((b, i) => {
    for (const d of b.drafts) {
      const id = d.draftId || ''
      if (!draftToBatch.has(id)) draftToBatch.set(id, new Set())
      draftToBatch.get(id)!.add(i)
    }
  })
  const split = [...draftToBatch.values()].filter((s) => s.size > 1).length
  if (split > 0) {
    warnings.push(`${split} 条执行要求被拆到不同审核人/截止分组，将各自生成执行要求（契约 §9）`)
  }

  return { batches, warnings }
}

/**
 * 保存草稿：DRAFT commit，零校验（契约 §9 不要求审核人/执行人/截止）。
 * - cardIds 未传：保留老调用语义，提交全部卡。
 * - cardIds 已传：只提交用户实际勾选的卡；显式空选不回退全量。
 */
export function buildDraftPayload(model: WorkbenchModel, cardIds?: string[]): CommitBatch | null {
  const cards = Array.isArray(cardIds)
    ? cardIds
        .map((id) => model.cards.find((c) => c.id === id))
        .filter((c): c is TaskCardV2 => !!c)
    : model.cards
  if (cards.length === 0) return null
  return {
    sourceId: model.source?.id ?? null,
    parseMode: model.parseMode,
    taskStatus: 'DRAFT',
    reviewerId: null,
    assigneeIds: [],
    deadlineMode: 'AFTER_APPROVAL_DAYS',
    deadlineDaysAfterApproval: 7,
    deadlineAt: null,
    drafts: buildDraftsFromCards(model, cards),
    cardIds: cards.map((c) => c.id),
  }
}

/** 把 CommitBatch 转成实际 commit API body（DRAFT 不带审核人/执行人/截止） */
export function batchToCommitBody(batch: CommitBatch): Record<string, unknown> {
  const base: Record<string, unknown> = {
    sourceId: batch.sourceId,
    parseMode: batch.parseMode,
    taskStatus: batch.taskStatus,
    drafts: batch.drafts,
    cardIds: batch.cardIds,
  }
  if (batch.taskStatus === 'PENDING_APPROVAL') {
    base.reviewerId = batch.reviewerId
    base.assigneeIds = batch.assigneeIds
    base.deadlineMode = batch.deadlineMode
    base.deadlineDaysAfterApproval = batch.deadlineDaysAfterApproval
    if (batch.deadlineAt) base.deadlineAt = batch.deadlineAt
  }
  return base
}
