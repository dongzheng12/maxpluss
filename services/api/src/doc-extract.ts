/**
 * 文档文本提取 — 支持 PDF / DOCX / TXT
 *
 * 主链路：
 *   上传文件 → extractTextDetailed() 提取正文 + 质量指标 → 送 dedup 服务比对
 */
import { readFileSync } from 'fs'
import { basename, extname } from 'path'
import * as http from 'http'
import * as https from 'https'
import * as crypto from 'crypto'

export type ExtractFailureCode =
  | 'EXTRACT_FAILED'
  | 'OCR_FAILED'
  | 'TEXT_INSUFFICIENT'
  | 'DEPENDENCY_MISSING'
  | 'SYSTEM_FAILURE'

export type TextQuality = {
  rawTextLength: number
  normalizedTextLength: number
  compactTextLength: number
  nonEmptyPages: number
  validCharCount: number
  validCharRatio: number
  sectionHintCount: number
  isMeaningful: boolean
}

export type ExtractTextDetails = {
  text: string
  method: string
  pages: number
  rawTextLength: number
  normalizedTextLength: number
  compactTextLength: number
  nonEmptyPages: number
  validCharCount: number
  validCharRatio: number
  sectionHintCount: number
  errorCode?: string | null
  error?: string | null
  ocrErrorCode?: string | null
}

const MIN_STRIPPED_LENGTH = 80
const MIN_COMPACT_LENGTH = 50
const MIN_VALID_CHAR_COUNT = 40
const MIN_VALID_CHAR_RATIO = 0.35
const MIN_NON_EMPTY_PAGES = 1
const MIN_PAGE_COMPACT_LENGTH = 10

const DEDUP_BASE = process.env.DEDUP_SERVICE_URL || 'http://127.0.0.1:8067'
const WATERMARK_RE = /学兔兔|bzfxw|www\.|标准下载|标准网|标准分享/i
const VALID_TEXT_CHAR_RE = /[\u4e00-\u9fffA-Za-z0-9]/g
const SECTION_HINT_RE = /^(\d+(?:\.\d+)*)\s+[\u4e00-\u9fffA-Za-z]/gm
const LOOSE_SECTION_HINT_RE = /(?:^|[^\d.])\d+\s*\.\s*\d+(?:\s*\.\s*\d+){0,2}\s*[\u4e00-\u9fffA-Za-z]/g
const SPACED_CJK_RE = /(?:[\u4e00-\u9fff]\s+){4,}[\u4e00-\u9fff]/g

export class DocumentExtractError extends Error {
  code: ExtractFailureCode
  details?: Partial<ExtractTextDetails>

  constructor(code: ExtractFailureCode, message: string, details?: Partial<ExtractTextDetails>) {
    super(message)
    this.name = 'DocumentExtractError'
    this.code = code
    this.details = details
  }
}

export async function extractText(filePath: string, maxPages?: number): Promise<string> {
  const details = await extractTextDetailed(filePath, maxPages)
  return details.text
}

export async function extractStandardSourceText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase()
  const buf = readFileSync(filePath)
  const name = basename(filePath)

  switch (ext) {
    case '.pdf':
      return (await extractPdfTextDetailed(buf, name)).text
    case '.docx':
    case '.doc':
      return (await buildLocalExtractResult(await extractDocxText(buf), 'mammoth')).text
    case '.txt':
    case '.md':
      return (await buildLocalExtractResult(buf.toString('utf-8'), 'plain')).text
    default:
      throw new DocumentExtractError('EXTRACT_FAILED', `不支持的文件类型: ${ext}`)
  }
}

export async function extractTextDetailed(filePath: string, maxPages?: number): Promise<ExtractTextDetails> {
  const ext = extname(filePath).toLowerCase()
  const buf = readFileSync(filePath)
  const name = basename(filePath)

  switch (ext) {
    case '.pdf':
      return extractPdfTextDetailed(buf, name, maxPages)
    case '.docx':
    case '.doc':
      return buildLocalExtractResult(await extractDocxText(buf), 'mammoth')
    case '.txt':
    case '.md':
      return buildLocalExtractResult(buf.toString('utf-8'), 'plain')
    default:
      throw new DocumentExtractError('EXTRACT_FAILED', `不支持的文件类型: ${ext}`)
  }
}

function normalizeText(text: string): string {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
}

function compactText(text: string): string {
  return text.replace(/\s+/g, '')
}

