import { z } from 'zod'
import type { RequirementDraft } from './types.js'
import { TASK_TYPES } from './types.js'
import { AiCallFailedError, AiNotConfiguredError } from './aiClient.js'
import { isAiPreviewOverloadLike } from './aiPreviewErrors.js'

export type TaskPolishStatus = 'SUCCEEDED' | 'DEGRADED' | 'SKIPPED'
export type TaskPolishDegradedReason =
  | 'AI_NOT_CONFIGURED'
  | 'POLISH_AI_FAILED'
  | 'POLISH_AI_OVERLOADED'
  | 'POLISH_AI_INVALID_JSON'
  | 'POLISH_PARTIAL_FAILED'
  | 'POLISH_RULE_REALTIME_LIMIT'

export type TaskCardPolishStatus = 'AI_POLISHED' | 'FALLBACK_ORIGINAL'
export type TaskType = typeof TASK_TYPES[number]
export type TaskDeadlineMode = 'FIXED' | 'AFTER_APPROVAL_DAYS'

export interface TaskPolishSource {
  id: string
  title: string
}

export interface TaskCardDraftForCommit {
  taskDraftId: string
  groupId: string
  title: string
  description: string
  taskType: TaskType
  submitRequirement: string
}

export interface TaskCardV2 {
  id: string
  draftId: string
  taskDraftId: string
  groupId: string
  title: string
  description: string
  submitRequirement: string
  taskType: TaskType
  requiredMaterials: string[]
  deadlineSuggestion: {
    mode: TaskDeadlineMode
    daysAfterApproval: number | null
    fixedAt: string | null
    label: string
    reason: string | null
  }
  basis: {
    sourceId: string | null
    sourceTitle: string | null
    clauseNo: string | null
    excerpt: string
  }
  polishStatus: TaskCardPolishStatus
  warnings: string[]
}

export type TaskGenerationPolishedDraft = RequirementDraft & {
  draftId: string
  groupId: string
  taskDrafts: TaskCardDraftForCommit[]
}

export interface TaskPolishSummary {
  enabled: true
  status: TaskPolishStatus
  degraded: boolean
  degradedReason: TaskPolishDegradedReason | null
  warnings: string[]
  stats: {
    inputDrafts: number
    outputCards: number
    aiCards: number
    fallbackCards: number
    batches: number
    failedBatches: number
    durationMs: number
  }
}

export interface TaskPolishOperationSummary {
  enabled: true
  status: TaskPolishStatus
  degraded: boolean
  degradedReason: TaskPolishDegradedReason | null
  warnings: string[]
  stats: {
    inputCards: number
    outputCards: number
    aiCards: number
    fallbackCards: number
    batches: number
    failedBatches: number
    durationMs: number
  }
}

export interface TaskPolishResult {
  polish: TaskPolishSummary
  drafts: TaskGenerationPolishedDraft[]
  taskCards: TaskCardV2[]
}

export interface TaskCardPolishResult {
  polish: TaskPolishOperationSummary
  taskCards: TaskCardV2[]
  taskDrafts: TaskCardDraftForCommit[]
}

export interface TaskPolishOptions {
  source?: TaskPolishSource | null
  aiCaller: (prompt: string) => Promise<string>
  forceFallbackReason?: TaskPolishDegradedReason | null
}

export interface TaskCardPolishOptions {
  aiCaller: (prompt: string) => Promise<string>
  instruction?: string | null
  fallbackWarning?: string
}

const DEFAULT_SUBMIT_REQUIREMENT = '请提交与本条款执行相关的记录、照片、台账或说明材料。'
const MAX_BATCH_SIZE = 8
const MAX_BATCH_CHARS = 10_000

const DeadlineSuggestionSchema = z.object({
  mode: z.enum(['FIXED', 'AFTER_APPROVAL_DAYS']).optional(),
  daysAfterApproval: z.number().int().positive().max(365).optional().nullable(),
  fixedAt: z.string().datetime().optional().nullable(),
  label: z.string().trim().min(1).max(100).optional().nullable(),
  reason: z.string().trim().max(300).optional().nullable(),
}).optional().nullable()

const AiTaskCardSchema = z.object({
  draftId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  submitRequirement: z.string().trim().min(1).max(1000),
  taskType: z.enum(TASK_TYPES).optional().nullable(),
  requiredMaterials: z.array(z.string().trim().min(1).max(200)).max(50).optional().nullable(),
  deadlineSuggestion: DeadlineSuggestionSchema,
})
const AiTaskCardArraySchema = z.array(AiTaskCardSchema)
type AiTaskCard = z.infer<typeof AiTaskCardSchema>

