/**
 * 企业申请模块路由
 *
 * 公开接口：
 *   POST /api/app/enterprise/apply            — 提交申请（IP 限流 1min/3 + 同手机 24h 去重）
 * Admin 接口：
 *   GET    /api/admin/enterprise/applications              — 列表（筛选 + 分页）
 *   PATCH  /api/admin/enterprise/applications/:id/status   — 更新状态
 *
 * 钉钉通知：env ENTERPRISE_APPLY_WEBHOOK_URL / ENTERPRISE_APPLY_SIGN_SECRET（缺则跳过）
 */
import type { Express, Request, Response } from 'express'
import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { z } from 'zod'
import { prisma } from './db.js'
import { requireAdmin, requireAuth, hashPassword, type AuthRequest } from './auth.js'
import { BankCreateSchema, BankUpdateSchema } from './standard-execution/questionBankRoutes.js'
import { attachRequirementHealth, attachRequirementTaskStats } from './standard-execution/utils.js'
import { buildBasisSnapshots, resolveRequirementBasis, type RequirementForSnapshot } from './standard-execution/basisSnapshots.js'
import { deleteRequirementsByPolicy } from './standard-execution/requirementDelete.js'
import { AiGenerateQuestionsSchema, generateQuizQuestions, AiQuizInvalidError } from './standard-execution/quizGenerate.js'
import { callStandardAI, AiNotConfiguredError, AiCallFailedError } from './standard-execution/aiClient.js'
import {
  SourceListQuerySchema,
  RequirementListQuerySchema,
  TaskListQuerySchema,
  TaskListV2QuerySchema,
  TaskCreateSchema,
  TaskUpdateSchema,
  TaskApprovalCommentSchema,
  BatchCreateTasksFromRequirementsSchema,
  RecordListQuerySchema,
  RecordVoidSchema,
  PackageCreateSchema,
  PackageListQuerySchema,
  PackageGenerateSchema,
  PackageAsyncGenerateSchema,
  PackagePreviewSchema,
  SourceCreateSchema,
  SourceUpdateSchema,
  AutoGenerateSchema,
  BatchIdsSchema,
  BatchAssignSchema,
  TASK_TYPES,
  PlanCreateSchema,
  PlanUpdateSchema,
  PlanBindTasksSchema,
  PlanGenerateTasksSchema,
} from './standard-execution/types.js'
import { buildManagementTaskListV2 } from './standard-execution/taskListV2.js'
import { ASSIGNEE_STATUS, type AssigneeStatus } from './standard-execution/enums.js'
import { computeRisks } from './standard-execution/riskRoutes.js'
import { runParse } from './standard-execution/autoGenerateRoute.js'
import { registerTaskGenerationRoutes } from './standard-execution/taskGenerationRoutes.js'
import { packageFilePathFromUrl } from './standard-execution/packageBundle.js'
import { buildPackagePreview, generatePackageArtifacts, packageZipDownloadName, readPackageArtifactFile } from './standard-execution/packageArtifacts.js'
import { resolveValidPackageRecords } from './standard-execution/packageSelection.js'
import { PACKAGE_TEMPLATES } from './standard-execution/packageTemplates.js'
import { getPackageGenerationJob, startPackageGenerationJob } from './standard-execution/packageJobs.js'
import {
  buildRecordEvidencePdfBuffer,
  loadRecordEvidenceChain,
  recordEvidencePdfFilename,
} from './standard-execution/recordEvidence.js'
import { SourceOwnershipUpdateSchema, canManageSourceOwnership } from './standard-execution/sourceOwnership.js'
import {
  approveTaskApproval,
  rejectTaskApproval,
  submitTaskApproval,
  TaskApprovalError,
} from './standard-execution/taskApproval.js'
import { withSubmitFormConfig } from './standard-execution/submitFormConfig.js'
import { invalidateSEContext } from './routes/seChat.js'
import { Prisma } from '@prisma/client'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { buildDingtalkUrl } from './alert.js'
import { logger } from './logger.js'
import crypto from 'crypto'

const ApplySchema = z.object({
  name: z.string().trim().min(1, 'name 不能为空').max(50),
  position: z.string().trim().min(1, 'position 不能为空').max(50),
  company: z.string().trim().min(1, 'company 不能为空').max(100),
  phone: z.string().regex(/^1[3-9]\d{9}$/, '手机号格式错误'),
  requirement: z.string().trim().max(1000).optional().default(''),
})

function normalizeApplyPayload(body: unknown) {
  const input = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const getString = (key: string) => (typeof input[key] === 'string' ? input[key] : undefined)
  const requirement = getString('requirement')?.trim()
  const requirementParts = [
    getString('industry') ? `行业：${getString('industry')}` : '',
    getString('companySize') ? `规模：${getString('companySize')}` : '',
    getString('useCase') ? `用途：${getString('useCase')}` : '',
    getString('scenario') ? `场景：${getString('scenario')}` : '',
    getString('remark') ? `备注：${getString('remark')}` : '',
  ].filter(Boolean)

  return {
    name: getString('name') ?? getString('contactName'),
    position: getString('position') ?? '未填写',
    company: getString('company') ?? getString('companyName'),
    phone: getString('phone') ?? getString('contactPhone'),
    requirement: requirement || requirementParts.join('；'),
  }
}

const StatusSchema = z.object({
  status: z.enum(['pending', 'contacted']),
})

function packageDownloadName(title: string | null | undefined, id: string) {
  const safeTitle = String(title || '审计包').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)
  return `${safeTitle || id}.zip`
}

const DEFAULT_ENTERPRISE_ID = 'DEFAULT'
const TEMP_PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
const COMPLIANCE_CYCLE_TYPES = ['ANNUAL', 'QUARTERLY', 'MONTHLY', 'CUSTOM'] as const
const COMPLIANCE_CYCLE_STATUSES = ['PLANNING', 'ACTIVE', 'COMPLETED'] as const
const COMPLIANCE_CYCLE_TEMPLATE_STATUSES = ['ACTIVE', 'DISABLED'] as const
const TASK_DEADLINE_MODES = ['FIXED', 'AFTER_APPROVAL_DAYS'] as const
const PDF_FONT_CANDIDATES = [
  '/app/assets/fonts/NotoSansSC-Regular.otf',
  'assets/fonts/NotoSansSC-Regular.otf',
  'services/api/assets/fonts/NotoSansSC-Regular.otf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
]
const CYCLE_REPORT_DIR = path.resolve(
  process.env.SE_CYCLE_REPORT_DIR || path.join(process.cwd(), 'uploads', 'se-cycle-reports'),
)

const UniqueStringArraySchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(500)
  .refine((arr) => new Set(arr).size === arr.length, { message: 'ids 含重复项' })

const ComplianceCycleTaskConfigSchema = z.object({
  reviewerId: z.string().trim().min(1).optional().nullable(),
  assigneeIds: z.array(z.string().trim().min(1)).max(100).optional(),
  taskType: z.string().trim().max(100).optional().nullable(),
  taskStatus: z.enum(['DRAFT', 'PENDING_APPROVAL']).optional(),
  deadlineMode: z.enum(TASK_DEADLINE_MODES).optional(),
  deadlineDaysAfterApproval: z.number().int().positive().max(365).optional().nullable(),
  submitRequirement: z.string().trim().max(1000).optional().nullable(),
  titlePrefix: z.string().trim().max(80).optional().nullable(),
})

const ComplianceCycleTemplateCreateSchema = z.object({
  title: z.string().trim().min(1, 'title 不能为空').max(200),
  cycleType: z.enum(COMPLIANCE_CYCLE_TYPES),
  requirementIds: UniqueStringArraySchema,
  taskConfig: ComplianceCycleTaskConfigSchema.optional().default({}),
})

const ComplianceCycleTemplateListSchema = z.object({
  status: z.enum(COMPLIANCE_CYCLE_TEMPLATE_STATUSES).optional(),
  cycleType: z.enum(COMPLIANCE_CYCLE_TYPES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
})

const ComplianceCycleStartSchema = ComplianceCycleTaskConfigSchema.extend({
  title: z.string().trim().min(1).max(200).optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  deadlineAt: z.coerce.date().optional().nullable(),
}).refine((data) => data.endDate.getTime() > data.startDate.getTime(), {
  message: 'endDate 必须晚于 startDate',
})

const ComplianceCycleListSchema = z.object({
  status: z.enum(COMPLIANCE_CYCLE_STATUSES).optional(),
  templateId: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
})

const SourceVersionCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  version: z.string().trim().min(1, 'version 不能为空').max(80),
  rawText: z.string().max(1_000_000).optional().nullable(),
  fileUrl: z.string().max(500).optional().nullable(),
  analyze: z.boolean().optional().default(true),
})

type ComplianceCycleTaskConfig = z.infer<typeof ComplianceCycleTaskConfigSchema>

function generateTempPassword(length = 8): string {
  let password = ''
  for (let i = 0; i < length; i += 1) {
    password += TEMP_PASSWORD_CHARS[crypto.randomInt(0, TEMP_PASSWORD_CHARS.length)]
  }
  return password
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
}

function normalizeCycleTaskConfig(value: unknown): ComplianceCycleTaskConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const parsed = ComplianceCycleTaskConfigSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

function mergeCycleTaskConfig(
  templateConfig: ComplianceCycleTaskConfig,
  override: z.infer<typeof ComplianceCycleStartSchema>,
): ComplianceCycleTaskConfig & { deadlineAt?: Date | null } {
  const overrideTaskConfig = ComplianceCycleTaskConfigSchema.parse(override)
  return {
    ...templateConfig,
    ...Object.fromEntries(Object.entries(overrideTaskConfig).filter(([, value]) => value !== undefined)),
    assigneeIds: override.assigneeIds ?? templateConfig.assigneeIds ?? [],
    reviewerId: override.reviewerId ?? templateConfig.reviewerId ?? null,
    taskStatus: override.taskStatus ?? templateConfig.taskStatus ?? 'DRAFT',
    deadlineMode: override.deadlineMode ?? templateConfig.deadlineMode ?? 'AFTER_APPROVAL_DAYS',
    deadlineDaysAfterApproval: override.deadlineDaysAfterApproval ?? templateConfig.deadlineDaysAfterApproval ?? 7,
    deadlineAt: override.deadlineAt ?? null,
  }
}

function cycleFrequency(cycleType: string) {
  if (cycleType === 'ANNUAL') return 'yearly'
  if (cycleType === 'QUARTERLY') return 'quarterly'
  if (cycleType === 'MONTHLY') return 'monthly'
  return null
}

function formatDate(value: Date | string | null | undefined, withTime = false) {
  if (!value) return '-'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  const iso = date.toISOString()
  return withTime ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10)
}

function sanitizeForStandardFont(text: string) {
  return text.replace(/[^\x20-\x7E]/g, '?')
}

function hasNonAscii(text: string) {
  return /[^\x00-\x7F]/.test(text)
}

function wrapLine(line: string, maxChars: number) {
  if (line.length <= maxChars) return [line]
  const out: string[] = []
  for (let i = 0; i < line.length; i += maxChars) out.push(line.slice(i, i + maxChars))
  return out
}

function extractClauseMap(text: string | null | undefined) {
  const map = new Map<string, string>()
  for (const rawLine of String(text || '').split(/\n+/)) {
    const line = rawLine.trim()
    const match = line.match(/^(\d+(?:\.\d+){0,4})\s+(.{2,})$/)
    if (match) map.set(match[1], match[2].replace(/\s+/g, ' ').trim())
  }
  return map
}

function buildVersionChangeSummary(oldText: string | null | undefined, newText: string | null | undefined) {
  const oldClauses = extractClauseMap(oldText)
  const newClauses = extractClauseMap(newText)
  const added: string[] = []
  const modified: string[] = []
  const removed: string[] = []
  for (const [clauseNo, body] of newClauses) {
    if (!oldClauses.has(clauseNo)) added.push(clauseNo)
    else if (oldClauses.get(clauseNo) !== body) modified.push(clauseNo)
  }
  for (const clauseNo of oldClauses.keys()) {
    if (!newClauses.has(clauseNo)) removed.push(clauseNo)
  }
  return {
    mode: 'RULE_DIFF',
    added,
    modified,
    removed,
    affectedClauseNos: Array.from(new Set([...added, ...modified, ...removed])),
    summary: `新增 ${added.length} 条，修改 ${modified.length} 条，删除 ${removed.length} 条`,
  }
}

