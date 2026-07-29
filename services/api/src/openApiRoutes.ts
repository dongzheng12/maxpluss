import type { Express, NextFunction, Request, Response } from 'express'
import crypto from 'crypto'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from './db.js'
import { requireAuth, type AuthRequest } from './auth.js'
import { logger } from './logger.js'
import { enqueueRecordVectorIndex } from './vectorIndexWorker.js'

const API_KEY_PREFIX = 'bxz_live_'
const WEBHOOK_SECRET_PREFIX = 'whsec_'
const OPEN_API_SCOPES = ['records:write', 'tasks:read', 'webhooks:manage'] as const
const WEBHOOK_EVENTS = ['task.completed', 'record.created', 'review.approved', 'record.expiring'] as const
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 100

type OpenApiScope = (typeof OPEN_API_SCOPES)[number]
type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]
type WebhookSender = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number }>

type OpenApiContext = {
  apiKeyId: string
  keyName: string
  enterpriseId: string
  scopes: string[]
}

type OpenApiRequest = Request & {
  openApi?: OpenApiContext
}

const ApiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(OPEN_API_SCOPES)).min(1),
  expiresAt: z.coerce.date().optional().nullable(),
})

const WebhookCreateSchema = z.object({
  url: z.string().trim().url().max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
})

const WebhookUpdateSchema = z.object({
  url: z.string().trim().url().max(500).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  isActive: z.boolean().optional(),
})

const OpenRecordPushSchema = z.object({
  requirementId: z.string().trim().optional(),
  sourceNo: z.string().trim().optional(),
  clauseNo: z.string().trim().optional(),
  executorName: z.string().trim().min(1).max(80),
  executedAt: z.coerce.date().optional(),
  summary: z.string().trim().min(1).max(4000),
  fileUrls: z.array(z.string().trim().max(500)).max(20).optional().default([]),
}).refine((value) => value.requirementId || (value.sourceNo && value.clauseNo), {
  message: '必须提供 requirementId，或同时提供 sourceNo + clauseNo',
})

const OpenTasksQuerySchema = z.object({
  status: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const rateBuckets = new Map<string, { windowStart: number; count: number }>()

export function __resetOpenApiRateLimit() {
  rateBuckets.clear()
}

function hashApiKey(key: string) {
  return crypto.createHash('sha256').update(key).digest('hex')
}

function randomToken(prefix: string, bytes = 24) {
  return `${prefix}${crypto.randomBytes(bytes).toString('base64url')}`
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function isExpired(expiresAt: Date | null) {
  return !!expiresAt && expiresAt.getTime() <= Date.now()
}

function checkRateLimit(apiKeyId: string) {
  const now = Date.now()
  const bucket = rateBuckets.get(apiKeyId)
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(apiKeyId, { windowStart: now, count: 1 })
    return true
  }
  bucket.count += 1
  return bucket.count <= RATE_LIMIT_MAX
}

async function resolveEnterpriseAdmin(req: AuthRequest, res: Response): Promise<string | null> {
  if (req.userRole === 'admin') return req.userEnterpriseId || 'DEFAULT'
  const user = await prisma.appUser.findUnique({
    where: { id: req.userId! },
    select: { enterpriseId: true, enterpriseRole: true },
  })
  if (!user?.enterpriseId || user.enterpriseRole !== 'ADMIN') {
    res.status(403).json({ error: '仅企业 ADMIN 可管理开放 API' })
    return null
  }
  return user.enterpriseId
}

function requireOpenApiKey(req: OpenApiRequest, res: Response, next: NextFunction) {
  void (async () => {
    const auth = req.headers.authorization || ''
    const match = auth.match(/^Bearer\s+(.+)$/i)
    if (!match) return res.status(401).json({ error: '缺少 API Key' })
    const key = match[1].trim()
    const apiKey = await prisma.enterpriseApiKey.findUnique({ where: { keyHash: hashApiKey(key) } })
    if (!apiKey || !apiKey.isActive || isExpired(apiKey.expiresAt)) {
      return res.status(403).json({ error: 'API Key 无效或已过期' })
    }
    if (!checkRateLimit(apiKey.id)) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' })
    }
    req.openApi = {
      apiKeyId: apiKey.id,
      keyName: apiKey.name,
      enterpriseId: apiKey.enterpriseId,
      scopes: jsonStringArray(apiKey.scopes),
    }
    res.on('finish', () => {
      prisma.enterpriseApiAccessLog.create({
        data: {
          enterpriseId: apiKey.enterpriseId,
          apiKeyId: apiKey.id,
          keyName: apiKey.name,
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
        },
      }).catch((err) => logger.warn({ err }, '[open-api] access log failed'))
    })
    await prisma.enterpriseApiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    next()
  })().catch(next)
}

function requireScope(scope: OpenApiScope) {
  return (req: OpenApiRequest, res: Response, next: NextFunction) => {
    if (!req.openApi?.scopes.includes(scope)) return res.status(403).json({ error: `缺少 scope：${scope}` })
    next()
  }
}

const defaultWebhookSender: WebhookSender = async (url, body, headers) => {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  })
  return { status: response.status }
}

