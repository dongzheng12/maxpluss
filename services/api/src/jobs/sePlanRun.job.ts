/**
 * Standard Execution plan runner
 *
 * Periodic plans are deliberately generated as PENDING_APPROVAL tasks. Employees
 * still cannot see them until the task approval flow publishes the tasks.
 */
import cron from 'node-cron'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { logger } from '../logger.js'
import { buildBasisSnapshots, type RequirementForSnapshot } from '../standard-execution/basisSnapshots.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_DAYS_AFTER_APPROVAL = 7

type Frequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly'

type RunnablePlan = Awaited<ReturnType<typeof findDuePlans>>[number]

export interface PlanRunResult {
  planId: string
  runDate: Date
  status: 'CREATED' | 'SKIPPED' | 'FAILED'
  createdTasks: number
  createdItems: number
  nextRunAt: Date | null
  errorMessage?: string
}

export interface DuePlanRunSummary {
  checked: number
  createdRuns: number
  skippedRuns: number
  failedRuns: number
  createdTasks: number
  results: PlanRunResult[]
}

function addMonthsClamped(date: Date, months: number) {
  const result = new Date(date)
  const originalDate = result.getDate()
  result.setDate(1)
  result.setMonth(result.getMonth() + months)
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()
  result.setDate(Math.min(originalDate, lastDay))
  return result
}

export function computeNextPlanRunAt(current: Date, frequency: string | null, endAt: Date | null) {
  let next: Date | null = null
  switch (frequency) {
    case 'daily':
      next = new Date(current.getTime() + DAY_MS)
      break
    case 'weekly':
      next = new Date(current.getTime() + 7 * DAY_MS)
      break
    case 'monthly':
      next = addMonthsClamped(current, 1)
      break
    case 'quarterly':
      next = addMonthsClamped(current, 3)
      break
    case 'yearly':
      next = addMonthsClamped(current, 12)
      break
    default:
      return null
  }
  if (endAt && next.getTime() > endAt.getTime()) return null
  return next
}

function parseAssigneeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)))
}

function taskDeadlineForRun(plan: RunnablePlan, runDate: Date) {
  const mode = plan.defaultDeadlineMode || 'AFTER_APPROVAL_DAYS'
  const days = plan.defaultDeadlineDaysAfterApproval ?? DEFAULT_DAYS_AFTER_APPROVAL
  return {
    deadlineMode: mode,
    deadlineDaysAfterApproval: mode === 'AFTER_APPROVAL_DAYS' ? days : null,
    deadlineAt: mode === 'FIXED' ? new Date(runDate.getTime() + days * DAY_MS) : null,
  }
}

async function findDuePlans(now: Date) {
  return prisma.standardExecutionPlan.findMany({
    where: {
      status: 'ACTIVE',
      frequency: { not: null },
      nextRunAt: { lte: now },
      OR: [{ endAt: null }, { endAt: { gte: now } }],
    },
    orderBy: { nextRunAt: 'asc' },
    take: 50,
  })
}

function isUniqueRunConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