class PolishInvalidJsonError extends Error {
  constructor(public reason: string) {
    super(`AI 润色返回非法 JSON：${reason}`)
  }
}

function clamp(s: string, max: number) {
  return s.length > max ? s.slice(0, max) : s
}

function stripJsonFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
}

function taskTypeOrOther(input: unknown): TaskType {
  return typeof input === 'string' && (TASK_TYPES as readonly string[]).includes(input)
    ? input as TaskType
    : 'OTHER'
}

function ensureDraftIds(drafts: RequirementDraft[]): TaskGenerationPolishedDraft[] {
  return drafts.map((draft, index) => {
    const draftId = `draft-${index + 1}`
    return {
      ...draft,
      draftId,
      groupId: draftId,
      taskDrafts: [],
    }
  })
}

function deadlineFromFrequency(frequency?: string | null) {
  if (frequency === 'MONTHLY') return { days: 30, label: '审核通过后 30 天内完成', reason: '按月度检查频率推荐' }
  if (frequency === 'QUARTERLY') return { days: 90, label: '审核通过后 90 天内完成', reason: '按季度检查频率推荐' }
  if (frequency === 'YEARLY') return { days: 365, label: '审核通过后 365 天内完成', reason: '按年度检查频率推荐' }
  return { days: 7, label: '审核通过后 7 天内完成', reason: '未识别明确频率，按默认周期推荐' }
}

export function buildTaskDraft(card: TaskCardV2): TaskCardDraftForCommit {
  return {
    taskDraftId: card.taskDraftId,
    groupId: card.groupId,
    title: card.title,
    description: card.description,
    taskType: card.taskType,
    submitRequirement: card.submitRequirement,
  }
}

function fallbackOriginalCard(card: TaskCardV2, warning: string): TaskCardV2 {
  return {
    ...card,
    polishStatus: 'FALLBACK_ORIGINAL',
    warnings: [...(card.warnings || []), warning],
  }
}

function fallbackCard(
  draft: TaskGenerationPolishedDraft,
  index: number,
  source: TaskPolishSource | null | undefined,
  warnings: string[] = [],
): TaskCardV2 {
  const taskDraftId = `task-${draft.draftId}`
  const deadline = deadlineFromFrequency(draft.suggestedFrequency)
  const title = draft.title?.trim()
    ? clamp(/^每|^检查|^核查|^提交|^建立|^维护|^完成/.test(draft.title.trim()) ? draft.title.trim() : `检查${draft.title.trim()}`, 80)
    : `检查执行要求 ${index + 1}`
  const description = clamp((draft.executionDescription || draft.requirementText || title).trim(), 2000)
  const submitRequirement = clamp((draft.submitRequirement || DEFAULT_SUBMIT_REQUIREMENT).trim(), 1000)
  const requiredMaterials = draft.requiredMaterials?.filter(Boolean) || []
  return {
    id: taskDraftId,
    draftId: draft.draftId,
    taskDraftId,
    groupId: draft.groupId,
    title,
    description,
    submitRequirement,
    taskType: taskTypeOrOther(draft.recommendedTaskType),
    requiredMaterials,
    deadlineSuggestion: {
      mode: 'AFTER_APPROVAL_DAYS',
      daysAfterApproval: deadline.days,
      fixedAt: null,
      label: deadline.label,
      reason: deadline.reason,
    },
    basis: {
      sourceId: source?.id ?? null,
      sourceTitle: source?.title ?? null,
      clauseNo: draft.clauseNo ?? null,
      excerpt: clamp(draft.requirementText, 600),
    },
    polishStatus: 'FALLBACK_ORIGINAL',
    warnings,
  }
}

function applyAiCard(
  draft: TaskGenerationPolishedDraft,
  index: number,
  aiCard: AiTaskCard | undefined,
  source: TaskPolishSource | null | undefined,
): TaskCardV2 {
  if (!aiCard) {
    return fallbackCard(draft, index, source, ['AI 未返回该条润色结果，已保留原始解析内容'])
  }
  const fallback = fallbackCard(draft, index, source)
  const suggested = aiCard.deadlineSuggestion
  const days = suggested?.daysAfterApproval ?? fallback.deadlineSuggestion.daysAfterApproval ?? null
  return {
    ...fallback,
    title: clamp(aiCard.title.trim(), 80),
    description: aiCard.description.trim(),
    submitRequirement: aiCard.submitRequirement.trim(),
    taskType: taskTypeOrOther(aiCard.taskType || draft.recommendedTaskType),
    requiredMaterials: aiCard.requiredMaterials?.filter(Boolean) || draft.requiredMaterials?.filter(Boolean) || [],
    deadlineSuggestion: {
      mode: suggested?.mode || 'AFTER_APPROVAL_DAYS',
      daysAfterApproval: suggested?.mode === 'FIXED' ? null : days,
      fixedAt: suggested?.mode === 'FIXED' ? suggested.fixedAt ?? null : null,
      label: suggested?.label || (days ? `审核通过后 ${days} 天内完成` : '按固定截止时间完成'),
      reason: suggested?.reason ?? fallback.deadlineSuggestion.reason,
    },
    polishStatus: 'AI_POLISHED',
    warnings: [],
  }
}

