/**
 * 比对任务队列 Worker
 * 按 priority ASC, createdAt ASC 顺序消费 PENDING 任务
 * priority: 1=高（全库/扫一扫），2=低（一对一）
 */
import { PrismaClient } from '@prisma/client'
import { trackServerEvent, markUserActive } from './tracker.js'
import { unlink } from 'fs/promises'
import {
  analyzeTextQuality,
  DocumentExtractError,
  extractTextDetailed,
  extractTextFromString,
  pollExtractTextJob,
  submitExtractTextJob,
  type ExtractFailureCode,
  type ExtractJobPollResult,
  type ExtractTextDetails,
} from './doc-extract'

const prisma = new PrismaClient()
const dbUrl = process.env.DATABASE_URL || ''
const IS_POSTGRES = dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://')

/**
 * 任务完成后清理上传原件 — 隐私政策第 4/6 节明确「任务完成后清理」。
 * 容错策略：删失败只 console.warn，不影响任务完成（任务已经在 db 标 COMPLETED）。
 * 必须在 db update 成功之后才调，否则 retry 路径会找不到原文件。
 * 兜底由 uploadsSweeper 30 天扫描负责。
 */
async function cleanupUploadFiles(taskNo: string, files: Array<string | undefined | null>) {
  for (const f of files) {
    if (!f) continue
    try {
      await unlink(f)
      console.log(`[taskWorker] 清理上传原件: ${f} (task=${taskNo})`)
    } catch (err: any) {
      // ENOENT = 文件已不存在，正常情况（手动清过 / 上一次任务已删 / sweeper 提前扫到）
      if (err?.code !== 'ENOENT') {
        console.warn(`[taskWorker] 清理上传原件失败: ${f} (task=${taskNo}) - ${err?.message || err}`)
      }
    }
  }
}

type TaskFailureCode = 'EXTRACT_FAILED' | 'OCR_FAILED' | 'TEXT_INSUFFICIENT'

// ─── 1v1 比对超限阈值(双层限流第二层)──
// 仅 1v1 / ONE_TO_ONE 触发,全库比对 library / full-corpus 不受这些限制。
// 单文件:pages ≤ 60(硬失败), normalized ≤ 60000(超出截断), sections 仅日志诊断
// 合计:pages ≤ 120(硬失败), normalized ≤ 100000(硬失败), sections 仅日志诊断
// pages/normalized 超限走 throw DocumentExtractError → 任务 FAILED。
// sections 超限不再 throw — 章节数是正则估算,易把目录/列表/编号误判,不适合作为
// 用户侧硬失败条件(2026-05-06 起)。常量保留作为日志告警阈值。
// 用户侧 errorMessage 不暴露内部机制(OOM/heap/worker/V8 等),详情走 logger.warn。
export const PAIR_PER_FILE_PAGE_LIMIT = 60
export const PAIR_PER_FILE_NORMALIZED_LIMIT = 60000
export const PAIR_PER_FILE_SECTION_LIMIT = 150
export const PAIR_TOTAL_PAGE_LIMIT = 120
export const PAIR_TOTAL_NORMALIZED_LIMIT = 100000
export const PAIR_TOTAL_SECTION_LIMIT = 300

// 失败文案细分:超页数 / 超字数 / 合计超限 各自独立中文提示,
// 用户能据此判断下一步动作(拆页 / 缩文)。

// ─── 安全截断（方案 A）───────────────────────────────────────
// 仅对「文本字数超限」(normalized > 60000) 触发：截到 60000 字 + 重算 details,
// 而不直接 throw。pages 仍硬抛(扫描件/解析耗时);sections 不再硬抛,仅日志诊断。
//
// codepoint 边界处理:JS slice 按 UTF-16 code unit,如果末尾正好截在 surrogate pair
// 中间(罕见汉字 CJK Ext B/C/D 等),会留下孤立 high surrogate 显示成乱码。
// 这里检测末位 0xD800-0xDBFF → 去掉,保证截断不破坏可读字符。
// 标准文档常用汉字都在 BMP,这条防御只保护极端情况。
function safeTruncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  let cut = text.slice(0, maxLen)
  const lastCode = cut.charCodeAt(cut.length - 1)
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
    cut = cut.slice(0, -1)
  }
  return cut
}

/** 把 details 字段按截断后的 text 重算 — quality 字段是 analyzeTextQuality 的结果 */
function rewriteDetailsForTruncation(
  details: ExtractTextDetails,
  truncatedText: string,
): void {
  const requality = analyzeTextQuality(truncatedText, [truncatedText])
  details.text = truncatedText
  details.normalizedTextLength = requality.normalizedTextLength
  details.compactTextLength = requality.compactTextLength
  details.sectionHintCount = requality.sectionHintCount
  details.validCharCount = requality.validCharCount
  details.validCharRatio = requality.validCharRatio
  // nonEmptyPages 不重算 — 保留原页数(只是做了文本截断,不是少了实际页)。
  // 下游 buildRealCompareReport 不消费这个字段(只用 text),保留原值仅为日志。
}

/** 组装 1v1 截断提示。任一文件被截 → 返回中文提示;都没截 → 返回 undefined。 */
export function buildPairTruncationNote(
  a: { truncated: boolean; originalCharLength: number },
  b: { truncated: boolean; originalCharLength: number },
): string | undefined {
  const fmt = (n: number) => n.toLocaleString('zh-CN')
  const limit = PAIR_PER_FILE_NORMALIZED_LIMIT
  if (a.truncated && b.truncated) {
    return `本次仅分析文档 A 前 ${fmt(limit)} 字（原文 ${fmt(a.originalCharLength)} 字）和文档 B 前 ${fmt(limit)} 字（原文 ${fmt(b.originalCharLength)} 字），超出部分未纳入比对结果。`
  }
  if (a.truncated) {
    return `本次仅分析文档 A 前 ${fmt(limit)} 字（原文 ${fmt(a.originalCharLength)} 字），超出部分未纳入比对结果。`
  }
  if (b.truncated) {
    return `本次仅分析文档 B 前 ${fmt(limit)} 字（原文 ${fmt(b.originalCharLength)} 字），超出部分未纳入比对结果。`
  }
  return undefined
}

