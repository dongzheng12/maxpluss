/**
 * 合规审核台（Submission 通过 / 驳回）— Admin / 企业管理员 / 企业经理 / task.reviewerId
 *
 *   GET    /api/admin/standard-execution/reviews                — 审核列表（默认 SUBMITTED 待审）
 *   GET    /api/enterprise/standard-execution/reviews           — 企业审核列表（enterpriseId 隔离）
 *   GET    /api/admin/standard-execution/reviews/:submissionId  — 单条详情（含 attachments / reviewLogs）
 *   POST   /api/admin/standard-execution/reviews/:submissionId/approve  — 通过事务（doc §七.4 8 步）
 *   POST   /api/admin/standard-execution/reviews/:submissionId/reject   — 驳回事务（doc §七.5 6 步）
 *
 * 权限：requireAuth + (平台 admin / 企业 ADMIN|MANAGER / task.reviewerId=req.userId)
 *
 * approve 事务原子写入 4 张表：Submission / Assignee / ReviewLog / Record（+ 可能的 Task）。
 * reject 事务原子写入 3 张表：Submission / Assignee / ReviewLog（不生成 Record）。
 *
 * @see 必读/02_技术架构.md §四.7 Submission + §四.9 ReviewLog + §七.4 SubmissionStatus + §八 路由结构
 */
import type { Express, Response } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { requireAuth, type AuthRequest } from '../auth.js'
import { getEnterpriseId } from './utils.js'
import {
  ReviewListQuerySchema,
  ReviewApproveSchema,
  ReviewRejectSchema,
} from './types.js'
import { normalizeBasisSnapshots, resolveRequirementBasis } from './basisSnapshots.js'
import { emitEnterpriseWebhook } from '../openApiRoutes.js'
import { analyzeReviewSubmission } from './reviewAi.js'
import { enqueueRecordVectorIndex } from '../vectorIndexWorker.js'

function badRequest(res: Response, msg: string) {
  return res.status(400).json({ error: msg })
}

type TaskItemSnapshot = {
  taskItemId: string
  requirementId: string
  status: string
  note?: string | null
  fileUrls?: string[]
}

function getTaskItemSnapshotMap(submitDataJson: unknown) {
  const root = submitDataJson && typeof submitDataJson === 'object'
    ? submitDataJson as { items?: unknown }
    : null
  const items = Array.isArray(root?.items) ? root.items : []
  const map = new Map<string, TaskItemSnapshot>()
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (typeof item.taskItemId !== 'string') continue
    map.set(item.taskItemId, {
      taskItemId: item.taskItemId,
      requirementId: typeof item.requirementId === 'string' ? item.requirementId : '',
      status: typeof item.status === 'string' ? item.status : 'PENDING',
      note: typeof item.note === 'string' ? item.note : null,
      fileUrls: Array.isArray(item.fileUrls)
        ? item.fileUrls.filter((v): v is string => typeof v === 'string')
        : [],
    })
  }
  return map
}

const REVIEW_PATHS = [
  '/api/admin/standard-execution/reviews',
  '/api/enterprise/standard-execution/reviews',
] satisfies string[]
const REVIEW_DETAIL_PATHS = REVIEW_PATHS.map((p) => `${p}/:submissionId`)
const REVIEW_AI_ANALYSIS_PATHS = REVIEW_PATHS.map((p) => `${p}/:submissionId/ai-analysis`)
const REVIEW_APPROVE_PATHS = REVIEW_PATHS.map((p) => `${p}/:submissionId/approve`)
const REVIEW_REJECT_PATHS = REVIEW_PATHS.map((p) => `${p}/:submissionId/reject`)
const ENTERPRISE_REVIEW_ROLES = new Set(['ADMIN', 'MANAGER', 'REVIEWER'])

function isEnterpriseReviewPath(req: AuthRequest) {
  return req.path.startsWith('/api/enterprise/')
}

function canSeeAllReviews(req: AuthRequest) {
  if (req.userRole === 'admin') return true
  return req.userEnterpriseRole === 'ADMIN' || req.userEnterpriseRole === 'MANAGER'
}

function hasEnterpriseReviewAccess(req: AuthRequest) {
  if (!isEnterpriseReviewPath(req)) return true
  if (req.userRole === 'admin') return true
  return ENTERPRISE_REVIEW_ROLES.has(String(req.userEnterpriseRole || ''))
}

