import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { runParse } from './autoGenerateRoute.js'
import { callStandardAI } from './aiClient.js'
import { buildBasisSnapshots, type RequirementForSnapshot } from './basisSnapshots.js'
import {
  buildTaskDraft,
  polishTaskGenerationDrafts,
  repolishTaskCards,
  type TaskPolishDegradedReason,
} from './taskPolishService.js'
import type {
  TaskGenerationCardRewriteInput,
  TaskGenerationCardsRepolishInput,
  TaskGenerationCommitInput,
  TaskGenerationPreviewInput,
  TaskGenerationReExtractInput,
} from './types.js'

type ParseMode = 'OCR_AI' | 'RULE' | 'AI_STUB'

export interface TaskGenerationContext {
  enterpriseId: string
  userId: string
  scope: 'admin' | 'enterprise'
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status })
}

function generateModeFromParseMode(parseMode: ParseMode) {
  if (parseMode === 'OCR_AI') return 'AI'
  if (parseMode === 'AI_STUB') return 'AI_STUB'
  return 'RULE'
}

function isPolishEnabled(input: TaskGenerationPreviewInput['polish']) {
  if (input === true) return true
  if (input && typeof input === 'object') return input.enabled !== false
  return false
}

function polishFallbackReasonFromParse(reason: string | null | undefined): TaskPolishDegradedReason | null {
  if (reason === 'AI_NOT_CONFIGURED') return 'AI_NOT_CONFIGURED'
  if (reason === 'AI_INVALID_JSON') return 'POLISH_AI_INVALID_JSON'
  if (reason === 'AI_FAILED') return 'POLISH_AI_FAILED'
  if (reason === 'REALTIME_RULE_LIMIT') return 'POLISH_RULE_REALTIME_LIMIT'
  return null
}

async function loadSource(enterpriseId: string, sourceId: string) {
  return prisma.standardExecutionSource.findFirst({
    where: { id: sourceId, enterpriseId },
    select: {
      id: true,
      title: true,
      sourceNo: true,
      sourceType: true,
      version: true,
      rawText: true,
      status: true,
    },
  })
}

async function validateUsers(ctx: TaskGenerationContext, reviewerId: string, assigneeIds: string[]) {
  const ids = Array.from(new Set([reviewerId, ...assigneeIds]))
  const where: Prisma.AppUserWhereInput =
    ctx.scope === 'enterprise'
      ? { id: { in: ids }, OR: [{ enterpriseId: ctx.enterpriseId }, { role: 'admin' }] }
      : { id: { in: ids } }
  const found = await prisma.appUser.findMany({ where, select: { id: true } })
  const foundSet = new Set(found.map((user) => user.id))
  return {
    reviewerOk: foundSet.has(reviewerId),
    missingAssignees: assigneeIds.filter((id) => !foundSet.has(id)),
  }
}

export async function previewTaskGenerationDrafts(
  ctx: TaskGenerationContext,
  input: TaskGenerationPreviewInput,
  aiCaller: (prompt: string) => Promise<string> = callStandardAI,
) {
  const source = input.sourceId ? await loadSource(ctx.enterpriseId, input.sourceId) : null
  if (input.sourceId && !source) throw httpError(404, '标准来源不存在或无权访问')

  const rawText = input.rawText?.trim() || source?.rawText || ''
  const requestedMode = input.parseMode
  const result = await runParse(rawText, requestedMode, aiCaller)
  const sourcePayload = source
    ? {
        id: source.id,
        title: source.title,
        sourceNo: source.sourceNo,
        sourceType: source.sourceType,
        version: source.version,
      }
    : null

  const polishResult = isPolishEnabled(input.polish)
    ? await polishTaskGenerationDrafts(result.drafts, {
        source: sourcePayload ? { id: sourcePayload.id, title: sourcePayload.title } : null,
        aiCaller,
        forceFallbackReason: result.degraded ? polishFallbackReasonFromParse(result.degradedReason) : null,
      })
    : null

  return {
    source: sourcePayload,
    requestedMode,
    parseMode: result.parseMode,
    degraded: result.degraded,
    degradedReason: result.degradedReason ?? null,
    warnings: result.warnings,
    rejectedCount: result.rejectedCount,
    ...(result.candidateV2Enabled
      ? {
          candidateV2Enabled: true,
          candidateRequirements: result.candidateRequirements,
          candidateScoreDistribution: result.candidateScoreDistribution,
          candidateThresholds: result.candidateThresholds,
          taskPackages: result.taskPackages,
          coverageReport: result.coverageReport,
        }
      : {}),
    drafts: polishResult?.drafts ?? result.drafts,
    ...(polishResult
      ? {
          polish: polishResult.polish,
          taskCards: polishResult.taskCards,
        }
      : {}),
  }
}