export function analyzeTextQuality(text: string, pageTexts: string[] = [text]): TextQuality {
  const rawText = text || ''
  const normalized = normalizeText(rawText)
  const compact = compactText(normalized)
  const validCharCount = (compact.match(VALID_TEXT_CHAR_RE) || []).length
  const validCharRatio = compact.length > 0 ? validCharCount / compact.length : 0
  const nonEmptyPages = pageTexts.filter(page => compactText(page || '').length >= MIN_PAGE_COMPACT_LENGTH).length
  const sectionHintCount = (normalized.match(SECTION_HINT_RE) || []).length
  const strippedLength = rawText.trim().length

  const isMeaningful =
    strippedLength >= MIN_STRIPPED_LENGTH &&
    compact.length >= MIN_COMPACT_LENGTH &&
    validCharCount >= MIN_VALID_CHAR_COUNT &&
    validCharRatio >= MIN_VALID_CHAR_RATIO &&
    nonEmptyPages >= MIN_NON_EMPTY_PAGES

  return {
    rawTextLength: rawText.length,
    normalizedTextLength: normalized.length,
    compactTextLength: compact.length,
    nonEmptyPages,
    validCharCount,
    validCharRatio: Number(validCharRatio.toFixed(4)),
    sectionHintCount,
    isMeaningful,
  }
}

function buildExtractDetails(
  text: string,
  method: string,
  pages: number,
  pageTexts: string[] = [text],
  extra: Partial<ExtractTextDetails> = {}
): ExtractTextDetails {
  const normalizedText = normalizeText(text || '')
  const quality = analyzeTextQuality(text, pageTexts)

  return {
    text: normalizedText,
    method,
    pages,
    rawTextLength: quality.rawTextLength,
    normalizedTextLength: quality.normalizedTextLength,
    compactTextLength: quality.compactTextLength,
    nonEmptyPages: quality.nonEmptyPages,
    validCharCount: quality.validCharCount,
    validCharRatio: quality.validCharRatio,
    sectionHintCount: quality.sectionHintCount,
    errorCode: extra.errorCode ?? null,
    error: extra.error ?? null,
    ocrErrorCode: extra.ocrErrorCode ?? null,
  }
}

function ensureAcceptableText(details: ExtractTextDetails, fallbackCode: ExtractFailureCode): ExtractTextDetails {
  const quality = analyzeTextQuality(details.text)
  if (quality.isMeaningful) return details

  throw new DocumentExtractError(
    details.errorCode === 'DEPENDENCY_MISSING' ? 'DEPENDENCY_MISSING' : fallbackCode,
    details.error || '文档文字过少，无法进行比对。请上传文字版 PDF 或 Word 文档，或直接输入文本。',
    details
  )
}

function mapDedupErrorCode(code: string | undefined): ExtractFailureCode {
  if (code === 'DEPENDENCY_MISSING') return 'DEPENDENCY_MISSING'
  if (code === 'OCR_FAILED') return 'OCR_FAILED'
  if (code === 'TEXT_INSUFFICIENT') return 'TEXT_INSUFFICIENT'
  return 'EXTRACT_FAILED'
}

function filterWatermarkLines(text: string): string {
  return text
    .split('\n')
    .filter(line => !WATERMARK_RE.test(line))
    .join('\n')
}

function needsStructuredPdfFallback(details: ExtractTextDetails): boolean {
  const text = details.text || ''
  const looseSectionHints = (text.match(LOOSE_SECTION_HINT_RE) || []).length
  const spacedCjkRuns = (text.match(SPACED_CJK_RE) || []).length
  return details.sectionHintCount < 3 && (looseSectionHints >= 8 || spacedCjkRuns >= 20)
}

function structureScore(details: ExtractTextDetails): number {
  return details.sectionHintCount * 20 + details.nonEmptyPages * 5 + Math.min(details.compactTextLength, 20000) / 1000
}

