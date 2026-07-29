/**
 * 主入口 — 路由、中间件、数据导入
 * @date   2026-03-21
 *
 * ════════════════════════════════════════════════════════
 * 路由分区说明
 * ════════════════════════════════════════════════════════
 *
 * 【主业务路由】由 registerAppRoutes / registerGiftRoutes / registerVerificationRoutes 注册
 *   → 标准小智用户端 + 管理后台全部业务逻辑（会员/订单/发票/比对/公告等）
 *   → 见 appRoutes.ts / giftRoutes.ts / verificationRoutes.ts
 *
 * 【历史兼容路由 / 产品评测路由】直接写在本文件（app.post / app.get …）
 *   → 早期产品评测、数据导入、规则评估、采集任务等
 *   → 不属于标准小智主业务，暂保留兼容，后续可按需迁移或清理
 *   → 主要包括：/api/assess、/api/ingest、/api/admin/ingestion-jobs、
 *               /api/admin/audits、/api/products、/api/scenes 等
 *
 * 【遗留占位】部分路由仅作历史兼容，无活跃调用，标记见各段注释
 * ════════════════════════════════════════════════════════
 */
import express from 'express'
import 'express-async-errors' // patch express 4：捕获 async handler 的 throw → 全局 error handler（getEnterpriseId 403 依赖此）
import cors from 'cors'
import { z } from 'zod'
import { healthPayload } from './version'
import { checkPrismaSchemaHealth } from './schemaHealth'
import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'
import fs from 'fs/promises'
import path from 'path'
import { parse as csvParse } from 'csv-parse/sync'
import xlsx from 'xlsx'
import { assessByRules } from './rules'
import { prisma, initDatabase } from './db'
import { ingestStandard, parseSnippet } from './ingest'
import { ensureAppSeed, registerAppRoutes } from './appRoutes'
import { registerVerificationRoutes } from './verificationRoutes'
import { registerGiftRoutes } from './giftRoutes'
import { registerSalesRoutes } from './salesRoutes'
import { registerSalesV2Routes } from './salesV2Routes'
import { registerCouponRoutes } from './couponRoutes'
import { registerInternalRoutes } from './internal/routes.js'
import { registerStaffRoutes } from './staffRoutes'
import { registerRoleRoutes } from './roleRoutes'
import { registerExpertVoteRoutes } from './expertVoteRoutes'
import { registerEnterpriseRoutes } from './enterpriseRoutes'
import { registerWechatRoutes } from './wechatRoutes'
import { registerStandardExecutionRoutes } from './standard-execution/sourceRoutes'
import { registerEnterpriseMytasksRoutes } from './standard-execution/enterpriseMytasksRoutes'
import { registerOpenApiRoutes } from './openApiRoutes'
import { requireAdmin, optionalAuth } from './auth'
import { preloadPlatformCerts } from './wechat-pay'
import { startOrderSweeper } from './orderSweeper'
import { startUploadsSweeper } from './uploadsSweeper'
import { startMembershipExpirySweeper } from './membershipSweeper'
import chatRouter from './routes/chat.js'
import seChatRouter from './routes/seChat.js'
import { scheduleLabelSync } from './jobs/labelSync.job.js'
import { scheduleStandardExecutionPlanRuns } from './jobs/sePlanRun.job.js'
import { startVectorIndexWorker } from './vectorIndexWorker.js'

import { alertCritical } from './alert.js'
import { logger } from './logger.js'

process.on('unhandledRejection', (reason) => {
  logger.fatal({ module: 'process', err: reason }, 'unhandledRejection')
  alertCritical('process', 'unhandledRejection', { reason: String((reason as any)?.message ?? reason).slice(0, 300) })
})
process.on('uncaughtException', (err) => {
  logger.fatal({ module: 'process', err }, 'uncaughtException')
  alertCritical('process', 'uncaughtException', { message: err?.message, stack: err?.stack?.slice(0, 500) })
})

const app = express()
app.set('trust proxy', 1) // nginx 反代，信任第一层代理
// 归集平台路由走独立 CORS（API Key 鉴权，不依赖 cookie，允许任意 origin）
app.use('/api/guiji', cors({ origin: '*', credentials: false }))
app.use(cors({
  origin: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : process.env.NODE_ENV === 'production'
      ? [
          'https://biaozhunxiaozhi.com',
          'https://www.biaozhunxiaozhi.com',
          'https://api.biaozhunxiaozhi.com',
        ]
      : [
          'https://biaozhunxiaozhi.com',
          'https://www.biaozhunxiaozhi.com',
          'https://api.biaozhunxiaozhi.com',
          'http://localhost:5173',
        ],
  credentials: true,
}))
app.use(express.json({
  limit: '1mb',
  // 保留 rawBody 供微信支付回调验签使用
  verify: (req: any, _res, buf) => { req.rawBody = buf },
}))

// 安全响应头
app.disable('x-powered-by')
app.use((_req, resH, nextH) => {
  resH.setHeader('X-Content-Type-Options', 'nosniff')
  resH.setHeader('X-Frame-Options', 'DENY')
  nextH()
})

const uploadDir = path.resolve(process.cwd(), 'uploads')

async function ensureUploadsDir() {
  try {
    await fs.mkdir(uploadDir, { recursive: true })
  } catch {
    // ignore
  }
}

async function parseCsvFile(filePath: string) {
  const content = await fs.readFile(filePath, 'utf-8')
  return csvParse(content, { columns: true, skip_empty_lines: true, trim: true })
}

function parseExcelFile(filePath: string) {
  const workbook = xlsx.readFile(filePath)
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  return xlsx.utils.sheet_to_json(sheet, { defval: '' })
}

function pickValue(row: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
      return row[key]
    }
  }
  return undefined
}

function parseList(value?: string) {
  if (!value) return []
  return String(value)
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function toNumber(value: any) {
  if (value === undefined || value === null || value === '') return undefined
  const num = Number(value)
  return Number.isNaN(num) ? undefined : num
}

function toDate(value: any) {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

async function parseImportRecords(body: any) {
  const format = String(body.format || 'json').toLowerCase()
  if (format === 'json') {
    if (Array.isArray(body.records)) return body.records
    if (body.text) return JSON.parse(body.text)
    if (body.contentBase64) {
      const text = Buffer.from(body.contentBase64, 'base64').toString('utf-8')
      return JSON.parse(text)
    }
    throw new Error('missing json records/text/contentBase64')
  }
  if (format === 'csv') {
    const text = body.text
      ? String(body.text)
      : body.contentBase64
        ? Buffer.from(body.contentBase64, 'base64').toString('utf-8')
        : null
    if (!text) throw new Error('missing csv text/contentBase64')
    return csvParse(text, { columns: true, skip_empty_lines: true, trim: true })
  }
  if (format === 'excel') {
    if (!body.contentBase64) throw new Error('missing excel contentBase64')
    const buffer = Buffer.from(body.contentBase64, 'base64')
    const workbook = xlsx.read(buffer, { type: 'buffer' })
    const sheetName = body.sheetName || workbook.SheetNames[0]
    const sheet = workbook.Sheets[sheetName]
    return xlsx.utils.sheet_to_json(sheet, { defval: '' })
  }
  throw new Error(`unsupported format: ${format}`)
}

function evaluateLimit(
  value: number,
  limitType?: string | null,
  threshold?: number | null,
  min?: number | null,
  max?: number | null,
  comparator?: string | null
) {
  if (limitType === 'MIN') return value >= (min ?? 0)
  if (limitType === 'MAX') return value <= (max ?? 0)
  if (limitType === 'RANGE') return value >= (min ?? 0) && value <= (max ?? 0)
  if (limitType === 'EXACT') return value === (threshold ?? 0)

  switch (comparator) {
    case '>':
      return value > (threshold ?? 0)
    case '>=':
      return value >= (threshold ?? 0)
    case '<':
      return value < (threshold ?? 0)
    case '<=':
      return value <= (threshold ?? 0)
    case '=':
    case '==':
      return value === (threshold ?? 0)
    case '!=':
      return value !== (threshold ?? 0)
    default:
      return false
  }
}

function gradeScore(score: number) {
  if (score >= 90) return 'A+'
  if (score >= 80) return 'A'
  if (score >= 70) return 'B'
  if (score >= 60) return 'C'
  return '风险'
}

function strictnessScore(limitCount: number, safetyCount: number) {
  const base = Math.min(80, limitCount * 4)
  return Math.min(100, base + safetyCount * 5)
}

function normalizeUnit(value: number, fromUnit?: string | null, toUnit?: string | null) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return value
  const map: Record<string, Record<string, number>> = {
    'mg/kg': { 'g/kg': 0.001 },
    'g/kg': { 'mg/kg': 1000 },
    'mg/L': { 'g/L': 0.001 },
    'g/L': { 'mg/L': 1000 },
    'mg/100g': { 'g/100g': 0.001 },
    'g/100g': { 'mg/100g': 1000 }
  }
  const factor = map[fromUnit]?.[toUnit]
  if (!factor) return value
  return value * factor
}

const defaultWeights = {
  safety: 0.4,
  quality: 0.3,
  reliability: 0.2,
  transparency: 0.1
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value))
}

