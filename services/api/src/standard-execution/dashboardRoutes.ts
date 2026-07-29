/**
 * standard-execution 总览 Dashboard
 *
 *   GET /api/admin/standard-execution/dashboard       — Admin（DEFAULT 企业）
 *   GET /api/enterprise/standard-execution/dashboard  — 企业用户（按当前 enterpriseId 隔离）
 *
 * 返回 counts（多表 count）+ recentTasks/recentReviews/recentRecords（最近 10）+ 实时算 risks 总数
 *
 * @see 必读/00_项目概述.md §五 SE 主链路 + 必读/02_技术架构.md §四 SE 模型（总览看板聚合）
 */
import type { Express, Response } from 'express'
import { z } from 'zod'
import xlsx from 'xlsx'
import { prisma } from '../db.js'
import { requireAdmin, requireAuth, type AuthRequest } from '../auth.js'
import { getEnterpriseId } from './utils.js'
import { computeRisks } from './riskRoutes.js'

const DEFAULT_ENTERPRISE_ID = 'DEFAULT'
const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000
const DAY_MS = 24 * 3600 * 1000

const IntelligenceDashboardQuerySchema = z.object({
  range: z.coerce.number().int().refine((value) => [30, 90, 365].includes(value), {
    message: 'range 仅支持 30/90/365',
  }).default(90),
})

type IntelligenceTrendPoint = {
  label: string
  startDate: string
  endDate: string
  total: number
  completed?: number
  approved?: number
  overdue?: number
  rate?: number
}

type IntelligenceDashboardData = Awaited<ReturnType<typeof buildIntelligenceDashboardData>>

function percent(numerator: number, denominator: number) {
  if (!denominator) return 0
  return Math.round((numerator / denominator) * 100)
}

function daysUntil(from: Date, to: Date) {
  return Math.ceil((to.getTime() - from.getTime()) / (24 * 3600 * 1000))
}

function toDateOnly(value: Date) {
  return value.toISOString().slice(0, 10)
}

function formatMonthDay(value: Date) {
  return value.toISOString().slice(5, 10)
}

function startOfDay(value: Date) {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date
}

function addDays(value: Date, days: number) {
  const date = new Date(value)
  date.setDate(date.getDate() + days)
  return date
}

function monthStart(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), 1)
}

function buildWeekBuckets(start: Date, end: Date) {
  const buckets: Array<IntelligenceTrendPoint & { start: Date; end: Date }> = []
  let cursor = startOfDay(start)
  while (cursor.getTime() <= end.getTime()) {
    const bucketStart = cursor
    const bucketEnd = new Date(Math.min(addDays(bucketStart, 6).getTime(), end.getTime()))
    buckets.push({
      label: `${formatMonthDay(bucketStart)}~${formatMonthDay(bucketEnd)}`,
      startDate: toDateOnly(bucketStart),
      endDate: toDateOnly(bucketEnd),
      start: bucketStart,
      end: bucketEnd,
      total: 0,
      completed: 0,
      approved: 0,
      overdue: 0,
      rate: 0,
    })
    cursor = addDays(bucketStart, 7)
  }
  return buckets
}

function bucketIndexFor(date: Date | null | undefined, buckets: Array<{ start: Date; end: Date }>) {
  if (!date || buckets.length === 0) return -1
  const ts = date.getTime()
  return buckets.findIndex((bucket) => ts >= bucket.start.getTime() && ts <= addDays(bucket.end, 1).getTime() - 1)
}

function stripBucketInternals(buckets: Array<IntelligenceTrendPoint & { start: Date; end: Date }>) {
  return buckets.map(({ start: _start, end: _end, ...bucket }) => bucket)
}

function currentOverdueWhere(enterpriseId: string, now: Date) {
  return {
    enterpriseId,
    deletedAt: null,
    OR: [
      { status: 'OVERDUE' },
      { status: 'PUBLISHED', deadlineAt: { lt: now } },
    ],
  }
}

