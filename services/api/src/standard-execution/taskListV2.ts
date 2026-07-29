import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import type {
  MyTaskListV2Query,
  MpTaskTab,
  TaskListV2ManagementTab,
  TaskListV2Query,
} from './types.js'
import { ASSIGNEE_STATUS, type AssigneeStatus } from './enums.js'
import { EMPLOYEE_VISIBLE_TASK_STATUSES } from './taskApproval.js'
import { buildSubmitFormConfig } from './submitFormConfig.js'

const ACTIVE_TASK_STATUSES = ['PUBLISHED', 'IN_PROGRESS', 'OVERDUE'] as const
const DONE_TASK_STATUSES = ['COMPLETED', 'CANCELLED'] as const
const TODO_ASSIGNEE_STATUSES = ['PENDING', 'IN_PROGRESS', 'REJECTED'] as const
const DAY_MS = 24 * 60 * 60 * 1000

const managementInclude = {
  plan: { select: { id: true, title: true } },
  requirement: { include: { source: true } },
  items: {
    include: { requirement: { include: { source: true } } },
    orderBy: { createdAt: 'asc' },
  },
  assignees: true,
} satisfies Prisma.StandardExecutionTaskInclude

const assigneeInclude = {
  task: {
    include: {
      requirement: { include: { source: true } },
      plan: { select: { id: true, title: true } },
      items: {
        include: { requirement: { include: { source: true } } },
        orderBy: { createdAt: 'asc' },
      },
      assignees: true,
    },
  },
} satisfies Prisma.StandardExecutionTaskAssigneeInclude

type ManagementTaskRow = Prisma.StandardExecutionTaskGetPayload<{ include: typeof managementInclude }>
type MyTaskRow = Prisma.StandardExecutionTaskAssigneeGetPayload<{ include: typeof assigneeInclude }>
type UserLite = { id: string; name: string | null; phone: string | null; email: string | null; avatarUrl: string | null }
type RequirementLite = NonNullable<ManagementTaskRow['requirement']>

function nowRange(deadline?: TaskListV2Query['deadline'] | MyTaskListV2Query['deadline']) {
  const now = new Date()
  const dueSoonEnd = new Date(now.getTime() + 7 * DAY_MS)
  if (deadline === 'overdue') return { now, dueSoonEnd, value: { lt: now } }
  if (deadline === 'dueSoon') return { now, dueSoonEnd, value: { gte: now, lte: dueSoonEnd } }
  if (deadline === 'none') return { now, dueSoonEnd, value: null }
  return { now, dueSoonEnd, value: undefined }
}

function deadlineWhere(deadline?: TaskListV2Query['deadline'] | MyTaskListV2Query['deadline']): Prisma.StandardExecutionTaskWhereInput | null {
  const deadlineRange = nowRange(deadline)
  if (deadlineRange.value === undefined) return null
  if (deadline === 'overdue') {
    return {
      OR: [
        { status: 'OVERDUE' },
        { AND: [{ status: { in: [...ACTIVE_TASK_STATUSES] } }, { deadlineAt: deadlineRange.value }] },
      ],
    }
  }
  return { deadlineAt: deadlineRange.value }
}

function taskIsOverdue(task: { status: string; deadlineAt: Date | null }) {
  return (
    task.status === 'OVERDUE' ||
    (ACTIVE_TASK_STATUSES.includes(task.status as never) && !!task.deadlineAt && task.deadlineAt.getTime() < Date.now())
  )
}

function tabWhere(tab: TaskListV2ManagementTab, userId?: string): Prisma.StandardExecutionTaskWhereInput {
  if (tab === 'draft') return { status: 'DRAFT' }
  if (tab === 'todo') {
    return {
      OR: [
        { status: 'PENDING_APPROVAL' },
        { assignees: { some: { status: 'PENDING_REVIEW' } } },
      ],
    }
  }
  if (tab === 'executing') {
    return {
      OR: [
        { status: { in: [...ACTIVE_TASK_STATUSES] } },
        deadlineWhere('overdue') ?? { status: 'OVERDUE' },
      ],
    }
  }
  if (tab === 'ended') return { status: { in: [...DONE_TASK_STATUSES] } }
  if (tab === 'plan') return { planId: { not: null } }
  if (tab === 'requirement') return { OR: [{ requirementId: { not: null } }, { items: { some: {} } }] }
  if (tab === 'mine' && userId) return { OR: [{ reviewerId: userId }, { createdBy: userId }, { assignees: { some: { assigneeId: userId } } }] }
  if (tab === 'mine') return { id: '__NO_CURRENT_USER__' }
  if (tab === 'closed') return { status: { in: [...DONE_TASK_STATUSES] } }
  return {}
}