function applyAiCardToExisting(card: TaskCardV2, aiCard: AiTaskCard | undefined, warning: string): TaskCardV2 {
  if (!aiCard) return fallbackOriginalCard(card, warning)
  const suggested = aiCard.deadlineSuggestion
  const days = suggested?.daysAfterApproval ?? card.deadlineSuggestion.daysAfterApproval ?? null
  return {
    ...card,
    title: clamp(aiCard.title.trim(), 80),
    description: aiCard.description.trim(),
    submitRequirement: aiCard.submitRequirement.trim(),
    taskType: taskTypeOrOther(aiCard.taskType || card.taskType),
    requiredMaterials: aiCard.requiredMaterials?.filter(Boolean) || card.requiredMaterials?.filter(Boolean) || [],
    deadlineSuggestion: {
      mode: suggested?.mode || card.deadlineSuggestion.mode || 'AFTER_APPROVAL_DAYS',
      daysAfterApproval: suggested?.mode === 'FIXED' ? null : days,
      fixedAt: suggested?.mode === 'FIXED' ? suggested.fixedAt ?? null : null,
      label: suggested?.label || card.deadlineSuggestion.label || (days ? `审核通过后 ${days} 天内完成` : '按固定截止时间完成'),
      reason: suggested?.reason ?? card.deadlineSuggestion.reason ?? null,
    },
    polishStatus: 'AI_POLISHED',
    warnings: [],
  }
}

function classifyPolishFailure(err: unknown): TaskPolishDegradedReason {
  if (err instanceof AiNotConfiguredError) return 'AI_NOT_CONFIGURED'
  if (err instanceof PolishInvalidJsonError) return 'POLISH_AI_INVALID_JSON'
  if (err instanceof AiCallFailedError && isAiPreviewOverloadLike(err.reason)) return 'POLISH_AI_OVERLOADED'
  if (err instanceof AiCallFailedError) return 'POLISH_AI_FAILED'
  if (isAiPreviewOverloadLike(err)) return 'POLISH_AI_OVERLOADED'
  return 'POLISH_AI_FAILED'
}