async function buildComplianceRadarData(enterpriseId: string, risks: Awaited<ReturnType<typeof computeRisks>>) {
  const now = new Date()
  const startOfMonth = monthStart(now)
  const reviewSince = new Date(now.getTime() - THIRTY_DAYS_MS)
  const expiresSoon = new Date(now.getTime() + THIRTY_DAYS_MS)
  const overdueTaskWhere = {
    enterpriseId,
    deletedAt: null,
    OR: [
      { status: 'OVERDUE' },
      { status: 'PUBLISHED', deadlineAt: { lt: now } },
    ],
  }
  const monthTaskWhere = {
    enterpriseId,
    deletedAt: null,
    status: { in: ['PUBLISHED', 'OVERDUE', 'COMPLETED'] },
    OR: [
      { publishedAt: { gte: startOfMonth } },
      { completedAt: { gte: startOfMonth } },
      { createdAt: { gte: startOfMonth } },
    ],
  }
  const reviewedWhere = {
    enterpriseId,
    status: { in: ['APPROVED', 'REJECTED'] },
    reviewedAt: { gte: reviewSince },
  }

  const [
    activeRequirements,
    validRecords,
    monthlyTasksTotal,
    monthlyTasksCompleted,
    reviewedSubmissionsTotal,
    approvedSubmissions,
    overdueTasksCount,
    overdueTasks,
  ] = await Promise.all([
    prisma.standardExecutionRequirement.findMany({
      where: { enterpriseId, status: 'ACTIVE' },
      select: {
        id: true,
        sourceId: true,
        source: { select: { id: true, title: true, sourceNo: true, version: true } },
      },
    }),
    prisma.standardExecutionRecord.findMany({
      where: {
        enterpriseId,
        status: 'VALID',
        OR: [
          { validUntil: null },
          { validUntil: { lte: expiresSoon } },
          { validUntil: { gt: expiresSoon } },
        ],
      },
      select: {
        id: true,
        title: true,
        requirementId: true,
        sourceId: true,
        taskId: true,
        validUntil: true,
        recordDate: true,
      },
    }),
    prisma.standardExecutionTask.count({ where: monthTaskWhere }),
    prisma.standardExecutionTask.count({ where: { ...monthTaskWhere, status: 'COMPLETED' } }),
    prisma.standardExecutionSubmission.count({ where: reviewedWhere }),
    prisma.standardExecutionSubmission.count({ where: { ...reviewedWhere, status: 'APPROVED' } }),
    prisma.standardExecutionTask.count({ where: overdueTaskWhere }),
    prisma.standardExecutionTask.findMany({
      where: overdueTaskWhere,
      select: { id: true, requirementId: true },
    }),
  ])

  const activeRequirementIds = new Set(activeRequirements.map((r) => r.id))
  const coveredRequirementIds = new Set(
    validRecords
      .filter((record) => activeRequirementIds.has(record.requirementId))
      .map((record) => record.requirementId),
  )

  const requirementsBySource = new Map<string, typeof activeRequirements>()
  for (const requirement of activeRequirements) {
    const list = requirementsBySource.get(requirement.sourceId) || []
    list.push(requirement)
    requirementsBySource.set(requirement.sourceId, list)
  }
  const overdueByRequirement = new Map<string, number>()
  for (const task of overdueTasks) {
    if (!task.requirementId) continue
    overdueByRequirement.set(task.requirementId, (overdueByRequirement.get(task.requirementId) || 0) + 1)
  }

  const heatmap = Array.from(requirementsBySource.entries())
    .map(([sourceId, requirements]) => {
      const covered = requirements.filter((requirement) => coveredRequirementIds.has(requirement.id)).length
      const overdueCount = requirements.reduce((sum, requirement) => sum + (overdueByRequirement.get(requirement.id) || 0), 0)
      const source = requirements[0]?.source
      return {
        sourceId,
        sourceTitle: source?.title || '未知标准来源',
        sourceNo: source?.sourceNo ?? null,
        version: source?.version ?? null,
        controlPointCount: requirements.length,
        coveredCount: covered,
        coverageRate: percent(covered, requirements.length),
        overdueTaskCount: overdueCount,
      }
    })
    .sort((a, b) => a.coverageRate - b.coverageRate || b.overdueTaskCount - a.overdueTaskCount || a.sourceTitle.localeCompare(b.sourceTitle, 'zh-CN'))

  const expiringRecords = validRecords
    .filter((record) => record.validUntil && record.validUntil.getTime() <= expiresSoon.getTime())
    .map((record) => {
      const remaining = daysUntil(now, record.validUntil!)
      return {
        recordId: record.id,
        recordTitle: record.title,
        requirementId: record.requirementId,
        sourceId: record.sourceId,
        taskId: record.taskId,
        validUntil: record.validUntil!.toISOString(),
        daysUntilExpiry: remaining,
        severity: remaining < 0 ? 'ERROR' : remaining <= 7 ? 'RED' : 'ORANGE',
      }
    })
    .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry)
    .slice(0, 20)

  return {
    generatedAt: now.toISOString(),
    metrics: {
      controlPointCoverage: {
        covered: coveredRequirementIds.size,
        total: activeRequirements.length,
        rate: percent(coveredRequirementIds.size, activeRequirements.length),
      },
      monthlyTaskCompletion: {
        completed: monthlyTasksCompleted,
        total: monthlyTasksTotal,
        rate: percent(monthlyTasksCompleted, monthlyTasksTotal),
      },
      reviewPassRate: {
        approved: approvedSubmissions,
        total: reviewedSubmissionsTotal,
        rate: percent(approvedSubmissions, reviewedSubmissionsTotal),
      },
      overdueTasks: {
        count: overdueTasksCount,
      },
    },
    heatmap,
    expiringRecords,
    riskEvents: risks,
  }
}

