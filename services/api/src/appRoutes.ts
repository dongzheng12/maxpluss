/**
 * 标准小智主业务路由（小程序 + H5 + 管理后台）
 * @date   2026-03-21
 *
 * ════════════════════════════════════════════════════════
 * 路由功能分区
 * ════════════════════════════════════════════════════════
 *  /api/app/auth/*        用户注册/登录/修改密码/邮箱验证码
 *  /api/app/profile       个人信息查询与编辑
 *  /api/app/home          首页聚合数据（公告/统计/快捷入口）
 *  /api/app/compare/*     文档比对（主入口走 dedup 服务）
 *  /api/app/recognize     扫一扫识别（走 dedup 服务）
 *  /api/app/membership    会员方案查询
 *  /api/app/orders/*      订单管理
 *  /api/app/invoice/*     发票申请
 *  /api/app/booking/*     标准服务预约
 *  /api/admin/*           管理后台（用户/订单/统计/公告/赠送等）
 *
 * 【比对链路说明】
 *   主链路：callDedupService() → dedup Python 服务（MinHash + 报告生成）
 *   兜底链路：buildRealCompareReport() → compare-engine.ts（Node TF-IDF，仅 dedup 不可用时触发）
 *
 * 【文本提取链路说明】
 *   主链路：extractText() → doc-extract.ts（Node 侧 PDF/DOCX 提取 + OCR 兜底）
 *   上传文件后先提取文本，再送 dedup 服务比对
 * ════════════════════════════════════════════════════════
 */
import type { Express, Request, Response, NextFunction } from 'express'
import { z } from 'zod'

// Zod 全局中文错误消息
z.setErrorMap((issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return { message: '参数类型错误' }
    case z.ZodIssueCode.too_small:
      if (issue.type === 'string') return { message: `不能少于 ${issue.minimum} 个字符` }
      if (issue.type === 'number') return { message: `不能小于 ${issue.minimum}` }
      return { message: '输入内容过短' }
    case z.ZodIssueCode.too_big:
      if (issue.type === 'string') return { message: `不能超过 ${issue.maximum} 个字符` }
      return { message: '输入内容过长' }
    case z.ZodIssueCode.invalid_enum_value:
      return { message: '无效的选项值' }
    case z.ZodIssueCode.invalid_string:
      if (issue.validation === 'email') return { message: '请输入有效的邮箱地址' }
      if (issue.validation === 'url') return { message: '请输入有效的网址' }
      return { message: '格式不正确' }
    default:
      return { message: ctx.defaultError }
  }
})

import multer from 'multer'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { prisma } from './db'
import { announcements, buildCompareReport, getStandardById, heroStats, icsCatalog, listStandards, membershipPlans, standards } from './appData'
import { buildRealCompareReport } from './compare-engine'
import { extractText } from './doc-extract'
import { createPayment, createNativePayment, createRefund, decryptNotification, isRealPayConfigured, verifyCallbackSignature } from './wechat-pay'
import { getSweeperStats } from './orderSweeper'
import { hashPassword, verifyPassword, signJwt, requireAuth, optionalAuth, requireAdmin, requirePermission, type AuthRequest } from './auth'
import { createId } from '@paralleldrive/cuid2'
import crypto from 'crypto'
import http from 'http'
import https from 'https'
import { alertCritical } from './alert'
import { trackEvent, trackServerEvent, trackScanSuccess, markUserActive } from './tracker'
import {
  validateAndLockCoupon, unlockCouponByOrder, redeemCouponByOrder,
  snapshotCoupon, listApplicableCoupons, couponsEnabled,
  issueSalesPromoCouponOnRegister,
} from './coupons'
import { getWxaCode } from './internal/wxacode.js'
import { sendPushForRule } from './internal/pushHelpers.js'
import { TEMPLATE_REFERRAL } from './internal/rules/types.js'
import { writeAuditLog } from './utils/auditLog.js'
import { getAllContentConfigs, getContentConfigGroup, getContentConfig, updateContentConfig } from './internal/contentConfig.js'
import { seedMpRemoteConfigGroups } from './internal/seedMpRemoteConfig.js'
import { EXPERT_VOTE_REFUNDABLE_STATUSES, isExpertVoteRefundableStatus } from './services/expertVote.js'

function getSingleValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined
  return undefined
}

function getRouteParam(value: unknown): string {
  return getSingleValue(value) ?? ''
}

// ─── 轻量级内存限速器（无需第三方包）─────────────────────────
// 防止密码暴力破解：同一 IP 登录失败超过 10 次/15min 则封锁
const loginAttempts = new Map<string, { count: number; resetAt: number }>()
const RATE_WINDOW_MS = 15 * 60 * 1000  // 15 分钟
const MAX_ATTEMPTS = 10

function getClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for']
  return (Array.isArray(xff) ? xff[0] : xff?.split(',')[0]) || req.socket.remoteAddress || 'unknown'
}

function checkLoginRateLimit(ip: string): { blocked: boolean; remaining: number } {
  const now = Date.now()
  const entry = loginAttempts.get(ip)
  if (!entry || now > entry.resetAt) {
    return { blocked: false, remaining: MAX_ATTEMPTS }
  }
  return { blocked: entry.count >= MAX_ATTEMPTS, remaining: Math.max(0, MAX_ATTEMPTS - entry.count) }
}

function recordLoginFailure(ip: string): void {
  const now = Date.now()
  const entry = loginAttempts.get(ip)
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
  } else {
    entry.count++
  }
}

function resetLoginAttempts(ip: string): void {
  loginAttempts.delete(ip)
}

// 定期清理过期条目，防止内存泄漏
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of loginAttempts.entries()) {
    if (now > entry.resetAt) loginAttempts.delete(ip)
  }
}, 5 * 60 * 1000)

// ─── 通用 IP 维度限速器（识别 / AI 对话等高成本接口）──────────
// 防止恶意刷接口耗光 LLM 额度或拖垮识别服务
// 用法：const ok = checkIpRate(ip, 30, 60_000); if (!ok) return 429
const ipRateBuckets = new Map<string, { count: number; resetAt: number }>()
export function checkIpRate(ip: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const e = ipRateBuckets.get(ip)
  if (!e || now > e.resetAt) {
    ipRateBuckets.set(ip, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (e.count >= max) return false
  e.count++
  return true
}
export function getIpFromReq(req: Request): string {
  const xff = req.headers['x-forwarded-for']
  return (Array.isArray(xff) ? xff[0] : xff?.split(',')[0]) || req.socket.remoteAddress || 'unknown'
}
// Express 中间件工厂：放在 multer 之前，避免无谓的上传带宽消耗
export function ipRateLimit(max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = getIpFromReq(req)
    if (!checkIpRate(ip, max, windowMs)) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' })
    }
    next()
  }
}
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of ipRateBuckets.entries()) {
    if (now > v.resetAt) ipRateBuckets.delete(k)
  }
}, 5 * 60 * 1000)

// ─── Dedup 能力服务调用 ─────────────────────────────────────

const DEDUP_BASE = process.env.DEDUP_SERVICE_URL || 'http://127.0.0.1:8067'
const PERSONAL_ANNUAL_LIMIT = 10 // 个人会员全库相似度分析年度额度
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024 // 50MB 上传文件大小限制
// 比对队列保护
//  Layer 1（所有非 admin 用户）：同一 userId 已有 PENDING/PROCESSING → 409 引导回已有任务
//  Layer 2（仅免费用户）：全局 PENDING 数 ≥ FREE_QUEUE_LIMIT → 429 + 排队信息
//  admin 完全绕过，会员仅绕过 Layer 2 仍受 Layer 1 约束（防误提交占资源）
const FREE_QUEUE_LIMIT = 20
const QUEUE_ESTIMATE_MIN_PER_TASK = 2 // 与 /api/app/compare/queue-status 的 estimateMinutes 同步

// 支付链路 transaction 显式 timeout + isolationLevel（5 处共用）
//   timeout: 事务持有写锁的最大时间。WAL + busy_timeout=5s 之上再留余量
//   maxWait: 事务 BEGIN 前等锁的最大时间。并发支付高峰时不至于秒抛
//   isolationLevel: 'Serializable' — PG 下显式声明，避免默认 READ COMMITTED 让支付 / 优惠券锁
//     在并发回调下漏锁。SQLite Prisma 不支持该选项但参数会被静默忽略，向下兼容。
// 必须配合 handlePostPaymentInTx / executeRefund 的"事务内无外部 HTTP / 慢逻辑"约束。
const PAYMENT_TX_OPTIONS = {
  timeout: 8000,
  maxWait: 5000,
  isolationLevel: 'Serializable' as const,
}

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

// PG Serializable 隔离级别下，并发支付回调写同一行 / 优惠券核销 / 推荐返佣
// 会触发 SSI 序列化冲突 → Prisma 抛 P2034（write conflict / deadlock），
// 或事务被 abort 后下一次 query 抛 25P02（current transaction is aborted）。
// 这是 PG Serializable 的预期语义，需要应用层 retry。
//
// SQLite 不会触发 P2034，但会因文件锁 busy_timeout 抛 P1008/P2028；
// 这两个原本由微信回调侧重试兜底，但放进同一 retry wrapper 里能让它们也
// 在应用层短间隔重试一两次，多数情况能在事务内自愈。
//
// 重要约束：fn 必须返回值，不要靠 closure mutate 外层变量——
// retry 时 fn 会被多次执行，外层 push/累加会重复。
//
// 错误识别：Prisma 5.x 在 PG 下两条路径抛错：
//   1. PrismaClientKnownRequestError —— err.code = 'P2034' / 'P2002' 等
//   2. PrismaClientUnknownRequestError —— 没 err.code，PG 原始 SQLSTATE 嵌在 message 字符串里
//      （如 'code: "25P02"' / 'code: "40001"'）。SSI 失败/事务 abort 走这条
export const PAYMENT_RETRY_CODES = new Set(['P2034', '25P02', '40001'])

export function isRetryablePaymentError(err: any): boolean {
  if (err?.code && PAYMENT_RETRY_CODES.has(err.code)) return true
  const msg: string = typeof err?.message === 'string' ? err.message : ''
  // 在 PrismaClientUnknownRequestError 的 message 里以 'code: "XXXXX"' 形式嵌入 SQLSTATE
  for (const c of PAYMENT_RETRY_CODES) {
    if (msg.includes(`code: "${c}"`) || msg.includes(`code: '${c}'`)) return true
  }
  return false
}

export async function runPaymentTx<T>(
  fn: (tx: TxClient) => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  let lastErr: any
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await prisma.$transaction(fn, PAYMENT_TX_OPTIONS)
    } catch (err: any) {
      lastErr = err
      if (!isRetryablePaymentError(err) || attempt >= maxRetries) throw err
      // jitter 10-50ms 避免 retry 再次同步撞车
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 40))
    }
  }
  throw lastErr
}
// fail-fast：BXZ_INTERNAL_SECRET 是 dedup 通信的 HMAC 密钥，缺失会让所有比对/扫一扫
// 链路 401。之前用 || 'dev-secret-change-me' 静默 fallback 是 4-08 扫一扫事故的真凶
// （fallback 跟 dedup 端 secret 不一致 → HMAC 失败 → 用户看到比对失败但系统不报警）。
// 现在确认 dotenv 加载顺序没 bug（实测 .env 自动 load 成功），fallback 是纯隐患，
// 直接拒启动。docker run 同时挂 .env + -e 双保险，正常永远进不到这个分支。
if (!process.env.BXZ_INTERNAL_SECRET) {
  console.error('[FATAL] BXZ_INTERNAL_SECRET 未设置，拒绝启动。请检查 .env 文件 mount 或 docker run -e 是否正确。')
  process.exit(1)
}
const DEDUP_SECRET: string = process.env.BXZ_INTERNAL_SECRET

function makeInternalKey(path: string): string {
  const ts = Math.floor(Date.now() / 1000).toString()
  const sig = crypto.createHmac('sha256', DEDUP_SECRET)
    .update(`${ts}:${path}`)
    .digest('hex')
  return `${ts}:${sig}`
}

async function callDedupService(path: string, body: Record<string, unknown>, _retry = 0): Promise<any> {
  const url = `${DEDUP_BASE}${path}`
  const payload = JSON.stringify(body)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Internal-Key': makeInternalKey(path),
  }

  // HTTP 超时由 worker 层面的 STAGE_TIMEOUT_MS（30 分钟）兜底，
  // 此处不加 socket timeout — 同步路径长任务本身可能跑十几分钟
  const result: any = await new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const mod = parsedUrl.protocol === 'https:' ? https : http
    const req = mod.request(parsedUrl, { method: 'POST', headers }, (res: any) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        if (res.statusCode === 401 && _retry === 0) {
          resolve({ __retry401: true })
          return
        }
        if (res.statusCode >= 400) {
          reject(new Error(`dedup service error ${res.statusCode}: ${text}`))
          return
        }
        try { resolve(JSON.parse(text)) } catch { reject(new Error(`dedup: invalid JSON — ${text.slice(0, 200)}`)) }
      })
    })
    req.on('error', (e: Error) => reject(new Error(`dedup service unreachable: ${e.message}`)))
    req.write(payload)
    req.end()
  })

  // 401 自动重试一次（重新生成签名）
  if (result?.__retry401) {
    console.log(`[callDedupService] 401 → 重新签名重试 ${path}`)
    return callDedupService(path, body, 1)
  }
  return result
}

/**
 * 通过 http 模块发送 multipart/form-data 文件到 dedup 服务（兼容 Node 16）
 */
async function callDedupMultipart(path: string, filePath: string, fileName: string, mimeType: string): Promise<any> {
  const buf = readFileSync(filePath)
  const boundary = `----FormBoundary${Date.now()}`
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  )
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Buffer.concat([header, buf, footer])

  const parsedUrl = new URL(`${DEDUP_BASE}${path}`)
  const mod = parsedUrl.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const req = mod.request(parsedUrl, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'X-Internal-Key': makeInternalKey(path),
        'Content-Length': body.length,
      },
      timeout: 180_000,
    }, (res: any) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        if (res.statusCode >= 400) {
          reject(new Error(`dedup service error ${res.statusCode}: ${text}`))
          return
        }
        try { resolve(JSON.parse(text)) } catch { reject(new Error(`dedup: invalid JSON — ${text.slice(0, 200)}`)) }
      })
    })
    req.on('error', (e: Error) => reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('dedup recognize timeout (60s)')) })
    req.write(body)
    req.end()
  })
}

type ScanRecognizeStandard = {
  code?: string
  name?: string
  status?: string
}

type ScanRecognizeRawResult = {
  success?: boolean
  recognized?: string | null
  confidence?: number | null
  standards?: ScanRecognizeStandard[]
  ocr_text?: string
  error?: string | null
  match_source?: string | null
  // 2026-04-10 P0 止血新增字段
  recognition_mode?: 'exact' | 'category' | 'general' | null
  industry_token?: string | null
  risk_directions?: string[] | null
}

function normalizeScanMatchSource(result: ScanRecognizeRawResult): string {
  const explicit = result.match_source?.trim()
  if (explicit) return explicit

  const standards = result.standards || []
  const topCode = (standards[0]?.code || '').replace(/\s+/g, '').toUpperCase()
  const ocrText = (result.ocr_text || '').replace(/\s+/g, '').toUpperCase()

  if (topCode && ocrText.includes(topCode)) return 'ocr_code'
  if (ocrText && /GB\/?T|GB|QB|DB|HG|JB|YY|YC|NY\/?T/.test(ocrText)) return 'ocr_text'
  if (result.recognized || result.confidence) return 'category_keyword'
  return 'unknown'
}

function getScanMatchSourceLabel(source: string): string {
  if (source === 'ocr_code') return '包装标准号直连'
  if (source === 'ocr_text') return '包装文字匹配'
  if (source === 'category_keyword') return '商品类别关联'
  return '综合匹配'
}

function buildScanOcrPreview(text?: string): string {
  const cleaned = (text || '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  return cleaned.length > 36 ? `${cleaned.slice(0, 36)}...` : cleaned
}

function buildScanAdvice(result: ScanRecognizeRawResult, matchSource: string) {
  const standards = result.standards || []
  if (!standards.length) return null

  const confidencePct = Math.round(((result.confidence || 0) as number) * 100)
  const topStandard = standards[0] || {}
  const topStatus = topStandard.status || '未知'
  const currentCount = standards.filter((item) => item.status === '现行' || item.status === '即将实施').length
  const matchSourceLabel = getScanMatchSourceLabel(matchSource)

  let score = 0
  if (matchSource === 'ocr_code') score += 38
  else if (matchSource === 'ocr_text') score += 28
  else if (matchSource === 'category_keyword') score += 18
  else score += 12

  if (topStatus === '现行') score += 28
  else if (topStatus === '即将实施') score += 20
  else if (topStatus === '未知') score += 10

  if (standards.length >= 3) score += 12
  else if (standards.length === 2) score += 8
  else if (standards.length === 1) score += 4

  if (confidencePct >= 85) score += 12
  else if (confidencePct >= 70) score += 8
  else if (confidencePct >= 50) score += 4
  else if (confidencePct > 0) score += 1

  if (matchSource === 'category_keyword') score = Math.min(score, 75)
  if (matchSource === 'category_keyword' && confidencePct < 40) score = Math.min(score, 49)
  if (topStatus === '废止') score = Math.min(score, 49)
  if (topStatus === '未知' && matchSource !== 'ocr_code') score = Math.min(score, 59)

  let level = 'low'
  let label = '谨慎购买'
  if (score >= 80) {
    level = 'high'
    label = '值得优先考虑'
  } else if (score >= 60) {
    level = 'mid'
    label = '可以考虑'
  } else if (score >= 40) {
    level = 'verify'
    label = '建议核实后再买'
  }

  let summary = '当前更适合作为标准匹配参考，建议结合品牌说明和包装执行标准一起判断。'
  if (matchSource === 'ocr_code' && score >= 80) {
    summary = '已直接识别到包装上的标准号，且命中标准状态较好，可以作为优先考虑项。'
  } else if (score >= 60) {
    summary = '已匹配到相关标准，整体参考价值不错，但仍建议查看商品详情页和包装执行标准进一步确认。'
  } else if (matchSource === 'category_keyword') {
    summary = '当前更多是按商品类别关联到标准，参考价值有限，建议以包装上的执行标准为准。'
  } else if (topStatus === '废止') {
    summary = '首个命中标准已处于废止状态，建议先核对商品包装上的执行标准再决定。'
  }
  if (matchSource === 'category_keyword' && confidencePct < 40) {
    summary = '当前主要是低置信度的商品类别关联，识别结果仅供参考，建议优先核对包装文字和执行标准。'
  }

  return {
    score,
    level,
    label,
    summary,
    reasons: [
      `匹配方式：${matchSourceLabel}`,
      `首个匹配标准：${topStandard.code || '未知标准'}`,
      `标准状态：${topStatus}`,
      `共匹配到 ${standards.length} 项相关标准`,
      `图像识别置信度 ${confidencePct}%`,
    ],
  }
}

// ─── 文件上传配置 ──────────────────────────────────────────
const UPLOAD_DIR = join(process.cwd(), 'uploads')
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true })

// defParamCharset:'utf8' 让 multer 把 multipart Content-Disposition 的
// filename 字段按 UTF-8 解码,而不是默认的 latin1。修复中文文件名(如
// "测试A-日常生活.docx")在 file.originalname 上变成乱码 "æµè¯A-..." 的问题。
// 影响所有 multer 实例,所以三处统一加。
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const hash = crypto.randomBytes(8).toString('hex')
      const ext = (file.originalname.toLowerCase().match(/\.[^.]+$/) || [''])[0]
      cb(null, `${Date.now()}-${hash}${ext}`)
    }
  }),
  limits: { fileSize: MAX_UPLOAD_SIZE },  // 50MB
  defParamCharset: 'utf8',
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.txt', '.md']
    const ext = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0]
    if (ext && allowed.includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error(`不支持的文件类型: ${ext}`))
    }
  }
})

// 专用于识别接口：支持图片 + 文档（拍照/扫描识别场景）
const uploadRecognize = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const hash = crypto.randomBytes(8).toString('hex')
      const ext = (file.originalname.toLowerCase().match(/\.[^.]+$/) || [''])[0]
      cb(null, `${Date.now()}-${hash}${ext}`)
    }
  }),
  limits: { fileSize: MAX_UPLOAD_SIZE },
  defParamCharset: 'utf8',
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.txt', '.md', '.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp', '.tmp']
    const ext = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0]
    if (ext && allowed.includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error(`不支持的文件类型: ${ext}`))
    }
  }
})

// 专用于章节提取：支持文档 + wx.uploadFile 的 .tmp 临时文件
const uploadAny = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const hash = crypto.randomBytes(8).toString('hex')
      const ext = (file.originalname.match(/\.[^.]+$/) || [''])[0]
      cb(null, `${Date.now()}-${hash}${ext}`)
    }
  }),
  limits: { fileSize: MAX_UPLOAD_SIZE },
  defParamCharset: 'utf8',
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.txt', '.md', '.tmp']
    const ext = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0]
    if (ext && allowed.includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error(`不支持的文件类型: ${ext}`))
    }
  }
})

// ─── 分片上传 token 存储(小程序 wx.uploadFile 单文件限制) ───
// 小程序一次只能上传一个文件,1对1 比对需要两次串行上传:
// 1) POST /api/app/compare/upload-part 上传 A → 拿 partToken_A
// 2) POST /api/app/compare/upload-part 上传 B → 拿 partToken_B
// 3) POST /api/app/compare/tasks 用 fileAToken + fileBToken 合并任务
// PC Web 仍走 multipart 一次性 fileA + fileB,本机制不影响 PC 现有调用链。
type UploadPartEntry = { userId: string; filePath: string; originalName: string; createdAt: number }
const uploadPartStore = new Map<string, UploadPartEntry>()
const UPLOAD_PART_TTL_MS = 10 * 60 * 1000

function gcUploadPartStore() {
  const now = Date.now()
  for (const [token, entry] of uploadPartStore) {
    if (now - entry.createdAt > UPLOAD_PART_TTL_MS) {
      uploadPartStore.delete(token)
      try { require('fs').unlinkSync(entry.filePath) } catch {}
    }
  }
}
const uploadPartGcTimer = setInterval(gcUploadPartStore, 60 * 1000)
if (typeof uploadPartGcTimer.unref === 'function') uploadPartGcTimer.unref()

const DEMO_USER_ID: string = process.env.NODE_ENV === 'production' ? '__no_demo__' : 'demo-user'

function getUserId(req: Request): string {
  // Prefer JWT-authenticated userId
  const authReq = req as AuthRequest
  if (authReq.userId) return authReq.userId
  // 生产环境不接受 header/query 回退，防止身份伪造
  if (process.env.NODE_ENV === 'production') return DEMO_USER_ID
  // Fallback to header/query for backward compat (dev only)
  const headerUserId = req.header('x-user-id')
  const queryUserId = typeof req.query.userId === 'string' ? req.query.userId : undefined
  return headerUserId || queryUserId || DEMO_USER_ID
}

function makeBusinessNo(prefix: 'ORD' | 'BOOK' | 'CMP' | 'INV') {
  const now = new Date()
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('')
  const random = Math.floor(Math.random() * 900000 + 100000)
  return `${prefix}-${parts}-${random}`
}

function parseJson<T>(value?: string | null): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

// ─── 比对队列保护辅助 ──────────────────────────────────────
// 暴露为命名导出，方便 tests 直接调；运行时仍由两个 compare 端点引用。

export async function isPaidCompareUser(userId: string): Promise<boolean> {
  if (!userId || userId === DEMO_USER_ID) return false
  const m = await prisma.userMembership.findFirst({
    where: { userId, status: 'ACTIVE', planId: { in: ['personal', 'pro', 'enterprise'] } },
    select: { id: true },
  })
  return !!m
}

export async function findActiveCompareTask(userId: string) {
  if (!userId || userId === DEMO_USER_ID) return null
  return prisma.compareTask.findFirst({
    where: { userId, status: { in: ['PENDING', 'PROCESSING'] } },
    orderBy: { createdAt: 'desc' },
    select: { taskNo: true, status: true, compareMode: true },
  })
}

export type CompareQueueRejection =
  | {
      http: 409
      body: {
        error: 'ALREADY_PROCESSING'
        message: string
        currentTaskNo: string
        currentStatus: string
      }
    }
  | {
      http: 429
      body: {
        error: 'QUEUE_FULL'
        message: string
        queuePosition: number
        estimateMinutes: number
        upgradeUrl: string
      }
    }

export async function checkCompareQueue(
  userId: string,
  role: string | undefined
): Promise<CompareQueueRejection | null> {
  if (role === 'admin') return null

  const active = await findActiveCompareTask(userId)
  if (active) {
    return {
      http: 409,
      body: {
        error: 'ALREADY_PROCESSING',
        message: '您有任务正在处理中，请等待完成后再提交新任务',
        currentTaskNo: active.taskNo,
        currentStatus: active.status,
      },
    }
  }

  if (!(await isPaidCompareUser(userId))) {
    const pendingCount = await prisma.compareTask.count({ where: { status: 'PENDING' } })
    if (pendingCount >= FREE_QUEUE_LIMIT) {
      return {
        http: 429,
        body: {
          error: 'QUEUE_FULL',
          message: '当前任务排队较长，请稍后再试或升级会员优先处理',
          queuePosition: pendingCount + 1,
          estimateMinutes: (pendingCount + 1) * QUEUE_ESTIMATE_MIN_PER_TASK,
          upgradeUrl: '/membership',
        },
      }
    }
  }

  return null
}