function statusWhere(status: string): Prisma.StandardExecutionTaskWhereInput {
  if (status === 'PENDING_REVIEW') return { assignees: { some: { status: 'PENDING_REVIEW' } } }
  if (status === 'EXECUTING') {
    return {
      status: { in: [...ACTIVE_TASK_STATUSES] },
      assignees: { some: { status: { not: 'COMPLETED' } } },
    }
  }
  if (status === 'OVERDUE') return deadlineWhere('overdue') ?? { status: 'OVERDUE' }
  if (status === 'CLOSED') return { status: 'CANCELLED' }
  return { status }
}

function statusFilterWhere(status: TaskListV2Query['status']): Prisma.StandardExecutionTaskWhereInput | null {
  if (!status) return null
  const values = Array.isArray(status) ? status : [status]
  return { OR: values.map((value) => statusWhere(value)) }
}

function assigneeTabWhere(tab: MpTaskTab): Prisma.StandardExecutionTaskAssigneeWhereInput {
  if (tab === 'closed') return { task: { status: 'CANCELLED' } }
  if (tab === 'review') return { status: 'PENDING_REVIEW', task: { status: { in: [...EMPLOYEE_VISIBLE_TASK_STATUSES] } } }
  if (tab === 'done') return { status: 'COMPLETED', task: { status: { in: [...EMPLOYEE_VISIBLE_TASK_STATUSES] } } }
  return { status: { in: [...TODO_ASSIGNEE_STATUSES] }, task: { status: { in: [...EMPLOYEE_VISIBLE_TASK_STATUSES] } } }
}

function buildManagementWhere(
  enterpriseId: string,
  query: TaskListV2Query,
  overrideTab?: TaskListV2ManagementTab,
  userId?: string,
): Prisma.StandardExecutionTaskWhereInput {
  const clauses: Prisma.StandardExecutionTaskWhereInput[] = [{ enterpriseId, deletedAt: null }, tabWhere(overrideTab ?? query.tab, userId)]
  const deadline = deadlineWhere(query.deadline)

  const statusFilter = statusFilterWhere(query.status)
  if (statusFilter) clauses.push(statusFilter)
  if (query.assigneeStatus) {
    clauses.push({
      assignees: { some: { status: Array.isArray(query.assigneeStatus) ? { in: query.assigneeStatus } : query.assigneeStatus } },
    })
  }
  if (query.origin === 'PLAN') clauses.push({ planId: { not: null } })
  if (query.origin === 'MANUAL') clauses.push({ planId: null })
  if (query.planId) clauses.push({ planId: query.planId })
  if (query.reviewerId) clauses.push({ reviewerId: query.reviewerId })
  if (query.assigneeId) clauses.push({ assignees: { some: { assigneeId: query.assigneeId } } })
  if (query.mine) clauses.push(tabWhere('mine', userId))
  if (query.requirementId) {
    clauses.push({ OR: [{ requirementId: query.requirementId }, { items: { some: { requirementId: query.requirementId } } }] })
  }
  if (query.sourceId) {
    clauses.push({
      OR: [
        { requirement: { sourceId: query.sourceId } },
        { items: { some: { requirement: { sourceId: query.sourceId } } } },
      ],
    })
  }
  if (query.keyword) {
    clauses.push({
      OR: [
        { title: { contains: query.keyword, mode: 'insensitive' } },
        { requirement: { title: { contains: query.keyword, mode: 'insensitive' } } },
        { items: { some: { requirement: { title: { contains: query.keyword, mode: 'insensitive' } } } } },
      ],
    })
  }
  if (deadline) clauses.push(deadline)

  return { AND: clauses }
}

function mergeTaskWhere(
  base: Prisma.StandardExecutionTaskWhereInput | undefined,
  next: Prisma.StandardExecutionTaskWhereInput,
): Prisma.StandardExecutionTaskWhereInput {
  if (!base || Object.keys(base).length === 0) return next
  return { AND: [base, next] }
}