async function assertSourceAccess(enterpriseId: string, sourceId: string | undefined) {
  if (!sourceId) return null
  const source = await loadSource(enterpriseId, sourceId)
  if (!source) throw httpError(404, '标准来源不存在或无权访问')
  return {
    id: source.id,
    title: source.title,
    sourceNo: source.sourceNo,
    sourceType: source.sourceType,
    version: source.version,
  }
}

export async function rewriteTaskGenerationCard(
  ctx: TaskGenerationContext,
  input: TaskGenerationCardRewriteInput,
  aiCaller: (prompt: string) => Promise<string> = callStandardAI,
) {
  await assertSourceAccess(ctx.enterpriseId, input.sourceId)
  const result = await repolishTaskCards([input.card], {
    aiCaller,
    instruction: input.instruction,
    fallbackWarning: 'AI 重写失败，已保留原卡片',
  })
  const taskCard = result.taskCards[0] ?? input.card
  return {
    operation: 'CARD_REWRITE' as const,
    polish: result.polish,
    taskCard,
    taskDraft: result.taskDrafts[0] ?? buildTaskDraft(taskCard),
  }
}

export async function repolishTaskGenerationCards(
  ctx: TaskGenerationContext,
  input: TaskGenerationCardsRepolishInput,
  aiCaller: (prompt: string) => Promise<string> = callStandardAI,
) {
  await assertSourceAccess(ctx.enterpriseId, input.sourceId)
  const result = await repolishTaskCards(input.cards, {
    aiCaller,
    instruction: input.instruction,
    fallbackWarning: 'AI 重润色失败，已保留原卡片',
  })
  return {
    operation: 'BATCH_REPOLISH' as const,
    ...result,
  }
}

export async function reExtractTaskGenerationDrafts(
  ctx: TaskGenerationContext,
  input: TaskGenerationReExtractInput,
  aiCaller: (prompt: string) => Promise<string> = callStandardAI,
) {
  const data = await previewTaskGenerationDrafts(ctx, input, aiCaller)
  return {
    operation: 'RE_EXTRACT' as const,
    ...data,
  }
}

type CreatedRequirement = RequirementForSnapshot & {
  createdRequirementId: string
  draftIndex: number
}

function normalizeTaskDrafts(
  draft: TaskGenerationCommitInput['drafts'][number],
  draftIndex: number,
) {
  const taskDrafts = draft.taskDrafts?.length
    ? draft.taskDrafts
    : [{
        taskDraftId: `task-${draft.draftId || draftIndex}`,
        groupId: draft.groupId || `draft-${draft.draftId || draftIndex}`,
        title: null,
        description: null,
        taskType: null,
        submitRequirement: null,
      }]
  return taskDrafts.map((taskDraft, taskIndex) => ({
    ...taskDraft,
    taskDraftId: taskDraft.taskDraftId || `task-${draft.draftId || draftIndex}-${taskIndex}`,
    groupId: taskDraft.groupId || draft.groupId || `draft-${draft.draftId || draftIndex}-${taskIndex}`,
  }))
}

function applyCardIdWhitelist(
  drafts: TaskGenerationCommitInput['drafts'],
  cardIds: TaskGenerationCommitInput['cardIds'],
) {
  if (!cardIds) return drafts
  const allowed = new Set(cardIds)
  return drafts.flatMap((draft, draftIndex) => {
    const taskDrafts = normalizeTaskDrafts(draft, draftIndex).filter((taskDraft) =>
      taskDraft.taskDraftId ? allowed.has(taskDraft.taskDraftId) : false,
    )
    if (taskDrafts.length === 0) return []
    return [{ ...draft, taskDrafts }]
  })
}

