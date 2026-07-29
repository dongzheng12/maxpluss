/**
 * 工作台 v2 纯逻辑层（无 React / 无 antd 依赖，可被 vitest node 环境直接测）。
 *
 * 设计：cards 是用户可编辑字段的唯一来源；draftMeta 保存 preview 给的不可编辑
 * draft 元信息（条款号 / 要求正文 / 推荐类型等），commit 时按 cards + draftMeta 重建
 * drafts payload。这样避免 cards/drafts 双写不同步。
 *
 * 契约：必读/archive/tasks/v2-ai-task-polish-api-contract-2026-06-05.md
 */
import type {
  CandidateRequirement,
  CandidateScoreDistribution,
  PolishSummary,
  SeDeadlineMode,
  TaskCardV2,
  TaskGenerationCandidateThresholds,
  TaskGenerationCoverageReport,
  TaskGenerationDraft,
  TaskGenerationTaskPackage,
  TaskGenerationPreviewV2Resp,
} from '../../../api/standardExecution'

export interface DraftMetaEntry {
  draftId: string
  title: string
  clauseNo: string | null
  requirementText: string
  recommendedTaskType: string | null
  executionDescription: string | null
  requiredMaterials: string[]
}

export interface WorkbenchModel {
  source: TaskGenerationPreviewV2Resp['source']
  requestedMode: string
  parseMode: string
  degraded: boolean
  degradedReason: string | null
  warnings: string[]
  cards: TaskCardV2[]
  draftMeta: Record<string, DraftMetaEntry>
  polish: PolishSummary | null
  candidateV2Enabled: boolean
  candidateRequirements: CandidateRequirement[]
  candidateScoreDistribution: CandidateScoreDistribution | null
  candidateThresholds: TaskGenerationCandidateThresholds | null
  taskPackages: TaskGenerationTaskPackage[]
  coverageReport: TaskGenerationCoverageReport | null
}

/** 单卡可编辑字段补丁（仅这些字段允许用户改） */
export type CardEditablePatch = Partial<
  Pick<TaskCardV2, 'title' | 'taskType' | 'description' | 'submitRequirement' | 'requiredMaterials'>
> & {
  deadlineSuggestion?: Partial<TaskCardV2['deadlineSuggestion']>
}

const DEFAULT_FALLBACK_SUBMIT = '请提交与本条款执行相关的记录、照片、台账或说明材料。'

export function emptyModel(): WorkbenchModel {
  return {
    source: null,
    requestedMode: 'OCR_AI',
    parseMode: 'OCR_AI',
    degraded: false,
    degradedReason: null,
    warnings: [],
    cards: [],
    draftMeta: {},
    polish: null,
    candidateV2Enabled: false,
    candidateRequirements: [],
    candidateScoreDistribution: null,
    candidateThresholds: null,
    taskPackages: [],
    coverageReport: null,
  }
}

/** 截止建议人话标签（fallback 合成 / 缺 label 时兜底） */
export function deadlineLabel(mode: SeDeadlineMode, daysAfterApproval: number | null, fixedAt: string | null): string {
  if (mode === 'AFTER_APPROVAL_DAYS') {
    const days = daysAfterApproval ?? 7
    return `审核通过后 ${days} 天内完成`
  }
  return fixedAt ? `截止 ${fixedAt}` : '固定截止时间'
}

function frequencyToDays(freq: string | null | undefined): number {
  switch (freq) {
    case 'MONTHLY':
      return 30
    case 'QUARTERLY':
      return 90
    case 'YEARLY':
      return 365
    default:
      return 7
  }
}

/**
 * 由单个 draft 合成 fallback 任务卡（契约 §7 fallback 规则）。
 * 用于 polish 未返回 taskCards 时的客户端兜底，以及本地 mock。
 */