async function runSinglePlan(plan: RunnablePlan, now: Date): Promise<PlanRunResult> {
  const runDate = plan.nextRunAt ?? now
  const nextRunAt = computeNextPlanRunAt(runDate, plan.frequency, plan.endAt)
  const assigneeIds = parseAssigneeIds(plan.defaultAssigneeIds)

  try {
    return await prisma.$transaction(async (tx) => {
      const planRun = await tx.standardExecutionPlanRun.create({
        data: {
          enterpriseId: plan.enterpriseId,
          planId: plan.id,
          runDate,
          status: 'CREATED',
        },
      })

      const failOrSkip = async (status: 'SKIPPED' | 'FAILED', errorMessage: string): Promise<PlanRunResult> => {
        await tx.standardExecutionPlanRun.update({
          where: { id: planRun.id },
          data: { status, errorMessage },
        })
        await tx.standardExecutionPlan.update({
          where: { id: plan.id },
          data: { lastRunAt: now, nextRunAt, roundNumber: { increment: 1 } },
        })
        return { planId: plan.id, runDate, status, createdTasks: 0, createdItems: 0, nextRunAt, errorMessage }
      }

      if (!plan.defaultReviewerId || assigneeIds.length === 0) {
        return failOrSkip('SKIPPED', '计划缺少默认审核人或执行人，未生成本轮任务')
      }

      const requirements = await tx.standardExecutionRequirement.findMany({
        where: {
          enterpriseId: plan.enterpriseId,
          sourceId: plan.sourceId,
          status: 'ACTIVE',
        },
        select: {
          id: true,
          sourceId: true,
          clauseNo: true,
          title: true,
          requirementText: true,
          recommendedTaskType: true,
          executionDescription: true,
          submitRequirement: true,
          source: {
            select: {
              id: true,
              title: true,
              sourceNo: true,
              sourceType: true,
              version: true,
            },
          },
        },
      })

      if (requirements.length === 0) {
        return failOrSkip('SKIPPED', '计划对应标准来源暂无 ACTIVE 执行要求')
      }

      const groups = new Map<string, RequirementForSnapshot[]>()
      for (const requirement of requirements) {
        const taskType = plan.defaultTaskType || requirement.recommendedTaskType || 'OTHER'
        groups.set(taskType, [...(groups.get(taskType) ?? []), requirement])
      }

      const deadline = taskDeadlineForRun(plan, runDate)
      const createdTaskIds: string[] = []
      let createdItems = 0
      const dateLabel = runDate.toISOString().slice(0, 10)

      for (const [taskType, group] of groups) {
        const task = await tx.standardExecutionTask.create({
          data: {
            enterpriseId: plan.enterpriseId,
            planId: plan.id,
            requirementId: group.length === 1 ? group[0].id : null,
            title: `${plan.title} ${dateLabel} - ${taskType}`,
            description: group
              .map((requirement, index) => {
                const head = [requirement.clauseNo, requirement.title].filter(Boolean).join(' ')
                return `${index + 1}. ${head}\n${requirement.executionDescription || requirement.requirementText}`
              })
              .join('\n\n')
              .slice(0, 2000),
            taskType,
            submitRequirement:
              group.find((requirement) => requirement.submitRequirement?.trim())?.submitRequirement?.trim() ||
              '请上传完成证明材料（图片或文档）并填写说明',
            deadlineAt: deadline.deadlineAt,
            deadlineMode: deadline.deadlineMode,
            deadlineDaysAfterApproval: deadline.deadlineDaysAfterApproval,
            reviewerId: plan.defaultReviewerId,
            status: 'PENDING_APPROVAL',
            submittedForApprovalAt: now,
            basisSnapshots: buildBasisSnapshots(group, now) as unknown as Prisma.InputJsonValue,
            createdBy: plan.createdBy,
          },
        })
        createdTaskIds.push(task.id)

        await tx.standardExecutionTaskApprovalLog.create({
          data: {
            enterpriseId: plan.enterpriseId,
            taskId: task.id,
            action: 'SUBMIT_APPROVAL',
            fromStatus: 'DRAFT',
            toStatus: 'PENDING_APPROVAL',
            reviewerId: plan.createdBy,
            comment: '周期计划自动生成，待任务审核通过后下发',
          },
        })

        await tx.standardExecutionTaskItem.createMany({
          data: group.map((requirement) => ({
            taskId: task.id,
            requirementId: requirement.id,
            status: 'PENDING',
          })),
        })
        createdItems += group.length

        await tx.standardExecutionTaskAssignee.createMany({
          data: assigneeIds.map((assigneeId) => ({
            enterpriseId: plan.enterpriseId,
            taskId: task.id,
            assigneeId,
            status: 'PENDING',
          })),
        })
      }

      await tx.standardExecutionPlanRun.update({
        where: { id: planRun.id },
        data: { createdTaskIds: createdTaskIds as unknown as Prisma.InputJsonValue },
      })
      await tx.standardExecutionPlan.update({
        where: { id: plan.id },
        data: { lastRunAt: now, nextRunAt, roundNumber: { increment: 1 } },
      })

      return {
        planId: plan.id,
        runDate,
        status: 'CREATED',
        createdTasks: createdTaskIds.length,
        createdItems,
        nextRunAt,
      }
    })
  } catch (error) {
    if (!isUniqueRunConflict(error)) throw error
    await prisma.standardExecutionPlan.update({
      where: { id: plan.id },
      data: { lastRunAt: now, nextRunAt, roundNumber: { increment: 1 } },
    })
    return {
      planId: plan.id,
      runDate,
      status: 'SKIPPED',
      createdTasks: 0,
      createdItems: 0,
      nextRunAt,
      errorMessage: '本轮计划已生成过，跳过重复派发',
    }
  }
}

export async function runDueStandardExecutionPlans(now: Date = new Date()): Promise<DuePlanRunSummary> {
  const plans = await findDuePlans(now)
  const results: PlanRunResult[] = []

  for (const plan of plans) {
    try {
      results.push(await runSinglePlan(plan, now))
    } catch (error) {
      logger.error({ module: 'se-plan-run', planId: plan.id, err: error }, 'failed to run standard execution plan')
      results.push({
        planId: plan.id,
        runDate: plan.nextRunAt ?? now,
        status: 'FAILED',
        createdTasks: 0,
        createdItems: 0,
        nextRunAt: plan.nextRunAt ?? null,
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    checked: plans.length,
    createdRuns: results.filter((item) => item.status === 'CREATED').length,
    skippedRuns: results.filter((item) => item.status === 'SKIPPED').length,
    failedRuns: results.filter((item) => item.status === 'FAILED').length,
    createdTasks: results.reduce((sum, item) => sum + item.createdTasks, 0),
    results,
  }
}

export function scheduleStandardExecutionPlanRuns() {
  const enabled = process.env.SE_PLAN_RUNNER_ENABLED !== 'false'
  if (!enabled) {
    logger.info({ module: 'se-plan-run' }, 'standard execution plan runner disabled')
    return
  }

  const run = () => {
    void runDueStandardExecutionPlans()
      .then((summary) => {
        if (summary.checked > 0) {
          logger.info({ module: 'se-plan-run', ...summary }, 'standard execution plan runner completed')
        }
      })
      .catch((error) => {
        logger.error({ module: 'se-plan-run', err: error }, 'standard execution plan runner failed')
      })
  }

  run()
  cron.schedule('*/15 * * * *', run)
}
