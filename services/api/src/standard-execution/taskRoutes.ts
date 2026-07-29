/**
 * 任务（Task）+ 任务执行人（Assignee）后端接口 — Admin only
 *
 *   GET    /api/admin/standard-execution/tasks                — 列表
 *   GET    /api/admin/standard-execution/tasks/:id            — 详情（含 requirement/source/assignees）
 *   POST   /api/admin/standard-execution/tasks                — 创建 DRAFT + Assignees
 *   POST   /api/admin/standard-execution/requirements/:id/create-task — 便捷创建（requirementId 来自路径）
 *   PATCH  /api/admin/standard-execution/tasks/:id            — 编辑（仅 DRAFT）
 *   POST   /api/admin/standard-execution/tasks/:id/publish    — DRAFT → PUBLISHED
 *   POST   /api/admin/standard-execution/tasks/:id/cancel     — DRAFT|PUBLISHED → CANCELLED
 *   GET    /api/admin/standard-execution/tasks/:id/progress   — Assignee 状态聚合
 *
 * 状态机详见 必读/02_技术架构.md §七.2 TaskStatus：
 *   DRAFT → PUBLISHED
 *   PUBLISHED → COMPLETED (S8 审核全通过时自动)
 *   PUBLISHED → OVERDUE (后台扫描；S9/S10)
 *   DRAFT | PUBLISHED → CANCELLED
 *
 * 创建任务规则：
 *   - 只有 ACTIVE Requirement 可创建任务
 *   - assigneeIds 非空 + 去重
 *   - reviewerId / assigneeIds 必须是已存在的 AppUser
 *
 * @see 必读/02_技术架构.md §四.4 Task 模型 + §七.2 TaskStatus + §六 六类任务类型结构化字段
 */
import type { Express, Response } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { requireAdmin, type AuthRequest } from '../auth.js'
import { getEnterpriseId, toPrismaJson } from './utils.js'
import {
  TaskCreateSchema,
  TaskCreateViaRequirementSchema,
  TaskUpdateSchema,
  TaskListQuerySchema,
  TaskListV2QuerySchema,
  TaskApprovalCommentSchema,
  BatchCreateTasksFromRequirementsSchema,
  BatchIdsSchema,
  BatchAssignSchema,
  type TaskCreateInput,
  type BatchCreateTasksFromRequirementsInput,
  TASK_TYPES,
} from './types.js'
import { ASSIGNEE_STATUS, type AssigneeStatus } from './enums.js'
import { buildBasisSnapshots, type RequirementForSnapshot } from './basisSnapshots.js'
import {
  approveTaskApproval,
  rejectTaskApproval,
  submitTaskApproval,
  TaskApprovalError,
} from './taskApproval.js'
import { buildManagementTaskListV2 } from './taskListV2.js'
import { withSubmitFormConfig } from './submitFormConfig.js'

function badRequest(res: Response, msg: string) {
  return res.status(400).json({ error: msg })
}

function handleApprovalError(res: Response, err: unknown) {
  if (err instanceof TaskApprovalError) {
    return res.status(err.status).json({ error: err.message })
  }
  throw err
}

interface ValidatedInput {
  reviewerOk: boolean
  missingAssignees: string[]
}

/** 校验 reviewerId / assigneeIds 都在 AppUser 表里存在 */
async function validateUsers(reviewerId: string, assigneeIds: string[]): Promise<ValidatedInput> {
  const allIds = Array.from(new Set([reviewerId, ...assigneeIds]))
  const found = await prisma.appUser.findMany({
    where: { id: { in: allIds } },
    select: { id: true },
  })
  const foundSet = new Set(found.map((u) => u.id))
  return {
    reviewerOk: foundSet.has(reviewerId),
    missingAssignees: assigneeIds.filter((id) => !foundSet.has(id)),
  }
}

/** 把 Task 行 + assignees 拼装成响应 + isOverdue 计算字段 */
function withOverdue<T extends { status: string; deadlineAt: Date | null }>(task: T): T & { isOverdue: boolean } {
  const isOverdue = task.status === 'PUBLISHED' && !!task.deadlineAt && task.deadlineAt.getTime() < Date.now()
  return { ...task, isOverdue }
}