export function fallbackCardFromDraft(
  draft: TaskGenerationDraft,
  source: TaskGenerationPreviewV2Resp['source'],
  index: number,
): TaskCardV2 {
  const draftId = draft.draftId || `draft-${index + 1}`
  const taskDraft = draft.taskDrafts?.[0]
  const taskDraftId = taskDraft?.taskDraftId || `task-${draftId}`
  const groupId = (taskDraft?.groupId || draft.groupId || draftId) as string
  const days = frequencyToDays((draft as { suggestedFrequency?: string | null }).suggestedFrequency)
  return {
    id: taskDraftId,
    draftId,
    taskDraftId,
    groupId,
    title: (taskDraft?.title || draft.title || draft.requirementText || '未命名任务').trim(),
    description: (taskDraft?.description || draft.executionDescription || draft.requirementText || '').trim(),
    submitRequirement: (taskDraft?.submitRequirement || draft.submitRequirement || DEFAULT_FALLBACK_SUBMIT).trim(),
    taskType: (taskDraft?.taskType || draft.recommendedTaskType || 'OTHER') as string,
    requiredMaterials: draft.requiredMaterials?.filter(Boolean) || [],
    deadlineSuggestion: {
      mode: 'AFTER_APPROVAL_DAYS',
      daysAfterApproval: days,
      fixedAt: null,
      label: deadlineLabel('AFTER_APPROVAL_DAYS', days, null),
      reason: null,
    },
    basis: {
      sourceId: source?.id ?? null,
      sourceTitle: source?.title ?? null,
      clauseNo: draft.clauseNo ?? null,
      excerpt: (draft.requirementText || '').slice(0, 600),
    },
    polishStatus: 'FALLBACK_ORIGINAL',
    warnings: [],
  }
}

function draftMetaFromDraft(draft: TaskGenerationDraft, index: number): DraftMetaEntry {
  return {
    draftId: draft.draftId || `draft-${index + 1}`,
    title: draft.title || '',
    clauseNo: draft.clauseNo ?? null,
    requirementText: draft.requirementText || '',
    recommendedTaskType: draft.recommendedTaskType ?? null,
    executionDescription: draft.executionDescription ?? null,
    requiredMaterials: draft.requiredMaterials?.filter(Boolean) || [],
  }
}

/** 把 preview 响应转成工作台模型：优先用后端 taskCards，缺失则由 drafts 客户端合成 */
export function buildModelFromPreview(resp: TaskGenerationPreviewV2Resp): WorkbenchModel {
  const drafts = resp.drafts || []
  const draftMeta: Record<string, DraftMetaEntry> = {}
  drafts.forEach((draft, index) => {
    const meta = draftMetaFromDraft(draft, index)
    draftMeta[meta.draftId] = meta
  })
  const cards =
    resp.taskCards && resp.taskCards.length > 0
      ? resp.taskCards.map(normalizeCard)
      : drafts.map((draft, index) => fallbackCardFromDraft(draft, resp.source, index))
  return {
    source: resp.source,
    requestedMode: resp.requestedMode || resp.parseMode || 'OCR_AI',
    parseMode: resp.parseMode || resp.requestedMode || 'OCR_AI',
    degraded: !!resp.degraded,
    degradedReason: resp.degradedReason ?? null,
    warnings: resp.warnings || [],
    cards,
    draftMeta,
    polish: resp.polish ?? null,
    candidateV2Enabled: !!resp.candidateV2Enabled,
    candidateRequirements: resp.candidateRequirements || [],
    candidateScoreDistribution: resp.candidateScoreDistribution ?? null,
    candidateThresholds: resp.candidateThresholds ?? null,
    taskPackages: resp.taskPackages || [],
    coverageReport: resp.coverageReport ?? null,
  }
}

/** 补齐可空字段，保证渲染/编辑安全 */
function normalizeCard(card: TaskCardV2): TaskCardV2 {
  return {
    ...card,
    requiredMaterials: card.requiredMaterials || [],
    warnings: card.warnings || [],
    deadlineSuggestion: {
      ...card.deadlineSuggestion,
      label:
        card.deadlineSuggestion?.label ||
        deadlineLabel(
          card.deadlineSuggestion?.mode || 'AFTER_APPROVAL_DAYS',
          card.deadlineSuggestion?.daysAfterApproval ?? null,
          card.deadlineSuggestion?.fixedAt ?? null,
        ),
    },
  }
}

export function findCard(model: WorkbenchModel, cardId: string): TaskCardV2 | undefined {
  return model.cards.find((c) => c.id === cardId)
}

function splitEvidenceMaterials(evidenceType: string | null | undefined): string[] {
  return (evidenceType || '')
    .split(/[、,，;；]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20)
}

function promotedTitle(candidate: CandidateRequirement): string {
  const action = candidate.action.trim()
  if (action) return action.slice(0, 80)
  return candidate.sourceText.trim().slice(0, 80) || '手动提升候选要求'
}

function uniqueLocalId(existingIds: Set<string>, base: string): string {
  let id = base
  let n = 2
  while (existingIds.has(id)) {
    id = `${base}-${n}`
    n += 1
  }
  existingIds.add(id)
  return id
}