export async function emitEnterpriseWebhook(
  enterpriseId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
  sender: WebhookSender = defaultWebhookSender,
) {
  const webhooks = await prisma.enterpriseWebhook.findMany({
    where: { enterpriseId, isActive: true },
  })
  const targets = webhooks.filter((webhook) => jsonStringArray(webhook.events).includes(event))
  const payload = {
    event,
    enterpriseId,
    occurredAt: new Date().toISOString(),
    data,
  }
  const body = JSON.stringify(payload)

  for (const webhook of targets) {
    const delivery = await prisma.enterpriseWebhookDelivery.create({
      data: {
        enterpriseId,
        webhookId: webhook.id,
        event,
        payload: payload as Prisma.InputJsonValue,
      },
    })
    let lastError: string | null = null
    let responseStatus: number | null = null
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const signature = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex')
        const response = await sender(webhook.url, body, {
          'Content-Type': 'application/json',
          'X-BXZ-Event': event,
          'X-BXZ-Signature': `sha256=${signature}`,
        })
        responseStatus = response.status
        if (response.status >= 200 && response.status < 300) {
          await prisma.enterpriseWebhookDelivery.update({
            where: { id: delivery.id },
            data: { status: 'SUCCESS', attempts: attempt, responseStatus, sentAt: new Date(), lastError: null },
          })
          await prisma.enterpriseWebhook.update({ where: { id: webhook.id }, data: { lastTriggeredAt: new Date() } })
          lastError = null
          break
        }
        lastError = `HTTP ${response.status}`
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'Webhook 发送失败'
      }
    }
    if (lastError) {
      await prisma.enterpriseWebhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', attempts: 3, responseStatus, lastError, sentAt: new Date() },
      })
    }
  }
}

function attachmentFileName(fileUrl: string) {
  try {
    return decodeURIComponent(fileUrl.split('/').filter(Boolean).pop() || 'external-file')
  } catch {
    return 'external-file'
  }
}