function buildPairFileOversizeMsg(
  fileLabel: '文档 A' | '文档 B',
  metric: 'pages' | 'normalized',
  actual: number,
  limit: number,
): string {
  if (metric === 'pages') {
    return `${fileLabel}页数过多（${actual} 页，超过单文件 ${limit} 页限制）。建议拆分后重新上传。本次失败不消耗权益。`
  }
  return `${fileLabel}文字过多（约 ${actual.toLocaleString('zh-CN')} 字，超过单文件 ${limit.toLocaleString('zh-CN')} 字限制）。建议拆分后重新上传。本次失败不消耗权益。`
}

function buildPairTotalOversizeMsg(
  metric: 'pages' | 'normalized',
  actual: number,
  limit: number,
): string {
  if (metric === 'pages') {
    return `两份文档合计页数过多（${actual} 页，超过合计 ${limit} 页限制）。建议拆分后重新上传。本次失败不消耗权益。`
  }
  return `两份文档合计文字过多（约 ${actual.toLocaleString('zh-CN')} 字，超过合计 ${limit.toLocaleString('zh-CN')} 字限制）。建议拆分后重新上传。本次失败不消耗权益。`
}

/** 1v1 单文件超限校验(fileA 或 fileB)。
 *
 * 三轴判定:
 *   pages > 60         → 硬抛(扫描件/解析耗时,不能截)
 *   normalized > 60000 → 截断到 60000 字 + 重算 details + 设 truncated 标志(不抛)
 *   sections > 150     → 仅 logger.warn 诊断,不抛(2026-05-06 起)
 *
 * 章节数取自 sectionHintCount 正则估算,易把目录、列表编号、条款引用、表格编号
 * 误判为章节,不适合作为用户侧硬失败条件。OOM 防线保留页数硬限 + 字数截断。
 *
 * mutate `details` 字段:caller 后续读 `details.text` 直接拿到截断版本。
 *
 * 返回 { truncated, originalCharLength }:
 *   truncated=true 时 caller 组装 truncationNote 传给 buildRealCompareReport
 *   originalCharLength 用于日志和 truncationNote 文案
 */
export function assertPairFileWithinLimit(
  details: ExtractTextDetails,
  fileLabel: '文档 A' | '文档 B',
  taskNo: string = '',
): { truncated: boolean; originalCharLength: number } {
  const fileSide = fileLabel === '文档 A' ? 'A' : 'B'
  const originalCharLength = details.normalizedTextLength

  if (details.nonEmptyPages > PAIR_PER_FILE_PAGE_LIMIT) {
    import('./logger.js').then(({ logger }) => logger.warn({
      module: 'taskWorker', taskNo, stage: 'pair-size-guard', fileSide,
      metric: 'pages', actual: details.nonEmptyPages, limit: PAIR_PER_FILE_PAGE_LIMIT,
    }, '1v1 单文件超限'))
    throw new DocumentExtractError('EXTRACT_FAILED', buildPairFileOversizeMsg(fileLabel, 'pages', details.nonEmptyPages, PAIR_PER_FILE_PAGE_LIMIT))
  }

  // normalized 超限 → 截断而非抛(方案 A)
  let truncated = false
  if (details.normalizedTextLength > PAIR_PER_FILE_NORMALIZED_LIMIT) {
    const truncatedText = safeTruncateText(details.text, PAIR_PER_FILE_NORMALIZED_LIMIT)
    rewriteDetailsForTruncation(details, truncatedText)
    truncated = true
    import('./logger.js').then(({ logger }) => logger.warn({
      module: 'taskWorker', taskNo, stage: 'pair-size-guard', fileSide,
      metric: 'normalized-truncated',
      original: originalCharLength,
      kept: details.normalizedTextLength,
      sectionHintAfter: details.sectionHintCount,
    }, '1v1 单文件文字超限,已截断继续比对'))
  }

  // sections 仅日志诊断,不再硬抛。若超过 PAIR_PER_FILE_SECTION_LIMIT 仅 warn,
  // 任务继续进入比对流程。常量保留作为日志告警阈值。
  if (details.sectionHintCount > PAIR_PER_FILE_SECTION_LIMIT) {
    import('./logger.js').then(({ logger }) => logger.warn({
      module: 'taskWorker', taskNo, stage: 'pair-size-guard', fileSide,
      metric: 'sections-info', actual: details.sectionHintCount, limit: PAIR_PER_FILE_SECTION_LIMIT,
      truncatedFirst: truncated,
    }, '1v1 单文件章节数较多(仅诊断,继续比对)'))
  }

  return { truncated, originalCharLength }
}

