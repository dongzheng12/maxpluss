/**
 * 员工小程序端 — 我的任务（只读 + view 状态机）
 *
 *   GET  /api/app/standard-execution/tasks           — 我的任务列表（Tab：todo/review/done/closed）
 *   GET  /api/app/standard-execution/tasks/:id       — 任务详情（仅自己被指派的）
 *   POST /api/app/standard-execution/tasks/:id/view  — 进入任务：PENDING → IN_PROGRESS（其他状态 noop）
 *   GET  /api/app/standard-execution/records         — 我的证据库（Record.assigneeId = me，VALID）
 *
 * 权限：requireAuth（任意已登录用户）。
 * 所有查询硬过滤 assigneeId = me + enterpriseId 隔离。
 *
 * 任务可见性（任务审核决策）：
 *   task.status IN ('PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE') → 员工可见
 *   DRAFT / PENDING_APPROVAL / CANCELLED → 对员工不可见
 *
 * @see 必读/02_技术架构.md §四.4-7 Task/Assignee/Submission + §七.3 AssigneeStatus（小程序 4 Tab 映射） + §八 路由结构
 */
import type { Express, Response } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { requireAuth, type AuthRequest } from '../auth.js'
import { getEnterpriseId } from './utils.js'
import { enqueueRecordVectorIndex } from '../vectorIndexWorker.js'
import {
  MpTaskListQuerySchema,
  MyTaskListV2QuerySchema,
  MpRecordListQuerySchema,
  TaskItemPatchSchema,
  type MpTaskTab,
} from './types.js'
import {
  EMPLOYEE_OPERABLE_TASK_STATUSES,
  EMPLOYEE_VISIBLE_TASK_STATUSES,
} from './taskApproval.js'
import { buildMyTaskListV2 } from './taskListV2.js'
import { buildSubmitFormConfig } from './submitFormConfig.js'

function badRequest(res: Response, msg: string) {
  return res.status(400).json({ error: msg })
}