function batchesFor(drafts: TaskGenerationPolishedDraft[]) {
  const batches: TaskGenerationPolishedDraft[][] = []
  let current: TaskGenerationPolishedDraft[] = []
  let currentChars = 0
  for (const draft of drafts) {
    const chars = draft.requirementText.length + (draft.executionDescription?.length || 0) + (draft.submitRequirement?.length || 0)
    if (current.length > 0 && (current.length >= MAX_BATCH_SIZE || currentChars + chars > MAX_BATCH_CHARS)) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(draft)
    currentChars += chars
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function cardBatchesFor(cards: TaskCardV2[]) {
  const batches: TaskCardV2[][] = []
  let current: TaskCardV2[] = []
  let currentChars = 0
  for (const card of cards) {
    const chars = card.title.length + card.description.length + card.submitRequirement.length + card.basis.excerpt.length
    if (current.length > 0 && (current.length >= MAX_BATCH_SIZE || currentChars + chars > MAX_BATCH_CHARS)) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(card)
    currentChars += chars
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function buildPolishPrompt(drafts: TaskGenerationPolishedDraft[]) {
  const payload = drafts.map((draft) => ({
    draftId: draft.draftId,
    clauseNo: draft.clauseNo,
    title: draft.title,
    requirementText: draft.requirementText,
    executionDescription: draft.executionDescription,
    submitRequirement: draft.submitRequirement,
    requiredMaterials: draft.requiredMaterials,
    recommendedTaskType: draft.recommendedTaskType,
    suggestedFrequency: draft.suggestedFrequency,
  }))
  return `你是企业标准执行顾问。请把下列标准执行要求润色成人话任务卡，返回 JSON 数组，不要输出任何额外文字。

每个输入必须返回一条同 draftId 的结果。字段：
- draftId: 原样返回
- title: 可执行任务标题，尽量动词开头，不超过 80 字，例如"每月检查关键设备完好率"
- description: 执行说明，说明核查什么、怎么做、关注什么证据，不超过 2000 字
- submitRequirement: 员工完成任务需提交什么材料，不超过 1000 字
- taskType: TRAINING / QUALIFICATION_MATERIAL / ONBOARDING_ACCESS / INSPECTION_FILL / RECTIFICATION / ARCHIVE_MATERIAL / OTHER
- requiredMaterials: 材料清单，字符串数组
- deadlineSuggestion: { mode:"AFTER_APPROVAL_DAYS", daysAfterApproval:number, label:string, reason:string }。优先按条款频率推荐；无频率默认 7 天。

输入：
${JSON.stringify(payload)}`
}

function buildCardPolishPrompt(cards: TaskCardV2[], instruction?: string | null) {
  const payload = cards.map((card) => ({
    draftId: card.draftId,
    title: card.title,
    description: card.description,
    submitRequirement: card.submitRequirement,
    taskType: card.taskType,
    requiredMaterials: card.requiredMaterials,
    deadlineSuggestion: card.deadlineSuggestion,
    basis: card.basis,
  }))
  const instructionText = instruction?.trim()
    ? `\n用户额外要求：${clamp(instruction.trim(), 1000)}`
    : ''
  return `你是企业标准执行顾问。请把下列任务卡重新润色成人话任务卡，返回 JSON 数组，不要输出任何额外文字。

每个输入必须返回一条同 draftId 的结果。字段：
- draftId: 原样返回
- title: 可执行任务标题，尽量动词开头，不超过 80 字
- description: 执行说明，说明核查什么、怎么做、关注什么证据，不超过 2000 字
- submitRequirement: 员工完成任务需提交什么材料，不超过 1000 字
- taskType: TRAINING / QUALIFICATION_MATERIAL / ONBOARDING_ACCESS / INSPECTION_FILL / RECTIFICATION / ARCHIVE_MATERIAL / OTHER
- requiredMaterials: 材料清单，字符串数组
- deadlineSuggestion: { mode:"AFTER_APPROVAL_DAYS"|"FIXED", daysAfterApproval:number|null, fixedAt:string|null, label:string, reason:string|null }
${instructionText}

输入：
${JSON.stringify(payload)}`
}

function parseAiTaskCards(raw: string): AiTaskCard[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonFence(raw))
  } catch (err) {
    throw new PolishInvalidJsonError(err instanceof Error ? err.message : 'parse failed')
  }
  const res = AiTaskCardArraySchema.safeParse(parsed)
  if (!res.success) {
    throw new PolishInvalidJsonError(res.error.issues[0]?.message || 'schema validation failed')
  }
  return res.data
}

function emptySummary(startMs: number, status: TaskPolishStatus, reason: TaskPolishDegradedReason | null, warnings: string[]): TaskPolishSummary {
  return {
    enabled: true,
    status,
    degraded: status === 'DEGRADED',
    degradedReason: reason,
    warnings,
    stats: {
      inputDrafts: 0,
      outputCards: 0,
      aiCards: 0,
      fallbackCards: 0,
      batches: 0,
      failedBatches: 0,
      durationMs: Date.now() - startMs,
    },
  }
}

export async function polishTaskGenerationDrafts(
  drafts: RequirementDraft[],
  options: TaskPolishOptions,
): Promise<TaskPolishResult> {
  const startMs = Date.now()
  const normalizedDrafts = ensureDraftIds(drafts)

  if (normalizedDrafts.length === 0) {
    return { polish: emptySummary(startMs, 'SKIPPED', null, ['没有可润色的执行要求']), drafts: [], taskCards: [] }
  }

  const batches = batchesFor(normalizedDrafts)
  const taskCards: TaskCardV2[] = []
  let aiCards = 0
  let fallbackCards = 0
  let failedBatches = 0
  let lastReason: TaskPolishDegradedReason | null = options.forceFallbackReason ?? null
  const warnings: string[] = []

  if (options.forceFallbackReason) {
    warnings.push(
      options.forceFallbackReason === 'POLISH_RULE_REALTIME_LIMIT'
        ? '文档超出实时 AI 解析上限，润色阶段跳过 LLM 并使用规则解析结果'
        : '解析阶段 AI 已降级，润色阶段跳过 LLM 并保留原始解析结果',
    )
  }

  for (const batch of batches) {
    if (options.forceFallbackReason) {
      for (const draft of batch) {
        taskCards.push(fallbackCard(draft, normalizedDrafts.indexOf(draft), options.source, ['AI 润色已跳过，使用原始解析结果']))
        fallbackCards++
      }
      continue
    }

    try {
      const raw = await options.aiCaller(buildPolishPrompt(batch))
      const parsed = parseAiTaskCards(raw)
      const byDraftId = new Map(parsed.map((card) => [card.draftId, card]))
      for (const draft of batch) {
        const card = applyAiCard(draft, normalizedDrafts.indexOf(draft), byDraftId.get(draft.draftId), options.source)
        taskCards.push(card)
        if (card.polishStatus === 'AI_POLISHED') aiCards++
        else fallbackCards++
      }
    } catch (err) {
      failedBatches++
      lastReason = classifyPolishFailure(err)
      warnings.push(`AI 润色批次失败（${lastReason}），已保留原始解析结果`)
      for (const draft of batch) {
        taskCards.push(fallbackCard(draft, normalizedDrafts.indexOf(draft), options.source, [`AI 润色失败：${lastReason}`]))
        fallbackCards++
      }
    }
  }

  if (fallbackCards > 0 && !lastReason) {
    lastReason = 'POLISH_PARTIAL_FAILED'
    warnings.push('AI 润色结果不完整，缺失条目已保留原始解析结果')
  }
  const status: TaskPolishStatus = fallbackCards > 0 ? 'DEGRADED' : 'SUCCEEDED'
  const cardByDraftId = new Map(taskCards.map((card) => [card.draftId, card]))
  const polishedDrafts = normalizedDrafts.map((draft) => {
    const card = cardByDraftId.get(draft.draftId) ?? fallbackCard(draft, normalizedDrafts.indexOf(draft), options.source)
    return {
      ...draft,
      title: draft.title,
      recommendedTaskType: card.taskType,
      executionDescription: card.description,
      submitRequirement: card.submitRequirement,
      requiredMaterials: card.requiredMaterials,
      taskDrafts: [buildTaskDraft(card)],
    }
  })

  return {
    polish: {
      enabled: true,
      status,
      degraded: status === 'DEGRADED',
      degradedReason: status === 'DEGRADED' ? lastReason : null,
      warnings,
      stats: {
        inputDrafts: normalizedDrafts.length,
        outputCards: taskCards.length,
        aiCards,
        fallbackCards,
        batches: batches.length,
        failedBatches,
        durationMs: Date.now() - startMs,
      },
    },
    drafts: polishedDrafts,
    taskCards,
  }
}

export async function repolishTaskCards(
  cards: TaskCardV2[],
  options: TaskCardPolishOptions,
): Promise<TaskCardPolishResult> {
  const startMs = Date.now()
  const batches = cardBatchesFor(cards)
  const taskCards: TaskCardV2[] = []
  let aiCards = 0
  let fallbackCards = 0
  let failedBatches = 0
  let lastReason: TaskPolishDegradedReason | null = null
  const warnings: string[] = []
  const fallbackWarning = options.fallbackWarning || 'AI 重润色失败，已保留原卡片'

  for (const batch of batches) {
    try {
      const raw = await options.aiCaller(buildCardPolishPrompt(batch, options.instruction))
      const parsed = parseAiTaskCards(raw)
      const byDraftId = new Map(parsed.map((card) => [card.draftId, card]))
      for (const card of batch) {
        const polished = applyAiCardToExisting(card, byDraftId.get(card.draftId), 'AI 未返回该卡片润色结果，已保留原卡片')
        taskCards.push(polished)
        if (polished.polishStatus === 'AI_POLISHED') aiCards++
        else fallbackCards++
      }
    } catch (err) {
      failedBatches++
      lastReason = classifyPolishFailure(err)
      warnings.push(`AI 卡片润色批次失败（${lastReason}），已保留原卡片`)
      for (const card of batch) {
        taskCards.push(fallbackOriginalCard(card, fallbackWarning))
        fallbackCards++
      }
    }
  }

  if (fallbackCards > 0 && !lastReason) {
    lastReason = 'POLISH_PARTIAL_FAILED'
    warnings.push('AI 卡片润色结果不完整，缺失卡片已保留原内容')
  }

  const status: TaskPolishStatus = fallbackCards > 0 ? 'DEGRADED' : 'SUCCEEDED'
  return {
    polish: {
      enabled: true,
      status,
      degraded: status === 'DEGRADED',
      degradedReason: status === 'DEGRADED' ? lastReason : null,
      warnings,
      stats: {
        inputCards: cards.length,
        outputCards: taskCards.length,
        aiCards,
        fallbackCards,
        batches: batches.length,
        failedBatches,
        durationMs: Date.now() - startMs,
      },
    },
    taskCards,
    taskDrafts: taskCards.map(buildTaskDraft),
  }
}