function average(values: number[]) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function getStandardLine(limit: {
  limitType?: string | null
  comparator?: string | null
  threshold?: number | null
  thresholdMin?: number | null
  thresholdMax?: number | null
}) {
  if (limit.limitType === 'MIN' || limit.comparator === '>=' || limit.comparator === '>') {
    return { line: limit.thresholdMin ?? limit.threshold ?? null, direction: 'min' as const }
  }
  if (limit.limitType === 'MAX' || limit.comparator === '<=' || limit.comparator === '<') {
    return { line: limit.thresholdMax ?? limit.threshold ?? null, direction: 'max' as const }
  }
  if (limit.limitType === 'RANGE') {
    return { line: limit.thresholdMin ?? limit.thresholdMax ?? limit.threshold ?? null, direction: 'range' as const }
  }
  if (limit.limitType === 'EXACT') {
    return { line: limit.threshold ?? null, direction: 'exact' as const }
  }
  return { line: limit.threshold ?? limit.thresholdMin ?? limit.thresholdMax ?? null, direction: 'min' as const }
}

function calcMetricScore(params: {
  value: number | null
  line: number | null
  industryAvg: number | null
  direction: 'min' | 'max' | 'range' | 'exact'
  passed: boolean | null
}) {
  if (params.value === null || params.value === undefined) {
    return { score: 0, industryDiffPercent: 0, standardDiffPercent: 0 }
  }

  const { value, line, industryAvg, direction, passed } = params
  const industryDiffPercent = industryAvg ? Math.round(((value - industryAvg) / industryAvg) * 100) : 0
  let standardDiffPercent = 0
  if (line) {
    standardDiffPercent = Math.round(((value - line) / line) * 100)
  }

  if (!industryAvg || industryAvg === line || line === null) {
    const base = passed ? 70 : 40
    return { score: base, industryDiffPercent, standardDiffPercent }
  }

  let ratio = 0
  if (direction === 'min') {
    ratio = (value - line) / (industryAvg - line)
  } else if (direction === 'max') {
    ratio = (line - value) / (line - industryAvg)
  } else if (direction === 'range') {
    ratio = passed ? 0.8 : -0.2
  } else {
    ratio = passed ? 0.9 : -0.1
  }

  const score = clamp(70 + ratio * 30, 0, 100)
  return { score, industryDiffPercent, standardDiffPercent }
}

function getRiskWarning(value: number | null, line: number | null, direction: 'min' | 'max' | 'range' | 'exact') {
  if (value === null || line === null) return null
  if (direction === 'min' && value < line * 1.05) return '接近国家标准下限，建议关注'
  if (direction === 'max' && value > line * 0.95) return '接近国家标准上限，建议关注'
  return null
}

function calcReliabilityScore(reports: Array<{ date: Date | null; trustLevel: string | null; fileUrl: string | null }>) {
  if (reports.length <= 1) {
    const report = reports[0]
    let score = 60
    if (report?.date) {
      const days = (Date.now() - report.date.getTime()) / (1000 * 60 * 60 * 24)
      if (days <= 90) score += 15
      else if (days <= 180) score += 8
    }
    if (report?.trustLevel && ['third-party', 'authority'].includes(report.trustLevel)) score += 10
    if (report?.fileUrl) score += 8
    return clamp(score, 40, 95)
  }

  return 78
}

function calcTransparencyScore(report: { trustLevel: string | null; fileUrl: string | null } | null, standardHasContent: boolean) {
  let score = 40
  if (report) score += 20
  if (report?.trustLevel && ['third-party', 'authority'].includes(report.trustLevel)) score += 20
  if (report?.fileUrl) score += 10
  if (standardHasContent) score += 10
  return clamp(score, 0, 100)
}

const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: '标准小智 API',
      version: '1.0.0',
      description: '标准小智后端接口文档'
    },
    servers: [{ url: 'http://localhost:3000' }],
    paths: {
      '/health': {
        get: {
          summary: '健康检查',
          responses: {
            200: { description: 'OK' }
          }
        }
      },
      '/health/schema': {
        get: {
          summary: '数据库 schema drift 健康检查',
          responses: {
            200: { description: 'Schema OK' },
            503: { description: 'Schema drift detected' }
          }
        }
      },
      '/api/scan/assess': {
        post: {
          summary: '识别评分',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    barcode: { type: 'string' },
                    imageBase64: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: '评分结果' }
          }
        }
      },
      '/api/admin/standards': {
        get: { summary: '标准列表', responses: { 200: { description: 'OK' } } },
        post: {
          summary: '新增标准',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 200: { description: 'OK' } }
        }
      },
      '/api/admin/clauses': {
        get: { summary: '条款列表', responses: { 200: { description: 'OK' } } },
        post: {
          summary: '新增条款',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 200: { description: 'OK' } }
        }
      },
      '/api/admin/rulesets': {
        get: { summary: '规则集列表', responses: { 200: { description: 'OK' } } },
        post: {
          summary: '新增规则集',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 200: { description: 'OK' } }
        }
      },
      '/api/admin/mappings': {
        get: { summary: '识别映射列表', responses: { 200: { description: 'OK' } } },
        post: {
          summary: '新增识别映射',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 200: { description: 'OK' } }
        }
      },
      '/api/admin/audits': {
        get: { summary: '采集审核列表', responses: { 200: { description: 'OK' } } }
      },
      '/api/admin/production-data/all': {
        get: { summary: '检测数据汇总', responses: { 200: { description: 'OK' } } }
      },
      '/api/admin/production-data': {
        post: {
          summary: '新增检测数据',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 200: { description: 'OK' } }
        }
      },
      '/api/admin/imports': {
        post: {
          summary: '新增采集任务',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 200: { description: 'OK' } }
        }
      },
      '/api/admin/crawl': {
        post: {
          summary: '抓取任务',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 200: { description: 'OK' } }
        }
      }
    }
  },
  apis: []
})

// Swagger 文档仅在非生产环境暴露
if (process.env.NODE_ENV !== 'production') {
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, { explorer: true }))
}

// ── 【主业务路由】标准小智核心业务 ───────────────────────────────
registerAppRoutes(app)
registerVerificationRoutes(app)
registerGiftRoutes(app)
registerSalesRoutes(app)
registerSalesV2Routes(app)
registerCouponRoutes(app)
registerInternalRoutes(app)
registerStaffRoutes(app)
registerRoleRoutes(app)
registerExpertVoteRoutes(app)
registerEnterpriseRoutes(app)
registerWechatRoutes(app)
registerStandardExecutionRoutes(app)
registerEnterpriseMytasksRoutes(app)
registerOpenApiRoutes(app)

// 静态服务：销售主页头像/二维码（仅 uploads/sales/ 子目录对外可访问，不暴露整个 uploads）
app.use(
  '/uploads/sales',
  express.static(path.resolve(process.cwd(), 'uploads', 'sales'), { maxAge: '1h', index: false, dotfiles: 'deny' }),
)
// 静态服务：standard-execution 员工提交附件（一期直链；二期可加鉴权下载端点）
app.use(
  '/uploads/standard-execution',
  express.static(path.resolve(process.cwd(), 'uploads', 'standard-execution'), { maxAge: '1h', index: false, dotfiles: 'deny' }),
)
// 静态服务：standard-execution 标准来源 PDF / Word 上传文件
app.use(
  '/uploads/standard-sources',
  express.static(path.resolve(process.cwd(), 'uploads', 'standard-sources'), { maxAge: '1h', index: false, dotfiles: 'deny' }),
)
app.use('/api/app/chat', chatRouter)
app.use('/api/app/se-chat', seChatRouter)

app.get('/health', (_req, res) => {
  // no-store：deploy 脚本会在 canary 阶段多次调用，不能让 nginx/浏览器缓存上一次结果
  res.set('Cache-Control', 'no-store')
  res.json(healthPayload())
})

app.get('/health/schema', async (_req, res) => {
  res.set('Cache-Control', 'no-store')
  const schema = await checkPrismaSchemaHealth(prisma)
  res.status(schema.ok ? 200 : 503).json({
    ...healthPayload(),
    ok: schema.ok,
    schema,
  })
})