/** 1v1 合计超限校验(fileA + fileB),超限 → 服务端 logger.warn 详情 + 抛用户友好 DocumentExtractError */
export function assertPairTotalWithinLimit(
  sourceA: ExtractTextDetails,
  sourceB: ExtractTextDetails,
  taskNo: string = '',
): void {
  const totalPages = sourceA.nonEmptyPages + sourceB.nonEmptyPages
  const totalChars = sourceA.normalizedTextLength + sourceB.normalizedTextLength
  const totalSections = sourceA.sectionHintCount + sourceB.sectionHintCount
  if (totalPages > PAIR_TOTAL_PAGE_LIMIT) {
    import('./logger.js').then(({ logger }) => logger.warn({
      module: 'taskWorker', taskNo, stage: 'pair-size-guard', fileSide: 'A+B',
      metric: 'pages', actual: totalPages, limit: PAIR_TOTAL_PAGE_LIMIT,
    }, '1v1 合计超限'))
    throw new DocumentExtractError('EXTRACT_FAILED', buildPairTotalOversizeMsg('pages', totalPages, PAIR_TOTAL_PAGE_LIMIT))
  }
  if (totalChars > PAIR_TOTAL_NORMALIZED_LIMIT) {
    import('./logger.js').then(({ logger }) => logger.warn({
      module: 'taskWorker', taskNo, stage: 'pair-size-guard', fileSide: 'A+B',
      metric: 'normalized', actual: totalChars, limit: PAIR_TOTAL_NORMALIZED_LIMIT,
    }, '1v1 合计超限'))
    throw new DocumentExtractError('EXTRACT_FAILED', buildPairTotalOversizeMsg('normalized', totalChars, PAIR_TOTAL_NORMALIZED_LIMIT))
  }
  // sections 仅日志诊断,不再硬抛(2026-05-06 起)。常量保留作为告警阈值。
  if (totalSections > PAIR_TOTAL_SECTION_LIMIT) {
    import('./logger.js').then(({ logger }) => logger.warn({
      module: 'taskWorker', taskNo, stage: 'pair-size-guard', fileSide: 'A+B',
      metric: 'sections-info', actual: totalSections, limit: PAIR_TOTAL_SECTION_LIMIT,
    }, '1v1 合计章节数较多(仅诊断,继续比对)'))
  }
}

// 需要外部注入的依赖（避免循环引用）
let _callDedupService: (path: string, body: Record<string, unknown>) => Promise<any>
let _buildRealCompareReport: (opts: any) => any
let _buildCompareReport: (opts: any) => any
let _standards: any[]

export function initWorker(deps: {
  callDedupService: typeof _callDedupService
  buildRealCompareReport: typeof _buildRealCompareReport
  buildCompareReport: typeof _buildCompareReport
  standards: any[]
}) {
  _callDedupService = deps.callDedupService
  _buildRealCompareReport = deps.buildRealCompareReport
  _buildCompareReport = deps.buildCompareReport
  _standards = deps.standards
}

let running = false

function normalizeFailureCode(code?: string | null): TaskFailureCode {
  if (code === 'OCR_FAILED' || code === 'DEPENDENCY_MISSING') return 'OCR_FAILED'
  if (code === 'TEXT_INSUFFICIENT') return 'TEXT_INSUFFICIENT'
  return 'EXTRACT_FAILED'
}

function buildProvidedTextDetails(text: string): ExtractTextDetails {
  const normalizedText = extractTextFromString(text)
  const quality = analyzeTextQuality(normalizedText, [normalizedText])
  return {
    text: normalizedText,
    method: 'provided_text',
    pages: normalizedText ? 1 : 0,
    rawTextLength: quality.rawTextLength,
    normalizedTextLength: quality.normalizedTextLength,
    compactTextLength: quality.compactTextLength,
    nonEmptyPages: quality.nonEmptyPages,
    validCharCount: quality.validCharCount,
    validCharRatio: quality.validCharRatio,
    sectionHintCount: quality.sectionHintCount,
    errorCode: null,
    error: null,
    ocrErrorCode: null,
  }
}

function logExtractDetails(taskNo: string, stage: string, details: ExtractTextDetails) {
  console.log(
    `[taskWorker] extract task=${taskNo} stage=${stage} method=${details.method} raw=${details.rawTextLength} normalized=${details.normalizedTextLength} compact=${details.compactTextLength} nonEmptyPages=${details.nonEmptyPages} validRatio=${details.validCharRatio} sections=${details.sectionHintCount} ocrErrorCode=${details.ocrErrorCode ?? 'none'}`
  )
}

function ensureWorkerTextReady(
  taskNo: string,
  stage: string,
  details: ExtractTextDetails,
  source: 'file' | 'body',
  isOneToOne: boolean = false
) {
  logExtractDetails(taskNo, stage, details)

  const looksBlank = details.normalizedTextLength === 0 || details.compactTextLength === 0
  const looksNoisy = details.validCharCount < 40 || details.validCharRatio < 0.35
  const tooShort = details.normalizedTextLength < 80 || details.compactTextLength < 50
  // emptyStructure 是为「标准草稿必有 1.x 编号」假设设计的,只对全库/选库模式生效。
  // 1对1 的预期场景包含「任意两份文档对比」(企业制度/合同/培训材料……),
  // 不能用「没有 1.x 编号 = 垃圾输入」这条规则误伤。
  const emptyStructure = !isOneToOne
    && source === 'file'
    && details.sectionHintCount === 0
    && details.compactTextLength < 240

  if (looksBlank || looksNoisy || tooShort || emptyStructure) {
    throw new DocumentExtractError(
      'TEXT_INSUFFICIENT',
      '文档提取结果不足，无法继续比对。请上传文字版 PDF / Word 文档，或检查 OCR 服务是否可用。',
      details
    )
  }
}

export async function failCompareTask(taskNo: string, failureCode: TaskFailureCode, message: string) {
  const task = await prisma.compareTask.findUnique({ where: { taskNo }, select: { userId: true, compareMode: true } }).catch(() => null)
  const failed = await prisma.compareTask.updateMany({
    where: { taskNo, status: 'PROCESSING' },
    data: {
      status: 'FAILED',
      errorMessage: `[${failureCode}] ${message}`,
      summaryJson: JSON.stringify({ failureCode, stage: 'extract' }),
      finishedAt: new Date(),
    },
  }).catch(() => ({ count: 0 }))
  if (failed.count === 1) {
    trackServerEvent('compare_fail', { taskNo, mode: task?.compareMode, error_reason: failureCode }, task?.userId)
  }
}

