/**
 * standard-execution 模块共享工具
 *
 * @date  2026-05-21
 * @see   必读/02_技术架构.md §三 企业版多租户设计（一期单租户 enterpriseId='DEFAULT'）
 */
import type { Request } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'

const DEFAULT_ENTERPRISE_ID = 'DEFAULT'
const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000
const YEAR_DAYS_MS = 365 * 24 * 3600 * 1000

export type RequirementHealthStatus = 'COVERED' | 'EXPIRING' | 'UNCOVERED' | 'NO_TASK' | 'NA'

export type RequirementHealth = {
  status: RequirementHealthStatus
  taskCount: number
  validRecordCount: number
  latestValidRecordDate: Date | null
  validUntil: Date | null
  daysUntilExpiry: number | null
  description: string
}

/**
 * zod 解析产物 → Prisma Json 字段写入值。
 * null/undefined 统一落 DbNull（列式 NULL，与现有 SE JSON 字段语义一致；禁改 JsonNull）。
 */
export function toPrismaJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value == null ? Prisma.DbNull : (value as Prisma.InputJsonValue)
}

/**
 * 获取当前请求的企业 ID（多租户隔离 key）。
 *
 * - admin（平台后台管理）：取本人绑定企业；未绑定兜底 DEFAULT（管理默认企业数据）。
 * - 企业成员：取 JWT 注入的 req.userEnterpriseId（由 requireAuth/optionalAuth 写入）。
 * - 非 admin 且无 enterpriseId：throw 403（依赖 express-async-errors 让全局 handler 接住）。
 *
 * 禁止在业务接口里直接写 "DEFAULT"，所有 standard-execution 接口的
 * where / data / select 都必须经此函数取值。
 */
export function getEnterpriseId(req: Request): string {
  const r = req as { userRole?: string; userEnterpriseId?: string | null }
  if (r.userRole === 'admin') return r.userEnterpriseId ?? DEFAULT_ENTERPRISE_ID
  const eid = r.userEnterpriseId
  if (!eid) {
    throw Object.assign(new Error('非企业成员，无权访问企业数据'), { status: 403 })
  }
  return eid
}

/**
 * 给检查点列表附加关联任务统计（P1-7）：taskCount + 最近一次任务状态。
 * 一次性批量查（按 createdAt desc）避免 N+1；latestTaskStatus 取该检查点下最新创建任务的状态。
 * TODO: 单检查点任务量级上千后，改为 groupBy(requirementId) 统计 count + 单独查 latest，避免一次性拉全量 task。
 */
export async function attachRequirementTaskStats<T extends { id: string }>(
  enterpriseId: string,
  requirements: T[],
): Promise<(T & { taskCount: number; latestTaskStatus: string | null })[]> {
  const reqIds = requirements.map((r) => r.id)
  const tasks = reqIds.length
    ? await prisma.standardExecutionTask.findMany({
        where: { requirementId: { in: reqIds }, enterpriseId, deletedAt: null },
        select: { requirementId: true, status: true },
        orderBy: { createdAt: 'desc' },
      })
    : []
  const statsByReq = new Map<string, { count: number; latestStatus: string }>()
  for (const t of tasks) {
    if (!t.requirementId) continue
    const cur = statsByReq.get(t.requirementId)
    if (cur) cur.count++
    else statsByReq.set(t.requirementId, { count: 1, latestStatus: t.status }) // desc → 首条即最近
  }
  return requirements.map((r) => {
    const s = statsByReq.get(r.id)
    return { ...r, taskCount: s?.count ?? 0, latestTaskStatus: s?.latestStatus ?? null }
  })
}

function daysUntil(from: Date, to: Date) {
  return Math.ceil((to.getTime() - from.getTime()) / (24 * 3600 * 1000))
}

function healthDescription(status: RequirementHealthStatus, days: number | null) {
  if (status === 'NA') return '仅对已启用控制点计算合规健康状态。'
  if (status === 'NO_TASK') return '该控制点尚未关联执行任务，建议先生成任务草稿。'
  if (status === 'UNCOVERED') return '该控制点已有任务但暂无有效证据记录。'
  if (status === 'EXPIRING') {
    if (days === null) return '最近有效证据未设置有效期且记录已超过 365 天，建议复核更新。'
    if (days < 0) return `最近有效证据已过期 ${Math.abs(days)} 天，建议立即更新。`
    return `最近有效证据将在 ${days} 天内到期，建议提前更新。`
  }
  return '该控制点已有有效证据覆盖，当前状态良好。'
}