// ── 【历史兼容 / 产品评测路由】以下路由为早期产品评测逻辑 ──────────
// 不属于标准小智主业务，暂保留兼容，无活跃调用时可按需清理

const assessSchema = z.object({
  barcode: z.string().optional(),
  imageBase64: z.string().optional()
})

app.post('/api/scan/assess', optionalAuth as any, async (req, res) => {
  const parsed = assessSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload' })
  }

  const result = await assessByRules(parsed.data)
  const inputType = parsed.data.barcode ? 'barcode' : parsed.data.imageBase64 ? 'image' : 'unknown'
  const inputValue = parsed.data.barcode ? parsed.data.barcode : undefined
  const mapping = parsed.data.barcode
    ? await prisma.productMapping.findFirst({ where: { value: parsed.data.barcode } })
    : null
  await prisma.assessment.create({
    data: {
      productId: mapping?.productId,
      inputType,
      inputValue,
      score: result.score,
      compliance: result.compliance,
      suggestion: result.suggestion,
      details: JSON.stringify(result.details)
    }
  })
  res.json(result)
})

app.get('/api/scan', async (req, res) => {
  const barcode = String(req.query.barcode || '').trim()
  if (!barcode) return res.status(400).json({ error: 'barcode is required' })

  const mapping = await prisma.productMapping.findFirst({
    where: { value: barcode },
    include: { product: true }
  })
  const product = mapping?.product || (await prisma.product.findFirst({ where: { barcode } }))
  if (!product) return res.status(404).json({ error: 'product not found' })

  const report = await prisma.report.findFirst({
    where: { productId: product.id },
    orderBy: { date: 'desc' }
  })

  res.json({
    product,
    report_exists: Boolean(report),
    next_step: report ? 'score' : 'profile',
    reportStatus: report ? 'HAS_REPORT' : 'NO_REPORT',
    next: report ? 'score' : 'profile'
  })
})

app.get('/api/score', async (req, res) => {
  const barcode = String(req.query.barcode || '').trim()
  if (!barcode) return res.status(400).json({ error: 'barcode is required' })

  const mapping = await prisma.productMapping.findFirst({
    where: { value: barcode },
    include: { product: true }
  })
  const product = mapping?.product || (await prisma.product.findFirst({ where: { barcode } }))
  if (!product) return res.status(404).json({ error: 'product not found' })

  const reports = await prisma.report.findMany({
    where: { productId: product.id },
    orderBy: { date: 'desc' },
    include: { measurements: true }
  })
  const report = reports[0]
  if (!report) return res.status(400).json({ error: 'no report found' })

  const standardCodes = mapping?.standardIds ? (JSON.parse(mapping.standardIds) as string[]) : []
  const standards = standardCodes.length
    ? await prisma.standard.findMany({ where: { code: { in: standardCodes } } })
    : []
  const standard = standards[0]
  if (!standard) return res.status(400).json({ error: 'no standard mapped' })

  const limits = await prisma.standardClause.findMany({
    where: { standardId: standard.id },
    include: { indicatorRef: true }
  })
  const indicatorMappings = await prisma.indicatorMapping.findMany()
  const indicators = await prisma.indicator.findMany({
    where: { name: { in: limits.map((limit) => limit.indicator) } }
  })
  const indicatorByName = new Map(indicators.map((indicator) => [indicator.name, indicator]))
  const baselines = product.categoryId
    ? await prisma.peerBaseline.findMany({ where: { categoryId: product.categoryId } })
    : []
  const baselineMap = new Map(baselines.map((baseline) => [baseline.indicatorId, baseline.avg ?? null]))
  const standardContent = await prisma.standardContent.findUnique({ where: { standardId: standard.id } })

  const metrics = limits.map((limit) => {
    const measurement = report.measurements.find((item) => {
      if (limit.indicatorId && item.indicatorId) return item.indicatorId === limit.indicatorId
      if (item.rawName === limit.indicator) return true
      const mappingHit = indicatorMappings.find(
        (map) => map.rawKey === item.rawName && map.indicatorId === limit.indicatorId
      )
      return Boolean(mappingHit)
    })

    let rawValue = measurement?.valueStd ?? measurement?.rawValue
    if (
      rawValue !== undefined &&
      rawValue !== null &&
      measurement?.rawUnit &&
      limit.unit &&
      measurement?.unitStd === undefined
    ) {
      rawValue = normalizeUnit(rawValue, measurement.rawUnit, limit.unit)
    }
    const ok =
      rawValue !== undefined && rawValue !== null
        ? evaluateLimit(
            rawValue,
            limit.limitType,
            limit.threshold,
            limit.thresholdMin,
            limit.thresholdMax,
            limit.comparator
          )
        : null

    const indicatorRef = limit.indicatorRef ?? indicatorByName.get(limit.indicator)
    const dimension = indicatorRef?.dimension ?? 'quality'
    const indicatorId = indicatorRef?.indicatorId ?? indicatorRef?.id ?? limit.indicator
    const baseline = indicatorRef ? baselineMap.get(indicatorRef.id) ?? null : null
    const { line, direction } = getStandardLine(limit)
    const scoreDetail = calcMetricScore({
      value: rawValue ?? null,
      line,
      industryAvg: baseline,
      direction,
      passed: ok
    })

    return {
      indicator_id: indicatorId,
      name: limit.indicator,
      dimension,
      value: rawValue ?? null,
      unit: measurement?.unitStd ?? limit.unit ?? measurement?.rawUnit ?? null,
      standard_limit: line,
      industry_avg: baseline,
      score: Math.round(scoreDetail.score),
      status: ok === null ? 'missing' : ok ? 'pass' : 'fail',
      industry_diff_percent: scoreDetail.industryDiffPercent,
      standard_diff_percent: scoreDetail.standardDiffPercent,
      risk_warning: getRiskWarning(rawValue ?? null, line, direction)
    }
  })

  const grouped: Record<string, number[]> = {
    safety: [],
    quality: [],
    reliability: [],
    transparency: []
  }
  metrics.forEach((metric) => {
    if (!grouped[metric.dimension]) grouped[metric.dimension] = []
    grouped[metric.dimension].push(metric.score)
  })

  const safetyScores = grouped.safety
  const safetyFail = metrics.some((metric) => metric.dimension === 'safety' && metric.status === 'fail')
  const safetyScore = safetyScores.length
    ? safetyFail
      ? clamp(Math.min(...safetyScores) * 0.5, 0, 100)
      : clamp(average(safetyScores), 0, 100)
    : 70

  const qualityScore = grouped.quality.length ? clamp(average(grouped.quality), 0, 100) : 70
  const reliabilityScore = grouped.reliability.length
    ? clamp(average(grouped.reliability), 0, 100)
    : calcReliabilityScore(reports)
  const transparencyScore = grouped.transparency.length
    ? clamp(average(grouped.transparency), 0, 100)
    : calcTransparencyScore(report, Boolean(standardContent))

  const ruleset = await prisma.ruleSet.findFirst({
    where: { enabled: true },
    orderBy: { createdAt: 'desc' }
  })
  let weights = defaultWeights
  if (ruleset?.weights) {
    try {
      const parsed = JSON.parse(ruleset.weights) as Record<string, number>
      weights = {
        safety: parsed.safety ?? parsed.安全标准 ?? defaultWeights.safety,
        quality: parsed.质量标准 ?? parsed.quality ?? defaultWeights.quality,
        reliability: parsed.reliability ?? defaultWeights.reliability,
        transparency: parsed.transparency ?? defaultWeights.transparency
      }
    } catch {
      weights = defaultWeights
    }
  }

  const totalScore = Math.round(
    safetyScore * weights.safety +
      qualityScore * weights.quality +
      reliabilityScore * weights.reliability +
      transparencyScore * weights.transparency
  )
  const grade = gradeScore(totalScore)

  const categoryTotal = product.categoryId
    ? await prisma.product.count({ where: { categoryId: product.categoryId } })
    : await prisma.product.count()
  const percentile = clamp(Math.round((totalScore - 50) * 2), 1, 99)
  const rank = Math.max(1, Math.round(((100 - percentile) / 100) * categoryTotal))

  const suggestionType = totalScore >= 85 ? 'success' : totalScore >= 70 ? 'success' : totalScore >= 60 ? 'warning' : 'error'
  const suggestion = totalScore >= 85
    ? '该产品各项指标优于国家标准，品质优秀，推荐购买。'
    : totalScore >= 70
      ? '该产品整体优于国家标准，品质良好，可以放心购买。'
      : totalScore >= 60
        ? '该产品接近国家标准下限，建议谨慎选择。'
        : '该产品存在明显风险指标，不建议购买。'

  const explain = {
    safety: safetyFail ? '存在安全指标未通过，安全维度被强惩罚。' : '所有安全指标均符合标准，无高风险项。',
    quality: qualityScore >= 80 ? '多数性能指标优于行业均值。' : '部分性能指标低于行业均值。',
    reliability: reports.length > 1 ? '多批次检测波动较小，可靠性较高。' : '缺少多批次数据，依据报告时效与来源可信度评分。',
    transparency: report.fileUrl ? '报告来源可信且可下载原始数据。' : '报告信息不完整，透明度偏低。'
  }

  await prisma.assessment.create({
    data: {
      productId: product.id,
      reportId: report.id,
      rulesetId: ruleset?.id,
      inputType: 'barcode',
      inputValue: barcode,
      score: totalScore,
      grade,
      percentile,
      compliance: totalScore >= 80 ? '合规' : totalScore >= 60 ? '部分合规' : '不合规',
      suggestion,
      details: JSON.stringify(metrics),
      explainJson: JSON.stringify(explain)
    }
  })

  res.json({
    product,
    reportId: report.id,
    standard: {
      code: standard.code,
      title: standard.title,
      type: standard.level
    },
    total_score: totalScore,
    grade,
    radar: {
      safety: Math.round(safetyScore),
      quality: Math.round(qualityScore),
      reliability: Math.round(reliabilityScore),
      transparency: Math.round(transparencyScore)
    },
    metrics,
    explain,
    ranking: {
      category_total: categoryTotal,
      rank,
      percentile,
      industry_avg_score: 72
    },
    suggestion,
    suggestion_type: suggestionType
  })
})