function classifyTaskFailure(err: any): { failureCode: TaskFailureCode; message: string } {
  if (err instanceof DocumentExtractError) {
    const failureCode = normalizeFailureCode(err.code)
    return { failureCode, message: err.message }
  }

  const rawMsg = err?.message || '比对失败'
  if (rawMsg.includes('timestamp expired')) {
    return { failureCode: 'EXTRACT_FAILED', message: '比对服务内部通信超时，请重新提交' }
  }
  if (rawMsg.includes('ECONNREFUSED')) {
    return { failureCode: 'EXTRACT_FAILED', message: '比对服务暂不可用，请稍后重试' }
  }
  if (rawMsg.includes('文字过少') || rawMsg.includes('无法识别')) {
    return { failureCode: 'TEXT_INSUFFICIENT', message: rawMsg }
  }
  return {
    failureCode: 'EXTRACT_FAILED',
    message: `比对处理失败，请重试（${rawMsg.slice(0, 60)}）`,
  }
}

async function resolveSourceText(
  taskNo: string,
  stage: string,
  filePath: string,
  bodySourceText: string,
  maxPages?: number,
  isOneToOne: boolean = false
): Promise<ExtractTextDetails> {
  if (filePath) {
    const details = await extractTextDetailed(filePath, maxPages)
    ensureWorkerTextReady(taskNo, stage, details, 'file', isOneToOne)
    return details
  }

  if (bodySourceText) {
    const details = buildProvidedTextDetails(bodySourceText)
    ensureWorkerTextReady(taskNo, stage, details, 'body', isOneToOne)
    return details
  }

  throw new DocumentExtractError('EXTRACT_FAILED', '未找到可比对的文档内容')
}

// ─── 异步状态机模式（BXZ_TASK_ASYNC_MODE=1 启用）─────────────
//
// 任务对外 status 仍然只有 PENDING/PROCESSING/COMPLETED/FAILED 四个值。
// processingStage 是子状态，仅 worker 内部用：
//   PENDING_INIT     刚领到 PENDING task，下一 tick 提交 extract job
//   EXTRACT_A_WAIT   A 文档 extract job 已提交，轮询中
//   EXTRACT_B_WAIT   B 文档 extract job 已提交（仅 1对1）
//   REPORTING        所有 extract 完成，正在跑 dedup report (同步) / 写库
//   （null = 没用异步模式 / 已 COMPLETED / FAILED）
//
// 异步模式下 extract 文本结果存到 intakeJson.extractedSourceText / extractedTargetText，
// REPORTING 阶段调用旧的 processLibrary/processPair 时用 bodySourceText/targetBodyText
// 短路掉 extractTextDetailed，复用既有 buildRealCompareReport 等代码。
//
// 单 slot 一 tick 只推进一个阶段（提交一次 / 轮询一次 / 调一次 report）。
// in-process Set 防止两 slot 同时动一个 task。

const ASYNC_MODE = process.env.BXZ_TASK_ASYNC_MODE === '1'
const STAGE_TIMEOUT_MS = 30 * 60 * 1000  // 单阶段超时 30 分钟，超过 → FAILED
const POLL_INTERVAL_MS = 2000             // tick 间隔
const inFlight = new Set<string>()        // worker 进程内 soft lock

// 同步模式无阶段超时，进程崩溃后 PROCESSING 任务永久挂起。
// 每 5 分钟扫一次：createdAt 超过 20 分钟仍 PROCESSING → 重置 PENDING 让其他 slot 重试。
// 用 createdAt 而非 updatedAt 的原因：CompareTask 模型当前没有 @updatedAt 字段
// （生产 db 实测无此列）；引入 updatedAt 需 schema migration，留到 1.0.1 一起做。
// 20 分钟阈值 = 单任务最长 ~5min × 4 倍缓冲，避开队列长 + 正常处理叠加误杀。
const STUCK_SWEEP_INTERVAL_MS = 5 * 60 * 1000
const STUCK_THRESHOLD_MS = 20 * 60 * 1000
let stuckSweeperTimer: NodeJS.Timeout | null = null

async function sweepStuckProcessing(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS)
    const result = await prisma.compareTask.updateMany({
      where: {
        status: 'PROCESSING',
        createdAt: { lt: cutoff },
      },
      data: { status: 'PENDING' },
    })
    if (result.count > 0) {
      console.warn(`[taskWorker stuck-sweeper] 重置 ${result.count} 条卡死 PROCESSING 任务 → PENDING`)
    }
  } catch (err: any) {
    console.error('[taskWorker stuck-sweeper] 清扫异常:', err?.message || err)
  }
}

function startStuckSweeper(): void {
  if (stuckSweeperTimer) return
  // 启动时立即跑一次（捕获上次进程崩溃遗留），之后每 5 分钟一次
  sweepStuckProcessing()
  stuckSweeperTimer = setInterval(sweepStuckProcessing, STUCK_SWEEP_INTERVAL_MS)
}

export function startWorker(intervalMs = 3000, concurrency = 2) {
  if (running) return
  running = true
  startStuckSweeper()
  if (ASYNC_MODE) {
    import('./logger.js').then(({ logger }) => logger.info({ module: 'taskWorker', mode: 'async', concurrency, tickMs: POLL_INTERVAL_MS }, '已启动'))
    for (let slotId = 0; slotId < concurrency; slotId++) {
      const slotLoop = async () => {
        while (running) {
          try {
            const did = await asyncTick(slotId)
            await sleep(did ? 50 : POLL_INTERVAL_MS)
          } catch (err) {
            console.error(`[taskWorker async slot ${slotId}] 未捕获错误:`, err)
            await sleep(POLL_INTERVAL_MS)
          }
        }
      }
      slotLoop()
    }
    return
  }

  import('./logger.js').then(({ logger }) => logger.info({ module: 'taskWorker', mode: 'sync', concurrency, intervalMs }, '已启动'))
  for (let slotId = 0; slotId < concurrency; slotId++) {
    const slotLoop = async () => {
      while (running) {
        try {
          const claimed = await processNextTask(slotId)
          if (!claimed) {
            await sleep(intervalMs)
          }
        } catch (err) {
          console.error(`[taskWorker slot ${slotId}] 未捕获错误:`, err)
          await sleep(intervalMs)
        }
      }
    }
    slotLoop()
  }
}