/**
 * 给控制点附加实时健康状态（B4）。批量查询任务数量和 VALID 记录，避免列表 N+1。
 *
 * 优先级：
 * - 非 ACTIVE：NA
 * - ACTIVE 且无任务：NO_TASK
 * - ACTIVE 且无 VALID 记录：UNCOVERED
 * - 最近 VALID 记录 30 天内到期/已过期，或无 validUntil 且记录超过 365 天：EXPIRING
 * - 其余：COVERED
 */
export async function attachRequirementHealth<T extends { id: string; status: string; taskCount?: number }>(
  enterpriseId: string,
  requirements: T[],
): Promise<(T & { health: RequirementHealth })[]> {
  const activeRequirements = requirements.filter((r) => r.status === 'ACTIVE')
  const activeReqIds = activeRequirements.map((r) => r.id)
  const hasTaskCounts = requirements.every((r) => typeof r.taskCount === 'number')

  const [taskCounts, validRecords] = await Promise.all([
    hasTaskCounts || activeReqIds.length === 0
      ? Promise.resolve(new Map<string, number>())
      : prisma.standardExecutionTask
          .groupBy({
            by: ['requirementId'],
            where: {
              enterpriseId,
              deletedAt: null,
              requirementId: { in: activeReqIds },
            },
            _count: { _all: true },
          })
          .then((rows) => {
            const counts = new Map<string, number>()
            for (const row of rows) {
              if (row.requirementId) counts.set(row.requirementId, row._count._all)
            }
            return counts
          }),
    activeReqIds.length === 0
      ? Promise.resolve([])
      : prisma.standardExecutionRecord.findMany({
          where: {
            enterpriseId,
            requirementId: { in: activeReqIds },
            status: 'VALID',
          },
          select: {
            requirementId: true,
            recordDate: true,
            validUntil: true,
          },
          orderBy: [
            { requirementId: 'asc' },
            { recordDate: 'desc' },
            { createdAt: 'desc' },
          ],
        }),
  ])

  const validRecordStats = new Map<string, {
    count: number
    latestRecordDate: Date
    latestValidUntil: Date | null
  }>()
  for (const record of validRecords) {
    const current = validRecordStats.get(record.requirementId)
    if (current) {
      current.count += 1
      continue
    }
    validRecordStats.set(record.requirementId, {
      count: 1,
      latestRecordDate: record.recordDate,
      latestValidUntil: record.validUntil,
    })
  }

  const now = new Date()
  const expiresSoonAt = new Date(now.getTime() + THIRTY_DAYS_MS)
  const staleRecordBefore = new Date(now.getTime() - YEAR_DAYS_MS)

  return requirements.map((requirement) => {
    const taskCount = typeof requirement.taskCount === 'number'
      ? requirement.taskCount
      : taskCounts.get(requirement.id) ?? 0
    const recordStat = validRecordStats.get(requirement.id)
    const latestValidUntil = recordStat?.latestValidUntil ?? null
    const latestRecordDate = recordStat?.latestRecordDate ?? null
    const days = latestValidUntil ? daysUntil(now, latestValidUntil) : null
    let status: RequirementHealthStatus = 'NA'

    if (requirement.status === 'ACTIVE') {
      if (taskCount === 0) {
        status = 'NO_TASK'
      } else if (!recordStat) {
        status = 'UNCOVERED'
      } else if (
        (latestValidUntil && latestValidUntil.getTime() <= expiresSoonAt.getTime()) ||
        (!latestValidUntil && latestRecordDate !== null && latestRecordDate.getTime() < staleRecordBefore.getTime())
      ) {
        status = 'EXPIRING'
      } else {
        status = 'COVERED'
      }
    }

    return {
      ...requirement,
      health: {
        status,
        taskCount,
        validRecordCount: recordStat?.count ?? 0,
        latestValidRecordDate: latestRecordDate,
        validUntil: latestValidUntil,
        daysUntilExpiry: days,
        description: healthDescription(status, days),
      },
    }
  })
}