function normalizeFileUrls(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

// task.status 员工可见集合
const VISIBLE_TASK_STATUSES: Prisma.StandardExecutionTaskWhereInput['status'] = {
  in: [...EMPLOYEE_VISIBLE_TASK_STATUSES],
}

// Tab → assignee.status 映射
const TAB_TO_ASSIGNEE_STATUS: Record<MpTaskTab, string[]> = {
  todo: ['PENDING', 'IN_PROGRESS', 'REJECTED'],  // 待处理含驳回（员工需重新提交）
  review: ['PENDING_REVIEW'],
  done: ['COMPLETED'],
  closed: [],  // 已关闭按 task.status=CANCELLED 查，不依赖 assignee status
}

export function registerStandardExecutionMpTaskRoutes(app: Express) {
  app.get(
    '/api/app/standard-execution/tasks/list-v2',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const parsed = MyTaskListV2QuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)
      const result = await buildMyTaskListV2(enterpriseId, req.userId!, parsed.data)
      res.json(result)
    },
  )

  // ─── 我的任务列表 ─────────────────────────────────
  app.get(
    '/api/app/standard-execution/tasks',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const parsed = MpTaskListQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const { tab, page, pageSize } = parsed.data
      const enterpriseId = getEnterpriseId(req as never)

      // 已关闭 tab：按 task.status=CANCELLED 查（不依赖 assignee status）；其余按 assignee status + 可见 task
      const where: Prisma.StandardExecutionTaskAssigneeWhereInput = tab === 'closed'
        ? { enterpriseId, assigneeId: req.userId!, task: { status: 'CANCELLED' } }
        : {
            enterpriseId,
            assigneeId: req.userId!,
            status: { in: TAB_TO_ASSIGNEE_STATUS[tab] },
            task: { status: VISIBLE_TASK_STATUSES },
          }

      // 排序：待处理/审核中按截止升序(即将到期在前)+更新倒序；已完成/已关闭按更新倒序(最近在前)
      const orderBy: Prisma.StandardExecutionTaskAssigneeOrderByWithRelationInput[] =
        tab === 'done' || tab === 'closed'
          ? [{ updatedAt: 'desc' }]
          : [{ task: { deadlineAt: 'asc' } }, { updatedAt: 'desc' }]

      const [rows, total] = await Promise.all([
        prisma.standardExecutionTaskAssignee.findMany({
          where,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            task: {
              include: {
                requirement: { select: { id: true, title: true, clauseNo: true } },
              },
            },
          },
        }),
        prisma.standardExecutionTaskAssignee.count({ where }),
      ])

      const now = Date.now()
      const data = rows.map((a) => {
        const deadlineMs = a.task.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY
        const isOverdue =
          a.task.status === 'PUBLISHED' && deadlineMs < now && a.status !== 'COMPLETED'
        return {
          assigneeId: a.id,
          assigneeStatus: a.status,
          submittedAt: a.submittedAt,
          reviewedAt: a.reviewedAt,
          isOverdue,
          isRejected: a.status === 'REJECTED',
          task: {
            id: a.task.id,
            title: a.task.title,
            taskType: a.task.taskType,
            status: a.task.status,
            deadlineAt: a.task.deadlineAt,
            basisSnapshots: a.task.basisSnapshots,
            requirement: a.task.requirement,
          },
        }
      })

      res.json({ data, total, page, pageSize })
    },
  )

  // ─── 任务详情 ─────────────────────────────────────
  app.get(
    '/api/app/standard-execution/tasks/:id',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const taskId = String(req.params.id || '').trim()
      if (!taskId) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)

      // 必须是被指派的员工才能看
      const myAssignee = await prisma.standardExecutionTaskAssignee.findFirst({
        where: { taskId, enterpriseId, assigneeId: req.userId! },
      })
      if (!myAssignee) return res.status(403).json({ error: '无权查看此任务' })

      const task = await prisma.standardExecutionTask.findFirst({
        where: { id: taskId, enterpriseId },
        include: {
          requirement: { include: { source: true } },
          items: {
            include: { requirement: { include: { source: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      })
      if (!task) return res.status(404).json({ error: '任务不存在' })

      // 任务审核通过并下发前，执行人虽已预创建但员工端不可见；CANCELLED 已关闭但允许只读查看。
      if (task.status !== 'CANCELLED' && !(EMPLOYEE_VISIBLE_TASK_STATUSES as readonly string[]).includes(task.status)) {
        return res.status(404).json({ error: '任务不存在' })
      }

      // 我的所有提交（按 version desc，最新在前）
      const mySubmissions = await prisma.standardExecutionSubmission.findMany({
        where: {
          taskId,
          enterpriseId,
          assigneeId: req.userId!,
        },
        orderBy: { version: 'desc' },
      })
      const submissionIds = mySubmissions.map((s) => s.id)
      const attachments = submissionIds.length > 0
        ? await prisma.standardExecutionAttachment.findMany({
            where: {
              enterpriseId,
              bizType: 'SUBMISSION',
              bizId: { in: submissionIds },
            },
            orderBy: { createdAt: 'asc' },
          })
        : []
      const attachmentsBySubmission = new Map<string, typeof attachments>()
      for (const attachment of attachments) {
        const list = attachmentsBySubmission.get(attachment.bizId) || []
        list.push(attachment)
        attachmentsBySubmission.set(attachment.bizId, list)
      }

      const now = Date.now()
      const isOverdue =
        task.status === 'PUBLISHED' &&
        !!task.deadlineAt &&
        task.deadlineAt.getTime() < now &&
        myAssignee.status !== 'COMPLETED'

      res.json({
        data: {
          task: {
            id: task.id,
            title: task.title,
            description: task.description,
            taskType: task.taskType,
            submitRequirement: task.submitRequirement,
            deadlineAt: task.deadlineAt,
            status: task.status,
            reviewerId: task.reviewerId,
            publishedAt: task.publishedAt,
            completedAt: task.completedAt,
            checklistSchema: task.checklistSchema,
            parametersSchema: task.parametersSchema,
            learningMaterials: task.learningMaterials,
            quizBankId: task.quizBankId,
            submitFormConfig: buildSubmitFormConfig({
              taskType: task.taskType,
              checklistSchema: task.checklistSchema,
              parametersSchema: task.parametersSchema,
              learningMaterials: task.learningMaterials,
              quizBankId: task.quizBankId,
              taskItemCount: task.items.length,
            }),
            basisSnapshots: task.basisSnapshots,
          },
          requirement: task.requirement,
          // 关联控制点（新模型 TaskItem 列表；旧模型用 requirement 单条）
          taskItems: task.items.map((it) => ({
            id: it.id,
            status: it.status,
            requirement: it.requirement,
          })),
          myAssignee: {
            id: myAssignee.id,
            status: myAssignee.status,
            submittedAt: myAssignee.submittedAt,
            reviewedAt: myAssignee.reviewedAt,
          },
          mySubmissions: mySubmissions.map((submission) => ({
            ...submission,
            attachments: attachmentsBySubmission.get(submission.id) || [],
          })),
          isOverdue,
        },
      })
    },
  )

  // ─── 进入任务：PENDING → IN_PROGRESS ────────────────
  app.post(
    '/api/app/standard-execution/tasks/:id/view',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const taskId = String(req.params.id || '').trim()
      if (!taskId) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)

      const myAssignee = await prisma.standardExecutionTaskAssignee.findFirst({
        where: { taskId, enterpriseId, assigneeId: req.userId! },
        include: { task: { select: { status: true } } },
      })
      if (!myAssignee) return res.status(403).json({ error: '无权操作此任务' })

      // 任务审核通过并下发前不可操作；COMPLETED 允许调用 view，会落到下方 noop 分支。
      if (!(EMPLOYEE_OPERABLE_TASK_STATUSES as readonly string[]).includes(myAssignee.task.status) && myAssignee.task.status !== 'COMPLETED') {
        return res.status(409).json({ error: `任务当前状态 ${myAssignee.task.status} 不可操作` })
      }

      if (myAssignee.status !== 'PENDING') {
        return res.json({ data: { id: myAssignee.id, status: myAssignee.status }, noop: true })
      }

      const updated = await prisma.standardExecutionTaskAssignee.update({
        where: { id: myAssignee.id },
        data: { status: 'IN_PROGRESS' },
      })
      res.json({ data: { id: updated.id, status: updated.status } })
    },
  )

  // ─── Task Items 列表（员工本人 task）──────────────────
  app.get(
    '/api/app/standard-execution/tasks/:taskId/items',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const taskId = String(req.params.taskId || '').trim()
      if (!taskId) return badRequest(res, 'taskId 非法')
      const enterpriseId = getEnterpriseId(req as never)

      // 该 task 必须有 assignee=当前用户
      const myAssignee = await prisma.standardExecutionTaskAssignee.findFirst({
        where: { taskId, enterpriseId, assigneeId: req.userId! },
        include: { task: { select: { status: true } } },
      })
      if (!myAssignee) return res.status(403).json({ error: '无权查看此任务' })
      if (!(EMPLOYEE_VISIBLE_TASK_STATUSES as readonly string[]).includes(myAssignee.task.status)) {
        return res.status(404).json({ error: '任务不存在' })
      }

      const items = await prisma.standardExecutionTaskItem.findMany({
        where: { taskId },
        orderBy: { createdAt: 'asc' },
        include: {
          requirement: {
            select: { title: true, clauseNo: true, requirementText: true },
          },
        },
      })
      const progresses = items.length
        ? await prisma.standardExecutionTaskItemProgress.findMany({
            where: {
              enterpriseId,
              taskId,
              assigneeId: req.userId!,
              taskItemId: { in: items.map((item) => item.id) },
            },
          })
        : []
      const progressByItemId = new Map(progresses.map((p) => [p.taskItemId, p]))

      res.json({
        data: items.map((item) => {
          const progress = progressByItemId.get(item.id)
          return {
            id: item.id,
            taskId: item.taskId,
            requirementId: item.requirementId,
            status: progress?.status ?? 'PENDING',
            note: progress?.note ?? null,
            fileUrls: normalizeFileUrls(progress?.fileUrls),
            completedAt: progress?.completedAt ?? null,
            createdAt: item.createdAt,
            updatedAt: progress?.updatedAt ?? item.updatedAt,
            requirement: item.requirement,
          }
        }),
      })
    },
  )

  // ─── Task Item 暂存（PATCH）──────────────────────────
  app.patch(
    '/api/app/standard-execution/tasks/:taskId/items/:itemId',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const taskId = String(req.params.taskId || '').trim()
      const itemId = String(req.params.itemId || '').trim()
      if (!taskId || !itemId) return badRequest(res, 'taskId 或 itemId 非法')

      const parsed = TaskItemPatchSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }

      const enterpriseId = getEnterpriseId(req as never)

      // 该 task 必须有 assignee=当前用户
      const myAssignee = await prisma.standardExecutionTaskAssignee.findFirst({
        where: { taskId, enterpriseId, assigneeId: req.userId! },
        include: { task: { select: { status: true } } },
      })
      if (!myAssignee) return res.status(403).json({ error: '无权操作此任务' })
      if (!(EMPLOYEE_OPERABLE_TASK_STATUSES as readonly string[]).includes(myAssignee.task.status)) {
        return res.status(409).json({ error: `任务当前状态 ${myAssignee.task.status} 不可操作` })
      }

      // item 必须属于该 task
      const item = await prisma.standardExecutionTaskItem.findFirst({
        where: { id: itemId, taskId },
      })
      if (!item) return res.status(404).json({ error: 'TaskItem 不存在' })

      // 仅更新传入字段；写入当前执行人的 progress，不污染 TaskItem 模板项。
      const updateData: Record<string, unknown> = {}
      if (parsed.data.status !== undefined) updateData.status = parsed.data.status
      if (parsed.data.note !== undefined) updateData.note = parsed.data.note
      if (parsed.data.fileUrls !== undefined) {
        updateData.fileUrls = parsed.data.fileUrls === null ? Prisma.DbNull : parsed.data.fileUrls
      }

      const updated = await prisma.standardExecutionTaskItemProgress.upsert({
        where: { taskItemId_assigneeId: { taskItemId: itemId, assigneeId: req.userId! } },
        create: {
          enterpriseId,
          taskId,
          taskItemId: itemId,
          requirementId: item.requirementId,
          assigneeId: req.userId!,
          status: parsed.data.status ?? 'PENDING',
          note: parsed.data.note ?? null,
          fileUrls: parsed.data.fileUrls === undefined || parsed.data.fileUrls === null
            ? Prisma.DbNull
            : parsed.data.fileUrls,
        },
        update: updateData,
      })

      res.json({
        data: {
          id: item.id,
          taskId: item.taskId,
          requirementId: item.requirementId,
          status: updated.status,
          note: updated.note,
          fileUrls: normalizeFileUrls(updated.fileUrls),
          completedAt: updated.completedAt,
          createdAt: item.createdAt,
          updatedAt: updated.updatedAt,
        },
      })
    },
  )

  // ─── 我的完成记录 ─────────────────────────────────
  app.get(
    '/api/app/standard-execution/records',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const parsed = MpRecordListQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const { page, pageSize } = parsed.data
      const enterpriseId = getEnterpriseId(req as never)

      const where: Prisma.StandardExecutionRecordWhereInput = {
        enterpriseId,
        assigneeId: req.userId!,
        status: 'VALID',
      }

      const [data, total] = await Promise.all([
        prisma.standardExecutionRecord.findMany({
          where,
          orderBy: { recordDate: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.standardExecutionRecord.count({ where }),
      ])
      res.json({ data, total, page, pageSize })
    },
  )

  // ── 获取题目（员工答题前拉取，不含正确答案）──────────────────────────────
  app.get(
    '/api/app/standard-execution/tasks/:id/quiz',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const enterpriseId = getEnterpriseId(req as never)
      const taskId = String(req.params.id || '').trim()

      // 确认该员工被指派了这个任务
      const assignee = await prisma.standardExecutionTaskAssignee.findFirst({
        where: { taskId, assigneeId: req.userId!, enterpriseId },
      })
      if (!assignee) return res.status(403).json({ error: '无权访问' })

      const task = await prisma.standardExecutionTask.findFirst({
        where: { id: taskId, enterpriseId, deletedAt: null },
        select: { quizBankId: true },
      })
      if (!task?.quizBankId) return res.status(404).json({ error: '该任务未关联题库' })

      const bank = await prisma.sEQuestionBank.findFirst({
        where: { id: task.quizBankId, deletedAt: null },
      })
      if (!bank) return res.status(404).json({ error: '题库不存在' })

      // 返回题目时去掉 answer 和 exp（防止作弊）
      const questions = (bank.questions as Array<Record<string, unknown>>).map((q) => ({
        id: q.id,
        type: q.type,
        text: q.text,
        opts: q.opts,
        score: q.score,
        // answer 和 exp 不下发
      }))

      res.json({ quizBankId: bank.id, title: bank.title, questions })
    },
  )

  // ── 提交答题结果 ────────────────────────────────────────────────────────────
  app.post(
    '/api/app/standard-execution/tasks/:id/quiz/submit',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const enterpriseId = getEnterpriseId(req as never)
      const taskId = String(req.params.id || '').trim()

      const assignee = await prisma.standardExecutionTaskAssignee.findFirst({
        where: { taskId, assigneeId: req.userId!, enterpriseId },
      })
      if (!assignee) return res.status(403).json({ error: '无权访问' })

      // 校验 body
      const { answers: submittedAnswers, timeUsedSec } = req.body as {
        answers: Array<{ questionId: string; selected: number[] }>,
        timeUsedSec: number,
      }
      if (!Array.isArray(submittedAnswers) || typeof timeUsedSec !== 'number') {
        return res.status(400).json({ error: '参数格式错误' })
      }

      const task = await prisma.standardExecutionTask.findFirst({
        where: { id: taskId, enterpriseId, deletedAt: null },
        select: {
          quizBankId: true,
          requirementId: true,
          title: true,
          requirement: { select: { sourceId: true, title: true } },
        },
      })
      if (!task?.quizBankId) return res.status(404).json({ error: '该任务未关联题库' })

      const bank = await prisma.sEQuestionBank.findFirst({
        where: { id: task.quizBankId, deletedAt: null },
      })
      if (!bank) return res.status(404).json({ error: '题库不存在' })

      const questions = bank.questions as Array<{
        id: string; type: string; answer: number[]; score: number
      }>

      // 计算得分
      let score = 0
      let correctCount = 0
      const totalScore = questions.reduce((s, q) => s + q.score, 0)
      const resultAnswers: Array<{ questionId: string; selected: number[]; correct: boolean }> = []

      for (const q of questions) {
        const submitted = submittedAnswers.find((a) => a.questionId === q.id)
        const selected = submitted?.selected ?? []
        const correctSet = new Set(q.answer)
        const selectedSet = new Set(selected)
        const correct =
          correctSet.size === selectedSet.size &&
          [...correctSet].every((x) => selectedSet.has(x))
        if (correct) { score += q.score; correctCount++ }
        resultAnswers.push({ questionId: q.id, selected, correct })
      }

      const passed = totalScore > 0 && score / totalScore >= 0.6 // 60 分及格

      const result = await prisma.sEQuizResult.create({
        data: {
          enterpriseId,
          taskId,
          quizBankId: task.quizBankId,
          assigneeId: req.userId!,
          score,
          totalScore,
          correctCount,
          wrongCount: questions.length - correctCount,
          timeUsedSec: Math.round(timeUsedSec),
          answers: resultAnswers as never,
          passed,
        },
      })

      // 答题通过 → 直接判为通过完成，跳过人工审核：assignee COMPLETED + 建 submission(APPROVED) + Record(进证据库) + task 完成判定
      // 与人工审核 approve 终态一致（reviewRoutes）；APPROVED 是 submission 状态，assignee 终态是 COMPLETED
      if (passed) {
        let createdRecordId: string | null = null
        await prisma.$transaction(async (tx) => {
          const now = new Date()
          await tx.standardExecutionTaskAssignee.updateMany({
            where: { taskId, assigneeId: req.userId! },
            data: { status: 'COMPLETED', submittedAt: now, reviewedAt: now },
          })
          // 有关联要求项才生成 submission + Record（旧模型；新模型 TaskItem 任务一般不挂题库）
          if (task.requirementId && task.requirement) {
            const sub = await tx.standardExecutionSubmission.create({
              data: {
                enterpriseId,
                taskId,
                assigneeId: req.userId!,
                submitText: `答题考核通过：${score}/${totalScore} 分`,
                status: 'APPROVED',
                submittedAt: now,
                reviewedAt: now,
              },
            })
            const record = await tx.standardExecutionRecord.create({
              data: {
                enterpriseId,
                sourceId: task.requirement.sourceId,
                requirementId: task.requirementId,
                taskId,
                submissionId: sub.id,
                assigneeId: req.userId!,
                title: task.requirement.title || task.title,
                summary: `答题考核通过：${score}/${totalScore} 分`,
                status: 'VALID',
                createdFrom: 'QUIZ_PASS',
                recordDate: now,
              },
            })
            createdRecordId = record.id
          }
          // 同 task 所有 assignee 都 COMPLETED → task COMPLETED
          const remaining = await tx.standardExecutionTaskAssignee.count({
            where: { taskId, enterpriseId, status: { not: 'COMPLETED' } },
          })
          if (remaining === 0) {
            await tx.standardExecutionTask.update({
              where: { id: taskId },
              data: { status: 'COMPLETED', completedAt: now, updatedBy: req.userId! },
            })
          }
        })
        if (createdRecordId) enqueueRecordVectorIndex(createdRecordId)
      }

      // 返回正确答案让前端展示解析
      const correctAnswers = questions.map((q) => ({
        questionId: q.id,
        answer: q.answer,
        exp: (q as Record<string, unknown>).exp,
      }))

      res.json({ ...result, correctAnswers })
    },
  )
}