// processingStage 进入 SET 子句前必须经过白名单校验（防御性硬闸门）：
// claimNextTask 用的是 $queryRawUnsafe 拼接 SQL，当前调用方都传常量，
// 但只要白名单里没有的值进来就直接 throw，杜绝结构性 SQL 注入风险。
const ALLOWED_PROCESSING_STAGES = new Set([
  'PENDING_INIT',
  'EXTRACT_A_WAIT',
  'EXTRACT_B_WAIT',
  'REPORTING',
] as const)

function buildClaimSetClause(processingStage?: string | null): string {
  const clauses = [`status = 'PROCESSING'`]
  if (processingStage !== undefined) {
    if (processingStage === null) {
      clauses.push(`"processingStage" = NULL`)
    } else {
      if (!ALLOWED_PROCESSING_STAGES.has(processingStage as any)) {
        throw new Error(`buildClaimSetClause: 非法 processingStage='${processingStage}'，仅允许 ${[...ALLOWED_PROCESSING_STAGES].join('/')}`)
      }
      clauses.push(`"processingStage" = '${processingStage}'`)
    }
    clauses.push(`"stageStartedAt" = CURRENT_TIMESTAMP`)
  }
  return clauses.join(',\n         ')
}

export async function claimNextTask(processingStage?: string | null): Promise<any | null> {
  const setClause = buildClaimSetClause(processingStage)
  const claimed: any[] = IS_POSTGRES
    ? await prisma.$queryRawUnsafe(
        `WITH next AS (
           SELECT id
           FROM "CompareTask"
           WHERE status = 'PENDING'
           ORDER BY priority ASC, "createdAt" ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE "CompareTask" AS t
         SET ${setClause}
         FROM next
         WHERE t.id = next.id
         RETURNING t.*`
      )
    : await prisma.$queryRawUnsafe(
        `UPDATE "CompareTask"
         SET ${setClause}
         WHERE id = (
           SELECT id FROM "CompareTask"
           WHERE status = 'PENDING'
           ORDER BY priority ASC, "createdAt" ASC
           LIMIT 1
         )
         RETURNING *`
      )
  return claimed[0] || null
}

// 返回值：true = 领取并处理了一条 task；false = 当前没有 PENDING task 可领
async function processNextTask(slotId: number = 0): Promise<boolean> {
  const task = await claimNextTask()

  if (!task) return false

  console.log(`[taskWorker slot ${slotId}] 领取: ${task.taskNo} (${task.compareMode}, priority=${task.priority})`)

  try {
    const meta = task.intakeJson ? JSON.parse(task.intakeJson) : {}
    const fileAPath = meta.fileAPath || ''
    const fileBPath = meta.fileBPath || ''
    const fileBName = meta.fileBName || ''
    const bodySourceText = meta.sourceText || ''
    const title = meta.title || task.documentName.replace(/\.[^.]+$/, '')

    if (task.compareMode === 'library') {
      await processLibrary(task, fileAPath, bodySourceText, title)
    } else {
      await processPair(task, fileAPath, fileBPath, bodySourceText, fileBName)
    }
  } catch (err: any) {
    console.error(`[taskWorker slot ${slotId}] 任务 ${task.taskNo} 失败:`, err)
    const { failureCode, message } = classifyTaskFailure(err)
    await failCompareTask(task.taskNo, failureCode, message)
  }

  return true
}

async function processLibrary(task: any, filePath: string, bodySourceText: string, title: string) {
  const source = await resolveSourceText(task.taskNo, 'library:source', filePath, bodySourceText)
  const sourceText = source.text

  const dedupReport = await _callDedupService('/internal/report', {
    text: sourceText,
    title,
    ics_hint: '',
    top_n: 20,
  })

  const sanitizedSimilar = (dedupReport.top_similar || []).map((s: any) => ({
    code: s.code, name: s.name, overall_score: s.overall_score,
    title_sim: s.title_sim, content_sim: s.content_sim, structure_sim: s.structure_sim,
    reference_sim: s.reference_sim, term_sim: s.term_sim,
    matched_sections: s.matched_sections, matched_refs: s.matched_refs, matched_terms: s.matched_terms,
  }))

  const reportForStorage = { ...dedupReport, top_similar: sanitizedSimilar }
  if (reportForStorage.stats) delete reportForStorage.stats.processing_ms

  const completed = await prisma.compareTask.updateMany({
    where: { taskNo: task.taskNo, status: 'PROCESSING' },
    data: {
      status: 'COMPLETED',
      summaryJson: JSON.stringify({
        freeRisk: dedupReport.free_risk || [],
        riskLevel: dedupReport.risk_level || '',
        riskLabel: dedupReport.risk_label || '',
      }),
      reportJson: JSON.stringify(reportForStorage),
      finishedAt: new Date(),
    },
  })
  if (completed.count !== 1) {
    console.warn(`[taskWorker] 跳过重复完成: ${task.taskNo} (library)`)
    return
  }
  console.log(`[taskWorker] 任务 ${task.taskNo} (library) 完成`)
  trackServerEvent('compare_complete', {
    mode: 'library',
    taskNo: task.taskNo,
    duration_sec: Math.round((Date.now() - new Date(task.createdAt).getTime()) / 1000),
    match_count: dedupReport.top_similar?.length ?? 0,
  }, task.userId)
  markUserActive(task.userId)

  // 任务落库成功后清理上传原件（容错，删失败只记日志）
  await cleanupUploadFiles(task.taskNo, [filePath])
}