app.get('/api/profile', async (req, res) => {
  const barcode = String(req.query.barcode || '').trim()
  if (!barcode) return res.status(400).json({ error: 'barcode is required' })

  const mapping = await prisma.productMapping.findFirst({
    where: { value: barcode },
    include: { product: true }
  })
  const product = mapping?.product || (await prisma.product.findFirst({ where: { barcode } }))
  if (!product) return res.status(404).json({ error: 'product not found' })

  const standardCodes = mapping?.standardIds ? (JSON.parse(mapping.standardIds) as string[]) : []
  const standards = standardCodes.length
    ? await prisma.standard.findMany({ where: { code: { in: standardCodes } } })
    : []
  const standard = standards[0]
  if (!standard) return res.status(400).json({ error: 'no standard mapped' })

  const limits = await prisma.standardClause.findMany({ where: { standardId: standard.id } })
  const keyLimits = limits.slice(0, 10).map((limit) => ({
    indicator: limit.indicator,
    limitType: limit.limitType,
    threshold: limit.threshold,
    thresholdMin: limit.thresholdMin,
    thresholdMax: limit.thresholdMax,
    unit: limit.unit
  }))

  const safetyCount = limits.filter((limit) => limit.veto).length
  const strictness = strictnessScore(limits.length, safetyCount)

  res.json({
    product,
    standard: {
      code: standard.code,
      title: standard.title,
      level: standard.level,
      source: standard.source,
      version: standard.version,
      status: standard.status,
      publishDate: standard.publishDate,
      effectiveDate: standard.effectiveDate
    },
    profile: {
      keyLimits,
      strictnessScore: strictness
    },
    tips: '暂无检测报告，建议上传或补齐检测数据。'
  })
})

app.get('/api/admin/standards', requireAdmin as any, async (_req, res) => {
  const standards = await prisma.standard.findMany({ orderBy: { createdAt: 'desc' } })
  res.json(standards)
})

app.post('/api/admin/standards', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    title: z.string(),
    type: z.string().optional(),
    level: z.enum(['国家', '行业', '企业']),
    source: z.string(),
    version: z.string(),
    scope: z.string(),
    status: z.string().optional(),
    publishDate: z.string().optional(),
    effectiveDate: z.string().optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })
  const count = await prisma.standard.count()
  const standard = await prisma.standard.create({
    data: {
      code: `STD-${String(count + 1).padStart(3, '0')}`,
      title: parsed.data.title,
      type: parsed.data.type,
      level: parsed.data.level,
      source: parsed.data.source,
      version: parsed.data.version,
      scope: parsed.data.scope,
      status: parsed.data.status,
      publishDate: parsed.data.publishDate ? new Date(parsed.data.publishDate) : undefined,
      effectiveDate: parsed.data.effectiveDate ? new Date(parsed.data.effectiveDate) : undefined
    }
  })
  res.json(standard)
})

app.get('/api/admin/standards/:id/content', requireAdmin as any, async (req, res) => {
  const content = await prisma.standardContent.findUnique({
    where: { standardId: req.params.id }
  })
  if (!content) return res.json(null)
  res.json({
    ...content,
    header: content.header ? JSON.parse(content.header) : null,
    toc: content.toc ? JSON.parse(content.toc) : null,
    sections: content.sections ? JSON.parse(content.sections) : null,
    figures: content.figures ? JSON.parse(content.figures) : null,
    tables: content.tables ? JSON.parse(content.tables) : null,
    references: content.references ? JSON.parse(content.references) : null
  })
})

app.post('/api/admin/standards/:id/content', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    header: z.any().optional(),
    toc: z.any().optional(),
    preface: z.string().optional(),
    intro: z.string().optional(),
    sections: z.any().optional(),
    figures: z.any().optional(),
    tables: z.any().optional(),
    references: z.any().optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })

  const content = await prisma.standardContent.upsert({
    where: { standardId: req.params.id },
    update: {
      header: parsed.data.header ? JSON.stringify(parsed.data.header) : null,
      toc: parsed.data.toc ? JSON.stringify(parsed.data.toc) : null,
      preface: parsed.data.preface ?? null,
      intro: parsed.data.intro ?? null,
      sections: parsed.data.sections ? JSON.stringify(parsed.data.sections) : null,
      figures: parsed.data.figures ? JSON.stringify(parsed.data.figures) : null,
      tables: parsed.data.tables ? JSON.stringify(parsed.data.tables) : null,
      references: parsed.data.references ? JSON.stringify(parsed.data.references) : null
    },
    create: {
      standardId: req.params.id,
      header: parsed.data.header ? JSON.stringify(parsed.data.header) : null,
      toc: parsed.data.toc ? JSON.stringify(parsed.data.toc) : null,
      preface: parsed.data.preface ?? null,
      intro: parsed.data.intro ?? null,
      sections: parsed.data.sections ? JSON.stringify(parsed.data.sections) : null,
      figures: parsed.data.figures ? JSON.stringify(parsed.data.figures) : null,
      tables: parsed.data.tables ? JSON.stringify(parsed.data.tables) : null,
      references: parsed.data.references ? JSON.stringify(parsed.data.references) : null
    }
  })

  res.json({
    ...content,
    header: content.header ? JSON.parse(content.header) : null,
    toc: content.toc ? JSON.parse(content.toc) : null,
    sections: content.sections ? JSON.parse(content.sections) : null,
    figures: content.figures ? JSON.parse(content.figures) : null,
    tables: content.tables ? JSON.parse(content.tables) : null,
    references: content.references ? JSON.parse(content.references) : null
  })
})

app.get('/api/admin/clauses', requireAdmin as any, async (_req, res) => {
  const clauses = await prisma.standardClause.findMany({ orderBy: { id: 'desc' } })
  res.json(clauses)
})

app.post('/api/admin/clauses', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    standardId: z.string(),
    key: z.string(),
    requirement: z.string(),
    indicator: z.string(),
    comparator: z.enum(['>', '>=', '<', '<=', '=', '==', '!=']),
    threshold: z.number(),
    limitType: z.enum(['MIN', 'MAX', 'RANGE', 'EXACT']).optional(),
    thresholdMin: z.number().optional(),
    thresholdMax: z.number().optional(),
    unit: z.string().optional(),
    weight: z.number().min(0).max(1),
    scopeText: z.string().optional(),
    veto: z.boolean().optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })
  const indicatorRef = await prisma.indicator.findFirst({
    where: { name: parsed.data.indicator }
  })
  const clause = await prisma.standardClause.create({
    data: {
      standardId: parsed.data.standardId,
      key: parsed.data.key,
      requirement: parsed.data.requirement,
      indicator: parsed.data.indicator,
      indicatorId: indicatorRef?.id,
      comparator: parsed.data.comparator,
      threshold: parsed.data.threshold,
      limitType: parsed.data.limitType,
      thresholdMin: parsed.data.thresholdMin,
      thresholdMax: parsed.data.thresholdMax,
      unit: parsed.data.unit,
      weight: parsed.data.weight,
      scopeText: parsed.data.scopeText,
      veto: parsed.data.veto ?? false
    }
  })
  res.json(clause)
})

