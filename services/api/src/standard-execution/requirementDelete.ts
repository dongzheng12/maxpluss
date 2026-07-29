import type { Prisma } from '@prisma/client'

export type RequirementDeleteDetail =
  | {
      id: string
      action: 'deleted'
      reason: 'NO_ASSOCIATION'
    }
  | {
      id: string
      action: 'archived'
      reason: 'HAS_HISTORY'
      associations: {
        tasks: number
        taskItems: number
        records: number
        packageItems: number
      }
    }
  | {
      id: string
      action: 'skipped'
      reason: 'NOT_FOUND'
    }

export interface RequirementDeleteResult {
  requested: number
  deleted: number
  archived: number
  skipped: number
  details: RequirementDeleteDetail[]
}

function increment(map: Map<string, number>, id: string | null, count: number) {
  if (!id) return
  map.set(id, (map.get(id) ?? 0) + count)
}

async function countRequirementAssociations(
  tx: Prisma.TransactionClient,
  enterpriseId: string,
  ids: string[],
) {
  const [tasks, taskItems, records, packageItems] = await Promise.all([
    tx.standardExecutionTask.groupBy({
      by: ['requirementId'],
      where: { enterpriseId, requirementId: { in: ids } },
      _count: { _all: true },
    }),
    tx.standardExecutionTaskItem.groupBy({
      by: ['requirementId'],
      where: { requirementId: { in: ids } },
      _count: { _all: true },
    }),
    tx.standardExecutionRecord.groupBy({
      by: ['requirementId'],
      where: { enterpriseId, requirementId: { in: ids } },
      _count: { _all: true },
    }),
    tx.standardExecutionPackageItem.groupBy({
      by: ['requirementId'],
      where: { enterpriseId, requirementId: { in: ids } },
      _count: { _all: true },
    }),
  ])

  const taskCounts = new Map<string, number>()
  const taskItemCounts = new Map<string, number>()
  const recordCounts = new Map<string, number>()
  const packageItemCounts = new Map<string, number>()

  for (const row of tasks) increment(taskCounts, row.requirementId, row._count._all)
  for (const row of taskItems) increment(taskItemCounts, row.requirementId, row._count._all)
  for (const row of records) increment(recordCounts, row.requirementId, row._count._all)
  for (const row of packageItems) increment(packageItemCounts, row.requirementId, row._count._all)

  return { taskCounts, taskItemCounts, recordCounts, packageItemCounts }
}

export async function deleteRequirementsByPolicy(
  tx: Prisma.TransactionClient,
  params: {
    enterpriseId: string
    ids: string[]
    updatedBy: string
  },
): Promise<RequirementDeleteResult> {
  const requested = params.ids.length
  const requirements = await tx.standardExecutionRequirement.findMany({
    where: { id: { in: params.ids }, enterpriseId: params.enterpriseId },
    select: { id: true },
  })
  const existingIds = requirements.map((item) => item.id)
  const existingSet = new Set(existingIds)

  const details: RequirementDeleteDetail[] = []
  const missingIds = params.ids.filter((id) => !existingSet.has(id))
  for (const id of missingIds) {
    details.push({ id, action: 'skipped', reason: 'NOT_FOUND' })
  }

  if (existingIds.length === 0) {
    return { requested, deleted: 0, archived: 0, skipped: missingIds.length, details }
  }

  const { taskCounts, taskItemCounts, recordCounts, packageItemCounts } =
    await countRequirementAssociations(tx, params.enterpriseId, existingIds)

  const deleteIds: string[] = []
  const archiveIds: string[] = []
  for (const id of existingIds) {
    const associations = {
      tasks: taskCounts.get(id) ?? 0,
      taskItems: taskItemCounts.get(id) ?? 0,
      records: recordCounts.get(id) ?? 0,
      packageItems: packageItemCounts.get(id) ?? 0,
    }
    const hasHistory = Object.values(associations).some((count) => count > 0)
    if (hasHistory) {
      archiveIds.push(id)
      details.push({ id, action: 'archived', reason: 'HAS_HISTORY', associations })
    } else {
      deleteIds.push(id)
      details.push({ id, action: 'deleted', reason: 'NO_ASSOCIATION' })
    }
  }

  let deleted = 0
  let archived = 0
  if (deleteIds.length > 0) {
    const result = await tx.standardExecutionRequirement.deleteMany({
      where: { id: { in: deleteIds }, enterpriseId: params.enterpriseId },
    })
    deleted = result.count
  }
  if (archiveIds.length > 0) {
    const result = await tx.standardExecutionRequirement.updateMany({
      where: { id: { in: archiveIds }, enterpriseId: params.enterpriseId },
      data: { status: 'ARCHIVED', updatedBy: params.updatedBy },
    })
    archived = result.count
  }

  return {
    requested,
    deleted,
    archived,
    skipped: requested - deleted - archived,
    details,
  }
}