async function buildComplianceCyclePdfBuffer(title: string, lines: string[]) {
  const pdf = await PDFDocument.create()
  let font = await pdf.embedFont(StandardFonts.Helvetica)
  let hasCustomFont = false
  pdf.registerFontkit(fontkit)
  for (const candidate of PDF_FONT_CANDIDATES) {
    if (!existsSync(candidate) || !/\.(otf|ttf)$/i.test(candidate)) continue
    try {
      font = await pdf.embedFont(await readFile(candidate))
      hasCustomFont = true
      break
    } catch {
      // Fallback to Helvetica below.
    }
  }
  const rawText = [title, ...lines].join('\n')
  if (!hasCustomFont && hasNonAscii(rawText)) {
    throw Object.assign(new Error('PDF_CJK_FONT_MISSING'), { status: 500 })
  }

  const pageWidth = 595.28
  const pageHeight = 841.89
  const margin = 48
  const fontSize = 10
  const lineHeight = 16
  let page = pdf.addPage([pageWidth, pageHeight])
  let y = pageHeight - margin
  const draw = (raw: string, size = fontSize, tone: 'heading' | 'text' = 'text') => {
    const text = hasCustomFont ? raw : sanitizeForStandardFont(raw)
    for (const wrapped of wrapLine(text, size > fontSize ? 32 : 66)) {
      if (y < margin) {
        page = pdf.addPage([pageWidth, pageHeight])
        y = pageHeight - margin
      }
      page.drawText(wrapped || ' ', {
        x: margin,
        y,
        size,
        font,
        color: tone === 'heading' ? rgb(0.05, 0.18, 0.32) : rgb(0.12, 0.12, 0.12),
      })
      y -= size > fontSize ? lineHeight + 5 : lineHeight
    }
  }

  draw(title, 18, 'heading')
  y -= 8
  for (const line of lines) {
    if (line.startsWith('## ')) {
      y -= 4
      draw(line.replace(/^##\s+/, ''), 13, 'heading')
    } else {
      draw(line)
    }
  }
  return Buffer.from(await pdf.save())
}

async function resolveBoundEnterpriseForAdmin(req: AuthRequest): Promise<string> {
  if (req.userEnterpriseId) return req.userEnterpriseId
  const user = await prisma.appUser.findUnique({
    where: { id: req.userId! },
    select: { enterpriseId: true },
  })
  return user?.enterpriseId ?? DEFAULT_ENTERPRISE_ID
}

// ─── IP 限流（内存桶，1 分钟 3 次） ─────────────
const ipBucket = new Map<string, number[]>()
const IP_WINDOW_MS = 60_000
const IP_MAX = 3

function checkIpLimit(ip: string): boolean {
  const now = Date.now()
  const arr = (ipBucket.get(ip) || []).filter((t) => now - t < IP_WINDOW_MS)
  if (arr.length >= IP_MAX) {
    ipBucket.set(ip, arr)
    return false
  }
  arr.push(now)
  ipBucket.set(ip, arr)
  return true
}

// 测试钩子：清空内存桶
export function __resetEnterpriseIpBucket() {
  ipBucket.clear()
}

function getClientIp(req: Request): string {
  const xff = (req.headers['x-forwarded-for'] as string | undefined) || ''
  const first = xff.split(',')[0]?.trim()
  return first || req.ip || 'unknown'
}

// ─── 钉钉通知（失败静默） ────────────────────────
async function notifyDingtalk(payload: {
  name: string
  position: string
  company: string
  phone: string
  requirement: string
  createdAt: Date
}) {
  const url = process.env.ENTERPRISE_APPLY_WEBHOOK_URL || ''
  if (!url) return // 本地/未配置时跳过
  const secret = process.env.ENTERPRISE_APPLY_SIGN_SECRET || ''
  try {
    const signedUrl = buildDingtalkUrl(url, secret)
    const text =
      `**新企业申请**\n\n` +
      `- 姓名：${payload.name}（${payload.position}）\n` +
      `- 公司：${payload.company}\n` +
      `- 手机：${payload.phone}\n` +
      `- 需求：${payload.requirement || '未填写'}\n` +
      `- 时间：${payload.createdAt.toISOString()}`
    const body = JSON.stringify({
      msgtype: 'markdown',
      markdown: { title: '新企业申请', text },
    })
    await fetch(signedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    logger.warn({ err }, '[enterprise] dingtalk notify failed')
  }
}

export function registerEnterpriseRoutes(app: Express, aiCaller: (prompt: string) => Promise<string> = callStandardAI) {
  // 公开接口：提交申请
  app.post('/api/app/enterprise/apply', async (req, res) => {
    const parsed = ApplySchema.safeParse(normalizeApplyPayload(req.body))
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    }
    const data = parsed.data
    const ip = getClientIp(req)

    if (!checkIpLimit(ip)) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' })
    }

    // 同手机号 24h 去重：已有 pending 则只更新 updatedAt，不重推钉钉
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const existing = await prisma.enterpriseApplication.findFirst({
      where: { phone: data.phone, status: 'pending', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
    })
    if (existing) {
      await prisma.enterpriseApplication.update({
        where: { id: existing.id },
        data: { updatedAt: new Date() },
      })
      return res.json({ success: true, deduped: true })
    }

    const created = await prisma.enterpriseApplication.create({
      data: {
        name: data.name,
        position: data.position,
        company: data.company,
        phone: data.phone,
        requirement: data.requirement,
        ipAddress: ip,
      },
    })

    // 异步通知，不阻塞响应
    void notifyDingtalk({
      name: created.name,
      position: created.position,
      company: created.company,
      phone: created.phone,
      requirement: created.requirement,
      createdAt: created.createdAt,
    })

    res.json({ success: true })
  })

  // Admin：列表
  app.get(
    '/api/admin/enterprise/applications',
    requireAdmin as never,
    async (req, res) => {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined
      const page = Math.max(1, Number(req.query.page) || 1)
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20))
      const where = status && status !== 'all' ? { status } : {}
      const [data, total] = await Promise.all([
        prisma.enterpriseApplication.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.enterpriseApplication.count({ where }),
      ])
      res.json({ data, total })
    },
  )

  const EnterpriseActivateSchema = z.object({
    enterpriseName: z.string().trim().min(1).optional(),
    code: z.string().trim().min(1).optional(),
    enterpriseRole: z.enum(['ADMIN', 'MANAGER', 'REVIEWER', 'EMPLOYEE']).optional().default('MANAGER'),
  })

  // Admin：一键开通（创建 Enterprise + 把申请人按 phone 绑定/创建为 AppUser + 设企业角色）。
  // 新建客户平台 role 始终为 user；已有平台 admin 账号必须保留 admin 身份。
  app.post(
    '/api/admin/enterprise/applications/:id/activate',
    requireAdmin as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const application = await prisma.enterpriseApplication.findUnique({ where: { id } })
      if (!application) return res.status(404).json({ error: '申请不存在' })

      const parsed = EnterpriseActivateSchema.safeParse(req.body ?? {})
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const body = parsed.data
      const enterpriseName = (body.enterpriseName ?? application.company).trim()
      if (!enterpriseName) return res.status(400).json({ error: '企业名称不能为空' })

      // 生成唯一 code：优先用 body.code，否则按申请 id 生成稳定 code，保证重复开通同一申请可幂等复用企业。
      let code = (body.code ?? '').trim()
      if (!code) {
        code = `ENT-${application.id}`.toUpperCase()
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          // 1. 创建/复用 Enterprise（按 code 幂等）
          const existingEnt = await tx.enterprise.findUnique({ where: { code } })
          const enterprise = existingEnt
            ? existingEnt
            : await tx.enterprise.create({ data: { name: enterpriseName, code, status: 'ACTIVE' } })

          // 2. AppUser by phone：存在则更新，不存在则创建
          let defaultPassword: string | null = null
          const initialPassword = application.phone.slice(-6)
          let user = await tx.appUser.findUnique({ where: { phone: application.phone } })
          if (!user) {
            defaultPassword = initialPassword
            user = await tx.appUser.create({
              data: {
                id: `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                phone: application.phone,
                name: application.name,
                role: 'user',
                enterpriseId: enterprise.id,
                enterpriseRole: body.enterpriseRole,
                passwordHash: await hashPassword(initialPassword),
              },
            })
          } else {
            if (!user.passwordHash) defaultPassword = initialPassword
            user = await tx.appUser.update({
              where: { id: user.id },
              data: {
                role: user.role === 'admin' ? 'admin' : 'user',
                enterpriseId: enterprise.id,
                enterpriseRole: body.enterpriseRole,
                ...(!user.passwordHash ? { passwordHash: await hashPassword(initialPassword) } : {}),
              },
            })
          }

          // 3. 申请置 converted
          const updatedApp = await tx.enterpriseApplication.update({
            where: { id },
            data: { status: 'converted' },
          })

          return { enterprise, user, application: updatedApp, defaultPassword }
        })

        res.json({
          data: {
            enterprise: result.enterprise,
            user: { id: result.user.id, phone: result.user.phone, name: result.user.name, enterpriseRole: result.user.enterpriseRole },
            defaultPassword: result.defaultPassword,
            application: result.application,
          },
        })
      } catch (err) {
        const msg = (err as { message?: string })?.message || '开通失败'
        logger.warn({ err }, '[enterprise] activate failed')
        res.status(500).json({ error: msg })
      }
    },
  )

  // Admin：更新跟进状态。converted 只能由 /activate 事务写入，避免申请已转化但企业/成员未绑定。
  app.patch(
    '/api/admin/enterprise/applications/:id/status',
    requireAdmin as never,
    async (req, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const parsed = StatusSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: 'status 非法' })
      }
      const exists = await prisma.enterpriseApplication.findUnique({ where: { id } })
      if (!exists) return res.status(404).json({ error: '记录不存在' })
      const updated = await prisma.enterpriseApplication.update({
        where: { id },
        data: { status: parsed.data.status },
      })
      res.json({ data: updated })
    },
  )

  // ─── 企业版当前用户身份 ────────────────────────────
  // GET /api/enterprise/me — 返回 enterpriseId / enterpriseRole / enterpriseName
  // 用于企业版前端守卫与顶部栏显示。
  // admin 若已绑定企业，按绑定企业展示；未绑定才兼容 DEFAULT 平台视角。
  app.get('/api/enterprise/me', requireAuth as never, async (req: AuthRequest, res: Response) => {
    const user = await prisma.appUser.findUnique({
      where: { id: req.userId! },
      select: {
        id: true,
        phone: true,
        name: true,
        role: true,
        enterpriseId: true,
        enterpriseRole: true,
        passwordMustChange: true,
      },
    })
    if (!user) return res.status(404).json({ error: '用户不存在' })

    // admin 通配
    if (user.role === 'admin') {
      // admin 已绑定企业 → 返回真实企业（前端按真实 enterpriseId/Role 路由，不再伪装 DEFAULT）
      if (user.enterpriseId) {
        const ent = await prisma.enterprise.findUnique({ where: { id: user.enterpriseId } })
        return res.json({
          user: { id: user.id, phone: user.phone, name: user.name, role: user.role, passwordMustChange: user.passwordMustChange === true },
          enterpriseId: user.enterpriseId,
          enterpriseRole: user.enterpriseRole ?? 'ADMIN',
          enterpriseName: ent?.name ?? null,
          enterpriseStatus: ent?.status ?? null,
          isAdminBypass: true,
        })
      }
      // 纯平台管理员（无绑定企业）：保持 DEFAULT 以兼容后台管理
      const ent = await prisma.enterprise.findUnique({ where: { id: DEFAULT_ENTERPRISE_ID } })
      return res.json({
        user: { id: user.id, phone: user.phone, name: user.name, role: user.role, passwordMustChange: user.passwordMustChange === true },
        enterpriseId: DEFAULT_ENTERPRISE_ID,
        enterpriseRole: 'ADMIN',
        enterpriseName: ent?.name ?? '平台管理员',
        enterpriseStatus: ent?.status ?? 'ACTIVE',
        isAdminBypass: true,
      })
    }

    if (!user.enterpriseId || !user.enterpriseRole) {
      return res.json({
        user: { id: user.id, phone: user.phone, name: user.name, role: user.role, passwordMustChange: user.passwordMustChange === true },
        enterpriseId: null,
        enterpriseRole: null,
        enterpriseName: null,
        enterpriseStatus: null,
        isAdminBypass: false,
      })
    }

    const ent = await prisma.enterprise.findUnique({ where: { id: user.enterpriseId } })
    res.json({
      user: { id: user.id, phone: user.phone, name: user.name, role: user.role, passwordMustChange: user.passwordMustChange === true },
      enterpriseId: user.enterpriseId,
      enterpriseRole: user.enterpriseRole,
      enterpriseName: ent?.name ?? null,
      enterpriseStatus: ent?.status ?? null,
      isAdminBypass: false,
    })
  })

  // ─── 企业版：成员列表 ─────────────────────────────
  // GET /api/enterprise/members
  // admin 已绑定企业时返回绑定企业成员；未绑定时返回 DEFAULT 企业成员。
  app.get('/api/enterprise/members', requireAuth as never, async (req: AuthRequest, res: Response) => {
    if (req.userRole === 'admin') {
      const enterpriseId = await resolveBoundEnterpriseForAdmin(req)
      const user = await prisma.appUser.findUnique({
        where: { id: req.userId! },
        select: { id: true, phone: true, name: true, enterpriseRole: true, passwordMustChange: true },
      })
      if (!user) return res.status(404).json({ error: '用户不存在' })
      const enterpriseMembers = await prisma.appUser.findMany({
        where: { enterpriseId },
        select: { id: true, phone: true, name: true, enterpriseRole: true, passwordMustChange: true },
        orderBy: { createdAt: 'asc' },
      })
      const all = enterpriseMembers.length > 0
        ? enterpriseMembers
        : [{ id: user.id, phone: user.phone, name: user.name, enterpriseRole: 'ADMIN', passwordMustChange: user.passwordMustChange }]
      return res.json({ data: all.map((u) => ({ id: u.id, phone: u.phone, nickName: u.name, enterpriseRole: u.enterpriseRole, passwordMustChange: u.passwordMustChange === true })) })
    }

    const me = await prisma.appUser.findUnique({
      where: { id: req.userId! },
      select: { enterpriseId: true, enterpriseRole: true },
    })
    if (!me?.enterpriseId || !me?.enterpriseRole) {
      return res.status(403).json({ error: '当前账号未绑定企业，无权访问' })
    }

    const members = await prisma.appUser.findMany({
      where: { enterpriseId: me.enterpriseId },
      select: { id: true, phone: true, name: true, enterpriseRole: true, passwordMustChange: true },
      orderBy: { createdAt: 'asc' },
    })
    res.json({ data: members.map((u) => ({ id: u.id, phone: u.phone, nickName: u.name, enterpriseRole: u.enterpriseRole, passwordMustChange: u.passwordMustChange === true })) })
  })

  // ─── 企业版：成员管理（ADMIN only）─────────────────
  // POST   /api/enterprise/members         — 添加（按手机号查/建，绑定本企业）
  // PATCH  /api/enterprise/members/:id     — 改角色
  // DELETE /api/enterprise/members/:id     — 移除（解绑 enterpriseId/Role）

  const ENTERPRISE_ROLES = ['ADMIN', 'MANAGER', 'REVIEWER', 'EMPLOYEE'] as const

  async function requireEnterpriseAdmin(req: AuthRequest, res: Response): Promise<{ enterpriseId: string } | null> {
    if (req.userRole === 'admin') return { enterpriseId: await resolveBoundEnterpriseForAdmin(req) }
    const me = await prisma.appUser.findUnique({
      where: { id: req.userId! },
      select: { enterpriseId: true, enterpriseRole: true },
    })
    if (!me?.enterpriseId || !me?.enterpriseRole) {
      res.status(403).json({ error: '当前账号未绑定企业，无权访问' })
      return null
    }
    if (me.enterpriseRole !== 'ADMIN') {
      res.status(403).json({ error: '仅企业 ADMIN 可执行此操作' })
      return null
    }
    return { enterpriseId: me.enterpriseId }
  }

  app.post(
    '/api/enterprise/members',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const ctx = await requireEnterpriseAdmin(req, res)
      if (!ctx) return
      const phone = String((req.body?.phone ?? '')).trim()
      const name = req.body?.name ? String(req.body.name).trim() : null
      const roleInput = String((req.body?.enterpriseRole ?? 'EMPLOYEE')).trim().toUpperCase()
      if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式错误' })
      if (!(ENTERPRISE_ROLES as readonly string[]).includes(roleInput)) {
        return res.status(400).json({ error: 'enterpriseRole 非法' })
      }

      const existing = await prisma.appUser.findUnique({ where: { phone } })
      if (existing) {
        if (existing.enterpriseId && existing.enterpriseId !== ctx.enterpriseId) {
          return res.status(409).json({ error: '该手机号已属于其他企业，请联系平台管理员处理' })
        }
        const temporaryPassword = existing.passwordHash ? null : generateTempPassword()
        const updated = await prisma.appUser.update({
          where: { id: existing.id },
          data: {
            enterpriseId: ctx.enterpriseId,
            enterpriseRole: roleInput,
            ...(name && !existing.name ? { name } : {}),
            ...(temporaryPassword
              ? { passwordHash: await hashPassword(temporaryPassword), passwordMustChange: true }
              : {}),
          },
        })
        return res.status(200).json({
          data: { id: updated.id, phone: updated.phone, nickName: updated.name, enterpriseRole: updated.enterpriseRole, passwordMustChange: updated.passwordMustChange === true },
          temporaryPassword,
        })
      }

      const temporaryPassword = generateTempPassword()
      const created = await prisma.appUser.create({
        data: {
          id: `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          phone,
          name,
          role: 'user',
          enterpriseId: ctx.enterpriseId,
          enterpriseRole: roleInput,
          passwordHash: await hashPassword(temporaryPassword),
          passwordMustChange: true,
        },
      })
      res.status(201).json({
        data: { id: created.id, phone: created.phone, nickName: created.name, enterpriseRole: created.enterpriseRole, passwordMustChange: created.passwordMustChange === true },
        temporaryPassword,
      })
    },
  )

  app.patch(
    '/api/enterprise/members/:id',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const ctx = await requireEnterpriseAdmin(req, res)
      if (!ctx) return
      const id = String(req.params.id || '').trim()

      // 兼容旧客户端 action；新客户端调用独立 reset-password 端点。
      if (req.body?.action === 'resetPassword') {
        return resetEnterpriseMemberPassword(id, ctx.enterpriseId, res)
      }

      const roleInput = String((req.body?.enterpriseRole ?? '')).trim().toUpperCase()
      if (!(ENTERPRISE_ROLES as readonly string[]).includes(roleInput)) {
        return res.status(400).json({ error: 'enterpriseRole 非法' })
      }
      // 不能改自己（防止 ADMIN 把自己降级锁死）
      if (id === req.userId) return res.status(400).json({ error: '不能修改自己的角色，请由其他 ADMIN 操作' })

      const target = await prisma.appUser.findUnique({
        where: { id },
        select: { id: true, enterpriseId: true },
      })
      if (!target || target.enterpriseId !== ctx.enterpriseId) {
        return res.status(404).json({ error: '成员不存在或不属于本企业' })
      }
      const updated = await prisma.appUser.update({
        where: { id },
        data: { enterpriseRole: roleInput },
      })
      res.json({
        data: { id: updated.id, phone: updated.phone, nickName: updated.name, enterpriseRole: updated.enterpriseRole, passwordMustChange: updated.passwordMustChange === true },
      })
    },
  )

  async function resetEnterpriseMemberPassword(id: string, enterpriseId: string, res: Response) {
    const target = await prisma.appUser.findUnique({
      where: { id },
      select: { id: true, phone: true, enterpriseId: true },
    })
    if (!target || target.enterpriseId !== enterpriseId) {
      return res.status(404).json({ error: '成员不存在或不属于本企业' })
    }
    if (!target.phone) {
      return res.status(400).json({ error: '该成员无手机号，无法重置密码' })
    }
    const temporaryPassword = generateTempPassword()
    const newHash = await hashPassword(temporaryPassword)
    await prisma.appUser.update({
      where: { id },
      data: { passwordHash: newHash, passwordMustChange: true },
    })
    return res.json({ ok: true, temporaryPassword, passwordMustChange: true })
  }

  app.post(
    '/api/enterprise/members/:id/reset-password',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const ctx = await requireEnterpriseAdmin(req, res)
      if (!ctx) return
      const id = String(req.params.id || '').trim()
      return resetEnterpriseMemberPassword(id, ctx.enterpriseId, res)
    },
  )

  app.delete(
    '/api/enterprise/members/:id',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const ctx = await requireEnterpriseAdmin(req, res)
      if (!ctx) return
      const id = String(req.params.id || '').trim()
      if (id === req.userId) return res.status(400).json({ error: '不能移除自己' })

      const target = await prisma.appUser.findUnique({
        where: { id },
        select: { id: true, enterpriseId: true },
      })
      if (!target || target.enterpriseId !== ctx.enterpriseId) {
        return res.status(404).json({ error: '成员不存在或不属于本企业' })
      }
      await prisma.appUser.update({
        where: { id },
        data: { enterpriseId: null, enterpriseRole: null },
      })
      res.json({ ok: true })
    },
  )

  // POST /api/enterprise/members/batch-remove — 批量移除（解绑 enterpriseId/Role）
  // 只动本企业成员，且永不移除自己（NOT id=self）；其余项落入 skipped。
  app.post(
    '/api/enterprise/members/batch-remove',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const ctx = await requireEnterpriseAdmin(req, res)
      if (!ctx) return
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const result = await prisma.appUser.updateMany({
        where: {
          id: { in: parsed.data.ids },
          enterpriseId: ctx.enterpriseId,
          NOT: { id: req.userId! },
        },
        data: { enterpriseId: null, enterpriseRole: null },
      })
      res.json({
        ok: result.count,
        requested: parsed.data.ids.length,
        skipped: parsed.data.ids.length - result.count,
      })
    },
  )

  // ─── 企业版：题库管理 ─────────────────────────────
  // /api/enterprise/standard-execution/question-banks (list/detail/create/update/delete)
  // 权限与其他 SE 企业版一致：resolveEnterpriseId（admin→DEFAULT / 企业成员→本企业），enterpriseId 隔离。
  app.get(
    '/api/enterprise/standard-execution/question-banks',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可管理题库' })
      }
      const keyword = (req.query.keyword ? String(req.query.keyword) : '').trim()
      const page = Math.max(1, Number(req.query.page) || 1)
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20))
      const where: Record<string, unknown> = {
        enterpriseId,
        deletedAt: null,
        ...(keyword ? { title: { contains: keyword, mode: 'insensitive' } } : {}),
      }
      const [data, total] = await Promise.all([
        prisma.sEQuestionBank.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            title: true,
            description: true,
            questions: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { tasks: { where: { deletedAt: null } } } },
          },
        }),
        prisma.sEQuestionBank.count({ where }),
      ])
      const rows = data.map((b) => ({
        id: b.id,
        title: b.title,
        description: b.description,
        questionCount: Array.isArray(b.questions) ? (b.questions as unknown[]).length : 0,
        taskCount: b._count.tasks,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
      }))
      res.json({ data: rows, total, page, pageSize })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/question-banks/:id',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可管理题库' })
      }
      const id = String(req.params.id || '').trim()
      const bank = await prisma.sEQuestionBank.findFirst({ where: { id, enterpriseId, deletedAt: null } })
      if (!bank) return res.status(404).json({ error: '题库不存在' })
      res.json(bank)
    },
  )

  app.post(
    '/api/enterprise/standard-execution/question-banks',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可管理题库' })
      }
      const parsed = BankCreateSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message })
      const bank = await prisma.sEQuestionBank.create({
        data: {
          enterpriseId,
          title: parsed.data.title,
          description: parsed.data.description ?? null,
          questions: parsed.data.questions as never,
          createdBy: req.userId!,
        },
      })
      res.status(201).json(bank)
    },
  )

  app.patch(
    '/api/enterprise/standard-execution/question-banks/:id',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可管理题库' })
      }
      const id = String(req.params.id || '').trim()
      const existing = await prisma.sEQuestionBank.findFirst({ where: { id, enterpriseId, deletedAt: null } })
      if (!existing) return res.status(404).json({ error: '题库不存在' })
      const parsed = BankUpdateSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message })
      const updated = await prisma.sEQuestionBank.update({
        where: { id },
        data: {
          ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
          ...(parsed.data.description !== undefined ? { description: parsed.data.description ?? null } : {}),
          ...(parsed.data.questions !== undefined ? { questions: parsed.data.questions as never } : {}),
        },
      })
      res.json(updated)
    },
  )

  app.delete(
    '/api/enterprise/standard-execution/question-banks/:id',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可管理题库' })
      }
      const id = String(req.params.id || '').trim()
      const existing = await prisma.sEQuestionBank.findFirst({ where: { id, enterpriseId, deletedAt: null } })
      if (!existing) return res.status(404).json({ error: '题库不存在' })
      const inUse = await prisma.standardExecutionTask.count({
        where: { quizBankId: id, deletedAt: null, status: { in: ['DRAFT', 'PUBLISHED'] } },
      })
      if (inUse > 0) return res.status(409).json({ error: `该题库还被 ${inUse} 个任务使用，无法删除` })
      await prisma.sEQuestionBank.update({ where: { id }, data: { deletedAt: new Date() } })
      res.json({ ok: true })
    },
  )

  // ─── 企业版：题库 AI 生成题目（P1-9）──────────────
  // POST /api/enterprise/standard-execution/question-banks/ai-generate
  // 复用 callStandardAI（可注入 aiCaller 便于测试）；只返回预览题目，由前端确认后才走 create/update 入库。
  app.post(
    '/api/enterprise/standard-execution/question-banks/ai-generate',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = AiGenerateQuestionsSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可管理题库' })
      }

      // 出题依据：requirementText 优先；否则按 requirementId 取执行要求正文 + 可执行描述
      let sourceText = (parsed.data.requirementText || '').trim()
      if (!sourceText && parsed.data.requirementId) {
        const reqRow = await prisma.standardExecutionRequirement.findFirst({
          where: { id: parsed.data.requirementId, enterpriseId },
          select: { title: true, requirementText: true, executionDescription: true },
        })
        if (!reqRow) return res.status(404).json({ error: '执行要求不存在或不属于当前企业' })
        sourceText = [reqRow.title, reqRow.requirementText, reqRow.executionDescription].filter(Boolean).join('\n')
      }
      if (!sourceText) return res.status(400).json({ error: '缺少出题依据（requirementId 或 requirementText）' })

      try {
        const questions = await generateQuizQuestions(
          sourceText,
          { count: parsed.data.count, questionType: parsed.data.questionType, difficulty: parsed.data.difficulty },
          aiCaller,
        )
        // P1-9: 注入来源执行要求 id，供前端显示来源
        const withRel = parsed.data.requirementId
          ? questions.map((q) => ({ ...q, relatedRequirementId: parsed.data.requirementId }))
          : questions
        res.json({ data: { questions: withRel } })
      } catch (e) {
        if (e instanceof AiQuizInvalidError) return res.status(422).json({ error: e.message })
        if (e instanceof AiNotConfiguredError) return res.status(503).json({ error: 'AI 服务未配置，请联系管理员' })
        if (e instanceof AiCallFailedError) return res.status(502).json({ error: 'AI 调用失败，请稍后重试' })
        return res.status(500).json({ error: (e as Error).message })
      }
    },
  )

  // ─── 企业版：标准来源只读列表 ─────────────────────
  // GET /api/enterprise/standard-execution/sources
  // 供企业版要求项管理页的「规则解析」弹窗下拉使用。
  // admin 已绑定企业时使用绑定企业；未绑定才兼容 DEFAULT。
  app.get(
    '/api/enterprise/standard-execution/sources',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = SourceListQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const { sourceType, status, keyword, page, pageSize } = parsed.data

      // 解析 enterpriseId：admin 优先使用绑定企业，其余从 DB 取
      let enterpriseId: string
      if (req.userRole === 'admin') {
        enterpriseId = await resolveBoundEnterpriseForAdmin(req)
      } else {
        const user = await prisma.appUser.findUnique({
          where: { id: req.userId! },
          select: { enterpriseId: true, enterpriseRole: true },
        })
        if (!user?.enterpriseId || !user?.enterpriseRole) {
          return res.status(403).json({ error: '当前账号未绑定企业，无权访问' })
        }
        enterpriseId = user.enterpriseId
      }

      const where: Record<string, unknown> = { enterpriseId }
      if (sourceType) where.sourceType = sourceType
      if (status) where.status = Array.isArray(status) ? { in: status } : status
      if (keyword) {
        where.OR = [
          { title: { contains: keyword, mode: 'insensitive' } },
          { sourceNo: { contains: keyword, mode: 'insensitive' } },
        ]
      }

      const [data, total] = await Promise.all([
        prisma.standardExecutionSource.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.standardExecutionSource.count({ where }),
      ])
      res.json({ data, total, page, pageSize })
    },
  )

  // ─── 企业版：要求项只读列表 ───────────────────────
  // GET /api/enterprise/standard-execution/requirements
  app.get(
    '/api/enterprise/standard-execution/requirements',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = RequirementListQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const { sourceId, status, generateMode, keyword, sourceKeyword, page, pageSize } = parsed.data

      let enterpriseId: string
      if (req.userRole === 'admin') {
        enterpriseId = await resolveBoundEnterpriseForAdmin(req)
      } else {
        const user = await prisma.appUser.findUnique({
          where: { id: req.userId! },
          select: { enterpriseId: true, enterpriseRole: true },
        })
        if (!user?.enterpriseId || !user?.enterpriseRole) {
          return res.status(403).json({ error: '当前账号未绑定企业，无权访问' })
        }
        enterpriseId = user.enterpriseId
      }

      const where: Record<string, unknown> = { enterpriseId }
      if (sourceId) where.sourceId = sourceId
      if (status) where.status = Array.isArray(status) ? { in: status } : status
      if (generateMode) where.generateMode = generateMode
      if (keyword) {
        where.OR = [
          { title: { contains: keyword, mode: 'insensitive' } },
          { clauseNo: { contains: keyword, mode: 'insensitive' } },
        ]
      }
      if (sourceKeyword) where.source = { title: { contains: sourceKeyword, mode: 'insensitive' } }

      const [rows, total] = await Promise.all([
        prisma.standardExecutionRequirement.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.standardExecutionRequirement.count({ where }),
      ])
      // P1-7/B4: 附加关联任务统计 + 控制点健康状态，批量查询避免 N+1。
      const withTaskStats = await attachRequirementTaskStats(enterpriseId, rows)
      const data = await attachRequirementHealth(enterpriseId, withTaskStats)
      res.json({ data, total, page, pageSize })
    },
  )

  // ─── 企业版：任务管理 ─────────────────────────────
  // GET  /api/enterprise/standard-execution/tasks          — 列表
  // POST /api/enterprise/standard-execution/tasks          — 创建
  // POST /api/enterprise/standard-execution/tasks/:id/submit-approval
  // POST /api/enterprise/standard-execution/tasks/:id/approval/approve
  // POST /api/enterprise/standard-execution/tasks/:id/approval/reject
  // POST /api/enterprise/standard-execution/tasks/:id/cancel
  // GET  /api/enterprise/standard-execution/tasks/:id/progress

  /** 解析当前请求的 enterpriseId（企业版通用）*/
  async function resolveEnterpriseId(req: AuthRequest, res: Response): Promise<string | null> {
    if (req.userRole === 'admin') return resolveBoundEnterpriseForAdmin(req)
    const user = await prisma.appUser.findUnique({
      where: { id: req.userId! },
      select: { enterpriseId: true, enterpriseRole: true },
    })
    if (!user?.enterpriseId || !user?.enterpriseRole) {
      res.status(403).json({ error: '当前账号未绑定企业，无权访问' })
      return null
    }
    return user.enterpriseId
  }

  function withOverdue<T extends {
    status: string
    deadlineAt: Date | null
    taskType?: string | null
    checklistSchema?: unknown
    parametersSchema?: unknown
    learningMaterials?: unknown
    quizBankId?: string | null
    items?: unknown[]
  }>(task: T): T & { isOverdue: boolean; submitFormConfig: ReturnType<typeof withSubmitFormConfig>['submitFormConfig'] } {
    const isOverdue = task.status === 'PUBLISHED' && !!task.deadlineAt && task.deadlineAt.getTime() < Date.now()
    return withSubmitFormConfig({ ...task, isOverdue })
  }

  function handleTaskApprovalError(res: Response, err: unknown) {
    if (err instanceof TaskApprovalError) {
      return res.status(err.status).json({ error: err.message })
    }
    throw err
  }

  function canReviewTaskApproval(req: AuthRequest, task: { reviewerId: string | null }) {
    if (req.userRole === 'admin') return true
    if (req.userEnterpriseRole === 'ADMIN' || req.userEnterpriseRole === 'MANAGER') return true
    return task.reviewerId === req.userId
  }

  async function validateEnterpriseUsers(
    enterpriseId: string,
    reviewerId?: string,
    assigneeIds: string[] = [],
  ) {
    const ids = Array.from(new Set([...(reviewerId ? [reviewerId] : []), ...assigneeIds]))
    if (ids.length === 0) {
      return { reviewerOk: true, missingAssignees: [] }
    }

    const found = await prisma.appUser.findMany({
      where: {
        id: { in: ids },
        OR: [{ enterpriseId }, { role: 'admin' }],
      },
      select: { id: true },
    })
    const foundSet = new Set(found.map((u) => u.id))
    return {
      reviewerOk: reviewerId ? foundSet.has(reviewerId) : true,
      missingAssignees: assigneeIds.filter((id) => !foundSet.has(id)),
    }
  }

  app.get(
    '/api/enterprise/standard-execution/tasks/list-v2',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = TaskListV2QuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const result = await buildManagementTaskListV2(enterpriseId, parsed.data, req.userId)
      res.json(result)
    },
  )

  app.get(
    '/api/enterprise/standard-execution/tasks',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = TaskListQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return

      const { requirementId, status, origin, reviewerId, assigneeId, keyword, page, pageSize } = parsed.data
      const where: Record<string, unknown> = { enterpriseId }
      if (requirementId) where.requirementId = requirementId
      if (status) where.status = Array.isArray(status) ? { in: status } : status
      if (origin === 'PLAN') where.planId = { not: null }
      if (origin === 'MANUAL') where.planId = null
      if (reviewerId) where.reviewerId = reviewerId
      if (keyword) where.title = { contains: keyword, mode: 'insensitive' }
      if (assigneeId) where.assignees = { some: { assigneeId } }

      const [rows, total] = await Promise.all([
        prisma.standardExecutionTask.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.standardExecutionTask.count({ where }),
      ])
      res.json({ data: rows.map(withOverdue), total, page, pageSize })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/tasks',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = TaskCreateSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return

      let requirement: (RequirementForSnapshot & { status: string }) | null = null
      if (parsed.data.requirementId) {
        requirement = await prisma.standardExecutionRequirement.findFirst({
          where: { id: parsed.data.requirementId, enterpriseId },
          select: {
            id: true,
            sourceId: true,
            clauseNo: true,
            title: true,
            requirementText: true,
            status: true,
            recommendedTaskType: true,
            executionDescription: true,
            submitRequirement: true,
            source: {
              select: {
                id: true,
                title: true,
                sourceNo: true,
                sourceType: true,
                version: true,
                isLatestVersion: true,
              },
            },
          },
        })
        if (!requirement) {
          return res.status(400).json({ error: 'requirementId 对应的执行要求不存在' })
        }
        if (requirement.status !== 'ACTIVE') {
          return res.status(400).json({ error: `仅 ACTIVE 执行要求可创建任务（当前 ${requirement.status}）` })
        }
        if (requirement.source?.isLatestVersion === false) {
          return res.status(400).json({ error: '旧版本标准不可创建任务，请先复核并切换到最新版本' })
        }
      }

      // DRAFT 可零校验保存；只要填了执行人，就必须同时填审核人并校验归属。
      const { reviewerId, assigneeIds } = parsed.data
      if (reviewerId || assigneeIds.length > 0) {
        if (!reviewerId) return res.status(400).json({ error: '选择执行人时必须同时选择审核人' })
        const userCheck = await validateEnterpriseUsers(enterpriseId, reviewerId, assigneeIds)
        if (!userCheck.reviewerOk) {
          return res.status(400).json({ error: 'reviewerId 对应用户不存在或不属于本企业' })
        }
        if (userCheck.missingAssignees.length > 0) {
          return res.status(400).json({
            error: `assigneeIds 含不存在或不属于本企业的用户：${userCheck.missingAssignees.join(', ')}`,
          })
        }
      }

      const created = await prisma.$transaction(async (tx) => {
        const task = await tx.standardExecutionTask.create({
          data: {
            enterpriseId,
            requirementId: parsed.data.requirementId ?? null,
            title: parsed.data.title,
            description: parsed.data.description ?? null,
            taskType: parsed.data.taskType ?? null,
            submitRequirement: parsed.data.submitRequirement ?? null,
            deadlineAt: parsed.data.deadlineAt ?? null,
            deadlineMode: parsed.data.deadlineMode,
            deadlineDaysAfterApproval: parsed.data.deadlineDaysAfterApproval ?? null,
            reviewerId: parsed.data.reviewerId ?? null,
            checklistSchema: (parsed.data.checklistSchema ?? Prisma.DbNull) as Prisma.InputJsonValue,
            parametersSchema: (parsed.data.parametersSchema ?? Prisma.DbNull) as Prisma.InputJsonValue,
            learningMaterials: (parsed.data.learningMaterials ?? Prisma.DbNull) as Prisma.InputJsonValue,
            basisSnapshots: requirement ? buildBasisSnapshots([requirement]) as unknown as Prisma.InputJsonValue : [],
            quizBankId: parsed.data.quizBankId ?? null,
            createdBy: req.userId!,
          },
        })
        if (parsed.data.assigneeIds.length > 0) {
          await tx.standardExecutionTaskAssignee.createMany({
            data: parsed.data.assigneeIds.map((aid) => ({ enterpriseId, taskId: task.id, assigneeId: aid })),
          })
        }
        return task
      })
      res.status(201).json({ data: withOverdue(created) })
    },
  )

  type GroupableRequirement = {
    id: string
    sourceId: string
    clauseNo: string | null
    title: string
    requirementText: string
    recommendedTaskType: string | null
    executionDescription: string | null
    submitRequirement: string | null
    source: {
      id: string
      title: string
      sourceNo: string | null
      sourceType: string
      version: string | null
      isLatestVersion?: boolean
    } | null
  }

  async function createGroupedPlanTasks(
    tx: Prisma.TransactionClient,
    opts: {
      enterpriseId: string
      planId: string | null
      planTitle: string
      requirements: GroupableRequirement[]
      forcedTaskType?: string | null
      titlePrefix?: string | null
      submitRequirement?: string | null
      deadlineAt: Date | null
      deadlineMode?: string
      deadlineDaysAfterApproval?: number | null
      reviewerId?: string | null
      assigneeIds?: string[]
      quizBankId?: string | null
      taskStatus?: 'DRAFT' | 'PENDING_APPROVAL'
      createdBy: string
    },
  ) {
    const groups = new Map<string, GroupableRequirement[]>()
    for (const requirement of opts.requirements) {
      const taskType = opts.forcedTaskType?.trim() || requirement.recommendedTaskType || 'OTHER'
      groups.set(taskType, [...(groups.get(taskType) ?? []), requirement])
    }

    const prefix = (opts.titlePrefix || '').trim()
    const defaultSubmitRequirement = '请上传完成证明材料（图片或文档）并填写说明'
    const tasks = []
    let createdItems = 0
    const taskStatus = opts.taskStatus ?? 'DRAFT'
    const submittedForApprovalAt = taskStatus === 'PENDING_APPROVAL' ? new Date() : null
    const assigneeIds = opts.assigneeIds ?? []
    if (taskStatus === 'PENDING_APPROVAL') {
      if (!opts.reviewerId) {
        throw new Error('创建待审核任务必须指定审核人')
      }
      if (assigneeIds.length === 0) {
        throw new Error('创建待审核任务必须指定执行人')
      }
      if ((opts.deadlineMode ?? 'FIXED') === 'FIXED' && !opts.deadlineAt) {
        throw new Error('创建待审核任务必须指定截止时间')
      }
    }

    for (const [taskType, group] of groups) {
      const taskTitle = prefix ? `${prefix} - ${taskType}` : `${opts.planTitle} - ${taskType}`
      const description = group
        .map((r, i) => {
          const head = [r.clauseNo, r.title].filter(Boolean).join(' ')
          return `${i + 1}. ${head}\n${r.executionDescription || r.requirementText}`
        })
        .join('\n\n')
        .slice(0, 2000)
      const submitRequirement =
        opts.submitRequirement?.trim() ||
        group.find((r) => r.submitRequirement?.trim())?.submitRequirement?.trim() ||
        defaultSubmitRequirement

      const task = await tx.standardExecutionTask.create({
        data: {
          enterpriseId: opts.enterpriseId,
          planId: opts.planId,
          requirementId: group.length === 1 ? group[0].id : null,
          title: taskTitle,
          description,
          taskType,
          submitRequirement,
          deadlineAt: opts.deadlineAt,
          deadlineMode: opts.deadlineMode ?? 'FIXED',
          deadlineDaysAfterApproval: opts.deadlineDaysAfterApproval ?? null,
          reviewerId: opts.reviewerId ?? null,
          status: taskStatus,
          submittedForApprovalAt,
          basisSnapshots: buildBasisSnapshots(group) as unknown as Prisma.InputJsonValue,
          quizBankId: opts.quizBankId ?? null,
          createdBy: opts.createdBy,
        },
      })
      tasks.push(task)

      if (taskStatus === 'PENDING_APPROVAL') {
        await tx.standardExecutionTaskApprovalLog.create({
          data: {
            enterpriseId: opts.enterpriseId,
            taskId: task.id,
            action: 'SUBMIT_APPROVAL',
            fromStatus: 'DRAFT',
            toStatus: 'PENDING_APPROVAL',
            reviewerId: opts.createdBy,
          },
        })
      }

      await tx.standardExecutionTaskItem.createMany({
        data: group.map((requirement) => ({
          taskId: task.id,
          requirementId: requirement.id,
          status: 'PENDING',
        })),
      })
      createdItems += group.length

      if (assigneeIds.length > 0) {
        await tx.standardExecutionTaskAssignee.createMany({
          data: assigneeIds.map((assigneeId) => ({
            enterpriseId: opts.enterpriseId,
            taskId: task.id,
            assigneeId,
            status: 'PENDING',
          })),
        })
      }
    }

    return {
      tasks,
      createdTasks: tasks.length,
      createdItems,
      groups: Array.from(groups, ([taskType, requirements]) => ({
        taskType,
        requirementIds: requirements.map((r) => r.id),
      })),
    }
  }

  app.post(
    '/api/enterprise/standard-execution/requirements/batch-create-tasks',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = BatchCreateTasksFromRequirementsSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return

      const requirements = await prisma.standardExecutionRequirement.findMany({
        where: { id: { in: parsed.data.requirementIds }, enterpriseId },
        select: {
          id: true,
          sourceId: true,
          clauseNo: true,
          title: true,
          requirementText: true,
          status: true,
          recommendedTaskType: true,
          executionDescription: true,
          submitRequirement: true,
          source: {
            select: {
              id: true,
              title: true,
              sourceNo: true,
              sourceType: true,
              version: true,
              isLatestVersion: true,
            },
          },
        },
      })
      if (requirements.length !== parsed.data.requirementIds.length) {
        return res.status(400).json({ error: '部分执行要求不存在或不属于当前企业' })
      }
      const inactive = requirements.filter((r) => r.status !== 'ACTIVE')
      if (inactive.length > 0) {
        return res.status(400).json({ error: `仅 ACTIVE 执行要求可生成任务：${inactive.map((r) => r.title).join('、')}` })
      }

      const assigneeIds = parsed.data.assigneeIds ?? []
      if (parsed.data.reviewerId || assigneeIds.length > 0) {
        if (!parsed.data.reviewerId) {
          return res.status(400).json({ error: '选择执行人时必须同时选择审核人' })
        }
        const userCheck = await validateEnterpriseUsers(enterpriseId, parsed.data.reviewerId, assigneeIds)
        if (!userCheck.reviewerOk) {
          return res.status(400).json({ error: 'reviewerId 对应用户不存在或不属于本企业' })
        }
        if (userCheck.missingAssignees.length > 0) {
          return res.status(400).json({
            error: `assigneeIds 含不存在或不属于本企业的用户：${userCheck.missingAssignees.join(', ')}`,
          })
        }
      }

      const byId = new Map(requirements.map((r) => [r.id, r]))
      const orderedRequirements = parsed.data.requirementIds.map((id) => byId.get(id)!)
      const prefix = (parsed.data.titlePrefix || '').trim()

      // P1-1 去 Plan 化：不再创建已废弃的 StandardExecutionPlan。Plan.enterpriseId 对 Enterprise 有强 FK，
      // 而平台超管走企业版会被 resolveEnterpriseId 通配为 'DEFAULT'（Enterprise 表无此记录）→ 建 Plan 撞 P2003 → 整批 500。
      // Task/TaskItem 的 enterpriseId 无 FK，直接基于 Requirement 建任务（同类型合 1 Task + 每 Requirement 1 TaskItem），planId 留空。
      const batchTitle = prefix || `批量执行 ${new Date().toISOString().slice(0, 10)}`
      const created = await prisma.$transaction((tx) =>
        createGroupedPlanTasks(tx, {
          enterpriseId,
          planId: null,
          planTitle: batchTitle,
          requirements: orderedRequirements,
          forcedTaskType: parsed.data.taskType ?? null,
          titlePrefix: prefix || null,
          submitRequirement: parsed.data.submitRequirement,
          deadlineAt: parsed.data.deadlineAt ?? null,
          deadlineMode: parsed.data.deadlineMode,
          deadlineDaysAfterApproval: parsed.data.deadlineDaysAfterApproval ?? null,
          reviewerId: parsed.data.reviewerId,
          assigneeIds,
          quizBankId: parsed.data.quizBankId ?? null,
          createdBy: req.userId!,
        }),
      )

      res.status(201).json({
        data: created.tasks.map(withOverdue),
        planId: null,
        createdCount: created.createdTasks,
        createdItems: created.createdItems,
        groups: created.groups,
      })
    },
  )

  app.patch(
    '/api/enterprise/standard-execution/tasks/:id',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const parsed = TaskUpdateSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return

      const exists = await prisma.standardExecutionTask.findFirst({
        where: { id, enterpriseId },
        select: { id: true, status: true, reviewerId: true },
      })
      if (!exists) return res.status(404).json({ error: '记录不存在' })
      // DRAFT 全字段可改；PUBLISHED 仅安全字段 + 追加执行人；其余状态不可改
      if (exists.status !== 'DRAFT' && exists.status !== 'PUBLISHED') {
        return res.status(409).json({ error: `仅 DRAFT / PUBLISHED 任务可编辑（当前 ${exists.status}）` })
      }
      const isPublished = exists.status === 'PUBLISHED'

      if (parsed.data.reviewerId || parsed.data.assigneeIds) {
        const reviewerIdForCheck = parsed.data.reviewerId ?? exists.reviewerId
        if (!reviewerIdForCheck && (parsed.data.assigneeIds?.length ?? 0) > 0) {
          return res.status(400).json({ error: '选择执行人时必须同时选择审核人' })
        }
        const userCheck = await validateEnterpriseUsers(
          enterpriseId,
          reviewerIdForCheck ?? '',
          parsed.data.assigneeIds ?? [],
        )
        if (reviewerIdForCheck && !userCheck.reviewerOk) {
          return res.status(400).json({ error: 'reviewerId 对应用户不存在或不属于本企业' })
        }
        if (userCheck.missingAssignees.length > 0) {
          return res.status(400).json({
            error: `assigneeIds 含不存在或不属于本企业的用户：${userCheck.missingAssignees.join(', ')}`,
          })
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        const taskUpdate: Record<string, unknown> = { updatedBy: req.userId! }
        if (parsed.data.title !== undefined) taskUpdate.title = parsed.data.title
        if (parsed.data.description !== undefined) taskUpdate.description = parsed.data.description
        // 安全字段：DRAFT / PUBLISHED 都可改
        if (parsed.data.submitRequirement !== undefined) taskUpdate.submitRequirement = parsed.data.submitRequirement
        if (parsed.data.deadlineAt !== undefined) taskUpdate.deadlineAt = parsed.data.deadlineAt
        if (parsed.data.deadlineMode !== undefined) taskUpdate.deadlineMode = parsed.data.deadlineMode
        if (parsed.data.deadlineDaysAfterApproval !== undefined)
          taskUpdate.deadlineDaysAfterApproval = parsed.data.deadlineDaysAfterApproval ?? null
        if (parsed.data.reviewerId !== undefined) taskUpdate.reviewerId = parsed.data.reviewerId
        // 结构字段：仅 DRAFT 可改（PUBLISHED 禁改任务类型/检查项/参数/学习材料/题库）
        if (!isPublished) {
          if (parsed.data.taskType !== undefined) taskUpdate.taskType = parsed.data.taskType
          if (parsed.data.checklistSchema !== undefined)
            taskUpdate.checklistSchema = parsed.data.checklistSchema ?? Prisma.DbNull
          if (parsed.data.parametersSchema !== undefined)
            taskUpdate.parametersSchema = parsed.data.parametersSchema ?? Prisma.DbNull
          if (parsed.data.learningMaterials !== undefined)
            taskUpdate.learningMaterials = parsed.data.learningMaterials ?? Prisma.DbNull
          if (parsed.data.quizBankId !== undefined)
            taskUpdate.quizBankId = parsed.data.quizBankId ?? null
        }

        const task = await tx.standardExecutionTask.update({ where: { id }, data: taskUpdate })

        if (parsed.data.assigneeIds !== undefined) {
          if (isPublished) {
            // PUBLISHED：只追加新执行人（不删已有、不动已有进度）
            const existing = await tx.standardExecutionTaskAssignee.findMany({
              where: { taskId: id }, select: { assigneeId: true },
            })
            const existingSet = new Set(existing.map((a) => a.assigneeId))
            const toAdd = parsed.data.assigneeIds.filter((aid) => !existingSet.has(aid))
            if (toAdd.length > 0) {
              await tx.standardExecutionTaskAssignee.createMany({
                data: toAdd.map((aid) => ({ enterpriseId, taskId: id, assigneeId: aid })),
              })
            }
          } else {
            await tx.standardExecutionTaskAssignee.deleteMany({ where: { taskId: id } })
            await tx.standardExecutionTaskAssignee.createMany({
              data: parsed.data.assigneeIds.map((aid) => ({ enterpriseId, taskId: id, assigneeId: aid })),
            })
          }
        }
        return task
      })
      res.json({ data: withOverdue(updated) })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/tasks/:id/publish',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      return res.status(409).json({ error: '请先提交审核' })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/tasks/:id/submit-approval',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const parsed = TaskApprovalCommentSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return

      const task = await prisma.standardExecutionTask.findFirst({
        where: { id, enterpriseId },
        include: { _count: { select: { assignees: true } } },
      })
      if (!task) return res.status(404).json({ error: '记录不存在' })
      try {
        const updated = await prisma.$transaction((tx) =>
          submitTaskApproval(tx, {
            task,
            assigneeCount: task._count.assignees,
            operatorId: req.userId!,
            comment: parsed.data.comment,
          }),
        )
        return res.json({ data: withOverdue(updated) })
      } catch (err) {
        return handleTaskApprovalError(res, err)
      }
    },
  )

  app.post(
    '/api/enterprise/standard-execution/tasks/:id/approval/approve',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const parsed = TaskApprovalCommentSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return

      const task = await prisma.standardExecutionTask.findFirst({ where: { id, enterpriseId } })
      if (!task) return res.status(404).json({ error: '记录不存在' })
      if (!canReviewTaskApproval(req, task)) return res.status(403).json({ error: '无权审核此任务' })
      try {
        const result = await prisma.$transaction((tx) =>
          approveTaskApproval(tx, { task, operatorId: req.userId!, comment: parsed.data.comment }),
        )
        return res.json({
          data: withOverdue(result.task),
          deadlineAdjusted: result.deadlineAdjusted,
          oldDeadlineAt: result.oldDeadlineAt,
          newDeadlineAt: result.newDeadlineAt,
        })
      } catch (err) {
        return handleTaskApprovalError(res, err)
      }
    },
  )

  app.post(
    '/api/enterprise/standard-execution/tasks/:id/approval/reject',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const parsed = TaskApprovalCommentSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return

      const task = await prisma.standardExecutionTask.findFirst({ where: { id, enterpriseId } })
      if (!task) return res.status(404).json({ error: '记录不存在' })
      if (!canReviewTaskApproval(req, task)) return res.status(403).json({ error: '无权审核此任务' })
      try {
        const updated = await prisma.$transaction((tx) =>
          rejectTaskApproval(tx, { task, operatorId: req.userId!, comment: parsed.data.comment }),
        )
        return res.json({ data: withOverdue(updated) })
      } catch (err) {
        return handleTaskApprovalError(res, err)
      }
    },
  )

  app.post(
    '/api/enterprise/standard-execution/tasks/:id/cancel',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return

      const task = await prisma.standardExecutionTask.findFirst({
        where: { id, enterpriseId },
        select: { id: true, status: true, deadlineAt: true },
      })
      if (!task) return res.status(404).json({ error: '记录不存在' })
      if (task.status === 'CANCELLED') {
        const full = await prisma.standardExecutionTask.findFirst({ where: { id, enterpriseId } })
        return res.json({ data: full ? withOverdue(full) : null, noop: true })
      }
      if (task.status !== 'DRAFT' && task.status !== 'PENDING_APPROVAL' && task.status !== 'PUBLISHED') {
        return res.status(409).json({ error: `${task.status} 任务不可取消` })
      }
      const updated = await prisma.standardExecutionTask.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), updatedBy: req.userId! },
      })
      res.json({ data: withOverdue(updated) })
    },
  )

  // ═══ 企业版门户批量操作 ═══════════════════════════════
  // 与 admin /api/admin/standard-execution/*/batch-* 同语义；enterpriseId 走
  // resolveEnterpriseId（企业用户取自身，admin 已绑定企业时取绑定企业）。复用 status 终态做软删，
  // updateMany 天然跳过 不存在/越权/已终态 项，统一返回 {ok, requested, skipped}。
  app.post(
    '/api/enterprise/standard-execution/sources/batch-disable',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const result = await prisma.standardExecutionSource.updateMany({
        where: { id: { in: parsed.data.ids }, enterpriseId, status: 'ACTIVE' },
        data: { status: 'DISABLED', updatedBy: req.userId! },
      })
      res.json({ ok: result.count, requested: parsed.data.ids.length, skipped: parsed.data.ids.length - result.count })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/requirements/batch-archive',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const result = await prisma.standardExecutionRequirement.updateMany({
        where: { id: { in: parsed.data.ids }, enterpriseId, status: { in: ['ACTIVE', 'DISABLED'] } },
        data: { status: 'ARCHIVED', updatedBy: req.userId! },
      })
      res.json({ ok: result.count, requested: parsed.data.ids.length, skipped: parsed.data.ids.length - result.count })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/sources/batch-delete',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      try {
        const result = await prisma.standardExecutionSource.deleteMany({ where: { id: { in: parsed.data.ids }, enterpriseId } })
        res.json({ deleted: result.count })
      } catch {
        res.status(400).json({ error: '存在关联检查点/计划，无法删除（请先清理关联数据）' })
      }
    },
  )

  app.post(
    '/api/enterprise/standard-execution/requirements/batch-activate',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const result = await prisma.standardExecutionRequirement.updateMany({
        where: { id: { in: parsed.data.ids }, enterpriseId, status: { in: ['REVIEW_PENDING', 'DISABLED'] } },
        data: { status: 'ACTIVE', updatedBy: req.userId! },
      })
      res.json({ updated: result.count })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/requirements/batch-disable',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const result = await prisma.standardExecutionRequirement.updateMany({
        where: { id: { in: parsed.data.ids }, enterpriseId, status: { in: ['ACTIVE', 'REVIEW_PENDING', 'DRAFT'] } },
        data: { status: 'DISABLED', updatedBy: req.userId! },
      })
      res.json({ updated: result.count })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/requirements/batch-delete',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const result = await prisma.$transaction((tx) =>
        deleteRequirementsByPolicy(tx, { enterpriseId, ids: parsed.data.ids, updatedBy: req.userId! }),
      )
      res.json(result)
    },
  )

  app.post(
    '/api/enterprise/standard-execution/tasks/batch-cancel',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const result = await prisma.standardExecutionTask.updateMany({
        where: { id: { in: parsed.data.ids }, enterpriseId, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED'] } },
        data: { status: 'CANCELLED', cancelledAt: new Date(), updatedBy: req.userId! },
      })
      res.json({ ok: result.count, requested: parsed.data.ids.length, skipped: parsed.data.ids.length - result.count })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/tasks/batch-publish',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      return res.status(409).json({ error: '请先提交审核' })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/tasks/batch-assign',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = BatchAssignSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const v = await validateEnterpriseUsers(enterpriseId, parsed.data.reviewerId, parsed.data.assigneeIds)
      if (!v.reviewerOk) return res.status(400).json({ error: 'reviewerId 对应用户不存在' })
      if (v.missingAssignees.length > 0) {
        return res.status(400).json({ error: `assigneeIds 含不存在的用户：${v.missingAssignees.join(', ')}` })
      }
      const draftTasks = await prisma.standardExecutionTask.findMany({
        where: { id: { in: parsed.data.ids }, enterpriseId, status: 'DRAFT' },
        select: { id: true },
      })
      const draftIds = draftTasks.map((t) => t.id)
      if (draftIds.length > 0) {
        await prisma.$transaction(async (tx) => {
          for (const taskId of draftIds) {
            await tx.standardExecutionTask.update({
              where: { id: taskId },
              data: { reviewerId: parsed.data.reviewerId, updatedBy: req.userId! },
            })
            await tx.standardExecutionTaskAssignee.deleteMany({ where: { taskId } })
            await tx.standardExecutionTaskAssignee.createMany({
              data: parsed.data.assigneeIds.map((aid) => ({ enterpriseId, taskId, assigneeId: aid })),
            })
          }
        })
      }
      res.json({ ok: draftIds.length, requested: parsed.data.ids.length, skipped: parsed.data.ids.length - draftIds.length })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/records/batch-void',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const count = await prisma.$transaction(async (tx) => {
        const voidable = await tx.standardExecutionRecord.findMany({
          where: { id: { in: parsed.data.ids }, enterpriseId, status: { in: ['VALID', 'EXPIRED'] } },
          select: { id: true },
        })
        const voidableIds = voidable.map((r) => r.id)
        if (voidableIds.length === 0) return 0
        const updated = await tx.standardExecutionRecord.updateMany({
          where: { id: { in: voidableIds } },
          data: { status: 'VOID' },
        })
        const items = await tx.standardExecutionPackageItem.findMany({
          where: { recordId: { in: voidableIds }, enterpriseId },
          select: { packageId: true },
        })
        const packageIds = Array.from(new Set(items.map((i) => i.packageId)))
        if (packageIds.length > 0) {
          await tx.standardExecutionPackage.updateMany({
            where: { id: { in: packageIds }, enterpriseId },
            data: { hasInvalidRecord: true },
          })
        }
        return updated.count
      })
      res.json({ ok: count, requested: parsed.data.ids.length, skipped: parsed.data.ids.length - count })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/packages/batch-void',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const result = await prisma.standardExecutionPackage.updateMany({
        where: { id: { in: parsed.data.ids }, enterpriseId, status: { in: ['DRAFT', 'READY'] } },
        data: { status: 'VOID' },
      })
      res.json({ ok: result.count, requested: parsed.data.ids.length, skipped: parsed.data.ids.length - result.count })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/tasks/:id/progress',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return

      const task = await prisma.standardExecutionTask.findFirst({
        where: { id, enterpriseId },
        include: { assignees: true },
      })
      if (!task) return res.status(404).json({ error: '记录不存在' })

      const byStatus: Record<AssigneeStatus, number> = {
        PENDING: 0, IN_PROGRESS: 0, PENDING_REVIEW: 0, REJECTED: 0, COMPLETED: 0, OVERDUE: 0,
      }
      const now = Date.now()
      const deadlineMs = task.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY
      for (const a of task.assignees) {
        if (ASSIGNEE_STATUS.includes(a.status as AssigneeStatus)) {
          byStatus[a.status as AssigneeStatus]++
        }
      }
      res.json({
        data: {
          taskId: task.id,
          taskStatus: task.status,
          deadlineAt: task.deadlineAt,
          isOverdue: task.status === 'PUBLISHED' && deadlineMs < now,
          total: task.assignees.length,
          byStatus,
          assignees: task.assignees.map((a) => ({
            id: a.id,
            assigneeId: a.assigneeId,
            departmentId: a.departmentId,
            status: a.status,
            submittedAt: a.submittedAt,
            reviewedAt: a.reviewedAt,
            isOverdue: task.status === 'PUBLISHED' && deadlineMs < now && a.status !== 'COMPLETED',
          })),
        },
      })
    },
  )

  // ─── 企业版：要求项 CRUD ──────────────────────────────────────────
  // POST   /api/enterprise/standard-execution/requirements           — 新建（默认 REVIEW_PENDING；可显式 DRAFT）
  // PATCH  /api/enterprise/standard-execution/requirements/:id       — 编辑
  // PATCH  /api/enterprise/standard-execution/requirements/:id/activate
  // PATCH  /api/enterprise/standard-execution/requirements/:id/disable
  // PATCH  /api/enterprise/standard-execution/requirements/:id/archive

  const ReqCreateSchema = z.object({
    sourceId:            z.string().min(1),
    clauseNo:            z.string().max(50).optional(),
    title:               z.string().min(1).max(200),
    requirementText:     z.string().min(1),
    applicableDeptIds:   z.array(z.string()).max(50).optional().nullable(),
    archiveTags:         z.array(z.string()).max(50).optional().nullable(),
    recommendedTaskType: z.string().max(80).optional().nullable(),
    executionDescription:z.string().max(2000).optional().nullable(),
    submitRequirement:   z.string().max(1000).optional().nullable(),
    requiredMaterials:   z.array(z.string().min(1).max(200)).max(50).optional().nullable(),
    status:              z.enum(['DRAFT', 'REVIEW_PENDING']).optional(),
  })

  const ReqUpdateSchema = ReqCreateSchema.partial().omit({ sourceId: true, status: true })

  app.post(
    '/api/enterprise/standard-execution/requirements',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = ReqCreateSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      // 校验 source 属于本企业
      const source = await prisma.standardExecutionSource.findFirst({
        where: { id: parsed.data.sourceId, enterpriseId: enterpriseId as string },
      })
      if (!source) return res.status(404).json({ error: '标准来源不存在或不属于本企业' })
      const req2 = await prisma.standardExecutionRequirement.create({
        data: {
          enterpriseId: enterpriseId as string,
          sourceId: parsed.data.sourceId,
          clauseNo: parsed.data.clauseNo ?? null,
          title: parsed.data.title,
          requirementText: parsed.data.requirementText,
          applicableDeptIds:
            parsed.data.applicableDeptIds === undefined
              ? undefined
              : (parsed.data.applicableDeptIds as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
          archiveTags:
            parsed.data.archiveTags === undefined
              ? undefined
              : (parsed.data.archiveTags as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
          recommendedTaskType: parsed.data.recommendedTaskType ?? null,
          executionDescription: parsed.data.executionDescription ?? null,
          submitRequirement: parsed.data.submitRequirement ?? null,
          requiredMaterials:
            parsed.data.requiredMaterials === undefined
              ? undefined
              : (parsed.data.requiredMaterials as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
          generateMode: 'MANUAL',
          status: parsed.data.status ?? 'REVIEW_PENDING',
          createdBy: req.userId!,
        },
      })
      res.json({ data: req2 })
    },
  )

  app.patch(
    '/api/enterprise/standard-execution/requirements/:id',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const { id } = req.params
      const parsed = ReqUpdateSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const existing = await prisma.standardExecutionRequirement.findFirst({
        where: { id: id as string, enterpriseId: enterpriseId as string },
      })
      if (!existing) return res.status(404).json({ error: '要求项不存在' })
      if (existing.status === 'ARCHIVED') return res.status(400).json({ error: '已归档的要求项不可编辑' })
      const d = parsed.data
      const updated = await prisma.standardExecutionRequirement.update({
        where: { id: id as string },
        data: {
          ...(d.clauseNo !== undefined && { clauseNo: d.clauseNo }),
          ...(d.title !== undefined && { title: d.title }),
          ...(d.requirementText !== undefined && { requirementText: d.requirementText }),
          ...(d.applicableDeptIds !== undefined && { applicableDeptIds: (d.applicableDeptIds as Prisma.InputJsonValue | null) ?? Prisma.DbNull }),
          ...(d.archiveTags !== undefined && { archiveTags: (d.archiveTags as Prisma.InputJsonValue | null) ?? Prisma.DbNull }),
          ...(d.recommendedTaskType !== undefined && { recommendedTaskType: d.recommendedTaskType }),
          ...(d.executionDescription !== undefined && { executionDescription: d.executionDescription }),
          ...(d.submitRequirement !== undefined && { submitRequirement: d.submitRequirement }),
          ...(d.requiredMaterials !== undefined && { requiredMaterials: (d.requiredMaterials as Prisma.InputJsonValue | null) ?? Prisma.DbNull }),
          updatedBy: req.userId!,
        },
      })
      res.json({ data: updated })
    },
  )

  for (const action of ['activate', 'disable', 'archive'] as const) {
    const transitions: Record<typeof action, { from: string[]; to: string }> = {
      activate: { from: ['REVIEW_PENDING', 'DISABLED'], to: 'ACTIVE' },
      disable:  { from: ['ACTIVE', 'REVIEW_PENDING', 'DRAFT'], to: 'DISABLED' },
      archive:  { from: ['ACTIVE', 'DISABLED'], to: 'ARCHIVED' },
    }
    app.patch(
      `/api/enterprise/standard-execution/requirements/:id/${action}`,
      requireAuth as never,
      async (req: AuthRequest, res: Response) => {
        const { id } = req.params
        const enterpriseId = await resolveEnterpriseId(req, res)
        if (!enterpriseId) return
        const existing = await prisma.standardExecutionRequirement.findFirst({
          where: { id: id as string, enterpriseId: enterpriseId as string },
        })
        if (!existing) return res.status(404).json({ error: '要求项不存在' })
        const { from, to } = transitions[action]
        if (!from.includes(existing.status)) {
          return res.status(400).json({ error: `当前状态 ${existing.status} 不支持此操作` })
        }
        const updated = await prisma.standardExecutionRequirement.update({
          where: { id: id as string },
          data: { status: to, updatedBy: req.userId! },
        })
        res.json({ data: updated })
      },
    )
  }

  // ─── 解析当前请求企业用户角色（用于 void 等需 MANAGER+ 的操作）
  async function resolveEnterpriseRole(req: AuthRequest): Promise<'ADMIN' | 'MANAGER' | 'REVIEWER' | 'EMPLOYEE' | null> {
    if (req.userRole === 'admin') return 'ADMIN'
    const user = await prisma.appUser.findUnique({
      where: { id: req.userId! },
      select: { enterpriseRole: true },
    })
    if (!user?.enterpriseRole) return null
    return user.enterpriseRole as 'ADMIN' | 'MANAGER' | 'REVIEWER' | 'EMPLOYEE'
  }

  registerTaskGenerationRoutes(app, {
    basePath: '/api/enterprise/standard-execution/task-generation',
    middleware: requireAuth as never,
    aiCaller,
    resolveContext: async (req, res) => {
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return null
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可使用任务生成工作台' })
        return null
      }
      return {
        enterpriseId,
        userId: req.userId!,
        scope: 'enterprise',
      }
    },
  })

  // ───────────────────────────────────────────────────────────────
  // 企业版：执行记录（Records）
  // ───────────────────────────────────────────────────────────────
  app.get(
    '/api/enterprise/standard-execution/records',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = RecordListQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return

      const { status, sourceId, requirementId, taskId, assigneeId, departmentId, keyword, recordDateFrom, recordDateTo, page, pageSize } = parsed.data
      const where: Record<string, unknown> = { enterpriseId }
      if (status) where.status = Array.isArray(status) ? { in: status } : status
      if (sourceId) where.sourceId = sourceId
      if (requirementId) where.requirementId = requirementId
      if (taskId) where.taskId = taskId
      if (assigneeId) where.assigneeId = assigneeId
      if (departmentId) where.departmentId = departmentId
      if (recordDateFrom || recordDateTo) {
        where.recordDate = {
          ...(recordDateFrom ? { gte: recordDateFrom } : {}),
          ...(recordDateTo ? { lte: recordDateTo } : {}),
        }
      }
      if (keyword) {
        where.OR = [
          { title: { contains: keyword, mode: 'insensitive' } },
          { summary: { contains: keyword, mode: 'insensitive' } },
        ]
      }

      const [data, total] = await Promise.all([
        prisma.standardExecutionRecord.findMany({
          where,
          include: {
            task: {
              select: {
                id: true,
                title: true,
                requirement: {
                  select: {
                    id: true,
                    title: true,
                    clauseNo: true,
                    requirementText: true,
                    source: { select: { id: true, title: true, sourceNo: true, version: true } },
                  },
                },
              },
            },
            submission: { select: { id: true, version: true, submittedAt: true, reviewedAt: true, reviewerId: true } },
          },
          orderBy: { recordDate: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.standardExecutionRecord.count({ where }),
      ])
      res.json({ data, total, page, pageSize })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/records/:id/evidence-chain',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const chain = await loadRecordEvidenceChain(enterpriseId, id)
      if (!chain) return res.status(404).json({ error: '记录不存在' })
      res.json({ data: chain })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/records/:id/export-pdf',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const chain = await loadRecordEvidenceChain(enterpriseId, id)
      if (!chain) return res.status(404).json({ error: '记录不存在' })
      const pdf = await buildRecordEvidencePdfBuffer(chain)
      res.type('application/pdf')
      res.attachment(recordEvidencePdfFilename(chain))
      res.send(pdf)
    },
  )

  app.get(
    '/api/enterprise/standard-execution/records/:id',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return

      const record = await prisma.standardExecutionRecord.findFirst({
        where: { id, enterpriseId },
        include: {
          submission: true,
          task: { include: { requirement: { include: { source: true } } } },
        },
      })
      if (!record) return res.status(404).json({ error: '记录不存在' })

      const attachments = await prisma.standardExecutionAttachment.findMany({
        where: { enterpriseId, bizType: 'SUBMISSION', bizId: record.submissionId },
        orderBy: { createdAt: 'asc' },
      })
      const reviewLogs = await prisma.standardExecutionReviewLog.findMany({
        where: { enterpriseId, submissionId: record.submissionId },
        orderBy: { createdAt: 'asc' },
      })
      const basis = record.task
        ? resolveRequirementBasis(record.task.basisSnapshots, record.requirementId, record.task.requirement)
        : null
      res.json({
        data: {
          ...record,
          task: record.task && basis
            ? {
                ...record.task,
                requirement: basis.requirement,
              }
            : record.task,
          attachments,
          reviewLogs,
        },
      })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/records/:id/void',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const parsed = RecordVoidSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER 可作废执行记录' })
      }

      const exists = await prisma.standardExecutionRecord.findFirst({
        where: { id, enterpriseId },
        select: { id: true, status: true },
      })
      if (!exists) return res.status(404).json({ error: '记录不存在' })
      if (exists.status === 'VOID') {
        const full = await prisma.standardExecutionRecord.findFirst({ where: { id, enterpriseId } })
        return res.json({ data: full, noop: true })
      }
      if (exists.status !== 'VALID' && exists.status !== 'EXPIRED') {
        return res.status(409).json({ error: `当前状态 ${exists.status} 不可作废` })
      }

      const updated = await prisma.$transaction(async (tx) => {
        const r = await tx.standardExecutionRecord.update({ where: { id }, data: { status: 'VOID' } })
        const items = await tx.standardExecutionPackageItem.findMany({
          where: { recordId: id, enterpriseId },
          select: { packageId: true },
        })
        const packageIds = Array.from(new Set(items.map((i) => i.packageId)))
        if (packageIds.length > 0) {
          await tx.standardExecutionPackage.updateMany({
            where: { id: { in: packageIds }, enterpriseId },
            data: { hasInvalidRecord: true },
          })
        }
        return { record: r, affectedPackageIds: packageIds }
      })

      res.json({
        data: updated.record,
        affectedPackageIds: updated.affectedPackageIds,
        voidReason: parsed.data.voidReason ?? null,
      })
    },
  )

  // ───────────────────────────────────────────────────────────────
  // 企业版：合规雷达（Risks）
  // ───────────────────────────────────────────────────────────────
  app.get(
    '/api/enterprise/standard-execution/risks',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const items = await computeRisks(enterpriseId)
      res.json({ data: items, total: items.length })
    },
  )

  // ───────────────────────────────────────────────────────────────
  // 企业版：审计包（Packages）
  // ───────────────────────────────────────────────────────────────
  function packageFormatExt(format: string | null | undefined) {
    if (format === 'FOLDER') return 'txt'
    return format === 'PDF' ? 'pdf' : format === 'DOCX' ? 'docx' : 'zip'
  }
  function packageContentType(format: string | null | undefined) {
    if (format === 'FOLDER') return 'text/plain; charset=utf-8'
    if (format === 'PDF') return 'application/pdf'
    if (format === 'DOCX') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    return 'application/zip'
  }
  function packageDownloadName(title: string | null | undefined, id: string, format: string | null | undefined) {
    const safeTitle = String(title || '审计包').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)
    return `${safeTitle || id}.${packageFormatExt(format)}`
  }
  function packageArtifactContentType(fileName: string) {
    if (/\.docx$/i.test(fileName)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    if (/\.xlsx$/i.test(fileName)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    if (/\.pdf$/i.test(fileName)) return 'application/pdf'
    if (/\.zip$/i.test(fileName)) return 'application/zip'
    if (/\.json$/i.test(fileName)) return 'application/json; charset=utf-8'
    if (/\.txt$/i.test(fileName)) return 'text/plain; charset=utf-8'
    return 'application/octet-stream'
  }
  async function requirePackageManager(req: AuthRequest, res: Response) {
    const enterpriseId = await resolveEnterpriseId(req, res)
    if (!enterpriseId) return null
    const role = await resolveEnterpriseRole(req)
    if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
      res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可管理审计包' })
      return null
    }
    return enterpriseId
  }

  app.get(
    '/api/enterprise/standard-execution/packages',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = PackageListQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const enterpriseId = await requirePackageManager(req, res)
      if (!enterpriseId) return
      const { status, packageScene, keyword, page, pageSize } = parsed.data
      const where: Record<string, unknown> = { enterpriseId }
      if (status) where.status = Array.isArray(status) ? { in: status } : status
      if (packageScene) where.packageScene = packageScene
      if (keyword) where.title = { contains: keyword, mode: 'insensitive' }

      const [data, total] = await Promise.all([
        prisma.standardExecutionPackage.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.standardExecutionPackage.count({ where }),
      ])
      res.json({ data, total, page, pageSize })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/packages/templates',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const enterpriseId = await requirePackageManager(req, res)
      if (!enterpriseId) return
      res.json({ data: PACKAGE_TEMPLATES })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/packages',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = PackageCreateSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return

      let selection: Awaited<ReturnType<typeof resolveValidPackageRecords>>
      try {
        selection = await resolveValidPackageRecords(enterpriseId, parsed.data)
      } catch (e) {
        return res.status(400).json({ error: e instanceof Error ? e.message : '审计包记录选择无效' })
      }

      const result = await prisma.$transaction(async (tx) => {
        const pkg = await tx.standardExecutionPackage.create({
          data: {
            enterpriseId,
            title: parsed.data.title,
            packageScene: parsed.data.packageScene,
            description: parsed.data.description ?? null,
            dateFrom: parsed.data.dateFrom ?? null,
            dateTo: parsed.data.dateTo ?? null,
            format: parsed.data.format ?? 'FOLDER',
            createdBy: req.userId!,
          },
        })
        await tx.standardExecutionPackageItem.createMany({
          data: selection.recordIds.map((rid, idx) => {
            const r = selection.foundMap.get(rid)!
            return {
              enterpriseId,
              packageId: pkg.id,
              recordId: rid,
              requirementId: r.requirementId,
              taskId: r.taskId,
              submissionId: r.submissionId,
              sortNo: idx,
            }
          }),
        })
        return pkg
      })
      res.status(201).json({ data: result })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/packages/:id',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return

      const pkg = await prisma.standardExecutionPackage.findFirst({
        where: { id, enterpriseId },
        include: { items: { orderBy: { sortNo: 'asc' } } },
      })
      if (!pkg) return res.status(404).json({ error: '记录不存在' })

      const recordIds = pkg.items.map((i) => i.recordId)
      const submissionIds = pkg.items.map((i) => i.submissionId)
      const taskIds = pkg.items.map((i) => i.taskId)
      const requirementIds = pkg.items.map((i) => i.requirementId)

      const [records, submissions, tasks, requirements, attachments, reviewLogs] = await Promise.all([
        prisma.standardExecutionRecord.findMany({ where: { id: { in: recordIds }, enterpriseId } }),
        prisma.standardExecutionSubmission.findMany({ where: { id: { in: submissionIds }, enterpriseId } }),
        prisma.standardExecutionTask.findMany({ where: { id: { in: taskIds }, enterpriseId } }),
        prisma.standardExecutionRequirement.findMany({
          where: { id: { in: requirementIds }, enterpriseId },
          include: { source: true },
        }),
        prisma.standardExecutionAttachment.findMany({
          where: { enterpriseId, bizType: 'SUBMISSION', bizId: { in: submissionIds } },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.standardExecutionReviewLog.findMany({
          where: { submissionId: { in: submissionIds }, enterpriseId },
          orderBy: { createdAt: 'asc' },
        }),
      ])

      const recordMap = new Map(records.map((r) => [r.id, r]))
      const submissionMap = new Map(submissions.map((s) => [s.id, s]))
      const taskMap = new Map(tasks.map((t) => [t.id, t]))
      const requirementMap = new Map(requirements.map((r) => [r.id, r]))
      const attachmentBySubmission = new Map<string, typeof attachments>()
      for (const a of attachments) {
        const arr = attachmentBySubmission.get(a.bizId) ?? []
        arr.push(a)
        attachmentBySubmission.set(a.bizId, arr)
      }
      const reviewLogsBySubmission = new Map<string, typeof reviewLogs>()
      for (const r of reviewLogs) {
        const arr = reviewLogsBySubmission.get(r.submissionId) ?? []
        arr.push(r)
        reviewLogsBySubmission.set(r.submissionId, arr)
      }

      const tree: Array<{
        source: unknown
        requirements: Array<{
          requirement: unknown
          tasks: Array<{
            task: unknown
            submissions: Array<{
              submission: unknown
              record: unknown
              reviewLogs: unknown[]
              attachments: unknown[]
            }>
          }>
        }>
      }> = []
      const sourceIdx = new Map<string, number>()
      const reqIdx = new Map<string, Map<string, number>>()
      const taskIdx = new Map<string, Map<string, number>>()

      for (const item of pkg.items) {
        const reqEntity = requirementMap.get(item.requirementId)
        const task = taskMap.get(item.taskId)
        const sub = submissionMap.get(item.submissionId)
        const rec = recordMap.get(item.recordId)
        if (!task || !sub || !rec) continue
        const basis = resolveRequirementBasis(task.basisSnapshots, item.requirementId, reqEntity)
        if (!basis) continue
        const source = basis.source
        const sourceId = basis.snapshot?.sourceId ?? (reqEntity as { sourceId: string } | undefined)?.sourceId
        if (!sourceId) continue
        const requirement = basis.requirement

        let sIdx = sourceIdx.get(sourceId)
        if (sIdx === undefined) {
          sIdx = tree.length
          sourceIdx.set(sourceId, sIdx)
          tree.push({ source, requirements: [] })
          reqIdx.set(sourceId, new Map())
        }
        const reqMap = reqIdx.get(sourceId)!
        let rIdx = reqMap.get(requirement.id)
        if (rIdx === undefined) {
          rIdx = tree[sIdx].requirements.length
          reqMap.set(requirement.id, rIdx)
          tree[sIdx].requirements.push({ requirement, tasks: [] })
          taskIdx.set(requirement.id, new Map())
        }
        const tMap = taskIdx.get(requirement.id)!
        let tIdx = tMap.get(task.id)
        if (tIdx === undefined) {
          tIdx = tree[sIdx].requirements[rIdx].tasks.length
          tMap.set(task.id, tIdx)
          tree[sIdx].requirements[rIdx].tasks.push({ task, submissions: [] })
        }
        tree[sIdx].requirements[rIdx].tasks[tIdx].submissions.push({
          submission: sub,
          record: rec,
          reviewLogs: reviewLogsBySubmission.get(sub.id) ?? [],
          attachments: attachmentBySubmission.get(sub.id) ?? [],
        })
      }

      res.json({ data: { ...pkg, tree } })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/packages/:id/preview',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const parsed = PackagePreviewSchema.safeParse(req.body ?? {})
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await requirePackageManager(req, res)
      if (!enterpriseId) return

      try {
        const data = await buildPackagePreview(enterpriseId, id, parsed.data)
        res.json({ data })
      } catch (e) {
        const status = (e as { status?: number })?.status || 500
        res.status(status).json({ error: e instanceof Error ? e.message : '生成预览失败' })
      }
    },
  )

  app.post(
    '/api/enterprise/standard-execution/packages/:id/generate',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const parsed = PackageGenerateSchema.safeParse(req.body ?? {})
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await requirePackageManager(req, res)
      if (!enterpriseId) return

      const exists = await prisma.standardExecutionPackage.findFirst({
        where: { id, enterpriseId },
        select: { id: true, status: true, format: true },
      })
      if (!exists) return res.status(404).json({ error: '记录不存在' })
      if (exists.status !== 'DRAFT' && exists.status !== 'READY') {
        return res.status(409).json({ error: `当前状态 ${exists.status} 不可生成` })
      }
      const batchId = `se_pkg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      await prisma.standardExecutionPackage.update({
        where: { id },
        data: {
          generationStatus: 'GENERATING',
          generationBatchId: batchId,
          generationOptions: parsed.data as Prisma.InputJsonValue,
          generationError: null,
        },
      })
      try {
        const generated = await generatePackageArtifacts(enterpriseId, id, parsed.data)
        const updated = await prisma.standardExecutionPackage.update({
          where: { id },
          data: {
            status: 'READY',
            generatedAt: new Date(),
            fileUrl: generated.fileUrl,
            format: 'FOLDER',
            generationStatus: 'READY',
            generationBatchId: batchId,
            generationOptions: parsed.data as Prisma.InputJsonValue,
            outputDir: generated.outputDir,
            outputManifest: generated.outputManifest as unknown as Prisma.InputJsonValue,
            generationError: null,
          },
        })
        res.json({
          data: updated,
          batchId,
          status: 'READY',
          outputFiles: generated.outputFiles,
          skippedAttachments: generated.skippedAttachments,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : '审计包生成失败'
        await prisma.standardExecutionPackage.update({
          where: { id },
          data: { generationStatus: 'FAILED', generationError: message },
        })
        const status = (e as { status?: number })?.status || 500
        res.status(status).json({ error: message, batchId, status: 'FAILED' })
      }
    },
  )

  app.post(
    '/api/enterprise/standard-execution/packages/:id/generate-async',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const parsed = PackageAsyncGenerateSchema.safeParse(req.body ?? {})
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await requirePackageManager(req, res)
      if (!enterpriseId) return

      const exists = await prisma.standardExecutionPackage.findFirst({
        where: { id, enterpriseId },
        select: { id: true, status: true },
      })
      if (!exists) return res.status(404).json({ error: '记录不存在' })
      if (exists.status !== 'DRAFT' && exists.status !== 'READY') {
        return res.status(409).json({ error: `当前状态 ${exists.status} 不可生成` })
      }
      const { previewConfirmed: _previewConfirmed, format: _format, ...options } = parsed.data
      const job = await startPackageGenerationJob(enterpriseId, id, options)
      res.status(202).json({ data: job })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/packages/:id/generation-status',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const pkg = await prisma.standardExecutionPackage.findFirst({
        where: { id, enterpriseId },
        select: {
          id: true,
          status: true,
          generationStatus: true,
          generationBatchId: true,
          generationError: true,
          outputManifest: true,
          generatedAt: true,
        },
      })
      if (!pkg) return res.status(404).json({ error: '记录不存在' })
      const job = getPackageGenerationJob(id, typeof req.query.batchId === 'string' ? req.query.batchId : pkg.generationBatchId)
      res.json({
        data: {
          ...pkg,
          job: job ? {
            batchId: job.batchId,
            status: job.status,
            progress: job.progress,
            step: job.step,
            error: job.error,
            outputFiles: job.outputFiles,
            skippedAttachments: job.skippedAttachments,
          } : null,
        },
      })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/packages/:id/files',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const relativePath = typeof req.query.path === 'string' ? req.query.path : ''
      const enterpriseId = await requirePackageManager(req, res)
      if (!enterpriseId) return
      try {
        const file = await readPackageArtifactFile(enterpriseId, id, relativePath)
        res.type(packageArtifactContentType(file.downloadName))
        res.attachment(file.downloadName)
        res.send(file.content)
      } catch (e) {
        const status = (e as { status?: number })?.status || 500
        res.status(status).json({ error: e instanceof Error ? e.message : '审计包文件读取失败' })
      }
    },
  )

  app.get(
    '/api/enterprise/standard-execution/packages/:id/download',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const enterpriseId = await requirePackageManager(req, res)
      if (!enterpriseId) return

      const pkg = await prisma.standardExecutionPackage.findFirst({
        where: { id, enterpriseId },
        select: { id: true, title: true, status: true, fileUrl: true, format: true },
      })
      if (!pkg) return res.status(404).json({ error: '记录不存在' })
      if (pkg.status !== 'READY' || !pkg.fileUrl) {
        return res.status(409).json({ error: '审计包尚未生成' })
      }
      if (pkg.format === 'FOLDER') {
        try {
          const file = await readPackageArtifactFile(enterpriseId, id, 'README.txt')
          res.type(packageArtifactContentType(file.downloadName))
          res.attachment(packageDownloadName(pkg.title, pkg.id, pkg.format))
          return res.send(file.content)
        } catch (e) {
          const status = (e as { status?: number })?.status || 500
          return res.status(status).json({ error: e instanceof Error ? e.message : '审计包文件读取失败' })
        }
      }
      const filePath = packageFilePathFromUrl(pkg.fileUrl)
      if (!filePath) return res.status(409).json({ error: '审计包文件地址非法' })
      res.type(packageContentType(pkg.format))
      res.download(filePath, packageDownloadName(pkg.title, pkg.id, pkg.format), (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: '审计包文件不存在，请重新生成' })
      })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/packages/:id/download-zip',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const enterpriseId = await requirePackageManager(req, res)
      if (!enterpriseId) return
      try {
        const file = await readPackageArtifactFile(enterpriseId, id, '全部材料.zip')
        res.type('application/zip')
        res.attachment(await packageZipDownloadName(enterpriseId, id))
        res.send(file.content)
      } catch (e) {
        const status = (e as { status?: number })?.status || 500
        res.status(status).json({ error: e instanceof Error ? e.message : '审计包 ZIP 读取失败' })
      }
    },
  )

  app.post(
    '/api/enterprise/standard-execution/packages/:id/void',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const enterpriseId = await requirePackageManager(req, res)
      if (!enterpriseId) return

      const exists = await prisma.standardExecutionPackage.findFirst({
        where: { id, enterpriseId },
        select: { id: true, status: true },
      })
      if (!exists) return res.status(404).json({ error: '记录不存在' })
      if (exists.status === 'VOID') {
        const full = await prisma.standardExecutionPackage.findFirst({ where: { id, enterpriseId } })
        return res.json({ data: full, noop: true })
      }
      const updated = await prisma.standardExecutionPackage.update({
        where: { id },
        data: { status: 'VOID' },
      })
      res.json({ data: updated })
    },
  )

  // ───────────────────────────────────────────────────────────────
  // 企业版：标准来源 CRUD（列表已在前述端点提供）
  // ───────────────────────────────────────────────────────────────
  app.post(
    '/api/enterprise/standard-execution/sources',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = SourceCreateSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const data = await prisma.standardExecutionSource.create({
        data: {
          enterpriseId,
          title: parsed.data.title,
          sourceType: parsed.data.sourceType,
          sourceNo: parsed.data.sourceNo ?? null,
          version: parsed.data.version ?? null,
          rawText: parsed.data.rawText ?? null,
          fileUrl: parsed.data.fileUrl ?? null,
          createdBy: req.userId!,
        },
      })
      res.status(201).json({ data })
    },
  )

  app.patch(
    '/api/enterprise/standard-execution/sources/:id',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const parsed = SourceUpdateSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const exists = await prisma.standardExecutionSource.findFirst({
        where: { id, enterpriseId },
        select: { id: true },
      })
      if (!exists) return res.status(404).json({ error: '记录不存在' })

      const data = await prisma.standardExecutionSource.update({
        where: { id },
        data: { ...parsed.data, updatedBy: req.userId! },
      })
      res.json({ data })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/sources/:id/versions',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const source = await prisma.standardExecutionSource.findFirst({ where: { id, enterpriseId } })
      if (!source) return res.status(404).json({ error: '记录不存在' })
      const rootId = source.parentSourceId || source.id
      const data = await prisma.standardExecutionSource.findMany({
        where: { enterpriseId, OR: [{ id: rootId }, { parentSourceId: rootId }, { id: source.id }] },
        orderBy: { createdAt: 'desc' },
      })
      res.json({ data })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/sources/:id/versions',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      const parsed = SourceVersionCreateSchema.safeParse(req.body)
      if (!id) return res.status(400).json({ error: 'id 非法' })
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可上传新版本' })
      }
      const current = await prisma.standardExecutionSource.findFirst({ where: { id, enterpriseId } })
      if (!current) return res.status(404).json({ error: '记录不存在' })
      const rootId = current.parentSourceId || current.id
      const summary = parsed.data.analyze
        ? buildVersionChangeSummary(current.rawText, parsed.data.rawText ?? current.rawText)
        : { mode: 'SKIPPED', added: [], modified: [], removed: [], affectedClauseNos: [], summary: '已跳过变更分析' }
      const affectedClauseNos = new Set(summary.affectedClauseNos)
      const nextRawText = parsed.data.rawText ?? current.rawText
      const shouldMarkAllRequirements =
        parsed.data.analyze &&
        affectedClauseNos.size === 0 &&
        String(current.rawText || '') !== String(nextRawText || '')

      const result = await prisma.$transaction(async (tx) => {
        await tx.standardExecutionSource.updateMany({
          where: { enterpriseId, OR: [{ id: rootId }, { parentSourceId: rootId }] },
          data: { isLatestVersion: false, updatedBy: req.userId! },
        })
        const created = await tx.standardExecutionSource.create({
          data: {
            enterpriseId,
            title: parsed.data.title || current.title,
            sourceType: current.sourceType,
            sourceNo: current.sourceNo,
            version: parsed.data.version,
            rawText: nextRawText,
            fileUrl: parsed.data.fileUrl ?? current.fileUrl,
            ownershipTier: current.ownershipTier,
            parentSourceId: rootId,
            isLatestVersion: true,
            versionChangeSummary: summary as Prisma.InputJsonValue,
            status: 'ACTIVE',
            createdBy: req.userId!,
          },
        })
        const requirements = await tx.standardExecutionRequirement.findMany({
          where: { enterpriseId, sourceId: current.id },
          select: { id: true, clauseNo: true },
        })
        const affectedIds = requirements
          .filter((requirement) => shouldMarkAllRequirements || (requirement.clauseNo && affectedClauseNos.has(requirement.clauseNo)))
          .map((requirement) => requirement.id)
        if (affectedIds.length > 0) {
          await tx.standardExecutionRequirement.updateMany({
            where: { id: { in: affectedIds }, enterpriseId },
            data: { requiresReview: true, updatedBy: req.userId! },
          })
        }
        await tx.standardExecutionRisk.create({
          data: {
            enterpriseId,
            riskType: 'STANDARD_VERSION_UPDATED',
            riskLevel: affectedIds.length > 0 ? 'MEDIUM' : 'LOW',
            title: `标准 ${current.title} 已更新`,
            description: `新版本 ${parsed.data.version} 已上传，影响 ${affectedIds.length} 个控制点，请及时复核。${summary.summary}`,
            relatedType: 'SOURCE',
            relatedId: created.id,
          },
        })
        return { created, affectedRequirementIds: affectedIds }
      })
      invalidateSEContext(enterpriseId)
      res.status(201).json({ data: result.created, summary, affectedRequirementIds: result.affectedRequirementIds })
    },
  )

  app.patch(
    '/api/enterprise/standard-execution/sources/:id/ownership',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const parsed = SourceOwnershipUpdateSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (!canManageSourceOwnership(role)) {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER 可调整文档权属分档' })
      }

      const source = await prisma.standardExecutionSource.findFirst({
        where: { id, enterpriseId },
        select: { id: true },
      })
      if (!source) return res.status(404).json({ error: '记录不存在' })

      if (parsed.data.ownershipTier === 'O') {
        if (parsed.data.declarationAccepted !== true || !parsed.data.declarationText) {
          return res.status(422).json({ error: '升为 O 档必须提交并确认权属声明' })
        }

        const data = await prisma.$transaction(async (tx) => {
          await tx.standardExecutionSourceDeclaration.create({
            data: {
              enterpriseId,
              sourceId: id,
              ownershipTier: 'O',
              declarationText: parsed.data.declarationText!,
              declaredBy: req.userId!,
              ipAddress: req.ip || null,
              userAgent: req.get('user-agent') || null,
            },
          })
          return tx.standardExecutionSource.update({
            where: { id },
            data: { ownershipTier: 'O', updatedBy: req.userId! },
          })
        })
        invalidateSEContext(enterpriseId)
        return res.json({ data })
      }

      const data = await prisma.standardExecutionSource.update({
        where: { id },
        data: { ownershipTier: 'R', updatedBy: req.userId! },
      })
      invalidateSEContext(enterpriseId)
      res.json({ data })
    },
  )

  // ───────────────────────────────────────────────────────────────
  // 企业版：要求项自动解析（auto-generate）
  // ───────────────────────────────────────────────────────────────
  app.post(
    '/api/enterprise/standard-execution/requirements/auto-generate',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = AutoGenerateSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const { sourceId, parseMode, dryRun } = parsed.data

      const source = await prisma.standardExecutionSource.findFirst({
        where: { id: sourceId, enterpriseId },
        select: { id: true, rawText: true },
      })
      if (!source) return res.status(400).json({ error: 'sourceId 对应的标准来源不存在或不属于本企业' })

      const result = await runParse(source.rawText ?? '', parseMode, aiCaller)
      let createdCount = 0
      const aiCount = result.parseMode === 'OCR_AI' ? result.drafts.length : 0
      const ruleCount = result.parseMode === 'RULE' ? result.drafts.length : 0
      const degradedCount = result.degraded ? result.drafts.length : 0
      if (!dryRun && result.drafts.length > 0) {
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
          drafts: result.drafts,
          createdCount,
          skippedCount: 0,
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

  app.patch(
    '/api/enterprise/standard-execution/sources/:id/disable',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id 非法' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const exists = await prisma.standardExecutionSource.findFirst({
        where: { id, enterpriseId },
        select: { id: true, status: true },
      })
      if (!exists) return res.status(404).json({ error: '记录不存在' })
      if (exists.status === 'DISABLED') {
        return res.json({ data: exists, alreadyDisabled: true })
      }
      const data = await prisma.standardExecutionSource.update({
        where: { id },
        data: { status: 'DISABLED', updatedBy: req.userId! },
      })
      res.json({ data })
    },
  )

  // ───────────────────────────────────────────────────────────────
  // 企业版：合规周期（Plan）— Step 2 CRUD + Task 绑定
  // ───────────────────────────────────────────────────────────────

  // POST /api/enterprise/standard-execution/plans（Step 1 已建，补 reviewer+ 校验）
  app.post(
    '/api/enterprise/standard-execution/plans',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = PlanCreateSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可创建合规周期' })
      }

      // sourceId FK 校验：source 必须存在且属于同企业
      const source = await prisma.standardExecutionSource.findFirst({
        where: { id: parsed.data.sourceId, enterpriseId },
        select: { id: true },
      })
      if (!source) {
        return res.status(400).json({ error: 'sourceId 对应的标准来源不存在或不属于当前企业' })
      }

      const data = await prisma.standardExecutionPlan.create({
        data: {
          enterpriseId,
          sourceId: parsed.data.sourceId,
          title: parsed.data.title,
          roundNumber: parsed.data.roundNumber ?? 1,
          scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null,
          frequency: parsed.data.frequency ?? null,
          startAt: parsed.data.startAt ? new Date(parsed.data.startAt) : null,
          endAt: parsed.data.endAt ? new Date(parsed.data.endAt) : null,
          nextRunAt: parsed.data.nextRunAt ? new Date(parsed.data.nextRunAt) : null,
          defaultReviewerId: parsed.data.defaultReviewerId ?? null,
          defaultAssigneeIds: parsed.data.defaultAssigneeIds ?? [],
          defaultTaskType: parsed.data.defaultTaskType ?? null,
          defaultDeadlineMode: parsed.data.defaultDeadlineMode,
          defaultDeadlineDaysAfterApproval: parsed.data.defaultDeadlineDaysAfterApproval ?? 7,
          status: 'DRAFT',
          createdBy: req.userId!,
        },
      })
      res.status(201).json({ data })
    },
  )

  // GET /api/enterprise/standard-execution/plans（所有成员可读）
  app.get(
    '/api/enterprise/standard-execution/plans',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return

      const page = Math.max(1, Number(req.query.page) || 1)
      const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 20))
      const skip = (page - 1) * pageSize

      const [total, data] = await Promise.all([
        prisma.standardExecutionPlan.count({ where: { enterpriseId } }),
        prisma.standardExecutionPlan.findMany({
          where: { enterpriseId },
          orderBy: { createdAt: 'desc' },
          skip,
          take: pageSize,
        }),
      ])
      res.json({ data, total, page, pageSize })
    },
  )

  // GET /api/enterprise/standard-execution/plans/:id（含 tasks，所有成员可读）
  app.get(
    '/api/enterprise/standard-execution/plans/:id',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return

      const plan = await prisma.standardExecutionPlan.findFirst({
        where: { id, enterpriseId },
        include: { tasks: true },
      })
      if (!plan) return res.status(404).json({ error: '计划不存在或无权访问' })
      res.json({ data: plan })
    },
  )

  // PATCH /api/enterprise/standard-execution/plans/:id（reviewer+）
  app.patch(
    '/api/enterprise/standard-execution/plans/:id',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可更新合规周期' })
      }

      const parsed = PlanUpdateSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }

      const exists = await prisma.standardExecutionPlan.findFirst({
        where: { id, enterpriseId },
        select: { id: true },
      })
      if (!exists) return res.status(404).json({ error: '计划不存在或无权访问' })

      const { title, status, roundNumber, scheduledAt } = parsed.data
      const updateData: Record<string, unknown> = {}
      if (title !== undefined) updateData.title = title
      if (status !== undefined) updateData.status = status
      if (roundNumber !== undefined) updateData.roundNumber = roundNumber
      if (scheduledAt !== undefined) {
        updateData.scheduledAt = scheduledAt ? new Date(scheduledAt) : null
      }
      if (parsed.data.frequency !== undefined) updateData.frequency = parsed.data.frequency
      if (parsed.data.startAt !== undefined) updateData.startAt = parsed.data.startAt ? new Date(parsed.data.startAt) : null
      if (parsed.data.endAt !== undefined) updateData.endAt = parsed.data.endAt ? new Date(parsed.data.endAt) : null
      if (parsed.data.nextRunAt !== undefined) updateData.nextRunAt = parsed.data.nextRunAt ? new Date(parsed.data.nextRunAt) : null
      if (parsed.data.defaultReviewerId !== undefined) updateData.defaultReviewerId = parsed.data.defaultReviewerId
      if (parsed.data.defaultAssigneeIds !== undefined) updateData.defaultAssigneeIds = parsed.data.defaultAssigneeIds ?? []
      if (parsed.data.defaultTaskType !== undefined) updateData.defaultTaskType = parsed.data.defaultTaskType
      if (parsed.data.defaultDeadlineMode !== undefined) updateData.defaultDeadlineMode = parsed.data.defaultDeadlineMode
      if (parsed.data.defaultDeadlineDaysAfterApproval !== undefined) {
        updateData.defaultDeadlineDaysAfterApproval = parsed.data.defaultDeadlineDaysAfterApproval ?? 7
      }

      const data = await prisma.standardExecutionPlan.update({
        where: { id },
        data: updateData,
      })
      res.json({ data })
    },
  )

  // DELETE /api/enterprise/standard-execution/plans/:id（reviewer+，先解绑关联 task）
  app.delete(
    '/api/enterprise/standard-execution/plans/:id',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可删除合规周期' })
      }

      const exists = await prisma.standardExecutionPlan.findFirst({
        where: { id, enterpriseId },
        select: { id: true },
      })
      if (!exists) return res.status(404).json({ error: '计划不存在或无权访问' })

      // 软删：置 status=CANCELLED，不物理删除（保留关联 task.planId）
      const updated = await prisma.standardExecutionPlan.update({
        where: { id },
        data: { status: 'CANCELLED' },
      })
      res.json({ data: updated })
    },
  )

  // POST /api/enterprise/standard-execution/plans/:id/tasks（批量绑定，reviewer+）
  app.post(
    '/api/enterprise/standard-execution/plans/:id/tasks',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可绑定任务' })
      }

      const parsed = PlanBindTasksSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }

      const plan = await prisma.standardExecutionPlan.findFirst({
        where: { id, enterpriseId },
        select: { id: true, enterpriseId: true },
      })
      if (!plan) return res.status(404).json({ error: '计划不存在或无权访问' })

      const { taskIds } = parsed.data
      // 宽松绑定：updateMany where 带 enterpriseId，只绑属于本企业的 task（幂等，重复绑定无副作用，跨企业 task 自动跳过）
      const result = await prisma.standardExecutionTask.updateMany({
        where: { id: { in: taskIds }, enterpriseId },
        data: { planId: id },
      })
      res.json({ ok: true, bound: result.count })
    },
  )

  // DELETE /api/enterprise/standard-execution/plans/:id/tasks/:taskId（解绑单个，reviewer+）
  app.delete(
    '/api/enterprise/standard-execution/plans/:id/tasks/:taskId',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      const taskId = String(req.params.taskId || '').trim()
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可解绑任务' })
      }

      const plan = await prisma.standardExecutionPlan.findFirst({
        where: { id, enterpriseId },
        select: { id: true, enterpriseId: true },
      })
      if (!plan) return res.status(404).json({ error: '计划不存在或无权访问' })

      const task = await prisma.standardExecutionTask.findFirst({
        where: { id: taskId, enterpriseId },
        select: { id: true },
      })
      if (!task) return res.status(404).json({ error: 'task 不存在或无权访问' })

      await prisma.standardExecutionTask.update({
        where: { id: taskId },
        data: { planId: null },
      })
      res.json({ ok: true })
    },
  )

  // ─── POST /api/enterprise/standard-execution/plans/:id/generate-tasks（REVIEWER+）
  // 按 recommendedTaskType 自动分组；显式 taskType 时统一覆盖成一个任务组。
  app.post(
    '/api/enterprise/standard-execution/plans/:id/generate-tasks',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const planId = String(req.params.id || '').trim()
      if (!planId) return res.status(400).json({ error: 'planId 非法' })

      const parsed = PlanGenerateTasksSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }

      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可生成任务' })
      }

      // plan 存在且属于同企业
      const plan = await prisma.standardExecutionPlan.findFirst({
        where: { id: planId, enterpriseId },
        select: { id: true, title: true },
      })
      if (!plan) return res.status(404).json({ error: '合规周期不存在或无权访问' })

      // requirementIds 都属于同企业且 status=ACTIVE
      const requirements = await prisma.standardExecutionRequirement.findMany({
        where: { id: { in: parsed.data.requirementIds }, enterpriseId },
        select: {
          id: true,
          sourceId: true,
          clauseNo: true,
          title: true,
          requirementText: true,
          status: true,
          recommendedTaskType: true,
          executionDescription: true,
          submitRequirement: true,
          source: {
            select: {
              id: true,
              title: true,
              sourceNo: true,
              sourceType: true,
              version: true,
              isLatestVersion: true,
            },
          },
        },
      })
      if (requirements.length !== parsed.data.requirementIds.length) {
        return res.status(400).json({ error: '部分执行要求不存在或不属于当前企业' })
      }
      const inactive = requirements.filter((r) => r.status !== 'ACTIVE')
      if (inactive.length > 0) {
        return res.status(400).json({ error: `仅 ACTIVE 执行要求可生成任务：${inactive.map((r) => r.title).join('、')}` })
      }
      const oldVersion = requirements.filter((r) => r.source?.isLatestVersion === false)
      if (oldVersion.length > 0) {
        return res.status(400).json({ error: `旧版本标准不可创建任务：${oldVersion.map((r) => r.title).join('、')}` })
      }

      // assigneeIds 非空（zod 已校验 min 1）+ reviewer/assignees 用户存在性
      const v = await validateEnterpriseUsers(enterpriseId, parsed.data.reviewerId, parsed.data.assigneeIds)
      if (!v.reviewerOk) return res.status(400).json({ error: 'reviewerId 对应用户不存在' })
      if (v.missingAssignees.length > 0) {
        return res.status(400).json({ error: `assigneeIds 含不存在的用户：${v.missingAssignees.join(', ')}` })
      }

      // deadlineAt 缺省取 now()+7天
      const deadlineAt = parsed.data.deadlineAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      const prefix = (parsed.data.titlePrefix || '').trim()
      const byId = new Map(requirements.map((r) => [r.id, r]))
      const orderedRequirements = parsed.data.requirementIds.map((id) => byId.get(id)!)

      const existingItems = await prisma.standardExecutionTaskItem.findMany({
        where: {
          requirementId: { in: parsed.data.requirementIds },
          task: {
            enterpriseId,
            planId,
            deletedAt: null,
            status: { not: 'CANCELLED' },
          },
        },
        select: { requirementId: true },
      })
      const existingRequirementIds = new Set(existingItems.map((item) => item.requirementId))
      const newRequirements = orderedRequirements.filter((requirement) => !existingRequirementIds.has(requirement.id))
      if (newRequirements.length === 0) {
        return res.status(200).json({
          ok: true,
          createdTasks: 0,
          createdItems: 0,
          skippedExisting: existingRequirementIds.size,
          taskStatus: parsed.data.taskStatus,
          groups: [],
        })
      }

      const result = await prisma.$transaction((tx) =>
        createGroupedPlanTasks(tx, {
          enterpriseId,
          planId,
          planTitle: plan.title,
          requirements: newRequirements,
          forcedTaskType: parsed.data.taskType ?? null,
          titlePrefix: prefix || null,
          submitRequirement: parsed.data.submitRequirement,
          deadlineAt,
          deadlineMode: parsed.data.deadlineMode,
          deadlineDaysAfterApproval: parsed.data.deadlineDaysAfterApproval ?? null,
          reviewerId: parsed.data.reviewerId,
          assigneeIds: parsed.data.assigneeIds,
          taskStatus: parsed.data.taskStatus,
          createdBy: req.userId!,
        }),
      )

      res.status(201).json({
        ok: true,
        createdTasks: result.createdTasks,
        createdItems: result.createdItems,
        skippedExisting: existingRequirementIds.size,
        taskStatus: parsed.data.taskStatus,
        groups: result.groups,
      })
    },
  )

  async function loadComplianceCycleDashboard(enterpriseId: string, cycleId: string) {
    const cycle = await prisma.sEComplianceCycle.findFirst({ where: { id: cycleId, enterpriseId } })
    if (!cycle) return null
    const requirementIds = jsonStringArray(cycle.requirementIds)
    const [template, requirements, tasks, records] = await Promise.all([
      prisma.sEComplianceCycleTemplate.findFirst({ where: { id: cycle.templateId, enterpriseId } }),
      prisma.standardExecutionRequirement.findMany({
        where: { id: { in: requirementIds }, enterpriseId },
        include: { source: { select: { id: true, title: true, sourceNo: true, version: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      cycle.planId
        ? prisma.standardExecutionTask.findMany({
          where: { enterpriseId, planId: cycle.planId, deletedAt: null },
          include: {
            assignees: true,
            items: { include: { requirement: { select: { id: true, clauseNo: true, title: true } } } },
          },
          orderBy: { createdAt: 'asc' },
        })
        : Promise.resolve([]),
      prisma.standardExecutionRecord.findMany({
        where: { enterpriseId, requirementId: { in: requirementIds }, status: 'VALID' },
        orderBy: { recordDate: 'desc' },
      }),
    ])
    const coveredRequirementIds = new Set(records.map((record) => record.requirementId))
    const now = Date.now()
    const overdueTasks = tasks.filter((task) =>
      task.status === 'OVERDUE' ||
      (task.status === 'PUBLISHED' && task.deadlineAt && task.deadlineAt.getTime() < now),
    )
    return {
      cycle,
      template,
      requirements,
      tasks,
      records,
      stats: {
        totalRequirements: requirementIds.length,
        coveredRequirements: coveredRequirementIds.size,
        progressPercent: requirementIds.length ? Math.round((coveredRequirementIds.size / requirementIds.length) * 100) : 0,
        overdueTasks: overdueTasks.length,
        totalTasks: tasks.length,
        completedTasks: tasks.filter((task) => task.status === 'COMPLETED').length,
      },
      requirementRows: requirements.map((requirement) => {
        const latestRecord = records.find((record) => record.requirementId === requirement.id)
        const taskItems = tasks.flatMap((task) => task.items.filter((item) => item.requirementId === requirement.id).map((item) => ({ ...item, task })))
        const latestDoneItem = taskItems.find((item) => item.status === 'DONE')
        return {
          id: requirement.id,
          clauseNo: requirement.clauseNo,
          title: requirement.title,
          sourceTitle: requirement.source?.title ?? null,
          sourceNo: requirement.source?.sourceNo ?? null,
          status: latestRecord ? 'COVERED' : latestDoneItem ? 'DONE_NO_RECORD' : 'PENDING',
          taskCount: taskItems.length,
          latestRecordDate: latestRecord?.recordDate ?? null,
          validUntil: latestRecord?.validUntil ?? null,
        }
      }),
    }
  }

  app.get(
    '/api/enterprise/standard-execution/cycle-templates',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = ComplianceCycleTemplateListSchema.safeParse(req.query)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const { status, cycleType, page, pageSize } = parsed.data
      const where: Prisma.SEComplianceCycleTemplateWhereInput = { enterpriseId }
      if (status) where.status = status
      if (cycleType) where.cycleType = cycleType
      const [data, total] = await Promise.all([
        prisma.sEComplianceCycleTemplate.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.sEComplianceCycleTemplate.count({ where }),
      ])
      res.json({ data, total, page, pageSize })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/cycle-templates',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = ComplianceCycleTemplateCreateSchema.safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可创建周期模板' })
      }

      const requirements = await prisma.standardExecutionRequirement.findMany({
        where: { id: { in: parsed.data.requirementIds }, enterpriseId },
        select: { id: true, status: true, title: true },
      })
      if (requirements.length !== parsed.data.requirementIds.length) {
        return res.status(400).json({ error: '部分控制点不存在或不属于当前企业' })
      }
      const inactive = requirements.filter((requirement) => requirement.status !== 'ACTIVE')
      if (inactive.length > 0) {
        return res.status(400).json({ error: `仅 ACTIVE 控制点可加入周期模板：${inactive.map((r) => r.title).join('、')}` })
      }

      const data = await prisma.sEComplianceCycleTemplate.create({
        data: {
          enterpriseId,
          title: parsed.data.title,
          cycleType: parsed.data.cycleType,
          requirementIds: parsed.data.requirementIds,
          taskConfig: parsed.data.taskConfig as Prisma.InputJsonValue,
          createdBy: req.userId!,
        },
      })
      res.status(201).json({ data })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/cycle-templates/:id/start',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const templateId = String(req.params.id || '').trim()
      const parsed = ComplianceCycleStartSchema.safeParse(req.body)
      if (!templateId) return res.status(400).json({ error: 'templateId 非法' })
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可启动周期' })
      }

      const template = await prisma.sEComplianceCycleTemplate.findFirst({
        where: { id: templateId, enterpriseId, status: 'ACTIVE' },
      })
      if (!template) return res.status(404).json({ error: '周期模板不存在或已停用' })
      const requirementIds = jsonStringArray(template.requirementIds)
      const config = mergeCycleTaskConfig(normalizeCycleTaskConfig(template.taskConfig), parsed.data)
      const reviewerId = config.reviewerId || null
      const assigneeIds = config.assigneeIds ?? []
      if (!reviewerId || assigneeIds.length === 0) {
        return res.status(400).json({ error: '启动周期必须指定审核人和至少 1 个执行人' })
      }
      const userCheck = await validateEnterpriseUsers(enterpriseId, reviewerId, assigneeIds)
      if (!userCheck.reviewerOk) return res.status(400).json({ error: 'reviewerId 对应用户不存在或不属于本企业' })
      if (userCheck.missingAssignees.length > 0) {
        return res.status(400).json({ error: `assigneeIds 含不存在或不属于本企业的用户：${userCheck.missingAssignees.join(', ')}` })
      }

      const requirements = await prisma.standardExecutionRequirement.findMany({
        where: { id: { in: requirementIds }, enterpriseId },
        select: {
          id: true,
          sourceId: true,
          clauseNo: true,
          title: true,
          requirementText: true,
          status: true,
          recommendedTaskType: true,
          executionDescription: true,
          submitRequirement: true,
          source: { select: { id: true, title: true, sourceNo: true, sourceType: true, version: true, isLatestVersion: true } },
        },
      })
      if (requirements.length !== requirementIds.length) {
        return res.status(400).json({ error: '周期模板包含不存在或已移出本企业的控制点' })
      }
      const inactive = requirements.filter((requirement) => requirement.status !== 'ACTIVE')
      if (inactive.length > 0) {
        return res.status(400).json({ error: `仅 ACTIVE 控制点可启动周期：${inactive.map((r) => r.title).join('、')}` })
      }
      const oldVersion = requirements.filter((requirement) => requirement.source?.isLatestVersion === false)
      if (oldVersion.length > 0) {
        return res.status(400).json({ error: `旧版本标准不可启动周期：${oldVersion.map((r) => r.title).join('、')}` })
      }
      const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]))
      const orderedRequirements = requirementIds.map((id) => byId.get(id)!)
      const cycleTitle = parsed.data.title || `${template.title} ${formatDate(parsed.data.startDate)}~${formatDate(parsed.data.endDate)}`
      const deadlineMode = config.deadlineMode ?? 'AFTER_APPROVAL_DAYS'
      const deadlineAt = deadlineMode === 'FIXED' ? (config.deadlineAt ?? parsed.data.endDate) : null
      const storedConfig = { ...config }
      delete storedConfig.deadlineAt

      const result = await prisma.$transaction(async (tx) => {
        const cycle = await tx.sEComplianceCycle.create({
          data: {
            enterpriseId,
            templateId: template.id,
            title: cycleTitle,
            cycleType: template.cycleType,
            requirementIds,
            taskConfig: storedConfig as Prisma.InputJsonValue,
            startDate: parsed.data.startDate,
            endDate: parsed.data.endDate,
            status: 'ACTIVE',
            createdBy: req.userId!,
          },
        })
        const plan = await tx.standardExecutionPlan.create({
          data: {
            enterpriseId,
            sourceId: orderedRequirements[0].sourceId,
            complianceCycleId: cycle.id,
            title: cycleTitle,
            roundNumber: 1,
            scheduledAt: parsed.data.startDate,
            frequency: cycleFrequency(template.cycleType),
            startAt: parsed.data.startDate,
            endAt: parsed.data.endDate,
            nextRunAt: parsed.data.startDate,
            defaultReviewerId: reviewerId,
            defaultAssigneeIds: assigneeIds,
            defaultTaskType: config.taskType ?? null,
            defaultDeadlineMode: deadlineMode,
            defaultDeadlineDaysAfterApproval: config.deadlineDaysAfterApproval ?? 7,
            status: 'ACTIVE',
            createdBy: req.userId!,
          },
        })
        await tx.sEComplianceCycle.update({ where: { id: cycle.id }, data: { planId: plan.id } })
        const tasks = await createGroupedPlanTasks(tx, {
          enterpriseId,
          planId: plan.id,
          planTitle: plan.title,
          requirements: orderedRequirements,
          forcedTaskType: config.taskType ?? null,
          titlePrefix: config.titlePrefix ?? cycleTitle,
          submitRequirement: config.submitRequirement,
          deadlineAt,
          deadlineMode,
          deadlineDaysAfterApproval: config.deadlineDaysAfterApproval ?? null,
          reviewerId,
          assigneeIds,
          taskStatus: config.taskStatus ?? 'DRAFT',
          createdBy: req.userId!,
        })
        return { cycle: { ...cycle, planId: plan.id }, plan, tasks }
      })

      res.status(201).json({
        data: result.cycle,
        plan: result.plan,
        createdTasks: result.tasks.createdTasks,
        createdItems: result.tasks.createdItems,
        groups: result.tasks.groups,
      })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/cycles',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const parsed = ComplianceCycleListSchema.safeParse(req.query)
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const { status, templateId, page, pageSize } = parsed.data
      const where: Prisma.SEComplianceCycleWhereInput = { enterpriseId }
      if (status) where.status = status
      if (templateId) where.templateId = templateId
      const [data, total] = await Promise.all([
        prisma.sEComplianceCycle.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.sEComplianceCycle.count({ where }),
      ])
      res.json({ data, total, page, pageSize })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/cycles/:id',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const dashboard = await loadComplianceCycleDashboard(enterpriseId, id)
      if (!dashboard) return res.status(404).json({ error: '周期不存在或无权访问' })
      res.json({ data: dashboard.cycle, template: dashboard.template, stats: dashboard.stats, requirements: dashboard.requirementRows, tasks: dashboard.tasks })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/cycles/:id/report',
    requireAuth as never,
    async (req: AuthRequest, res: Response) => {
      const id = String(req.params.id || '').trim()
      const enterpriseId = await resolveEnterpriseId(req, res)
      if (!enterpriseId) return
      const role = await resolveEnterpriseRole(req)
      if (role !== 'ADMIN' && role !== 'MANAGER' && role !== 'REVIEWER') {
        return res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可生成周期报告' })
      }
      const dashboard = await loadComplianceCycleDashboard(enterpriseId, id)
      if (!dashboard) return res.status(404).json({ error: '周期不存在或无权访问' })
      const enterprise = await prisma.enterprise.findUnique({ where: { id: enterpriseId }, select: { name: true } })
      const title = `${enterprise?.name || enterpriseId}-${dashboard.cycle.title}-合规报告-${formatDate(new Date())}`
      const lines = [
        `企业：${enterprise?.name || enterpriseId}`,
        `周期：${dashboard.cycle.title}`,
        `周期类型：${dashboard.cycle.cycleType}`,
        `起止日期：${formatDate(dashboard.cycle.startDate)} ~ ${formatDate(dashboard.cycle.endDate)}`,
        `状态：${dashboard.cycle.status}`,
        '',
        '## 执行统计',
        `控制点：${dashboard.stats.coveredRequirements}/${dashboard.stats.totalRequirements} 已覆盖（${dashboard.stats.progressPercent}%）`,
        `执行任务：${dashboard.stats.completedTasks}/${dashboard.stats.totalTasks} 已完成`,
        `逾期任务：${dashboard.stats.overdueTasks}`,
        '',
        '## 控制点执行状态',
        ...dashboard.requirementRows.map((row, index) => (
          `${index + 1}. ${[row.sourceNo, row.clauseNo, row.title].filter(Boolean).join(' ')} | ${row.status} | 最近记录 ${formatDate(row.latestRecordDate)} | 有效期 ${formatDate(row.validUntil)}`
        )),
      ]
      await mkdir(CYCLE_REPORT_DIR, { recursive: true })
      const fileName = `${dashboard.cycle.id}.pdf`
      const filePath = path.join(CYCLE_REPORT_DIR, fileName)
      const fileUrl = `/uploads/se-cycle-reports/${fileName}`
      const pdf = await buildComplianceCyclePdfBuffer(title, lines)
      await writeFile(filePath, pdf)
      const updated = await prisma.sEComplianceCycle.update({
        where: { id: dashboard.cycle.id },
        data: { reportStatus: 'READY', reportFileUrl: fileUrl, reportGeneratedAt: new Date(), updatedBy: req.userId! },
      })
      res.json({ data: updated, fileUrl, fileName: `${enterprise?.name || enterpriseId}-${dashboard.cycle.title}-合规报告-${formatDate(new Date())}.pdf` })
    },
  )

  // ─── 企业试用开通（admin only）─────────────────────
  // POST /api/admin/enterprise/provision
  // 替代「给 admin 账号开试用」的旧做法（安全漏洞：admin role 同时拿到平台后台权限）。
  // 正确姿势：试用客户 role='user' + 独立 enterpriseId + enterpriseRole='ADMIN'。
  app.post(
    '/api/admin/enterprise/provision',
    requireAdmin as never,
    async (req: AuthRequest, res: Response) => {
      const schema = z.object({
        phone: z.string().regex(/^1[3-9]\d{9}$/, '手机号格式错误'),
        name: z.string().trim().min(1).optional(),
        enterpriseName: z.string().trim().min(1, '企业名称必填'),
        enterpriseId: z.string().trim().min(1).optional(), // 传入则复用已有企业，否则新建独立企业
      })
      const parsed = schema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }
      const { phone, name, enterpriseName, enterpriseId: reqEntId } = parsed.data

      // 1. 找或建独立 Enterprise（真多租户：每客户独立 enterpriseId）
      let enterprise
      if (reqEntId) {
        enterprise = await prisma.enterprise.findUnique({ where: { id: reqEntId } })
        if (!enterprise) return res.status(404).json({ error: '指定的 enterpriseId 不存在' })
      } else {
        const code = `ENT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
        enterprise = await prisma.enterprise.create({ data: { name: enterpriseName, code } })
      }

      // 2. 找或建 AppUser（role 强制 'user'，绝不写 admin）
      const existing = await prisma.appUser.findUnique({ where: { phone } })
      let user
      if (existing) {
        if (existing.enterpriseId && existing.enterpriseId !== enterprise.id) {
          return res.status(409).json({ error: '该手机号已属于其他企业，请先解绑' })
        }
        user = await prisma.appUser.update({
          where: { id: existing.id },
          data: {
            enterpriseId: enterprise.id,
            enterpriseRole: 'ADMIN',
            ...(name && !existing.name ? { name } : {}),
          },
        })
      } else {
        const userId = `ent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        user = await prisma.appUser.create({
          data: {
            id: userId,
            phone,
            name: name ?? null,
            role: 'user',
            enterpriseId: enterprise.id,
            enterpriseRole: 'ADMIN',
            passwordHash: await hashPassword(phone.slice(-6)), // 初始密码 = 手机号后 6 位
          },
        })
      }

      res.status(201).json({
        userId: user.id,
        enterpriseId: enterprise.id,
        enterpriseName: enterprise.name,
        phone: user.phone,
        enterpriseRole: 'ADMIN',
        created: !existing,
        defaultPassword: existing ? null : phone.slice(-6), // 仅新建用户返回初始密码，提醒通知客户修改
      })
    },
  )
}