/** 把未成任务候选显式提升为本地任务卡，后续保存/派发复用现有 commit 链路。 */
export function promoteCandidateToCard(model: WorkbenchModel, candidateIndex: number): WorkbenchModel {
  const candidate = model.candidateRequirements[candidateIndex]
  if (!candidate) return model
  const baseDraftId = `candidate-${candidateIndex + 1}`
  if (model.cards.some((card) => card.draftId === baseDraftId || card.taskDraftId.startsWith(`task-${baseDraftId}`))) {
    return model
  }
  const existingDraftIds = new Set(Object.keys(model.draftMeta))
  const existingCardIds = new Set(model.cards.map((card) => card.id))
  const draftId = uniqueLocalId(existingDraftIds, baseDraftId)
  const taskDraftId = uniqueLocalId(existingCardIds, `task-${draftId}`)
  const groupId = `group-${draftId}`
  const title = promotedTitle(candidate)
  const materials = splitEvidenceMaterials(candidate.evidenceType)
  const submitRequirement = materials.length
    ? `提交或留存：${materials.join('、')}`
    : DEFAULT_FALLBACK_SUBMIT
  const days = frequencyToDays(candidate.frequency)
  const description = [
    candidate.action || candidate.sourceText,
    candidate.responsibleRole ? `责任对象：${candidate.responsibleRole}` : '',
    candidate.frequency ? `执行频次：${candidate.frequency}` : '',
    candidate.riskLevel ? `风险等级：${candidate.riskLevel}` : '',
  ].filter(Boolean).join('\n')
  const card: TaskCardV2 = {
    id: taskDraftId,
    draftId,
    taskDraftId,
    groupId,
    title,
    description,
    submitRequirement,
    taskType: candidate.suggestedTaskType || 'OTHER',
    requiredMaterials: materials,
    deadlineSuggestion: {
      mode: 'AFTER_APPROVAL_DAYS',
      daysAfterApproval: days,
      fixedAt: null,
      label: deadlineLabel('AFTER_APPROVAL_DAYS', days, null),
      reason: candidate.frequency ? `候选要求频次：${candidate.frequency}` : null,
    },
    basis: {
      sourceId: model.source?.id ?? null,
      sourceTitle: model.source?.title ?? null,
      clauseNo: candidate.clauseNo ?? null,
      excerpt: candidate.sourceText.slice(0, 600),
    },
    polishStatus: 'FALLBACK_ORIGINAL',
    warnings: ['由未成任务候选手动提升，请复核 5W 完整性后再派发。'],
  }
  return {
    ...model,
    cards: [...model.cards, card],
    draftMeta: {
      ...model.draftMeta,
      [draftId]: {
        draftId,
        title,
        clauseNo: candidate.clauseNo ?? null,
        requirementText: candidate.sourceText,
        recommendedTaskType: candidate.suggestedTaskType ?? null,
        executionDescription: candidate.action || null,
        requiredMaterials: materials,
      },
    },
  }
}

/** 编辑单卡（不可变更新；deadlineSuggestion 合并并重算 label） */
export function applyCardEdit(model: WorkbenchModel, cardId: string, patch: CardEditablePatch): WorkbenchModel {
  const cards = model.cards.map((card) => {
    if (card.id !== cardId) return card
    const next: TaskCardV2 = { ...card }
    if (patch.title !== undefined) next.title = patch.title
    if (patch.taskType !== undefined) next.taskType = patch.taskType
    if (patch.description !== undefined) next.description = patch.description
    if (patch.submitRequirement !== undefined) next.submitRequirement = patch.submitRequirement
    if (patch.requiredMaterials !== undefined) next.requiredMaterials = patch.requiredMaterials
    if (patch.deadlineSuggestion) {
      const merged = { ...card.deadlineSuggestion, ...patch.deadlineSuggestion }
      merged.label = deadlineLabel(merged.mode, merged.daysAfterApproval, merged.fixedAt)
      next.deadlineSuggestion = merged
    }
    return next
  })
  return { ...model, cards }
}

/** 用 AI 重写结果替换同 id 卡（保位置）。契约 §6：id 保持不变。 */
export function applyRewrittenCard(model: WorkbenchModel, card: TaskCardV2): WorkbenchModel {
  const cards = model.cards.map((c) => (c.id === card.id ? normalizeCard(card) : c))
  return { ...model, cards }
}