// ─── 内部 helper：实际 create 逻辑（被两个端点复用）───────
async function doCreateTask(
  req: AuthRequest,
  res: Response,
  parsed: TaskCreateInput,
) {
  const enterpriseId = getEnterpriseId(req as never)

  let requirement: (RequirementForSnapshot & { status: string }) | null = null
  if (parsed.requirementId) {
    // 任务可直接手动创建；如果带 requirementId，则锁定当时任务依据快照。
    requirement = await prisma.standardExecutionRequirement.findFirst({
      where: { id: parsed.requirementId, enterpriseId },
      select: {
        id: true,
        sourceId: true,
        clauseNo: true,
        title: true,
        requirementText: true,
        status: true,
        recommendedTaskType: true,
        executionDescription: true,
        submitRequirement: true,
        source: { select: { id: true, title: true, sourceNo: true, sourceType: true, version: true, isLatestVersion: true } },
      },
    })
    if (!requirement) return badRequest(res, 'requirementId 对应的执行要求不存在')
    if (requirement.status !== 'ACTIVE') {
      return badRequest(res, `仅 ACTIVE 执行要求可创建任务（当前 ${requirement.status}）`)
    }
    if (requirement.source?.isLatestVersion === false) {
      return badRequest(res, '旧版本标准不可创建任务，请先复核并切换到最新版本')
    }
  }

  // 2. reviewer / assignees 用户存在性
  if (parsed.reviewerId || parsed.assigneeIds.length > 0) {
    if (!parsed.reviewerId) return badRequest(res, '选择执行人时必须同时选择审核人')
    const v = await validateUsers(parsed.reviewerId, parsed.assigneeIds)
    if (!v.reviewerOk) return badRequest(res, 'reviewerId 对应用户不存在')
    if (v.missingAssignees.length > 0) {
      return badRequest(res, `assigneeIds 含不存在的用户：${v.missingAssignees.join(', ')}`)
    }
  }

  // 3. 事务：建 Task DRAFT + N 条 Assignee PENDING
  const created = await prisma.$transaction(async (tx) => {
    const task = await tx.standardExecutionTask.create({
      data: {
        enterpriseId,
        requirementId: parsed.requirementId ?? null,
        title: parsed.title,
        description: parsed.description ?? null,
        taskType: parsed.taskType ?? null,
        submitRequirement: parsed.submitRequirement ?? null,
        deadlineAt: parsed.deadlineAt ?? null,
        deadlineMode: parsed.deadlineMode,
        deadlineDaysAfterApproval: parsed.deadlineDaysAfterApproval ?? null,
        reviewerId: parsed.reviewerId ?? null,
        checklistSchema: toPrismaJson(parsed.checklistSchema),
        parametersSchema: toPrismaJson(parsed.parametersSchema),
        learningMaterials: toPrismaJson(parsed.learningMaterials),
        basisSnapshots: requirement ? toPrismaJson(buildBasisSnapshots([requirement])) : [],
        quizBankId: parsed.quizBankId ?? null,
        createdBy: req.userId!,
      },
    })
    if (parsed.assigneeIds.length > 0) {
      await tx.standardExecutionTaskAssignee.createMany({
        data: parsed.assigneeIds.map((aid) => ({
          enterpriseId,
          taskId: task.id,
          assigneeId: aid,
          // departmentId / reviewerId per-assignee 一期不设，走 Task.reviewerId
        })),
      })
    }
    return task
  })

  res.status(201).json({ data: withSubmitFormConfig(withOverdue(created)) })
}

