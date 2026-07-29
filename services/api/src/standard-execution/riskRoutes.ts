/**
 * 风险看板 — Admin only（一期实时计算，不落库）
 *
 *   GET  /api/admin/standard-execution/risks           — 全量 4 类风险，按 level 排序
 *   POST /api/admin/standard-execution/risks/:id/handle — 占位（一期不写库；二期补 Risk 表 + 忽略列表）
 *
 * 4 类风险规则（doc §十二，阈值硬编码）：
 *   REQUIREMENT_NO_TASK     ACTIVE 要求项 ≥ 3 天未关联任务（HIGH）
 *   TASK_OVERDUE            task.deadlineAt < now 且 status='PUBLISHED'（HIGH）
 *   ASSIGNEE_NOT_SUBMITTED  task.deadlineAt < now+24h 且 assignee.status ∈ {PENDING,IN_PROGRESS,REJECTED}（MEDIUM）
 *   REVIEW_PENDING          submission.submittedAt < now-48h 且 status='SUBMITTED'（MEDIUM）
 *
 * id 合成键：`${riskType}:${relatedId}` —— 前端可用作 key；handle 端点直接接收此 id 解析
 */
import type { Express } from 'express'
import { prisma } from '../db.js'
import { requireAdmin, type AuthRequest } from '../auth.js'
import { getEnterpriseId } from './utils.js'
import type { RiskType, RiskLevel } from './enums.js'

interface RiskItem {
  id: string
  riskType: RiskType
  riskLevel: RiskLevel
  title: string
  description: string
  relatedType: 'Requirement' | 'Task' | 'TaskAssignee' | 'Submission'
  relatedId: string
  createdAt: Date
}

const THREE_DAYS_MS = 3 * 24 * 3600 * 1000
const TWENTY_FOUR_HOURS_MS = 24 * 3600 * 1000
const FORTY_EIGHT_HOURS_MS = 48 * 3600 * 1000

const LEVEL_ORDER: Record<RiskLevel, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }

async function computeRisks(enterpriseId: string): Promise<RiskItem[]> {
  const now = new Date()
  const threeDaysAgo = new Date(now.getTime() - THREE_DAYS_MS)
  const next24h = new Date(now.getTime() + TWENTY_FOUR_HOURS_MS)
  const fortyEightHoursAgo = new Date(now.getTime() - FORTY_EIGHT_HOURS_MS)

  const [reqNoTask, overdueTasks, urgentAssignees, pendingReviews] = await Promise.all([
    // 1. REQUIREMENT_NO_TASK：ACTIVE ≥ 3 天 + 无 task
    prisma.standardExecutionRequirement.findMany({
      where: {
        enterpriseId,
        status: 'ACTIVE',
        createdAt: { lt: threeDaysAgo },
        tasks: { none: {} },
      },
      select: { id: true, title: true, createdAt: true },
    }),
    // 2. TASK_OVERDUE
    prisma.standardExecutionTask.findMany({
      where: {
        enterpriseId,
        OR: [
          { status: 'OVERDUE' },
          { status: 'PUBLISHED', deadlineAt: { lt: now } },
        ],
      },
      select: { id: true, title: true, deadlineAt: true },
    }),
    // 3. ASSIGNEE_NOT_SUBMITTED：紧迫 (24h 内截止) 但未提交
    prisma.standardExecutionTaskAssignee.findMany({
      where: {
        enterpriseId,
        status: { in: ['PENDING', 'IN_PROGRESS', 'REJECTED'] },
        task: { deadlineAt: { lt: next24h }, status: 'PUBLISHED' },
      },
      include: { task: { select: { id: true, title: true, deadlineAt: true } } },
    }),
    // 4. REVIEW_PENDING：超 48h 未审
    prisma.standardExecutionSubmission.findMany({
      where: {
        enterpriseId,
        status: 'SUBMITTED',
        submittedAt: { lt: fortyEightHoursAgo },
      },
      include: { task: { select: { id: true, title: true } } },
    }),
  ])

  const items: RiskItem[] = []

  for (const r of reqNoTask) {
    items.push({
      id: `REQUIREMENT_NO_TASK:${r.id}`,
      riskType: 'REQUIREMENT_NO_TASK',
      riskLevel: 'HIGH',
      title: `要求项无任务：${r.title}`,
      description: `要求项已启用 ${Math.floor((now.getTime() - r.createdAt.getTime()) / (24 * 3600 * 1000))} 天仍未创建任务`,
      relatedType: 'Requirement',
      relatedId: r.id,
      createdAt: r.createdAt,
    })
  }

  for (const t of overdueTasks) {
    if (!t.deadlineAt) continue
    items.push({
      id: `TASK_OVERDUE:${t.id}`,
      riskType: 'TASK_OVERDUE',
      riskLevel: 'HIGH',
      title: `任务已逾期：${t.title}`,
      description: `截止时间 ${t.deadlineAt.toISOString()} 已过，任务未完成`,
      relatedType: 'Task',
      relatedId: t.id,
      createdAt: t.deadlineAt,
    })
  }

  for (const a of urgentAssignees) {
    if (!a.task.deadlineAt) continue
    items.push({
      id: `ASSIGNEE_NOT_SUBMITTED:${a.id}`,
      riskType: 'ASSIGNEE_NOT_SUBMITTED',
      riskLevel: 'MEDIUM',
      title: `执行人未提交：${a.task.title}`,
      description: `执行人 ${a.assigneeId} 当前状态 ${a.status}，截止 ${a.task.deadlineAt.toISOString()}`,
      relatedType: 'TaskAssignee',
      relatedId: a.id,
      createdAt: a.task.deadlineAt,
    })
  }

  for (const s of pendingReviews) {
    items.push({
      id: `REVIEW_PENDING:${s.id}`,
      riskType: 'REVIEW_PENDING',
      riskLevel: 'MEDIUM',
      title: `审核滞留：${s.task.title}`,
      description: `提交 ${s.submittedAt.toISOString()} 起超 48 小时未审`,
      relatedType: 'Submission',
      relatedId: s.id,
      createdAt: s.submittedAt,
    })
  }

  // 排序：level 优先（HIGH→MEDIUM→LOW），同 level 按 createdAt asc（最早出现的在前）
  items.sort((a, b) => {
    const lvl = LEVEL_ORDER[a.riskLevel] - LEVEL_ORDER[b.riskLevel]
    if (lvl !== 0) return lvl
    return a.createdAt.getTime() - b.createdAt.getTime()
  })

  return items
}

export function registerStandardExecutionRiskRoutes(app: Express) {
  app.get(
    '/api/admin/standard-execution/risks',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const enterpriseId = getEnterpriseId(req as never)
      const items = await computeRisks(enterpriseId)
      res.json({ data: items, total: items.length })
    },
  )

  app.post(
    '/api/admin/standard-execution/risks/:id/handle',
    requireAdmin as never,
    async (_req: AuthRequest, res) => {
      // 一期占位：不落库；二期补 Risk 表 + 忽略列表
      res.json({ data: null, noop: true, note: '一期占位，未持久化处理状态' })
    },
  )
}

export { computeRisks }