/** 批量重润色：按 id 替换多张卡（顺序不变，未命中保持原样） */
export function applyRepolishedCards(model: WorkbenchModel, incoming: TaskCardV2[]): WorkbenchModel {
  const byId = new Map(incoming.map((c) => [c.id, normalizeCard(c)]))
  const cards = model.cards.map((c) => byId.get(c.id) ?? c)
  return { ...model, cards }
}

/** 删除单卡；同步清理只剩该卡的 draftMeta（无 card 引用即移除） */
export function deleteCard(model: WorkbenchModel, cardId: string): WorkbenchModel {
  const cards = model.cards.filter((c) => c.id !== cardId)
  const stillUsed = new Set(cards.map((c) => c.draftId))
  const draftMeta: Record<string, DraftMetaEntry> = {}
  Object.values(model.draftMeta).forEach((meta) => {
    if (stillUsed.has(meta.draftId)) draftMeta[meta.draftId] = meta
  })
  return { ...model, cards, draftMeta }
}

/** 入场姿态文案用：统计卡片与 AI 润色情况 */
export function cardStats(cards: TaskCardV2[]): { total: number; aiPolished: number; fallback: number } {
  let aiPolished = 0
  let fallback = 0
  cards.forEach((c) => {
    if (c.polishStatus === 'AI_POLISHED') aiPolished += 1
    else fallback += 1
  })
  return { total: cards.length, aiPolished, fallback }
}

// ─── 卡片合并 / 拆分（批次3，纯逻辑）───────────────────

function pruneDraftMeta(model: WorkbenchModel): WorkbenchModel {
  const used = new Set(model.cards.map((c) => c.draftId))
  const draftMeta: Record<string, DraftMetaEntry> = {}
  Object.values(model.draftMeta).forEach((meta) => {
    if (used.has(meta.draftId)) draftMeta[meta.draftId] = meta
  })
  return { ...model, draftMeta }
}

function uniqArr(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))]
}

/** 去重去空后用换行拼接 */
function uniqJoin(parts: string[]): string {
  return uniqArr(parts.map((p) => (p || '').trim())).join('\n')
}

function uniqueCardId(cards: TaskCardV2[], base: string): string {
  const existing = new Set(cards.map((c) => c.id))
  let n = 2
  let id = `${base}${n}`
  while (existing.has(id)) {
    n += 1
    id = `${base}${n}`
  }
  return id
}

/**
 * 合并多张卡为一张（合并到第一张卡的位置/归属）。
 * - <2 张时原样返回。
 * - 说明/提交要求去重换行拼接，材料并集；归属取第一张卡的 draft/group。
 * - 清理因合并而无卡引用的 draftMeta。
 */
export function mergeCards(model: WorkbenchModel, cardIds: string[]): WorkbenchModel {
  const ids = new Set(cardIds)
  const picked = model.cards.filter((c) => ids.has(c.id))
  if (picked.length < 2) return model
  const first = picked[0]
  const merged: TaskCardV2 = {
    ...first,
    description: uniqJoin(picked.map((c) => c.description)),
    submitRequirement: uniqJoin(picked.map((c) => c.submitRequirement)),
    requiredMaterials: uniqArr(picked.flatMap((c) => c.requiredMaterials || [])),
    warnings: uniqArr(picked.flatMap((c) => c.warnings || [])),
    polishStatus: picked.every((c) => c.polishStatus === 'AI_POLISHED') ? 'AI_POLISHED' : 'FALLBACK_ORIGINAL',
  }
  const firstIdx = model.cards.findIndex((c) => c.id === first.id)
  const cards: TaskCardV2[] = []
  model.cards.forEach((c, i) => {
    if (i === firstIdx) cards.push(merged)
    else if (!ids.has(c.id)) cards.push(c)
  })
  return pruneDraftMeta({ ...model, cards })
}

/**
 * 拆分单卡为两张：副本带新 taskDraftId + 新 groupId（→ commit 时成独立任务），
 * 同 draftId（同执行要求）。原卡原位保留，副本紧随其后。
 */
export function splitCard(model: WorkbenchModel, cardId: string): WorkbenchModel {
  const idx = model.cards.findIndex((c) => c.id === cardId)
  if (idx < 0) return model
  const src = model.cards[idx]
  const newId = uniqueCardId(model.cards, `${src.id}-s`)
  const copy: TaskCardV2 = {
    ...src,
    id: newId,
    taskDraftId: newId,
    groupId: `${src.groupId}-split-${model.cards.length + 1}`,
    title: `${src.title}（拆分）`,
  }
  const cards = [...model.cards.slice(0, idx + 1), copy, ...model.cards.slice(idx + 1)]
  return { ...model, cards }
}