// P0-3: 事务内版本，供 handlePostPaymentInTx 复用
// sourceRef: 订单号或赠送码，用于退款时精确撤销（按 sourceRef 反查）
async function ensureActiveMembershipInTx(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  userId: string,
  planId: string,
  sourceRef?: string
) {
  const plan = membershipPlans.find((item) => item.id === planId)
  if (!plan) return null

  // 支付回调 / mock pay / 后台补单都可能因为重试而重复触发同一笔订单。
  // 这里按 sourceRef=orderNo 先做短路，避免：
  // 1. 重复 EXPIRE + CREATE 产生多条历史会员记录
  // 2. SQLite 在高并发重试下放大写锁等待，触发 P1008 / P2028
  // 不能简单“补 Z 当 UTC”式靠时序碰运气，这里必须把幂等锚点落到业务主键上。
  if (sourceRef) {
    const existing = await tx.userMembership.findFirst({
      where: {
        userId,
        source: 'PURCHASE',
        sourceRef,
      },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    })
    if (existing) {
      return Object.assign(existing, { isRenewal: false, wasCreated: false })
    }
  }

  // 只 EXPIRE 同来源（PURCHASE）且等级 ≤ 新购买等级 的现有 ACTIVE 会员。
  // 不动 SALES_GIFT 和其他独立来源 — 这些是用户的赠送/管理员授予权益，
  // 不应该因为用户付费购买而被吞掉。
  // 越权降级（如已有 pro 买 personal）由 createOrder MEMBERSHIP 兜底拦截
  // (commit ee59fe8)，本函数仅作最后防线。
  const tierRank: Record<string, number> = { personal: 1, pro: 2, enterprise: 3 }
  const newRank = tierRank[planId] || 0
  const coveredPlanIds = Object.entries(tierRank)
    .filter(([, rank]) => rank <= newRank)
    .map(([id]) => id)

  const expired = await tx.userMembership.updateMany({
    where: {
      userId,
      status: 'ACTIVE',
      source: 'PURCHASE',
      planId: { in: coveredPlanIds },
    },
    data: { status: 'EXPIRED' }
  })

  const startAt = new Date()
  const endAt = new Date(startAt)
  endAt.setFullYear(endAt.getFullYear() + 1)

  const membership = await tx.userMembership.create({
    data: {
      userId,
      planId,
      status: 'ACTIVE',
      sourceRef,
      startAt,
      endAt,
      benefitsJson: JSON.stringify(plan.features)
    },
    include: { plan: true }
  })
  await writeAuditLog({
    actor: userId,
    action: 'MEMBERSHIP_CREATED',
    targetType: 'UserMembership',
    targetId: membership.id,
    diff: {
      userId,
      planId,
      source: 'PURCHASE',
      sourceRef: sourceRef || null,
      startAt: membership.startAt.toISOString(),
      endAt: membership.endAt.toISOString(),
      isRenewal: expired.count > 0,
    },
  }, tx)
  // 续费 vs 首开：EXPIRE 掉同来源旧会员时 count>0 视为续费
  return Object.assign(membership, { isRenewal: expired.count > 0, wasCreated: true })
}

// P0-3: 对外接口，自带事务
async function ensureActiveMembership(userId: string, planId: string, sourceRef?: string) {
  return runPaymentTx(
    (tx) => ensureActiveMembershipInTx(tx, userId, planId, sourceRef),
  )
}

function serializeMembership(
  record: (Awaited<ReturnType<typeof prisma.userMembership.findFirst>> & { plan?: any }) | null | undefined
) {
  if (!record) return null
  return {
    id: record.id,
    status: record.status,
    startAt: record.startAt,
    endAt: record.endAt,
    plan: record.plan
      ? {
          id: record.plan.id,
          name: record.plan.name,
          price: record.plan.price,
          badge: record.plan.badge,
          description: record.plan.description,
          features: parseJson<string[]>(record.plan.featuresJson) || []
        }
      : null
  }
}

// ───── Plan featuresJson 序列化 / 反序列化（阶段 0：mp 远程配置底座）─────
// 历史：featuresJson 字段名沿用，但内容由"纯 string[]"升级为"结构化对象"，装完整元数据
// 新格式：{ features, originalPrice, priceUnit, unit, color, bg, note, quotas? }
// 旧格式（纯数组）由 deserializePlanFeatures 兼容；首次 admin 编辑 plan 自动迁移到新格式
type PlanMeta = {
  features: string[]
  originalPrice?: number
  priceUnit?: number
  unit?: string
  color?: string
  bg?: string
  note?: string
  quotas?: Record<string, number | 'unlimited'>
}

function planFeaturesPayload(plan: typeof membershipPlans[number]): string {
  return JSON.stringify({
    features: plan.features,
    originalPrice: plan.originalPrice,
    priceUnit: plan.priceUnit,
    unit: plan.unit,
    color: plan.color,
    bg: plan.bg,
    note: plan.note,
  })
}

function deserializePlanFeatures(featuresJson: string | null | undefined): PlanMeta {
  if (!featuresJson) return { features: [] }
  try {
    const parsed = JSON.parse(featuresJson)
    if (Array.isArray(parsed)) return { features: parsed.filter(s => typeof s === 'string') }
    if (parsed && typeof parsed === 'object') {
      return {
        features: Array.isArray(parsed.features) ? parsed.features.filter((s: unknown) => typeof s === 'string') : [],
        originalPrice: typeof parsed.originalPrice === 'number' ? parsed.originalPrice : undefined,
        priceUnit: typeof parsed.priceUnit === 'number' ? parsed.priceUnit : undefined,
        unit: typeof parsed.unit === 'string' ? parsed.unit : undefined,
        color: typeof parsed.color === 'string' ? parsed.color : undefined,
        bg: typeof parsed.bg === 'string' ? parsed.bg : undefined,
        note: typeof parsed.note === 'string' ? parsed.note : undefined,
        quotas: parsed.quotas && typeof parsed.quotas === 'object' ? parsed.quotas : undefined,
      }
    }
  } catch { /* fall through */ }
  return { features: [] }
}

// 把 DB plan 行组装成前端期望的完整结构。缺字段时按 appData.ts 同 id 的 hardcoded 兜底。
function buildPlanResponse(dbPlan: { id: string; name: string; price: number; badge: string | null; description: string; featuresJson: string }) {
  const meta = deserializePlanFeatures(dbPlan.featuresJson)
  const fb = membershipPlans.find(p => p.id === dbPlan.id)
  return {
    id: dbPlan.id,
    name: dbPlan.name,
    price: dbPlan.price,
    badge: dbPlan.badge ?? '',
    description: dbPlan.description,
    features: meta.features.length ? meta.features : (fb?.features ?? []),
    originalPrice: meta.originalPrice ?? fb?.originalPrice ?? dbPlan.price,
    priceUnit: meta.priceUnit ?? fb?.priceUnit ?? dbPlan.price * 100,
    unit: meta.unit ?? fb?.unit ?? '年',
    color: meta.color ?? fb?.color ?? '#1677ff',
    bg: meta.bg ?? fb?.bg ?? '#f0f5ff',
    note: meta.note ?? fb?.note ?? '',
    quotas: meta.quotas ?? {},
  }
}

export async function ensureAppSeed() {
  // 归集平台哨兵用户：CompareTask.userId FK 依赖此记录，缺失会 P2003
  await prisma.appUser.upsert({
    where: { id: 'guiji-anonymous' },
    update: {},
    create: {
      id: 'guiji-anonymous',
      role: 'system',
      name: '归集平台匿名用户',
    },
  })

  // v3 §4：内置 AdminRole 启动时 ensure（"销售"角色）
  const { ensureBuiltInRoles } = await import('./services/builtInRoles.js')
  await ensureBuiltInRoles('system')

  // 生产环境不注入 demo 管理员账号
  if (process.env.NODE_ENV !== 'production') {
    const demoHash = await hashPassword('admin123')
    await prisma.appUser.upsert({
      where: { id: DEMO_USER_ID },
      update: { passwordHash: demoHash, role: 'admin' },
      create: {
        id: DEMO_USER_ID,
        phone: '13800138000',
        passwordHash: demoHash,
        role: 'admin',
        name: '管理员',
        organization: '通标中研'
      }
    })
  }

  for (const plan of membershipPlans) {
    await prisma.membershipPlan.upsert({
      where: { id: plan.id },
      // 阶段 0（mp 远程配置底座）起：不再每次启动覆盖 DB
      // 运营在 admin 后台改 plan price / features / originalPrice 等字段后不被发版重置
      // 如需让新 hardcoded 默认值生效：admin 后台手动同步，或先 DELETE 该 plan 让 create 路径重新注入
      update: {},
      create: {
        id: plan.id,
        name: plan.name,
        price: plan.price,
        badge: plan.badge,
        description: plan.description,
        // featuresJson 从纯数组 ['xx','yy'] 升级为结构化对象，装完整元数据
        // 旧记录（纯数组）由 deserializePlanFeatures 向后兼容
        featuresJson: planFeaturesPayload(plan),
        status: 'ACTIVE'
      }
    })
  }

  // demo 数据 seed (membership / orders / compareTask) 统一只在非生产环境跑。
  // 生产环境 DEMO_USER_ID = '__no_demo__',AppUser 表里没有这条记录,
  // 强行 create userMembership / appOrder / compareTask 用这个 userId 会
  // 触发 P2003 Foreign key constraint violated。
  // 历史 bug:之前只把 demo user 创建那一段做了生产隔离 (line 537),
  // 但下面 demo data seed 没隔离,生产启动每次都会 catch 一次 prisma:error
  // "Failed to seed app data" warning(虽然不影响 API listen,但日志噪音)。
  if (process.env.NODE_ENV !== 'production') {
    const currentMembership = await prisma.userMembership.findFirst({
      where: { userId: DEMO_USER_ID, status: 'ACTIVE' }
    })
    if (!currentMembership) {
      await ensureActiveMembership(DEMO_USER_ID, 'pro')
    }

    const orderCount = await prisma.appOrder.count()
    if (orderCount === 0) {
      await prisma.appOrder.createMany({
        data: [
          {
            orderNo: 'ORD-20260309-001',
            userId: DEMO_USER_ID,
            planId: 'pro',
            productType: 'MEMBERSHIP',
            title: '专业包年会员',
            amount: 3998,
            status: 'PAID',
            channel: 'WECHAT',
            invoiceStatus: 'NOT_REQUESTED',
            paidAt: new Date('2026-03-09T10:15:00+08:00')
          },
          {
            orderNo: 'ORD-20260308-014',
            userId: DEMO_USER_ID,
            productType: 'STANDARD_DOWNLOAD',
            productRef: 't-cecs-10216-2024',
            title: 'T/CECS 10216-2024 按次查阅',
            amount: 69,
            status: 'PROCESSING',
            channel: 'ALIPAY',
            invoiceStatus: 'NOT_REQUESTED'
          }
        ]
      })
    }

    const compareCount = await prisma.compareTask.count()
    if (compareCount === 0) {
      const taskNo = 'CMP-20260309-018'
      await prisma.compareTask.create({
        data: {
          taskNo,
          userId: DEMO_USER_ID,
          documentName: '预制菜工厂设计说明书-v3.docx',
          fileType: 'docx',
          compareMode: 'all',
          selectedStandardIds: JSON.stringify(['t-cas-608-2023', 'gb-t-19001-2016']),
          status: 'COMPLETED',
          summaryJson: JSON.stringify({
            freeRisk: [
              '检测到 3 条已废止引用标准，建议优先修订引用清单。',
              '与 2 份现行标准综合相似度超过 70%，存在重复建设风险。',
              '第 5 章和第 6 章存在悬置段，正式立项前建议补齐。'
            ]
          }),
          reportJson: JSON.stringify(
            buildCompareReport({
              taskNo,
              documentName: '预制菜工厂设计说明书-v3.docx',
              selectedStandardIds: ['t-cas-608-2023', 'gb-t-19001-2016'],
              compareMode: 'all'
            })
          ),
          fullReportUnlockedAt: new Date('2026-03-09T11:55:00+08:00'),
          finishedAt: new Date('2026-03-09T11:40:00+08:00')
        }
      })
    }
  }

  await seedWorkbenchEntries()
  await seedSalesAiCoupon()
  // 阶段 0：mp 远程配置底座 — ContentConfig 12 分组默认值（upsert update:{}）
  await seedMpRemoteConfigGroups(prisma as any)

  // 专家评审投票（P0-1）：SystemSetting 默认值（upsert update:{}）
  const { ensureExpertVoteSettings } = await import('./services/expertVote.js')
  await ensureExpertVoteSettings()
}

// 销售推广页 — 标准小智 AI 详情页"专属优惠券"远程配置 seed
//   group=sales_ai_coupon / platform=WEB / type=COUPON_CARD / key=sales_ai_coupon_main
//   字段映射：
//     title       → 卡片标题（"专属优惠"）
//     subtitle    → 金额右侧文案（"会员直减券"）
//     description → 卡片说明段
//     content     → 金额数值字符串（"50" / 解析失败前端走 fallback）
//     extraJson   → 装结构化字段：tag / amountPrefix / amountSuffix / benefits[] /
//                   validityDays / scene / applicablePlans / ctaText / ctaAction
//   upsert update:{}：首次注入兜底默认值，后续 admin 运营改动不被发版覆盖
async function seedSalesAiCoupon() {
  await (prisma as any).contentConfig.upsert({
    where: { key: 'sales_ai_coupon_main' },
    update: {},
    create: {
      key: 'sales_ai_coupon_main',
      group: 'sales_ai_coupon',
      platform: 'WEB',
      type: 'COUPON_CARD',
      title: '专属优惠',
      subtitle: '会员直减券',
      description: '通过销售推广页注册即可获得，可用于购买任意会员套餐',
      content: '50',
      sortOrder: 1,
      enabled: true,
      extraJson: JSON.stringify({
        tag: '限时',
        amountPrefix: '¥',
        amountSuffix: '',
        benefits: ['注册即领', '全会员通用', '60 天有效'],
        validityDays: 60,
        scene: 'sales_promotion_ai_detail',
        applicablePlans: ['all'],
        ctaText: '',
        ctaAction: 'none',
      }),
    },
  })
}

// 工作台入口配置 seed —— 复用 ContentConfig 表
//   group=workbench_entries / platform=MP / type=ENTRY
//   现有 11 个工具 visible=true 保持现状顺序；新增 3 个骨架页 visible=false
//   upsert 仅 create，不 update — 管理员对 enabled/sortOrder 的运营调整不被发版覆盖
const WORKBENCH_ENTRIES_SEED: Array<{
  key: string
  label: string
  icon: string
  path: string
  isTab: boolean
  visible: boolean
  sort: number
}> = [
  { key: 'chat',          label: '呼叫小智',     icon: 'chat',          path: '/pages/chat/index',          isTab: false, visible: true,  sort: 1 },
  { key: 'scan',          label: '扫一扫',       icon: 'compare',       path: '/pages/scan/index',          isTab: false, visible: true,  sort: 2 },
  { key: 'committee',     label: '技术委员会',   icon: 'committee',     path: '/pages/committee/index',     isTab: false, visible: true,  sort: 3 },
  { key: 'graph',         label: '标准图谱',     icon: 'graph',         path: '/pages/graph/index',         isTab: false, visible: true,  sort: 4 },
  { key: 'industry',      label: '行业推荐',     icon: 'industry',      path: '/pages/industry/index',      isTab: false, visible: true,  sort: 5 },
  { key: 'outline',       label: '一句话生架构', icon: 'outline',       path: '/pages/outline/index',       isTab: false, visible: true,  sort: 6 },
  { key: 'compare',       label: '文档比对',     icon: 'compare',       path: '/pages/compare/index',       isTab: true,  visible: true,  sort: 7 },
  { key: 'booking',       label: '标准服务预约', icon: 'booking',       path: '/pages/booking/index',       isTab: false, visible: true,  sort: 8 },
  { key: 'certification', label: '认证',         icon: 'certification', path: '/pages/certification/index', isTab: false, visible: true,  sort: 9 },
  { key: 'training',      label: '培训',         icon: 'training',      path: '/pages/training/index',      isTab: false, visible: true,  sort: 10 },
  { key: 'standards',     label: '知识库检索',   icon: 'compare',       path: '/pages/standards/index',     isTab: false, visible: true,  sort: 11 },
  // 1.0.2 预埋骨架页（visible=false 默认隐藏，运营在 admin 后台开启）
  { key: 'workbench',     label: '我的工作台',   icon: 'compare',       path: '/pages/workbench/index',     isTab: false, visible: false, sort: 12 },
  { key: 'expert-vote',   label: '专家投票',     icon: 'compare',       path: '/pages/expert-vote/index',   isTab: false, visible: false, sort: 13 },
  { key: 'draft-center',  label: '草稿管理',     icon: 'compare',       path: '/pages/draft-center/index',  isTab: false, visible: false, sort: 14 },
]

async function seedWorkbenchEntries() {
  for (const e of WORKBENCH_ENTRIES_SEED) {
    await (prisma as any).contentConfig.upsert({
      where: { key: `workbench_entry_${e.key}` },
      // 已存在不动 — 管理员的 enabled/sortOrder 运营调整不被发版覆盖
      update: {},
      create: {
        key: `workbench_entry_${e.key}`,
        group: 'workbench_entries',
        platform: 'MP',
        type: 'ENTRY',
        title: e.label,
        sortOrder: e.sort,
        enabled: e.visible,
        extraJson: JSON.stringify({ icon: e.icon, path: e.path, isTab: e.isTab, originalKey: e.key }),
      },
    })
  }
}

type OrderRef = { orderNo: string; productType: string; userId: string | null; planId: string | null; productRef: string | null }