async function extractPdfTextDetailed(buf: Buffer, filename: string, maxPages?: number): Promise<ExtractTextDetails> {
  const readerText = await tryPdfreader(buf)
  const filtered = filterWatermarkLines(readerText)
  const readerDetails = buildExtractDetails(filtered, 'pdfreader', 0)
  const readerQuality = analyzeTextQuality(readerDetails.text)

  console.log(
    `[doc-extract] pdfreader raw=${readerDetails.rawTextLength} normalized=${readerDetails.normalizedTextLength} compact=${readerDetails.compactTextLength} validRatio=${readerDetails.validCharRatio} nonEmptyPages=${readerDetails.nonEmptyPages}`
  )

  if (readerQuality.isMeaningful && !needsStructuredPdfFallback(readerDetails)) {
    return readerDetails
  }

  if (readerQuality.isMeaningful) {
    console.log(
      `[doc-extract] pdfreader 结构异常 sectionHints=${readerDetails.sectionHintCount} -> 调 dedup extract-text`
    )
  }

  if (!readerQuality.isMeaningful) {
    console.log(
      `[doc-extract] pdfreader 不足 raw=${readerDetails.rawTextLength} normalized=${readerDetails.normalizedTextLength} -> 调 dedup extract-text`
    )
  }

  try {
    const dedupDetails = await callDedupExtractText(buf, filename, maxPages)
    const acceptableDedup = ensureAcceptableText(dedupDetails, 'TEXT_INSUFFICIENT')
    if (readerQuality.isMeaningful && structureScore(readerDetails) > structureScore(acceptableDedup)) {
      console.log(
        `[doc-extract] dedup 结构未优于 pdfreader readerScore=${structureScore(readerDetails).toFixed(1)} dedupScore=${structureScore(acceptableDedup).toFixed(1)} -> 使用 pdfreader`
      )
      return readerDetails
    }
    return acceptableDedup
  } catch (err: any) {
    if (readerQuality.isMeaningful) {
      console.error(`[doc-extract] dedup extract-text 失败，回退 pdfreader: ${err.message}`)
      return readerDetails
    }
    if (err instanceof DocumentExtractError) throw err
    console.error(`[doc-extract] dedup extract-text 技术错误: ${err.message}`)
    throw new DocumentExtractError('EXTRACT_FAILED', `文档解析失败，请稍后重试。（${err.message}）`)
  }
}

async function buildLocalExtractResult(text: string, method: string): Promise<ExtractTextDetails> {
  return ensureAcceptableText(buildExtractDetails(text, method, 1), 'TEXT_INSUFFICIENT')
}

async function tryPdfreader(buf: Buffer): Promise<string> {
  try {
    const { PdfReader } = await import('pdfreader')
    const parsePromise = new Promise<string>((resolve, reject) => {
      const rowMap = new Map<number, string[]>()
      new PdfReader().parseBuffer(buf, (err: any, item: any) => {
        if (err) {
          reject(err)
          return
        }
        if (!item) {
          const sorted = Array.from(rowMap.keys()).sort((a, b) => a - b)
          resolve(sorted.map(y => rowMap.get(y)!.join(' ')).join('\n'))
          return
        }
        if (item.text) {
          const y = Math.round((item.y ?? 0) * 10)
          if (!rowMap.has(y)) rowMap.set(y, [])
          rowMap.get(y)!.push(item.text)
        }
      })
    })
    const timeout = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('pdfreader 超时(5s)')), 5_000)
    )
    return await Promise.race([parsePromise, timeout])
  } catch (err: any) {
    console.error('[doc-extract] pdfreader 失败:', err.message)
    return ''
  }
}