function buildMyWhere(
  enterpriseId: string,
  userId: string,
  query: MyTaskListV2Query,
  overrideTab?: MpTaskTab,
): Prisma.StandardExecutionTaskAssigneeWhereInput {
  const base = assigneeTabWhere(overrideTab ?? query.tab)
  const taskClauses: Prisma.StandardExecutionTaskWhereInput[] = [{ deletedAt: null }]
  const deadline = deadlineWhere(query.deadline)

  if (query.taskType) taskClauses.push({ taskType: query.taskType })
  if (query.keyword) {
    taskClauses.push({
      OR: [
        { title: { contains: query.keyword, mode: 'insensitive' } },
        { requirement: { title: { contains: query.keyword, mode: 'insensitive' } } },
        { items: { some: { requirement: { title: { contains: query.keyword, mode: 'insensitive' } } } } },
      ],
    })
  }
  if (deadline) taskClauses.push(deadline)

  return {
    ...base,
    enterpriseId,
    assigneeId: userId,
    task: mergeTaskWhere(base.task, { AND: taskClauses }),
  }
}

function statusCounts(assignees: { status: string }[]) {
  const counts = Object.fromEntries(ASSIGNEE_STATUS.map((status) => [status, 0])) as Record<AssigneeStatus, number>
  for (const assignee of assignees) {
    if (ASSIGNEE_STATUS.includes(assignee.status as AssigneeStatus)) counts[assignee.status as AssigneeStatus] += 1
  }
  return { total: assignees.length, byStatus: counts }
}

function assigneeMetrics(assignees: { status: string }[]) {
  const summary = statusCounts(assignees)
  return {
    summary,
    pendingReviewCount: summary.byStatus.PENDING_REVIEW,
    completedCount: summary.byStatus.COMPLETED,
    overdueCount: summary.byStatus.OVERDUE,
  }
}

function userMap(users: UserLite[]) {
  return new Map(users.map((user) => [user.id, user]))
}

function userDto(user?: UserLite) {
  return user ? { id: user.id, name: user.name, phone: user.phone, email: user.email, avatarUrl: user.avatarUrl } : null
}

function snapshotBasis(value: Prisma.JsonValue | null) {
  if (!Array.isArray(value)) return []
  const rows: Record<string, unknown>[] = []
  for (const item of value) {
    if (item && typeof item === 'object' && !Array.isArray(item)) rows.push(item as Record<string, unknown>)
  }
  return rows
    .map((item) => ({
      requirementId: typeof item.requirementId === 'string' ? item.requirementId : null,
      sourceId: typeof item.sourceId === 'string' ? item.sourceId : null,
      sourceTitle: typeof item.sourceTitle === 'string' ? item.sourceTitle : null,
      sourceNo: typeof item.sourceNo === 'string' ? item.sourceNo : null,
      sourceType: typeof item.sourceType === 'string' ? item.sourceType : null,
      clauseNo: typeof item.clauseNo === 'string' ? item.clauseNo : null,
      title: typeof item.title === 'string' ? item.title : '',
      requirementText: typeof item.requirementText === 'string' ? item.requirementText : '',
    }))
}

function requirementBasis(requirement: RequirementLite) {
  return {
    requirementId: requirement.id,
    sourceId: requirement.sourceId,
    sourceTitle: requirement.source?.title ?? null,
    sourceNo: requirement.source?.sourceNo ?? null,
    sourceType: requirement.source?.sourceType ?? null,
    clauseNo: requirement.clauseNo,
    title: requirement.title,
    requirementText: requirement.requirementText,
  }
}

function resolveBasis(task: ManagementTaskRow) {
  const snap = snapshotBasis(task.basisSnapshots)
  if (snap.length > 0) return snap
  if (task.items.length > 0) return task.items.map((item) => requirementBasis(item.requirement))
  return task.requirement ? [requirementBasis(task.requirement)] : []
}

function sourceFromBasis(basis: ReturnType<typeof resolveBasis>) {
  const first = basis.find((item) => item.sourceId || item.sourceTitle)
  return first
    ? {
        id: first.sourceId,
        title: first.sourceTitle,
        sourceNo: first.sourceNo,
        sourceType: first.sourceType,
      }
    : null
}

function requirementSummary(basis: ReturnType<typeof resolveBasis>) {
  return basis.slice(0, 3).map((item) => ({
    requirementId: item.requirementId,
    clauseNo: item.clauseNo,
    title: item.title,
    sourceTitle: item.sourceTitle,
  }))
}

