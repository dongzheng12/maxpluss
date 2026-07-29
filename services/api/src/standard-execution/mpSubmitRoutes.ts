/**
 * 员工小程序端 — 文件上传 + 提交任务
 *
 *   POST /api/app/standard-execution/tasks/:id/upload  — multipart/form-data 单文件，返回 fileUrl
 *   POST /api/app/standard-execution/tasks/:id/submit  — body { submitText, attachments[] }
 *
 * 业务规则（doc §七.3 + §七.5）：
 *   - submitText 非空 + 至少 1 个附件
 *   - 任务 status ∈ {PUBLISHED, IN_PROGRESS, OVERDUE}（未审核/未下发/已关闭拒绝）
 *   - assignee.status ≠ COMPLETED
 *   - 重新提交：旧 isLatest=false，新 version=prev+1, isLatest=true, parentSubmissionId=prev.id
 *   - 事务：Submission + Attachment + Assignee.status=PENDING_REVIEW 原子写入
 *
 * 文件落盘：uploads/standard-execution/{taskId}/{userId}/{ts}-{rand}{ext}
 * 静态暴露由 main.ts 配置（/uploads/standard-execution）。
 *
 * @see 必读/02_技术架构.md §四.7 Submission + §七.4 SubmissionStatus（驳回后重新提交不覆盖旧版本，version+1）
 */
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Express, Response } from 'express'
import multer from 'multer'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { requireAuth, type AuthRequest } from '../auth.js'
import { getEnterpriseId, toPrismaJson } from './utils.js'
import { MpSubmitSchema } from './types.js'
import { EMPLOYEE_OPERABLE_TASK_STATUSES } from './taskApproval.js'

export const STANDARD_EXECUTION_UPLOAD_DIR = join(
  process.cwd(),
  'uploads',
  'standard-execution',
)
if (!existsSync(STANDARD_EXECUTION_UPLOAD_DIR)) {
  mkdirSync(STANDARD_EXECUTION_UPLOAD_DIR, { recursive: true })
}

const FILE_MAX = 50 * 1024 * 1024 // 50MB

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream', // 兜底（部分客户端 zip / docx 走这个）
])

function normalizeFileUrls(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function buildSubmitDataJsonWithTaskItems(
  items: Array<{ id: string; requirementId: string; status: string; note: string | null; fileUrls: unknown }>,
  progressByItemId: Map<string, { status: string; note: string | null; fileUrls: unknown }>,
  submittedData: Record<string, unknown> | undefined,
): Prisma.InputJsonValue {
  const itemSnapshots = items.map((item) => {
    const progress = progressByItemId.get(item.id)
    return {
      taskItemId: item.id,
      requirementId: item.requirementId,
      status: progress?.status ?? 'PENDING',
      note: progress?.note ?? null,
      fileUrls: normalizeFileUrls(progress?.fileUrls),
    }
  })
  return {
    ...(submittedData ?? {}),
    // Preserve the canonical TaskItem snapshot used by review -> record splitting.
    items: itemSnapshots,
  } as Prisma.InputJsonValue
}

function badRequest(res: Response, msg: string) {
  return res.status(400).json({ error: msg })
}

const uploadHandler = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const taskId = String((req.params as { id?: string }).id || 'unknown')
      const userId = (req as AuthRequest).userId || 'anon'
      const dir = join(STANDARD_EXECUTION_UPLOAD_DIR, taskId, userId)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (_req, file, cb) => {
      // utf8 文件名修复（与 expertVoteRoutes 同款）
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8')
      const ts = Date.now()
      const rand = Math.floor(Math.random() * 1e6).toString(36)
      const dotIdx = file.originalname.lastIndexOf('.')
      const ext = dotIdx > 0 ? file.originalname.slice(dotIdx) : ''
      cb(null, `${ts}-${rand}${ext}`)
    },
  }),
  limits: { fileSize: FILE_MAX },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('不支持的文件类型'))
    }
    cb(null, true)
  },
})

/**
 * 校验：assignee 必须存在（assigneeId=me）+ task 可提交（已下发/处理中/逾期）+ assignee 非 COMPLETED
 * 返回 { ok, status?, error? } — status 用于发送错误时拿到具体码
 */
async function loadAndCheckAssignee(req: AuthRequest, taskId: string) {
  const enterpriseId = getEnterpriseId(req as never)
  const assignee = await prisma.standardExecutionTaskAssignee.findFirst({
    where: { taskId, enterpriseId, assigneeId: req.userId! },
    include: { task: { select: { id: true, status: true, enterpriseId: true } } },
  })
  if (!assignee) return { ok: false as const, code: 403, msg: '无权操作此任务' }
  if (!(EMPLOYEE_OPERABLE_TASK_STATUSES as readonly string[]).includes(assignee.task.status)) {
    return { ok: false as const, code: 409, msg: `任务当前状态 ${assignee.task.status} 不可提交` }
  }
  if (assignee.status === 'COMPLETED') {
    return { ok: false as const, code: 409, msg: '任务已完成，不可重复提交' }
  }
  return { ok: true as const, assignee, enterpriseId }
}