function taskTitle(
  titlePrefix: string | null | undefined,
  groupTitle: string | null | undefined,
  requirements: CreatedRequirement[],
) {
  if (groupTitle?.trim()) return groupTitle.trim()
  const basisTitle = requirements.length > 1
    ? requirements.map((item) => item.title).join('、').slice(0, 140)
    : requirements[0]?.title || '任务'
  return titlePrefix?.trim() ? `${titlePrefix.trim()} - ${basisTitle}` : basisTitle
}

function taskDescription(description: string | null | undefined, requirements: CreatedRequirement[]) {
  if (description?.trim()) return description.trim()
  return requirements
    .map((item, index) => {
      const head = [item.clauseNo, item.title].filter(Boolean).join(' ')
      return `${index + 1}. ${head}\n${item.executionDescription || item.requirementText}`
    })
    .join('\n\n')
    .slice(0, 2000)
}

export async function commitTaskGenerationDrafts(
  ctx: TaskGenerationContext,
  input: TaskGenerationCommitInput,
) {
  const drafts = applyCardIdWhitelist(input.drafts, input.cardIds)
  if (drafts.length === 0) throw httpError(400, '草稿不能为空')
  if (drafts.length > 100) throw httpError(400, '一次最多提交 100 条草稿')
  const source = await loadSource(ctx.enterpriseId, input.sourceId)
  if (!source) throw httpError(404, '标准来源不存在或无权访问')

  const batchId = randomUUID()
  const taskStatus = input.taskStatus ?? 'DRAFT'
  const assigneeIds = input.assigneeIds ?? []
  if (taskStatus === 'PENDING_APPROVAL') {
    if (!input.reviewerId) throw httpError(400, 'reviewerId 不能为空')
    if (assigneeIds.length === 0) throw httpError(400, 'assigneeIds 至少需要 1 个执行人')
    if (input.deadlineMode === 'FIXED' && !input.deadlineAt) throw httpError(400, '固定截止时间不能为空')
    if (input.deadlineMode === 'AFTER_APPROVAL_DAYS') {
      const days = input.deadlineDaysAfterApproval ?? 7
      if (!Number.isInteger(days) || days <= 0 || days > 365) throw httpError(400, '审核通过后完成天数必须为 1-365 天')
    }
  }
  if (input.reviewerId || assigneeIds.length > 0) {
    if (!input.reviewerId) throw httpError(400, '选择执行人时必须同时选择审核人')
    const userCheck = await validateUsers(ctx, input.reviewerId, assigneeIds)
    if (!userCheck.reviewerOk) throw httpError(400, 'reviewerId 对应用户不存在或不属于当前企业')
    if (userCheck.missingAssignees.length > 0) {
      throw httpError(400, `assigneeIds 含不存在或不属于当前企业的用户：${userCheck.missingAssignees.join(', ')}`)
    }
  }
  const submittedForApprovalAt = taskStatus === 'PENDING_APPROVAL' ? new Date() : null
  const result = await prisma.$transaction(async (tx) => {
    const createdRequirements: CreatedRequirement[] = []

    for (const [draftIndex, draft] of drafts.entries()) {
      const requirement = await tx.standardExecutionRequirement.create({
        data: {
          enterpriseId: ctx.enterpriseId,
          sourceId: source.id,
          clauseNo: draft.clauseNo ?? null,
          title: draft.title,
          requirementText: draft.requirementText,
          generateMode: generateModeFromParseMode(input.parseMode),
          status: 'ACTIVE',
          recommendedTaskType: draft.recommendedTaskType ?? null,
          executionDescription: draft.executionDescription ?? null,
          submitRequirement: draft.submitRequirement ?? null,
          requiredMaterials: (draft.requiredMaterials ?? Prisma.DbNull) as Prisma.InputJsonValue,
          parseMode: input.parseMode,
          createdBy: ctx.userId,
        },
      })
      createdRequirements.push({
        createdRequirementId: requirement.id,
        draftIndex,
        id: requirement.id,
        sourceId: source.id,
        clauseNo: draft.clauseNo ?? null,
        title: draft.title,
        requirementText: draft.requirementText,
        recommendedTaskType: draft.recommendedTaskType ?? null,
        executionDescription: draft.executionDescription ?? null,
        submitRequirement: draft.submitRequirement ?? null,
        source: {
          id: source.id,
          title: source.title,
          sourceNo: source.sourceNo,
          sourceType: source.sourceType,
          version: source.version,
        },
      })
    }

    const groups = new Map<string, {
      taskDraft: ReturnType<typeof normalizeTaskDrafts>[number]
      requirements: CreatedRequirement[]
    }>()
    drafts.forEach((draft, draftIndex) => {
      const requirement = createdRequirements[draftIndex]
      for (const taskDraft of normalizeTaskDrafts(draft, draftIndex)) {
        const key = taskDraft.groupId || `draft-${draftIndex}`
        const group = groups.get(key)
        if (group) {
          if (!group.requirements.some((item) => item.id === requirement.id)) {
            group.requirements.push(requirement)
          }
        } else {
          groups.set(key, { taskDraft, requirements: [requirement] })
        }
      }
    })

    const createdTaskIds: string[] = []
    for (const group of groups.values()) {
      const firstRequirement = group.requirements[0]
      const taskType =
        group.taskDraft.taskType ||
        input.taskType ||
        firstRequirement.recommendedTaskType ||
        'OTHER'
      const submitRequirement =
        group.taskDraft.submitRequirement?.trim() ||
        group.requirements.find((item) => item.submitRequirement?.trim())?.submitRequirement?.trim() ||
        input.submitRequirement?.trim() ||
        '请按任务要求完成执行，并提交必要的记录、说明或证明材料。'
      const task = await tx.standardExecutionTask.create({
        data: {
          enterpriseId: ctx.enterpriseId,
          requirementId: group.requirements.length === 1 ? firstRequirement.id : null,
          title: taskTitle(input.titlePrefix, group.taskDraft.title, group.requirements),
          description: taskDescription(group.taskDraft.description, group.requirements),
          taskType,
          submitRequirement,
          deadlineAt: input.deadlineAt ?? null,
          deadlineMode: input.deadlineMode,
          deadlineDaysAfterApproval: input.deadlineDaysAfterApproval ?? null,
          reviewerId: input.reviewerId ?? null,
          status: taskStatus,
          submittedForApprovalAt,
          basisSnapshots: buildBasisSnapshots(group.requirements) as unknown as Prisma.InputJsonValue,
          createdBy: ctx.userId,
        },
      })
      createdTaskIds.push(task.id)

      if (taskStatus === 'PENDING_APPROVAL') {
        await tx.standardExecutionTaskApprovalLog.create({
          data: {
            enterpriseId: ctx.enterpriseId,
            taskId: task.id,
            action: 'SUBMIT_APPROVAL',
            fromStatus: 'DRAFT',
            toStatus: 'PENDING_APPROVAL',
            reviewerId: ctx.userId,
          },
        })
      }

      if (group.requirements.length > 1) {
        await tx.standardExecutionTaskItem.createMany({
          data: group.requirements.map((requirement) => ({
            taskId: task.id,
            requirementId: requirement.id,
            status: 'PENDING',
          })),
        })
      }

      if (assigneeIds.length > 0) {
        await tx.standardExecutionTaskAssignee.createMany({
          data: assigneeIds.map((assigneeId) => ({
            enterpriseId: ctx.enterpriseId,
            taskId: task.id,
            assigneeId,
            status: 'PENDING',
          })),
        })
      }
    }

    return {
      requirementIds: createdRequirements.map((item) => item.id),
      taskIds: createdTaskIds,
    }
  })

  return {
    batchId,
    created: result,
    summary: {
      requirements: result.requirementIds.length,
      tasks: result.taskIds.length,
      taskStatus,
    },
  }
}