function managementActions(task: { status: string }) {
  if (task.status === 'DRAFT') return ['edit', 'assign', 'submitApproval', 'delete']
  if (task.status === 'PENDING_APPROVAL') return ['view']
  if (ACTIVE_TASK_STATUSES.includes(task.status as never)) return ['view', 'cancel']
  return ['view']
}

function myActions(assignee: { status: string; task: { status: string } }) {
  if (assignee.task.status === 'CANCELLED') return ['view']
  if (assignee.status === 'PENDING') return ['start']
  if (assignee.status === 'IN_PROGRESS') return ['continue']
  if (assignee.status === 'REJECTED') return ['resubmit']
  if (assignee.status === 'PENDING_REVIEW') return ['viewReview']
  if (assignee.status === 'COMPLETED') return ['viewResult']
  return ['view']
}

async function fetchUsers(ids: string[]) {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)))
  if (uniqueIds.length === 0) return userMap([])
  const users = await prisma.appUser.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, name: true, phone: true, email: true, avatarUrl: true },
  })
  return userMap(users)
}

function taskDto(task: ManagementTaskRow, users: Map<string, UserLite>) {
  const basis = resolveBasis(task)
  const metrics = assigneeMetrics(task.assignees)
  const reviewer = task.reviewerId ? userDto(users.get(task.reviewerId)) : null
  return {
    enterpriseId: task.enterpriseId,
    id: task.id,
    requirementId: task.requirementId,
    planId: task.planId,
    planTitle: task.plan?.title ?? null,
    title: task.title,
    description: task.description,
    taskType: task.taskType,
    submitRequirement: task.submitRequirement,
    deadlineMode: task.deadlineMode,
    deadlineDaysAfterApproval: task.deadlineDaysAfterApproval,
    status: task.status,
    origin: task.planId ? 'PLAN' : 'MANUAL',
    deadlineAt: task.deadlineAt,
    reviewerId: task.reviewerId,
    reviewerName: reviewer?.name || reviewer?.phone || reviewer?.email || null,
    reviewer,
    isOverdue: taskIsOverdue(task),
    basis,
    requirementCount: basis.length,
    requirementSummary: requirementSummary(basis),
    source: sourceFromBasis(basis),
    requirement: task.requirement,
    taskItems: task.items.map((item) => ({ id: item.id, status: item.status, requirement: item.requirement })),
    hasTaskItems: task.items.length > 0,
    hasQuiz: !!task.quizBankId,
    quizBankId: task.quizBankId,
    checklistSchema: task.checklistSchema,
    parametersSchema: task.parametersSchema,
    learningMaterials: task.learningMaterials,
    submitFormConfig: buildSubmitFormConfig({
      taskType: task.taskType,
      checklistSchema: task.checklistSchema,
      parametersSchema: task.parametersSchema,
      learningMaterials: task.learningMaterials,
      quizBankId: task.quizBankId,
      taskItemCount: task.items.length,
    }),
    basisSnapshots: task.basisSnapshots,
    assigneeCount: metrics.summary.total,
    assigneeSummary: metrics.summary,
    pendingReviewCount: metrics.pendingReviewCount,
    completedCount: metrics.completedCount,
    overdueCount: metrics.overdueCount,
    assignees: task.assignees.map((assignee) => ({
      id: assignee.id,
      assigneeId: assignee.assigneeId,
      user: userDto(users.get(assignee.assigneeId)),
      status: assignee.status,
      submittedAt: assignee.submittedAt,
      reviewedAt: assignee.reviewedAt,
    })),
    availableActions: managementActions(task),
    submittedForApprovalAt: task.submittedForApprovalAt,
    approvedAt: task.approvedAt,
    publishedAt: task.publishedAt,
    completedAt: task.completedAt,
    cancelledAt: task.cancelledAt,
    createdBy: task.createdBy,
    updatedBy: task.updatedBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

function myTaskDto(row: MyTaskRow, users: Map<string, UserLite>) {
  const task = row.task
  const basis = resolveBasis(task)
  return {
    assigneeId: row.id,
    assigneeUserId: row.assigneeId,
    assigneeStatus: row.status,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    isRejected: row.status === 'REJECTED',
    isOverdue: taskIsOverdue(task) && row.status !== 'COMPLETED',
    availableActions: myActions(row),
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      taskType: task.taskType,
      status: task.status,
      deadlineAt: task.deadlineAt,
      submitRequirement: task.submitRequirement,
      basis,
      source: sourceFromBasis(basis),
      requirement: task.requirement,
      taskItems: task.items.map((item) => ({ id: item.id, status: item.status, requirement: item.requirement })),
      hasTaskItems: task.items.length > 0,
      hasQuiz: !!task.quizBankId,
      submitFormConfig: buildSubmitFormConfig({
        taskType: task.taskType,
        checklistSchema: task.checklistSchema,
        parametersSchema: task.parametersSchema,
        learningMaterials: task.learningMaterials,
        quizBankId: task.quizBankId,
        taskItemCount: task.items.length,
      }),
      reviewer: task.reviewerId ? userDto(users.get(task.reviewerId)) : null,
      assigneeSummary: statusCounts(task.assignees),
    },
  }
}

export async function buildManagementTaskListV2(enterpriseId: string, query: TaskListV2Query, userId?: string) {
  const where = buildManagementWhere(enterpriseId, query, undefined, userId)
  const [rows, total, counts] = await Promise.all([
    prisma.standardExecutionTask.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: managementInclude,
    }),
    prisma.standardExecutionTask.count({ where }),
    query.includeCounts ? buildManagementCounts(enterpriseId, query, userId) : Promise.resolve(undefined),
  ])
  const users = await fetchUsers(rows.flatMap((task) => [task.reviewerId ?? '', ...task.assignees.map((a) => a.assigneeId)]))
  return { data: rows.map((task) => taskDto(task, users)), total, page: query.page, pageSize: query.pageSize, counts }
}