export async function buildDashboardData(enterpriseId: string) {
  const now = new Date()
  const [
    sources,
    requirements,
    requirementsActive,
    tasks,
    tasksDraft,
    tasksPublished,
    tasksCompleted,
    tasksOverdue,
    assigneesPending,
    assigneesPendingReview,
    assigneesCompleted,
    submissionsPending,
    packages,
    packagesReady,
    records,
    recordsValid,
    recentTasks,
    recentReviews,
    recentRecords,
    risks,
  ] = await Promise.all([
    prisma.standardExecutionSource.count({ where: { enterpriseId } }),
    prisma.standardExecutionRequirement.count({ where: { enterpriseId } }),
    prisma.standardExecutionRequirement.count({ where: { enterpriseId, status: 'ACTIVE' } }),
    prisma.standardExecutionTask.count({ where: { enterpriseId } }),
    prisma.standardExecutionTask.count({ where: { enterpriseId, status: 'DRAFT' } }),
    prisma.standardExecutionTask.count({ where: { enterpriseId, status: 'PUBLISHED' } }),
    prisma.standardExecutionTask.count({ where: { enterpriseId, status: 'COMPLETED' } }),
    prisma.standardExecutionTask.count({
      where: { enterpriseId, status: 'PUBLISHED', deadlineAt: { lt: now } },
    }),
    prisma.standardExecutionTaskAssignee.count({ where: { enterpriseId, status: 'PENDING' } }),
    prisma.standardExecutionTaskAssignee.count({ where: { enterpriseId, status: 'PENDING_REVIEW' } }),
    prisma.standardExecutionTaskAssignee.count({ where: { enterpriseId, status: 'COMPLETED' } }),
    prisma.standardExecutionSubmission.count({ where: { enterpriseId, status: 'SUBMITTED' } }),
    prisma.standardExecutionPackage.count({ where: { enterpriseId } }),
    prisma.standardExecutionPackage.count({ where: { enterpriseId, status: 'READY' } }),
    prisma.standardExecutionRecord.count({ where: { enterpriseId } }),
    prisma.standardExecutionRecord.count({ where: { enterpriseId, status: 'VALID' } }),
    prisma.standardExecutionTask.findMany({
      where: { enterpriseId, status: { in: ['PUBLISHED', 'COMPLETED', 'OVERDUE'] } },
      orderBy: { publishedAt: 'desc' },
      take: 10,
      select: { id: true, title: true, status: true, deadlineAt: true, publishedAt: true },
    }),
    prisma.standardExecutionSubmission.findMany({
      where: { enterpriseId, status: 'SUBMITTED' },
      orderBy: { submittedAt: 'asc' },
      take: 10,
      select: { id: true, taskId: true, assigneeId: true, version: true, submittedAt: true },
    }),
    prisma.standardExecutionRecord.findMany({
      where: { enterpriseId, status: 'VALID' },
      orderBy: { recordDate: 'desc' },
      take: 10,
      select: { id: true, title: true, taskId: true, assigneeId: true, recordDate: true },
    }),
    computeRisks(enterpriseId),
  ])
  const complianceRadar = await buildComplianceRadarData(enterpriseId, risks)

  return {
    counts: {
      sources,
      requirements,
      requirementsActive,
      tasks,
      tasksDraft,
      tasksPublished,
      tasksCompleted,
      tasksOverdue,
      assigneesPending,
      assigneesPendingReview,
      assigneesCompleted,
      submissionsPending,
      packages,
      packagesReady,
      records,
      recordsValid,
      risks: risks.length,
    },
    recentTasks,
    recentReviews,
    recentRecords,
    complianceRadar,
  }
}