app.get('/api/admin/rulesets', requireAdmin as any, async (_req, res) => {
  const rulesets = await prisma.ruleSet.findMany({ orderBy: { createdAt: 'desc' } })
  res.json(
    rulesets.map((r) => ({
      ...r,
      weights: r.weights ? JSON.parse(r.weights) : {},
      expression: r.expression ? JSON.parse(r.expression) : null
    }))
  )
})

app.post('/api/admin/rulesets', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    name: z.string(),
    strategy: z.enum(['加权平均', '最低值', '最高值']),
    weights: z.record(z.number()),
    expression: z.any().optional(),
    version: z.string().optional(),
    enabled: z.boolean().optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })
  const ruleset = await prisma.ruleSet.create({
    data: {
      name: parsed.data.name,
      strategy: parsed.data.strategy,
      weights: JSON.stringify(parsed.data.weights),
      expression: parsed.data.expression ? JSON.stringify(parsed.data.expression) : null,
      version: parsed.data.version,
      enabled: parsed.data.enabled ?? true
    }
  })
  res.json(ruleset)
})

app.get('/api/admin/mappings', requireAdmin as any, async (_req, res) => {
  const mappings = await prisma.productMapping.findMany({
    orderBy: { priority: 'desc' },
    include: { product: true }
  })
  res.json(
    mappings.map((m) => ({
      id: m.id,
      type: m.type,
      value: m.value,
      priority: m.priority,
      standardIds: m.standardIds ? JSON.parse(m.standardIds) : [],
      productName: m.product?.name || ''
    }))
  )
})

app.post('/api/admin/mappings', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    type: z.enum(['条码', '品类', '图像特征']),
    value: z.string(),
    productName: z.string(),
    standardIds: z.array(z.string()),
    priority: z.number().int().min(1).max(10)
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })
  const product = await prisma.product.create({
    data: {
      name: parsed.data.productName
    }
  })
  const mapping = await prisma.productMapping.create({
    data: {
      productId: product.id,
      type: parsed.data.type,
      value: parsed.data.value,
      priority: parsed.data.priority,
      standardIds: JSON.stringify(parsed.data.standardIds)
    }
  })
  res.json({
    id: mapping.id,
    type: mapping.type,
    value: mapping.value,
    priority: mapping.priority,
    standardIds: JSON.parse(mapping.standardIds),
    productName: product.name
  })
})

app.get('/api/admin/audits', requireAdmin as any, async (_req, res) => {
  const audits = await prisma.auditTask.findMany({ orderBy: { createdAt: 'desc' } })
  res.json(
    audits.map((a) => ({
      ...a,
      payload: a.payload ? JSON.parse(a.payload) : null
    }))
  )
})

app.post('/api/admin/audits/:id/approve', requireAdmin as any, async (req, res) => {
  const audit = await prisma.auditTask.update({
    where: { id: req.params.id },
    data: { status: '已通过' }
  })
  res.json({
    ...audit,
    payload: audit.payload ? JSON.parse(audit.payload) : null
  })
})

app.post('/api/admin/audits/:id/reject', requireAdmin as any, async (req, res) => {
  const audit = await prisma.auditTask.update({
    where: { id: req.params.id },
    data: { status: '已驳回' }
  })
  res.json({
    ...audit,
    payload: audit.payload ? JSON.parse(audit.payload) : null
  })
})

app.post('/api/admin/audits/:id/parse', requireAdmin as any, async (req, res) => {
  const audit = await prisma.auditTask.findUnique({ where: { id: req.params.id } })
  if (!audit) return res.status(404).json({ error: 'Not found' })
  const payload = audit.payload ? JSON.parse(audit.payload) : {}
  if (payload?.snippet) {
    const parsed = parseSnippet(payload.snippet as string)
    const nextPayload = { ...payload, parsed }
    const updated = await prisma.auditTask.update({
      where: { id: req.params.id },
      data: { payload: JSON.stringify(nextPayload) }
    })
    return res.json({ ...updated, payload: nextPayload })
  }
  return res.status(400).json({ error: 'No snippet to parse' })
})

app.post('/api/admin/audits/:id/ingest', requireAdmin as any, async (req, res) => {
  const audit = await prisma.auditTask.findUnique({ where: { id: req.params.id } })
  if (!audit) return res.status(404).json({ error: 'Not found' })
  const payload = audit.payload ? JSON.parse(audit.payload) : {}
  const candidate = payload.parsed || payload
  try {
    const standard = await ingestStandard(candidate)
    const updated = await prisma.auditTask.update({
      where: { id: req.params.id },
      data: { status: '已入库' }
    })
    return res.json({ standard, audit: { ...updated, payload } })
  } catch (error) {
    return res.status(400).json({ error: String(error) })
  }
})

app.post('/api/admin/imports', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    title: z.string(),
    source: z.string(),
    payload: z.record(z.any()).optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })
  const task = await prisma.auditTask.create({
    data: {
      title: parsed.data.title,
      source: parsed.data.source,
      status: '待审核',
      payload: parsed.data.payload ? JSON.stringify(parsed.data.payload) : null
    }
  })
  res.json(task)
})

app.post('/api/admin/crawl', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    url: z.string().url(),
    source: z.string().optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })

  let status = '待审核'
  let payload: Record<string, unknown> | undefined
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    const response = await fetch(parsed.data.url, { signal: controller.signal })
    clearTimeout(timer)
    const text = await response.text()
    payload = {
      url: parsed.data.url,
      snippet: text.slice(0, 2000)
    }
  } catch (error) {
    status = '抓取失败'
    payload = { url: parsed.data.url, error: String(error) }
  }

  const task = await prisma.auditTask.create({
    data: {
      title: `抓取任务: ${parsed.data.url}`,
      source: parsed.data.source || 'crawler',
      status,
      payload: payload ? JSON.stringify(payload) : null
    }
  })
  res.json(task)
})

app.post('/api/admin/production-data', requireAdmin as any, async (req, res) => {
  const schema = z
    .object({
      productId: z.string().optional(),
      productName: z.string().optional(),
      standardId: z.string().optional(),
      standardCode: z.string().optional(),
      dataSource: z.string(),
      reportItems: z.array(
        z.object({
          indicator: z.string(),
          value: z.number(),
          unit: z.string().optional(),
          result: z.string().optional()
        })
      )
    })
    .refine((data) => data.standardId || data.standardCode, {
      message: 'standardId or standardCode is required'
    })
    .refine((data) => data.productId || data.productName, {
      message: 'productId or productName is required'
    })

  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })

  const standard = parsed.data.standardId
    ? await prisma.standard.findUnique({ where: { id: parsed.data.standardId } })
    : await prisma.standard.findUnique({ where: { code: parsed.data.standardCode } })
  if (!standard) return res.status(404).json({ error: 'Standard not found' })

  const product = parsed.data.productId
    ? await prisma.product.findUnique({ where: { id: parsed.data.productId } })
    : await prisma.product.create({ data: { name: parsed.data.productName! } })
  if (!product) return res.status(404).json({ error: 'Product not found' })

  const production = await prisma.productionStandard.create({
    data: {
      productId: product.id,
      standardId: standard.id,
      dataSource: parsed.data.dataSource,
      reportItems: {
        create: parsed.data.reportItems.map((item) => ({
          indicator: item.indicator,
          value: item.value,
          unit: item.unit,
          result: item.result
        }))
      }
    },
    include: {
      reportItems: true,
      standard: true,
      product: true
    }
  })

  res.json(production)
})

app.get('/api/admin/production-data/all', requireAdmin as any, async (_req, res) => {
  const productions = await prisma.productionStandard.findMany({
    orderBy: { createdAt: 'desc' },
    include: { reportItems: true, standard: true, product: true }
  })
  res.json(
    productions.map((item) => ({
      ...item,
      productName: item.product?.name || '',
      standardTitle: item.standard?.title || ''
    }))
  )
})

app.get('/api/admin/production-data/:productId', requireAdmin as any, async (req, res) => {
  const productions = await prisma.productionStandard.findMany({
    where: { productId: req.params.productId },
    orderBy: { createdAt: 'desc' },
    include: { reportItems: true, standard: true }
  })
  res.json(productions)
})

app.get('/api/admin/categories', requireAdmin as any, async (_req, res) => {
  const items = await prisma.category.findMany({ orderBy: { createdAt: 'desc' } })
  res.json(items)
})

