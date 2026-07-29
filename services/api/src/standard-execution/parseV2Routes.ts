import type { Express, Response } from 'express'
import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { prisma as defaultPrisma } from '../db.js'
import { requireAdmin, type AuthRequest } from '../auth.js'
import { logger } from '../logger.js'
import { getEnterpriseId } from './utils.js'
import {
  parseStandardV2 as defaultParseStandardV2,
  synthesizeParseV2Chunk,
  type ParseStandardV2Options,
  type ParseV2ChunkCache,
  type ParseV2RequirementDraft,
  type ParseV2Result,
  type SourceForParseV2,
} from './parseAiV2.js'
import { callStandardAI } from './aiClient.js'
import { createEmbedClient, type EmbedClient } from './embedClient.js'
import { createQdrantClient, type QdrantClient } from './qdrantClient.js'
import { createSearchClient, type SearchClient } from './searchClient.js'

type ParseJobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED'

export interface ParseV2RouteDeps {
  prisma?: PrismaClient
  parseStandardV2?: (source: SourceForParseV2, options?: ParseStandardV2Options) => Promise<ParseV2Result>
  aiCaller?: (prompt: string) => Promise<string>
  embedClient?: EmbedClient
  qdrantClient?: Pick<QdrantClient, 'search'>
  searchClient?: SearchClient
  timeoutMs?: number
}

let depsOverride: ParseV2RouteDeps | null = null
const activeJobCreates = new Map<string, Promise<Awaited<ReturnType<typeof createOrReuseParseJob>>>>()

export function __setParseV2RouteDepsForTest(deps: ParseV2RouteDeps | null) {
  depsOverride = deps
}

function badRequest(res: Response, msg: string) {
  return res.status(400).json({ error: msg })
}

function deps(input: ParseV2RouteDeps = {}) {
  return {
    prisma: input.prisma ?? depsOverride?.prisma ?? defaultPrisma,
    parseStandardV2: input.parseStandardV2 ?? depsOverride?.parseStandardV2 ?? defaultParseStandardV2,
    aiCaller: input.aiCaller ?? depsOverride?.aiCaller ?? callStandardAI,
    embedClient: input.embedClient ?? depsOverride?.embedClient ?? createEmbedClient(),
    qdrantClient: input.qdrantClient ?? depsOverride?.qdrantClient ?? createQdrantClient(),
    searchClient: input.searchClient ?? depsOverride?.searchClient ?? createSearchClient(),
    timeoutMs: input.timeoutMs ?? depsOverride?.timeoutMs ?? 120_000,
  }
}

function serializeParseJob(job: {
  id: string
  sourceId: string
  status: string
  progress: number
  step: string | null
  result: Prisma.JsonValue | null
  errorMessage: string | null
  createdAt: Date
  updatedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}) {
  return {
    jobId: job.id,
    sourceId: job.sourceId,
    status: job.status,
    progress: job.progress,
    step: job.step,
    result: job.result,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  }
}

function asParseV2Result(value: unknown): ParseV2Result | null {
  const result = value as Partial<ParseV2Result> | null
  if (!result || result.version !== 'v2' || !Array.isArray(result.requirements)) return null
  return result as ParseV2Result
}

function parseChunkRef(sourceChunks: string[] | undefined): number | null {
  const raw = sourceChunks?.find((item) => /^chunk:\d+$/.test(item))
  if (!raw) return null
  const index = Number(raw.split(':')[1])
  return Number.isInteger(index) ? index : null
}

function findChunkCache(result: ParseV2Result, draft: ParseV2RequirementDraft): ParseV2ChunkCache | null {
  const chunkIndex = parseChunkRef(draft.sourceChunks)
  if (chunkIndex !== null) {
    return result.chunks?.find((cache) => cache.chunk.chunkIndex === chunkIndex) ?? null
  }
  if (draft.clauseNo) {
    return result.chunks?.find((cache) => cache.chunk.clauseNo === draft.clauseNo) ?? null
  }
  return null
}

function parseTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('PARSE_V2_TIMEOUT')), timeoutMs)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

async function updateJobProgress(
  db: PrismaClient,
  jobId: string,
  event: { step: string; progress: number },
) {
  try {
    await db.sEParseJob.update({
      where: { id: jobId },
      data: {
        step: event.step,
        progress: Math.min(99, Math.max(0, Math.floor(event.progress))),
      },
    })
  } catch (err) {
    logger.warn({ module: 'parse-v2-job', jobId, err }, 'parse v2 progress update failed')
  }
}

async function runParseJob(jobId: string, inputDeps: ParseV2RouteDeps = {}) {
  const d = deps(inputDeps)
  const db = d.prisma
  try {
    const job = await db.sEParseJob.findUnique({ where: { id: jobId } })
    if (!job || job.status !== 'QUEUED') return
    await db.sEParseJob.update({
      where: { id: jobId },
      data: {
        status: 'RUNNING',
        progress: 1,
        step: 'QUEUED',
        startedAt: new Date(),
      },
    })

    const source = await db.standardExecutionSource.findFirst({
      where: {
        id: job.sourceId,
        enterpriseId: job.enterpriseId,
      },
      select: {
        id: true,
        enterpriseId: true,
        title: true,
        sourceNo: true,
        rawText: true,
      },
    })
    if (!source) throw new Error('标准来源不存在或无权访问')

    const result = await parseTimeout(d.parseStandardV2(source, {
      aiCaller: d.aiCaller,
      embedClient: d.embedClient,
      qdrantClient: d.qdrantClient,
      searchClient: d.searchClient,
      onProgress: (event) => updateJobProgress(db, jobId, event),
    }), d.timeoutMs)

    await db.sEParseJob.update({
      where: { id: jobId },
      data: {
        status: 'DONE',
        progress: 100,
        step: 'DONE',
        result: result as unknown as Prisma.InputJsonValue,
        errorMessage: null,
        finishedAt: new Date(),
      },
    })
  } catch (err) {
    const message = err instanceof Error && err.message === 'PARSE_V2_TIMEOUT'
      ? '解析超时，请缩短标准文本或稍后重试'
      : (err instanceof Error ? err.message : '解析失败')
    logger.warn({ module: 'parse-v2-job', jobId, err }, 'parse v2 job failed')
    await db.sEParseJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        progress: 100,
        step: 'FAILED',
        errorMessage: message.slice(0, 500),
        finishedAt: new Date(),
      },
    }).catch((updateErr) => logger.warn({ module: 'parse-v2-job', jobId, updateErr }, 'parse v2 fail update failed'))
  }
}

async function findActiveJob(db: PrismaClient, enterpriseId: string, sourceId: string) {
  return db.sEParseJob.findFirst({
    where: {
      enterpriseId,
      sourceId,
      status: { in: ['QUEUED', 'RUNNING'] },
    },
    orderBy: { createdAt: 'desc' },
  })
}

async function createOrReuseParseJob(
  db: PrismaClient,
  input: {
    enterpriseId: string
    sourceId: string
    userId: string
  },
) {
  const active = await findActiveJob(db, input.enterpriseId, input.sourceId)
  if (active) return { job: active, reused: true }
  const job = await db.sEParseJob.create({
    data: {
      enterpriseId: input.enterpriseId,
      sourceId: input.sourceId,
      status: 'QUEUED',
      progress: 0,
      step: 'QUEUED',
      createdBy: input.userId,
    },
  })
  return { job, reused: false }
}

