/**
 * standard-execution / AI 解析 V2 Pipeline
 *
 * V2 与 parseAi.ts（V1）并存：这里只返回 Job result JSON 所需的草稿，
 * 不写 StandardExecutionRequirement，等待 E3 人工确认后再入库。
 */
import { z } from 'zod'
import { logger } from '../logger.js'
import { callStandardAI } from './aiClient.js'
import { segmentClauses, type ClauseChunk } from './clauseSegment.js'
import { createEmbedClient, type EmbedClient } from './embedClient.js'
import { createQdrantClient, type QdrantClient, type VectorCollection, type VectorSearchHit } from './qdrantClient.js'
import { createSearchClient, type SearchClient, type SearchSnippet } from './searchClient.js'
import type { RequirementDraft } from './types.js'

export interface SourceForParseV2 {
  id: string
  enterpriseId: string
  title: string
  sourceNo?: string | null
  rawText?: string | null
}

export interface ParseV2RequirementDraft extends RequirementDraft {
  confidence: number
  reasoning: string
  sourceChunks: string[]
  needsReview: boolean
}

export interface SimilarContext {
  id: string
  collection: VectorCollection
  score: number
  title: string
  text: string
  payload: Record<string, unknown>
}

export interface ParseV2Metadata {
  version: 'E2_PARSE_V2'
  sourceId: string
  sourceTitle: string
  sourceNo: string | null
  chunkCount: number
  requirementCount: number
  degradedSteps: string[]
  retrieval: {
    standardClauses: number
    requirementPoints: number
    executionRecords: number
    internetSnippets: number
  }
  generatedAt: string
  disclaimer: string
}

export interface ParseV2ChunkCache {
  chunk: ClauseChunk
  similarClauses: SimilarContext[]
  similarRequirements: SimilarContext[]
  similarRecords: SimilarContext[]
  searchSnippets: SearchSnippet[]
}

export interface ParseV2Result {
  version: 'v2'
  sourceId: string
  requirements: ParseV2RequirementDraft[]
  chunks: ParseV2ChunkCache[]
  metadata: ParseV2Metadata
}

export interface ParseStandardV2Options {
  aiCaller?: (prompt: string) => Promise<string>
  embedClient?: EmbedClient
  qdrantClient?: Pick<QdrantClient, 'search'>
  searchClient?: SearchClient
  concurrency?: number
  onProgress?: (event: { step: string; progress: number }) => void | Promise<void>
}

const DISCLAIMER = '仅供参考，最终以人工审核为准'
const AI_RECOMMENDED_TASK_TYPES = [
  'TRAINING',
  'QUALIFICATION_MATERIAL',
  'ONBOARDING_ACCESS',
  'INSPECTION_FILL',
  'RECTIFICATION',
  'ARCHIVE_MATERIAL',
] as const

const ConfidenceSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    const clean = value.replace('%', '').trim()
    const num = Number(clean)
    if (Number.isFinite(num)) return num > 1 ? num / 100 : num
  }
  if (typeof value === 'number' && value > 1) return value / 100
  return value
}, z.coerce.number().min(0).max(1))

const AiRequirementV2Schema = z.object({
  clauseNo: z.string().optional().nullable(),
  title: z.string().trim().min(1),
  requirementText: z.string().trim().min(1),
  executionDescription: z.string().optional().nullable(),
  recommendedTaskType: z.enum(AI_RECOMMENDED_TASK_TYPES).optional().nullable(),
  suggestedDepartment: z.string().optional().nullable(),
  suggestedFrequency: z.string().optional().nullable(),
  submitRequirement: z.string().optional().nullable(),
  requiredMaterials: z.array(z.string()).optional().nullable(),
  confidence: ConfidenceSchema,
  reasoning: z.string().trim().min(1),
  sourceChunks: z.array(z.string()).optional().default([]),
  needsReview: z.boolean().optional().default(false),
})
const AiRequirementArraySchema = z.array(AiRequirementV2Schema)
const AiSynthesisResponseSchema = z.union([
  z.object({
    requirements: AiRequirementArraySchema,
    disclaimer: z.string().optional(),
  }),
  AiRequirementArraySchema,
])

function stripJsonFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
}

function normalizeText(value: unknown, maxLen = 1200): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text
}

function payloadString(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === 'string' ? payload[key] as string : ''
}

