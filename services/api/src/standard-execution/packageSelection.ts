import { prisma } from '../db.js'
import type { PackageCreateInput } from './types.js'

const PACKAGE_RECORD_SELECT = {
  id: true,
  status: true,
  requirementId: true,
  taskId: true,
  submissionId: true,
} as const

type PackageRecord = {
  id: string
  status: string
  requirementId: string
  taskId: string
  submissionId: string
}

function appendUnique(target: PackageRecord[], seen: Set<string>, rows: PackageRecord[]) {
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    target.push(row)
  }
}

export async function resolveValidPackageRecords(enterpriseId: string, input: PackageCreateInput) {
  const selected: PackageRecord[] = []
  const seen = new Set<string>()

  if (input.recordIds?.length) {
    const records = await prisma.standardExecutionRecord.findMany({
      where: { id: { in: input.recordIds }, enterpriseId },
      select: PACKAGE_RECORD_SELECT,
    })
    const foundMap = new Map(records.map((r) => [r.id, r]))
    const missing = input.recordIds.filter((id) => !foundMap.has(id))
    if (missing.length > 0) {
      throw new Error(`recordIds 含不存在的记录：${missing.join(', ')}`)
    }
    const invalid = records.filter((r) => r.status !== 'VALID')
    if (invalid.length > 0) {
      throw new Error(`仅可包含 VALID 记录，以下记录状态非法：${invalid.map((r) => r.id).join(', ')}`)
    }
    appendUnique(selected, seen, input.recordIds.map((id) => foundMap.get(id)!))
  }

  if (input.requirementIds?.length) {
    const records = await prisma.standardExecutionRecord.findMany({
      where: { enterpriseId, requirementId: { in: input.requirementIds }, status: 'VALID' },
      select: PACKAGE_RECORD_SELECT,
      orderBy: [{ recordDate: 'asc' }, { createdAt: 'asc' }],
    })
    appendUnique(selected, seen, records)
  }

  if (input.taskIds?.length) {
    const records = await prisma.standardExecutionRecord.findMany({
      where: { enterpriseId, taskId: { in: input.taskIds }, status: 'VALID' },
      select: PACKAGE_RECORD_SELECT,
      orderBy: [{ recordDate: 'asc' }, { createdAt: 'asc' }],
    })
    appendUnique(selected, seen, records)
  }

  if (input.sourceIds?.length || input.departmentIds?.length || input.dateFrom || input.dateTo) {
    const records = await prisma.standardExecutionRecord.findMany({
      where: {
        enterpriseId,
        status: 'VALID',
        ...(input.sourceIds?.length ? { sourceId: { in: input.sourceIds } } : {}),
        ...(input.departmentIds?.length ? { departmentId: { in: input.departmentIds } } : {}),
        ...(input.dateFrom || input.dateTo
          ? {
              recordDate: {
                ...(input.dateFrom ? { gte: input.dateFrom } : {}),
                ...(input.dateTo ? { lte: input.dateTo } : {}),
              },
            }
          : {}),
      },
      select: PACKAGE_RECORD_SELECT,
      orderBy: [{ recordDate: 'asc' }, { createdAt: 'asc' }],
    })
    appendUnique(selected, seen, records)
  }

  if (input.planId) {
    const tasks = await prisma.standardExecutionTask.findMany({
      where: { enterpriseId, planId: input.planId, deletedAt: null },
      select: { id: true },
    })
    const planTaskIds = tasks.map((t) => t.id)
    if (planTaskIds.length > 0) {
      const records = await prisma.standardExecutionRecord.findMany({
        where: { enterpriseId, taskId: { in: planTaskIds }, status: 'VALID' },
        select: PACKAGE_RECORD_SELECT,
        orderBy: [{ recordDate: 'asc' }, { createdAt: 'asc' }],
      })
      appendUnique(selected, seen, records)
    }
  }

  if (selected.length === 0) {
    throw new Error('未解析到任何 VALID 执行记录')
  }

  return {
    records: selected,
    recordIds: selected.map((r) => r.id),
    foundMap: new Map(selected.map((r) => [r.id, r])),
  }
}
