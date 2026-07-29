import crypto from 'crypto'
import type { PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from './db.js'
import { logger } from './logger.js'
import { createEmbedClient, type EmbedClient, MAX_EMBED_BATCH_SIZE } from './standard-execution/embedClient.js'
import { segmentClausesByRule } from './standard-execution/clauseSegment.js'
import { createQdrantClient, type QdrantClient, type VectorCollection, type VectorPoint } from './standard-execution/qdrantClient.js'

type TargetType = 'SOURCE_CLAUSE' | 'REQUIREMENT' | 'RECORD'

export type VectorIndexStats = {
  scanned: number
  indexed: number
  skipped: number
  failed: number
}

export type VectorIndexDeps = {
  prisma?: PrismaClient
  embedClient?: EmbedClient
  qdrantClient?: QdrantClient
}

type IndexCandidate = {
  collection: VectorCollection
  targetType: TargetType
  targetId: string
  enterpriseId: string
  chunkIndex: number
  text: string
  payload: Record<string, unknown>
}

let depsOverride: VectorIndexDeps | null = null
let interval: NodeJS.Timeout | null = null
let running = false

export function __setVectorIndexDepsForTest(deps: VectorIndexDeps | null) {
  depsOverride = deps
}

function deps(input: VectorIndexDeps = {}) {
  return {
    prisma: input.prisma ?? depsOverride?.prisma ?? defaultPrisma,
    embedClient: input.embedClient ?? depsOverride?.embedClient ?? createEmbedClient(),
    qdrantClient: input.qdrantClient ?? depsOverride?.qdrantClient ?? createQdrantClient(),
  }
}

function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function pointIdFor(collection: string, targetId: string, chunkIndex: number): string {
  const hex = crypto.createHash('sha256').update(`${collection}:${targetId}:${chunkIndex}`).digest('hex')
  const bytes = hex.split('')
  bytes[12] = '5'
  const variant = (parseInt(bytes[16], 16) & 0x3) | 0x8
  bytes[16] = variant.toString(16)
  const h = bytes.join('').slice(0, 32)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

async function collectSourceCandidates(db: PrismaClient, enterpriseId?: string, limit = 200): Promise<IndexCandidate[]> {
  const sources = await db.standardExecutionSource.findMany({
    where: {
      status: 'ACTIVE',
      rawText: { not: null },
      ...(enterpriseId ? { enterpriseId } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  })
  const candidates: IndexCandidate[] = []
  for (const source of sources) {
    const chunks = segmentClausesByRule(source.rawText ?? '')
    for (const chunk of chunks) {
      candidates.push({
        collection: 'standard_clauses',
        targetType: 'SOURCE_CLAUSE',
        targetId: source.id,
        enterpriseId: source.enterpriseId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        payload: {
          sourceId: source.id,
          enterpriseId: source.enterpriseId,
          clauseNo: chunk.clauseNo,
          title: chunk.title || source.title,
          chunkText: chunk.text,
          chunkIndex: chunk.chunkIndex,
        },
      })
    }
  }
  return candidates
}

async function collectRequirementCandidates(db: PrismaClient, enterpriseId?: string, limit = 500): Promise<IndexCandidate[]> {
  const requirements = await db.standardExecutionRequirement.findMany({
    where: {
      ...(enterpriseId ? { enterpriseId } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  })
  return requirements.map((requirement) => ({
    collection: 'requirement_points',
    targetType: 'REQUIREMENT',
    targetId: requirement.id,
    enterpriseId: requirement.enterpriseId,
    chunkIndex: 0,
    text: [requirement.title, requirement.requirementText].filter(Boolean).join('\n'),
    payload: {
      requirementId: requirement.id,
      enterpriseId: requirement.enterpriseId,
      sourceId: requirement.sourceId,
      clauseNo: requirement.clauseNo ?? '',
      taskType: requirement.recommendedTaskType ?? '',
      title: requirement.title,
      requirementText: requirement.requirementText,
      createdAt: requirement.createdAt.toISOString(),
    },
  }))
}

async function collectRecordCandidates(db: PrismaClient, enterpriseId?: string, limit = 500): Promise<IndexCandidate[]> {
  const records = await db.standardExecutionRecord.findMany({
    where: {
      status: 'VALID',
      ...(enterpriseId ? { enterpriseId } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  })
  return records.map((record) => ({
    collection: 'execution_records',
    targetType: 'RECORD',
    targetId: record.id,
    enterpriseId: record.enterpriseId,
    chunkIndex: 0,
    text: [record.title, record.summary].filter(Boolean).join('\n'),
    payload: {
      recordId: record.id,
      enterpriseId: record.enterpriseId,
      requirementId: record.requirementId,
      recordDate: record.recordDate.toISOString(),
      status: 'VALID',
      title: record.title,
      summary: record.summary ?? '',
    },
  }))
}

async function shouldIndex(db: PrismaClient, candidate: IndexCandidate): Promise<{ pointId: string; hash: string; skip: boolean }> {
  const hash = contentHash(candidate.text)
  const pointId = pointIdFor(candidate.collection, candidate.targetId, candidate.chunkIndex)
  const existing = await db.sEVectorIndexItem.findUnique({
    where: {
      collection_targetId_chunkIndex: {
        collection: candidate.collection,
        targetId: candidate.targetId,
        chunkIndex: candidate.chunkIndex,
      },
    },
  })
  return {
    pointId,
    hash,
    skip: existing?.status === 'INDEXED' && existing.contentHash === hash,
  }
}

async function indexBatch(
  db: PrismaClient,
  embedClient: EmbedClient,
  qdrantClient: QdrantClient,
  candidates: IndexCandidate[],
): Promise<VectorIndexStats> {
  const stats: VectorIndexStats = { scanned: candidates.length, indexed: 0, skipped: 0, failed: 0 }
  await qdrantClient.ensureCollections(embedClient.vectorSize)

  for (let i = 0; i < candidates.length; i += MAX_EMBED_BATCH_SIZE) {
    const batch = candidates.slice(i, i + MAX_EMBED_BATCH_SIZE)
    const prepared = await Promise.all(batch.map(async (candidate) => ({
      candidate,
      marker: await shouldIndex(db, candidate),
    })))
    const todo = prepared.filter((item) => !item.marker.skip)
    stats.skipped += prepared.length - todo.length
    if (todo.length === 0) continue

    try {
      const vectors = await embedClient.embedTexts(todo.map((item) => item.candidate.text))
      const pointsByCollection = new Map<VectorCollection, VectorPoint[]>()
      todo.forEach((item, index) => {
        const point: VectorPoint = {
          id: item.marker.pointId,
          vector: vectors[index],
          payload: item.candidate.payload,
        }
        const current = pointsByCollection.get(item.candidate.collection) ?? []
        current.push(point)
        pointsByCollection.set(item.candidate.collection, current)
      })
      for (const [collection, points] of pointsByCollection.entries()) {
        await qdrantClient.upsertPoints(collection, points)
      }
      await Promise.all(todo.map((item) => db.sEVectorIndexItem.upsert({
        where: {
          collection_targetId_chunkIndex: {
            collection: item.candidate.collection,
            targetId: item.candidate.targetId,
            chunkIndex: item.candidate.chunkIndex,
          },
        },
        update: {
          enterpriseId: item.candidate.enterpriseId,
          targetType: item.candidate.targetType,
          contentHash: item.marker.hash,
          pointId: item.marker.pointId,
          status: 'INDEXED',
          errorMessage: null,
          indexedAt: new Date(),
        },
        create: {
          enterpriseId: item.candidate.enterpriseId,
          collection: item.candidate.collection,
          targetType: item.candidate.targetType,
          targetId: item.candidate.targetId,
          chunkIndex: item.candidate.chunkIndex,
          contentHash: item.marker.hash,
          pointId: item.marker.pointId,
          status: 'INDEXED',
          indexedAt: new Date(),
        },
      })))
      stats.indexed += todo.length
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown'
      stats.failed += todo.length
      await Promise.all(todo.map((item) => db.sEVectorIndexItem.upsert({
        where: {
          collection_targetId_chunkIndex: {
            collection: item.candidate.collection,
            targetId: item.candidate.targetId,
            chunkIndex: item.candidate.chunkIndex,
          },
        },
        update: {
          enterpriseId: item.candidate.enterpriseId,
          targetType: item.candidate.targetType,
          contentHash: item.marker.hash,
          pointId: item.marker.pointId,
          status: 'FAILED',
          errorMessage: message.slice(0, 500),
        },
        create: {
          enterpriseId: item.candidate.enterpriseId,
          collection: item.candidate.collection,
          targetType: item.candidate.targetType,
          targetId: item.candidate.targetId,
          chunkIndex: item.candidate.chunkIndex,
          contentHash: item.marker.hash,
          pointId: item.marker.pointId,
          status: 'FAILED',
          errorMessage: message.slice(0, 500),
        },
      })))
      logger.warn({ module: 'vector-index', err: message }, 'vector index batch failed')
    }
  }
  return stats
}

export async function runVectorIndexOnce(
  options: { enterpriseId?: string; limit?: number } = {},
  inputDeps: VectorIndexDeps = {},
): Promise<VectorIndexStats> {
  const { prisma: db, embedClient, qdrantClient } = deps(inputDeps)
  const limit = options.limit ?? 500
  const candidates = [
    ...(await collectSourceCandidates(db, options.enterpriseId, Math.min(limit, 200))),
    ...(await collectRequirementCandidates(db, options.enterpriseId, limit)),
    ...(await collectRecordCandidates(db, options.enterpriseId, limit)),
  ].filter((candidate) => candidate.text.trim().length > 0)
  return indexBatch(db, embedClient, qdrantClient, candidates)
}

async function indexSingle(targetType: TargetType, targetId: string, inputDeps: VectorIndexDeps = {}) {
  const { prisma: db, embedClient, qdrantClient } = deps(inputDeps)
  let candidates: IndexCandidate[] = []
  if (targetType === 'SOURCE_CLAUSE') {
    const source = await db.standardExecutionSource.findUnique({ where: { id: targetId } })
    if (!source?.rawText) return
    candidates = await collectSourceCandidates(db, source.enterpriseId, 1)
    candidates = candidates.filter((candidate) => candidate.targetId === targetId)
  } else if (targetType === 'REQUIREMENT') {
    const requirement = await db.standardExecutionRequirement.findUnique({ where: { id: targetId } })
    if (!requirement) return
    candidates = (await collectRequirementCandidates(db, requirement.enterpriseId, 50)).filter((candidate) => candidate.targetId === targetId)
  } else {
    const record = await db.standardExecutionRecord.findUnique({ where: { id: targetId } })
    if (!record || record.status !== 'VALID') return
    candidates = (await collectRecordCandidates(db, record.enterpriseId, 50)).filter((candidate) => candidate.targetId === targetId)
  }
  await indexBatch(db, embedClient, qdrantClient, candidates)
}

function shouldSkipAsyncTrigger(): boolean {
  return process.env.NODE_ENV === 'test' && !depsOverride
}

function fireAndForget(promise: Promise<unknown>) {
  promise.catch((err) => {
    logger.warn({ module: 'vector-index', err }, 'async vector index failed')
  })
}

export function enqueueSourceVectorIndex(sourceId: string) {
  if (shouldSkipAsyncTrigger()) return
  fireAndForget(indexSingle('SOURCE_CLAUSE', sourceId))
}

export function enqueueRequirementVectorIndex(requirementId: string) {
  if (shouldSkipAsyncTrigger()) return
  fireAndForget(indexSingle('REQUIREMENT', requirementId))
}

export function enqueueRecordVectorIndex(recordId: string) {
  if (shouldSkipAsyncTrigger()) return
  fireAndForget(indexSingle('RECORD', recordId))
}

export function startVectorIndexWorker() {
  if (process.env.NODE_ENV === 'test') return
  if (process.env.VECTOR_INDEX_ENABLED === '0') return
  if (interval) return
  const intervalMs = Number(process.env.VECTOR_INDEX_INTERVAL_MS || 300_000)
  const tick = async () => {
    if (running) return
    running = true
    try {
      const stats = await runVectorIndexOnce()
      logger.info({ module: 'vector-index', stats }, 'vector index scan finished')
    } catch (err) {
      logger.warn({ module: 'vector-index', err }, 'vector index scan skipped')
    } finally {
      running = false
    }
  }
  void tick()
  interval = setInterval(() => void tick(), intervalMs)
}