function normalizeRefundReason(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function formatCny(cents: number): string {
  return (cents / 100).toFixed(2)
}

async function withExpertVoteOrderStatus<T extends {
  orderNo: string
  productType: string
  productRef: string | null
}>(orders: T[]): Promise<Array<T & { expertVoteRequestStatus?: string | null }>> {
  const expertOrders = orders.filter((order) => order.productType === 'EXPERT_VOTE')
  if (expertOrders.length === 0) return orders

  const requestNos = expertOrders.map((order) => order.productRef).filter((v): v is string => !!v)
  const orderNos = expertOrders.map((order) => order.orderNo)
  const requests = await prisma.expertVoteRequest.findMany({
    where: {
      OR: [
        requestNos.length ? { requestNo: { in: requestNos } } : undefined,
        { orderNo: { in: orderNos } },
      ].filter(Boolean) as any,
    },
    select: { requestNo: true, orderNo: true, status: true },
  })
  const byRequestNo = new Map(requests.map((r) => [r.requestNo, r.status]))
  const byOrderNo = new Map(requests.filter((r) => r.orderNo).map((r) => [r.orderNo!, r.status]))

  return orders.map((order) => {
    if (order.productType !== 'EXPERT_VOTE') return order
    const status = (order.productRef && byRequestNo.get(order.productRef)) || byOrderNo.get(order.orderNo) || null
    return { ...order, expertVoteRequestStatus: status }
  })
}

/**
 * 支付后需要在 $transaction **外**执行的副作用。
 * trackServerEvent / markUserActive 都走外层 prisma，若在事务内调用会与
 * 当前事务的写锁自竞争，在慢盘（CI）下触发 "Operations timed out after N/A"。
 * 按系统边界 §11（journal_mode=delete + 单进程写入）收敛到事务外统一 flush。
 */
type PostPaymentEffects = {
  events: Array<{ event: string; props: Record<string, unknown>; userId: string | null }>
  markActiveUserIds: string[]
}

type PaymentSuccessResult = {
  order: Awaited<ReturnType<typeof prisma.appOrder.findUnique>>
  effects: PostPaymentEffects
  transitioned: boolean
}

function flushPostPaymentEffects(effects: PostPaymentEffects) {
  for (const e of effects.events) trackServerEvent(e.event, e.props, e.userId)
  for (const uid of effects.markActiveUserIds) markUserActive(uid)
}

/**
 * P0-2: 事务内版本 — 业务处理与订单状态更新共享同一事务
 * 副作用（埋点/活跃标记）收集到返回值里，由调用方在事务结束后 flush。
 */
async function handlePostPaymentInTx(tx: TxClient, order: OrderRef): Promise<PostPaymentEffects> {
  const effects: PostPaymentEffects = { events: [], markActiveUserIds: [] }

  if (order.productType === 'MEMBERSHIP' && order.userId && order.planId) {
    // 退款撤销时按 sourceRef=orderNo 精确匹配（执行 executeRefund 见 line ~2917）
    const membership = await ensureActiveMembershipInTx(tx, order.userId, order.planId, order.orderNo)
    if (membership && (membership as any).wasCreated !== false) {
      // 埋点：会员开通/续费（营销自动化：到期前提醒 R10/R11、首付欢迎 R08 依赖）
      effects.events.push({
        event: 'membership_activated',
        props: {
          planId: order.planId,
          orderNo: order.orderNo,
          source: 'PURCHASE',
          isRenewal: (membership as any).isRenewal === true,
          endAt: membership.endAt.toISOString(),
        },
        userId: order.userId,
      })
      effects.markActiveUserIds.push(order.userId)
    }
  }
  if (order.productType === 'COMPARE_REPORT' && order.productRef) {
    await tx.compareTask.update({
      where: { taskNo: order.productRef },
      data: { fullReportUnlockedAt: new Date() }
    })
  }
  if (order.productType === 'COMPARE_EXPORT' && order.productRef) {
    await tx.compareTask.update({
      where: { taskNo: order.productRef },
      data: { exportUnlockedAt: new Date() }
    })
  }
  // 专家评审投票（P0-1）：支付成功 → ExpertVoteRequest PAYING 迁 EXPERT_ARRANGING
  // CAS 在 transitionStatus 内完成，幂等（重复回调不会再迁移）
  if (order.productType === 'EXPERT_VOTE' && order.productRef) {
    const { transitionStatus } = await import('./services/expertVote.js')
    await transitionStatus(tx, order.productRef, 'PAYING', 'EXPERT_ARRANGING', { paidAt: new Date() })
  }

  // 裂变奖励：被邀请人首次付费触发（任务六 R14）
  // 同事务保证：奖励发放失败会回滚支付回调事务，下次微信重试仍可触达
  // 幂等保证：Referral.rewardedAt 非 null 就跳过
  if (order.userId) {
    await applyReferralRewardIfEligible(tx, order.userId)
  }

  return effects
}

/**
 * 支付成功提交（事务内）：
 *   - AppOrder: PENDING/PAYING/PENDING_VERIFY -> PAID
 *   - UserCoupon: LOCKED -> USED（若订单绑券）
 *   - 后置业务：会员开通 / 报告解锁 / 裂变奖励
 * 幂等：若订单已是 PAID，则不重复核销/不重复触发后置业务。
 */
async function finalizeSuccessfulPaymentInTx(
  tx: TxClient,
  params: { orderNo: string; paidAt: Date; channel?: 'WECHAT' | 'ALIPAY' }
): Promise<PaymentSuccessResult> {
  const data: any = {
    status: 'PAID',
    paidAt: params.paidAt,
  }
  if (params.channel) data.channel = params.channel

  const affected = await tx.appOrder.updateMany({
    where: { orderNo: params.orderNo, status: { in: ['PENDING', 'PAYING', 'PENDING_VERIFY'] } },
    data,
  })

  const order = await tx.appOrder.findUnique({ where: { orderNo: params.orderNo } })
  if (!order) {
    return {
      order: null,
      effects: { events: [], markActiveUserIds: [] },
      transitioned: false,
    }
  }
  if (affected.count === 0) {
    return {
      order,
      effects: { events: [], markActiveUserIds: [] },
      transitioned: false,
    }
  }

  if (order.userCouponId) {
    await redeemCouponByOrder(tx, order.orderNo, order.userCouponId)
  }

  const effects = await handlePostPaymentInTx(tx, order)
  effects.events.push({
    event: 'pay_success',
    props: {
      plan: order.planId,
      amount: order.amount,
      orderNo: order.orderNo,
      channel: order.channel,
    },
    userId: order.userId,
  })
  return { order, effects, transitioned: true }
}

/**
 * 给指定用户延长/新建 SYSTEM 会员的公共逻辑
 * 有 ACTIVE 会员 → 延长 endAt；无 → 新建 personal 体验期
 * sourceRef 由调用方拼，便于追溯来源（REFERRAL_REG_REWARD / REFERRAL_PAY_REWARD / 等）
 */
async function extendUserMembership(
  tx: TxClient,
  targetUserId: string,
  days: number,
  sourceRef: string,
  source: string = 'SYSTEM',
  salesCode: string | null = null,
): Promise<{ mode: 'extend_existing' | 'create_trial' }> {
  const ms = days * 24 * 60 * 60 * 1000
  const active = await tx.userMembership.findFirst({
    where: { userId: targetUserId, status: 'ACTIVE' },
    orderBy: { endAt: 'desc' },
  })
  if (active) {
    await tx.userMembership.update({
      where: { id: active.id },
      data: { endAt: new Date(active.endAt.getTime() + ms) },
    })
    return { mode: 'extend_existing' }
  }
  const startAt = new Date()
  const endAt = new Date(startAt.getTime() + ms)
  const created = await tx.userMembership.create({
    data: {
      userId: targetUserId,
      planId: 'personal',
      status: 'ACTIVE',
      source,
      sourceRef,
      salesCode,
      startAt, endAt,
    },
  })
  await writeAuditLog({
    actor: targetUserId,
    action: 'MEMBERSHIP_CREATED',
    targetType: 'UserMembership',
    targetId: created.id,
    diff: {
      userId: targetUserId,
      planId: 'personal',
      source,
      sourceRef,
      startAt: created.startAt.toISOString(),
      endAt: created.endAt.toISOString(),
      isRenewal: false,
    },
  }, tx)
  return { mode: 'create_trial' }
}

/**
 * R14 两级裂变 — 注册归因奖励（A3 方案：双方各 +7 天）
 * 在 POST /api/app/referral/track 写入 Referral 后同事务调用
 * 幂等：registrationRewardedAt 是双方奖励的共同标记（同事务写入/不写入，不存在半发状态）
 * 注册奖励不增 totalInvited（totalInvited 以"付费成功的邀请数"为口径）
 */
async function applyRegistrationReward(tx: TxClient, referralId: string, inviterId: string, inviteeId: string): Promise<void> {
  const row = await tx.referral.findUnique({ where: { id: referralId } })
  if (!row || row.registrationRewardedAt) return

  // 邀请人 +7 天
  const inviterResult = await extendUserMembership(
    tx, inviterId, 7, `REFERRAL_REG_REWARD:${inviteeId}`,
  )
  // 被邀请人 +7 天（A3 核心：注册即送，邀请活动的 hook）
  const inviteeResult = await extendUserMembership(
    tx, inviteeId, 7, `REFERRAL_REG_INVITEE_REWARD:${inviterId}`,
  )

  await tx.referral.update({
    where: { id: referralId },
    data: { registrationRewardedAt: new Date() },
  })

  trackServerEvent('referral_registration_rewarded', {
    inviterId, inviteeId,
    inviterMode: inviterResult.mode,
    inviteeMode: inviteeResult.mode,
  }, inviterId)
}

/**
 * R14 两级裂变：付费奖励（+30 天）+ 微信推送
 * 在 handlePostPaymentInTx 事务内调用，幂等看 paymentRewardedAt
 */
async function applyReferralRewardIfEligible(tx: TxClient, inviteeId: string): Promise<void> {
  const ref = await tx.referral.findUnique({ where: { inviteeId } })
  if (!ref || ref.paymentRewardedAt) return

  const { mode } = await extendUserMembership(tx, ref.inviterId, 30, `REFERRAL_PAY_REWARD:${inviteeId}`)

  await tx.referral.update({
    where: { id: ref.id },
    data: { paymentRewardedAt: new Date() },
  })

  // totalInvited 以"付费成功的邀请数"为口径
  await tx.referralCode.updateMany({
    where: { userId: ref.inviterId },
    data: { totalInvited: { increment: 1 } },
  })

  trackServerEvent('referral_payment_rewarded', { inviterId: ref.inviterId, inviteeId, mode }, ref.inviterId)

  // 奖励到账推送（R14 REWARD 变种），setImmediate 延迟到 tx commit 之后
  // refId 用 inviteeId 保证幂等（每个邀请关系的付费奖励只推一次）
  const inviterId = ref.inviterId
  setImmediate(() => {
    sendPushForRule({
      userId: inviterId,
      ruleId: 'R14',
      templateId: TEMPLATE_REFERRAL,
      templateData: {
        thing1: '邀请奖励已到账',
        thing2: '您邀请的好友已完成首次付费，30天会员已发放',
      },
      refId: `reward:${inviteeId}`,
    }).catch(() => { /* 静默：推送失败不影响奖励发放 */ })
  })
}

/**
 * 支付成功后的后续处理（会员开通、报告解锁等）
 * 非回调路径（mock / alipay）使用此函数，自带独立事务
 */
export async function handlePostPayment(order: OrderRef) {
  const effects = await runPaymentTx(
    (tx) => handlePostPaymentInTx(tx, order),
  )
  flushPostPaymentEffects(effects)
}

// ─── 微信 code2Session 辅助 ─────────────────────────────────
type WxCode2SessionResult = { openid?: string; session_key?: string; errcode?: number; errmsg?: string }
type WxCode2SessionFetcher = (code: string) => Promise<WxCode2SessionResult>
let __wxCode2SessionFetcher: WxCode2SessionFetcher | null = null
/** 测试注入：替换 wxCode2Session 实现，避免真调微信 */
export function __setWxCode2SessionFetcher(fn: WxCode2SessionFetcher | null) { __wxCode2SessionFetcher = fn }

function wxCode2Session(code: string): Promise<WxCode2SessionResult> {
  if (__wxCode2SessionFetcher) return __wxCode2SessionFetcher(code)
  // 本地 dev：BXZ_DEV_MOCK_WX_LOGIN=true 时返回固定 openid，跳过真实微信调用
  // 生产环境无此 env，正常走 sns/jscode2session。
  if (process.env.BXZ_DEV_MOCK_WX_LOGIN === 'true') {
    const openid = 'dev-mock-openid-' + (code || 'static').slice(-6)
    return Promise.resolve({ openid, session_key: 'dev-mock-session-key' })
  }
  const appid = process.env.WX_APPID
  const secret = process.env.WX_SECRET
  if (!appid || !secret) return Promise.reject(new Error('WX_APPID / WX_SECRET not configured'))
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appid}&secret=${secret}&js_code=${code}&grant_type=authorization_code`
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, (resp) => {
      let data = ''
      resp.on('data', (c: Buffer) => { data += c })
      resp.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { reject(new Error('WeChat API response parse error')) }
      })
    }).on('error', reject)
  })
}

export function registerAppRoutes(app: Express) {
  // Global: parse JWT on all /api/app routes (non-blocking)
  app.use('/api/app', optionalAuth)

  // ─── 微信小程序登录 ────────────────────────────────────────
  app.post('/api/app/auth/wx-login', async (req, res) => {
    const { code, salesCode: rawSalesCode, inviteCode: rawInviteCode } = req.body
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: '缺少 code 参数' })
    }

    // Feature flag：与 register 一致，false 时退回老逻辑
    const inlineInvite = process.env.BXZ_INVITECODE_INLINE !== 'false'
    const inviteCodeNorm = inlineInvite && typeof rawInviteCode === 'string'
      ? rawInviteCode.trim().toUpperCase()
      : ''

    // ① 邀请码校验（不存在 → 400 早返回，wx code 不消耗）
    let inviterId: string | null = null
    if (inviteCodeNorm) {
      const rcRow = await prisma.referralCode.findUnique({ where: { code: inviteCodeNorm }, select: { userId: true } })
      if (!rcRow) {
        return res.status(400).json({ error: '邀请码无效或已停用', field: 'inviteCode' })
      }
      inviterId = rcRow.userId
    }

    let wxRes: Awaited<ReturnType<typeof wxCode2Session>>
    try {
      wxRes = await wxCode2Session(code)
    } catch (e: any) {
      console.error('[wx-login] code2Session failed:', e.message)
      return res.status(502).json({ error: '微信服务调用失败，请稍后重试' })
    }

    if (wxRes.errcode || !wxRes.openid) {
      console.error('[wx-login] WeChat error:', wxRes.errcode, wxRes.errmsg)
      return res.status(400).json({ error: wxRes.errmsg || '微信登录失败' })
    }

    const openId = wxRes.openid

    // ② 销售归因校验（互斥：inviteCode 命中时跳过）
    let attributedSalesCode: string | null = null
    if (!inviterId && rawSalesCode && typeof rawSalesCode === 'string') {
      const codeRow = await prisma.salesCode.findUnique({ where: { salesCode: rawSalesCode } })
      if (codeRow && codeRow.status === 'ACTIVE') {
        const sp = await prisma.salesProfile.findUnique({ where: { id: codeRow.profileId } })
        if (sp && sp.status === 'ENABLED') attributedSalesCode = rawSalesCode
      } else {
        const sp = await prisma.salesProfile.findUnique({ where: { salesCode: rawSalesCode } })
        if (sp && sp.status === 'ENABLED') attributedSalesCode = sp.salesCode
      }
    }

    // ③ 查找已有用户
    let user = await prisma.appUser.findUnique({ where: { openId } })
    const isFirstLogin = !user

    // ④ 自邀防御：老用户用自己的码 → 静默忽略 inviteCode
    let inviterIdForTx: string | null = inviterId
    if (inviterId && user && user.id === inviterId) {
      inviterIdForTx = null
    }

    if (!user) {
      const userId = `wx-${openId.slice(-12)}-${Date.now().toString(36)}`
      user = await prisma.appUser.create({
        data: {
          id: userId,
          openId,
          name: '微信用户',
          role: 'user',
          // inviteCode 命中时不写销售归因
          salesCode: inviterIdForTx ? null : attributedSalesCode,
        }
      })
    }

    // ⑤ 归因奖励 — 仅首次创建用户时发
    if (isFirstLogin) {
      const userIdLocal = user.id
      // 裂变归因路径
      if (inviterIdForTx) {
        try {
          await prisma.$transaction(async (tx) => {
            const refRow = await tx.referral.create({ data: { inviterId: inviterIdForTx!, inviteeId: userIdLocal } })
            await applyRegistrationReward(tx, refRow.id, inviterIdForTx!, userIdLocal)
          })
          trackServerEvent('referral_tracked', { inviterId: inviterIdForTx, inviteeId: userIdLocal }, userIdLocal)
        } catch (err: any) {
          console.error('[wx-login] 裂变归因写入失败', { err: err?.message, userId: userIdLocal, inviterId: inviterIdForTx })
        }
      } else if (attributedSalesCode) {
        // 销售归因路径：7 天 SALES_REFERRAL + ¥50 直减券
        try {
          await extendUserMembership(
            prisma as any,
            userIdLocal,
            7,
            `SALES_REFERRAL:${attributedSalesCode}`,
            'SALES_REFERRAL',
            attributedSalesCode,
          )
        } catch (err: any) {
          console.error('[wx-login] 销售归因会员发放失败', { err: err?.message, userId: userIdLocal, salesCode: attributedSalesCode })
        }
        try {
          await issueSalesPromoCouponOnRegister(prisma as any, userIdLocal)
        } catch (err: any) {
          console.error('[wx-login] 销售归因优惠券发放失败', { err: err?.message, userId: userIdLocal, salesCode: attributedSalesCode })
        }
      }
    }

    const token = signJwt({ sub: user.id, phone: user.phone, role: user.role, enterpriseId: user.enterpriseId ?? null, enterpriseRole: user.enterpriseRole ?? null })

    const membership = await prisma.userMembership.findFirst({
      where: { userId: user.id, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      include: { plan: true }
    })

    res.json({
      token,
      user: {
        id: user.id, phone: user.phone, email: user.email,
        name: user.name, organization: user.organization,
        role: user.role, avatarUrl: user.avatarUrl,
        createdAt: user.createdAt,
        needBindPhone: !user.phone,  // 告诉前端是否需要绑定手机
        enterpriseId: user.enterpriseId ?? null,
        enterpriseRole: user.enterpriseRole ?? null,
      },
      membership: serializeMembership(membership)
    })
  })

  // ─── 绑定手机号（微信用户首次绑定）────────────────────────
  app.post('/api/app/auth/bind-phone', requireAuth, async (req: AuthRequest, res) => {
    const schema = z.object({
      phone: z.string().regex(/^1[3-9]\d{9}$/, '请输入有效手机号'),
      smsCode: z.string().length(6, '短信验证码为6位'),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })

    const { phone, smsCode } = parsed.data
    const userId = req.userId!

    // 验证手机短信验证码
    const codeRecord = await prisma.verificationCode.findFirst({
      where: { target: phone, type: 'phone', usedAt: null, expiresAt: { gte: new Date() } },
      orderBy: { createdAt: 'desc' },
    })
    if (!codeRecord || codeRecord.code !== smsCode) {
      return res.status(400).json({ error: '短信验证码无效或已过期' })
    }
    await prisma.verificationCode.update({
      where: { id: codeRecord.id },
      data: { usedAt: new Date() },
    })

    // 验证手机号没被其他账号占用
    const existingPhone = await prisma.appUser.findUnique({ where: { phone } })
    if (existingPhone && existingPhone.id !== userId) {
      // 手机号已有账号 → 合并：把 openId 迁移到已有账号
      const currentUser = await prisma.appUser.findUnique({ where: { id: userId } })
      if (currentUser?.openId) {
        // 目标账号已有 openId → 不能覆盖，先清空当前用户的 openId 再迁移
        if (existingPhone.openId && existingPhone.openId !== currentUser.openId) {
          return res.status(409).json({ error: '该手机号已绑定其他微信，请联系客服处理' })
        }
        // 先清空临时账号的 openId，再迁移到目标账号（顺序不能反，否则唯一约束冲突）
        const openIdToMigrate = currentUser.openId
        await prisma.appUser.update({ where: { id: userId }, data: { openId: null } })
        if (!existingPhone.openId) {
          await prisma.appUser.update({
            where: { id: existingPhone.id },
            data: { openId: openIdToMigrate }
          })
        }
        // 删除临时微信账号（如无关联数据）
        const hasOrders = await prisma.appOrder.count({ where: { userId } })
        const hasTasks = await prisma.compareTask.count({ where: { userId } })
        if (hasOrders === 0 && hasTasks === 0) {
          await prisma.appUser.delete({ where: { id: userId } }).catch(() => {})
        }
        // 签发已有账号的 token
        const token = signJwt({ sub: existingPhone.id, phone: existingPhone.phone, role: existingPhone.role })
        const membership = await prisma.userMembership.findFirst({
          where: { userId: existingPhone.id, status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          include: { plan: true }
        })
        return res.json({
          token, merged: true,
          user: {
            id: existingPhone.id, phone: existingPhone.phone, email: existingPhone.email,
            name: existingPhone.name, organization: existingPhone.organization,
            role: existingPhone.role, avatarUrl: existingPhone.avatarUrl,
            createdAt: existingPhone.createdAt, needBindPhone: false,
          },
          membership: serializeMembership(membership)
        })
      }
      return res.status(409).json({ error: '该手机号已被其他账号绑定' })
    }

    // 绑定手机号
    const updateData: any = { phone }

    const user = await prisma.appUser.update({ where: { id: userId }, data: updateData })

    const token = signJwt({ sub: user.id, phone: user.phone, role: user.role })

    // 查询该用户的会员状态（非合并路径也需要返回）
    const membership = await prisma.userMembership.findFirst({
      where: { userId: user.id, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      include: { plan: true }
    })

    res.json({
      token,
      user: {
        id: user.id, phone: user.phone, email: user.email,
        name: user.name, organization: user.organization,
        role: user.role, avatarUrl: user.avatarUrl,
        createdAt: user.createdAt, needBindPhone: false,
      },
      membership: serializeMembership(membership)
    })
  })

  // ─── 注册 ────────────────────────────────────────────────
  const registerSchema = z.object({
    phone: z.string().regex(/^1[3-9]\d{9}$/, '请输入有效手机号'),
    smsCode: z.string().length(6, '短信验证码为6位'),
    password: z.string().min(6, '密码至少6位').max(64),
    email: z.string().email('请输入有效邮箱').optional().or(z.literal('')),
    name: z.string().optional(),
    organization: z.string().optional(),
    salesCode: z.string().max(16).optional(),  // 销售归因：前端从 URL/cookie 读出传入
    inviteCode: z.string().max(16).optional(), // 裂变归因：用户手填邀请码（与 salesCode 互斥，inviteCode 优先）
  })

  app.post('/api/app/auth/register', async (req, res) => {
    // 注册接口也加速率限制，防止暴力枚举验证码
    const regIp = getClientIp(req)
    const regRate = checkLoginRateLimit(regIp)
    if (regRate.blocked) {
      return res.status(429).json({ error: '操作过于频繁，请 15 分钟后再试' })
    }

    const parsed = registerSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })

    const { phone, smsCode, password, email, name, organization, salesCode: rawSalesCode, inviteCode: rawInviteCode } = parsed.data

    // Feature flag：BXZ_INVITECODE_INLINE=false 时退回老逻辑（忽略 inviteCode，前端事后调 /referral/track）
    const inlineInvite = process.env.BXZ_INVITECODE_INLINE !== 'false'
    const inviteCodeNorm = inlineInvite ? (rawInviteCode || '').trim().toUpperCase() : ''

    // ① 邀请码校验（在 SMS 消耗之前；不存在 → 400 早返回，验证码不消费）
    let inviterId: string | null = null
    if (inviteCodeNorm) {
      const rcRow = await prisma.referralCode.findUnique({ where: { code: inviteCodeNorm }, select: { userId: true } })
      if (!rcRow) {
        return res.status(400).json({ error: '邀请码无效或已停用', field: 'inviteCode' })
      }
      inviterId = rcRow.userId
    }

    // ② 销售归因校验（互斥：inviteCode 命中时整段跳过，强制 attributedSalesCode = null）
    // 无效/停用/不存在 → 静默忽略，不阻塞注册
    let attributedSalesCode: string | null = null
    if (!inviterId && rawSalesCode) {
      const codeRow = await prisma.salesCode.findUnique({ where: { salesCode: rawSalesCode } })
      if (codeRow && codeRow.status === 'ACTIVE') {
        const sp = await prisma.salesProfile.findUnique({ where: { id: codeRow.profileId } })
        if (sp && sp.status === 'ENABLED') attributedSalesCode = rawSalesCode
      } else {
        const sp = await prisma.salesProfile.findUnique({ where: { salesCode: rawSalesCode } })
        if (sp && sp.status === 'ENABLED') attributedSalesCode = sp.salesCode
      }
    }

    // ③ 验证手机短信验证码（找到记录但暂不消耗，留到事务里 update usedAt 保证原子）
    const codeRecord = await prisma.verificationCode.findFirst({
      where: { target: phone, type: 'phone', usedAt: null, expiresAt: { gte: new Date() } },
      orderBy: { createdAt: 'desc' },
    })
    if (!codeRecord || codeRecord.code !== smsCode) {
      return res.status(400).json({ error: '短信验证码无效或已过期' })
    }

    // ④ 已注册检查
    const existingByPhone = await prisma.appUser.findUnique({ where: { phone } })
    if (existingByPhone?.passwordHash) {
      return res.status(409).json({ error: '该手机号已注册，请直接登录' })
    }
    if (email) {
      const existingByEmail = await prisma.appUser.findFirst({ where: { email } })
      if (existingByEmail?.passwordHash) {
        return res.status(409).json({ error: '该邮箱已注册，请直接登录' })
      }
    }

    const pwHash = await hashPassword(password)
    const userId = createId()

    // ⑤ 自邀防御：existingByPhone 自己用自己的码 → 静默忽略 inviteCode（不建 Referral）
    let inviterIdForTx: string | null = inviterId
    if (inviterId && existingByPhone && existingByPhone.id === inviterId) {
      inviterIdForTx = null
    }

    // ⑥ 事务：消耗 SMS + 创建/更新 user + 归因奖励 一气呵成
    const user = await prisma.$transaction(async (tx) => {
      await tx.verificationCode.update({
        where: { id: codeRecord.id },
        data: { usedAt: new Date() },
      })

      const u = existingByPhone
        ? await tx.appUser.update({
            where: { phone },
            data: {
              passwordHash: pwHash,
              email,
              name: name || existingByPhone.name,
              organization: organization || existingByPhone.organization,
              // salesCode：首次归因优先；inviteCode 命中时不写销售归因
              salesCode: existingByPhone.salesCode || (inviterIdForTx ? null : attributedSalesCode) || null,
            },
          })
        : await tx.appUser.create({
            data: {
              id: userId,
              phone,
              email,
              passwordHash: pwHash,
              name: name || `用户${phone.slice(-4)}`,
              organization,
              role: 'user',
              salesCode: inviterIdForTx ? null : attributedSalesCode,
            }
          })

      // 裂变归因路径：建 Referral + 双方各 +7 天（已注册用户不再奖励）
      if (inviterIdForTx && !existingByPhone) {
        try {
          const refRow = await tx.referral.create({ data: { inviterId: inviterIdForTx, inviteeId: u.id } })
          await applyRegistrationReward(tx, refRow.id, inviterIdForTx, u.id)
        } catch (err: any) {
          // UNIQUE 冲突（理论上 u 是新建，inviteeId 不可能已有）兜底为静默
          console.error('[register] 裂变归因写入失败', { err: err?.message, userId: u.id, inviterId: inviterIdForTx })
        }
      }

      // 销售归因路径：仅首次创建用户 + 有效 attributedSalesCode 时发 7 天 SALES_REFERRAL + ¥50 直减券
      if (!inviterIdForTx && attributedSalesCode && !existingByPhone) {
        try {
          await extendUserMembership(
            tx,
            u.id,
            7,
            `SALES_REFERRAL:${attributedSalesCode}`,
            'SALES_REFERRAL',
            attributedSalesCode,
          )
        } catch (err: any) {
          console.error('[register] 销售归因会员发放失败', { err: err?.message, userId: u.id, salesCode: attributedSalesCode })
        }
        try {
          await issueSalesPromoCouponOnRegister(tx, u.id)
        } catch (err: any) {
          console.error('[register] 销售归因优惠券发放失败', { err: err?.message, userId: u.id, salesCode: attributedSalesCode })
        }
      }

      return u
    })

    const token = signJwt({ sub: user.id, phone: user.phone, role: user.role })

    // 事务外埋点
    if (inviterIdForTx && !existingByPhone) {
      trackServerEvent('referral_tracked', { inviterId: inviterIdForTx, inviteeId: user.id }, user.id)
    }

    const membership = await prisma.userMembership.findFirst({
      where: { userId: user.id, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      include: { plan: true }
    })

    res.status(201).json({
      token,
      user: { id: user.id, phone: user.phone, email: user.email, name: user.name, organization: user.organization, role: user.role, avatarUrl: user.avatarUrl, createdAt: user.createdAt },
      membership: serializeMembership(membership)
    })
  })

  // ─── 登录（支持手机号或邮箱）────────────────────────────
  const loginSchema = z.object({
    account: z.string().min(1, '请输入手机号或邮箱').optional(),
    phone: z.string().optional(),  // 兼容旧客户端
    password: z.string().min(1, '请输入密码')
  })

  app.post('/api/app/auth/login', async (req, res) => {
    const ip = getClientIp(req)
    const rateCheck = checkLoginRateLimit(ip)
    if (rateCheck.blocked) {
      return res.status(429).json({ error: '登录失败次数过多，请 15 分钟后再试' })
    }

    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })

    const account = (parsed.data.account || parsed.data.phone || '').trim()
    const { password } = parsed.data

    if (!account) {
      return res.status(400).json({ error: '请输入手机号或邮箱' })
    }

    // 判断是邮箱还是手机号
    const isEmail = account.includes('@')
    const user = isEmail
      ? await prisma.appUser.findFirst({ where: { email: account } })
      : await prisma.appUser.findUnique({ where: { phone: account } })

    if (!user) {
      recordLoginFailure(ip)
      return res.status(404).json({ error: '该账号未注册，请前往网页版注册' })
    }
    if (!user.passwordHash) {
      recordLoginFailure(ip)
      return res.status(401).json({ error: '账号或密码错误' })
    }

    const valid = await verifyPassword(password, user.passwordHash)
    if (!valid) {
      recordLoginFailure(ip)
      return res.status(401).json({ error: '账号或密码错误' })
    }
    resetLoginAttempts(ip)

    const token = signJwt({ sub: user.id, phone: user.phone, role: user.role, enterpriseId: user.enterpriseId ?? null, enterpriseRole: user.enterpriseRole ?? null })

    const membership = await prisma.userMembership.findFirst({
      where: { userId: user.id, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      include: { plan: true }
    })

    res.json({
      token,
      user: { id: user.id, phone: user.phone, email: user.email, name: user.name, organization: user.organization, role: user.role, avatarUrl: user.avatarUrl, createdAt: user.createdAt, enterpriseId: user.enterpriseId ?? null, enterpriseRole: user.enterpriseRole ?? null, passwordMustChange: user.passwordMustChange === true },
      membership: serializeMembership(membership)
    })
  })

  // ─── 修改密码 ────────────────────────────────────────────
  app.post('/api/app/auth/change-password', requireAuth, async (req: AuthRequest, res) => {
    const schema = z.object({
      oldPassword: z.string().min(1),
      newPassword: z.string().min(6).max(64),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message })

    const user = await prisma.appUser.findUnique({ where: { id: req.userId } })
    if (!user?.passwordHash) return res.status(400).json({ error: '账户异常' })

    const valid = await verifyPassword(parsed.data.oldPassword, user.passwordHash)
    if (!valid) return res.status(401).json({ error: '原密码错误' })

    const newHash = await hashPassword(parsed.data.newPassword)
    await prisma.appUser.update({ where: { id: req.userId }, data: { passwordHash: newHash, passwordMustChange: false } })

    res.json({ message: '密码修改成功' })
  })

  // ─── 忘记密码：重置密码（手机短信验证码校验）─────────────────────
  const resetPasswordSchema = z.object({
    phone: z.string().regex(/^1[3-9]\d{9}$/, '请输入有效手机号'),
    smsCode: z.string().length(6, '验证码为6位'),
    newPassword: z.string().min(6, '密码至少6位').max(64),
  })

  app.post('/api/app/auth/reset-password', async (req, res) => {
    // 重置密码也加速率限制
    const rstIp = getClientIp(req)
    const rstRate = checkLoginRateLimit(rstIp)
    if (rstRate.blocked) {
      return res.status(429).json({ error: '操作过于频繁，请 15 分钟后再试' })
    }

    const parsed = resetPasswordSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })

    const { phone, smsCode, newPassword } = parsed.data

    // 查找用户
    const user = await prisma.appUser.findUnique({ where: { phone } })
    if (!user) return res.status(404).json({ error: '该手机号未注册' })

    // 验证短信验证码
    const codeRecord = await prisma.verificationCode.findFirst({
      where: { target: phone, type: 'phone', usedAt: null, expiresAt: { gte: new Date() } },
      orderBy: { createdAt: 'desc' },
    })
    if (!codeRecord || codeRecord.code !== smsCode) {
      return res.status(400).json({ error: '验证码无效或已过期' })
    }
    await prisma.verificationCode.update({
      where: { id: codeRecord.id },
      data: { usedAt: new Date() },
    })

    // 更新密码
    const newHash = await hashPassword(newPassword)
    await prisma.appUser.update({ where: { id: user.id }, data: { passwordHash: newHash, passwordMustChange: false } })

    res.json({ message: '密码重置成功，请使用新密码登录' })
  })

  // ─── 站内通知中心（铃铛 + 列表 + 标记已读）──────────────
  // GET /api/app/notifications?page=1&pageSize=20
  // 返回未读 + 最近已读，按 createdAt DESC 分页；附带 unreadCount 用于铃铛红点
  app.get('/api/app/notifications', requireAuth, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store') // 发版 SOP 铁律 3：用户实时状态必加
    const userId = req.userId!
    const page = Math.max(1, Math.min(Number(req.query.page) || 1, 1000))
    const pageSize = Math.max(1, Math.min(Number(req.query.pageSize) || 20, 100))
    const [items, unreadCount, total] = await Promise.all([
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.notification.count({ where: { userId, readAt: null } }),
      prisma.notification.count({ where: { userId } }),
    ])
    res.json({ items, unreadCount, total, page, pageSize })
  })

  // POST /api/app/notifications/:id/read
  // 标记单条已读；幂等（重复调不报错）；只允许本人操作
  app.post('/api/app/notifications/:id/read', requireAuth, async (req: AuthRequest, res) => {
    const userId = req.userId!
    const id = String(req.params.id)
    const r = await prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    })
    res.json({ ok: true, updated: r.count })
  })

  // POST /api/app/notifications/read-all
  // 一键全部已读，便于前端"清空红点"
  app.post('/api/app/notifications/read-all', requireAuth, async (req: AuthRequest, res) => {
    const userId = req.userId!
    const r = await prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    })
    res.json({ ok: true, updated: r.count })
  })

  // ─── 裂变邀请（任务六 R14）─────────────────────────────

  const REFERRAL_QR_PAGE = 'pages/home/index'
  // 旧缓存使用了不存在的 pages/index/index；早于此修复点的缓存下次访问时刷新一次。
  const REFERRAL_QR_PAGE_FIX_CUTOFF = new Date('2026-05-27T08:50:00.000Z')

  // GET /api/app/referral/code — 生成/获取当前用户的邀请码 + 小程序码
  // 首次调：生成 8 位邀请码 + 调微信 wxacode.getUnlimited，base64 缓存到 DB
  // 非首次：直接返回缓存；缓存失效（qrcodeBase64 为空）时重新生成
  app.get('/api/app/referral/code', requireAuth, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const userId = req.userId!

    let row = await prisma.referralCode.findUnique({ where: { userId } })
    if (!row) {
      // 生成 8 位邀请码（排除易混淆字符）
      const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
      let code = ''
      for (let tries = 0; tries < 5; tries++) {
        code = Array.from({ length: 8 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('')
        try {
          row = await prisma.referralCode.create({ data: { userId, code } })
          break
        } catch { /* 极小概率 code 撞号重试 */ }
      }
      if (!row) return res.status(500).json({ error: '生成邀请码失败，请稍后重试' })
    }

    // 需要生成或刷新小程序码
    const shouldRefreshQr = !row.qrcodeBase64
      || !row.qrcodeUpdatedAt
      || row.qrcodeUpdatedAt < REFERRAL_QR_PAGE_FIX_CUTOFF
    if (shouldRefreshQr) {
      const scene = `ref_${userId}`
      if (scene.length > 32) {
        // 微信 wxacode scene 限 32 字符；userId 过长时退化为 code
        // （当前 userId 最长不会超，兜底而已）
      }
      const r = await getWxaCode({ scene, page: REFERRAL_QR_PAGE })
      if (!r.ok) {
        return res.status(502).json({ error: '小程序码生成失败', errmsg: r.errmsg, errcode: r.errcode })
      }
      row = await prisma.referralCode.update({
        where: { id: row.id },
        data: { qrcodeBase64: r.base64, qrcodeUpdatedAt: new Date() },
      })
    }

    res.json({
      code: row.code,
      qrcodeBase64: row.qrcodeBase64,
      totalInvited: row.totalInvited,
    })
  })

  // POST /api/app/referral/track — 归因上报（mp 登录后 / PC 注册登录后通用）
  // body: { scene: "ref_<inviterIdOrCode>" }
  //   mp 端 scene 来自小程序码 scene，值 = userId（cuid/user-<phone>）
  //   PC 端 scene 来自 URL ?ref=<CODE>，值 = ReferralCode.code（8 位短码）
  // 后端先按 userId 精确查，没命中再按 code 查 ReferralCode → 解析出 inviterId
  app.post('/api/app/referral/track', requireAuth, async (req: AuthRequest, res) => {
    const inviteeId = req.userId!
    const scene = typeof req.body?.scene === 'string' ? req.body.scene : ''
    if (!scene.startsWith('ref_')) {
      return res.status(400).json({ error: 'scene 格式不合法' })
    }
    const sceneValue = scene.slice(4)
    if (!sceneValue) return res.status(400).json({ error: 'scene 值缺失' })

    // 优先按 userId 查（小程序路径）
    let inviter = await prisma.appUser.findUnique({ where: { id: sceneValue }, select: { id: true } })
    // 未命中则按 ReferralCode.code 查（PC 短码路径）
    if (!inviter) {
      const codeRow = await prisma.referralCode.findUnique({ where: { code: sceneValue }, select: { userId: true } })
      if (codeRow) {
        inviter = await prisma.appUser.findUnique({ where: { id: codeRow.userId }, select: { id: true } })
      }
    }
    if (!inviter) {
      return res.json({ ok: false, reason: 'INVITER_NOT_FOUND' })
    }
    const inviterId = inviter.id

    // 自邀自禁止
    if (inviterId === inviteeId) {
      return res.json({ ok: false, reason: 'SELF_INVITE_IGNORED' })
    }

    // 被邀请人已有归属 → 先到先得，静默忽略
    const existing = await prisma.referral.findUnique({ where: { inviteeId } })
    if (existing) {
      return res.json({ ok: false, reason: 'ALREADY_ATTRIBUTED', inviterId: existing.inviterId })
    }

    try {
      // 归因 + 注册奖励发放同事务，保证"成功归因必有 +7 天"
      const ref = await prisma.$transaction(async (tx) => {
        const row = await tx.referral.create({ data: { inviterId, inviteeId } })
        await applyRegistrationReward(tx, row.id, inviterId, inviteeId)
        return row
      })
      trackServerEvent('referral_tracked', { inviterId, inviteeId }, inviteeId)
      res.json({ ok: true, referralId: ref.id })
    } catch (err: any) {
      // 并发竞态：UNIQUE 冲突兜底
      res.json({ ok: false, reason: 'ALREADY_ATTRIBUTED' })
    }
  })

  // ─── 埋点上报 ────────────────────────────────────────
  app.post('/api/app/track', ipRateLimit(60, 60_000), optionalAuth, async (req: AuthRequest, res) => {
    const body = req.body
    if (!body || !body.event || !body.platform) {
      return res.status(400).json({ error: '缺少 event 或 platform' })
    }
    const allowed = ['pc', 'mp']
    if (!allowed.includes(body.platform)) {
      return res.status(400).json({ error: 'platform 必须是 pc 或 mp' })
    }
    // fire-and-forget，立即返回 204
    trackEvent({
      event: String(body.event).slice(0, 100),
      props: body.props && typeof body.props === 'object' ? body.props : undefined,
      platform: body.platform,
      userId: req.userId || body.userId || null,
      sessionId: body.sessionId ? String(body.sessionId).slice(0, 64) : null,
      clientTs: typeof body.ts === 'number' ? body.ts : null,
      ip: req.ip || null,
      ua: req.headers['user-agent'] || null,
    }).catch(() => {})
    res.status(204).end()
  })

  // ─── 工作台入口配置（公开接口，小程序工作台动态渲染用）──
  // 数据源：ContentConfig group=workbench_entries（seed 见 seedWorkbenchEntries）
  // 仅返回 enabled=true 条目；visible=false 由管理员后台开关
  // 失败时小程序端 fallback 到本地 tools-config.js（双层保险）
  app.get('/api/app/workbench/entries', async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300') // 5 分钟客户端缓存，减压
    try {
      const rows = await getContentConfigGroup('workbench_entries')
      const items = rows.map((r: any) => {
        const extra = (() => { try { return JSON.parse(r.extraJson || '{}') } catch { return {} } })()
        return {
          key: extra.originalKey || r.key.replace(/^workbench_entry_/, ''),
          label: r.title || '',
          icon: extra.icon || 'compare',
          path: extra.path || '',
          isTab: !!extra.isTab,
          visible: !!r.enabled,
          sort: r.sortOrder || 0,
          // 阶段 0：扩 condition / gatedByFlag，让前端按 flag 决定是否展示
          //   condition: 自定义可见性条件（如 'paid_user' / 'role:sales'），前端结合 user state 判断
          //   gatedByFlag: 关联 feature-flags 接口里的 flag key，flag=false 时不展示
          condition: typeof extra.condition === 'string' ? extra.condition : null,
          gatedByFlag: typeof extra.gatedByFlag === 'string' ? extra.gatedByFlag : null,
        }
      })
      res.json({ items })
    } catch (err: any) {
      console.error('[workbench/entries]', err)
      res.status(500).json({ error: '工作台配置加载失败' })
    }
  })

  app.get('/api/app/home', async (_req, res) => {
    const [userCount, orderCount, compareCount, annRow] = await Promise.all([
      prisma.appUser.count(),
      prisma.appOrder.count({ where: { status: 'PAID' } }),
      prisma.compareTask.count(),
      prisma.systemSetting.findUnique({ where: { key: 'announcements_list' } }).catch(() => null),
    ])
    const dbAnnouncements = annRow ? JSON.parse(annRow.value) : []

    res.json({
      heroStats: {
        standards: 480000,
        users: userCount,
        orders: orderCount,
        compareTasks: compareCount,
      },
      announcements: dbAnnouncements,
      quickEntries: [
        { key: 'national', title: '国家标准库', route: '/standards/national' },
        { key: 'group', title: '团体标准库', route: '/standards/group' },
        { key: 'compare', title: '文档比对', route: '/compare' },
        { key: 'booking', title: '标准服务', route: '/booking' }
      ],
      featuredStandards: standards.slice(0, 4),
      membershipBanner: {
        title: '专业包年会员',
        subtitle: '标准检索、报告解锁与优先比对'
      }
    })
  })

  // 公告详情（公开只读，与 /api/app/home 同一数据源 systemSetting:announcements_list）
  app.get('/api/app/announcements/:id', async (req, res) => {
    const id = req.params.id
    const row = await prisma.systemSetting
      .findUnique({ where: { key: 'announcements_list' } })
      .catch(() => null)
    const list: any[] = row ? JSON.parse(row.value) : []
    const item = list.find((a) => a && a.id === id)
    if (!item) return res.status(404).json({ error: '公告不存在' })
    res.json({
      id: item.id,
      title: item.title || '',
      date: item.date || '',
      content: item.content || '',
    })
  })

  app.get('/api/app/profile', requireAuth, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const userId = req.userId!
    const user = await prisma.appUser.findUnique({ where: { id: userId } })
    if (!user) return res.status(404).json({ error: '用户不存在' })

    const membership = await prisma.userMembership.findFirst({
      where: { userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      include: { plan: true }
    })
    const [orderCount, bookingCount, compareCount] = await Promise.all([
      prisma.appOrder.count({ where: { userId } }),
      prisma.serviceBooking.count({ where: { userId } }),
      prisma.compareTask.count({ where: { userId } })
    ])

    res.json({
      user: { id: user.id, phone: user.phone, name: user.name, organization: user.organization, role: user.role, avatarUrl: user.avatarUrl, createdAt: user.createdAt, enterpriseId: user.enterpriseId ?? null, enterpriseRole: user.enterpriseRole ?? null, passwordMustChange: user.passwordMustChange === true },
      membership: serializeMembership(membership),
      counters: {
        orders: orderCount,
        bookings: bookingCount,
        compareTasks: compareCount
      }
    })
  })

  // ── GET /api/app/compare/free-quota — Pro 会员年度免费比对额度查询
  // ── 队列状态（排队中的 PENDING 任务数）
  app.get('/api/app/compare/queue-status', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const pendingCount = await prisma.compareTask.count({ where: { status: 'PENDING' } })
    res.json({ pendingCount, estimateMinutes: pendingCount * 2 })
  })

  app.get('/api/app/compare/free-quota', requireAuth, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const userId = req.userId!

    // 查 pro / enterprise 会员（enterprise 等同 pro）
    const proMembership = await prisma.userMembership.findFirst({
      where: { userId, status: 'ACTIVE', planId: { in: ['pro', 'enterprise'] } }
    })
    if (proMembership) {
      return res.json({ tier: 'pro', used: 0, limit: -1, remaining: -1 }) // -1 = 不限次
    }

    // 查 personal 会员
    const personalMembership = await prisma.userMembership.findFirst({
      where: { userId, status: 'ACTIVE', planId: 'personal' }
    })
    if (!personalMembership) {
      return res.json({ tier: 'free', used: 0, limit: 0, remaining: 0 })
    }

    const used = await prisma.appOrder.count({
      where: {
        userId,
        productType: 'COMPARE_REPORT',
        channel: 'MEMBER_FREE',
        status: 'PAID',
        paidAt: { gte: personalMembership.createdAt }
      }
    })
    res.json({ tier: 'personal', used, limit: PERSONAL_ANNUAL_LIMIT, remaining: Math.max(0, PERSONAL_ANNUAL_LIMIT - used) })
  })

  // ── PATCH /api/app/profile — 修改用户名/单位
  app.patch('/api/app/profile', requireAuth, async (req: AuthRequest, res) => {
    const userId = req.userId!
    const { name, organization } = req.body
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: '用户名不能为空' })
    }
    const user = await prisma.appUser.update({
      where: { id: userId },
      data: { name: name.trim(), ...(organization !== undefined ? { organization: (organization || '').trim() } : {}) },
    })
    res.json({ id: user.id, name: user.name, organization: user.organization })
  })

  // ─── 管理后台：用户列表 ──────────────────────────────────────
  // ─── 内部可观测性：orderSweeper 运行 stats（admin only）───
  app.get('/api/internal/sweeper/stats', requireAdmin, (_req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    res.json(getSweeperStats())
  })

  app.get('/api/admin/users', requirePermission('admin.users.read'), async (req: AuthRequest, res) => {
    const page = parseInt(getSingleValue(req.query.page) || '1', 10) || 1
    const pageSize = Math.min(100, Math.max(1, parseInt(getSingleValue(req.query.pageSize) || '20', 10) || 20))
    const keyword = (getSingleValue(req.query.keyword) || '').trim()
    const where: any = { role: 'user' }
    if (keyword) {
      where.OR = [
        { phone:        { contains: keyword, mode: 'insensitive' } },
        { name:         { contains: keyword, mode: 'insensitive' } },
        { organization: { contains: keyword, mode: 'insensitive' } },
      ]
    }
    const [items, total] = await Promise.all([
      prisma.appUser.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, phone: true, email: true, name: true, organization: true, role: true, avatarUrl: true, isBlocked: true, createdAt: true,
          memberships: { where: { status: 'ACTIVE' }, orderBy: { createdAt: 'desc' }, take: 1, select: { planId: true, endAt: true } },
        },
      }),
      prisma.appUser.count({ where }),
    ])
    const result = items.map((u: any) => {
      const m = u.memberships?.[0]
      return { ...u, memberships: undefined, memberTier: m ? m.planId : 'free', memberExpire: m ? m.endAt : null }
    })
    res.json({ items: result, total, page, pageSize })
  })

  // ─── 管理后台：启用/禁用用户 ───────────────────────────────
  // 切换 isBlocked 布尔；admin role 用户禁止禁用（避免锁死管理员）
  app.patch('/api/admin/users/:id/toggle-blocked', requirePermission('admin.users.toggle'), async (req: AuthRequest, res) => {
    const userId = getRouteParam(req.params.id)
    const target = await prisma.appUser.findUnique({ where: { id: userId }, select: { id: true, role: true, isBlocked: true } })
    if (!target) return res.status(404).json({ error: '用户不存在' })
    if (target.role === 'admin') return res.status(400).json({ error: '不能禁用管理员账号' })
    const updated = await prisma.appUser.update({
      where: { id: userId },
      data: { isBlocked: !target.isBlocked },
      select: { id: true, isBlocked: true },
    })
    res.json(updated)
  })

  // ─── 管理后台：管理员列表 ──────────────────────────────────
  app.get('/api/admin/admins', requireAdmin, async (_req: AuthRequest, res) => {
    const items = await prisma.appUser.findMany({
      where: { role: 'admin' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, phone: true, email: true, name: true, createdAt: true },
    })
    res.json({ items })
  })

  // ─── 管理后台：新增管理员（从已有用户提升） ──────────────────
  app.post('/api/admin/admins', requireAdmin, async (req: AuthRequest, res) => {
    const { phone } = req.body
    if (!phone) return res.status(400).json({ error: '请输入手机号' })
    const user = await prisma.appUser.findUnique({ where: { phone } })
    if (!user) return res.status(404).json({ error: '该手机号未注册' })
    if (user.role === 'admin') return res.status(400).json({ error: '该用户已是管理员' })
    const updated = await prisma.appUser.update({
      where: { id: user.id },
      data: { role: 'admin' },
      select: { id: true, phone: true, name: true, role: true },
    })
    res.json(updated)
  })

  // ─── 管理后台：删除管理员（降级为普通用户） ──────────────────
  app.delete('/api/admin/admins/:id', requireAdmin, async (req: AuthRequest, res) => {
    const adminId = getRouteParam(req.params.id)
    if (req.userId === adminId) return res.status(400).json({ error: '不能移除自己的管理员权限' })
    const user = await prisma.appUser.findUnique({ where: { id: adminId } })
    if (!user || user.role !== 'admin') return res.status(404).json({ error: '管理员不存在' })
    await prisma.appUser.update({ where: { id: adminId }, data: { role: 'user' } })
    res.json({ success: true })
  })

  app.get('/api/app/membership/plans', async (req, res) => {
    const userId = getUserId(req)
    const [membership, dbPlans] = await Promise.all([
      prisma.userMembership.findFirst({
        where: { userId, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
        include: { plan: true }
      }),
      // 阶段 0：真读 DB（不再返回 appData.membershipPlans 硬编码）
      // 运营在 admin 后台改套餐价格 / features 后接口跟随变化，无需发版
      prisma.membershipPlan.findMany({ where: { status: 'ACTIVE' }, orderBy: { price: 'asc' } }),
    ])

    res.json({
      currentMembership: serializeMembership(membership),
      plans: dbPlans.map(buildPlanResponse)
    })
  })

  // ─── 阶段 0：聚合 pricing 接口 ───────────────────────────
  // 小程序专用：plans + compareUnlock + (未来扩展) 灰度价格
  // 与 /api/app/membership/plans 区别：本接口不带 currentMembership，public 缓存友好
  app.get('/api/app/pricing', async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60')
    try {
      const [dbPlans, cuRow] = await Promise.all([
        prisma.membershipPlan.findMany({ where: { status: 'ACTIVE' }, orderBy: { price: 'asc' } }),
        prisma.systemSetting.findUnique({ where: { key: 'compare_unlock_price' } }).catch(() => null),
      ])
      const plans = dbPlans.map(buildPlanResponse)
      // compareUnlock：从 SystemSetting 读，缺省 400（保留与 payment/index.js 兜底一致）
      const compareUnlock = cuRow?.value ? Number(cuRow.value) : 400
      res.json({ plans, compareUnlock: Number.isFinite(compareUnlock) ? compareUnlock : 400 })
    } catch (err: any) {
      console.error('[app/pricing]', err)
      res.status(500).json({ error: '价格加载失败' })
    }
  })

  // ─── 阶段 0：feature flags 接口 ───────────────────────────
  // 数据源：SystemSetting key=feature_flags（单条 JSON），admin 后台编辑
  // env 级开关（如 BXZ_COUPON_ENABLED）合并进来，env 优先级最高
  // 用户级灰度（白名单 / 比例）目前只解析 default 值，不做用户分桶；后续按需扩
  app.get('/api/app/feature-flags', async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300')
    try {
      const row = await prisma.systemSetting.findUnique({ where: { key: 'feature_flags' } }).catch(() => null)
      let flags: Record<string, any> = {}
      if (row?.value) {
        try { flags = JSON.parse(row.value) } catch { flags = {} }
      }
      // env 级 flag 合并（优先级最高，admin 改不了）
      flags.couponEnabled = couponsEnabled()
      res.json({ flags })
    } catch (err: any) {
      console.error('[feature-flags]', err)
      res.json({ flags: { couponEnabled: couponsEnabled() } })
    }
  })

  // ─── 阶段 0：核心聚合配置接口（小程序 onLaunch 拉一次）──
  // 聚合：copy（按页面分组）/ contact / share / flags / appMinVersion
  // 小程序端三层兜底：远端 → localStorage 缓存 → 编译期 mock fallback
  app.get('/api/app/config', async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300')
    try {
      const COPY_GROUPS = ['mp_copy_home', 'mp_copy_register', 'mp_copy_membership', 'mp_copy_compare', 'mp_copy_status']
      const OTHER_GROUPS = ['contact', 'share_text']
      const [copyRows, otherRows, flagsRow, minVersionRow, membershipBenefitsRow, memberFreeBenefitsRow, membershipInfoNoticeRow, compareMembershipNoticeRow, profileLoginHintRow, profileMembershipHintRow] = await Promise.all([
        (prisma as any).contentConfig.findMany({
          where: { group: { in: COPY_GROUPS }, enabled: true },
          orderBy: { sortOrder: 'asc' },
        }),
        (prisma as any).contentConfig.findMany({
          where: { group: { in: OTHER_GROUPS }, enabled: true },
          orderBy: { sortOrder: 'asc' },
        }),
        prisma.systemSetting.findUnique({ where: { key: 'feature_flags' } }).catch(() => null),
        prisma.systemSetting.findUnique({ where: { key: 'mp_min_version' } }).catch(() => null),
        getContentConfig('membership_benefits_matrix').catch(() => null),
        getContentConfig('mp_member_free_benefits').catch(() => null),
        getContentConfig('mp_membership_info_notice').catch(() => null),
        getContentConfig('mp_compare_membership_notice').catch(() => null),
        getContentConfig('mp_profile_login_hint').catch(() => null),
        getContentConfig('mp_profile_membership_hint').catch(() => null),
      ])

      // copy 按 page 分组：mp_copy_home → copy.home.<key> = content
      const copy: Record<string, Record<string, string>> = {}
      for (const r of copyRows) {
        const page = String(r.group).replace(/^mp_copy_/, '')
        if (!copy[page]) copy[page] = {}
        copy[page][r.key] = r.content || r.title || ''
      }

      const contact: Record<string, string> = {}
      const share: Record<string, string> = {}
      for (const r of otherRows) {
        const bucket = r.group === 'contact' ? contact : share
        bucket[r.key] = r.content || r.title || ''
      }

      let flags: Record<string, any> = {}
      if (flagsRow?.value) {
        try { flags = JSON.parse(flagsRow.value) } catch { flags = {} }
      }
      flags.couponEnabled = couponsEnabled()

      const appMinVersion = minVersionRow?.value || ''
      let membershipBenefitsMatrix: unknown
      if (membershipBenefitsRow?.enabled && membershipBenefitsRow.content) {
        try {
          membershipBenefitsMatrix = JSON.parse(membershipBenefitsRow.content)
        } catch (err) {
          console.error('[app/config][membership_benefits_matrix] parse failed', err)
        }
      }
      let memberFreeBenefits: unknown
      if (memberFreeBenefitsRow?.enabled && memberFreeBenefitsRow.content) {
        try {
          const parsed = JSON.parse(memberFreeBenefitsRow.content)
          if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
            memberFreeBenefits = parsed
          }
        } catch (err) {
          console.error('[app/config][mp_member_free_benefits] parse failed', err)
        }
      }
      let compareMembershipNotice: unknown
      if (compareMembershipNoticeRow?.enabled && compareMembershipNoticeRow.content) {
        try {
          const parsed = JSON.parse(compareMembershipNoticeRow.content)
          if (parsed && typeof parsed === 'object') compareMembershipNotice = parsed
        } catch (err) {
          console.error('[app/config][mp_compare_membership_notice] parse failed', err)
        }
      }

      const payload: Record<string, unknown> = {
        copy,
        contact,
        share,
        flags,
        appMinVersion,
        version: Date.now(),  // 简化版：客户端拿到后存本地，下次请求带回比对（etag 后续再加）
      }
      if (membershipBenefitsMatrix) payload.membershipBenefitsMatrix = membershipBenefitsMatrix
      if (memberFreeBenefits) payload.memberFreeBenefits = memberFreeBenefits
      if (membershipInfoNoticeRow?.enabled && membershipInfoNoticeRow.content) payload.membershipInfoNotice = membershipInfoNoticeRow.content
      if (compareMembershipNotice) payload.compareMembershipNotice = compareMembershipNotice
      if (profileLoginHintRow?.enabled && profileLoginHintRow.content) payload.profileLoginHint = profileLoginHintRow.content
      if (profileMembershipHintRow?.enabled && profileMembershipHintRow.content) payload.profileMembershipHint = profileMembershipHintRow.content
      res.json(payload)
    } catch (err: any) {
      console.error('[app/config]', err)
      res.status(500).json({ error: '配置加载失败' })
    }
  })

  app.get('/api/app/ics', (_req, res) => {
    res.json({ items: icsCatalog })
  })

  app.get('/api/app/standards', (req, res) => {
    const items = listStandards({
      library: typeof req.query.library === 'string' ? req.query.library : undefined,
      keyword: typeof req.query.keyword === 'string' ? req.query.keyword : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      ics: typeof req.query.ics === 'string' ? req.query.ics : undefined,
      society: typeof req.query.society === 'string' ? req.query.society : undefined
    })

    res.json({
      total: items.length,
      items
    })
  })

  app.get('/api/app/standards/:id', (req, res) => {
    const standard = getStandardById(getRouteParam(req.params.id))
    if (!standard) return res.status(404).json({ error: '标准不存在' })

    const related = standards
      .filter((item) => item.id !== standard.id && (item.library === standard.library || item.ics === standard.ics))
      .slice(0, 3)

    res.json({
      ...standard,
      related,
      actions: {
        canPreview: standard.fulltextAvailable || standard.accessType !== 'metadata',
        canDownload: standard.fulltextAvailable,
        canCompare: true
      }
    })
  })

  app.get('/api/app/standards/:id/preview', async (req, res) => {
    const standard = getStandardById(getRouteParam(req.params.id))
    if (!standard) return res.status(404).json({ error: '标准不存在' })

    const membership = await prisma.userMembership.findFirst({
      where: { userId: getUserId(req), status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      include: { plan: true }
    })

    const isMember = Boolean(membership)
    // 会员可看所有类型标准全文；非会员仅 fulltext 类型免费开放
    const previewUnlocked = isMember || standard.accessType === 'fulltext'

    res.json({
      standardId: standard.id,
      title: standard.title,
      accessType: standard.accessType,
      previewUnlocked,
      officialPreviewUrl: standard.officialPreviewUrl,
      chapters: standard.chapters.map((chapter, index) => ({
        ...chapter,
        locked: previewUnlocked ? false : chapter.locked ?? index > 0
      })),
      paywall: previewUnlocked
        ? null
        : {
            type: 'MEMBERSHIP',
            title: '开通会员查看详细信息',
            previewPrice: standard.previewPrice,
            downloadPrice: standard.downloadPrice
          }
    })
  })

  // ─── 退款常量 ──────────────────────────────────────────────
  const REFUND_RATE = 0.8          // 用户退款比例（退80%，扣20%手续费）
  const REFUND_WINDOW_DAYS = 7     // 退款窗口（支付后7天内可退）

  app.get('/api/app/orders', requireAuth, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const userId = getUserId(req)

    // 默认过滤掉 CANCELLED/FAILED（C 端用户不需要看历史失败/取消订单）
    // 仅 admin 显式传 ?includeAll=true 时返回全部状态
    // 非 admin 传 includeAll 一律忽略（不拒绝，保持幂等）
    const isAdmin = req.userRole === 'admin'
    const includeAll = isAdmin && req.query.includeAll === 'true'

    const orders = await prisma.appOrder.findMany({
      where: {
        userId,
        ...(includeAll ? {} : { status: { in: ['PENDING', 'PAYING', 'PENDING_VERIFY', 'PAID', 'REFUNDED'] } }),
      },
      orderBy: { createdAt: 'desc' }
    })

    res.json({
      items: orders.map((order) => {
        const refundDeadline = order.paidAt && order.status === 'PAID'
          ? new Date(new Date(order.paidAt).getTime() + REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
          : null
        return {
          ...order,
          payload: parseJson(order.payloadJson),
          refundDeadline,
          refundRate: REFUND_RATE,
        }
      })
    })
  })

  // 后端按 productType + planId/productRef 固定计算金额，不信任前端传入的 amount
  function resolveOrderAmount(productType: string, planId?: string, productRef?: string): number {
    if (productType === 'MEMBERSHIP') {
      const plan = membershipPlans.find((p) => p.id === planId)
      if (!plan) throw new Error(`无效的会员套餐: ${planId || '(空)'}`)
      if (plan.price <= 0) throw new Error(`该套餐不支持线上购买`)
      return plan.price * 100  // 元 → 分
    }
    if (productType === 'COMPARE_REPORT' || productType === 'COMPARE_EXPORT') {
      return 0  // 比对报告不再按份付费，走会员权益
    }
    if (productType === 'STANDARD_PREVIEW' || productType === 'STANDARD_DOWNLOAD') {
      const std = getStandardById(productRef || '')
      if (!std) throw new Error(`标准不存在: ${productRef}`)
      const price = productType === 'STANDARD_PREVIEW'
        ? ((std as any).previewPrice || 0)
        : ((std as any).downloadPrice || 0)
      if (price <= 0) throw new Error(`该标准无对应售价`)
      return price * 100
    }
    // EXPERT_VOTE 不走通用 /api/app/orders 创建路径
    //   专家评审订单由 POST /api/app/expert-votes/:no/submit 直接事务建单（金额从 ExpertVoteRequest 快照取），
    //   避免与 MEMBERSHIP/STANDARD/COMPARE 的优惠券/幂等逻辑耦合。
    //   本函数显式抛错兜底（防御 productType 误传）。
    throw new Error(`不支持的商品类型: ${productType}`)
  }

  const createOrderSchema = z.object({
    productType: z.enum(['MEMBERSHIP', 'STANDARD_PREVIEW', 'STANDARD_DOWNLOAD', 'COMPARE_REPORT', 'COMPARE_EXPORT']),
    productRef: z.string().optional(),
    planId: z.string().optional(),
    title: z.string().min(1),
    amount: z.number().int().min(0).optional(),  // 前端可传用于展示，后端忽略
    channel: z.enum(['WECHAT', 'ALIPAY']).optional(),
    payload: z.any().optional(),
    userCouponId: z.string().optional(),  // 阶段三：可选优惠券（feature flag 控制）
  })

  app.post('/api/app/orders', requireAuth, async (req: AuthRequest, res) => {
    const parsed = createOrderSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: '参数错误' })

    const { productType, planId, productRef, title, channel, payload, userCouponId } = parsed.data
    const userId = getUserId(req)

    // 参数合法性校验
    if (productType === 'MEMBERSHIP' && !planId) {
      return res.status(400).json({ error: '会员订单必须指定 planId' })
    }
    if (['COMPARE_REPORT', 'COMPARE_EXPORT', 'STANDARD_PREVIEW', 'STANDARD_DOWNLOAD'].includes(productType) && !productRef) {
      return res.status(400).json({ error: `${productType} 订单必须指定 productRef` })
    }

    // MEMBERSHIP 订单：拦截重复购买/降级（兜底，前端会员卡片会先做一道）
    // personal → pro 升级走 flow=upgrade，前端构造 amount 是差价，
    // 但 productType=MEMBERSHIP/planId=pro 仍会进这里 — 通过 targetRank > currentRank 放行
    if (productType === 'MEMBERSHIP' && planId) {
      const activeMembership = await prisma.userMembership.findFirst({
        where: { userId, status: 'ACTIVE' },
      })
      if (activeMembership) {
        const tierRank: Record<string, number> = { personal: 1, pro: 2, enterprise: 3 }
        const currentRank = tierRank[activeMembership.planId] || 0
        const targetRank = tierRank[planId] || 0
        if (targetRank <= currentRank) {
          return res.status(400).json({ error: '您已是相应或更高等级会员，无需重复购买' })
        }
      }
    }

    // COMPARE_REPORT/EXPORT：验证 taskNo 存在且属于当前用户
    if ((productType === 'COMPARE_REPORT' || productType === 'COMPARE_EXPORT') && productRef) {
      const task = await prisma.compareTask.findUnique({ where: { taskNo: productRef } })
      if (!task) return res.status(404).json({ error: '比对任务不存在' })
      if (task.userId && task.userId !== userId) {
        return res.status(403).json({ error: '无权为此比对任务创建订单' })
      }
    }

    // 后端计算金额，不信任前端
    let originalAmount: number
    try {
      originalAmount = resolveOrderAmount(productType, planId, productRef)
    } catch (err: any) {
      console.error('[order] 金额计算异常:', err.message)
      return res.status(400).json({ error: '订单参数错误，请重试' })
    }

    // 幂等：同一用户 + 同一商品 + 未支付状态 → 直接返回已有订单，不重复创建
    // 含券订单进这里时，券已 LOCKED 在那张订单上，不需要重新锁
    const existingOrder = await prisma.appOrder.findFirst({
      where: {
        userId,
        productType,
        planId: planId ?? null,
        productRef: productRef ?? null,
        status: { in: ['PENDING', 'PAYING', 'PENDING_VERIFY'] }
      }
    })
    if (existingOrder) {
      return res.json(existingOrder)
    }

    // 销售归因快照：读 user.salesCode 写入订单，后续用户 salesCode 变化不影响历史订单
    const userSnapshot = await prisma.appUser.findUnique({
      where: { id: userId },
      select: { salesCode: true },
    })

    const orderNo = makeBusinessNo('ORD')

    // 阶段三：含券订单走事务（锁券 + 建单 + 写快照原子化）
    const useCoupon = couponsEnabled() && !!userCouponId
    let order: any
    try {
      order = await prisma.$transaction(async (tx) => {
        let finalAmount = originalAmount
        let discountAmount = 0
        let lockedUserCouponId: string | null = null

        if (useCoupon) {
          const lockResult = await validateAndLockCoupon(tx, {
            userId: userId!,
            userCouponId: userCouponId!,
            orderNo,
            productType,
            planId,
            originalAmount,
          })
          finalAmount = lockResult.finalAmount
          discountAmount = lockResult.discountAmount
          lockedUserCouponId = lockResult.userCoupon.id

          // OrderDiscount 快照（审计专用，模板后续修改不影响）
          await tx.orderDiscount.create({
            data: {
              orderNo,
              userCouponId: lockResult.userCoupon.id,
              couponSnapshot: snapshotCoupon(lockResult.coupon),
              originalAmount,
              discountAmount,
              finalAmount,
            },
          })
        }

        return tx.appOrder.create({
          data: {
            orderNo,
            userId,
            planId,
            productType,
            productRef,
            title,
            amount: finalAmount,            // 应付金额 = 微信下单金额（核心不变性）
            originalAmount,                  // 审计字段
            discountAmount,                  // 审计字段（无券=0）
            userCouponId: lockedUserCouponId,
            channel,
            payloadJson: payload ? JSON.stringify(payload) : undefined,
            salesCode: userSnapshot?.salesCode ?? null,
          }
        })
      })
    } catch (err: any) {
      console.error('[order] 创建订单失败:', err.message)
      return res.status(400).json({ error: err.message || '订单创建失败' })
    }

    // 埋点：订单创建（幂等返回已有订单的分支不触发，避免重复计数）
    trackServerEvent('order_created', {
      orderNo: order.orderNo,
      productType: order.productType,
      planId: order.planId,
      amount: order.amount,
      originalAmount: order.originalAmount,
      discountAmount: order.discountAmount,
      hasCoupon: !!order.userCouponId,
      channel: order.channel,
    }, order.userId)

    res.json(order)
  })

  /**
   * 发起支付
   *
   * 微信支付已配置 → 调用真实 JSAPI 下单，返回小程序 wx.requestPayment 参数
   * 微信支付未配置 → mock 模式，直接标记为 PAID
   */
  app.post('/api/app/orders/:orderNo/pay', requireAuth, async (req: AuthRequest, res) => {
    const schema = z.object({
      channel: z.enum(['WECHAT', 'ALIPAY']),
      openId: z.string().optional(),     // 微信支付需要用户 openid
      wxLoginCode: z.string().optional() // 小程序传 wx.login() 拿到的 code，后端内部换 openid
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: '参数错误' })

    const orderNo = getRouteParam(req.params.orderNo)
    const order = await prisma.appOrder.findUnique({ where: { orderNo } })
    if (!order) return res.status(404).json({ error: '订单不存在' })

    // 归属校验：只允许订单本人操作支付
    if (order.userId && order.userId !== getUserId(req)) {
      return res.status(403).json({ error: '无权操作此订单' })
    }

    if (order.status === 'PAID') {
      return res.json({ ...order, message: '订单已支付' })
    }
    if (order.status === 'FAILED') {
      return res.status(409).json({ error: '订单已失败，请重新创建订单' })
    }

    // 原子乐观锁 — PENDING/PAYING 都可以发起支付（PAYING 允许重新获取二维码）
    const lockResult = await prisma.appOrder.updateMany({
      where: { orderNo, status: { in: ['PENDING', 'PAYING'] } },
      data: { status: 'PAYING' }
    })
    if (lockResult.count === 0) {
      return res.status(409).json({ error: '当前订单状态不可支付' })
    }

    // ── 微信支付通道 ──
    if (parsed.data.channel === 'WECHAT') {
      let openId = parsed.data.openId

      // 小程序流程：传 wxLoginCode 让后端 fresh 换 openid（避免前端持久化 openid）
      if (!openId && parsed.data.wxLoginCode) {
        try {
          const wxRes = await wxCode2Session(parsed.data.wxLoginCode)
          if (wxRes.errcode || !wxRes.openid) {
            console.error('[pay] wxCode2Session 失败:', wxRes.errcode, wxRes.errmsg)
            return res.status(400).json({ error: '微信登录态校验失败，请重试' })
          }
          openId = wxRes.openid
        } catch (e: any) {
          console.error('[pay] wxCode2Session 异常:', e.message)
          return res.status(502).json({ error: '微信服务调用失败，请稍后重试' })
        }
      }

      // 有 openId → JSAPI（小程序）；无 openId → Native（PC Web 扫码）
      if (openId) {
        // ── JSAPI 小程序支付 ──
        const payResult = await createPayment({
          orderNo: order.orderNo,
          description: order.title,
          amountCents: order.amount,
          openId,
        })

        if (!payResult.success) {
          await prisma.appOrder.update({
            where: { orderNo: order.orderNo },
            data: {
              status: 'FAILED',
              failedAt: new Date(),
              failReason: 'JSAPI 下单失败: ' + (payResult.error || '未知错误'),
            }
          })
          return res.status(500).json({ error: payResult.error || '支付下单失败，请稍后重试' })
        }

        if (payResult.mock) {
          // dev-only：BXZ_PAY_AUTO_SUCCESS=true 时 mock 直接标 PAID，跳过凭证上传
          // 仅本地测试用，生产环境不要开（生产 loadConfig() 非 null，根本进不到 mock 分支）
          if (process.env.BXZ_PAY_AUTO_SUCCESS === 'true') {
            await prisma.appOrder.updateMany({
              where: { orderNo: order.orderNo, status: { in: ['PENDING', 'PAYING'] } },
              data: { status: 'PAYING', channel: 'WECHAT' },
            })
            const result = await prisma.$transaction(async (tx) => {
              return finalizeSuccessfulPaymentInTx(tx, {
                orderNo: order.orderNo,
                paidAt: new Date(),
                channel: 'WECHAT',
              })
            })
            if (result.transitioned) flushPostPaymentEffects(result.effects)
            return res.json({
              orderNo: order.orderNo,
              payMode: 'mock-paid',
              amount: order.amount,
              amountYuan: `¥${(order.amount / 100).toFixed(2)}`,
              title: order.title,
              status: 'PAID',
              message: '本地 mock 支付已自动成功（BXZ_PAY_AUTO_SUCCESS=true）',
            })
          }
          await prisma.appOrder.update({
            where: { orderNo: order.orderNo },
            data: { status: 'PAYING', channel: 'WECHAT' }
          })
          return res.json({
            orderNo: order.orderNo,
            payMode: 'qrcode',
            amount: order.amount,
            amountYuan: `¥${(order.amount / 100).toFixed(2)}`,
            title: order.title,
            message: '请使用微信扫描收款码完成支付，支付后上传截图凭证。'
          })
        }

        await prisma.appOrder.update({
          where: { orderNo: order.orderNo },
          data: { channel: 'WECHAT' }
        })
        return res.json({
          orderNo: order.orderNo,
          payMode: 'jsapi',
          payParams: payResult.payParams,
        })
      }

      // ── Native PC Web 扫码支付 ──
      const nativeResult = await createNativePayment({
        orderNo: order.orderNo,
        description: order.title,
        amountCents: order.amount,
      })

      if (!nativeResult.success) {
        await prisma.appOrder.update({
          where: { orderNo: order.orderNo },
          data: {
            status: 'FAILED',
            failedAt: new Date(),
            failReason: 'Native 下单失败: ' + (nativeResult.error || '未知错误'),
          }
        })
        return res.status(500).json({ error: nativeResult.error || '支付下单失败，请稍后重试' })
      }

      if (nativeResult.mock) {
        // dev-only：BXZ_PAY_AUTO_SUCCESS=true 时 mock 直接标 PAID
        if (process.env.BXZ_PAY_AUTO_SUCCESS === 'true') {
          await prisma.appOrder.updateMany({
            where: { orderNo: order.orderNo, status: { in: ['PENDING', 'PAYING'] } },
            data: { status: 'PAYING', channel: 'WECHAT' },
          })
          const result = await prisma.$transaction(async (tx) => {
            return finalizeSuccessfulPaymentInTx(tx, {
              orderNo: order.orderNo,
              paidAt: new Date(),
              channel: 'WECHAT',
            })
          })
          if (result.transitioned) flushPostPaymentEffects(result.effects)
          return res.json({
            orderNo: order.orderNo,
            payMode: 'mock-paid',
            amount: order.amount,
            amountYuan: `¥${(order.amount / 100).toFixed(2)}`,
            title: order.title,
            status: 'PAID',
            message: '本地 mock 支付已自动成功（BXZ_PAY_AUTO_SUCCESS=true）',
          })
        }
        // mock 模式：沿用静态收款码 + 凭证上传流程
        await prisma.appOrder.update({
          where: { orderNo: order.orderNo },
          data: { status: 'PAYING', channel: 'WECHAT' }
        })
        return res.json({
          orderNo: order.orderNo,
          payMode: 'qrcode',
          amount: order.amount,
          amountYuan: `¥${(order.amount / 100).toFixed(2)}`,
          title: order.title,
          message: '请使用微信扫描收款码完成支付，支付后上传截图凭证。'
        })
      }

      // 真实 Native：返回 code_url，前端渲染二维码
      await prisma.appOrder.update({
        where: { orderNo: order.orderNo },
        data: { channel: 'WECHAT' }
      })
      return res.json({
        orderNo: order.orderNo,
        payMode: 'native',
        codeUrl: nativeResult.codeUrl,
        amount: order.amount,
        amountYuan: `¥${(order.amount / 100).toFixed(2)}`,
        title: order.title,
      })
    }

    // ── 支付宝（暂走 mock）──
    const payment = await runPaymentTx(
      (tx) => finalizeSuccessfulPaymentInTx(tx, {
        orderNo: order.orderNo,
        paidAt: new Date(),
        channel: parsed.data.channel,
      }),
    )
    if (!payment.order) {
      return res.status(404).json({ error: '订单不存在' })
    }
    flushPostPaymentEffects(payment.effects)

    res.json({ ...payment.order, payMode: 'mock' })
  })

  /**
   * 微信支付回调通知
   * 微信服务器 POST /api/pay/notify
   *
   * P0-1: 用 updateMany + status:not:PAID 做原子幂等锁，防重复回调
   * P0-2: 订单状态更新与业务处理在同一事务中
   * P1: 解密失败返回 HTTP 200 + FAIL，让微信重试；不泄露内部错误
   */
  app.post('/api/pay/notify', async (req, res) => {
    try {
      // ── 回调验签（防伪造通知） ──
      const sigValid = verifyCallbackSignature(req)
      if (!sigValid) {
        console.warn('[pay-notify] 回调验签失败，拒绝处理')
        return res.json({ code: 'FAIL', message: 'Signature verification failed' })
      }

      const { resource } = req.body || {}
      if (!resource) {
        return res.status(400).json({ code: 'FAIL', message: 'Missing resource' })
      }

      const notification = decryptNotification(
        resource.ciphertext,
        resource.nonce,
        resource.associated_data
      )

      if (!notification) {
        return res.json({ code: 'FAIL', message: 'Decrypt failed' })
      }

      if (notification.tradeState === 'SUCCESS') {
        // P0-1 + P0-2: 原子更新 + 事务包装
        // 埋点副作用收集到事务外发送，避免与当前事务写锁自竞争（见 PostPaymentEffects 注释）
        // retry-safe：副作用通过 return 收集，避免 PG Serializable retry 时累积。
        const effects = await runPaymentTx(async (tx): Promise<PostPaymentEffects> => {
          const localEffects: PostPaymentEffects = { events: [], markActiveUserIds: [] }
          // P0-3: 金额校验 — 回调金额必须与订单金额一致（defense-in-depth，签名验证之外的第二道防线）
          const orderForAmountCheck = await tx.appOrder.findUnique({ where: { orderNo: notification.orderNo } })
          if (!orderForAmountCheck) return localEffects
          if (notification.amountCents !== orderForAmountCheck.amount) {
            console.error(`[pay-notify] 金额不一致！orderNo=${notification.orderNo} 订单=${orderForAmountCheck.amount} 回调=${notification.amountCents}`)
            await tx.appOrder.updateMany({
              where: { orderNo: notification.orderNo, status: { notIn: ['PAID', 'FAILED'] } },
              data: { status: 'FAILED', failedAt: new Date(), failReason: `金额不一致: 订单${orderForAmountCheck.amount} vs 回调${notification.amountCents}` }
            })
            return localEffects
          }

          const payment = await finalizeSuccessfulPaymentInTx(tx, {
            orderNo: notification.orderNo,
            paidAt: new Date(notification.paidAt),
          })
          localEffects.events.push(...payment.effects.events)
          localEffects.markActiveUserIds.push(...payment.effects.markActiveUserIds)
          return localEffects
        })
        flushPostPaymentEffects(effects)
      } else {
        // P1-1: 非 SUCCESS 状态 → 标记订单 FAILED，用户可明确看到失败
        await prisma.appOrder.updateMany({
          where: { orderNo: notification.orderNo, status: { notIn: ['PAID', 'FAILED'] } },
          data: {
            status: 'FAILED',
            failedAt: new Date(),
            failReason: '微信回调返回非成功状态: ' + notification.tradeState,
          }
        })
      }

      // 返回成功应答（微信要求）
      res.json({ code: 'SUCCESS', message: 'OK' })
    } catch (err: any) {
      console.error('[pay-notify] 处理回调失败:', err)
      alertCritical('pay-notify', '支付回调处理失败', { error: err?.message, body: req.body?.resource?.ciphertext?.slice(0, 20) })
      res.json({ code: 'FAIL', message: 'SERVICE_ERROR' })
    }
  })

  /**
   * 查询支付配置状态（供前端判断是否显示真实/mock 支付）
   */
  app.get('/api/app/pay/config', async (_req, res) => {
    // 阶段 0：扩 paymentEntryEnabled / receiptFallbackEnabled，运营可在 SystemSetting 调
    //   paymentEntryEnabled    SystemSetting key=payment_entry_enabled  (默认 true)
    //   receiptFallbackEnabled SystemSetting key=receipt_fallback_enabled (默认 true)
    const [entryRow, receiptRow] = await Promise.all([
      prisma.systemSetting.findUnique({ where: { key: 'payment_entry_enabled' } }).catch(() => null),
      prisma.systemSetting.findUnique({ where: { key: 'receipt_fallback_enabled' } }).catch(() => null),
    ])
    res.json({
      wechatPay: isRealPayConfigured(),
      alipay: false,  // 暂未接入
      paymentEntryEnabled: entryRow ? entryRow.value !== 'false' : true,
      receiptFallbackEnabled: receiptRow ? receiptRow.value !== 'false' : true,
    })
  })

  /**
   * 轮询订单支付状态（前端 Native 支付后每 3s 轮询）
   */
  app.get('/api/app/orders/:orderNo/status', requireAuth, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const orderNo = getRouteParam(req.params.orderNo)
    const order = await prisma.appOrder.findUnique({
      where: { orderNo },
      select: { orderNo: true, status: true, userId: true, paidAt: true },
    })
    if (!order) return res.status(404).json({ error: '订单不存在' })
    if (order.userId && order.userId !== getUserId(req)) {
      return res.status(403).json({ error: '无权查看此订单' })
    }
    res.json({ orderNo: order.orderNo, status: order.status, paidAt: order.paidAt })
  })

  // ─── 阶段三：优惠券接口 ───────────────────────────────────

  /**
   * 选券查询：返回当前用户可用、且适用于指定商品的券，含预计算抵扣
   * GET /api/app/coupons/applicable?productType=...&planId=...&productRef=...
   * Feature flag 关闭时返回空数组
   */
  app.get('/api/app/coupons/applicable', requireAuth, async (req: AuthRequest, res) => {
    if (!couponsEnabled()) return res.json({ items: [] })
    const productType = String(req.query.productType || '')
    const planId = req.query.planId ? String(req.query.planId) : null
    const productRef = req.query.productRef ? String(req.query.productRef) : undefined
    if (!['MEMBERSHIP', 'STANDARD_PREVIEW', 'STANDARD_DOWNLOAD', 'COMPARE_REPORT', 'COMPARE_EXPORT'].includes(productType)) {
      return res.status(400).json({ error: '不支持的 productType' })
    }
    let originalAmount: number
    try {
      originalAmount = resolveOrderAmount(productType, planId || undefined, productRef)
    } catch {
      return res.json({ items: [], originalAmount: 0 })
    }
    const items = await listApplicableCoupons(prisma, {
      userId: getUserId(req)!,
      productType,
      planId,
      originalAmount,
    })
    res.json({ items, originalAmount })
  })

  /**
   * 我的优惠券列表（4 tab：可用 / 已使用 / 已过期 / 已失效）
   * GET /api/app/coupons/my?status=AVAILABLE|USED|EXPIRED|REVOKED
   */
  app.get('/api/app/coupons/my', requireAuth, async (req: AuthRequest, res) => {
    if (!couponsEnabled()) return res.json({ items: [] })
    const status = String(req.query.status || 'AVAILABLE')
    if (!['AVAILABLE', 'LOCKED', 'USED', 'EXPIRED', 'REVOKED'].includes(status)) {
      return res.status(400).json({ error: '非法 status' })
    }
    const list = await prisma.userCoupon.findMany({
      where: { userId: getUserId(req)!, status },
      include: { coupon: true },
      orderBy: { expiresAt: 'asc' },
    })
    res.json({
      items: list.map(uc => ({
        id: uc.id,
        couponId: uc.couponId,
        name: uc.coupon.name,
        code: uc.coupon.code,
        description: uc.coupon.description,
        discountType: uc.coupon.discountType,
        discountValue: uc.coupon.discountValue,
        minAmount: uc.coupon.minAmount,
        maxDiscount: uc.coupon.maxDiscount,
        applicableScope: uc.coupon.applicableScope,
        status: uc.status,
        source: uc.source,
        issuedAt: uc.issuedAt,
        expiresAt: uc.expiresAt,
        usedAt: uc.usedAt,
        usedOrderNo: uc.usedOrderNo,
      })),
    })
  })

  /**
   * 取消订单 — PENDING / PAYING 状态可取消
   * 已支付(PAID)、已取消(CANCELLED) 不可重复操作
   */
  app.post('/api/app/orders/:orderNo/cancel', requireAuth, async (req: AuthRequest, res) => {
    const orderNo = getRouteParam(req.params.orderNo)
    const order = await prisma.appOrder.findUnique({ where: { orderNo } })
    if (!order) return res.status(404).json({ error: '订单不存在' })
    if (order.userId && order.userId !== getUserId(req)) {
      return res.status(403).json({ error: '无权操作此订单' })
    }
    if (order.status === 'PAID') {
      return res.status(409).json({ error: '订单已支付，无法取消' })
    }
    if (order.status === 'CANCELLED') {
      return res.json({ orderNo: order.orderNo, status: 'CANCELLED', message: '订单已取消' })
    }
    if (!['PENDING', 'PAYING'].includes(order.status)) {
      return res.status(409).json({ error: `当前状态(${order.status})不可取消` })
    }

    // 取消订单 + 解锁优惠券 + 联动关联业务单（事务原子）
    await prisma.$transaction(async (tx) => {
      await tx.appOrder.update({
        where: { orderNo: order.orderNo },
        data: { status: 'CANCELLED', failReason: '用户主动取消' },
      })
      await unlockCouponByOrder(tx, order.orderNo)
      // 联动取消关联的专家评审申请（若有）
      if (order.productType === 'EXPERT_VOTE') {
        await (tx as any).expertVoteRequest.updateMany({
          where: { orderNo: order.orderNo, status: 'PAYING' },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: '用户取消订单' },
        })
      }
    })
    res.json({ orderNo: order.orderNo, status: 'CANCELLED', message: '订单已取消' })
  })

  // ─── 上传支付凭证 ─────────────────────────────────────────
  // 用户扫码支付后，上传截图凭证 → 订单进入 PENDING_VERIFY 状态
  const uploadReceipt = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
      filename: (_req, file, cb) => {
        const hash = crypto.randomBytes(8).toString('hex')
        const ext = (file.originalname.match(/\.[^.]+$/) || [''])[0]
        cb(null, `receipt-${Date.now()}-${hash}${ext}`)
      }
    }),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    defParamCharset: 'utf8',
    fileFilter: (_req, file, cb) => {
      const allowed = ['.jpg', '.jpeg', '.png', '.pdf']
      const ext = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0]
      if (ext && allowed.includes(ext)) {
        cb(null, true)
      } else {
        cb(new Error(`不支持的凭证文件类型: ${ext}`))
      }
    }
  })

  app.post('/api/app/orders/:orderNo/receipt', requireAuth, uploadReceipt.single('file'), async (req: AuthRequest, res) => {
    try {
      const orderNo = getRouteParam(req.params.orderNo)
      const order = await prisma.appOrder.findUnique({ where: { orderNo } })
      if (!order) return res.status(404).json({ error: '订单不存在' })

      // 归属校验：只允许订单本人上传凭证
      if (order.userId && order.userId !== getUserId(req)) {
        return res.status(403).json({ error: '无权操作此订单' })
      }

      // 只有 PAYING 或 PENDING 状态的订单可以上传凭证
      if (!['PAYING', 'PENDING'].includes(order.status)) {
        return res.status(400).json({ error: `当前订单状态(${order.status})不允许上传凭证` })
      }

      const receiptPath = req.file?.filename || ''
      if (!receiptPath) {
        return res.status(400).json({ error: '请上传支付凭证截图' })
      }

      await prisma.appOrder.update({
        where: { orderNo },
        data: {
          status: 'PENDING_VERIFY',
          receiptImage: receiptPath,
          channel: 'WECHAT',
        }
      })

      res.json({
        orderNo: order.orderNo,
        status: 'PENDING_VERIFY',
        message: '凭证已上传，我们将在 24 小时内完成核实确认。'
      })
    } catch (err: any) {
      console.error('[receipt] 上传凭证失败:', err)
      res.status(500).json({ error: '上传失败，请稍后重试' })
    }
  })

  // 静态文件：收款码图片（仅登录用户可访问，防止未授权访问平台收款码）
  app.get('/api/app/pay/qrcode', requireAuth, (_req, res) => {
    const qrPath = join(process.cwd(), 'public/pay-qrcode.jpg')
    res.sendFile(qrPath, { root: '/' })
  })

  app.get('/api/app/bookings', requireAuth, async (req: AuthRequest, res) => {
    const items = await prisma.serviceBooking.findMany({
      where: { userId: getUserId(req) },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ items })
  })

  app.post('/api/app/bookings', requireAuth, async (req: AuthRequest, res) => {
    const schema = z.object({
      name: z.string().min(1),
      phone: z.string().min(11).max(11),
      organization: z.string().min(1),
      demandType: z.enum(['团体标准', '企业标准', '不确定']).optional(),
      demandDesc: z.string().max(200).optional(),
      source: z.string().optional()
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: '参数错误' })

    const booking = await prisma.serviceBooking.create({
      data: {
        bookingNo: makeBusinessNo('BOOK'),
        userId: getUserId(req),
        name: parsed.data.name,
        phone: parsed.data.phone,
        organization: parsed.data.organization,
        demandType: parsed.data.demandType,
        demandDesc: parsed.data.demandDesc,
        source: parsed.data.source ?? 'miniapp'
      }
    })

    res.json({
      ...booking,
      confirmation: '已收到，1 个工作日内联系您'
    })
  })

  app.get('/api/app/compare/tasks', requireAuth, async (req: AuthRequest, res) => {
    const items = await prisma.compareTask.findMany({
      where: { userId: getUserId(req) },
      orderBy: { createdAt: 'desc' }
    })
    res.json({
      items: items.map((item) => ({
        taskNo: item.taskNo,
        documentName: item.documentName,
        compareMode: item.compareMode,
        status: item.status,
        errorMessage: item.errorMessage || undefined,
        createdAt: item.createdAt,
        finishedAt: item.finishedAt || undefined,
        fullReportUnlocked: Boolean(item.fullReportUnlockedAt)
      }))
    })
  })

  // ─── 删除比对任务（仅允许删除自己的任务）─────────────────────
  app.delete('/api/app/compare/tasks/:taskNo', requireAuth, async (req: AuthRequest, res) => {
    const taskNo = getRouteParam(req.params.taskNo)
    const task = await prisma.compareTask.findUnique({ where: { taskNo } })
    if (!task) return res.status(404).json({ error: '任务不存在' })
    if (task.userId && task.userId !== getUserId(req)) {
      return res.status(403).json({ error: '无权删除此任务' })
    }
    // 同时删除关联的未支付订单
    await prisma.appOrder.deleteMany({
      where: { productRef: task.taskNo, productType: 'COMPARE_REPORT', status: { not: 'PAID' } }
    })
    await prisma.compareTask.delete({ where: { taskNo } })
    res.json({ ok: true })
  })

  // ─── 重试失败任务 ─────────────────────────────────────────────
  app.post('/api/app/compare/tasks/:taskNo/retry', requireAuth, async (req: AuthRequest, res) => {
    const taskNo = getRouteParam(req.params.taskNo)
    const task = await prisma.compareTask.findUnique({ where: { taskNo } })
    if (!task) return res.status(404).json({ error: '任务不存在' })
    if (task.userId && task.userId !== getUserId(req)) {
      return res.status(403).json({ error: '无权操作此任务' })
    }
    if (task.status !== 'FAILED') {
      return res.status(400).json({ error: '仅失败任务可重试' })
    }
    await prisma.compareTask.update({
      where: { taskNo },
      data: { status: 'PENDING', errorMessage: null, summaryJson: null, reportJson: null, finishedAt: null }
    })
    res.json({ ok: true, status: 'PENDING' })
  })

  // ─── 单任务状态轮询（轻量级，仅返回状态）─────────────────────
  app.get('/api/app/compare/tasks/:taskNo/status', requireAuth, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const taskNo = getRouteParam(req.params.taskNo)
    const task = await prisma.compareTask.findUnique({
      where: { taskNo },
      select: { taskNo: true, status: true, errorMessage: true, finishedAt: true }
    })
    if (!task) return res.status(404).json({ error: '任务不存在' })
    res.json(task)
  })

  /**
   * 创建比对任务
   * 支持两种方式：
   *   1. multipart/form-data — 上传文件 + 表单字段
   *   2. application/json — 传入 sourceText（前端已提取文本）
   */
  // ─── 分片上传：单文件 → 返回 partToken ───
  // 小程序 wx.uploadFile 一次只能传一个文件,1对1 比对需要 A、B 串行两次上传
  // 拿 token,最后调 /api/app/compare/tasks 时用 fileAToken + fileBToken 合并任务
  app.post('/api/app/compare/upload-part', requireAuth, upload.single('file'), async (req: AuthRequest, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: '未收到文件' })
      }
      const partToken = 'upld_' + crypto.randomBytes(12).toString('hex')
      uploadPartStore.set(partToken, {
        userId: getUserId(req),
        filePath: req.file.path,
        originalName: req.file.originalname,
        createdAt: Date.now(),
      })
      res.json({
        partToken,
        fileName: req.file.originalname,
        ttlSeconds: Math.floor(UPLOAD_PART_TTL_MS / 1000),
      })
    } catch (err: any) {
      console.error('[compare/upload-part]', err)
      res.status(500).json({ error: '文件上传失败，请重试' })
    }
  })

  app.post('/api/app/compare/tasks', ipRateLimit(5, 60_000), requireAuth, upload.fields([{ name: 'file', maxCount: 1 }, { name: 'fileB', maxCount: 1 }]), async (req: AuthRequest, res) => {
    try {
      const userId = getUserId(req)
      const userRole = req.userRole

      // 队列两层保护（详见 FREE_QUEUE_LIMIT 注释）
      // 拒绝时清理 multer 已落盘的孤儿文件；fileToken 不动，10 分钟 TTL 内可重试
      const queueGate = await checkCompareQueue(userId, userRole)
      if (queueGate) {
        const f = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined
        for (const p of [f?.file?.[0]?.path, f?.fileB?.[0]?.path]) {
          if (p) { try { await (await import('fs/promises')).unlink(p) } catch {} }
        }
        return res.status(queueGate.http).json(queueGate.body)
      }

      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined
      const fileA = files?.file?.[0]
      const fileB = files?.fileB?.[0]

      // 路径 1: PC Web - multipart 一次性同时上传 fileA + fileB
      let fileAPath = fileA?.path || ''
      let fileBPath = fileB?.path || ''
      let fileAName = fileA?.originalname || ''
      let fileBName = fileB?.originalname || ''

      // 路径 2: 小程序 - 通过 fileAToken / fileBToken 合并先前 upload-part 上传的分片
      const fileAToken: string = req.body.fileAToken || ''
      const fileBToken: string = req.body.fileBToken || ''
      if (fileAToken) {
        const entry = uploadPartStore.get(fileAToken)
        if (!entry || entry.userId !== userId) {
          return res.status(400).json({ error: '文件 A token 无效或已过期，请重新上传' })
        }
        fileAPath = entry.filePath
        fileAName = entry.originalName
        uploadPartStore.delete(fileAToken)
      }
      if (fileBToken) {
        const entry = uploadPartStore.get(fileBToken)
        if (!entry || entry.userId !== userId) {
          return res.status(400).json({ error: '文件 B token 无效或已过期，请重新上传' })
        }
        fileBPath = entry.filePath
        fileBName = entry.originalName
        uploadPartStore.delete(fileBToken)
      }

      const compareMode = req.body.compareMode || 'all'
      const isOneToOne = compareMode === 'ONE_TO_ONE' || compareMode === 'pair'

      // 1对1 比对需要会员权益（personal / pro / enterprise）
      if (isOneToOne && !(await isPaidCompareUser(userId))) {
        // 清理已上传的孤儿文件
        for (const p of [fileAPath, fileBPath]) {
          if (p) { try { await (await import('fs/promises')).unlink(p) } catch {} }
        }
        return res.status(403).json({
          error: '一对一比对为会员专属功能，请升级会员后使用',
          upgradeUrl: '/membership',
        })
      }

      // 1对1 任务必须有 fileB,否则直接 400 拒绝建任务,
      // 不允许 worker 静默回退到「前 5 条全库切片」假比对
      if (isOneToOne && !fileBPath) {
        return res.status(400).json({ error: '1对1 比对必须上传对比文档（B 文档）' })
      }

      // 1v1 双层限流(第一层): 文件大小校验 — 仅 isOneToOne 触发,
      // 全库比对 library / full-corpus 不走这套,以免误伤大文档检索。
      //   - 单文件 ≤ 10MB
      //   - 双文件合计 ≤ 20MB(belt-and-suspenders)
      // 超限 → 400 + 清理孤儿 + 不消耗队列 + 不创建 task
      // 用户文案不暴露内部机制,详情走服务端日志(taskNo/size 等)。
      if (isOneToOne) {
        const MAX_SINGLE_FILE_SIZE = 10 * 1024 * 1024
        const MAX_PAIR_TOTAL_SIZE = 20 * 1024 * 1024
        const fsp = await import('fs/promises')
        const statSize = async (p: string): Promise<number> => {
          if (!p) return 0
          try { return (await fsp.stat(p)).size } catch { return 0 }
        }
        const sizeA = await statSize(fileAPath)
        const sizeB = await statSize(fileBPath)
        const cleanupOrphans = async () => {
          for (const p of [fileAPath, fileBPath]) {
            if (p) { try { await fsp.unlink(p) } catch {} }
          }
        }
        const fmtSize = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`
        if (sizeA > MAX_SINGLE_FILE_SIZE) {
          console.warn(`[compare/tasks] 1v1 size reject userId=${userId} fileA=${fileAName} sizeA=${sizeA} limit=${MAX_SINGLE_FILE_SIZE}`)
          await cleanupOrphans()
          return res.status(400).json({
            error: `文档 A 文件过大（${fmtSize(sizeA)}，超过单文件 10 MB 限制）。建议拆分或压缩后重新上传。本次失败不消耗权益。`,
          })
        }
        if (fileBPath && sizeB > MAX_SINGLE_FILE_SIZE) {
          console.warn(`[compare/tasks] 1v1 size reject userId=${userId} fileB=${fileBName} sizeB=${sizeB} limit=${MAX_SINGLE_FILE_SIZE}`)
          await cleanupOrphans()
          return res.status(400).json({
            error: `文档 B 文件过大（${fmtSize(sizeB)}，超过单文件 10 MB 限制）。建议拆分或压缩后重新上传。本次失败不消耗权益。`,
          })
        }
        if (fileBPath && sizeA + sizeB > MAX_PAIR_TOTAL_SIZE) {
          console.warn(`[compare/tasks] 1v1 total size reject userId=${userId} sizeA=${sizeA} sizeB=${sizeB} total=${sizeA + sizeB} limit=${MAX_PAIR_TOTAL_SIZE}`)
          await cleanupOrphans()
          return res.status(400).json({
            error: `两份文档合计文件过大（${fmtSize(sizeA + sizeB)}，超过合计 20 MB 限制）。建议拆分或压缩后重新上传。本次失败不消耗权益。`,
          })
        }
      }

      const documentName = req.body.documentName
        || (fileAName && fileBName ? `${fileAName} vs ${fileBName}` : fileAName)
        || '未命名文档'
      const fileType = req.body.fileType || fileAName.match(/\.([^.]+)$/)?.[1] || 'docx'
      const selectedStandardIds: string[] = (() => {
        try { return JSON.parse(req.body.selectedStandardIds || '[]') }
        catch { return [] }
      })()

      const bodySourceText = req.body.sourceText || ''
      const taskNo = makeBusinessNo('CMP')

      // 创建 PENDING 任务入队，worker 按优先级处理
      // intakeJson 增加 fileBName,便于 worker 在 1对1 报告里展示真实对比方文件名
      await prisma.compareTask.create({
        data: {
          taskNo,
          userId,
          documentName,
          fileType,
          compareMode,
          selectedStandardIds: JSON.stringify(selectedStandardIds),
          status: 'PENDING',
          priority: isOneToOne ? 2 : 1,
          intakeJson: JSON.stringify({
            fileAPath,
            fileBPath,
            fileAName,
            fileBName,
            sourceText: bodySourceText,
          }),
        }
      })

      res.json({
        taskNo,
        status: 'PENDING',
        message: '比对任务已提交，处理中。',
      })

    } catch (err: any) {
      console.error('[compare] 创建任务失败:', err)
      res.status(500).json({ error: '比对任务创建失败，请稍后重试' })
    }
  })

  // ─── 全库比对（异步：先建 PENDING 任务立即返回，后台处理）───
  // 用户上传单个文档，与 73K 国标库全量比对
  app.post('/api/app/compare/library', ipRateLimit(5, 60_000), requireAuth, upload.single('file'), async (req: AuthRequest, res) => {
    try {
      const userId = getUserId(req)
      const userRole = req.userRole

      // 队列两层保护（详见 FREE_QUEUE_LIMIT 注释）
      const queueGate = await checkCompareQueue(userId, userRole)
      if (queueGate) {
        if (req.file?.path) { try { await (await import('fs/promises')).unlink(req.file.path) } catch {} }
        return res.status(queueGate.http).json(queueGate.body)
      }

      const documentName = req.body.documentName || req.file?.originalname || '未命名文档'
      const fileType = req.body.fileType || req.file?.originalname?.match(/\.([^.]+)$/)?.[1] || 'docx'
      const filePath = req.file?.path || ''
      const bodySourceText = req.body.sourceText || ''

      const taskNo = makeBusinessNo('CMP')
      const title = req.body.title || documentName.replace(/\.[^.]+$/, '')

      // 创建 PENDING 任务入队，worker 按优先级处理
      await prisma.compareTask.create({
        data: {
          taskNo,
          userId,
          documentName,
          fileType,
          compareMode: 'library',
          selectedStandardIds: '[]',
          status: 'PENDING',
          priority: 1, // 全库 = 高优先级
          intakeJson: JSON.stringify({ fileAPath: filePath, sourceText: bodySourceText, title }),
        }
      })

      res.json({
        taskNo,
        status: 'PENDING',
        message: '比对任务已提交，处理中。可在任务列表中查看进度。',
      })

    } catch (err: any) {
      console.error('[compare/library] 创建任务失败:', err)
      if (err.message?.includes('ECONNREFUSED')) {
        return res.status(503).json({ error: '比对服务暂不可用，请稍后重试' })
      }
      // P2: 文档提取失败属于用户输入问题，返回 422；其他才是 500
      const isUserError = err.message?.includes('文字过少') || err.message?.includes('无法解析') || err.message?.includes('无法提取') || err.message?.includes('不支持的文件类型') || err.message?.includes('内容为空')
      res.status(isUserError ? 422 : 500).json({ error: isUserError ? err.message : '全库相似度分析失败，请稍后重试' })
    }
  })

  // ─── 章节提取 ──────────────────────────────────────────────
  // 上传单个文件 → 提取章节标题列表
  app.post('/api/app/compare/extract-sections', ipRateLimit(10, 60_000), requireAuth, uploadAny.single('file'), async (req: AuthRequest, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: '请上传文件' })

      // wx.uploadFile 的临时文件名没有扩展名，用 formData.filename 补上
      const originalName: string = req.body.filename || req.file.originalname || ''
      const ext = (originalName.match(/\.[^.]+$/) || [''])[0].toLowerCase()
      let filePath = req.file.path
      if (ext && !filePath.endsWith(ext)) {
        const newPath = filePath + ext
        const { renameSync } = await import('fs')
        renameSync(filePath, newPath)
        filePath = newPath
      }

      const text = await extractText(filePath)
      console.log(`[extract-sections] file=${originalName} ext=${ext} textLen=${text?.length ?? 0} preview=${(text || '').slice(0, 200).replace(/\n/g, '\\n')}`)
      if (!text || text.length < 10) {
        return res.status(422).json({
          error: '无法提取文档文字，可能是扫描版 PDF 或加密文档。请尝试上传文字版 PDF 或 Word 文档。',
          sections: []
        })
      }
      // 过滤水印行（学兔兔、bzfxw 等文档共享网站水印）
      const WATERMARK_RE = /学兔兔|bzfxw|www\.|标准下载|标准网|标准分享/i
      const cleanText = text.split(/\r?\n/).filter(l => !WATERMARK_RE.test(l)).join('\n')

      // 解析章节标题：行首为数字编号（如 "1 "、"2.1 "、"3.1.2 "）
      const lines = cleanText.split(/\r?\n/)
      const chapterRe = /^(\d+(?:\.\d+)*)\s+([\u4e00-\u9fa5\w].{0,60})$/
      const sections: { id: string; title: string; content: string }[] = []
      const seen = new Set<string>()
      // 记录每个章节的起始行号
      const headingLines: { idx: number; title: string }[] = []
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim()
        const m = trimmed.match(chapterRe)
        if (m) {
          const title = `${m[1]} ${m[2].trim()}`
          if (!seen.has(title)) {
            seen.add(title)
            headingLines.push({ idx: i, title })
          }
        }
        if (headingLines.length >= 60) break
      }
      // 收集每个章节的正文内容（标题行到下一个标题行之间的段落）
      headingLines.forEach((h, i) => {
        const end = i + 1 < headingLines.length ? headingLines[i + 1].idx : lines.length
        const contentLines = lines.slice(h.idx + 1, end).map(l => l.trim()).filter(l => l.length > 0)
        sections.push({ id: `s${i}`, title: h.title, content: contentLines.join('\n') })
      })
      // 如果解析不出章节（txt/无结构文档），返回段落级摘要
      if (sections.length === 0) {
        const paras = lines.filter(l => l.trim().length > 10).slice(0, 20)
        paras.forEach((p, i) => sections.push({ id: `p${i}`, title: p.trim().slice(0, 60), content: p.trim() }))
      }
      res.json({ sections })
    } catch (err: any) {
      console.error('[extract-sections]', err)
      res.status(500).json({ error: '章节提取失败，请稍后重试' })
    }
  })

  // ─── 章节级比对 ────────────────────────────────────────────
  // 接受两组章节标题，返回相似度映射
  app.post('/api/app/compare/run-sections', ipRateLimit(10, 60_000), requireAuth, (req: AuthRequest, res) => {
    const { sectionsA, sectionsB } = req.body as {
      sectionsA: { id: string; title: string; content?: string }[]
      sectionsB: { id: string; title: string; content?: string }[]
    }
    if (!Array.isArray(sectionsA) || !Array.isArray(sectionsB)) {
      return res.status(400).json({ error: '参数错误' })
    }

    function bigrams(str: string): Set<string> {
      const s = new Set<string>()
      for (let i = 0; i < str.length - 1; i++) s.add(str.slice(i, i + 2))
      return s
    }
    function similarity(a: string, b: string): number {
      if (!a || !b) return 0
      const ba = bigrams(a.toLowerCase())
      const bb = bigrams(b.toLowerCase())
      let inter = 0
      ba.forEach(bg => { if (bb.has(bg)) inter++ })
      const union = ba.size + bb.size - inter
      return union ? inter / union : 0
    }

    const mappings: object[] = []
    const used = new Set<number>()
    sectionsA.forEach((a, i) => {
      let bestJ = -1, bestScore = 0
      sectionsB.forEach((b, j) => {
        if (used.has(j)) return
        const sc = similarity(a.title, b.title)
        if (sc > bestScore) { bestScore = sc; bestJ = j }
      })
      if (bestJ >= 0 && bestScore > 0.1) {
        used.add(bestJ)
        mappings.push({
          idxA: i, idxB: bestJ,
          sectionA: a.title, sectionB: sectionsB[bestJ].title,
          contentA: a.content || '',
          contentB: sectionsB[bestJ].content || '',
          similarity: Math.round(bestScore * 100)
        })
      } else {
        mappings.push({
          idxA: i, idxB: -1,
          sectionA: a.title, sectionB: '—',
          contentA: a.content || '',
          contentB: '',
          similarity: 0
        })
      }
    })
    res.json({ mappings })
  })

  app.get('/api/app/compare/tasks/:taskNo', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const taskNo = getRouteParam(req.params.taskNo)
    const task = await prisma.compareTask.findUnique({ where: { taskNo } })
    if (!task) return res.status(404).json({ error: '任务不存在' })
    // P0-4: 归属校验 — 他人知道 taskNo 也不能查看私密报告
    if (task.userId && task.userId !== getUserId(req)) {
      return res.status(403).json({ error: '无权访问此比对任务' })
    }

    const report = parseJson<Record<string, unknown>>(task.reportJson)
    const summary = parseJson<Record<string, unknown>>(task.summaryJson)

    // 不管是否解锁，始终返回免费预览字段
    const riskLevel = (summary as any)?.riskLevel || (report as any)?.risk_level || ''
    const riskLabel = (summary as any)?.riskLabel || (report as any)?.risk_label || ''

    // library 模式：提取免费预览摘要（不暴露完整报告）
    let preview: Record<string, unknown> | null = null
    if (task.compareMode === 'library' && report) {
      const topSimilar = (report as any).top_similar || []
      preview = {
        topSimilarCount: topSimilar.length,
        topSimilarPreview: topSimilar.slice(0, 3).map((s: any) => ({
          code: s.code,
          name: s.name,
          overall_score: s.overall_score,
        })),
        summaryOverallMax: (report as any).summary?.overall_max ?? 0,
        termsMatched: (report as any).terms?.matched ?? 0,
        referencesTotal: (report as any).references?.total ?? 0,
        referencesIssueCount: ((report as any).references?.issues || []).length,
        structureMissing: ((report as any).structure?.missing || []).length,
        duplicationRate: (report as any).duplication?.estimated_rate ?? 0,
        conclusions: ((report as any).conclusions || []).slice(0, 2),
      }
    }

    // 付费会员查看全库报告时自动解锁（无需手动点"解锁"）
    let autoUnlocked = false
    if (task.compareMode === 'library' && !task.fullReportUnlockedAt && task.status === 'COMPLETED') {
      const userId = getUserId(req)
      if (userId) {
        const membership = await prisma.userMembership.findFirst({
          where: { userId, status: 'ACTIVE', planId: { in: ['personal', 'pro', 'enterprise'] } }
        })
        if (membership) {
          await prisma.compareTask.update({
            where: { taskNo: task.taskNo },
            data: { fullReportUnlockedAt: new Date() }
          })
          autoUnlocked = true
        }
      }
    }

    const isUnlocked = task.compareMode !== 'library' || Boolean(task.fullReportUnlockedAt) || autoUnlocked

    res.json({
      taskNo: task.taskNo,
      documentName: task.documentName,
      compareMode: task.compareMode,
      status: task.status,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
      riskLevel,
      riskLabel,
      freeRisk: summary?.freeRisk ?? [],
      intake: parseJson<Record<string, unknown>>(task.intakeJson) ?? null,
      preview,
      access: {
        fullReportUnlocked: isUnlocked,
        exportUnlocked: Boolean(task.exportUnlockedAt)
      },
      report: isUnlocked ? report : null,
      termIssues: (report as any)?.termIssues ?? [],
      unlockOffer: {
        fullReportPrice: 0,
        exportPrice: 0
      }
    })
  })

  // 保存题录信息（标准编号、题名、ICS/CCS、适用范围）
  app.patch('/api/app/compare/tasks/:taskNo/intake', requireAuth, async (req: AuthRequest, res) => {
    try {
      const taskNo = getRouteParam(req.params.taskNo)
      const task = await prisma.compareTask.findUnique({ where: { taskNo } })
      if (!task) return res.status(404).json({ error: '任务不存在' })
      if (task.userId && task.userId !== getUserId(req)) {
        return res.status(403).json({ error: '无权修改此比对任务' })
      }
      const { standardCode, chineseTitle, standardType, ics, ccs, scope } = req.body
      await prisma.compareTask.update({
        where: { taskNo },
        data: { intakeJson: JSON.stringify({ standardCode, chineseTitle, standardType, ics, ccs, scope }) }
      })
      res.json({ ok: true })
    } catch (err: any) {
      res.status(500).json({ error: '保存失败，请稍后重试' })
    }
  })

  app.post('/api/app/compare/tasks/:taskNo/unlock-order', requireAuth, async (req: AuthRequest, res) => {
    const taskNo = getRouteParam(req.params.taskNo)
    const task = await prisma.compareTask.findUnique({ where: { taskNo } })
    if (!task) return res.status(404).json({ error: '任务不存在' })
    // P0-4: 归属校验
    if (task.userId && task.userId !== getUserId(req)) {
      return res.status(403).json({ error: '无权解锁此比对报告' })
    }

    const userId = getUserId(req)


    if (userId) {
      // pro / enterprise 会员：不限次免费解锁
      const proMembership = await prisma.userMembership.findFirst({
        where: { userId, status: 'ACTIVE', planId: { in: ['pro', 'enterprise'] } }
      })
      if (proMembership) {
        const order = await prisma.appOrder.create({
          data: {
            orderNo: makeBusinessNo('ORD'),
            userId,
            productType: 'COMPARE_REPORT',
            productRef: task.taskNo,
            title: `比对报告解锁 - ${task.documentName}`,
            amount: 0,
            status: 'PAID',
            channel: 'MEMBER_FREE',
            paidAt: new Date(),
          }
        })
        await handlePostPayment({ orderNo: order.orderNo, productType: order.productType, userId: order.userId, planId: null, productRef: order.productRef })
        return res.json({ ...order, memberFree: true, tier: 'pro' })
      }

      // personal 会员：年度 10 次免费
      const personalMembership = await prisma.userMembership.findFirst({
        where: { userId, status: 'ACTIVE', planId: 'personal' }
      })
      if (personalMembership) {
        const usedFreeCompares = await prisma.appOrder.count({
          where: {
            userId,
            productType: 'COMPARE_REPORT',
            channel: 'MEMBER_FREE',
            status: 'PAID',
            paidAt: { gte: personalMembership.createdAt }
          }
        })
        if (usedFreeCompares < PERSONAL_ANNUAL_LIMIT) {
          const order = await prisma.appOrder.create({
            data: {
              orderNo: makeBusinessNo('ORD'),
              userId,
              productType: 'COMPARE_REPORT',
              productRef: task.taskNo,
              title: `比对报告解锁 - ${task.documentName}`,
              amount: 0,
              status: 'PAID',
              channel: 'MEMBER_FREE',
              paidAt: new Date(),
            }
          })
          await handlePostPayment({ orderNo: order.orderNo, productType: order.productType, userId: order.userId, planId: null, productRef: order.productRef })
          return res.json({ ...order, memberFree: true, usedFreeCompares: usedFreeCompares + 1, freeLimit: PERSONAL_ANNUAL_LIMIT, tier: 'personal' })
        }
        // 额度用完
        return res.status(403).json({ error: `本年度全库相似度分析额度已用完（${PERSONAL_ANNUAL_LIMIT}/${PERSONAL_ANNUAL_LIMIT}），请升级专业版获取不限次权益` })
      }
    }

    // 免费用户：不可解锁
    res.status(403).json({ error: '全库相似度分析报告需要会员权限，请开通个人或专业会员' })
  })

  app.post('/api/app/compare/tasks/:taskNo/export-order', requireAuth, async (req: AuthRequest, res) => {
    const task = await prisma.compareTask.findUnique({ where: { taskNo: getRouteParam(req.params.taskNo) } })
    if (!task) return res.status(404).json({ error: '任务不存在' })

    const order = await prisma.appOrder.create({
      data: {
        orderNo: makeBusinessNo('ORD'),
        userId: req.userId!,
        productType: 'COMPARE_EXPORT',
        productRef: task.taskNo,
        title: `PDF 报告导出 - ${task.documentName}`,
        amount: 0,
        status: 'PAID',
        channel: 'MEMBER_FREE',
        paidAt: new Date()
      }
    })
    res.json(order)
  })

  // ─── 发票申请 ──────────────────────────────────────────────

  /**
   * 查询用户的发票申请列表
   */
  app.get('/api/app/invoices', requireAuth, async (req: AuthRequest, res) => {
    const userId = getUserId(req)
    const items = await prisma.invoiceRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ items })
  })

  /**
   * 提交发票申请
   *
   * 限制：只有已支付的订单才能申请发票，且不能重复申请
   */
  app.post('/api/app/invoices', requireAuth, async (req: AuthRequest, res) => {
    const invoiceSchema = z.object({
      orderNo: z.string().min(1),
      type: z.enum(['NORMAL', 'SPECIAL']).default('NORMAL'),
      titleType: z.enum(['PERSONAL', 'COMPANY']).default('COMPANY'),
      title: z.string().min(1, '请填写发票抬头'),
      taxNo: z.string().optional(),
      bank: z.string().optional(),
      bankAccount: z.string().optional(),
      address: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().email('请填写正确的邮箱'),
      remark: z.string().max(200).optional()
    })

    const parsed = invoiceSchema.safeParse(req.body)
    if (!parsed.success) {
      const firstError = parsed.error.errors[0]?.message || '参数错误'
      return res.status(400).json({ error: firstError })
    }

    const userId = getUserId(req)

    // 检查订单存在且已支付
    const order = await prisma.appOrder.findUnique({ where: { orderNo: parsed.data.orderNo } })
    if (!order) return res.status(404).json({ error: '订单不存在' })
    if (order.status !== 'PAID') return res.status(400).json({ error: '订单未支付，无法申请发票' })
    if (order.amount <= 0) return res.status(400).json({ error: '0 元订单无需开票' })
    if (order.invoiceStatus === 'REQUESTED' || order.invoiceStatus === 'ISSUED') {
      return res.status(400).json({ error: '该订单已申请过发票' })
    }
    // 退款窗口期内不允许开票（开票后再退款会导致票作废 / 财务对账问题）
    if (order.paidAt) {
      const refundDeadlineMs = new Date(order.paidAt).getTime() + REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000
      if (Date.now() < refundDeadlineMs) {
        return res.status(400).json({ error: `订单仍在 ${REFUND_WINDOW_DAYS} 天退款期内，请在退款期结束后申请发票` })
      }
    }

    // 企业发票必须填税号
    if (parsed.data.titleType === 'COMPANY' && !parsed.data.taxNo) {
      return res.status(400).json({ error: '企业发票请填写纳税人识别号' })
    }

    // 专用发票必须填银行信息和地址
    if (parsed.data.type === 'SPECIAL') {
      if (!parsed.data.bank || !parsed.data.bankAccount) {
        return res.status(400).json({ error: '专用发票请填写开户银行和账号' })
      }
      if (!parsed.data.address || !parsed.data.phone) {
        return res.status(400).json({ error: '专用发票请填写注册地址和电话' })
      }
    }

    const invoiceNo = makeBusinessNo('INV')

    const invoice = await prisma.invoiceRequest.create({
      data: {
        invoiceNo,
        userId,
        orderNo: order.orderNo,
        type: parsed.data.type,
        titleType: parsed.data.titleType,
        title: parsed.data.title,
        taxNo: parsed.data.taxNo,
        bank: parsed.data.bank,
        bankAccount: parsed.data.bankAccount,
        address: parsed.data.address,
        phone: parsed.data.phone,
        email: parsed.data.email,
        amount: order.amount,
        remark: parsed.data.remark
      }
    })

    // 更新订单的发票状态 + 锁定 invoicedAt（开票后禁退款，对称保护）
    await prisma.appOrder.update({
      where: { orderNo: order.orderNo },
      data: { invoiceStatus: 'REQUESTED', invoicedAt: new Date() }
    })

    res.json({
      ...invoice,
      message: '发票申请已提交，预计 1-3 个工作日内发送到您的邮箱'
    })
  })

  /**
   * 查询单张发票详情
   */
  app.get('/api/app/invoices/:invoiceNo', requireAuth, async (req: AuthRequest, res) => {
    const invoiceNo = getRouteParam(req.params.invoiceNo)
    const userId = getUserId(req)
    const invoice = await prisma.invoiceRequest.findUnique({
      where: { invoiceNo }
    })
    if (!invoice) return res.status(404).json({ error: '发票申请不存在' })
    // ownership 拦截：禁止跨用户读取（PII：税号/邮箱/抬头）
    // admin 角色可越权查看任何发票（财务对账场景）
    if (invoice.userId !== userId && req.userRole !== 'admin') {
      return res.status(404).json({ error: '发票申请不存在' })
    }
    res.json(invoice)
  })

  /**
   * 查询订单的发票状态（供前端判断是否可以申请发票）
   */
  app.get('/api/app/orders/:orderNo/invoice-status', requireAuth, async (req: AuthRequest, res) => {
    const orderNo = getRouteParam(req.params.orderNo)
    const userId = getUserId(req)
    const order = await prisma.appOrder.findUnique({ where: { orderNo } })
    if (!order) return res.status(404).json({ error: '订单不存在' })
    // ownership 拦截：禁止跨用户读取订单状态。admin 越权可查
    if (order.userId !== userId && req.userRole !== 'admin') {
      return res.status(404).json({ error: '订单不存在' })
    }

    const existingInvoice = await prisma.invoiceRequest.findFirst({
      where: { orderNo: order.orderNo }
    })

    // 退款窗口已过才允许申请发票
    const refundWindowClosed = !!(order.paidAt &&
      Date.now() >= new Date(order.paidAt).getTime() + REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000)

    res.json({
      orderNo: order.orderNo,
      orderStatus: order.status,
      invoiceStatus: order.invoiceStatus,
      canApply: order.status === 'PAID' &&
        order.amount > 0 &&
        order.invoiceStatus === 'NOT_REQUESTED' &&
        refundWindowClosed,
      refundWindowClosed,
      existingInvoice: existingInvoice ? {
        invoiceNo: existingInvoice.invoiceNo,
        status: existingInvoice.status,
        title: existingInvoice.title,
        email: existingInvoice.email,
        createdAt: existingInvoice.createdAt
      } : null
    })
  })

  // ─── 统一识别（扫描优先，OCR 兜底）──────────────────────────
  // 上传图片/PDF → 条码扫描 → OCR 兜底 → 返回识别结果
  app.post('/api/app/recognize', ipRateLimit(30, 60_000), requireAuth, uploadRecognize.single('file'), async (req: AuthRequest, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: '请上传文件' })

      const result = await callDedupMultipart(
        '/internal/recognize',
        req.file.path,
        req.file.originalname || 'file',
        req.file.mimetype || 'application/octet-stream',
      ) as any

      // 如果识别到标准号且有文字 → 提示可以发起全库比对
      if (result.success && result.text_length >= 50) {
        result.canLibraryCompare = true
      }

      // 埋点：扫码成功（首扫/每扫），营销自动化依赖
      if (result.success) {
        trackScanSuccess(req.userId, {
          endpoint: 'recognize',
          text_length: result.text_length,
          recognized: result.recognized ?? null,
        }).catch(() => {})
      }

      res.json(result)
    } catch (err: any) {
      console.error('[recognize] 识别失败:', err)
      if (err.name === 'AbortError') {
        return res.status(504).json({ error: '识别超时，请稍后重试' })
      }
      if (err.message?.includes('ECONNREFUSED')) {
        return res.status(503).json({ error: '识别服务暂不可用，请稍后重试' })
      }
      res.status(500).json({ error: '识别失败，请稍后重试' })
    }
  })

  // ─── 扫一扫拍照识别（PP-ShiTu + OCR 并行）──────────────────
  // 额度控制由小程序前端 session.js 管理（与 detail/graph/outline 等一致）
  app.post('/api/app/scan/recognize', ipRateLimit(30, 60_000), requireAuth, uploadRecognize.single('file'), async (req: AuthRequest, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: '请上传文件' })

      const result = await callDedupMultipart(
        '/internal/scan-recognize',
        req.file.path,
        req.file.originalname || 'file',
        req.file.mimetype || 'application/octet-stream',
      ) as ScanRecognizeRawResult

      const matchSource = normalizeScanMatchSource(result)
      const matchSourceLabel = getScanMatchSourceLabel(matchSource)
      const ocrPreview = buildScanOcrPreview(result.ocr_text)
      // advice 评分模型已废弃（前端 _buildAdvice 也已删），保留 nullable 以防旧客户端
      // 兼容期；新前端只吃 recognition_mode / industry_token / risk_directions
      const advice = buildScanAdvice(result, matchSource)

      // 服务推荐 — 由 ts 层固定文案，不从 dedup 来。底部弱化卡片，引导到现有全库比对功能
      const serviceOffer = {
        title: '想做更深入的标准合规审查？',
        body: '上传商品包装 / 规格书 PDF，走全库相似度分析，获取详细的标准引用与差异报告。',
        cta: { text: '去做全库比对', url: '/pages/compare/index?from=scan' },
      }

      // 埋点：扫码成功（首扫/每扫），营销自动化依赖
      trackScanSuccess(req.userId, {
        endpoint: 'scan/recognize',
        match_source: matchSource,
        recognition_mode: result.recognition_mode || 'general',
      }).catch(() => {})

      res.json({
        ...result,
        match_source: matchSource,
        match_source_label: matchSourceLabel,
        ocr_preview: ocrPreview,
        advice,
        // P0 止血新增透传字段
        recognition_mode: result.recognition_mode || 'general',
        industry_token: result.industry_token || null,
        risk_directions: result.risk_directions || [],
        service_offer: serviceOffer,
      })
    } catch (err: any) {
      console.error('[scan/recognize] 失败:', err)
      if (err.name === 'AbortError') {
        return res.status(504).json({ error: '识别超时，请稍后重试' })
      }
      if (err.message?.includes('ECONNREFUSED')) {
        return res.status(503).json({ error: '识别服务暂不可用，请稍后重试' })
      }
      res.status(500).json({ error: '识别失败，请稍后重试' })
    }
  })

  // 识别 + 全库比对一体化（拍照 → 识别 → 比对）
  app.post('/api/app/recognize-and-compare', ipRateLimit(30, 60_000), requireAuth, uploadRecognize.single('file'), async (req: AuthRequest, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: '请上传文件' })

      // 1. 先识别
      const recognizeResult = await callDedupMultipart(
        '/internal/recognize',
        req.file.path,
        req.file.originalname || 'file',
        req.file.mimetype || 'application/octet-stream',
      ) as any

      // 埋点：扫码成功（首扫/每扫），营销自动化依赖
      if (recognizeResult.success) {
        trackScanSuccess(req.userId, {
          endpoint: 'recognize-and-compare',
          text_length: recognizeResult.text_length,
          has_standard: Boolean(recognizeResult.standard),
        }).catch(() => {})
      }

      // 如果识别到标准号，直接返回标准信息（不做全库比对）
      if (recognizeResult.standard) {
        return res.json({
          mode: 'standard_found',
          recognize: recognizeResult,
          standard: recognizeResult.standard,
        })
      }

      // 2. 有足够文字 → 发起全库比对
      if (recognizeResult.text && recognizeResult.text_length >= 50) {
        const title = req.body.title || ''
        const dedupReport = await callDedupService('/internal/report', {
          text: recognizeResult.text,
          title,
          ics_hint: '',
          top_n: 20,
        })

        const taskNo = makeBusinessNo('CMP')
        const task = await prisma.compareTask.create({
          data: {
            taskNo,
            userId: getUserId(req),
            documentName: req.file.originalname || '拍照识别文档',
            fileType: 'image',
            compareMode: 'library',
            selectedStandardIds: '[]',
            status: 'COMPLETED',
            summaryJson: JSON.stringify({
              freeRisk: dedupReport.free_risk || [],
              riskLevel: dedupReport.risk_level || '',
              riskLabel: dedupReport.risk_label || '',
            }),
            reportJson: JSON.stringify(dedupReport),
            finishedAt: new Date(),
          }
        })

        return res.json({
          mode: 'library_compared',
          recognize: recognizeResult,
          taskNo: task.taskNo,
          freeRisk: dedupReport.free_risk || [],
          riskLevel: dedupReport.risk_level,
          riskLabel: dedupReport.risk_label,
        })
      }

      // 3. 文字太少，只返回识别结果
      res.json({
        mode: 'text_insufficient',
        recognize: recognizeResult,
        error: '识别到的文字过少，无法进行全库相似度分析。请拍摄更清晰的标准文档内容页。'
      })
    } catch (err: any) {
      console.error('[recognize-and-compare] 失败:', err)
      res.status(500).json({ error: '识别比对失败，请稍后重试' })
    }
  })

  // ═══════════════════════════════════════════════════════════
  // 管理后台 API
  // ═══════════════════════════════════════════════════════════

  /** 管理后台：发票列表（分页，默认100条） */
  app.get('/api/admin/invoices', requirePermission('admin.invoices.read'), async (req: AuthRequest, res) => {
    const take = Math.min(Number(req.query.pageSize) || 100, 500)
    const skip = (Math.max(Number(req.query.page) || 1, 1) - 1) * take
    const [total, items] = await Promise.all([
      prisma.invoiceRequest.count(),
      prisma.invoiceRequest.findMany({ orderBy: { createdAt: 'desc' }, take, skip }),
    ])
    res.json({ total, items })
  })

  /** 管理后台：开具发票 */
  app.post('/api/admin/invoices/:invoiceNo/issue', requirePermission('admin.invoices.issue'), async (req: AuthRequest, res) => {
    const invoiceNo = getRouteParam(req.params.invoiceNo)
    const invoice = await prisma.invoiceRequest.findUnique({ where: { invoiceNo } })
    if (!invoice) return res.status(404).json({ error: '发票不存在' })
    if (invoice.status !== 'PENDING') return res.status(400).json({ error: '该发票已处理' })
    const updated = await prisma.invoiceRequest.update({
      where: { invoiceNo },
      data: { status: 'ISSUED', issuedAt: new Date() }
    })
    // 更新订单发票状态
    await prisma.appOrder.updateMany({ where: { orderNo: invoice.orderNo }, data: { invoiceStatus: 'ISSUED' } })
    res.json(updated)
  })

  /** 管理后台：驳回发票 */
  app.post('/api/admin/invoices/:invoiceNo/reject', requirePermission('admin.invoices.reject'), async (req: AuthRequest, res) => {
    const { reason } = req.body || {}
    const invoiceNo = getRouteParam(req.params.invoiceNo)
    const invoice = await prisma.invoiceRequest.findUnique({ where: { invoiceNo } })
    if (!invoice) return res.status(404).json({ error: '发票不存在' })
    if (invoice.status !== 'PENDING') return res.status(400).json({ error: '该发票已处理' })
    const updated = await prisma.invoiceRequest.update({
      where: { invoiceNo },
      data: { status: 'REJECTED', rejectReason: reason || '信息不符' }
    })
    // 回退订单发票状态，允许用户重新申请
    await prisma.appOrder.updateMany({
      where: { orderNo: invoice.orderNo },
      data: { invoiceStatus: 'NOT_REQUESTED' }
    })
    res.json(updated)
  })

  /** 管理后台：预约列表（分页，默认100条） */
  app.get('/api/admin/bookings', requirePermission('admin.bookings.read'), async (req: AuthRequest, res) => {
    const take = Math.min(Number(req.query.pageSize) || 100, 500)
    const skip = (Math.max(Number(req.query.page) || 1, 1) - 1) * take
    const [total, items] = await Promise.all([
      prisma.serviceBooking.count(),
      prisma.serviceBooking.findMany({ orderBy: { createdAt: 'desc' }, take, skip }),
    ])
    res.json({ total, items })
  })

  /** 管理后台：更新预约状态 */
  app.patch('/api/admin/bookings/:bookingNo/status', requirePermission('admin.bookings.manage'), async (req: AuthRequest, res) => {
    const { status } = req.body
    if (!['待联系', '已联系', '已完成', '已取消'].includes(status)) {
      return res.status(400).json({ error: '无效状态' })
    }
    const updated = await prisma.serviceBooking.update({
      where: { bookingNo: getRouteParam(req.params.bookingNo) },
      data: { status }
    })
    res.json(updated)
  })

  /** 管理后台：订单列表（分页，默认100条） */
  app.get('/api/admin/orders', requirePermission('admin.orders.read'), async (req: AuthRequest, res) => {
    const take = Math.min(Number(req.query.pageSize) || 100, 500)
    const skip = (Math.max(Number(req.query.page) || 1, 1) - 1) * take
    const [total, items] = await Promise.all([
      prisma.appOrder.count(),
      prisma.appOrder.findMany({ orderBy: { createdAt: 'desc' }, take, skip, include: { user: { select: { phone: true, name: true } } } }),
    ])
    res.json({ total, items: await withExpertVoteOrderStatus(items) })
  })

  /** 管理后台：订单详情 */
  app.get('/api/admin/orders/:orderNo', requirePermission('admin.orders.read'), async (req: Request, res: Response) => {
    const order = await prisma.appOrder.findUnique({
      where: { orderNo: getRouteParam(req.params.orderNo) },
      include: { user: { select: { phone: true, name: true } } },
    })
    if (!order) return res.status(404).json({ error: '订单不存在' })
    const [item] = await withExpertVoteOrderStatus([order])
    res.json(item)
  })

  /** 管理后台：比对任务列表（分页，默认100条） */
  app.get('/api/admin/compare-tasks', requireAdmin, async (req: AuthRequest, res) => {
    const take = Math.min(Number(req.query.pageSize) || 100, 500)
    const skip = (Math.max(Number(req.query.page) || 1, 1) - 1) * take
    const [total, items] = await Promise.all([
      prisma.compareTask.count(),
      prisma.compareTask.findMany({ orderBy: { createdAt: 'desc' }, take, skip, include: { user: { select: { phone: true, name: true } } } }),
    ])
    res.json({ total, items })
  })

  /** 管理后台：确认支付凭证（PENDING_VERIFY → PAID） */
  app.post('/api/admin/orders/:orderNo/confirm', requirePermission('admin.orders.confirm'), async (req: AuthRequest, res) => {
    try {
      const orderNo = getRouteParam(req.params.orderNo)
      const order = await prisma.appOrder.findUnique({ where: { orderNo } })
      if (!order) return res.status(404).json({ error: '订单不存在' })
      if (order.status !== 'PENDING_VERIFY') return res.status(400).json({ error: `当前状态 ${order.status}，不可确认` })

      // retry-safe：副作用通过 return 收集，避免 PG Serializable retry 时累积。
      const effects = await runPaymentTx(async (tx) => {
        await tx.appOrder.update({
          where: { orderNo },
          data: { status: 'PAID', paidAt: new Date() }
        })
        return handlePostPaymentInTx(tx, order)
      })
      flushPostPaymentEffects(effects)
      res.json({ ok: true, orderNo: order.orderNo, status: 'PAID' })
    } catch (e: any) {
      console.error('[confirm-receipt] 确认凭证异常:', e)
      res.status(500).json({ error: '操作失败，请稍后重试' })
    }
  })

  /** 管理后台：驳回支付凭证（PENDING_VERIFY → PENDING） */
  app.post('/api/admin/orders/:orderNo/reject-receipt', requirePermission('admin.orders.confirm'), async (req: AuthRequest, res) => {
    try {
      const orderNo = getRouteParam(req.params.orderNo)
      const order = await prisma.appOrder.findUnique({ where: { orderNo } })
      if (!order) return res.status(404).json({ error: '订单不存在' })
      if (order.status !== 'PENDING_VERIFY') return res.status(400).json({ error: `当前状态 ${order.status}，不可驳回` })

      const updated = await prisma.appOrder.update({
        where: { orderNo },
        data: { status: 'PENDING', receiptImage: null }
      })
      res.json({ ok: true, orderNo: updated.orderNo, status: 'PENDING' })
    } catch (e: any) {
      console.error('[reject-receipt] 驳回凭证异常:', e)
      res.status(500).json({ error: '操作失败，请稍后重试' })
    }
  })

  /** 管理后台：查看凭证图片 */
  app.get('/api/admin/orders/:orderNo/receipt', requirePermission('admin.orders.read'), async (req: AuthRequest, res) => {
    const order = await prisma.appOrder.findUnique({ where: { orderNo: getRouteParam(req.params.orderNo) } })
    if (!order || !order.receiptImage) return res.status(404).json({ error: '无凭证' })
    // receiptImage 只存文件名，实际文件在 UPLOAD_DIR 下
    res.sendFile(order.receiptImage, { root: UPLOAD_DIR })
  })

  type RefundTxResult = {
    expertVoteCasFailed: boolean
    requestNo?: string
  }

  type RefundExecutionResult =
    | { ok: false; error: string }
    | {
        ok: true
        refundId?: string
        mock: boolean
        refundCents: number
        expertVoteCasFailed: boolean
        requestNo?: string
      }

  /** 通用退款执行逻辑（管理后台 + 用户端共用） */
  async function executeRefund(order: any, reason: string, refundCents: number, operatorId: string): Promise<RefundExecutionResult> {
    const refundNo = `RF-${order.orderNo}`
    const refundResult = await createRefund({
      orderNo: order.orderNo,
      refundNo,
      totalCents: order.amount,
      refundCents,
      reason,
    })

    if (!refundResult.success) {
      return { ok: false, error: `微信退款失败: ${refundResult.error}` }
    }

    const txResult: RefundTxResult = await runPaymentTx(async (tx) => {
      const refundedAt = new Date()
      await tx.appOrder.update({
        where: { orderNo: order.orderNo },
        data: {
          status: 'REFUNDED',
          refundedAt,
          refundReason: reason,
          payloadJson: JSON.stringify({
            ...JSON.parse(order.payloadJson || '{}'),
            refundId: refundResult.refundId,
            refundNo,
            refundStatus: refundResult.status,
            refundCents,
            refundRate: refundCents === order.amount ? 1 : REFUND_RATE,
          }),
        }
      })

      if (order.productType === 'MEMBERSHIP' && order.userId) {
        // 精确撤销：只关闭由本订单开通的会员，不影响其他来源（赠送/管理员授予）
        const revokedRows = await tx.userMembership.updateMany({
          where: {
            userId: order.userId,
            status: 'ACTIVE',
            sourceRef: order.orderNo,
          },
          data: {
            status: 'EXPIRED',
            revokedAt: new Date(),
            revokedBy: operatorId,
            revokeReason: `退款撤销 (${order.orderNo})`,
          }
        })
        // legacy fallback：sourceRef 字段是 2026-04-09 才加的，老 ACTIVE 数据 sourceRef 是 NULL
        // 仅在按 sourceRef 找不到时，按 userId+planId 匹配 sourceRef IS NULL 的行兜底
        // 这层保护避免误伤已写过 sourceRef 的新会员（精确模式优先）
        let fallbackRows = { count: 0 }
        if (revokedRows.count === 0) {
          fallbackRows = await tx.userMembership.updateMany({
            where: {
              userId: order.userId,
              status: 'ACTIVE',
              planId: order.planId || undefined,
              sourceRef: null,
            },
            data: {
              status: 'EXPIRED',
              revokedAt: new Date(),
              revokedBy: operatorId,
              revokeReason: `退款撤销 (${order.orderNo}) [legacy fallback]`,
            }
          })
        }
        const totalRevoked = revokedRows.count + fallbackRows.count
        if (totalRevoked > 0) {
          await writeAuditLog({
            actor: operatorId || null,
            action: 'MEMBERSHIP_REVOKED',
            targetType: 'UserMembership',
            targetId: order.orderNo,
            diff: {
              userId: order.userId,
              revokedBy: operatorId,
              reason: `退款撤销 (${order.orderNo})`,
              source: 'refund',
              orderNo: order.orderNo,
              planId: order.planId,
              revokedCount: totalRevoked,
              mode: revokedRows.count > 0 ? 'exact_sourceRef' : 'legacy_fallback',
            },
          }, tx)
        }
      }
      if (order.productType === 'COMPARE_REPORT' && order.productRef) {
        await tx.compareTask.updateMany({
          where: { taskNo: order.productRef },
          data: { fullReportUnlockedAt: null }
        })
      }
      if (order.productType === 'COMPARE_EXPORT' && order.productRef) {
        await tx.compareTask.updateMany({
          where: { taskNo: order.productRef },
          data: { exportUnlockedAt: null }
        })
      }
      if (order.productType === 'EXPERT_VOTE' && order.productRef) {
        await tx.auditLog.create({
          data: {
            actor: operatorId || null,
            action: 'ORDER_REFUND',
            targetType: 'AppOrder',
            targetId: order.orderNo,
            diffJson: JSON.stringify({
              orderNo: order.orderNo,
              productType: 'EXPERT_VOTE',
              refundCents,
              operatorId,
              refundedAt: refundedAt.toISOString(),
              reason,
              refundId: refundResult.refundId,
              refundOrderId: refundNo,
              refundChannel: refundResult.mock ? 'MOCK_WECHAT' : 'WECHAT',
            }),
          },
        })
        const current = await tx.expertVoteRequest.findFirst({
          where: { requestNo: order.productRef, orderNo: order.orderNo },
          select: { id: true, requestNo: true, projectName: true, userId: true, status: true },
        })
        const actualStatus = current?.status || null
        const moved = current
          ? await tx.expertVoteRequest.updateMany({
              where: {
                id: current.id,
                orderNo: order.orderNo,
                status: { in: [...EXPERT_VOTE_REFUNDABLE_STATUSES] },
              },
              data: { status: 'REFUNDED' },
            })
          : { count: 0 }

        if (current && moved.count === 1) {
          await tx.expertVoteSignLog.create({
            data: {
              requestId: current.id,
              action: 'REFUND',
              operatorId,
              payloadJson: JSON.stringify({
                requestNo: current.requestNo,
                projectName: current.projectName,
                fromStatus: actualStatus,
                toStatus: 'REFUNDED',
                refundAmount: refundCents,
                refundCents,
                operatorId,
                refundOrderId: refundNo,
                wxRefundId: refundResult.refundId,
                orderNo: order.orderNo,
                operatedAt: refundedAt.toISOString(),
                reason,
              }),
            },
          })
          await tx.notification.create({
            data: {
              userId: current.userId,
              title: '专家评审申请已退款',
              body: `《${current.projectName}》专家评审申请已退款，金额 ¥${formatCny(refundCents)} 将原路退回，预计 1-3 个工作日到账。`,
              type: 'EXPERT_VOTE',
              link: `/expert-vote/${current.requestNo}`,
            },
          })
          return { expertVoteCasFailed: false, requestNo: current.requestNo }
        }

        // 微信退款已经成功，此时如果因并发状态漂移导致本地 ExpertVoteRequest 迁移失败，
        // 不能回滚本事务。否则 AppOrder 仍显示 PAID，会比"专家评审状态未联动"更严重：
        // 钱已退但订单未退。这里先把订单退款事实落库，再用 REFUND_CAS_FAILED 进入人工修复。
        if (current) {
          await tx.expertVoteSignLog.create({
            data: {
              requestId: current.id,
              action: 'REFUND_CAS_FAILED',
              operatorId,
              payloadJson: JSON.stringify({
                wxRefundId: refundResult.refundId,
                wxRefundedAt: refundedAt.toISOString(),
                orderNo: order.orderNo,
                requestNo: current.requestNo,
                expertVoteRequestId: current.id,
                refundCents,
                expectedRefundableStates: EXPERT_VOTE_REFUNDABLE_STATUSES,
                actualStatus,
                operatorId,
                message: '钱已退但本地专家评审状态联动失败，需要人工介入。',
              }),
            },
          })
          await tx.notification.create({
            data: {
              userId: current.userId,
              title: '订单退款已处理',
              body: `《${current.projectName}》相关订单退款已处理，金额 ¥${formatCny(refundCents)} 将原路退回，预计 1-3 个工作日到账。`,
              type: 'EXPERT_VOTE',
              link: `/expert-vote/${current.requestNo}`,
            },
          })
        }
        return {
          expertVoteCasFailed: true,
          requestNo: current?.requestNo || order.productRef,
        }
      }
      return { expertVoteCasFailed: false }
    })

    return {
      ok: true,
      refundId: refundResult.refundId,
      mock: refundResult.mock,
      refundCents,
      ...txResult,
    }
  }

  /** 管理后台：退款（PAID → REFUNDED，默认全额，撤销会员/报告解锁） */
  app.post('/api/admin/orders/:orderNo/refund', requirePermission('admin.orders.refund'), async (req: AuthRequest, res) => {
    try {
      const { reason, refundCents: requestedRefundCents } = req.body || {}
      const order = await prisma.appOrder.findUnique({ where: { orderNo: getRouteParam(req.params.orderNo) } })
      if (!order) return res.status(404).json({ error: '订单不存在' })
      if (order.productType === 'EXPERT_VOTE' && order.status !== 'PAID') {
        return res.status(409).json({ error: `当前订单状态 ${order.status}，不允许退款` })
      }
      if (order.status !== 'PAID') return res.status(400).json({ error: `当前状态 ${order.status}，只有已支付订单可退款` })

      let finalReason = reason || '管理员操作退款'
      if (order.productType === 'EXPERT_VOTE') {
        finalReason = normalizeRefundReason(reason)
        if (!finalReason) return res.status(400).json({ error: '请填写退款原因' })
        if (finalReason.length > 500) return res.status(400).json({ error: '退款原因不能超过 500 字' })

        const requested = requestedRefundCents === undefined || requestedRefundCents === null || requestedRefundCents === ''
          ? order.amount
          : Number(requestedRefundCents)
        if (!Number.isFinite(requested) || requested !== order.amount) {
          return res.status(400).json({ error: '专家评审第一版仅支持全额退款' })
        }

        if (!order.productRef) return res.status(409).json({ error: '订单未绑定专家评审申请' })
        const expertVote = await prisma.expertVoteRequest.findFirst({
          where: { requestNo: order.productRef, orderNo: order.orderNo },
          select: { requestNo: true, status: true },
        })
        if (!expertVote) return res.status(409).json({ error: '订单未绑定专家评审申请' })
        if (!isExpertVoteRefundableStatus(expertVote.status)) {
          return res.status(409).json({ error: `当前专家评审状态 ${expertVote.status} 不允许退款` })
        }
      }

      // 管理员默认全额退款
      const refundCents = order.amount
      const refundResult = await executeRefund(order, finalReason, refundCents, (req as AuthRequest).userId || 'admin')

      if (!refundResult.ok) {
        return res.status(502).json({ error: refundResult.error })
      }
      if ((refundResult as any).expertVoteCasFailed) {
        return res.status(500).json({
          error: '退款已发起但状态联动失败，请联系工程处理',
          refundId: refundResult.refundId,
          requestNo: (refundResult as any).requestNo,
        })
      }

      console.log(`[refund-admin] 订单 ${order.orderNo} 全额退款成功 — refundId: ${refundResult.refundId}`)
      res.json({
        ok: true,
        orderNo: order.orderNo,
        status: 'REFUNDED',
        refundId: refundResult.refundId,
        refundCents: refundResult.refundCents,
        mock: refundResult.mock,
      })
    } catch (e: any) {
      console.error('[refund] 退款异常:', e.message)
      res.status(500).json({ error: '退款操作失败，请稍后重试' })
    }
  })

  /** 用户端：申请退款（80%退款，7天窗口） */
  // 用户退款通道已关闭（2026-04-10 法务审核：一经开通不予退款）
  // 保留路由以防旧客户端调用，统一返回 403
  app.post('/api/app/orders/:orderNo/refund', requireAuth, async (req: AuthRequest, res) => {
    console.log(`[refund-user] 退款通道已关闭，拒绝 ${getRouteParam(req.params.orderNo)}`)
    return res.status(403).json({ error: '退款通道已关闭，如有需要请联系客服：biaozhunxiaozhi@tbzy.org.cn' })
  })

  /** 管理后台：首页统计（含待审核数） */
  app.get('/api/admin/stats', requireAdmin, async (_req: AuthRequest, res) => {
    const [users, orders, paidOrders, pendingVerifyOrders, tasks, pendingTasks, bookings, invoices, pendingInvoices] = await Promise.all([
      prisma.appUser.count(),
      prisma.appOrder.count(),
      prisma.appOrder.count({ where: { status: 'PAID' } }),
      prisma.appOrder.count({ where: { status: 'PENDING_VERIFY' } }),
      prisma.compareTask.count(),
      prisma.compareTask.count({ where: { status: 'PENDING' } }),
      prisma.serviceBooking.count(),
      prisma.invoiceRequest.count(),
      prisma.invoiceRequest.count({ where: { status: 'PENDING' } }),
    ])
    res.json({ users, orders, paidOrders, pendingVerifyOrders, compareTasks: tasks, pendingTasks, bookings, invoices, pendingInvoices })
  })

  /** 管理后台：系统设置（读取） */
  app.get('/api/admin/settings', requireAdmin, async (_req: AuthRequest, res) => {
    try {
      const settings = await prisma.systemSetting.findMany()
      const map: Record<string, string> = {}
      settings.forEach((s: any) => { map[s.key] = s.value })
      res.json(map)
    } catch {
      // 表可能不存在，返回默认值
      res.json({
        siteName: '标准小智',
        contactPhone: '',
        contactEmail: '',
        announcement: '',
        membershipEnabled: 'true',
        compareEnabled: 'true',
      })
    }
  })

  /** 管理后台：系统设置（保存） */
  app.post('/api/admin/settings', requireAdmin, async (req: AuthRequest, res) => {
    try {
      const entries = Object.entries(req.body || {})
      for (const [key, value] of entries) {
        await prisma.systemSetting.upsert({
          where: { key },
          update: { value: String(value) },
          create: { key, value: String(value) }
        })
      }
      res.json({ ok: true })
    } catch (e: any) {
      res.status(500).json({ error: '系统设置保存失败：' + e.message })
    }
  })

  // ─── 管理后台：内容管理（公告） ───────────────────────────────
  const ANNOUNCEMENTS_KEY = 'announcements_list'

  /** 读取公告列表 */
  app.get('/api/admin/announcements', requirePermission('admin.announcements.manage'), async (_req: AuthRequest, res) => {
    try {
      const row = await prisma.systemSetting.findUnique({ where: { key: ANNOUNCEMENTS_KEY } })
      const list = row ? JSON.parse(row.value) : []
      res.json({ items: list })
    } catch { res.json({ items: [] }) }
  })

  /** 新增公告 */
  app.post('/api/admin/announcements', requirePermission('admin.announcements.manage'), async (req: AuthRequest, res) => {
    const { title, content } = req.body
    if (!title?.trim()) return res.status(400).json({ error: '标题不能为空' })
    const row = await prisma.systemSetting.findUnique({ where: { key: ANNOUNCEMENTS_KEY } })
    const list = row ? JSON.parse(row.value) : []
    const newItem = { id: `ann-${Date.now()}`, title: title.trim(), content: (content || '').trim(), date: new Date().toISOString().slice(0, 10), createdAt: new Date().toISOString() }
    list.unshift(newItem)
    await prisma.systemSetting.upsert({ where: { key: ANNOUNCEMENTS_KEY }, update: { value: JSON.stringify(list) }, create: { key: ANNOUNCEMENTS_KEY, value: JSON.stringify(list) } })
    res.json(newItem)
  })

  /** 编辑公告 */
  app.put('/api/admin/announcements/:id', requirePermission('admin.announcements.manage'), async (req: AuthRequest, res) => {
    const { id } = req.params
    const { title, content } = req.body
    if (!title?.trim()) return res.status(400).json({ error: '标题不能为空' })
    const row = await prisma.systemSetting.findUnique({ where: { key: ANNOUNCEMENTS_KEY } })
    const list: any[] = row ? JSON.parse(row.value) : []
    const idx = list.findIndex((a) => a.id === id)
    if (idx < 0) return res.status(404).json({ error: '公告不存在' })
    list[idx] = { ...list[idx], title: title.trim(), content: (content || '').trim() }
    await prisma.systemSetting.upsert({ where: { key: ANNOUNCEMENTS_KEY }, update: { value: JSON.stringify(list) }, create: { key: ANNOUNCEMENTS_KEY, value: JSON.stringify(list) } })
    res.json(list[idx])
  })

  /** 删除公告 */
  app.delete('/api/admin/announcements/:id', requirePermission('admin.announcements.manage'), async (req: AuthRequest, res) => {
    const { id } = req.params
    const row = await prisma.systemSetting.findUnique({ where: { key: ANNOUNCEMENTS_KEY } })
    const list: any[] = row ? JSON.parse(row.value) : []
    const filtered = list.filter((a) => a.id !== id)
    await prisma.systemSetting.upsert({ where: { key: ANNOUNCEMENTS_KEY }, update: { value: JSON.stringify(filtered) }, create: { key: ANNOUNCEMENTS_KEY, value: JSON.stringify(filtered) } })
    res.json({ ok: true })
  })

  // ============================================================
  // CMS 展示内容管理 (ContentConfig)
  // ============================================================

  /** 公开接口：返回所有 enabled=true 的条目（前端 fallback 用） */
  app.get('/api/content-config', async (req: Request, res: Response) => {
    try {
      const { group } = req.query as Record<string, string>
      let items: any[]
      if (group) {
        items = await getContentConfigGroup(group)
      } else {
        items = await getAllContentConfigs()
        items = items.filter((i: any) => i.enabled)
      }
      res.json({ items })
    } catch (err: any) {
      console.error('[content-config] GET error:', err)
      res.status(500).json({ error: '服务器内部错误' })
    }
  })

  /** Admin 接口：取全部条目 */
  app.get('/api/admin/content-config', requirePermission('admin.content.manage'), async (_req: AuthRequest, res: Response) => {
    try {
      const items = await getAllContentConfigs()
      res.json({ items })
    } catch (err: any) {
      console.error('[content-config] admin GET error:', err)
      res.status(500).json({ error: '服务器内部错误' })
    }
  })

  /** Admin 接口：更新单条 */
  app.put('/api/admin/content-config/:key', requirePermission('admin.content.manage'), async (req: AuthRequest, res: Response) => {
    try {
      const key = req.params.key as string
      const existing = await getContentConfig(key)
      if (!existing) return res.status(404).json({ error: '条目不存在' })

      const { content, title, subtitle, description, enabled, sortOrder, remark } = req.body
      const patch: Record<string, any> = {}
      if (content !== undefined) patch.content = String(content)
      if (title !== undefined) patch.title = String(title)
      if (subtitle !== undefined) patch.subtitle = String(subtitle)
      if (description !== undefined) patch.description = String(description)
      if (enabled !== undefined) patch.enabled = Boolean(enabled)
      if (sortOrder !== undefined) patch.sortOrder = Number(sortOrder)
      if (remark !== undefined) patch.remark = String(remark)

      const updated = await updateContentConfig(key as string, patch)
      res.json({ ok: true, item: updated })
    } catch (err: any) {
      console.error('[content-config] admin PUT error:', err)
      res.status(500).json({ error: '服务器内部错误' })
    }
  })

  // ============================================================
  // 标准化体系建设文档归集平台 — 免登录比对接口
  // API Key 鉴权，不经过用户登录体系
  // ============================================================

  // CORS 由 main.ts 的 `app.use('/api/guiji', cors({ origin: '*' }))` 统一处理
  // /api/app/guiji/* 是前端代理路径：复用同一组 handler，但不要求前端持 X-Api-Key，
  // 改为校验服务端 .env 是否配置了 BXZ_GUIJI_API_KEY 作为"归集服务启用开关"。
  const GUIJI_API_KEY = process.env.BXZ_GUIJI_API_KEY || ''

  function requireGuijiKey(req: Request, res: Response, next: NextFunction) {
    const currentKey = process.env.BXZ_GUIJI_API_KEY || ''
    const key = req.headers['x-api-key'] as string
    if (!currentKey || !key) {
      return res.status(401).json({ error: '缺少 API Key' })
    }
    if (key.length !== currentKey.length ||
        !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(currentKey))) {
      return res.status(403).json({ error: 'API Key 无效' })
    }
    next()
  }

  function requireGuijiServerConfigured(_req: Request, res: Response, next: NextFunction) {
    if (!process.env.BXZ_GUIJI_API_KEY) {
      return res.status(503).json({ error: '归集服务未启用' })
    }
    next()
  }

  const guijiCreateTaskHandler = async (req: any, res: any) => {
    try {
      const files = req.files as Record<string, Express.Multer.File[]>
      const fileA = files?.file?.[0]
      if (!fileA) return res.status(400).json({ error: '请上传文档' })

      const compareMode = req.body.compareMode === 'ONE_TO_ONE' ? 'ONE_TO_ONE' : 'library'
      const fileB = files?.fileB?.[0]

      if (compareMode === 'ONE_TO_ONE' && !fileB) {
        return res.status(400).json({ error: '1对1比对必须上传文档B' })
      }

      const documentName = req.body.documentName || fileA.originalname
      const fileType = req.body.fileType || fileA.originalname.split('.').pop() || 'docx'
      const taskNo = makeBusinessNo('CMP')

      await prisma.compareTask.create({
        data: {
          taskNo,
          userId: 'guiji-anonymous',
          documentName,
          compareMode,
          selectedStandardIds: '[]',
          status: 'PENDING',
          priority: compareMode === 'ONE_TO_ONE' ? 2 : 1,
          fileType,
          intakeJson: JSON.stringify({
            fileAPath: fileA.path,
            fileBPath: fileB?.path || null,
            fileAName: fileA.originalname,
            fileBName: fileB?.originalname || null,
          }),
        },
      })

      res.json({ taskNo, status: 'PENDING', message: '比对任务已提交' })
    } catch (err: any) {
      console.error('[guiji] create task error:', err)
      res.status(500).json({ error: '服务器内部错误' })
    }
  }

  const guijiGetTaskHandler = async (req: any, res: any) => {
    try {
      const { taskNo } = req.params
      const task = await prisma.compareTask.findUnique({ where: { taskNo } })
      if (!task || task.userId !== 'guiji-anonymous') {
        return res.status(404).json({ error: '任务不存在' })
      }

      res.set('Cache-Control', 'no-store')
      res.json({
        taskNo: task.taskNo,
        documentName: task.documentName,
        compareMode: task.compareMode,
        status: task.status,
        errorMessage: task.errorMessage,
        createdAt: task.createdAt,
        finishedAt: task.finishedAt,
        report: task.status === 'COMPLETED' && task.reportJson
          ? JSON.parse(task.reportJson as string)
          : null,
      })
    } catch (err: any) {
      console.error('[guiji] get task error:', err)
      res.status(500).json({ error: '服务器内部错误' })
    }
  }

  const guijiGetTaskStatusHandler = async (req: any, res: any) => {
    try {
      const { taskNo } = req.params
      const task = await prisma.compareTask.findUnique({
        where: { taskNo },
        select: { taskNo: true, status: true, errorMessage: true, finishedAt: true, userId: true },
      })
      if (!task || task.userId !== 'guiji-anonymous') {
        return res.status(404).json({ error: '任务不存在' })
      }
      res.set('Cache-Control', 'no-store')
      res.json({
        taskNo: task.taskNo,
        status: task.status,
        errorMessage: task.errorMessage,
        finishedAt: task.finishedAt,
      })
    } catch (err: any) {
      res.status(500).json({ error: '服务器内部错误' })
    }
  }

  // 原 IP 直连入口：对接外部归集机构，仍要求 X-Api-Key 鉴权
  app.post(
    '/api/guiji/compare/tasks',
    ipRateLimit(3, 60_000),
    requireGuijiKey,
    upload.fields([
      { name: 'file', maxCount: 1 },
      { name: 'fileB', maxCount: 1 },
    ]),
    guijiCreateTaskHandler,
  )

  app.get(
    '/api/guiji/compare/tasks/:taskNo',
    requireGuijiKey,
    guijiGetTaskHandler,
  )

  app.get(
    '/api/guiji/compare/tasks/:taskNo/status',
    requireGuijiKey,
    guijiGetTaskStatusHandler,
  )

  // 8082 同源前端代理入口：前端不持 key，服务端 .env 配置 BXZ_GUIJI_API_KEY 即放行
  app.post(
    '/api/app/guiji/compare/tasks',
    ipRateLimit(3, 60_000),
    requireGuijiServerConfigured,
    upload.fields([
      { name: 'file', maxCount: 1 },
      { name: 'fileB', maxCount: 1 },
    ]),
    guijiCreateTaskHandler,
  )

  app.get(
    '/api/app/guiji/compare/tasks/:taskNo',
    requireGuijiServerConfigured,
    guijiGetTaskHandler,
  )

  app.get(
    '/api/app/guiji/compare/tasks/:taskNo/status',
    requireGuijiServerConfigured,
    guijiGetTaskStatusHandler,
  )

  // 引用一次防止 ESM tree-shaking / TS 报"未使用"（GUIJI_API_KEY 仅作模块加载时探针）
  void GUIJI_API_KEY

  // ─── 启动任务队列 Worker ──────────────────────────────────
  // 并发度 2 跟 dedup uvicorn workers=2 对齐（commit 0a8aa42）。
  // 原子领取 SQL 由 taskWorker.processNextTask 负责，多 slot 不会重复消费。
  // 测试环境跳过：worker 每 3s 抢 SQLite 写锁会让 CI vitest 批量测试出现
  // "database is locked"（GitHub runner 磁盘慢时尤其明显）。
  if (process.env.NODE_ENV !== 'test') {
    import('./taskWorker').then(({ initWorker, startWorker }) => {
      initWorker({ callDedupService, buildRealCompareReport, buildCompareReport, standards })
      startWorker(3000, 2)
    })
  }
}