function hitToSimilarContext(collection: VectorCollection, hit: VectorSearchHit): SimilarContext {
  const payload = hit.payload ?? {}
  const title = payloadString(payload, 'title') ||
    payloadString(payload, 'clauseNo') ||
    payloadString(payload, 'requirementId') ||
    payloadString(payload, 'recordId') ||
    String(hit.id)
  const text = payloadString(payload, 'chunkText') ||
    payloadString(payload, 'requirementText') ||
    payloadString(payload, 'summary') ||
    title
  return {
    id: `${collection}:${String(hit.id)}`,
    collection,
    score: hit.score,
    title: normalizeText(title, 120),
    text: normalizeText(text, 1000),
    payload,
  }
}

function normalizeDraft(
  item: z.infer<typeof AiRequirementV2Schema>,
  chunk: ClauseChunk,
  fallbackSources: string[],
): ParseV2RequirementDraft | null {
  const requirementText = item.requirementText.trim()
  const title = item.title.trim()
  if (!requirementText || !title) return null
  const confidence = Math.min(1, Math.max(0, item.confidence))
  const sourceChunks = (item.sourceChunks.length ? item.sourceChunks : fallbackSources)
    .map((source) => source.trim())
    .filter(Boolean)
    .slice(0, 20)
  return {
    clauseNo: item.clauseNo?.trim() || chunk.clauseNo || null,
    title,
    requirementText,
    executionDescription: item.executionDescription?.trim() || null,
    recommendedTaskType: item.recommendedTaskType ?? null,
    suggestedDepartment: item.suggestedDepartment?.trim() || null,
    suggestedFrequency: item.suggestedFrequency?.trim() || null,
    submitRequirement: item.submitRequirement?.trim() || null,
    requiredMaterials: item.requiredMaterials?.map((m) => m.trim()).filter(Boolean).slice(0, 20) ?? null,
    confidence,
    reasoning: item.reasoning.trim(),
    sourceChunks,
    needsReview: item.needsReview || confidence < 0.5,
  }
}

function parseSynthesisResponse(raw: string, chunk: ClauseChunk, fallbackSources: string[]): ParseV2RequirementDraft[] {
  const parsed = AiSynthesisResponseSchema.parse(JSON.parse(stripJsonFence(raw)))
  const items = Array.isArray(parsed) ? parsed : parsed.requirements
  return items.flatMap((item) => {
    const draft = normalizeDraft(item, chunk, fallbackSources)
    return draft ? [draft] : []
  })
}

function compareClauseNo(a: string | null, b: string | null): number {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  const pa = a.split(/[^\d]+/).filter(Boolean).map(Number)
  const pb = b.split(/[^\d]+/).filter(Boolean).map(Number)
  const max = Math.max(pa.length, pb.length)
  for (let i = 0; i < max; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da - db
  }
  return a.localeCompare(b, 'zh-CN')
}

function dedupeRequirements(requirements: ParseV2RequirementDraft[]): ParseV2RequirementDraft[] {
  const byKey = new Map<string, ParseV2RequirementDraft>()
  for (const requirement of requirements) {
    const key = [
      requirement.clauseNo ?? '',
      requirement.title,
      requirement.requirementText,
    ].join('|').replace(/\s+/g, '').toLowerCase()
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, requirement)
      continue
    }
    const mergedSources = Array.from(new Set([...existing.sourceChunks, ...requirement.sourceChunks])).slice(0, 20)
    if (requirement.confidence > existing.confidence) {
      byKey.set(key, { ...requirement, sourceChunks: mergedSources })
    } else {
      byKey.set(key, { ...existing, sourceChunks: mergedSources })
    }
  }
  return [...byKey.values()].sort((a, b) => compareClauseNo(a.clauseNo, b.clauseNo) || a.title.localeCompare(b.title, 'zh-CN'))
}

function formatSimilarItems(items: SimilarContext[], emptyText: string): string {
  if (items.length === 0) return emptyText
  return items.map((item, index) => [
    `${index + 1}. id=${item.id}`,
    `score=${item.score.toFixed(3)}`,
    `title=${item.title}`,
    `text=${item.text}`,
  ].join('\n')).join('\n\n')
}

function formatSearchItems(items: SearchSnippet[]): string {
  if (items.length === 0) return '无互联网摘要。'
  return items.map((item, index) => [
    `${index + 1}. id=search:${index}`,
    `provider=${item.provider}`,
    `title=${item.title}`,
    `url=${item.url}`,
    `summary=${item.content}`,
  ].join('\n')).join('\n\n')
}

export function buildSearchQuery(source: SourceForParseV2, chunk: ClauseChunk): string {
  return [
    source.sourceNo,
    chunk.clauseNo,
    chunk.title,
    '执行要求',
    '监管',
    '中文',
  ].filter(Boolean).join(' ')
}

