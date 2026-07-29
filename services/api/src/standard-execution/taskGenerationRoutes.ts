import type { Express, RequestHandler, Response } from 'express'
import { requireAdmin, type AuthRequest } from '../auth.js'
import { getEnterpriseId } from './utils.js'
import {
  TaskGenerationCardRewriteSchema,
  TaskGenerationCardsRepolishSchema,
  TaskGenerationCommitSchema,
  TaskGenerationPreviewSchema,
  TaskGenerationReExtractSchema,
} from './types.js'
import {
  commitTaskGenerationDrafts,
  previewTaskGenerationDrafts,
  repolishTaskGenerationCards,
  reExtractTaskGenerationDrafts,
  rewriteTaskGenerationCard,
  type TaskGenerationContext,
} from './taskGenerationService.js'
import { classifyAiPreviewError } from './aiPreviewErrors.js'
import { getTaskGenerationRuntimeConfig } from './parseRuntimeConfig.js'
import {
  createTaskGenerationPreviewJob,
  getTaskGenerationPreviewJob,
  listTaskGenerationPreviewJobs,
  serializeTaskGenerationPreviewJob,
} from './taskGenerationJobStore.js'

function sendError(res: Response, err: unknown, fallback: string) {
  const e = err as { status?: number; message?: string }
  res.status(e.status || 500).json({ error: e.message || fallback })
}

function sendPreviewError(res: Response, err: unknown, fallback: string) {
  const payload = classifyAiPreviewError(err, fallback)
  res.status(payload.status).json(payload)
}

export function registerTaskGenerationRoutes(
  app: Express,
  options: {
    basePath: string
    middleware: RequestHandler
    resolveContext: (req: AuthRequest, res: Response) => Promise<TaskGenerationContext | null> | TaskGenerationContext | null
    aiCaller?: (prompt: string) => Promise<string>
  },
) {
  app.get(
    `${options.basePath}/config`,
    options.middleware,
    async (_req: AuthRequest, res) => {
      res.json({ data: getTaskGenerationRuntimeConfig() })
    },
  )

  app.post(
    `${options.basePath}/preview`,
    options.middleware,
    async (req: AuthRequest, res) => {
      const parsed = TaskGenerationPreviewSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      try {
        const ctx = await options.resolveContext(req, res)
        if (!ctx) return
        const data = await previewTaskGenerationDrafts(ctx, parsed.data, options.aiCaller)
        res.json({ data })
      } catch (err) {
        sendPreviewError(res, err, '任务草稿预览失败')
      }
    },
  )

  app.post(
    `${options.basePath}/preview/jobs`,
    options.middleware,
    async (req: AuthRequest, res) => {
      const parsed = TaskGenerationPreviewSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      try {
        const ctx = await options.resolveContext(req, res)
        if (!ctx) return
        const job = createTaskGenerationPreviewJob(ctx, parsed.data, options.aiCaller)
        res.status(202).json({ data: serializeTaskGenerationPreviewJob(job) })
      } catch (err) {
        sendPreviewError(res, err, '任务草稿异步解析启动失败')
      }
    },
  )

  app.get(
    `${options.basePath}/preview/jobs`,
    options.middleware,
    async (req: AuthRequest, res) => {
      try {
        const ctx = await options.resolveContext(req, res)
        if (!ctx) return
        const rawSourceId = Array.isArray(req.query.sourceId) ? req.query.sourceId[0] : req.query.sourceId
        const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit
        const limit = rawLimit ? Number(rawLimit) : undefined
        const jobs = listTaskGenerationPreviewJobs(ctx, {
          sourceId: typeof rawSourceId === 'string' && rawSourceId.trim() ? rawSourceId.trim() : undefined,
          limit: Number.isFinite(limit) ? limit : undefined,
        })
        res.json({ data: jobs.map(serializeTaskGenerationPreviewJob) })
      } catch (err) {
        sendError(res, err, '任务草稿异步解析列表查询失败')
      }
    },
  )

  app.get(
    `${options.basePath}/preview/jobs/:jobId`,
    options.middleware,
    async (req: AuthRequest, res) => {
      try {
        const ctx = await options.resolveContext(req, res)
        if (!ctx) return
        const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
        const job = getTaskGenerationPreviewJob(ctx, jobId)
        if (!job) return res.status(404).json({ error: '异步解析任务不存在或无权访问' })
        res.json({ data: serializeTaskGenerationPreviewJob(job) })
      } catch (err) {
        sendError(res, err, '任务草稿异步解析查询失败')
      }
    },
  )

  app.post(
    `${options.basePath}/card-rewrite`,
    options.middleware,
    async (req: AuthRequest, res) => {
      const parsed = TaskGenerationCardRewriteSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      try {
        const ctx = await options.resolveContext(req, res)
        if (!ctx) return
        const data = await rewriteTaskGenerationCard(ctx, parsed.data, options.aiCaller)
        res.json({ data })
      } catch (err) {
        sendPreviewError(res, err, '任务卡 AI 重写失败')
      }
    },
  )

  app.post(
    `${options.basePath}/cards/repolish`,
    options.middleware,
    async (req: AuthRequest, res) => {
      const parsed = TaskGenerationCardsRepolishSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      try {
        const ctx = await options.resolveContext(req, res)
        if (!ctx) return
        const data = await repolishTaskGenerationCards(ctx, parsed.data, options.aiCaller)
        res.json({ data })
      } catch (err) {
        sendPreviewError(res, err, '任务卡批量重润色失败')
      }
    },
  )

  app.post(
    `${options.basePath}/re-extract`,
    options.middleware,
    async (req: AuthRequest, res) => {
      const parsed = TaskGenerationReExtractSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      try {
        const ctx = await options.resolveContext(req, res)
        if (!ctx) return
        const data = await reExtractTaskGenerationDrafts(ctx, parsed.data, options.aiCaller)
        res.json({ data })
      } catch (err) {
        sendPreviewError(res, err, '任务草稿重新提取失败')
      }
    },
  )

  app.post(
    `${options.basePath}/commit`,
    options.middleware,
    async (req: AuthRequest, res) => {
      const parsed = TaskGenerationCommitSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      try {
        const ctx = await options.resolveContext(req, res)
        if (!ctx) return
        const data = await commitTaskGenerationDrafts(ctx, parsed.data)
        res.status(201).json({ data })
      } catch (err) {
        sendError(res, err, '任务草稿提交失败')
      }
    },
  )
}

export function registerStandardExecutionTaskGenerationRoutes(app: Express) {
  registerTaskGenerationRoutes(app, {
    basePath: '/api/admin/standard-execution/task-generation',
    middleware: requireAdmin as never,
    resolveContext: (req: AuthRequest) => ({
      enterpriseId: getEnterpriseId(req as never),
      userId: req.userId!,
      scope: 'admin',
    }),
  })
}