app.post('/api/admin/categories', requireAdmin as any, async (req, res) => {
  const schema = z.object({ name: z.string(), parentId: z.string().optional() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })
  const item = await prisma.category.create({
    data: { name: parsed.data.name, parentId: parsed.data.parentId }
  })
  res.json(item)
})

app.get('/api/admin/indicators', requireAdmin as any, async (_req, res) => {
  const items = await prisma.indicator.findMany({ orderBy: { createdAt: 'desc' } })
  res.json(
    items.map((item) => ({
      ...item,
      synonyms: item.synonyms ? JSON.parse(item.synonyms) : []
    }))
  )
})

app.post('/api/admin/indicators', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    name: z.string(),
    synonyms: z.array(z.string()).optional(),
    defaultUnit: z.string().optional(),
    dimension: z.string().optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })
  const item = await prisma.indicator.create({
    data: {
      name: parsed.data.name,
      synonyms: parsed.data.synonyms ? JSON.stringify(parsed.data.synonyms) : null,
      defaultUnit: parsed.data.defaultUnit,
      dimension: parsed.data.dimension
    }
  })
  res.json(item)
})

app.get('/api/admin/reports', requireAdmin as any, async (_req, res) => {
  const items = await prisma.report.findMany({
    orderBy: { createdAt: 'desc' },
    include: { measurements: true }
  })
  res.json(items)
})

app.post('/api/admin/reports', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    productId: z.string(),
    reportNo: z.string().optional(),
    org: z.string().optional(),
    date: z.string().optional(),
    batchNo: z.string().optional(),
    sourceType: z.string(),
    fileUrl: z.string().optional(),
    trustLevel: z.string().optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })
  const item = await prisma.report.create({
    data: {
      productId: parsed.data.productId,
      reportNo: parsed.data.reportNo,
      org: parsed.data.org,
      date: parsed.data.date ? new Date(parsed.data.date) : undefined,
      batchNo: parsed.data.batchNo,
      sourceType: parsed.data.sourceType,
      fileUrl: parsed.data.fileUrl,
      trustLevel: parsed.data.trustLevel
    }
  })
  res.json(item)
})

app.get('/api/admin/measurements', requireAdmin as any, async (_req, res) => {
  const items = await prisma.measurement.findMany({ orderBy: { createdAt: 'desc' } })
  res.json(items)
})

app.post('/api/admin/measurements', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    reportId: z.string(),
    indicatorId: z.string().optional(),
    rawName: z.string(),
    rawValue: z.number().optional(),
    rawUnit: z.string().optional(),
    valueStd: z.number().optional(),
    unitStd: z.string().optional(),
    mappingConfidence: z.number().optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })

  let indicatorId = parsed.data.indicatorId
  let mappingConfidence = parsed.data.mappingConfidence
  let indicatorRef = indicatorId ? await prisma.indicator.findUnique({ where: { id: indicatorId } }) : null

  if (!indicatorId) {
    const mapping = await prisma.indicatorMapping.findFirst({
      where: { rawKey: parsed.data.rawName, mappingType: 'report_item' }
    })
    if (mapping) {
      indicatorId = mapping.indicatorId
      mappingConfidence = mapping.confidence ?? 0.8
      indicatorRef = await prisma.indicator.findUnique({ where: { id: indicatorId } })
    } else {
      const allIndicators = await prisma.indicator.findMany()
      const match = allIndicators.find((indicator) => {
        if (indicator.name === parsed.data.rawName) return true
        if (!indicator.synonyms) return false
        try {
          const synonyms = JSON.parse(indicator.synonyms) as string[]
          return synonyms.includes(parsed.data.rawName)
        } catch {
          return false
        }
      })
      if (match) {
        indicatorId = match.id
        mappingConfidence = 0.6
        indicatorRef = match
      }
    }
  }

  let unitStd = parsed.data.unitStd
  let valueStd = parsed.data.valueStd
  if (!unitStd && indicatorRef?.defaultUnit) {
    unitStd = indicatorRef.defaultUnit
  }
  if (valueStd === undefined && parsed.data.rawValue !== undefined && unitStd && parsed.data.rawUnit) {
    valueStd = normalizeUnit(parsed.data.rawValue, parsed.data.rawUnit, unitStd)
  }

  const item = await prisma.measurement.create({
    data: {
      reportId: parsed.data.reportId,
      indicatorId,
      rawName: parsed.data.rawName,
      rawValue: parsed.data.rawValue,
      rawUnit: parsed.data.rawUnit,
      valueStd,
      unitStd,
      mappingConfidence
    }
  })
  res.json(item)
})

app.get('/api/admin/peer-baseline', requireAdmin as any, async (_req, res) => {
  const items = await prisma.peerBaseline.findMany({ orderBy: { updatedAt: 'desc' } })
  res.json(items)
})

app.post('/api/admin/peer-baseline', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    categoryId: z.string(),
    indicatorId: z.string(),
    avg: z.number().optional(),
    p50: z.number().optional(),
    p75: z.number().optional(),
    p90: z.number().optional(),
    source: z.string().optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })
  const item = await prisma.peerBaseline.create({
    data: {
      categoryId: parsed.data.categoryId,
      indicatorId: parsed.data.indicatorId,
      avg: parsed.data.avg,
      p50: parsed.data.p50,
      p75: parsed.data.p75,
      p90: parsed.data.p90,
      source: parsed.data.source,
      updatedAt: new Date()
    }
  })
  res.json(item)
})

app.get('/api/admin/indicator-mappings', requireAdmin as any, async (_req, res) => {
  const items = await prisma.indicatorMapping.findMany({ orderBy: { updatedAt: 'desc' } })
  res.json(items)
})

app.post('/api/admin/indicator-mappings', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    mappingType: z.string(),
    rawKey: z.string(),
    indicatorId: z.string(),
    rule: z.string().optional(),
    confidence: z.number().optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })
  const item = await prisma.indicatorMapping.create({
    data: {
      mappingType: parsed.data.mappingType,
      rawKey: parsed.data.rawKey,
      indicatorId: parsed.data.indicatorId,
      rule: parsed.data.rule,
      confidence: parsed.data.confidence
    }
  })
  res.json(item)
})

app.get('/api/admin/ingestion-jobs', requireAdmin as any, async (_req, res) => {
  const items = await prisma.ingestionJob.findMany({ orderBy: { createdAt: 'desc' } })
  res.json(items)
})

app.post('/api/admin/ingestion-jobs', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    sourceType: z.string(),
    sourceName: z.string().optional(),
    payloadRef: z.string().optional(),
    status: z.string(),
    progress: z.number().optional(),
    errorLog: z.string().optional(),
    createdBy: z.string().optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })
  const item = await prisma.ingestionJob.create({
    data: {
      sourceType: parsed.data.sourceType,
      sourceName: parsed.data.sourceName,
      payloadRef: parsed.data.payloadRef,
      status: parsed.data.status,
      progress: parsed.data.progress,
      errorLog: parsed.data.errorLog,
      createdBy: parsed.data.createdBy
    }
  })
  res.json(item)
})