export function registerStandardExecutionParseV2Routes(app: Express) {
  app.post(
    '/api/admin/standard-execution/sources/:id/parse-v2',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const sourceId = String(req.params.id || '').trim()
      if (!sourceId) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)
      const d = deps()
      const source = await d.prisma.standardExecutionSource.findFirst({
        where: { id: sourceId, enterpriseId },
        select: { id: true, rawText: true },
      })
      if (!source) return res.status(404).json({ error: '标准来源不存在或无权访问' })
      if (!source.rawText?.trim()) return badRequest(res, '标准来源 rawText 为空，无法解析')

      const lockKey = `${enterpriseId}:${sourceId}`
      let creation = activeJobCreates.get(lockKey)
      const reusedByCreationLock = Boolean(creation)
      let shouldStartRunner = false
      if (!creation) {
        shouldStartRunner = true
        creation = createOrReuseParseJob(d.prisma, {
          enterpriseId,
          sourceId,
          userId: req.userId!,
        })
        activeJobCreates.set(lockKey, creation)
        void creation.finally(() => activeJobCreates.delete(lockKey)).catch(() => undefined)
      }
      const { job, reused } = await creation
      if (!reused && shouldStartRunner) void runParseJob(job.id)
      res.status(202).json({
        jobId: job.id,
        status: job.status as ParseJobStatus,
        progress: job.progress,
        reused: reused || reusedByCreationLock,
      })
    },
  )

  app.get(
    '/api/admin/standard-execution/parse-jobs/:jobId',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const jobId = String(req.params.jobId || '').trim()
      if (!jobId) return badRequest(res, 'jobId 非法')
      const enterpriseId = getEnterpriseId(req as never)
      const d = deps()
      const job = await d.prisma.sEParseJob.findFirst({
        where: { id: jobId, enterpriseId },
      })
      if (!job) return res.status(404).json({ error: '解析任务不存在或无权访问' })
      res.json(serializeParseJob(job))
    },
  )

  app.post(
    '/api/admin/standard-execution/parse-jobs/:jobId/requirements/:index/regenerate',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const jobId = String(req.params.jobId || '').trim()
      const index = Number(req.params.index)
      if (!jobId || !Number.isInteger(index) || index < 0) return badRequest(res, '参数非法')
      const enterpriseId = getEnterpriseId(req as never)
      const d = deps()
      const job = await d.prisma.sEParseJob.findFirst({
        where: { id: jobId, enterpriseId },
      })
      if (!job) return res.status(404).json({ error: '解析任务不存在或无权访问' })
      if (job.status !== 'DONE') return badRequest(res, '解析任务尚未完成，不能重新生成')
      const result = asParseV2Result(job.result)
      const current = result?.requirements[index]
      if (!result || !current) return badRequest(res, '解析结果不存在')
      const cache = findChunkCache(result, current)
      if (!cache) return badRequest(res, '当前解析任务缺少缓存上下文，无法单条重新生成')
      const source = await d.prisma.standardExecutionSource.findFirst({
        where: { id: job.sourceId, enterpriseId },
        select: {
          id: true,
          enterpriseId: true,
          title: true,
          sourceNo: true,
          rawText: true,
        },
      })
      if (!source) return res.status(404).json({ error: '标准来源不存在或无权访问' })
      try {
        const drafts = await synthesizeParseV2Chunk(source, cache, d.aiCaller)
        const nextDraft = drafts[0]
        if (!nextDraft) return badRequest(res, 'AI 未返回可用结果')
        const nextResult: ParseV2Result = {
          ...result,
          requirements: result.requirements.map((item, itemIndex) => itemIndex === index ? nextDraft : item),
          metadata: {
            ...result.metadata,
            generatedAt: new Date().toISOString(),
          },
        }
        await d.prisma.sEParseJob.update({
          where: { id: job.id },
          data: { result: nextResult as unknown as Prisma.InputJsonValue },
        })
        res.json({ data: nextDraft, result: nextResult })
      } catch (err) {
        const message = err instanceof Error ? err.message : '单条重新生成失败'
        logger.warn({ module: 'parse-v2-job', jobId, index, err }, 'parse v2 requirement regenerate failed')
        res.status(502).json({ error: message.slice(0, 500) })
      }
    },
  )
}