export function registerStandardExecutionMpSubmitRoutes(app: Express) {
  // ─── 文件上传 ─────────────────────────────────────
  app.post(
    '/api/app/standard-execution/tasks/:id/upload',
    requireAuth as never,
    async (req: AuthRequest, res, next) => {
      const taskId = String(req.params.id || '').trim()
      if (!taskId) return badRequest(res, 'id 非法')
      // 上传前 assignee 校验（防匿名占磁盘）
      const check = await loadAndCheckAssignee(req, taskId)
      if (!check.ok) return res.status(check.code).json({ error: check.msg })
      next()
    },
    (req, res, next) =>
      uploadHandler.single('file')(req, res, (err: unknown) => {
        if (err) {
          const e = err as { message?: string; code?: string }
          if (e.message === 'File too large' || e.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: '文件超过单文件大小限制' })
          }
          return res.status(400).json({ error: e.message || '上传失败' })
        }
        next()
      }),
    (req: AuthRequest, res) => {
      const taskId = String(req.params.id || '').trim()
      const file = (req as AuthRequest & { file?: Express.Multer.File }).file
      if (!file) return badRequest(res, '缺少 file 字段')
      const fileUrl = `/uploads/standard-execution/${taskId}/${req.userId}/${file.filename}`
      res.json({
        data: {
          fileName: file.originalname,
          fileUrl,
          fileSize: file.size,
          mimeType: file.mimetype,
        },
      })
    },
  )

  // ─── 提交任务 ─────────────────────────────────────
  app.post(
    '/api/app/standard-execution/tasks/:id/submit',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const taskId = String(req.params.id || '').trim()
      if (!taskId) return badRequest(res, 'id 非法')

      const parsed = MpSubmitSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const check = await loadAndCheckAssignee(req, taskId)
      if (!check.ok) return res.status(check.code).json({ error: check.msg })
      const { assignee, enterpriseId } = check

      // 判断是否为新模型（TaskItem 路径）：task 有 planId 或有 TaskItem 行
      const taskMeta = await prisma.standardExecutionTask.findFirst({
        where: { id: taskId },
        select: { planId: true },
      })
      const existingItems = await prisma.standardExecutionTaskItem.findMany({
        where: { taskId },
        select: { id: true, requirementId: true, status: true, note: true, fileUrls: true },
      })
      const isTaskItemMode = (taskMeta?.planId != null) || existingItems.length > 0
      const existingProgresses = isTaskItemMode && existingItems.length > 0
        ? await prisma.standardExecutionTaskItemProgress.findMany({
            where: {
              enterpriseId,
              taskId,
              assigneeId: req.userId!,
              taskItemId: { in: existingItems.map((item) => item.id) },
            },
          })
        : []
      const progressByItemId = new Map(existingProgresses.map((p) => [p.taskItemId, p]))

      // doc §七.5 重新提交：旧 isLatest=false，新 version=prev+1
      const result = await prisma.$transaction(async (tx) => {
        const prev = await tx.standardExecutionSubmission.findFirst({
          where: {
            taskId,
            enterpriseId,
            assigneeId: req.userId!,
            isLatest: true,
          },
          orderBy: { version: 'desc' },
          select: { id: true, version: true },
        })

        if (prev) {
          await tx.standardExecutionSubmission.update({
            where: { id: prev.id },
            data: { isLatest: false },
          })
        }

        // 新模型：submitDataJson 写入"当前执行人"的 item progress 快照
        let submitDataJson: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull
        if (isTaskItemMode && existingItems.length > 0) {
          const now = new Date()
          for (const progress of existingProgresses) {
            if (progress.status === 'PENDING') continue
            await tx.standardExecutionTaskItemProgress.update({
              where: { id: progress.id },
              data: { completedAt: now },
            })
          }
          submitDataJson = buildSubmitDataJsonWithTaskItems(existingItems, progressByItemId, parsed.data.submitDataJson)
        } else if (parsed.data.submitDataJson !== undefined) {
          submitDataJson = toPrismaJson(parsed.data.submitDataJson)
        }

        const submission = await tx.standardExecutionSubmission.create({
          data: {
            enterpriseId,
            taskId,
            assigneeId: req.userId!,
            submitText: parsed.data.submitText,
            submitDataJson,
            status: 'SUBMITTED',
            version: (prev?.version ?? 0) + 1,
            isLatest: true,
            parentSubmissionId: prev?.id ?? null,
            submittedAt: new Date(),
          },
        })

        await tx.standardExecutionAttachment.createMany({
          data: parsed.data.attachments.map((a) => ({
            enterpriseId,
            bizType: 'SUBMISSION',
            bizId: submission.id,
            fileName: a.fileName,
            fileUrl: a.fileUrl,
            fileSize: a.fileSize ?? null,
            mimeType: a.mimeType ?? null,
            uploadedBy: req.userId!,
          })),
        })

        await tx.standardExecutionTaskAssignee.update({
          where: { id: assignee.id },
          data: {
            status: 'PENDING_REVIEW',
            submittedAt: new Date(),
          },
        })

        return submission
      })

      // 附带返回新建附件，方便前端立即渲染
      const attachments = await prisma.standardExecutionAttachment.findMany({
        where: { bizType: 'SUBMISSION', bizId: result.id },
        orderBy: { createdAt: 'asc' },
      })

      res.status(201).json({ data: { ...result, attachments } })
    },
  )
}