async function callDedupExtractText(buf: Buffer, filename: string, maxPages?: number): Promise<ExtractTextDetails> {
  const boundary = `----BXZBoundary${Date.now()}`
  const safeFilename = filename.replace(/["\r\n]/g, '_')
  const parts: Buffer[] = []

  if (maxPages && maxPages > 0) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="max_pages"\r\n\r\n` +
      `${maxPages}\r\n`
    ))
  }

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
    `Content-Type: application/pdf\r\n\r\n`
  ))
  parts.push(buf)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  const body = Buffer.concat(parts)

  const url = new URL(`${DEDUP_BASE}/internal/extract-text`)
  const isHttps = url.protocol === 'https:'
  const lib: typeof http | typeof https = isHttps ? https : http

  // 内部 HMAC 鉴权（与 dedup auth.py 算法一致）
  // SECRET 在请求时从 process.env 读取（lazy），不是 module-level eval。
  // 静默 fallback 已在 2026-04-09 移除（appRoutes.ts module-level fail-fast 会先拦下）；
  // 此处 lazy 读取也直接抛错，不再 fallback 'dev-secret-change-me'。
  const internalSecret = process.env.BXZ_INTERNAL_SECRET
  if (!internalSecret) {
    throw new DocumentExtractError('EXTRACT_FAILED', 'BXZ_INTERNAL_SECRET 未配置，无法调用 dedup extract-text')
  }
  const ts = Math.floor(Date.now() / 1000).toString()
  const sig = crypto.createHmac('sha256', internalSecret)
    .update(`${ts}:/internal/extract-text`)
    .digest('hex')
  const internalKey = `${ts}:${sig}`

  const rawJson = await new Promise<string>((resolve, reject) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          'X-Internal-Key': internalKey,
        },
        // 30 分钟,dedup 真挂死兜底(只算 worker 真在解析的时间,不含排队)。
        // 这是 fail-safe,不是任务超时。任务总时长由前端轮询任务列表 +
        // 排队提示控制(/api/app/compare/queue-status)。
        timeout: 1_800_000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0
          if (statusCode >= 400) {
            reject(new Error(`dedup HTTP ${statusCode}`))
            return
          }
          resolve(Buffer.concat(chunks).toString('utf-8'))
        })
        res.on('error', reject)
      }
    )

    req.on('timeout', () => {
      req.destroy(new Error('dedup extract-text 请求超时(30 分钟,dedup 真挂死兜底)'))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })

  let data: any
  try {
    data = JSON.parse(rawJson)
  } catch {
    throw new DocumentExtractError('EXTRACT_FAILED', 'dedup 响应解析失败（非 JSON）')
  }

  const details = {
    ...buildExtractDetails(
      data?.text || '',
      data?.extract_method || data?.method || 'none',
      Number(data?.pages || 0),
      [data?.text || ''],
      {
        errorCode: data?.error_code ?? null,
        error: data?.error ?? null,
        ocrErrorCode: data?.ocr_error_code ?? null,
      }
    ),
    rawTextLength: Number(data?.raw_text_length ?? 0),
    normalizedTextLength: Number(data?.normalized_text_length ?? 0),
    compactTextLength: Number(data?.compact_text_length ?? 0),
    nonEmptyPages: Number(data?.non_empty_pages ?? 0),
    validCharCount: Number(data?.valid_char_count ?? 0),
    validCharRatio: Number(data?.valid_char_ratio ?? 0),
  }

  console.log(
    `[doc-extract] dedup extract-text method=${details.method} raw=${details.rawTextLength} normalized=${details.normalizedTextLength} nonEmptyPages=${details.nonEmptyPages} validRatio=${details.validCharRatio} errorCode=${details.errorCode ?? 'none'}`
  )

  if (!data?.success) {
    throw new DocumentExtractError(
      mapDedupErrorCode(data?.error_code),
      data?.error || 'dedup 提取失败',
      details
    )
  }

  return details
}

// ─── 异步 jobId 模式（BXZ_TASK_ASYNC_MODE=1 时由 taskWorker 状态机使用）────
//
// 设计：worker 提交 job → 立刻拿 jobId → 后续 tick 短轮询 jobStatus，直到 done/failed。
// 这两个函数只供 taskWorker 调，不替代 callDedupExtractText（旧路径仍然存在）。

function _hmacKey(path: string): string {
  const internalSecret = process.env.BXZ_INTERNAL_SECRET
  if (!internalSecret) {
    throw new DocumentExtractError('EXTRACT_FAILED', 'BXZ_INTERNAL_SECRET 未配置，无法调用 dedup')
  }
  const ts = Math.floor(Date.now() / 1000).toString()
  const sig = crypto.createHmac('sha256', internalSecret).update(`${ts}:${path}`).digest('hex')
  return `${ts}:${sig}`
}

/** 提交 extract-text job，立即返回 jobId（不等 OCR 完成）。timeout 60s 只是 submit 阶段。 */
export async function submitExtractTextJob(
  filePath: string,
  filename: string,
  maxPages?: number
): Promise<string> {
  const buf = readFileSync(filePath)
  const boundary = `----BXZBoundary${Date.now()}`
  const safeFilename = filename.replace(/["\r\n]/g, '_')
  const parts: Buffer[] = []
  if (maxPages && maxPages > 0) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="max_pages"\r\n\r\n` +
      `${maxPages}\r\n`
    ))
  }
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
    `Content-Type: application/pdf\r\n\r\n`
  ))
  parts.push(buf)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  const body = Buffer.concat(parts)

  const path = '/internal/jobs/extract-text'
  const url = new URL(`${DEDUP_BASE}${path}`)
  const isHttps = url.protocol === 'https:'
  const lib: typeof http | typeof https = isHttps ? https : http

  const rawJson = await new Promise<string>((resolve, reject) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          'X-Internal-Key': _hmacKey(path),
        },
        timeout: 60_000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const code = res.statusCode ?? 0
          if (code >= 400) {
            reject(new Error(`dedup submit HTTP ${code}`))
            return
          }
          resolve(Buffer.concat(chunks).toString('utf-8'))
        })
        res.on('error', reject)
      }
    )
    req.on('timeout', () => req.destroy(new Error('dedup submit 超时(60s)')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })

  let data: any
  try { data = JSON.parse(rawJson) } catch {
    throw new DocumentExtractError('EXTRACT_FAILED', `dedup job submit 响应非 JSON: ${rawJson.slice(0, 200)}`)
  }
  if (!data?.job_id) {
    throw new DocumentExtractError('EXTRACT_FAILED', `dedup job submit 缺 job_id: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return data.job_id as string
}

export type ExtractJobPollResult =
  | { status: 'pending' }
  | { status: 'running' }
  | { status: 'not_found' }
  | { status: 'done'; details: ExtractTextDetails }
  | { status: 'failed'; error: string; errorCode: ExtractFailureCode }

/** 短轮询单次：30s timeout（dedup worker 被 OCR 占满时 HTTP 排队可能到十几秒）。 */
export async function pollExtractTextJob(jobId: string): Promise<ExtractJobPollResult> {
  const path = `/internal/jobs/${encodeURIComponent(jobId)}`
  const url = new URL(`${DEDUP_BASE}${path}`)
  const isHttps = url.protocol === 'https:'
  const lib: typeof http | typeof https = isHttps ? https : http

  const rawJson = await new Promise<string>((resolve, reject) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: { 'X-Internal-Key': _hmacKey(path) },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const code = res.statusCode ?? 0
          if (code >= 400) {
            reject(new Error(`dedup poll HTTP ${code}`))
            return
          }
          resolve(Buffer.concat(chunks).toString('utf-8'))
        })
        res.on('error', reject)
      }
    )
    req.on('timeout', () => req.destroy(new Error('dedup poll 超时(30s)')))
    req.on('error', reject)
    req.end()
  })

  let data: any
  try { data = JSON.parse(rawJson) } catch {
    throw new DocumentExtractError('EXTRACT_FAILED', `dedup job poll 响应非 JSON: ${rawJson.slice(0, 200)}`)
  }
  const status = data?.status
  if (status === 'pending' || status === 'running') return { status }
  if (status === 'not_found') return { status: 'not_found' }
  if (status === 'failed') {
    return {
      status: 'failed',
      error: data?.error || 'dedup job failed',
      errorCode: mapDedupErrorCode(data?.error_code),
    }
  }
  if (status === 'done') {
    const r = data?.result || {}
    const details: ExtractTextDetails = {
      ...buildExtractDetails(
        r?.text || '',
        r?.extract_method || r?.method || 'none',
        Number(r?.pages || 0),
        [r?.text || ''],
        {
          errorCode: r?.error_code ?? null,
          error: r?.error ?? null,
          ocrErrorCode: r?.ocr_error_code ?? null,
        }
      ),
      rawTextLength: Number(r?.raw_text_length ?? 0),
      normalizedTextLength: Number(r?.normalized_text_length ?? 0),
      compactTextLength: Number(r?.compact_text_length ?? 0),
      nonEmptyPages: Number(r?.non_empty_pages ?? 0),
      validCharCount: Number(r?.valid_char_count ?? 0),
      validCharRatio: Number(r?.valid_char_ratio ?? 0),
    }
    if (!r?.success) {
      return {
        status: 'failed',
        error: r?.error || 'dedup 提取失败',
        errorCode: mapDedupErrorCode(r?.error_code),
      }
    }
    return { status: 'done', details }
  }
  throw new DocumentExtractError('EXTRACT_FAILED', `dedup job 未知状态: ${status}`)
}

async function extractDocxText(buf: Buffer): Promise<string> {
  try {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer: buf })
    const text = result.value || ''
    if (text.length < 10) {
      throw new Error('Word 文档内容为空或无法解析，请检查文件是否损坏。')
    }
    return text
  } catch (err: any) {
    console.error('[doc-extract] DOCX 解析失败:', err.message)
    throw err
  }
}

export function extractTextFromString(text: string): string {
  return normalizeText(text)
}