async function processPair(
  task: any,
  fileAPath: string,
  fileBPath: string,
  bodySourceText: string,
  fileBName: string,
  targetBodyText: string = ''
) {
  const isOneToOne = task.compareMode === 'ONE_TO_ONE' || task.compareMode === 'pair'
  const pageLimit = isOneToOne ? 30 : undefined
  const selectedStandardIds: string[] = (() => {
    try { return JSON.parse(task.selectedStandardIds || '[]') } catch { return [] }
  })()

  const source = await resolveSourceText(task.taskNo, 'pair:source', fileAPath, bodySourceText, pageLimit, isOneToOne)

  // 🔒 fileA 提取后立即超限校验(1v1 模式)
  // 返回值 {truncated, originalCharLength}: normalized 超限会就地截断 source.text + 重算 details
  // pages / sections 仍硬抛
  let truncationA: { truncated: boolean; originalCharLength: number } = { truncated: false, originalCharLength: 0 }
  let truncationB: { truncated: boolean; originalCharLength: number } = { truncated: false, originalCharLength: 0 }
  if (isOneToOne) {
    truncationA = assertPairFileWithinLimit(source, '文档 A', task.taskNo)
  }
  // 截断后再读 sourceText,确保下游 buildRealCompareReport 拿到的是截后版本
  const sourceText = source.text

  let targets: Array<{ code: string; title: string; type: string; textContent: string }>

  if (isOneToOne) {
    // ─── 1对1 真比对 ────────────────────────────────────────────
    // B1 bug 修复（原行为：fileB 提取后 targetText 被丢弃，targets 仍取自 _standards）
    // 同步模式：必须有 fileB；异步状态机模式：targetBodyText 已预提取。
    // fileB 解出的文本作为唯一对比目标，绕过 _standards 全库。
    if (!fileBPath && !targetBodyText) {
      throw new DocumentExtractError(
        'EXTRACT_FAILED',
        '1对1 比对必须上传对比文档（B 文档）。系统未收到对比方文件，已终止任务。'
      )
    }
    const target = await resolveSourceText(
      task.taskNo,
      'pair:target',
      targetBodyText ? '' : fileBPath,
      targetBodyText,
      30,
      true
    )

    // 🔒 fileB 单独超限校验(同样三轴: pages 抛 / normalized 截 / sections 抛)
    truncationB = assertPairFileWithinLimit(target, '文档 B', task.taskNo)
    // 合计超限校验:用截后的 source/target 算合计,如仍合计超限说明两边都很长 → 抛
    assertPairTotalWithinLimit(source, target, task.taskNo)

    const targetText = target.text
    if (targetText.length < 50) {
      throw new DocumentExtractError(
        'TEXT_INSUFFICIENT',
        '对比文档（B 文档）有效文字过少，无法进行 1对1 比对'
      )
    }
    if (sourceText.length < 50) {
      throw new DocumentExtractError(
        'TEXT_INSUFFICIENT',
        '主文档（A 文档）有效文字过少，无法进行 1对1 比对'
      )
    }
    targets = [{
      code: 'USER_B',
      title: fileBName || '用户上传文档 B',
      type: '用户文档',
      textContent: targetText,
    }]
  } else {
    // 选库模式（非 1对1）：保持原行为，对全库切片
    targets = _standards
      .filter(item => selectedStandardIds.includes(item.id) || selectedStandardIds.length === 0)
      .slice(0, 5)
      .map(item => ({
        code: item.code, title: item.title,
        type: item.library === 'group' ? '团标' : '国标',
        textContent: item.chapters.map((ch: any) => `${ch.title}\n${ch.paragraphs.join('\n')}`).join('\n\n'),
      }))
  }

  // 组装截断提示(任一文件被截 → 报告头部展示)
  const truncationNote = buildPairTruncationNote(truncationA, truncationB)

  const report = sourceText.length >= 50
    ? _buildRealCompareReport({ taskNo: task.taskNo, documentName: task.documentName, sourceText, targets, compareMode: task.compareMode, truncationNote })
    : _buildCompareReport({ taskNo: task.taskNo, documentName: task.documentName, selectedStandardIds, compareMode: task.compareMode })

  const completed = await prisma.compareTask.updateMany({
    where: { taskNo: task.taskNo, status: 'PROCESSING' },
    data: {
      status: 'COMPLETED',
      summaryJson: JSON.stringify({ freeRisk: report.freeRisk }),
      reportJson: JSON.stringify(report),
      finishedAt: new Date(),
    },
  })
  if (completed.count !== 1) {
    console.warn(`[taskWorker] 跳过重复完成: ${task.taskNo} (pair)`)
    return
  }
  console.log(`[taskWorker] 任务 ${task.taskNo} (pair) 完成`)
  trackServerEvent('compare_complete', {
    mode: 'one_to_one',
    taskNo: task.taskNo,
    duration_sec: Math.round((Date.now() - new Date(task.createdAt).getTime()) / 1000),
  }, task.userId)
  markUserActive(task.userId)

  // 任务落库成功后清理上传原件（容错，删失败只记日志）
  // 1对1 模式删 fileA + fileB；选库模式没有 fileB
  await cleanupUploadFiles(task.taskNo, [fileAPath, fileBPath])
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── 异步状态机实现 ─────────────────────────────────────────

type TaskRow = any

function parseMeta(task: TaskRow): any {
  try { return task.intakeJson ? JSON.parse(task.intakeJson) : {} }
  catch { return {} }
}

async function writeMeta(taskNo: string, meta: any): Promise<void> {
  await prisma.compareTask.update({
    where: { taskNo },
    data: { intakeJson: JSON.stringify(meta) },
  })
}

async function setStage(taskNo: string, stage: string, dedupJobId?: string | null): Promise<void> {
  const data: any = {
    processingStage: stage,
    stageStartedAt: new Date(),
    status: 'PROCESSING',
  }
  if (dedupJobId !== undefined) data.dedupJobId = dedupJobId
  await prisma.compareTask.update({ where: { taskNo }, data })
}

async function failStage(taskNo: string, code: TaskFailureCode, message: string): Promise<void> {
  await failCompareTask(taskNo, code, message)
}

async function asyncTick(slotId: number): Promise<boolean> {
  // 1. 优先推进已经在跑的 task（PROCESSING）
  const advanced = await tryAdvanceInFlightTask(slotId)
  if (advanced) return true
  // 2. 没有 in-flight 可推进 → 领一条 PENDING
  const picked = await tryPickPendingTask(slotId)
  return picked
}

async function tryPickPendingTask(slotId: number): Promise<boolean> {
  const task = await claimNextTask('PENDING_INIT')
  if (!task) return false
  console.log(`[taskWorker async slot ${slotId}] 领取 PENDING: ${task.taskNo} → PENDING_INIT`)
  // 立即推进一步（提交 extract job）
  inFlight.add(task.taskNo)
  try {
    await advanceTaskOneStep(task)
  } finally {
    inFlight.delete(task.taskNo)
  }
  return true
}

async function tryAdvanceInFlightTask(slotId: number): Promise<boolean> {
  // 找一条 PROCESSING 且不在 in-flight Set 里的 task
  // 不能用纯 SQL UPDATE...RETURNING 排除内存 Set，所以分两步：SELECT 候选 → JS 过滤 → 单条 take
  // PG 注意：表名/驼峰字段名必须双引号。
  const candidates: any[] = await prisma.$queryRawUnsafe(
    `SELECT * FROM "CompareTask"
     WHERE status = 'PROCESSING'
       AND "processingStage" IN ('PENDING_INIT','EXTRACT_A_WAIT','EXTRACT_B_WAIT','REPORTING')
     ORDER BY priority ASC, "createdAt" ASC
     LIMIT 10`
  )
  for (const task of candidates) {
    if (inFlight.has(task.taskNo)) continue
    inFlight.add(task.taskNo)
    try {
      await advanceTaskOneStep(task)
    } finally {
      inFlight.delete(task.taskNo)
    }
    return true
  }
  return false
}

async function advanceTaskOneStep(task: TaskRow): Promise<void> {
  // 阶段超时检查：stageStartedAt 距今 > STAGE_TIMEOUT_MS → 直接 FAIL
  if (task.stageStartedAt) {
    const elapsed = Date.now() - new Date(task.stageStartedAt).getTime()
    if (elapsed > STAGE_TIMEOUT_MS) {
      console.error(
        `[taskWorker async] ${task.taskNo} stage=${task.processingStage} 超时 ${Math.round(elapsed/1000)}s`
      )
      await failStage(task.taskNo, 'EXTRACT_FAILED', `处理阶段 ${task.processingStage} 超时（>30 分钟），请重新提交`)
      return
    }
  }

  const stage = task.processingStage as string
  try {
    if (stage === 'PENDING_INIT') {
      await stageSubmitExtractA(task)
    } else if (stage === 'EXTRACT_A_WAIT') {
      await stagePollExtractA(task)
    } else if (stage === 'EXTRACT_B_WAIT') {
      await stagePollExtractB(task)
    } else if (stage === 'REPORTING') {
      await stageReporting(task)
    } else {
      console.warn(`[taskWorker async] ${task.taskNo} 未知 stage: ${stage}`)
    }
  } catch (err: any) {
    console.error(`[taskWorker async] ${task.taskNo} stage=${stage} 失败:`, err)
    const { failureCode, message } = classifyTaskFailure(err)
    await failStage(task.taskNo, failureCode, message)
  }
}

async function stageSubmitExtractA(task: TaskRow): Promise<void> {
  const meta = parseMeta(task)
  const fileAPath = meta.fileAPath || ''
  const bodySourceText = meta.sourceText || ''
  // 没有 file → 用 body text 直接跳到 reporting
  if (!fileAPath) {
    if (bodySourceText) {
      meta.extractedSourceText = bodySourceText
      await writeMeta(task.taskNo, meta)
      await setStage(task.taskNo, 'REPORTING', null)
      return
    }
    throw new DocumentExtractError('EXTRACT_FAILED', '未找到可比对的文档内容')
  }
  // 非 PDF 文件（docx/txt/md）走旧同步路径，dedup 不处理这些
  if (!/\.pdf$/i.test(fileAPath)) {
    const details = await extractTextDetailed(fileAPath)
    meta.extractedSourceText = details.text
    await writeMeta(task.taskNo, meta)
    await setStage(task.taskNo, decideAfterExtractA(task), null)
    return
  }
  const isOneToOne = task.compareMode === 'ONE_TO_ONE' || task.compareMode === 'pair'
  const pageLimit = isOneToOne ? 30 : undefined
  const { basename } = await import('path')
  const jobId = await submitExtractTextJob(fileAPath, basename(fileAPath), pageLimit)
  await setStage(task.taskNo, 'EXTRACT_A_WAIT', jobId)
  console.log(`[taskWorker async] ${task.taskNo} EXTRACT_A 已提交 jobId=${jobId}`)
}

function decideAfterExtractA(task: TaskRow): string {
  const meta = parseMeta(task)
  const isOneToOne = task.compareMode === 'ONE_TO_ONE' || task.compareMode === 'pair'
  if (isOneToOne && meta.fileBPath) return 'EXTRACT_B_WAIT_INIT'
  return 'REPORTING'
}

async function stagePollExtractA(task: TaskRow): Promise<void> {
  if (!task.dedupJobId) {
    throw new DocumentExtractError('EXTRACT_FAILED', '内部状态错误：EXTRACT_A_WAIT 无 jobId')
  }
  let result: ExtractJobPollResult
  try {
    result = await pollExtractTextJob(task.dedupJobId)
  } catch (pollErr: any) {
    // poll HTTP 超时不直接 FAIL task，等下一 tick 重试（dedup worker 可能暂时繁忙）
    console.warn(`[taskWorker async] ${task.taskNo} poll A 暂时失败: ${pollErr.message}，下一 tick 重试`)
    return
  }
  if (result.status === 'pending' || result.status === 'running') {
    return  // 下一 tick 继续轮询
  }
  if (result.status === 'not_found') {
    // dedup 重启 / TTL 过期 → fallback 到旧同步路径，inline 把 A（必要时也 B）提取完，直接 REPORTING
    console.warn(`[taskWorker async] ${task.taskNo} job ${task.dedupJobId} not_found，fallback 同步`)
    const meta = parseMeta(task)
    const isOneToOne = task.compareMode === 'ONE_TO_ONE' || task.compareMode === 'pair'
    const details = await extractTextDetailed(meta.fileAPath, isOneToOne ? 30 : undefined)
    meta.extractedSourceText = details.text
    if (isOneToOne && meta.fileBPath) {
      const detB = await extractTextDetailed(meta.fileBPath, 30)
      meta.extractedTargetText = detB.text
    }
    await writeMeta(task.taskNo, meta)
    await setStage(task.taskNo, 'REPORTING', null)
    return
  }
  if (result.status === 'failed') {
    throw new DocumentExtractError(result.errorCode, result.error)
  }
  // done
  const meta = parseMeta(task)
  const isOneToOne = task.compareMode === 'ONE_TO_ONE' || task.compareMode === 'pair'
  ensureWorkerTextReady(task.taskNo, 'async:extract-a', result.details, 'file', isOneToOne)
  meta.extractedSourceText = result.details.text
  await writeMeta(task.taskNo, meta)
  if (isOneToOne && meta.fileBPath) {
    // 下一 tick 提交 B 文档；这里直接 inline 提交以减少 tick 次数
    const { basename } = await import('path')
    if (!/\.pdf$/i.test(meta.fileBPath)) {
      const detB = await extractTextDetailed(meta.fileBPath, 30)
      meta.extractedTargetText = detB.text
      await writeMeta(task.taskNo, meta)
      await setStage(task.taskNo, 'REPORTING', null)
      return
    }
    const jobId = await submitExtractTextJob(meta.fileBPath, basename(meta.fileBPath), 30)
    await setStage(task.taskNo, 'EXTRACT_B_WAIT', jobId)
    console.log(`[taskWorker async] ${task.taskNo} EXTRACT_B 已提交 jobId=${jobId}`)
  } else {
    await setStage(task.taskNo, 'REPORTING', null)
  }
}

async function stagePollExtractB(task: TaskRow): Promise<void> {
  if (!task.dedupJobId) {
    throw new DocumentExtractError('EXTRACT_FAILED', '内部状态错误：EXTRACT_B_WAIT 无 jobId')
  }
  let result: ExtractJobPollResult
  try {
    result = await pollExtractTextJob(task.dedupJobId)
  } catch (pollErr: any) {
    console.warn(`[taskWorker async] ${task.taskNo} poll B 暂时失败: ${pollErr.message}，下一 tick 重试`)
    return
  }
  if (result.status === 'pending' || result.status === 'running') return
  if (result.status === 'not_found') {
    const meta = parseMeta(task)
    console.warn(`[taskWorker async] ${task.taskNo} job ${task.dedupJobId} not_found，B 文档 fallback 同步`)
    const detB = await extractTextDetailed(meta.fileBPath, 30)
    meta.extractedTargetText = detB.text
    await writeMeta(task.taskNo, meta)
    await setStage(task.taskNo, 'REPORTING', null)
    return
  }
  if (result.status === 'failed') {
    throw new DocumentExtractError(result.errorCode, result.error)
  }
  // done
  const meta = parseMeta(task)
  ensureWorkerTextReady(task.taskNo, 'async:extract-b', result.details, 'file', true)
  meta.extractedTargetText = result.details.text
  await writeMeta(task.taskNo, meta)
  await setStage(task.taskNo, 'REPORTING', null)
}

async function stageReporting(task: TaskRow): Promise<void> {
  // 复用旧 processLibrary / processPair，extract 已经完成 → bodySourceText / targetBodyText 短路
  const meta = parseMeta(task)
  const fileAPath = meta.fileAPath || ''
  const fileBPath = meta.fileBPath || ''
  const fileBName = meta.fileBName || ''
  const bodySourceText = meta.extractedSourceText || meta.sourceText || ''
  const targetBodyText = meta.extractedTargetText || ''
  const title = meta.title || task.documentName.replace(/\.[^.]+$/, '')

  if (task.compareMode === 'library') {
    // 全库：bodySourceText 已就绪，processLibrary 走 buildProvidedTextDetails 短路
    await processLibrary(task, '' /* 不再传 filePath */, bodySourceText, title)
  } else {
    await processPair(task, '' /* fileA 不再读 */, fileBPath, bodySourceText, fileBName, targetBodyText)
  }
  // processLibrary / processPair 内部已经 cleanupUploadFiles + 写 COMPLETED
  // 但它们不知道还有 fileA（我们传了空）→ 在这里补一刀清 fileA
  if (fileAPath) await cleanupUploadFiles(task.taskNo, [fileAPath])
}