/** 校验 submission 可审核 + 权限。返回完整上下文供事务使用 */
async function loadAndCheck(req: AuthRequest, submissionId: string) {
  const enterpriseId = getEnterpriseId(req as never)
  if (!hasEnterpriseReviewAccess(req)) {
    return { ok: false as const, code: 403, msg: '无权访问企业合规审核台' }
  }
  const submission = await prisma.standardExecutionSubmission.findFirst({
    where: { id: submissionId, enterpriseId },
    include: {
      task: {
        include: {
          requirement: { select: { id: true, sourceId: true, title: true } },
          items: {
            include: {
              requirement: { select: { id: true, sourceId: true, title: true } },
            },
          },
        },
      },
    },
  })
  if (!submission) return { ok: false as const, code: 404, msg: '提交不存在' }

  // 权限：平台 admin / 企业 ADMIN|MANAGER / task.reviewerId=me
  const isAdmin = canSeeAllReviews(req)
  const isReviewer = submission.task.reviewerId === req.userId
  if (!isAdmin && !isReviewer) {
    return { ok: false as const, code: 403, msg: '无权审核此提交' }
  }

  // 状态校验
  if (submission.status !== 'SUBMITTED') {
    return {
      ok: false as const,
      code: 409,
      msg: `当前状态 ${submission.status} 不可审核`,
    }
  }
  if (!submission.isLatest) {
    return { ok: false as const, code: 409, msg: '仅最新版本可审核' }
  }

  return { ok: true as const, submission, enterpriseId }
}