app.post('/api/admin/ingestion-jobs/import', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    sourceType: z.enum([
      'standards',
      'clauses',
      'indicators',
      'reports',
      'measurements',
      'peer_baseline',
      'categories',
      'indicator_mappings'
    ]),
    format: z.enum(['json', 'csv', 'excel']).optional(),
    records: z.any().optional(),
    text: z.string().optional(),
    contentBase64: z.string().optional(),
    sourceName: z.string().optional(),
    createdBy: z.string().optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })

  const job = await prisma.ingestionJob.create({
    data: {
      sourceType: parsed.data.sourceType,
      sourceName: parsed.data.sourceName,
      status: 'RUNNING',
      progress: 0,
      createdBy: parsed.data.createdBy
    }
  })

  try {
    const records = parsed.data.records ?? (await parseImportRecords(parsed.data))
    const errors: { row: number; reason: string }[] = []
    let inserted = 0

    if (parsed.data.sourceType === 'categories') {
      for (const [index, row] of records.entries()) {
        const name = pickValue(row, ['name', 'category', 'category_name'])
        if (!name) {
          errors.push({ row: index + 1, reason: 'missing name' })
          continue
        }
        const existing = await prisma.category.findFirst({ where: { name: String(name) } })
        if (existing) {
          await prisma.category.update({
            where: { id: existing.id },
            data: { parentId: pickValue(row, ['parent_id', 'parentId']) }
          })
        } else {
          await prisma.category.create({
            data: { name: String(name), parentId: pickValue(row, ['parent_id', 'parentId']) }
          })
        }
        inserted += 1
      }
    }

    if (parsed.data.sourceType === 'indicators') {
      for (const [index, row] of records.entries()) {
        const name = pickValue(row, ['name', 'indicator'])
        if (!name) {
          errors.push({ row: index + 1, reason: 'missing name' })
          continue
        }
        const synonyms = parseList(pickValue(row, ['synonyms', 'alias', 'alias_list']))
        const existing = await prisma.indicator.findFirst({ where: { name: String(name) } })
        if (existing) {
          await prisma.indicator.update({
            where: { id: existing.id },
            data: {
              synonyms: synonyms.length ? JSON.stringify(synonyms) : null,
              defaultUnit: pickValue(row, ['default_unit', 'unit']) ?? existing.defaultUnit,
              dimension: pickValue(row, ['dimension', 'type']) ?? existing.dimension
            }
          })
        } else {
          await prisma.indicator.create({
            data: {
              name: String(name),
              synonyms: synonyms.length ? JSON.stringify(synonyms) : null,
              defaultUnit: pickValue(row, ['default_unit', 'unit']),
              dimension: pickValue(row, ['dimension', 'type'])
            }
          })
        }
        inserted += 1
      }
    }

    if (parsed.data.sourceType === 'standards') {
      for (const [index, row] of records.entries()) {
        const code = pickValue(row, ['standard_no', 'code', 'standardNo'])
        if (!code) {
          errors.push({ row: index + 1, reason: 'missing standard code' })
          continue
        }
        await prisma.standard.upsert({
          where: { code: String(code) },
          update: {
            title: pickValue(row, ['title', 'name']) || String(code),
            type: pickValue(row, ['type']),
            level: pickValue(row, ['level']) || '国家',
            source: pickValue(row, ['source']) || '',
            version: pickValue(row, ['version']) || '',
            scope: pickValue(row, ['scope']) || '',
            status: pickValue(row, ['status']),
            publishDate: toDate(pickValue(row, ['publish_date', 'publishDate'])),
            effectiveDate: toDate(pickValue(row, ['effective_date', 'effectiveDate']))
          },
          create: {
            code: String(code),
            title: pickValue(row, ['title', 'name']) || String(code),
            type: pickValue(row, ['type']),
            level: pickValue(row, ['level']) || '国家',
            source: pickValue(row, ['source']) || '',
            version: pickValue(row, ['version']) || '',
            scope: pickValue(row, ['scope']) || '',
            status: pickValue(row, ['status']),
            publishDate: toDate(pickValue(row, ['publish_date', 'publishDate'])),
            effectiveDate: toDate(pickValue(row, ['effective_date', 'effectiveDate']))
          }
        })
        inserted += 1
      }
    }

    if (parsed.data.sourceType === 'clauses') {
      for (const [index, row] of records.entries()) {
        const standardCode = pickValue(row, ['standard_no', 'standardCode', 'code'])
        const standard = standardCode
          ? await prisma.standard.findUnique({ where: { code: String(standardCode) } })
          : null
        const standardId = pickValue(row, ['standard_id', 'standardId']) || standard?.id
        if (!standardId) {
          errors.push({ row: index + 1, reason: 'missing standardId' })
          continue
        }
        const indicatorName = pickValue(row, ['indicator', 'indicator_name', 'key'])
        const indicator = indicatorName ? await prisma.indicator.findFirst({ where: { name: indicatorName } }) : null
        await prisma.standardClause.create({
          data: {
            standardId,
            key: pickValue(row, ['key', 'clause']) || String(indicatorName || '未命名条款'),
            requirement: pickValue(row, ['requirement']) || '',
            weight: toNumber(pickValue(row, ['weight'])) || 0.1,
            indicator: String(indicatorName || ''),
            indicatorId: indicator?.id,
            comparator: pickValue(row, ['comparator', 'op']) || '>=',
            threshold: toNumber(pickValue(row, ['threshold'])) || 0,
            limitType: pickValue(row, ['limit_type', 'limitType']) as any,
            thresholdMin: toNumber(pickValue(row, ['threshold_min', 'min'])),
            thresholdMax: toNumber(pickValue(row, ['threshold_max', 'max'])),
            unit: pickValue(row, ['unit']),
            scopeText: pickValue(row, ['scope', 'scope_text']),
            veto: Boolean(pickValue(row, ['veto', 'is_veto']))
          }
        })
        inserted += 1
      }
    }

    if (parsed.data.sourceType === 'reports') {
      for (const [index, row] of records.entries()) {
        const barcode = pickValue(row, ['barcode'])
        const productId = pickValue(row, ['product_id', 'productId'])
        const product = productId
          ? await prisma.product.findUnique({ where: { id: String(productId) } })
          : barcode
            ? await prisma.product.findFirst({ where: { barcode: String(barcode) } })
            : null
        if (!product) {
          errors.push({ row: index + 1, reason: 'missing product' })
          continue
        }
        await prisma.report.create({
          data: {
            productId: product.id,
            reportNo: pickValue(row, ['report_no', 'reportNo']),
            org: pickValue(row, ['org']),
            date: toDate(pickValue(row, ['date'])),
            batchNo: pickValue(row, ['batch_no', 'batchNo']),
            sourceType: pickValue(row, ['source_type', 'sourceType']) || 'manual',
            fileUrl: pickValue(row, ['file_url', 'fileUrl']),
            trustLevel: pickValue(row, ['trust_level', 'trustLevel'])
          }
        })
        inserted += 1
      }
    }

    if (parsed.data.sourceType === 'measurements') {
      for (const [index, row] of records.entries()) {
        const reportId = pickValue(row, ['report_id', 'reportId'])
        const reportNo = pickValue(row, ['report_no', 'reportNo'])
        const report = reportId
          ? await prisma.report.findUnique({ where: { id: String(reportId) } })
          : reportNo
            ? await prisma.report.findFirst({ where: { reportNo: String(reportNo) } })
            : null
        if (!report) {
          errors.push({ row: index + 1, reason: 'missing report' })
          continue
        }
        const indicatorName = pickValue(row, ['indicator', 'indicator_name', 'raw_name', 'rawName'])
        const indicator = indicatorName ? await prisma.indicator.findFirst({ where: { name: indicatorName } }) : null
        await prisma.measurement.create({
          data: {
            reportId: report.id,
            indicatorId: indicator?.id,
            rawName: String(indicatorName || ''),
            rawValue: toNumber(pickValue(row, ['raw_value', 'value'])),
            rawUnit: pickValue(row, ['raw_unit', 'unit']),
            valueStd: toNumber(pickValue(row, ['value_std'])),
            unitStd: pickValue(row, ['unit_std']),
            mappingConfidence: toNumber(pickValue(row, ['confidence']))
          }
        })
        inserted += 1
      }
    }

    if (parsed.data.sourceType === 'peer_baseline') {
      for (const [index, row] of records.entries()) {
        const categoryName = pickValue(row, ['category', 'category_name'])
        const categoryId = pickValue(row, ['category_id', 'categoryId'])
        const indicatorName = pickValue(row, ['indicator', 'indicator_name'])
        const indicatorId = pickValue(row, ['indicator_id', 'indicatorId'])
        const category = categoryId
          ? await prisma.category.findUnique({ where: { id: String(categoryId) } })
          : categoryName
            ? await prisma.category.findFirst({ where: { name: String(categoryName) } })
            : null
        const indicator = indicatorId
          ? await prisma.indicator.findUnique({ where: { id: String(indicatorId) } })
          : indicatorName
            ? await prisma.indicator.findFirst({ where: { name: String(indicatorName) } })
            : null
        if (!category || !indicator) {
          errors.push({ row: index + 1, reason: 'missing category or indicator' })
          continue
        }
        await prisma.peerBaseline.create({
          data: {
            categoryId: category.id,
            indicatorId: indicator.id,
            avg: toNumber(pickValue(row, ['avg'])),
            p50: toNumber(pickValue(row, ['p50'])),
            p75: toNumber(pickValue(row, ['p75'])),
            p90: toNumber(pickValue(row, ['p90'])),
            source: pickValue(row, ['source']),
            updatedAt: new Date()
          }
        })
        inserted += 1
      }
    }

    if (parsed.data.sourceType === 'indicator_mappings') {
      for (const [index, row] of records.entries()) {
        const indicatorName = pickValue(row, ['indicator', 'indicator_name'])
        const indicatorId = pickValue(row, ['indicator_id', 'indicatorId'])
        const indicator = indicatorId
          ? await prisma.indicator.findUnique({ where: { id: String(indicatorId) } })
          : indicatorName
            ? await prisma.indicator.findFirst({ where: { name: String(indicatorName) } })
            : null
        if (!indicator) {
          errors.push({ row: index + 1, reason: 'missing indicator' })
          continue
        }
        await prisma.indicatorMapping.create({
          data: {
            mappingType: pickValue(row, ['mapping_type', 'mappingType']) || 'report_item',
            rawKey: pickValue(row, ['raw_key', 'rawKey']) || '',
            indicatorId: indicator.id,
            rule: pickValue(row, ['rule']),
            confidence: toNumber(pickValue(row, ['confidence']))
          }
        })
        inserted += 1
      }
    }

    await prisma.ingestionJob.update({
      where: { id: job.id },
      data: { status: 'COMPLETED', progress: 1, errorLog: errors.length ? JSON.stringify(errors) : null }
    })

    res.json({ jobId: job.id, inserted, errors })
  } catch (error) {
    await prisma.ingestionJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', errorLog: String(error) }
    })
    res.status(400).json({ error: String(error), jobId: job.id })
  }
})