async function doBatchCreateTasksFromRequirements(
  req: AuthRequest,
  res: Response,
  parsed: BatchCreateTasksFromRequirementsInput,
) {
  const enterpriseId = getEnterpriseId(req as never)
  const requirements = await prisma.standardExecutionRequirement.findMany({
    where: { id: { in: parsed.requirementIds }, enterpriseId },
    select: {
      id: true,
      sourceId: true,
      clauseNo: true,
      title: true,
      requirementText: true,
      status: true,
      recommendedTaskType: true,
      executionDescription: true,
      submitRequirement: true,
      source: { select: { id: true, title: true, sourceNo: true, sourceType: true, version: true, isLatestVersion: true } },
    },
  })
  if (requirements.length !== parsed.requirementIds.length) {
    return badRequest(res, '部分要求项不存在或不属于当前企业')
  }
  const inactive = requirements.filter((r) => r.status !== 'ACTIVE')
  if (inactive.length > 0) {
    return badRequest(res, `仅 ACTIVE 要求项可生成任务：${inactive.map((r) => r.title).join('、')}`)
  }
  const oldVersion = requirements.filter((r) => r.source?.isLatestVersion === false)
  if (oldVersion.length > 0) {
    return badRequest(res, `旧版本标准不可创建任务：${oldVersion.map((r) => r.title).join('、')}`)
  }

  if (parsed.reviewerId || parsed.assigneeIds.length > 0) {
    if (!parsed.reviewerId) return badRequest(res, '选择执行人时必须同时选择审核人')
    const v = await validateUsers(parsed.reviewerId, parsed.assigneeIds)
    if (!v.reviewerOk) return badRequest(res, 'reviewerId 对应用户不存在')
    if (v.missingAssignees.length > 0) {
      return badRequest(res, `assigneeIds 含不存在的用户：${v.missingAssignees.join(', ')}`)
    }
  }

  const byId = new Map(requirements.map((r) => [r.id, r]))
  const prefix = (parsed.titlePrefix || '').trim()

  const created = await prisma.$transaction(async (tx) => {
    const tasks = []
    for (const requirementId of parsed.requirementIds) {
      const requirement = byId.get(requirementId)!
      // 未显式指定 taskType 时，继承检查点的 AI 推荐类型；都没有则兜底 OTHER
      const taskType = parsed.taskType ?? requirement.recommendedTaskType ?? 'OTHER'
      const task = await tx.standardExecutionTask.create({
        data: {
          enterpriseId,
          requirementId,
          title: prefix ? `${prefix} - ${requirement.title}` : requirement.title,
          description: requirement.requirementText.slice(0, 2000),
          taskType,
          submitRequirement: parsed.submitRequirement ?? requirement.submitRequirement ?? null,
          deadlineAt: parsed.deadlineAt ?? null,
          deadlineMode: parsed.deadlineMode,
          deadlineDaysAfterApproval: parsed.deadlineDaysAfterApproval ?? null,
          reviewerId: parsed.reviewerId ?? null,
          checklistSchema: Prisma.DbNull,
          parametersSchema: Prisma.DbNull,
          learningMaterials: Prisma.DbNull,
          basisSnapshots: toPrismaJson(buildBasisSnapshots([requirement])),
          quizBankId: parsed.quizBankId ?? null,
          createdBy: req.userId!,
        },
      })
      if (parsed.assigneeIds.length > 0) {
        await tx.standardExecutionTaskAssignee.createMany({
          data: parsed.assigneeIds.map((aid) => ({ enterpriseId, taskId: task.id, assigneeId: aid })),
        })
      }
      tasks.push(task)
    }
    return tasks
  })

  res.status(201).json({ data: created.map((task) => withSubmitFormConfig(withOverdue(task))), createdCount: created.length })
}