export function registerStandardExecutionReviewRoutes(app: Express) {
  // ─── 列表 ─────────────────────────────────────────
  app.get(
    REVIEW_PATHS,
    requireAuth as never,
    async (req: AuthRequest, res) => {
      if (!hasEnterpriseReviewAccess(req)) {
        return res.status(403).json({ error: '无权访问企业合规审核台' })
      }
      const parsed = ReviewListQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const { status, scope, taskId, keyword, page, pageSize } = parsed.data
      const enterpriseId = getEnterpriseId(req as never)

      const where: Prisma.StandardExecutionSubmissionWhereInput = { enterpriseId }
      // 默认仅 SUBMITTED；显式传 status 覆盖；status='all' 则不过滤
      if (status === undefined) where.status = 'SUBMITTED'
      else if (status !== 'all') where.status = Array.isArray(status) ? { in: status } : status
      if (taskId) where.taskId = taskId

      // scope='mine' / 非平台 admin / 企业 REVIEWER → 只看自己作为 reviewer 的
      if (scope === 'mine' || !canSeeAllReviews(req)) {
        where.task = { reviewerId: req.userId! }
      }

      if (keyword) {
        where.task = {
          ...(where.task as Prisma.StandardExecutionTaskWhereInput),
          title: { contains: keyword, mode: 'insensitive' },
        }
      }

      const [rows, total] = await Promise.all([
        prisma.standardExecutionSubmission.findMany({
          where,
          orderBy: { submittedAt: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            task: {
              include: {
                requirement: { select: { id: true, title: true } },
              },
            },
          },
        }),
        prisma.standardExecutionSubmission.count({ where }),
      ])

      // 批量查 assignee.status（Submission 与 Assignee 在 schema 中无 prisma relation，单独 join）
      const assigneeKeys = rows.map((s) => ({ taskId: s.taskId, assigneeId: s.assigneeId }))
      const assignees = assigneeKeys.length
        ? await prisma.standardExecutionTaskAssignee.findMany({
            where: {
              enterpriseId,
              OR: assigneeKeys,
            },
            select: { taskId: true, assigneeId: true, status: true, submittedAt: true, reviewedAt: true },
          })
        : []
      const assigneeMap = new Map(
        assignees.map((a) => [`${a.taskId}:${a.assigneeId}`, a]),
      )

      const data = rows.map((s) => {
        const a = assigneeMap.get(`${s.taskId}:${s.assigneeId}`)
        return {
          submission: {
            id: s.id,
            version: s.version,
            isLatest: s.isLatest,
            submitText: s.submitText,
            status: s.status,
            submittedAt: s.submittedAt,
            reviewedAt: s.reviewedAt,
            reviewComment: s.reviewComment,
          },
          task: {
            id: s.task.id,
            title: s.task.title,
            deadlineAt: s.task.deadlineAt,
            reviewerId: s.task.reviewerId,
            basisSnapshots: s.task.basisSnapshots,
          },
          requirement: s.task.requirement,
          assigneeId: s.assigneeId,
          assignee: a
            ? { status: a.status, submittedAt: a.submittedAt, reviewedAt: a.reviewedAt }
            : null,
        }
      })

      res.json({ data, total, page, pageSize })
    },
  )

  // ─── 详情 ─────────────────────────────────────────
  app.get(
    REVIEW_DETAIL_PATHS,
    requireAuth as never,
    async (req: AuthRequest, res) => {
      if (!hasEnterpriseReviewAccess(req)) {
        return res.status(403).json({ error: '无权访问企业合规审核台' })
      }
      const submissionId = String(req.params.submissionId || '').trim()
      if (!submissionId) return badRequest(res, 'submissionId 非法')
      const enterpriseId = getEnterpriseId(req as never)

      const submission = await prisma.standardExecutionSubmission.findFirst({
        where: { id: submissionId, enterpriseId },
        include: {
          task: {
            include: {
              requirement: { include: { source: true } },
            },
          },
        },
      })
      if (!submission) return res.status(404).json({ error: '提交不存在' })

      const isAdmin = canSeeAllReviews(req)
      const isReviewer = submission.task.reviewerId === req.userId
      if (!isAdmin && !isReviewer) {
        return res.status(403).json({ error: '无权查看此审核' })
      }

      const [attachments, reviewLogs, assignee] = await Promise.all([
        prisma.standardExecutionAttachment.findMany({
          where: { bizType: 'SUBMISSION', bizId: submission.id },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.standardExecutionReviewLog.findMany({
          where: { submissionId: submission.id, enterpriseId },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.standardExecutionTaskAssignee.findFirst({
          where: { taskId: submission.taskId, assigneeId: submission.assigneeId, enterpriseId },
        }),
      ])

      const canApprove =
        submission.status === 'SUBMITTED' && submission.isLatest && (isAdmin || isReviewer)
      const firstSnapshot = normalizeBasisSnapshots(submission.task.basisSnapshots)[0]
      const basis = submission.task.requirementId
        ? resolveRequirementBasis(submission.task.basisSnapshots, submission.task.requirementId, submission.task.requirement)
        : firstSnapshot
          ? {
              requirement: {
                id: firstSnapshot.requirementId,
                sourceId: firstSnapshot.sourceId,
                clauseNo: firstSnapshot.clauseNo,
                title: firstSnapshot.title,
                requirementText: firstSnapshot.requirementText,
                executionDescription: firstSnapshot.executionDescription,
                submitRequirement: firstSnapshot.submitRequirement,
                recommendedTaskType: firstSnapshot.recommendedTaskType,
                source: {
                  id: firstSnapshot.sourceId,
                  title: firstSnapshot.sourceTitle,
                  sourceNo: firstSnapshot.sourceNo,
                  sourceType: firstSnapshot.sourceType,
                  version: firstSnapshot.version,
                },
              },
            }
          : null

      res.json({
        data: {
          submission,
          attachments,
          task: basis
            ? {
                ...submission.task,
                requirement: basis.requirement,
              }
            : submission.task,
          requirement: basis?.requirement ?? submission.task.requirement,
          assignee,
          reviewLogs,
          canApprove,
        },
      })
    },
  )

  app.post(
    REVIEW_AI_ANALYSIS_PATHS,
    requireAuth as never,
    async (req: AuthRequest, res) => {
      if (!hasEnterpriseReviewAccess(req)) {
        return res.status(403).json({ error: '无权访问企业合规审核台' })
      }
      const submissionId = String(req.params.submissionId || '').trim()
      if (!submissionId) return badRequest(res, 'submissionId 非法')
      const enterpriseId = getEnterpriseId(req as never)

      const submission = await prisma.standardExecutionSubmission.findFirst({
        where: { id: submissionId, enterpriseId },
        include: {
          task: {
            include: {
              requirement: { include: { source: true } },
            },
          },
        },
      })
      if (!submission) return res.status(404).json({ error: '提交不存在' })

      const isAdmin = canSeeAllReviews(req)
      const isReviewer = submission.task.reviewerId === req.userId
      if (!isAdmin && !isReviewer) return res.status(403).json({ error: '无权查看此审核' })

      const [attachments, history] = await Promise.all([
        prisma.standardExecutionAttachment.findMany({
          where: { enterpriseId, bizType: 'SUBMISSION', bizId: submission.id },
          select: { fileName: true },
          orderBy: { createdAt: 'asc' },
        }),
        submission.task.requirementId
          ? prisma.standardExecutionSubmission.findMany({
              where: {
                enterpriseId,
                id: { not: submission.id },
                status: 'APPROVED',
                task: { requirementId: submission.task.requirementId },
              },
              select: { submitText: true },
              orderBy: { submittedAt: 'desc' },
              take: 20,
            })
          : Promise.resolve([]),
      ])

      const basis = submission.task.requirementId
        ? resolveRequirementBasis(submission.task.basisSnapshots, submission.task.requirementId, submission.task.requirement)
        : null
      const requirement = basis?.requirement ?? submission.task.requirement
      if (!requirement) return res.status(400).json({ error: '当前提交未关联控制点，无法生成 AI 分析' })
      const requiredMaterials = 'requiredMaterials' in requirement ? requirement.requiredMaterials : null
      const analysis = await analyzeReviewSubmission({
        requirement: {
          title: requirement.title,
          requirementText: requirement.requirementText,
          submitRequirement: requirement.submitRequirement,
          requiredMaterials,
        },
        task: {
          title: submission.task.title,
          taskType: submission.task.taskType,
          checklistSchema: submission.task.checklistSchema,
          parametersSchema: submission.task.parametersSchema,
        },
        submission: {
          submitText: submission.submitText,
          submitDataJson: submission.submitDataJson,
        },
        attachments,
        history,
      })

      res.json({ data: analysis })
    },
  )

  // ─── 通过（doc §七.4 8 步事务）────────────────────────
  app.post(
    REVIEW_APPROVE_PATHS,
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const submissionId = String(req.params.submissionId || '').trim()
      if (!submissionId) return badRequest(res, 'submissionId 非法')

      const parsed = ReviewApproveSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }

      const check = await loadAndCheck(req, submissionId)
      if (!check.ok) return res.status(check.code).json({ error: check.msg })
      const { submission, enterpriseId } = check
      const task = submission.task
      const reqMeta = task.requirement

      const result = await prisma.$transaction(async (tx) => {
        const now = new Date()

        // 4. Submission → APPROVED
        const updatedSubmission = await tx.standardExecutionSubmission.update({
          where: { id: submission.id },
          data: {
            status: 'APPROVED',
            reviewedAt: now,
            reviewerId: req.userId!,
            reviewComment: parsed.data.reviewComment ?? null,
          },
        })

        // 5. Assignee → COMPLETED
        await tx.standardExecutionTaskAssignee.updateMany({
          where: {
            taskId: task.id,
            assigneeId: submission.assigneeId,
            enterpriseId,
          },
          data: { status: 'COMPLETED', reviewedAt: now },
        })

        // 6. ReviewLog
        await tx.standardExecutionReviewLog.create({
          data: {
            enterpriseId,
            submissionId: submission.id,
            taskId: task.id,
            action: 'APPROVE',
            fromStatus: 'SUBMITTED',
            toStatus: 'APPROVED',
            reviewerId: req.userId!,
            comment: parsed.data.reviewComment ?? null,
          },
        })

        // 7. Record：新模型（TaskItem）→ 每个 DONE item 建 1 条 Record；旧模型建 1 条
        const assigneeRow = await tx.standardExecutionTaskAssignee.findFirst({
          where: { taskId: task.id, assigneeId: submission.assigneeId, enterpriseId },
          select: { departmentId: true },
        })
        const summary =
          parsed.data.recordSummary?.trim() ||
          submission.submitText.slice(0, 200)

        const taskItems = task.items ?? []
        const isTaskItemMode = task.planId != null || taskItems.length > 0
        const snapshotByItemId = getTaskItemSnapshotMap(submission.submitDataJson)

        const createdRecords: { id: string; requirementId: string; taskItemId: string | null }[] = []

        if (isTaskItemMode && taskItems.length > 0) {
          // 新模型：遍历提交快照中 DONE 的 TaskItem，每个建 1 条 Record（SKIPPED/PENDING 跳过）。
          // 快照来自当前执行人的 progress，避免多人任务互相覆盖。
          for (const item of taskItems) {
            const snapshot = snapshotByItemId.get(item.id)
            const itemStatus = snapshot?.status ?? item.status
            if (itemStatus !== 'DONE') continue
            const basis = resolveRequirementBasis(task.basisSnapshots, item.requirementId, item.requirement)
            if (!basis) continue
            const itemReq = basis.requirement as { id: string; sourceId: string; title?: string | null }
            const recordTitle = parsed.data.recordTitle?.trim() || itemReq.title || task.title
            const rec = await tx.standardExecutionRecord.create({
              data: {
                enterpriseId,
                sourceId: basis.snapshot?.sourceId ?? itemReq.sourceId,
                requirementId: item.requirementId,
                taskItemId: item.id,
                taskId: task.id,
                submissionId: submission.id,
                assigneeId: submission.assigneeId,
                departmentId: assigneeRow?.departmentId ?? null,
                title: recordTitle,
                summary,
                status: 'VALID',
                createdFrom: 'REVIEW_APPROVE',
                recordDate: now,
              },
            })
            createdRecords.push({ id: rec.id, requirementId: rec.requirementId, taskItemId: rec.taskItemId })
          }
        } else {
          // 旧模型：1 条 Record（使用原有 reqMeta；旧 task 必然有 requirementId）
          if (reqMeta) {
            const basis = resolveRequirementBasis(task.basisSnapshots, reqMeta.id, reqMeta)
            const requirement = basis?.requirement as { id: string; sourceId: string } | undefined
            const title = parsed.data.recordTitle?.trim() || task.title
            const rec = await tx.standardExecutionRecord.create({
              data: {
                enterpriseId,
                sourceId: basis?.snapshot?.sourceId ?? requirement?.sourceId ?? reqMeta.sourceId,
                requirementId: basis?.snapshot?.requirementId ?? requirement?.id ?? reqMeta.id,
                taskId: task.id,
                submissionId: submission.id,
                assigneeId: submission.assigneeId,
                departmentId: assigneeRow?.departmentId ?? null,
                title,
                summary,
                status: 'VALID',
                createdFrom: 'REVIEW_APPROVE',
                recordDate: now,
              },
            })
            createdRecords.push({ id: rec.id, requirementId: rec.requirementId, taskItemId: rec.taskItemId })
          }
        }

        // 8. 同 task 下所有 Assignee 是否都 COMPLETED → Task → COMPLETED
        const remaining = await tx.standardExecutionTaskAssignee.count({
          where: {
            taskId: task.id,
            enterpriseId,
            status: { not: 'COMPLETED' },
          },
        })
        let updatedTask = null
        if (remaining === 0) {
          updatedTask = await tx.standardExecutionTask.update({
            where: { id: task.id },
            data: { status: 'COMPLETED', completedAt: now, updatedBy: req.userId! },
          })
        }

        return { submission: updatedSubmission, records: createdRecords, task: updatedTask }
      })

      void emitEnterpriseWebhook(enterpriseId, 'review.approved', {
        submissionId: result.submission.id,
        taskId: task.id,
        recordIds: result.records.map((record) => record.id),
      }).catch(() => undefined)
      for (const record of result.records) {
        enqueueRecordVectorIndex(record.id)
        void emitEnterpriseWebhook(enterpriseId, 'record.created', {
          recordId: record.id,
          taskId: task.id,
          requirementId: record.requirementId,
        }).catch(() => undefined)
      }
      if (result.task) {
        void emitEnterpriseWebhook(enterpriseId, 'task.completed', {
          taskId: result.task.id,
          completedAt: result.task.completedAt?.toISOString() ?? new Date().toISOString(),
        }).catch(() => undefined)
      }

      res.json({
        data: {
          submission: result.submission,
          records: result.records,
          // 向后兼容：旧客户端期望 record 单数；result.records[0] 覆盖旧路径
          record: result.records[0] ?? null,
          taskCompleted: !!result.task,
        },
      })
    },
  )

  // ─── 驳回（doc §七.5 6 步事务）─────────────────────────
  app.post(
    REVIEW_REJECT_PATHS,
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const submissionId = String(req.params.submissionId || '').trim()
      if (!submissionId) return badRequest(res, 'submissionId 非法')

      const parsed = ReviewRejectSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }

      const check = await loadAndCheck(req, submissionId)
      if (!check.ok) return res.status(check.code).json({ error: check.msg })
      const { submission, enterpriseId } = check
      const task = submission.task

      const updatedSubmission = await prisma.$transaction(async (tx) => {
        const now = new Date()

        // 4. Submission → REJECTED
        const us = await tx.standardExecutionSubmission.update({
          where: { id: submission.id },
          data: {
            status: 'REJECTED',
            reviewedAt: now,
            reviewerId: req.userId!,
            reviewComment: parsed.data.reviewComment,
          },
        })

        // 5. Assignee → REJECTED
        await tx.standardExecutionTaskAssignee.updateMany({
          where: {
            taskId: task.id,
            assigneeId: submission.assigneeId,
            enterpriseId,
          },
          data: { status: 'REJECTED', reviewedAt: now },
        })

        // 6. ReviewLog
        await tx.standardExecutionReviewLog.create({
          data: {
            enterpriseId,
            submissionId: submission.id,
            taskId: task.id,
            action: 'REJECT',
            fromStatus: 'SUBMITTED',
            toStatus: 'REJECTED',
            reviewerId: req.userId!,
            comment: parsed.data.reviewComment,
          },
        })

        return us
      })

      res.json({ data: { submission: updatedSubmission } })
    },
  )
}