export function registerOpenApiRoutes(app: Express, options: { webhookSender?: WebhookSender } = {}) {
  const webhookSender = options.webhookSender || defaultWebhookSender

  app.get('/api/enterprise/open-api/keys', requireAuth as never, async (req: AuthRequest, res) => {
    const enterpriseId = await resolveEnterpriseAdmin(req, res)
    if (!enterpriseId) return
    const data = await prisma.enterpriseApiKey.findMany({
      where: { enterpriseId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, scopes: true, lastUsedAt: true, expiresAt: true, isActive: true, createdAt: true, revokedAt: true },
    })
    res.json({ data })
  })

  app.post('/api/enterprise/open-api/keys', requireAuth as never, async (req: AuthRequest, res) => {
    const parsed = ApiKeyCreateSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const enterpriseId = await resolveEnterpriseAdmin(req, res)
    if (!enterpriseId) return
    const plainKey = randomToken(API_KEY_PREFIX, 32)
    const data = await prisma.enterpriseApiKey.create({
      data: {
        enterpriseId,
        name: parsed.data.name,
        scopes: parsed.data.scopes,
        expiresAt: parsed.data.expiresAt ?? null,
        keyHash: hashApiKey(plainKey),
        createdBy: req.userId!,
      },
      select: { id: true, name: true, scopes: true, lastUsedAt: true, expiresAt: true, isActive: true, createdAt: true, revokedAt: true },
    })
    res.status(201).json({ data, plainKey })
  })

  app.delete('/api/enterprise/open-api/keys/:id', requireAuth as never, async (req: AuthRequest, res) => {
    const enterpriseId = await resolveEnterpriseAdmin(req, res)
    if (!enterpriseId) return
    const id = String(req.params.id || '')
    const result = await prisma.enterpriseApiKey.updateMany({
      where: { id, enterpriseId },
      data: { isActive: false, revokedAt: new Date() },
    })
    if (result.count === 0) return res.status(404).json({ error: 'API Key 不存在' })
    res.json({ ok: true })
  })

  app.get('/api/enterprise/open-api/webhooks', requireAuth as never, async (req: AuthRequest, res) => {
    const enterpriseId = await resolveEnterpriseAdmin(req, res)
    if (!enterpriseId) return
    const data = await prisma.enterpriseWebhook.findMany({
      where: { enterpriseId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, url: true, events: true, isActive: true, lastTriggeredAt: true, createdAt: true, updatedAt: true },
    })
    res.json({ data })
  })

  app.post('/api/enterprise/open-api/webhooks', requireAuth as never, async (req: AuthRequest, res) => {
    const parsed = WebhookCreateSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const enterpriseId = await resolveEnterpriseAdmin(req, res)
    if (!enterpriseId) return
    const secret = randomToken(WEBHOOK_SECRET_PREFIX, 24)
    const data = await prisma.enterpriseWebhook.create({
      data: {
        enterpriseId,
        url: parsed.data.url,
        events: parsed.data.events,
        secret,
        createdBy: req.userId!,
      },
      select: { id: true, url: true, events: true, isActive: true, lastTriggeredAt: true, createdAt: true, updatedAt: true },
    })
    res.status(201).json({ data, secret })
  })

  app.patch('/api/enterprise/open-api/webhooks/:id', requireAuth as never, async (req: AuthRequest, res) => {
    const parsed = WebhookUpdateSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const enterpriseId = await resolveEnterpriseAdmin(req, res)
    if (!enterpriseId) return
    const id = String(req.params.id || '')
    const result = await prisma.enterpriseWebhook.updateMany({
      where: { id, enterpriseId },
      data: parsed.data,
    })
    if (result.count === 0) return res.status(404).json({ error: 'Webhook 不存在' })
    const data = await prisma.enterpriseWebhook.findUnique({ where: { id }, select: { id: true, url: true, events: true, isActive: true, lastTriggeredAt: true, createdAt: true, updatedAt: true } })
    res.json({ data })
  })

  app.delete('/api/enterprise/open-api/webhooks/:id', requireAuth as never, async (req: AuthRequest, res) => {
    const enterpriseId = await resolveEnterpriseAdmin(req, res)
    if (!enterpriseId) return
    const id = String(req.params.id || '')
    const result = await prisma.enterpriseWebhook.updateMany({
      where: { id, enterpriseId },
      data: { isActive: false },
    })
    if (result.count === 0) return res.status(404).json({ error: 'Webhook 不存在' })
    res.json({ ok: true })
  })

  app.get('/api/open/v1/health', requireOpenApiKey, (req: OpenApiRequest, res) => {
    res.json({ ok: true, enterpriseId: req.openApi!.enterpriseId, keyName: req.openApi!.keyName, now: new Date().toISOString() })
  })

  app.get('/api/open/v1/tasks', requireOpenApiKey, requireScope('tasks:read'), async (req: OpenApiRequest, res) => {
    const parsed = OpenTasksQuerySchema.safeParse(req.query)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const where: Prisma.StandardExecutionTaskWhereInput = { enterpriseId: req.openApi!.enterpriseId, deletedAt: null }
    if (parsed.data.status) where.status = parsed.data.status
    const data = await prisma.standardExecutionTask.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parsed.data.limit,
      select: {
        id: true,
        requirementId: true,
        title: true,
        status: true,
        taskType: true,
        deadlineAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    res.json({ data })
  })

  app.post('/api/open/v1/records', requireOpenApiKey, requireScope('records:write'), async (req: OpenApiRequest, res) => {
    const parsed = OpenRecordPushSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const enterpriseId = req.openApi!.enterpriseId
    const requirement = parsed.data.requirementId
      ? await prisma.standardExecutionRequirement.findFirst({
        where: { id: parsed.data.requirementId, enterpriseId, status: 'ACTIVE' },
        include: { source: true },
      })
      : await prisma.standardExecutionRequirement.findFirst({
        where: {
          enterpriseId,
          status: 'ACTIVE',
          clauseNo: parsed.data.clauseNo,
          source: { sourceNo: parsed.data.sourceNo },
        },
        include: { source: true },
      })
    if (!requirement) return res.status(404).json({ error: '控制点不存在或不可用' })

    const executedAt = parsed.data.executedAt ?? new Date()
    const externalAssigneeId = `external:${parsed.data.executorName}`
    const result = await prisma.$transaction(async (tx) => {
      const task = await tx.standardExecutionTask.create({
        data: {
          enterpriseId,
          requirementId: requirement.id,
          title: `外部推送：${requirement.title}`,
          description: parsed.data.summary.slice(0, 2000),
          taskType: 'EXTERNAL_PUSH',
          submitRequirement: '外部系统推送执行数据',
          deadlineAt: executedAt,
          reviewerId: null,
          status: 'COMPLETED',
          publishedAt: executedAt,
          completedAt: executedAt,
          createdBy: `OPEN_API:${req.openApi!.apiKeyId}`,
        },
      })
      const submission = await tx.standardExecutionSubmission.create({
        data: {
          enterpriseId,
          taskId: task.id,
          assigneeId: externalAssigneeId,
          submitText: parsed.data.summary,
          status: 'APPROVED',
          version: 1,
          isLatest: true,
          submittedAt: executedAt,
          reviewedAt: executedAt,
          reviewerId: `OPEN_API:${req.openApi!.apiKeyId}`,
        },
      })
      const record = await tx.standardExecutionRecord.create({
        data: {
          enterpriseId,
          sourceId: requirement.sourceId,
          requirementId: requirement.id,
          taskId: task.id,
          submissionId: submission.id,
          assigneeId: externalAssigneeId,
          title: requirement.title,
          summary: parsed.data.summary,
          recordDate: executedAt,
          status: 'VALID',
          createdFrom: 'EXTERNAL_PUSH',
        },
      })
      if (parsed.data.fileUrls.length > 0) {
        await tx.standardExecutionAttachment.createMany({
          data: parsed.data.fileUrls.map((fileUrl) => ({
            enterpriseId,
            bizType: 'SUBMISSION',
            bizId: submission.id,
            fileName: attachmentFileName(fileUrl),
            fileUrl,
            uploadedBy: `OPEN_API:${req.openApi!.apiKeyId}`,
          })),
        })
      }
      return { task, submission, record }
    })

    void emitEnterpriseWebhook(enterpriseId, 'review.approved', {
      submissionId: result.submission.id,
      taskId: result.task.id,
      requirementId: requirement.id,
    }, webhookSender).catch((err) => logger.warn({ err }, '[open-api] review.approved webhook failed'))
    void emitEnterpriseWebhook(enterpriseId, 'task.completed', {
      taskId: result.task.id,
      requirementId: requirement.id,
      completedAt: result.task.completedAt?.toISOString() ?? executedAt.toISOString(),
    }, webhookSender).catch((err) => logger.warn({ err }, '[open-api] task.completed webhook failed'))
    void emitEnterpriseWebhook(enterpriseId, 'record.created', {
      recordId: result.record.id,
      taskId: result.task.id,
      requirementId: requirement.id,
      sourceId: requirement.sourceId,
    }, webhookSender).catch((err) => logger.warn({ err }, '[open-api] record.created webhook failed'))
    enqueueRecordVectorIndex(result.record.id)

    res.status(201).json({
      data: {
        recordId: result.record.id,
        taskId: result.task.id,
        submissionId: result.submission.id,
        requirementId: requirement.id,
        sourceId: requirement.sourceId,
      },
    })
  })
}