export async function buildManagementCounts(enterpriseId: string, query: TaskListV2Query, userId?: string) {
  const tabs: TaskListV2ManagementTab[] = ['all', 'draft', 'todo', 'executing', 'ended']
  const pairs = await Promise.all(tabs.map(async (tab) => [tab, await prisma.standardExecutionTask.count({ where: buildManagementWhere(enterpriseId, query, tab, userId) })] as const))
  const result = Object.fromEntries(pairs) as Record<string, number>
  result.overdue = await prisma.standardExecutionTask.count({ where: buildManagementWhere(enterpriseId, { ...query, deadline: 'overdue', status: undefined }, 'executing', userId) })
  result.plan = await prisma.standardExecutionTask.count({ where: buildManagementWhere(enterpriseId, query, 'plan', userId) })
  result.requirement = await prisma.standardExecutionTask.count({ where: buildManagementWhere(enterpriseId, query, 'requirement', userId) })
  result.mine = await prisma.standardExecutionTask.count({ where: buildManagementWhere(enterpriseId, query, 'mine', userId) })
  result.closed = result.ended ?? 0
  return result as Record<TaskListV2ManagementTab | 'todo' | 'executing' | 'ended' | 'overdue', number>
}

export async function buildMyTaskListV2(enterpriseId: string, userId: string, query: MyTaskListV2Query) {
  const where = buildMyWhere(enterpriseId, userId, query)
  const [rows, total, counts] = await Promise.all([
    prisma.standardExecutionTaskAssignee.findMany({
      where,
      orderBy: query.tab === 'done' || query.tab === 'closed'
        ? [{ updatedAt: 'desc' }]
        : [{ task: { deadlineAt: 'asc' } }, { updatedAt: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: assigneeInclude,
    }),
    prisma.standardExecutionTaskAssignee.count({ where }),
    query.includeCounts ? buildMyCounts(enterpriseId, userId, query) : Promise.resolve(undefined),
  ])
  const users = await fetchUsers(rows.flatMap((row) => [row.task.reviewerId ?? '', ...row.task.assignees.map((a) => a.assigneeId)]))
  return { data: rows.map((row) => myTaskDto(row, users)), total, page: query.page, pageSize: query.pageSize, counts }
}

export async function buildMyCounts(enterpriseId: string, userId: string, query: MyTaskListV2Query) {
  const tabs: MpTaskTab[] = ['todo', 'review', 'done', 'closed']
  const pairs = await Promise.all(tabs.map(async (tab) => [tab, await prisma.standardExecutionTaskAssignee.count({ where: buildMyWhere(enterpriseId, userId, query, tab) })] as const))
  return Object.fromEntries(pairs) as Record<MpTaskTab, number>
}