export async function buildIntelligenceDashboardData(enterpriseId: string, rangeDays = 90, canViewPeople = true) {
  const now = new Date()
  const rangeEnd = new Date(now)
  const rangeStart = startOfDay(new Date(now.getTime() - (rangeDays - 1) * DAY_MS))
  const taskBuckets = buildWeekBuckets(rangeStart, rangeEnd)
  const reviewBuckets = buildWeekBuckets(rangeStart, rangeEnd)
  const overdueBuckets = buildWeekBuckets(rangeStart, rangeEnd)

  const [
    activeRequirements,
    validRecords,
    tasks,
    reviewedSubmissions,
    assigneeRows,
    users,
    currentOverdueTasks,
  ] = await Promise.all([
    prisma.standardExecutionRequirement.findMany({
      where: { enterpriseId, status: 'ACTIVE' },
      select: { id: true, sourceId: true, title: true },
    }),
    prisma.standardExecutionRecord.findMany({
      where: { enterpriseId, status: 'VALID' },
      select: {
        id: true,
        requirementId: true,
        departmentId: true,
        recordDate: true,
        assigneeId: true,
      },
    }),
    prisma.standardExecutionTask.findMany({
      where: {
        enterpriseId,
        deletedAt: null,
        OR: [
          { createdAt: { gte: rangeStart } },
          { publishedAt: { gte: rangeStart } },
          { completedAt: { gte: rangeStart } },
          { deadlineAt: { gte: rangeStart } },
        ],
      },
      select: {
        id: true,
        requirementId: true,
        status: true,
        createdAt: true,
        publishedAt: true,
        completedAt: true,
        deadlineAt: true,
      },
    }),
    prisma.standardExecutionSubmission.findMany({
      where: {
        enterpriseId,
        status: { in: ['APPROVED', 'REJECTED'] },
        reviewedAt: { gte: rangeStart },
      },
      select: {
        id: true,
        status: true,
        assigneeId: true,
        reviewerId: true,
        submittedAt: true,
        reviewedAt: true,
      },
    }),
    prisma.standardExecutionTaskAssignee.findMany({
      where: {
        enterpriseId,
        OR: [
          { createdAt: { gte: rangeStart } },
          { submittedAt: { gte: rangeStart } },
          { reviewedAt: { gte: rangeStart } },
        ],
        task: { deletedAt: null },
      },
      select: {
        id: true,
        taskId: true,
        assigneeId: true,
        departmentId: true,
        status: true,
        task: {
          select: {
            requirementId: true,
            status: true,
            deadlineAt: true,
          },
        },
      },
    }),
    prisma.appUser.findMany({
      where: { enterpriseId },
      select: { id: true, name: true, phone: true, email: true },
    }),
    prisma.standardExecutionTask.count({ where: currentOverdueWhere(enterpriseId, now) }),
  ])

  const activeRequirementIds = new Set(activeRequirements.map((requirement) => requirement.id))
  const coveredRequirementIds = new Set(
    validRecords
      .filter((record) => activeRequirementIds.has(record.requirementId))
      .map((record) => record.requirementId),
  )
  const inScopeTasks = tasks.filter((task) => ['PUBLISHED', 'OVERDUE', 'COMPLETED'].includes(task.status))
  const completedTasks = inScopeTasks.filter((task) => task.status === 'COMPLETED')
  const approvedReviews = reviewedSubmissions.filter((submission) => submission.status === 'APPROVED')

  for (const task of inScopeTasks) {
    const totalDate = task.publishedAt ?? task.createdAt
    const totalIndex = bucketIndexFor(totalDate, taskBuckets)
    if (totalIndex >= 0) taskBuckets[totalIndex].total += 1
    const completedIndex = bucketIndexFor(task.completedAt, taskBuckets)
    if (task.status === 'COMPLETED' && completedIndex >= 0) taskBuckets[completedIndex].completed = (taskBuckets[completedIndex].completed || 0) + 1
  }
  for (const bucket of taskBuckets) {
    bucket.rate = percent(bucket.completed || 0, bucket.total)
  }

  for (const submission of reviewedSubmissions) {
    const index = bucketIndexFor(submission.reviewedAt, reviewBuckets)
    if (index < 0) continue
    reviewBuckets[index].total += 1
    if (submission.status === 'APPROVED') {
      reviewBuckets[index].approved = (reviewBuckets[index].approved || 0) + 1
    }
  }
  for (const bucket of reviewBuckets) {
    bucket.rate = percent(bucket.approved || 0, bucket.total)
  }

  for (const task of tasks) {
    const isOverdue = task.status === 'OVERDUE' || (task.status === 'PUBLISHED' && !!task.deadlineAt && task.deadlineAt.getTime() < now.getTime())
    if (!isOverdue) continue
    const index = bucketIndexFor(task.deadlineAt ?? task.createdAt, overdueBuckets)
    if (index >= 0) {
      overdueBuckets[index].total += 1
      overdueBuckets[index].overdue = (overdueBuckets[index].overdue || 0) + 1
    }
  }

  const userLabel = new Map(users.map((user) => [user.id, user.name || user.phone || user.email || user.id]))
  const departmentRequirementIds = new Map<string, Set<string>>()
  const departmentCoveredIds = new Map<string, Set<string>>()
  const departmentOverdueTasks = new Map<string, Set<string>>()

  for (const row of assigneeRows) {
    if (!row.departmentId || !row.task.requirementId || !activeRequirementIds.has(row.task.requirementId)) continue
    if (!departmentRequirementIds.has(row.departmentId)) departmentRequirementIds.set(row.departmentId, new Set())
    departmentRequirementIds.get(row.departmentId)!.add(row.task.requirementId)
    const isOverdue = row.task.status === 'OVERDUE' || (row.task.status === 'PUBLISHED' && !!row.task.deadlineAt && row.task.deadlineAt.getTime() < now.getTime())
    if (isOverdue) {
      if (!departmentOverdueTasks.has(row.departmentId)) departmentOverdueTasks.set(row.departmentId, new Set())
      departmentOverdueTasks.get(row.departmentId)!.add(row.taskId)
    }
  }
  for (const record of validRecords) {
    if (!record.departmentId || !activeRequirementIds.has(record.requirementId)) continue
    if (!departmentCoveredIds.has(record.departmentId)) departmentCoveredIds.set(record.departmentId, new Set())
    departmentCoveredIds.get(record.departmentId)!.add(record.requirementId)
    if (!departmentRequirementIds.has(record.departmentId)) departmentRequirementIds.set(record.departmentId, new Set())
    departmentRequirementIds.get(record.departmentId)!.add(record.requirementId)
  }
  const departmentIds = Array.from(new Set([...departmentRequirementIds.keys(), ...departmentCoveredIds.keys(), ...departmentOverdueTasks.keys()]))
  const departmentRows = departmentIds
    .map((departmentId) => {
      const total = departmentRequirementIds.get(departmentId)?.size || 0
      const covered = departmentCoveredIds.get(departmentId)?.size || 0
      return {
        departmentId,
        controlPointCount: total,
        coveredCount: covered,
        coverageRate: percent(covered, total),
        overdueTaskCount: departmentOverdueTasks.get(departmentId)?.size || 0,
      }
    })
    .filter((row) => row.controlPointCount > 0 || row.coveredCount > 0 || row.overdueTaskCount > 0)
    .sort((a, b) => b.coverageRate - a.coverageRate || a.overdueTaskCount - b.overdueTaskCount || a.departmentId.localeCompare(b.departmentId, 'zh-CN'))

  const executorMap = new Map<string, { totalTasks: number; completedTasks: number }>()
  for (const row of assigneeRows) {
    const current = executorMap.get(row.assigneeId) || { totalTasks: 0, completedTasks: 0 }
    current.totalTasks += 1
    if (row.status === 'COMPLETED' || row.task.status === 'COMPLETED') current.completedTasks += 1
    executorMap.set(row.assigneeId, current)
  }
  const executorRows = Array.from(executorMap.entries()).map(([userId, item]) => ({
    userId,
    name: userLabel.get(userId) || userId,
    totalTasks: item.totalTasks,
    completedTasks: item.completedTasks,
    completionRate: percent(item.completedTasks, item.totalTasks),
  }))
  const topExecutors = executorRows
    .slice()
    .sort((a, b) => b.completionRate - a.completionRate || b.completedTasks - a.completedTasks || b.totalTasks - a.totalTasks)
    .slice(0, 10)
  const bottomExecutors = executorRows
    .slice()
    .sort((a, b) => a.completionRate - b.completionRate || b.totalTasks - a.totalTasks || a.name.localeCompare(b.name, 'zh-CN'))
    .slice(0, 10)

  const reviewerMap = new Map<string, { reviewedCount: number; approvedCount: number; totalHours: number }>()
  for (const submission of reviewedSubmissions) {
    if (!submission.reviewerId || !submission.reviewedAt) continue
    const current = reviewerMap.get(submission.reviewerId) || { reviewedCount: 0, approvedCount: 0, totalHours: 0 }
    current.reviewedCount += 1
    if (submission.status === 'APPROVED') current.approvedCount += 1
    current.totalHours += Math.max(0, submission.reviewedAt.getTime() - submission.submittedAt.getTime()) / 3600_000
    reviewerMap.set(submission.reviewerId, current)
  }
  const reviewEfficiency = Array.from(reviewerMap.entries())
    .map(([userId, item]) => ({
      userId,
      name: userLabel.get(userId) || userId,
      reviewedCount: item.reviewedCount,
      approvedCount: item.approvedCount,
      passRate: percent(item.approvedCount, item.reviewedCount),
      avgReviewHours: Math.round((item.totalHours / Math.max(1, item.reviewedCount)) * 10) / 10,
    }))
    .sort((a, b) => a.avgReviewHours - b.avgReviewHours || b.reviewedCount - a.reviewedCount)
    .slice(0, 10)

  return {
    generatedAt: now.toISOString(),
    rangeDays,
    range: {
      startDate: toDateOnly(rangeStart),
      endDate: toDateOnly(rangeEnd),
    },
    overview: {
      totalRequirements: activeRequirements.length,
      coveredRequirements: coveredRequirementIds.size,
      uncoveredRequirements: Math.max(0, activeRequirements.length - coveredRequirementIds.size),
      coverageRate: percent(coveredRequirementIds.size, activeRequirements.length),
      tasksTotal: inScopeTasks.length,
      tasksCompleted: completedTasks.length,
      taskCompletionRate: percent(completedTasks.length, inScopeTasks.length),
      reviewsTotal: reviewedSubmissions.length,
      reviewsApproved: approvedReviews.length,
      reviewPassRate: percent(approvedReviews.length, reviewedSubmissions.length),
      overdueTasks: currentOverdueTasks,
    },
    trends: {
      taskCompletion: stripBucketInternals(taskBuckets),
      reviewPass: stripBucketInternals(reviewBuckets),
      overdue: stripBucketInternals(overdueBuckets),
    },
    department: {
      visible: departmentRows.length > 0,
      rows: departmentRows,
    },
    people: {
      visible: canViewPeople,
      topExecutors: canViewPeople ? topExecutors : [],
      bottomExecutors: canViewPeople ? bottomExecutors : [],
      reviewEfficiency: canViewPeople ? reviewEfficiency : [],
    },
  }
}