export function buildSynthesizePrompt(
  source: SourceForParseV2,
  chunk: ClauseChunk,
  context: {
    similarClauses: SimilarContext[]
    similarRequirements: SimilarContext[]
    similarRecords: SimilarContext[]
    searchSnippets: SearchSnippet[]
  },
): string {
  return `你是企业标准执行解析专家。请根据当前条款原文，并参考相似条款、历史控制点、有效执行记录和互联网摘要，提取可执行控制点草稿。

重要边界：
- 只输出严格 JSON，不要 Markdown，不要解释性正文。
- 结果只是待人工确认的草稿，末尾必须含"${DISCLAIMER}"。
- 不确定、证据不足、字段需要人工补齐时，needsReview=true，并降低 confidence。
- sourceChunks 只能引用下方提供的 id，例如 chunk:${chunk.chunkIndex}、standard_clauses:...、requirement_points:...、execution_records:...、search:0。
- 不得虚构法律依据、标准条款或历史记录；互联网摘要只作为参考，不能替代原文。

输出 JSON Schema：
{
  "requirements": [
    {
      "clauseNo": "条款编号，没有则为空字符串",
      "title": "控制点标题，不超过 24 字",
      "requirementText": "可追溯的原文要求，保留数值、期限、频率和证据要求",
      "executionDescription": "现场可执行描述",
      "recommendedTaskType": "TRAINING | QUALIFICATION_MATERIAL | ONBOARDING_ACCESS | INSPECTION_FILL | RECTIFICATION | ARCHIVE_MATERIAL",
      "suggestedDepartment": "建议责任部门/岗位",
      "suggestedFrequency": "建议频率",
      "submitRequirement": "执行人需提交什么才算完成",
      "requiredMaterials": ["材料1"],
      "confidence": 0.0,
      "reasoning": "说明依据：原文 + 相似控制点/记录/互联网摘要中的哪些信息支持该草稿",
      "sourceChunks": ["chunk:${chunk.chunkIndex}"],
      "needsReview": true
    }
  ],
  "disclaimer": "${DISCLAIMER}"
}

标准来源：
- sourceId: ${source.id}
- sourceNo: ${source.sourceNo || ''}
- title: ${source.title}

当前条款：
id=chunk:${chunk.chunkIndex}
clauseNo=${chunk.clauseNo || ''}
title=${chunk.title || ''}
text=${chunk.text}

相似标准条款：
${formatSimilarItems(context.similarClauses, '无相似标准条款。')}

相似历史控制点：
${formatSimilarItems(context.similarRequirements, '无相似历史控制点。')}

相似有效执行记录：
${formatSimilarItems(context.similarRecords, '无相似有效执行记录。')}

互联网摘要：
${formatSearchItems(context.searchSnippets)}

请现在输出 JSON。`
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function createMetadata(source: SourceForParseV2, chunkCount: number): ParseV2Metadata {
  return {
    version: 'E2_PARSE_V2',
    sourceId: source.id,
    sourceTitle: source.title,
    sourceNo: source.sourceNo ?? null,
    chunkCount,
    requirementCount: 0,
    degradedSteps: [],
    retrieval: {
      standardClauses: 0,
      requirementPoints: 0,
      executionRecords: 0,
      internetSnippets: 0,
    },
    generatedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
  }
}

function addDegraded(metadata: ParseV2Metadata, step: string, err?: unknown) {
  if (!metadata.degradedSteps.includes(step)) metadata.degradedSteps.push(step)
  if (err) {
    logger.warn({ module: 'parse-ai-v2', step, err }, 'parse v2 step degraded')
  }
}

async function retrieveRagContext(
  source: SourceForParseV2,
  chunk: ClauseChunk,
  deps: { embedClient: EmbedClient; qdrantClient: Pick<QdrantClient, 'search'> },
  metadata: ParseV2Metadata,
): Promise<{
  similarClauses: SimilarContext[]
  similarRequirements: SimilarContext[]
  similarRecords: SimilarContext[]
}> {
  let vector: number[]
  try {
    vector = (await deps.embedClient.embedTexts([chunk.text]))[0]
  } catch (err) {
    addDegraded(metadata, 'RAG_EMBED_UNAVAILABLE', err)
    return { similarClauses: [], similarRequirements: [], similarRecords: [] }
  }
  if (!vector?.length) {
    addDegraded(metadata, 'RAG_EMBED_EMPTY')
    return { similarClauses: [], similarRequirements: [], similarRecords: [] }
  }

  async function search(collection: VectorCollection, topK: number, metadataKey: keyof ParseV2Metadata['retrieval']) {
    try {
      const hits = await deps.qdrantClient.search(collection, vector, {
        enterpriseId: source.enterpriseId,
        topK,
      })
      const mapped = hits.map((hit) => hitToSimilarContext(collection, hit))
      metadata.retrieval[metadataKey] += mapped.length
      return mapped
    } catch (err) {
      addDegraded(metadata, `RAG_${collection.toUpperCase()}_UNAVAILABLE`, err)
      return []
    }
  }

  const [similarClauses, similarRequirements, similarRecords] = await Promise.all([
    search('standard_clauses', 3, 'standardClauses'),
    search('requirement_points', 5, 'requirementPoints'),
    search('execution_records', 3, 'executionRecords'),
  ])
  return { similarClauses, similarRequirements, similarRecords }
}

async function retrieveSearchSnippets(
  source: SourceForParseV2,
  chunk: ClauseChunk,
  searchClient: SearchClient,
  metadata: ParseV2Metadata,
): Promise<SearchSnippet[]> {
  try {
    const snippets = await searchClient.search(buildSearchQuery(source, chunk), { topK: 3 })
    metadata.retrieval.internetSnippets += snippets.length
    return snippets
  } catch (err) {
    addDegraded(metadata, 'SEARCH_UNAVAILABLE', err)
    return []
  }
}

function sourceRefsFor(
  chunk: ClauseChunk,
  context: {
    similarClauses: SimilarContext[]
    similarRequirements: SimilarContext[]
    similarRecords: SimilarContext[]
    searchSnippets: SearchSnippet[]
  },
) {
  return [
    `chunk:${chunk.chunkIndex}`,
    ...context.similarClauses.map((item) => item.id),
    ...context.similarRequirements.map((item) => item.id),
    ...context.similarRecords.map((item) => item.id),
    ...context.searchSnippets.map((_, index) => `search:${index}`),
  ]
}

export async function synthesizeParseV2Chunk(
  source: SourceForParseV2,
  cache: ParseV2ChunkCache,
  aiCaller: (prompt: string) => Promise<string> = callStandardAI,
): Promise<ParseV2RequirementDraft[]> {
  const prompt = buildSynthesizePrompt(source, cache.chunk, {
    similarClauses: cache.similarClauses,
    similarRequirements: cache.similarRequirements,
    similarRecords: cache.similarRecords,
    searchSnippets: cache.searchSnippets,
  })
  const raw = await aiCaller(prompt)
  return parseSynthesisResponse(raw, cache.chunk, sourceRefsFor(cache.chunk, cache))
}

export async function parseStandardV2(
  source: SourceForParseV2,
  options: ParseStandardV2Options = {},
): Promise<ParseV2Result> {
  const aiCaller = options.aiCaller ?? callStandardAI
  const embedClient = options.embedClient ?? createEmbedClient()
  const qdrantClient = options.qdrantClient ?? createQdrantClient()
  const searchClient = options.searchClient ?? createSearchClient()
  const concurrency = Math.min(Math.max(options.concurrency ?? 3, 1), 5)
  const report = async (step: string, progress: number) => {
    await options.onProgress?.({ step, progress })
  }

  await report('SEGMENTING', 5)
  const chunks = await segmentClauses(source.rawText ?? '', { aiCaller })
  const metadata = createMetadata(source, chunks.length)
  if (chunks.length === 0) {
    addDegraded(metadata, 'SEGMENT_EMPTY')
    await report('DONE', 100)
    return {
      version: 'v2',
      sourceId: source.id,
      requirements: [],
      chunks: [],
      metadata,
    }
  }

  await report('RETRIEVING_AND_SYNTHESIZING', 20)
  let finished = 0
  const chunkResults = await mapWithConcurrency(chunks, concurrency, async (chunk) => {
    const rag = await retrieveRagContext(source, chunk, { embedClient, qdrantClient }, metadata)
    const searchSnippets = await retrieveSearchSnippets(source, chunk, searchClient, metadata)
    const context: ParseV2ChunkCache = { chunk, ...rag, searchSnippets }
    const drafts = await synthesizeParseV2Chunk(source, context, aiCaller)
    finished += 1
    await report('RETRIEVING_AND_SYNTHESIZING', 20 + Math.floor((finished / chunks.length) * 70))
    return { drafts, context }
  })

  await report('AGGREGATING', 95)
  const requirements = dedupeRequirements(chunkResults.flatMap((item) => item.drafts))
  metadata.requirementCount = requirements.length
  await report('DONE', 100)
  return {
    version: 'v2',
    sourceId: source.id,
    requirements,
    chunks: chunkResults.map((item) => item.context),
    metadata,
  }
}
