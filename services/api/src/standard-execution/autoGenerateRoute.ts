/**
 * 自动解析要求项（auto-generate）— Admin only
 *
 *   POST /api/admin/standard-execution/requirements/auto-generate
 *
 * 三种 parseMode（doc §七.1）：
 *   - AI_STUB  : 占位，返回空 drafts，不写库
 *   - RULE     : 纯规则解析（条款编号 + 强约束词）
 *   - OCR_AI   : 主力，调 callStandardAI；失败 / 非法 JSON / AI 未配置 / rawText 空 → 降级 RULE
 *
 * 写库：generateMode 跟随实际执行模式（'AI' / 'RULE' / 'AI_STUB' 不会落库），status 固定 REVIEW_PENDING。
 * dryRun=true 时只返回 drafts 不写库（前端预览解析结果）。
 */
import type { Express, Response } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { requireAdmin, type AuthRequest } from '../auth.js'
import { logger } from '../logger.js'
import { getEnterpriseId } from './utils.js'
import {
  AutoGenerateSchema,
  type CandidateRequirement,
  type CandidateScoreDistribution,
  type RequirementDraft,
  type TaskGenerationCoverageReport,
  type TaskGenerationTaskPackage,
} from './types.js'
import { parseByRule } from './parseRule.js'
import { parseByAiWithCandidates, summarizeCandidateScores } from './parseAi.js'
import { cleanStandardText, chunkText, validateDrafts } from './parseClean.js'
import { aggregateCandidateRequirements } from './candidateAggregation.js'
import { ruleDraftsToCandidateRequirements } from './ruleCandidateAdapter.js'
import {
  getAiParseChunkChars,
  getAiParseConcurrency,
  getCandidateRequirementMinScore,
  getCandidateTaskMinScore,
  getRealtimeAiMaxChars,
  isCandidateV2Enabled,
} from './parseRuntimeConfig.js'
import {
  callStandardAI,
  AiNotConfiguredError,
  AiCallFailedError,
} from './aiClient.js'
import { AiInvalidJsonError } from './parseAi.js'

function badRequest(res: Response, msg: string) {
  return res.status(400).json({ error: msg })
}

type DegradedReason =
  | 'RAWTEXT_EMPTY'
  | 'AI_NOT_CONFIGURED'
  | 'AI_FAILED'
  | 'AI_INVALID_JSON'
  | 'REALTIME_RULE_LIMIT'

interface ParseResult {
  parseMode: 'OCR_AI' | 'RULE' | 'AI_STUB'
  drafts: RequirementDraft[]
  candidateV2Enabled: boolean
  candidateRequirements?: CandidateRequirement[]
  candidateScoreDistribution?: CandidateScoreDistribution
  candidateThresholds?: {
    candidateMinScore: number
    taskMinScore: number
  }
  taskPackages?: TaskGenerationTaskPackage[]
  coverageReport?: TaskGenerationCoverageReport
  degraded: boolean
  degradedReason?: DegradedReason
  // Phase 0.5 #4: 段3 校验产物——前端 dryRun 预览提示（超量/失败/过滤），不静默
  warnings: string[]
  rejectedCount: number
}

function emptyCandidateDistribution(): CandidateScoreDistribution {
  return summarizeCandidateScores([])
}

function candidateThresholds() {
  return {
    candidateMinScore: getCandidateRequirementMinScore(),
    taskMinScore: getCandidateTaskMinScore(),
  }
}

function baseCandidateResult() {
  return {
    candidateV2Enabled: false,
  }
}

function enabledCandidateResult(
  candidateRequirements: CandidateRequirement[],
  candidateScoreDistribution: CandidateScoreDistribution = emptyCandidateDistribution(),
  taskPackages: TaskGenerationTaskPackage[] = [],
  coverageReport: TaskGenerationCoverageReport | undefined = undefined,
) {
  return {
    candidateV2Enabled: true,
    candidateRequirements,
    candidateScoreDistribution,
    candidateThresholds: candidateThresholds(),
    taskPackages,
    coverageReport,
  }
}

function classifyAiError(err: unknown): DegradedReason {
  if (err instanceof AiNotConfiguredError) return 'AI_NOT_CONFIGURED'
  if (err instanceof AiInvalidJsonError) return 'AI_INVALID_JSON'
  if (err instanceof AiCallFailedError) return 'AI_FAILED'
  return 'AI_FAILED'
}

