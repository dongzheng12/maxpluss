import { randomUUID } from 'crypto'
import {
  previewTaskGenerationDrafts,
  type TaskGenerationContext,
} from './taskGenerationService.js'
import type { TaskGenerationPreviewInput } from './types.js'

type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

interface TaskGenerationPreviewJob {
  id: string
  enterpriseId: string
  userId: string
  scope: TaskGenerationContext['scope']
  status: JobStatus
  input: TaskGenerationPreviewInput
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  result: unknown | null
  error: { message: string; status: number } | null
}

const JOB_TTL_MS = 30 * 60 * 1000
const MAX_JOBS = 200
const jobs = new Map<string, TaskGenerationPreviewJob>()

function nowIso() {
  return new Date().toISOString()
}

function pruneJobs() {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (now - Date.parse(job.createdAt) > JOB_TTL_MS) jobs.delete(id)
  }
  if (jobs.size <= MAX_JOBS) return
  const sorted = [...jobs.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  for (const job of sorted.slice(0, jobs.size - MAX_JOBS)) jobs.delete(job.id)
}

function serializeError(err: unknown) {
  const e = err as { status?: number; message?: string }
  return {
    status: e.status || 500,
    message: e.message || '任务草稿异步解析失败',
  }
}

export function serializeTaskGenerationPreviewJob(job: TaskGenerationPreviewJob) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.result,
    error: job.error,
    volatile: true,
  }
}

export function createTaskGenerationPreviewJob(
  ctx: TaskGenerationContext,
  input: TaskGenerationPreviewInput,
  aiCaller?: (prompt: string) => Promise<string>,
) {
  pruneJobs()
  const ts = nowIso()
  const job: TaskGenerationPreviewJob = {
    id: randomUUID(),
    enterpriseId: ctx.enterpriseId,
    userId: ctx.userId,
    scope: ctx.scope,
    status: 'QUEUED',
    input,
    createdAt: ts,
    updatedAt: ts,
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  }
  jobs.set(job.id, job)

  void Promise.resolve().then(async () => {
    job.status = 'RUNNING'
    job.startedAt = nowIso()
    job.updatedAt = job.startedAt
    try {
      job.result = await previewTaskGenerationDrafts(ctx, input, aiCaller)
      job.status = 'SUCCEEDED'
    } catch (err) {
      job.error = serializeError(err)
      job.status = 'FAILED'
    } finally {
      job.finishedAt = nowIso()
      job.updatedAt = job.finishedAt
    }
  })

  return job
}

export function getTaskGenerationPreviewJob(ctx: TaskGenerationContext, jobId: string) {
  pruneJobs()
  const job = jobs.get(jobId)
  if (!job) return null
  if (job.enterpriseId !== ctx.enterpriseId) return null
  if (job.scope !== ctx.scope && ctx.scope !== 'admin') return null
  return job
}

export function listTaskGenerationPreviewJobs(
  ctx: TaskGenerationContext,
  options: { sourceId?: string; limit?: number } = {},
) {
  pruneJobs()
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 20)
  return [...jobs.values()]
    .filter((job) => {
      if (job.enterpriseId !== ctx.enterpriseId) return false
      if (job.scope !== ctx.scope && ctx.scope !== 'admin') return false
      if (job.userId !== ctx.userId) return false
      if (options.sourceId && job.input.sourceId !== options.sourceId) return false
      return true
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit)
}

export function clearTaskGenerationPreviewJobsForTests() {
  jobs.clear()
}
