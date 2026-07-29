import type { Prisma } from '@prisma/client'

export const DEFAULT_DEADLINE_DAYS_AFTER_APPROVAL = 7
const DAY_MS = 24 * 60 * 60 * 1000

export const EMPLOYEE_VISIBLE_TASK_STATUSES = ['PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE'] as const
export const EMPLOYEE_OPERABLE_TASK_STATUSES = ['PUBLISHED', 'IN_PROGRESS', 'OVERDUE'] as const

export class TaskApprovalError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type ApprovalTask = {
  id: string
  enterpriseId: string
  status: string
  deadlineAt: Date | null
  deadlineMode: string
  deadlineDaysAfterApproval: number | null
  submittedForApprovalAt: Date | null
  createdAt: Date
  reviewerId?: string | null
}

function trimComment(comment: string | null | undefined) {
  const value = comment?.trim()
  return value || null
}

function addDays(base: Date, days: number) {
  return new Date(base.getTime() + days * DAY_MS)
}

function originalDurationMs(task: ApprovalTask) {
  if (!task.deadlineAt) return DEFAULT_DEADLINE_DAYS_AFTER_APPROVAL * DAY_MS
  const primaryBase = task.submittedForApprovalAt
  if (primaryBase) {
    const duration = task.deadlineAt.getTime() - primaryBase.getTime()
    if (duration > 0) return duration
  }
  const fallback = task.deadlineAt.getTime() - task.createdAt.getTime()
  return fallback > 0 ? fallback : DEFAULT_DEADLINE_DAYS_AFTER_APPROVAL * DAY_MS
}

export function resolveApprovedDeadline(task: ApprovalTask, approvedAt: Date) {
  const oldDeadlineAt = task.deadlineAt
  if (task.deadlineMode === 'AFTER_APPROVAL_DAYS') {
    const days = task.deadlineDaysAfterApproval ?? DEFAULT_DEADLINE_DAYS_AFTER_APPROVAL
    const newDeadlineAt = addDays(approvedAt, days)
    return {
      oldDeadlineAt,
      newDeadlineAt,
      deadlineAdjusted: oldDeadlineAt?.getTime() !== newDeadlineAt.getTime(),
    }
  }

  if (!oldDeadlineAt) {
    const newDeadlineAt = addDays(approvedAt, DEFAULT_DEADLINE_DAYS_AFTER_APPROVAL)
    return { oldDeadlineAt, newDeadlineAt, deadlineAdjusted: true }
  }
  if (approvedAt.getTime() <= oldDeadlineAt.getTime()) {
    return { oldDeadlineAt, newDeadlineAt: oldDeadlineAt, deadlineAdjusted: false }
  }

  const newDeadlineAt = new Date(approvedAt.getTime() + originalDurationMs(task))
  return { oldDeadlineAt, newDeadlineAt, deadlineAdjusted: true }
}

export function assertTaskCanSubmitApproval(task: ApprovalTask, assigneeCount: number, now: Date) {
  if (task.status !== 'DRAFT') {
    throw new TaskApprovalError(409, `仅草稿任务可提交审核（当前 ${task.status}）`)
  }
  if (assigneeCount <= 0) {
    throw new TaskApprovalError(400, '任务没有执行人，无法提交审核')
  }
  if (!task.reviewerId) {
    throw new TaskApprovalError(400, '任务没有审核人，无法提交审核')
  }
  if (task.deadlineMode === 'AFTER_APPROVAL_DAYS') {
    const days = task.deadlineDaysAfterApproval ?? DEFAULT_DEADLINE_DAYS_AFTER_APPROVAL
    if (!Number.isInteger(days) || days <= 0 || days > 365) {
      throw new TaskApprovalError(400, '审核通过后完成天数必须为 1-365 天')
    }
    return
  }
  if (task.deadlineMode !== 'FIXED') {
    throw new TaskApprovalError(400, 'deadlineMode 非法')
  }
  if (!task.deadlineAt) {
    throw new TaskApprovalError(400, '固定截止时间不能为空')
  }
  if (task.deadlineAt.getTime() <= now.getTime()) {
    throw new TaskApprovalError(400, '固定截止时间必须晚于提交审核时间')
  }
}

export async function submitTaskApproval(
  tx: Prisma.TransactionClient,
  params: {
    task: ApprovalTask
    assigneeCount: number
    operatorId: string
    comment?: string | null
    now?: Date
  },
) {
  const now = params.now ?? new Date()
  assertTaskCanSubmitApproval(params.task, params.assigneeCount, now)
  const updated = await tx.standardExecutionTask.update({
    where: { id: params.task.id },
    data: {
      status: 'PENDING_APPROVAL',
      submittedForApprovalAt: now,
      updatedBy: params.operatorId,
    },
  })
  await tx.standardExecutionTaskApprovalLog.create({
    data: {
      enterpriseId: params.task.enterpriseId,
      taskId: params.task.id,
      action: 'SUBMIT_APPROVAL',
      fromStatus: 'DRAFT',
      toStatus: 'PENDING_APPROVAL',
      reviewerId: params.operatorId,
      comment: trimComment(params.comment),
    },
  })
  return updated
}

export async function approveTaskApproval(
  tx: Prisma.TransactionClient,
  params: {
    task: ApprovalTask
    operatorId: string
    comment?: string | null
    now?: Date
  },
) {
  if (params.task.status !== 'PENDING_APPROVAL') {
    throw new TaskApprovalError(409, `仅待审核任务可审核通过（当前 ${params.task.status}）`)
  }
  const approvedAt = params.now ?? new Date()
  const deadline = resolveApprovedDeadline(params.task, approvedAt)
  const updated = await tx.standardExecutionTask.update({
    where: { id: params.task.id },
    data: {
      status: 'PUBLISHED',
      approvedAt,
      publishedAt: approvedAt,
      deadlineAt: deadline.newDeadlineAt,
      updatedBy: params.operatorId,
    },
  })
  await tx.standardExecutionTaskApprovalLog.create({
    data: {
      enterpriseId: params.task.enterpriseId,
      taskId: params.task.id,
      action: 'APPROVE',
      fromStatus: 'PENDING_APPROVAL',
      toStatus: 'PUBLISHED',
      reviewerId: params.operatorId,
      comment: trimComment(params.comment),
    },
  })
  return { task: updated, ...deadline }
}

export async function rejectTaskApproval(
  tx: Prisma.TransactionClient,
  params: {
    task: ApprovalTask
    operatorId: string
    comment?: string | null
  },
) {
  if (params.task.status !== 'PENDING_APPROVAL') {
    throw new TaskApprovalError(409, `仅待审核任务可驳回（当前 ${params.task.status}）`)
  }
  const updated = await tx.standardExecutionTask.update({
    where: { id: params.task.id },
    data: {
      status: 'DRAFT',
      submittedForApprovalAt: null,
      approvedAt: null,
      publishedAt: null,
      updatedBy: params.operatorId,
    },
  })
  await tx.standardExecutionTaskApprovalLog.create({
    data: {
      enterpriseId: params.task.enterpriseId,
      taskId: params.task.id,
      action: 'REJECT',
      fromStatus: 'PENDING_APPROVAL',
      toStatus: 'DRAFT',
      reviewerId: params.operatorId,
      comment: trimComment(params.comment),
    },
  })
  return updated
}