async function buildRuleParseResult(
  cleanText: string,
  options: {
    degraded?: boolean
    degradedReason?: DegradedReason
    warnings?: string[]
  } = {},
): Promise<ParseResult> {
  const parsedDrafts = parseByRule(cleanText)
  const v = validateDrafts(parsedDrafts)
  const baseWarnings = [...v.warnings, ...(options.warnings ?? [])]
  if (!isCandidateV2Enabled()) {
    return {
      parseMode: 'RULE',
      drafts: v.valid,
      ...baseCandidateResult(),
      degraded: options.degraded ?? false,
      degradedReason: options.degradedReason,
      warnings: baseWarnings,
      rejectedCount: v.rejected.length,
    }
  }

  const ruleCandidates = ruleDraftsToCandidateRequirements(v.valid)
  const scoreDistribution = summarizeCandidateScores(ruleCandidates)
  const aggregation = await aggregateCandidateRequirements(ruleCandidates)
  const aggregated = validateDrafts(aggregation.drafts)
  const warnings = [
    ...baseWarnings,
    ...aggregated.warnings,
    ...aggregation.warnings,
  ]
  if (ruleCandidates.length > 0) {
    warnings.push(
      `规则候选要求 ${ruleCandidates.length} 条，其中 ${scoreDistribution.taskEligible} 条超过任务阈值，聚合为 ${aggregation.taskPackages.length} 个任务包，其余保留为候选/关联要求`,
    )
  }
  return {
    parseMode: 'RULE',
    drafts: aggregated.valid,
    ...enabledCandidateResult(ruleCandidates, scoreDistribution, aggregation.taskPackages, aggregation.coverageReport),
    degraded: options.degraded ?? false,
    degradedReason: options.degradedReason,
    warnings,
    rejectedCount: v.rejected.length + aggregated.rejected.length,
  }
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

/**
 * 解析三段管道（Phase 0.5 #4 修复）：
 *   段1 cleanStandardText（剥目录/前言/术语/附录）→ RULE 与 OCR_AI 共用
 *   段2 chunkText 分段 → 有限并发 parseByAi（避免超长 token → AI_INVALID_JSON，同时不拖过 8083 网关窗口）
 *   段3 validateDrafts（去重/过滤/数量上限）→ warnings 不静默
 * AI 全部分段失败才降级 RULE（降级也走 clean 后文本 + 段3，不再产垃圾）。
 * aiCaller 可注入以便测试。
 */
export async function runParse(
  rawText: string,
  requestedMode: 'OCR_AI' | 'RULE' | 'AI_STUB',
  aiCaller: (prompt: string) => Promise<string> = callStandardAI,
): Promise<ParseResult> {
  if (requestedMode === 'AI_STUB') {
    return { parseMode: 'AI_STUB', drafts: [], ...baseCandidateResult(), degraded: false, warnings: [], rejectedCount: 0 }
  }

  // 段1：清洗（RULE 与 OCR_AI 共用，确保 RULE 也不再切目录/前言/术语）
  const clean = cleanStandardText(rawText)

  if (requestedMode === 'RULE') {
    return buildRuleParseResult(clean)
  }

  // OCR_AI 主力路径：空文本直接降级
  if (!rawText || !rawText.trim()) {
    return buildRuleParseResult(clean, { degraded: true, degradedReason: 'RAWTEXT_EMPTY' })
  }

  // 段2：分段抽取（单段失败不拖垮整体）
  const chunkChars = getAiParseChunkChars()
  const chunks = chunkText(clean, chunkChars)
  const realtimeMaxChars = getRealtimeAiMaxChars()
  if (clean.length > realtimeMaxChars) {
    return buildRuleParseResult(clean, {
      degraded: true,
      degradedReason: 'REALTIME_RULE_LIMIT',
      warnings: [`文档约 ${clean.length} 字，超出 AI 实时解析上限 ${realtimeMaxChars} 字，将使用规则解析`],
    })
  }
  const concurrency = getAiParseConcurrency()
  const candidateV2 = isCandidateV2Enabled()
  const aiDrafts: RequirementDraft[] = []
  const candidateRequirements: CandidateRequirement[] = []
  let failedChunks = 0
  let lastReason: DegradedReason | undefined
  const chunkResults = await mapWithConcurrency(chunks, concurrency, async (chunk) => {
    try {
      const parsed = await parseByAiWithCandidates(chunk, aiCaller)
      return {
        drafts: candidateV2 ? [] : parsed.drafts,
        candidates: parsed.candidates,
        reason: null as DegradedReason | null,
      }
    } catch (err) {
      const reason = classifyAiError(err)
      logger.warn({ err, reason }, '[standard-execution] AI 分段解析失败')
      return { drafts: [] as RequirementDraft[], candidates: [] as CandidateRequirement[], reason }
    }
  })
  for (const result of chunkResults) {
    aiDrafts.push(...result.drafts)
    candidateRequirements.push(...result.candidates)
    if (result.reason) {
      failedChunks++
      lastReason = result.reason
    }
  }

  // 全部分段失败 → 降级 RULE（clean 后文本 + 段3 兜底，不再产垃圾），且 warning 不静默
  const hasAiOutput = candidateV2 ? candidateRequirements.length > 0 : aiDrafts.length > 0
  if (!hasAiOutput && failedChunks > 0) {
    return buildRuleParseResult(clean, {
      degraded: true,
      degradedReason: lastReason ?? 'AI_FAILED',
      warnings: [`AI 解析全部失败（${failedChunks}/${chunks.length} 段），已降级规则解析，请人工确认`],
    })
  }

  // 段3：校验 + 不静默告警（部分段失败也提示）
  const scoreDistribution = summarizeCandidateScores(candidateRequirements)
  const aggregation = candidateV2
    ? await aggregateCandidateRequirements(candidateRequirements, { aiCaller })
    : null
  const v = validateDrafts(aggregation?.drafts ?? aiDrafts)
  const warnings = [...v.warnings, ...(aggregation?.warnings ?? [])]
  const partialFail = failedChunks > 0
  if (partialFail) {
    warnings.push(`${chunks.length} 段中 ${failedChunks} 段 AI 解析失败，结果可能不完整，请人工确认`)
  }
  if (candidateV2 && candidateRequirements.length > v.valid.length) {
    warnings.push(
      `AI 候选要求 ${candidateRequirements.length} 条，其中 ${scoreDistribution.taskEligible} 条超过任务阈值，聚合为 ${aggregation?.taskPackages.length ?? 0} 个任务包，其余保留为候选/关联要求`,
    )
  }
  return {
    parseMode: 'OCR_AI',
    drafts: v.valid,
    ...(candidateV2
      ? enabledCandidateResult(candidateRequirements, scoreDistribution, aggregation?.taskPackages ?? [], aggregation?.coverageReport)
      : baseCandidateResult()),
    degraded: partialFail,
    degradedReason: partialFail ? lastReason : undefined,
    warnings,
    rejectedCount: v.rejected.length,
  }
}

export function registerStandardExecutionAutoGenerateRoute(
  app: Express,
  // 测试 hook：注入 aiCaller，默认走真实 callStandardAI
  aiCaller: (prompt: string) => Promise<string> = callStandardAI,
) {
  app.post(
    '/api/admin/standard-execution/requirements/auto-generate',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = AutoGenerateSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const { sourceId, parseMode, dryRun } = parsed.data
      const enterpriseId = getEnterpriseId(req as never)

      // sourceId FK 校验：source 必须存在且属于同企业
      const source = await prisma.standardExecutionSource.findFirst({
        where: { id: sourceId, enterpriseId },
        select: { id: true, rawText: true, status: true },
      })
      if (!source) return badRequest(res, 'sourceId 对应的标准来源不存在')

      const result = await runParse(source.rawText ?? '', parseMode, aiCaller)

      let createdCount = 0
      const skippedCount = 0 // parseByRule / parseByAi 内部已过滤空文本，这里不再二次过滤
      const aiCount = result.parseMode === 'OCR_AI' ? result.drafts.length : 0
      const ruleCount = result.parseMode === 'RULE' ? result.drafts.length : 0
      const degradedCount = result.degraded ? result.drafts.length : 0

      if (!dryRun && result.drafts.length > 0) {
        // generateMode 落库映射：解析实际执行模式 → 枚举
        //   OCR_AI 执行成功 → AI
        //   RULE 执行（含降级）→ RULE
        //   AI_STUB 不进这里（drafts 为空）
        const generateMode = result.parseMode === 'OCR_AI' ? 'AI' : 'RULE'
        const created = await prisma.standardExecutionRequirement.createMany({
          data: result.drafts.map((d) => ({
            enterpriseId,
            sourceId,
            clauseNo: d.clauseNo,
            title: d.title,
            requirementText: d.requirementText,
            applicableDeptIds: Prisma.DbNull,
            archiveTags: Prisma.DbNull,
            generateMode,
            status: 'REVIEW_PENDING',
            // P0-5: AI 解析字段落库（RULE 模式这些为空）
            recommendedTaskType: d.recommendedTaskType ?? null,
            executionDescription: d.executionDescription ?? null,
            submitRequirement: d.submitRequirement ?? null,
            requiredMaterials: d.requiredMaterials ? (d.requiredMaterials as Prisma.InputJsonValue) : Prisma.DbNull,
            parseMode: result.parseMode,
            degradedReason: result.degradedReason ?? null,
            createdBy: req.userId!,
          })),
        })
        createdCount = created.count
      }

      res.json({
        data: {
          sourceId,
          requestedMode: parseMode,
          parseMode: result.parseMode,
          degraded: result.degraded,
          degradedReason: result.degradedReason,
          ...(result.candidateV2Enabled
            ? {
                candidateV2Enabled: true,
                candidateRequirements: result.candidateRequirements,
                candidateScoreDistribution: result.candidateScoreDistribution,
                candidateThresholds: result.candidateThresholds,
                taskPackages: result.taskPackages,
                coverageReport: result.coverageReport,
              }
            : {}),
          drafts: result.drafts,
          createdCount,
          skippedCount,
          aiCount,
          ruleCount,
          degradedCount,
          warnings: result.warnings,
          rejectedCount: result.rejectedCount,
          dryRun,
        },
      })
    },
  )
}