export function registerStandardExecutionTaskRoutes(app: Express) {
  app.get(
    '/api/admin/standard-execution/tasks/list-v2',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = TaskListV2QuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)
      const result = await buildManagementTaskListV2(enterpriseId, parsed.data, req.userId)
      res.json(result)
    },
  )

  // ─── 列表 ─────────────────────────────────────────
  app.get(
    '/api/admin/standard-execution/tasks',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = TaskListQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const { requirementId, status, origin, reviewerId, assigneeId, keyword, page, pageSize } = parsed.data
      const enterpriseId = getEnterpriseId(req as never)

      const where: Prisma.StandardExecutionTaskWhereInput = { enterpriseId, deletedAt: null }
      if (requirementId) where.requirementId = requirementId
      if (status) where.status = Array.isArray(status) ? { in: status } : status
      if (origin === 'PLAN') where.planId = { not: null }
      if (origin === 'MANUAL') where.planId = null
      if (reviewerId) where.reviewerId = reviewerId
      if (keyword) where.title = { contains: keyword, mode: 'insensitive' }
      if (assigneeId) where.assignees = { some: { assigneeId } }

      const [rows, total] = await Promise.all([
        prisma.standardExecutionTask.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.standardExecutionTask.count({ where }),
      ])
      res.json({ data: rows.map((task) => withSubmitFormConfig(withOverdue(task))), total, page, pageSize })
    },
  )

  // ─── 详情 ─────────────────────────────────────────
  app.get(
    '/api/admin/standard-execution/tasks/:id',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)
      const task = await prisma.standardExecutionTask.findFirst({
        where: { id, enterpriseId, deletedAt: null },
        include: {
          assignees: true,
          requirement: { include: { source: true } },
          items: {
            include: { requirement: { include: { source: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      })
      if (!task) return res.status(404).json({ error: '记录不存在' })
      res.json({ data: withSubmitFormConfig(withOverdue(task)) })
    },
  )

  // ─── 创建 ─────────────────────────────────────────
  app.post(
    '/api/admin/standard-execution/tasks',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = TaskCreateSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      await doCreateTask(req, res, parsed.data)
    },
  )

  // ─── 便捷创建：requirements/:id/create-task ────────────
  app.post(
    '/api/admin/standard-execution/requirements/:id/create-task',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const requirementId = String(req.params.id || '').trim()
      if (!requirementId) return badRequest(res, 'id 非法')
      const parsed = TaskCreateViaRequirementSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      await doCreateTask(req, res, { ...parsed.data, requirementId })
    },
  )

  app.post(
    '/api/admin/standard-execution/requirements/batch-create-tasks',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = BatchCreateTasksFromRequirementsSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      await doBatchCreateTasksFromRequirements(req, res, parsed.data)
    },
  )

  // ─── 编辑（仅 DRAFT）─────────────────────────────────
  app.patch(
    '/api/admin/standard-execution/tasks/:id',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const parsed = TaskUpdateSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)

      const exists = await prisma.standardExecutionTask.findFirst({
        where: { id, enterpriseId, deletedAt: null },
        select: { id: true, status: true },
      })
      if (!exists) return res.status(404).json({ error: '记录不存在' })
      // DRAFT 全字段可改；PUBLISHED 仅安全字段（标题/说明/提交要求/截止/审核人 + 追加执行人）；其余状态不可改
      if (exists.status !== 'DRAFT' && exists.status !== 'PUBLISHED') {
        return res.status(409).json({ error: `仅 DRAFT / PUBLISHED 任务可编辑（当前 ${exists.status}）` })
      }
      const isPublished = exists.status === 'PUBLISHED'

      // 如改 reviewer/assignees，校验存在性
      if (parsed.data.reviewerId || parsed.data.assigneeIds) {
        // 拼一个全量列表去查
        const rid = parsed.data.reviewerId ?? ''
        const aids = parsed.data.assigneeIds ?? []
        if (rid || aids.length > 0) {
          const ids = Array.from(new Set([...(rid ? [rid] : []), ...aids]))
          const found = await prisma.appUser.findMany({
            where: { id: { in: ids } },
            select: { id: true },
          })
          const foundSet = new Set(found.map((u) => u.id))
          if (rid && !foundSet.has(rid)) return badRequest(res, 'reviewerId 对应用户不存在')
          const missing = aids.filter((a) => !foundSet.has(a))
          if (missing.length > 0) {
            return badRequest(res, `assigneeIds 含不存在的用户：${missing.join(', ')}`)
          }
        }
      }

      // 事务：更新 task 字段 + 如有 assigneeIds，全量替换 Assignee 行
      const updated = await prisma.$transaction(async (tx) => {
        const taskUpdate: Prisma.StandardExecutionTaskUpdateInput = {
          updatedBy: req.userId!,
        }
        if (parsed.data.title !== undefined) taskUpdate.title = parsed.data.title
        if (parsed.data.description !== undefined) taskUpdate.description = parsed.data.description
        // 安全字段：DRAFT / PUBLISHED 都可改
        if (parsed.data.submitRequirement !== undefined)
          taskUpdate.submitRequirement = parsed.data.submitRequirement
        if (parsed.data.deadlineAt !== undefined) taskUpdate.deadlineAt = parsed.data.deadlineAt
        if (parsed.data.deadlineMode !== undefined) taskUpdate.deadlineMode = parsed.data.deadlineMode
        if (parsed.data.deadlineDaysAfterApproval !== undefined)
          taskUpdate.deadlineDaysAfterApproval = parsed.data.deadlineDaysAfterApproval ?? null
        if (parsed.data.reviewerId !== undefined) taskUpdate.reviewerId = parsed.data.reviewerId
        // 结构字段：仅 DRAFT 可改（PUBLISHED 禁改任务类型/检查项/参数/学习材料/题库）
        if (!isPublished) {
          if (parsed.data.taskType !== undefined) taskUpdate.taskType = parsed.data.taskType
          if (parsed.data.checklistSchema !== undefined)
            taskUpdate.checklistSchema = toPrismaJson(parsed.data.checklistSchema)
          if (parsed.data.parametersSchema !== undefined)
            taskUpdate.parametersSchema = toPrismaJson(parsed.data.parametersSchema)
          if (parsed.data.learningMaterials !== undefined)
            taskUpdate.learningMaterials = toPrismaJson(parsed.data.learningMaterials)
          if (parsed.data.quizBankId !== undefined)
            taskUpdate.quizBank = parsed.data.quizBankId
              ? { connect: { id: parsed.data.quizBankId } }
              : { disconnect: true }
        }

        const task = await tx.standardExecutionTask.update({
          where: { id },
          data: taskUpdate,
        })

        if (parsed.data.assigneeIds !== undefined) {
          if (isPublished) {
            // PUBLISHED：只追加新执行人（不删已有、不动已有进度），新人从 PENDING 开始
            const existing = await tx.standardExecutionTaskAssignee.findMany({
              where: { taskId: id }, select: { assigneeId: true },
            })
            const existingSet = new Set(existing.map((a) => a.assigneeId))
            const toAdd = parsed.data.assigneeIds.filter((aid) => !existingSet.has(aid))
            if (toAdd.length > 0) {
              await tx.standardExecutionTaskAssignee.createMany({
                data: toAdd.map((aid) => ({ enterpriseId, taskId: id, assigneeId: aid })),
              })
            }
          } else {
            // DRAFT：全量替换
            await tx.standardExecutionTaskAssignee.deleteMany({ where: { taskId: id } })
            await tx.standardExecutionTaskAssignee.createMany({
              data: parsed.data.assigneeIds.map((aid) => ({ enterpriseId, taskId: id, assigneeId: aid })),
            })
          }
        }
        return task
      })

      res.json({ data: withSubmitFormConfig(withOverdue(updated)) })
    },
  )

  // ─── 旧发布接口：任务发布必须先走发布审核 ─────────────
  app.post(
    '/api/admin/standard-execution/tasks/:id/publish',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      return res.status(409).json({ error: '请先提交审核' })
    },
  )

  // ─── 提交任务审核：DRAFT → PENDING_APPROVAL ───────────
  app.post(
    '/api/admin/standard-execution/tasks/:id/submit-approval',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const parsed = TaskApprovalCommentSchema.safeParse(req.body)
      if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      const enterpriseId = getEnterpriseId(req as never)

      const task = await prisma.standardExecutionTask.findFirst({
        where: { id, enterpriseId, deletedAt: null },
        include: { _count: { select: { assignees: true } } },
      })
      if (!task) return res.status(404).json({ error: '记录不存在' })
      try {
        const updated = await prisma.$transaction((tx) =>
          submitTaskApproval(tx, {
            task,
            assigneeCount: task._count.assignees,
            operatorId: req.userId!,
            comment: parsed.data.comment,
          }),
        )
        return res.json({ data: withSubmitFormConfig(withOverdue(updated)) })
      } catch (err) {
        return handleApprovalError(res, err)
      }
    },
  )

  // ─── 任务审核通过：PENDING_APPROVAL → PUBLISHED ───────
  app.post(
    '/api/admin/standard-execution/tasks/:id/approval/approve',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const parsed = TaskApprovalCommentSchema.safeParse(req.body)
      if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      const enterpriseId = getEnterpriseId(req as never)

      const task = await prisma.standardExecutionTask.findFirst({
        where: { id, enterpriseId, deletedAt: null },
      })
      if (!task) return res.status(404).json({ error: '记录不存在' })
      try {
        const result = await prisma.$transaction((tx) =>
          approveTaskApproval(tx, { task, operatorId: req.userId!, comment: parsed.data.comment }),
        )
        return res.json({
          data: withSubmitFormConfig(withOverdue(result.task)),
          deadlineAdjusted: result.deadlineAdjusted,
          oldDeadlineAt: result.oldDeadlineAt,
          newDeadlineAt: result.newDeadlineAt,
        })
      } catch (err) {
        return handleApprovalError(res, err)
      }
    },
  )

  // ─── 任务审核驳回：PENDING_APPROVAL → DRAFT ────────────
  app.post(
    '/api/admin/standard-execution/tasks/:id/approval/reject',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const parsed = TaskApprovalCommentSchema.safeParse(req.body)
      if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      const enterpriseId = getEnterpriseId(req as never)

      const task = await prisma.standardExecutionTask.findFirst({
        where: { id, enterpriseId, deletedAt: null },
      })
      if (!task) return res.status(404).json({ error: '记录不存在' })
      try {
        const updated = await prisma.$transaction((tx) =>
          rejectTaskApproval(tx, { task, operatorId: req.userId!, comment: parsed.data.comment }),
        )
        return res.json({ data: withSubmitFormConfig(withOverdue(updated)) })
      } catch (err) {
        return handleApprovalError(res, err)
      }
    },
  )

  // ─── 取消/停用：DRAFT|PENDING_APPROVAL|PUBLISHED|IN_PROGRESS|OVERDUE → CANCELLED ───────────────
  app.post(
    '/api/admin/standard-execution/tasks/:id/cancel',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)

      const task = await prisma.standardExecutionTask.findFirst({
        where: { id, enterpriseId, deletedAt: null },
        select: { id: true, status: true, deadlineAt: true },
      })
      if (!task) return res.status(404).json({ error: '记录不存在' })
      if (task.status === 'CANCELLED') {
        const full = await prisma.standardExecutionTask.findFirst({ where: { id, enterpriseId } })
        return res.json({ data: full ? withSubmitFormConfig(withOverdue(full)) : null, noop: true })
      }
      if (!['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'IN_PROGRESS', 'OVERDUE'].includes(task.status)) {
        return res.status(409).json({ error: `${task.status} 任务不可取消` })
      }

      const updated = await prisma.standardExecutionTask.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          updatedBy: req.userId!,
        },
      })
      res.json({ data: withSubmitFormConfig(withOverdue(updated)) })
    },
  )

  // ─── 进度：Assignee 状态聚合 ─────────────────────────
  app.get(
    '/api/admin/standard-execution/tasks/:id/progress',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)

      const task = await prisma.standardExecutionTask.findFirst({
        where: { id, enterpriseId, deletedAt: null },
        include: { assignees: true },
      })
      if (!task) return res.status(404).json({ error: '记录不存在' })

      const byStatus: Record<AssigneeStatus, number> = {
        PENDING: 0,
        IN_PROGRESS: 0,
        PENDING_REVIEW: 0,
        REJECTED: 0,
        COMPLETED: 0,
        OVERDUE: 0,
      }
      const now = Date.now()
      const deadlineMs = task.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY
      for (const a of task.assignees) {
        if (ASSIGNEE_STATUS.includes(a.status as AssigneeStatus)) {
          byStatus[a.status as AssigneeStatus]++
        }
      }
      res.json({
        data: {
          taskId: task.id,
          taskStatus: task.status,
          deadlineAt: task.deadlineAt,
          isOverdue: task.status === 'PUBLISHED' && deadlineMs < now,
          total: task.assignees.length,
          byStatus,
          assignees: task.assignees.map((a) => ({
            id: a.id,
            assigneeId: a.assigneeId,
            departmentId: a.departmentId,
            status: a.status,
            submittedAt: a.submittedAt,
            reviewedAt: a.reviewedAt,
            isOverdue:
              task.status === 'PUBLISHED' &&
              deadlineMs < now &&
              a.status !== 'COMPLETED',
          })),
        },
      })
    },
  )

  // ─── 批量取消：DRAFT|PENDING_APPROVAL → CANCELLED ───────────
  // 「批量删除」语义 = 批量取消（终态）。COMPLETED/OVERDUE/已 CANCELLED 落入 skipped。
  app.post(
    '/api/admin/standard-execution/tasks/batch-cancel',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)
      const result = await prisma.standardExecutionTask.updateMany({
        where: { id: { in: parsed.data.ids }, enterpriseId, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED'] }, deletedAt: null },
        data: { status: 'CANCELLED', cancelledAt: new Date(), updatedBy: req.userId! },
      })
      res.json({
        ok: result.count,
        requested: parsed.data.ids.length,
        skipped: parsed.data.ids.length - result.count,
      })
    },
  )

  // ─── 旧批量发布接口：任务发布必须先走发布审核 ─────────
  app.post(
    '/api/admin/standard-execution/tasks/batch-publish',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      return res.status(409).json({ error: '请先提交审核' })
    },
  )

  // ─── 软删除：单个（仅 DRAFT）──────────────────────
  // DELETE /api/admin/standard-execution/tasks/:id —— 仅 DRAFT 可删，软删设 deletedAt；历史 Record 不受影响
  app.delete(
    '/api/admin/standard-execution/tasks/:id',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)
      const task = await prisma.standardExecutionTask.findFirst({
        where: { id, enterpriseId, deletedAt: null },
        select: { id: true, status: true },
      })
      if (!task) return res.status(404).json({ error: '记录不存在' })
      if (task.status !== 'DRAFT') {
        return res.status(403).json({ error: '仅草稿（DRAFT）任务可删除' })
      }
      await prisma.standardExecutionTask.update({
        where: { id },
        data: { deletedAt: new Date(), updatedBy: req.userId! },
      })
      res.json({ ok: true })
    },
  )

  // ─── 软删除：批量（仅 DRAFT）────────────────────────
  // POST /api/admin/standard-execution/tasks/batch-delete —— 非 DRAFT / 已删落入 skipped
  app.post(
    '/api/admin/standard-execution/tasks/batch-delete',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)
      const result = await prisma.standardExecutionTask.updateMany({
        where: { id: { in: parsed.data.ids }, enterpriseId, status: 'DRAFT', deletedAt: null },
        data: { deletedAt: new Date(), updatedBy: req.userId! },
      })
      res.json({
        ok: result.count,
        requested: parsed.data.ids.length,
        skipped: parsed.data.ids.length - result.count,
      })
    },
  )

  // ─── 批量指派：给多个 DRAFT 任务统一设审核人 + 执行人 ──
  // 仅 DRAFT 任务可改派（与单条编辑「仅 DRAFT」一致）；非 DRAFT 落入 skipped。
  app.post(
    '/api/admin/standard-execution/tasks/batch-assign',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = BatchAssignSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)
      const v = await validateUsers(parsed.data.reviewerId, parsed.data.assigneeIds)
      if (!v.reviewerOk) return badRequest(res, 'reviewerId 对应用户不存在')
      if (v.missingAssignees.length > 0) {
        return badRequest(res, `assigneeIds 含不存在的用户：${v.missingAssignees.join(', ')}`)
      }
      const draftTasks = await prisma.standardExecutionTask.findMany({
        where: { id: { in: parsed.data.ids }, enterpriseId, status: 'DRAFT', deletedAt: null },
        select: { id: true },
      })
      const draftIds = draftTasks.map((t) => t.id)
      if (draftIds.length > 0) {
        await prisma.$transaction(async (tx) => {
          for (const taskId of draftIds) {
            await tx.standardExecutionTask.update({
              where: { id: taskId },
              data: { reviewerId: parsed.data.reviewerId, updatedBy: req.userId! },
            })
            await tx.standardExecutionTaskAssignee.deleteMany({ where: { taskId } })
            await tx.standardExecutionTaskAssignee.createMany({
              data: parsed.data.assigneeIds.map((aid) => ({ enterpriseId, taskId, assigneeId: aid })),
            })
          }
        })
      }
      res.json({
        ok: draftIds.length,
        requested: parsed.data.ids.length,
        skipped: parsed.data.ids.length - draftIds.length,
      })
    },
  )
}