function appendSheet(workbook: xlsx.WorkBook, name: string, rows: Array<Record<string, unknown>>) {
  const sheet = xlsx.utils.json_to_sheet(rows.length ? rows : [{ 提示: '暂无数据' }])
  xlsx.utils.book_append_sheet(workbook, sheet, name.slice(0, 31))
}

function buildIntelligenceDashboardWorkbook(data: IntelligenceDashboardData) {
  const workbook = xlsx.utils.book_new()
  appendSheet(workbook, '总览', [
    { 指标: '控制点总数', 数值: data.overview.totalRequirements },
    { 指标: '已覆盖控制点', 数值: data.overview.coveredRequirements },
    { 指标: '未覆盖控制点', 数值: data.overview.uncoveredRequirements },
    { 指标: '覆盖率', 数值: `${data.overview.coverageRate}%` },
    { 指标: '任务总数', 数值: data.overview.tasksTotal },
    { 指标: '已完成任务', 数值: data.overview.tasksCompleted },
    { 指标: '任务完成率', 数值: `${data.overview.taskCompletionRate}%` },
    { 指标: '审核通过率', 数值: `${data.overview.reviewPassRate}%` },
    { 指标: '逾期任务数', 数值: data.overview.overdueTasks },
  ])
  appendSheet(workbook, '任务完成率趋势', data.trends.taskCompletion.map((row) => ({
    周期: row.label,
    开始日期: row.startDate,
    结束日期: row.endDate,
    任务总数: row.total,
    已完成: row.completed ?? 0,
    完成率: `${row.rate ?? 0}%`,
  })))
  appendSheet(workbook, '审核通过率趋势', data.trends.reviewPass.map((row) => ({
    周期: row.label,
    开始日期: row.startDate,
    结束日期: row.endDate,
    审核总数: row.total,
    已通过: row.approved ?? 0,
    通过率: `${row.rate ?? 0}%`,
  })))
  appendSheet(workbook, '逾期趋势', data.trends.overdue.map((row) => ({
    周期: row.label,
    开始日期: row.startDate,
    结束日期: row.endDate,
    逾期任务数: row.overdue ?? row.total,
  })))
  appendSheet(workbook, '部门排行', data.department.rows.map((row) => ({
    部门: row.departmentId,
    控制点数: row.controlPointCount,
    已覆盖: row.coveredCount,
    覆盖率: `${row.coverageRate}%`,
    逾期任务数: row.overdueTaskCount,
  })))
  if (data.people.visible) {
    appendSheet(workbook, '执行完成率TOP10', data.people.topExecutors.map((row) => ({
      人员: row.name,
      任务数: row.totalTasks,
      已完成: row.completedTasks,
      完成率: `${row.completionRate}%`,
    })))
    appendSheet(workbook, '执行完成率后10', data.people.bottomExecutors.map((row) => ({
      人员: row.name,
      任务数: row.totalTasks,
      已完成: row.completedTasks,
      完成率: `${row.completionRate}%`,
    })))
    appendSheet(workbook, '审核效率', data.people.reviewEfficiency.map((row) => ({
      审核人: row.name,
      审核数: row.reviewedCount,
      通过数: row.approvedCount,
      通过率: `${row.passRate}%`,
      平均审核小时: row.avgReviewHours,
    })))
  }
  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

async function resolveEnterpriseIdForEnterpriseRoute(req: AuthRequest, res: Response): Promise<string | null> {
  if (req.userRole === 'admin') {
    if (req.userEnterpriseId) return req.userEnterpriseId
    const user = await prisma.appUser.findUnique({
      where: { id: req.userId! },
      select: { enterpriseId: true },
    })
    return user?.enterpriseId ?? DEFAULT_ENTERPRISE_ID
  }
  const user = await prisma.appUser.findUnique({
    where: { id: req.userId! },
    select: { enterpriseId: true, enterpriseRole: true },
  })
  if (!user?.enterpriseId || !user?.enterpriseRole) {
    res.status(403).json({ error: '当前账号未绑定企业，无权访问' })
    return null
  }
  return user.enterpriseId
}

async function resolveEnterpriseDashboardContext(req: AuthRequest, res: Response): Promise<{ enterpriseId: string; canViewPeople: boolean } | null> {
  if (req.userRole === 'admin') {
    if (req.userEnterpriseId) return { enterpriseId: req.userEnterpriseId, canViewPeople: true }
    const user = await prisma.appUser.findUnique({
      where: { id: req.userId! },
      select: { enterpriseId: true },
    })
    return { enterpriseId: user?.enterpriseId ?? DEFAULT_ENTERPRISE_ID, canViewPeople: true }
  }
  const user = await prisma.appUser.findUnique({
    where: { id: req.userId! },
    select: { enterpriseId: true, enterpriseRole: true },
  })
  if (!user?.enterpriseId || !user?.enterpriseRole) {
    res.status(403).json({ error: '当前账号未绑定企业，无权访问' })
    return null
  }
  return {
    enterpriseId: user.enterpriseId,
    canViewPeople: user.enterpriseRole === 'ADMIN' || user.enterpriseRole === 'MANAGER',
  }
}

export function registerStandardExecutionDashboardRoutes(app: Express) {
  app.get(
    '/api/admin/standard-execution/dashboard',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const enterpriseId = getEnterpriseId(req as never)
      const data = await buildDashboardData(enterpriseId)
      res.json({ data })
    },
  )

  app.get(
    '/api/admin/standard-execution/intelligence-dashboard',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = IntelligenceDashboardQuerySchema.safeParse(req.query)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = getEnterpriseId(req as never)
      const data = await buildIntelligenceDashboardData(enterpriseId, parsed.data.range, true)
      res.json({ data })
    },
  )

  app.get(
    '/api/admin/standard-execution/intelligence-dashboard/export',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = IntelligenceDashboardQuerySchema.safeParse(req.query)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = getEnterpriseId(req as never)
      const data = await buildIntelligenceDashboardData(enterpriseId, parsed.data.range, true)
      const buffer = buildIntelligenceDashboardWorkbook(data)
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename=se_intelligence_dashboard_${toDateOnly(new Date())}.xlsx`)
      res.send(buffer)
    },
  )

  app.get(
    '/api/enterprise/standard-execution/dashboard',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const enterpriseId = await resolveEnterpriseIdForEnterpriseRoute(req, res)
      if (!enterpriseId) return
      const data = await buildDashboardData(enterpriseId)
      res.json({ data })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/intelligence-dashboard',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const parsed = IntelligenceDashboardQuerySchema.safeParse(req.query)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const context = await resolveEnterpriseDashboardContext(req, res)
      if (!context) return
      const data = await buildIntelligenceDashboardData(context.enterpriseId, parsed.data.range, context.canViewPeople)
      res.json({ data })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/intelligence-dashboard/export',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const parsed = IntelligenceDashboardQuerySchema.safeParse(req.query)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const context = await resolveEnterpriseDashboardContext(req, res)
      if (!context) return
      const data = await buildIntelligenceDashboardData(context.enterpriseId, parsed.data.range, context.canViewPeople)
      const buffer = buildIntelligenceDashboardWorkbook(data)
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename=se_intelligence_dashboard_${toDateOnly(new Date())}.xlsx`)
      res.send(buffer)
    },
  )
}