app.get('/api/admin/audit-logs', requireAdmin as any, async (_req, res) => {
  const items = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' } })
  res.json(items)
})

app.post('/api/admin/audit-logs', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    actor: z.string().optional(),
    action: z.string(),
    targetType: z.string(),
    targetId: z.string().optional(),
    diffJson: z.string().optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })
  const item = await prisma.auditLog.create({
    data: {
      actor: parsed.data.actor,
      action: parsed.data.action,
      targetType: parsed.data.targetType,
      targetId: parsed.data.targetId,
      diffJson: parsed.data.diffJson
    }
  })
  res.json(item)
})

app.get('/api/admin/scenes', requireAdmin as any, async (_req, res) => {
  const scenes = await prisma.scene.findMany({
    orderBy: { createdAt: 'desc' },
    include: { bindings: true, modules: true }
  })
  res.json(
    scenes.map((scene) => ({
      ...scene,
      bindings: scene.bindings.map((binding) => ({
        id: binding.id,
        standardId: binding.standardId,
        relation: binding.relation
      })),
      modules: scene.modules.map((module) => ({
        id: module.id,
        moduleType: module.moduleType,
        title: module.title,
        sortOrder: module.sortOrder
      }))
    }))
  )
})

app.post('/api/admin/scenes', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    name: z.string(),
    type: z.enum(['SOP', 'TRAINING', 'EXAM', 'SCAN', 'PSYTEST']),
    industry: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })
  const scene = await prisma.scene.create({
    data: {
      name: parsed.data.name,
      type: parsed.data.type,
      industry: parsed.data.industry,
      description: parsed.data.description,
      status: parsed.data.status ?? '启用'
    }
  })
  res.json(scene)
})

app.get('/api/admin/scenes/:id', requireAdmin as any, async (req, res) => {
  const scene = await prisma.scene.findUnique({
    where: { id: req.params.id },
    include: { bindings: true, modules: true }
  })
  if (!scene) return res.status(404).json({ error: 'Not found' })
  res.json({
    ...scene,
    modules: scene.modules.map((module) => ({
      id: module.id,
      moduleType: module.moduleType,
      title: module.title,
      sortOrder: module.sortOrder,
      payload: module.payload ? JSON.parse(module.payload) : null
    }))
  })
})

app.post('/api/admin/scenes/:id/modules', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    moduleType: z.enum(['STEP', 'CONTENT', 'QUIZ', 'RESULT', 'SIGN']),
    title: z.string(),
    sortOrder: z.number().int().min(1).max(999),
    payload: z.any().optional()
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })
  const module = await prisma.sceneModule.create({
    data: {
      sceneId: req.params.id,
      moduleType: parsed.data.moduleType,
      title: parsed.data.title,
      sortOrder: parsed.data.sortOrder,
      payload: JSON.stringify(parsed.data.payload ?? {})
    }
  })
  res.json(module)
})

app.post('/api/admin/scenes/:id/bindings', requireAdmin as any, async (req, res) => {
  const schema = z.object({
    standardId: z.string(),
    relation: z.enum(['REFERENCE', 'BASIS', 'BENCHMARK', 'TRAINING_REF'])
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' })
  const binding = await prisma.sceneStandardBinding.create({
    data: {
      sceneId: req.params.id,
      standardId: parsed.data.standardId,
      relation: parsed.data.relation
    }
  })
  res.json(binding)
})

// Express 全局错误中间件：兜底所有 next(err) / 同步抛错的中间件链
// 必须放在所有路由注册之后（main.ts 的注册顺序保证此处覆盖全部路由）
// 注意 4 参数签名 (err, req, res, next) 不可省，否则 Express 不会识别为 error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ module: 'express', err, path: _req?.path }, 'unhandled route error')
  if (res.headersSent) return
  const code = typeof err?.status === 'number' ? err.status : 500
  res.status(code).json({
    error: process.env.NODE_ENV === 'production' ? '服务异常，请稍后重试' : (err?.message || 'Internal Server Error')
  })
})

const port = Number(process.env.PORT || 3000)
// PRAGMA 必须在 startWorker / 任何写操作之前完成。
// 失败时直接退出，不允许跑在 delete journal 模式下（写锁竞争已知问题）。
initDatabase()
  .catch((error) => {
    console.error('initDatabase 失败，进程退出:', error)
    process.exit(1)
  })
  .then(async () => {
    const schema = await checkPrismaSchemaHealth(prisma)
    if (schema.ok) {
      logger.info({
        module: 'schema-health',
        provider: schema.provider,
        expectedTables: schema.expectedTables,
        expectedColumns: schema.expectedColumns,
      }, 'schema health ok at startup')
    } else {
      logger.error({
        module: 'schema-health',
        provider: schema.provider,
        missingTableCount: schema.missingTableCount,
        missingColumnCount: schema.missingColumnCount,
        error: schema.error,
      }, 'schema drift detected at startup')
    }
  })
  .then(() => ensureAppSeed())
  .catch((error) => {
    console.error('Failed to seed app data', error)
  })
  .finally(() => {
    const server = app.listen(port, () => {
      logger.info({ module: 'startup', port }, 'API listening')
      preloadPlatformCerts()

      // 订单超时自动清理（启动时立即跑一次 + 每 5 分钟一次）
      // 详细规则见 orderSweeper.ts
      startOrderSweeper(prisma)

      // 上传文件超时清理（启动时立即跑一次 + 每 24 小时一次）
      // 跟 taskWorker 完成时立即清理配套，sweeper 兜未完成/异常崩的孤儿文件
      // 默认 UPLOAD_RETAIN_DAYS=1（2026-04-12 30→7，2026-04-28 7→1，详见 uploadsSweeper.ts）
      startUploadsSweeper(uploadDir)

      // 营销自动化：每日 02:00 聚合用户标签（UserLabel 表）
      scheduleLabelSync()

      // 用标准周期计划：启动时补一次漏跑 + 每 15 分钟扫描 nextRunAt 到期计划。
      scheduleStandardExecutionPlanRuns()

      // SE 向量索引：启动时扫描未入库内容；失败只记日志，不影响主服务。
      startVectorIndexWorker()

      // 会员到期自动降级：每小时扫描 endAt 已过期的 ACTIVE 会员（详见 membershipSweeper.ts）
      startMembershipExpirySweeper(prisma)
    })

    // ─── SIGTERM/SIGINT graceful shutdown ─────────────────────────
    // 事故根因（2026-04-28 阶段三 seed Coupon 时踩到）：
    // docker stop 默认 SIGTERM 等 10s → SIGKILL（exit 137），
    // SIGKILL 打断 SQLite COMMIT 后的 fsync，bind mount 期间 OS page cache
    // 不保证 flush 到 host fs → 写入凭空消失。
    // 修复：收到 SIGTERM/SIGINT 立即 server.close + prisma.$disconnect（含 fsync），
    // 5s 超时兜底，进程主动 exit(0)，避免被 SIGKILL 掐断。
    let shuttingDown = false
    async function gracefulShutdown(signal: string) {
      if (shuttingDown) return
      shuttingDown = true
      logger.info({ module: 'shutdown', signal }, '收到关闭信号，graceful 退出')
      // 1. 停止接受新请求
      server.close()
      // 2. 等 prisma disconnect（触发 SQLite WAL checkpoint + fsync），最多等 5s
      try {
        await Promise.race([
          prisma.$disconnect(),
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ])
        logger.info({ module: 'shutdown' }, 'prisma disconnected')
      } catch (e: any) {
        logger.warn({ module: 'shutdown', err: e?.message }, 'prisma disconnect failed')
      }
      process.exit(0)
    }
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
    process.on('SIGINT', () => gracefulShutdown('SIGINT'))
  })
