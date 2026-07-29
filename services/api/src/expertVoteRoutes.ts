/**
 * 专家评审投票路由 — P0-1 仅暴露用户端最小闭环
 *
 *   /api/app/expert-votes                          GET   列表（仅本人）
 *   /api/app/expert-votes                          POST  创建草稿
 *   /api/app/expert-votes/:no                      GET   详情
 *   /api/app/expert-votes/:no                      PATCH 编辑草稿（仅 DRAFT）
 *   /api/app/expert-votes/:no                      DELETE 删除草稿（仅 DRAFT）
 *   /api/app/expert-votes/:no/submit               POST  提交并下单（DRAFT → PAYING）
 *   /api/app/expert-votes/:no/cancel               POST  取消（PAYING）
 *   /api/app/expert-votes/:no/attachments          POST  上传材料
 *   /api/app/expert-votes/:no/attachments/:aid     DELETE 删除附件（仅 DRAFT）
 *
 * 后台路由（专家组织 / 会议安排 / 投票管理 / 签章交付）放 P0-2 / P0-3，本文件不涉及。
 *
 * 设计原则：
 *   - 不复用 /api/app/orders 的 createOrder（耦合优惠券 / 幂等逻辑），
 *     提交时直接事务建单 + 状态迁移，金额从 ExpertVoteRequest.totalAmount 快照取。
 *   - 14 天提前约束在草稿 PATCH 与 submit 双重校验。
 *   - 附件大小双闸门：multer fileSize + 业务层累计 totalSize。
 */
import type { Express, Request } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import * as crypto from 'crypto'
import { prisma } from './db.js'
import { requireAuth, requirePermission, type AuthRequest } from './auth.js'
import {
  PRESET_EXPERT_COUNTS,
  isValidExpertCount,
  EXPERT_VOTE_DEFAULTS,
  assertDesiredDateLeadTime,
  assertDraftSubmittable,
  calcExpertVoteAmount,
  getExpertVoteFileMaxBytes,
  getExpertVoteTotalMaxBytes,
  getExpertVoteMinLeadDays,
  getExpertVotePathAEnabled,
  getExpertVoteUnitPrice,
  makeExpertVoteRequestNo,
  transitionStatus,
} from './services/expertVote.js'

const EXPERT_VOTE_UPLOAD_DIR = join(process.cwd(), 'uploads', 'expert-votes')
if (!existsSync(EXPERT_VOTE_UPLOAD_DIR)) mkdirSync(EXPERT_VOTE_UPLOAD_DIR, { recursive: true })

// ─── 工具 ────────────────────────────────────────────────────

function getUserId(req: AuthRequest): string {
  return req.userId || ''
}

function makeOrderNo(): string {
  const now = new Date()
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  const random = Math.floor(Math.random() * 900000 + 100000)
  return `ORD-${parts}-${random}`
}

const PROJECT_TYPES = ['标准评审', '专家投票', '项目论证', '成果评价', '技术咨询', '其他'] as const
const STANDARD_TYPES = ['国家标准', '行业标准', '地方标准', '团体标准', '企业标准', '技术规范', '其他'] as const
const STANDARD_STATUSES = ['立项前', '已立项', '起草中', '征求意见后', '送审稿', '报批前', '已发布', '复审中'] as const
const CONFIDENTIAL_LEVELS = ['NONE', 'SENSITIVE', 'STRICT'] as const
const EXPERT_SOURCES = ['PLATFORM', 'USER_SPECIFIED'] as const
const SLOTS = ['MORNING', 'AFTERNOON', 'EVENING', 'ANY'] as const

const draftSchema = z.object({
  // 申请人联系信息（提交时校验必填，草稿阶段允许缺省）
  contactName: z.string().min(2).max(50).optional(),
  contactPhone: z.string().regex(/^1[3-9]\d{9}$/, '请输入有效的中国大陆手机号').optional(),

  projectName: z.string().min(1).max(200),
  targetName: z.string().min(1).max(200),
  projectType: z.enum(PROJECT_TYPES),
  standardType: z.enum(STANDARD_TYPES),
  standardStatus: z.enum(STANDARD_STATUSES),
  industries: z.array(z.string()).default([]),
  keywords: z.string().max(500).optional(),
  draftingOrgs: z.string().max(500).optional(),
  participatingOrgs: z.string().max(2000).optional(),
  backgroundDesc: z.string().min(1).max(5000),
  disputePoints: z.string().max(5000).optional(),
  expectedFinishAt: z.string().optional(),
  confidentialLevel: z.enum(CONFIDENTIAL_LEVELS).default('NONE'),
  confidentialRemark: z.string().max(2000).optional(),

  expertSourceType: z.enum(EXPERT_SOURCES),
  expertCategories: z.array(z.string()).default([]),
  expertKeywords: z.string().max(500).optional(),
  titleRequirements: z.array(z.string()).default(['不限']),
  orgBackgroundRequirements: z.array(z.string()).default(['不限']),
  expertCount: z.number().int().refine(isValidExpertCount, {
    message: '专家数量必须为奇数且不少于 3 位',
  }),
  extraExpertNote: z.string().max(2000).optional(),
  userSpecifiedExperts: z.string().max(5000).optional(),

  desiredDate: z.string().optional(), // ISO date 字符串
  desiredSlot: z.enum(SLOTS).optional(),
  acceptReschedule: z.boolean().default(true),
  backupTimeNote: z.string().max(2000).optional(),

  materialRemark: z.string().max(2000).optional(),
})

type DraftPayload = z.infer<typeof draftSchema>

function parseOptionalDate(v: string | undefined | null): Date | null {
  if (!v) return null
  const d = new Date(v)
  if (isNaN(d.getTime())) throw new Error('日期格式无效')
  return d
}

function toDraftDbInput(p: DraftPayload) {
  return {
    contactName: p.contactName ?? null,
    contactPhone: p.contactPhone ?? null,
    projectName: p.projectName,
    targetName: p.targetName,
    projectType: p.projectType,
    standardType: p.standardType,
    standardStatus: p.standardStatus,
    industries: JSON.stringify(p.industries),
    keywords: p.keywords ?? null,
    draftingOrgs: p.draftingOrgs ?? null,
    participatingOrgs: p.participatingOrgs ?? null,
    backgroundDesc: p.backgroundDesc,
    disputePoints: p.disputePoints ?? null,
    expectedFinishAt: parseOptionalDate(p.expectedFinishAt),
    confidentialLevel: p.confidentialLevel,
    confidentialRemark: p.confidentialRemark ?? null,
    expertSourceType: p.expertSourceType,
    expertCategories: JSON.stringify(p.expertCategories),
    expertKeywords: p.expertKeywords ?? null,
    titleRequirements: JSON.stringify(p.titleRequirements ?? ['不限']),
    orgBackgroundRequirements: JSON.stringify(p.orgBackgroundRequirements ?? ['不限']),
    expertCount: p.expertCount,
    extraExpertNote: p.extraExpertNote ?? null,
    userSpecifiedExperts: p.userSpecifiedExperts ?? null,
    desiredDate: parseOptionalDate(p.desiredDate),
    desiredSlot: p.desiredSlot ?? null,
    acceptReschedule: p.acceptReschedule,
    backupTimeNote: p.backupTimeNote ?? null,
    materialRemark: p.materialRemark ?? null,
  }
}

function serializeRequest(r: any) {
  if (!r) return null
  return {
    ...r,
    industries: parseJsonArr(r.industries),
    expertCategories: parseJsonArr(r.expertCategories),
    titleRequirements: parseJsonArr(r.titleRequirements),
    orgBackgroundRequirements: parseJsonArr(r.orgBackgroundRequirements),
  }
}

// 用户端响应剥离的字段：
//   - 会议密码 / 内部文件系统路径 / 管理员操作员 userId / 内部通知标记
//   - PRD §10：站内消息不暴露密码；接口字段也应保持同等口径
const USER_STRIP_FIELDS = [
  'tencentMeetingPwd',
  'resultPdfPath',
  'resultDocxPath',
  'finalDeliverablePath',
  'signedPdfPath',
  'expertSignatureMaterialPath',
  'meetingArrangedBy',
  'voteClosedBy',
  'cancelledBy',
  'deliveredBy',
  'signedBy',
  'notifiedBy',
  'notifiedAt',
] as const

function serializeRequestForUser(r: any) {
  const base = serializeRequest(r)
  if (!base) return null
  const finalDeliverablePath = base.finalDeliverablePath || base.signedPdfPath
  const finalDeliverableReady = base.status === 'COMPLETED' && !!finalDeliverablePath
  const finalDeliverableExt = finalDeliverablePath?.endsWith('.pdf') ? '.pdf' : '.docx'
  const out: Record<string, any> = { ...base }
  for (const k of USER_STRIP_FIELDS) delete out[k]
  out.finalDeliverableReady = finalDeliverableReady
  if (finalDeliverableReady) {
    out.finalDeliverableFileName = `${base.requestNo}_专家评审最终交付文件${finalDeliverableExt}`
  }
  return out
}

function parseJsonArr(v: string | null | undefined): any[] {
  if (!v) return []
  try {
    const x = JSON.parse(v)
    return Array.isArray(x) ? x : []
  } catch { return [] }
}

// ─── 路由注册 ────────────────────────────────────────────────

export function registerExpertVoteRoutes(app: Express) {
  // ───── 价格与配置（公开，无需登录）─────
  // 前端申请表 / 列表空态展示价格 / 14 天约束 / 文件上限用
  // 价格统一从 SystemSetting 读，不在前端写死
  app.get('/api/app/expert-votes/pricing', async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60')
    try {
      const [unitPrice, minLeadDays, fileMaxBytes, totalMaxBytes] = await Promise.all([
        getExpertVoteUnitPrice(),
        getExpertVoteMinLeadDays(),
        getExpertVoteFileMaxBytes(),
        getExpertVoteTotalMaxBytes(),
      ])
      res.json({
        unitPrice,
        unitPriceYuan: Math.round(unitPrice / 100),
        minLeadDays,
        expertCountOptions: [...PRESET_EXPERT_COUNTS],
        fileMaxMb: Math.round(fileMaxBytes / 1024 / 1024),
        totalMaxMb: Math.round(totalMaxBytes / 1024 / 1024),
      })
    } catch {
      res.status(500).json({
        // 兜底：返回硬编码默认值，避免前端空白
        unitPrice: EXPERT_VOTE_DEFAULTS.UNIT_PRICE,
        unitPriceYuan: Math.round(EXPERT_VOTE_DEFAULTS.UNIT_PRICE / 100),
        minLeadDays: EXPERT_VOTE_DEFAULTS.MIN_LEAD_DAYS,
        expertCountOptions: [...PRESET_EXPERT_COUNTS],
        fileMaxMb: EXPERT_VOTE_DEFAULTS.FILE_MAX_MB,
        totalMaxMb: EXPERT_VOTE_DEFAULTS.TOTAL_MAX_MB,
        error: '配置加载失败，使用默认值',
      })
    }
  })

  // ───── 列表 ─────
  app.get('/api/app/expert-votes', requireAuth, async (req: AuthRequest, res) => {
    const userId = getUserId(req)
    const items = await prisma.expertVoteRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ items: items.map(serializeRequestForUser) })
  })

  // ───── 详情 ─────
  app.get('/api/app/expert-votes/:no', requireAuth, async (req: AuthRequest, res) => {
    const userId = getUserId(req)
    const requestNo = String(req.params.no || '')
    const r = await prisma.expertVoteRequest.findUnique({
      where: { requestNo },
      include: {
        attachments: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
        // 专家名单：仅返回展示字段，严禁暴露 phone/email（安全边界）
        experts: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            expertName: true,
            expertOrg: true,
            expertTitle: true,
            expertField: true,
            note: true,
          },
        },
      },
    })
    if (!r) return res.status(404).json({ error: '申请不存在' })
    if (r.userId !== userId) return res.status(403).json({ error: '无权查看此申请' })
    res.json(serializeRequestForUser(r))
  })

  // ───── 创建草稿 ─────
  app.post('/api/app/expert-votes', requireAuth, async (req: AuthRequest, res) => {
    const userId = getUserId(req)
    const parsed = draftSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    }
    try {
      await assertDesiredDateLeadTime(parseOptionalDate(parsed.data.desiredDate))
    } catch (err: any) {
      return res.status(400).json({ error: err.message })
    }
    const requestNo = makeExpertVoteRequestNo()
    const created = await prisma.expertVoteRequest.create({
      data: {
        requestNo,
        userId,
        status: 'DRAFT',
        ...toDraftDbInput(parsed.data),
      },
    })
    res.json(serializeRequestForUser(created))
  })

  // ───── 编辑草稿（仅 DRAFT） ─────
  app.patch('/api/app/expert-votes/:no', requireAuth, async (req: AuthRequest, res) => {
    const userId = getUserId(req)
    const requestNo = String(req.params.no || '')
    const existing = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    if (!existing) return res.status(404).json({ error: '申请不存在' })
    if (existing.userId !== userId) return res.status(403).json({ error: '无权编辑此申请' })
    if (existing.status !== 'DRAFT') return res.status(409).json({ error: '仅草稿可编辑' })

    const parsed = draftSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    }
    try {
      await assertDesiredDateLeadTime(parseOptionalDate(parsed.data.desiredDate))
    } catch (err: any) {
      return res.status(400).json({ error: err.message })
    }
    const updated = await prisma.expertVoteRequest.update({
      where: { requestNo },
      data: toDraftDbInput(parsed.data),
    })
    res.json(serializeRequestForUser(updated))
  })

  // ───── 删除草稿 ─────
  app.delete('/api/app/expert-votes/:no', requireAuth, async (req: AuthRequest, res) => {
    const userId = getUserId(req)
    const requestNo = String(req.params.no || '')
    const existing = await prisma.expertVoteRequest.findUnique({
      where: { requestNo },
      include: { attachments: true },
    })
    if (!existing) return res.status(404).json({ error: '申请不存在' })
    if (existing.userId !== userId) return res.status(403).json({ error: '无权删除此申请' })
    const DELETABLE_STATUSES = ['DRAFT', 'CANCELLED', 'COMPLETED']
    if (!DELETABLE_STATUSES.includes(existing.status)) {
      return res.status(409).json({ error: '当前状态不可删除，仅草稿/已取消/已完成可删除' })
    }

    // 物理删附件文件（best-effort，失败不影响主流程）
    for (const a of existing.attachments) {
      try { unlinkSync(a.storagePath) } catch { /* ignore */ }
    }
    // ExpertVoteAttachment 通过 onDelete: Cascade 自动清理
    await prisma.expertVoteRequest.delete({ where: { requestNo } })
    res.json({ ok: true })
  })

  // ───── 提交并下单（DRAFT → PAYING）─────
  // 事务：transitionStatus + AppOrder.create（productType=EXPERT_VOTE / productRef=requestNo）
  // 金额：unitPrice = SystemSetting.expert_vote_unit_price 当前值；锁定到 ExpertVoteRequest 与 AppOrder
  app.post('/api/app/expert-votes/:no/submit', requireAuth, async (req: AuthRequest, res) => {
    const userId = getUserId(req)
    const requestNo = String(req.params.no || '')
    const existing = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    if (!existing) return res.status(404).json({ error: '申请不存在' })
    if (existing.userId !== userId) return res.status(403).json({ error: '无权操作此申请' })
    if (existing.status !== 'DRAFT') return res.status(409).json({ error: '仅草稿可提交' })

    // 必填 / 14 天 / 涉密 等校验（从 DB 行读取）
    try {
      await assertDraftSubmittable({
        contactName: (existing as any).contactName ?? null,
        contactPhone: (existing as any).contactPhone ?? null,
        projectName: existing.projectName,
        targetName: existing.targetName,
        projectType: existing.projectType,
        standardType: existing.standardType,
        standardStatus: existing.standardStatus,
        backgroundDesc: existing.backgroundDesc,
        expertSourceType: existing.expertSourceType,
        expertCount: existing.expertCount,
        desiredDate: existing.desiredDate,
        desiredSlot: existing.desiredSlot,
        confidentialLevel: existing.confidentialLevel,
        confidentialRemark: existing.confidentialRemark,
      })
    } catch (err: any) {
      return res.status(400).json({ error: err.message })
    }

    const unitPrice = await getExpertVoteUnitPrice()
    let totalAmount: number
    try {
      totalAmount = calcExpertVoteAmount(existing.expertCount, unitPrice)
    } catch (err: any) {
      return res.status(400).json({ error: err.message })
    }

    const orderNo = makeOrderNo()

    try {
      const result = await prisma.$transaction(async (tx) => {
        // CAS DRAFT → PAYING + 锁单价快照
        const moved = await transitionStatus(tx, requestNo, 'DRAFT', 'PAYING', {
          unitPrice,
          totalAmount,
          orderNo,
          submittedAt: new Date(),
        })
        if (!moved) {
          throw new Error('申请状态已变更，请刷新后重试')
        }

        const order = await tx.appOrder.create({
          data: {
            orderNo,
            userId,
            productType: 'EXPERT_VOTE',
            productRef: requestNo,
            title: `专家评审投票服务 · ${existing.projectName}`,
            amount: totalAmount,
            originalAmount: totalAmount,
            discountAmount: 0,
          },
        })
        const updated = await tx.expertVoteRequest.findUnique({ where: { requestNo } })
        return { request: updated, order }
      })
      res.json({
        request: serializeRequestForUser(result.request),
        order: result.order,
      })
    } catch (err: any) {
      return res.status(400).json({ error: err.message || '提交失败' })
    }
  })

  // ───── 用户取消（PAYING）─────
  // 仅 PAYING 阶段允许用户取消；EXPERT_ARRANGING 之后必须走后台退款
  app.post('/api/app/expert-votes/:no/cancel', requireAuth, async (req: AuthRequest, res) => {
    const userId = getUserId(req)
    const requestNo = String(req.params.no || '')
    const existing = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    if (!existing) return res.status(404).json({ error: '申请不存在' })
    if (existing.userId !== userId) return res.status(403).json({ error: '无权操作此申请' })
    if (existing.status !== 'PAYING') {
      return res.status(409).json({ error: '当前状态不允许用户取消，请联系客服' })
    }

    try {
      await prisma.$transaction(async (tx) => {
        const moved = await transitionStatus(tx, requestNo, 'PAYING', 'CANCELLED', {
          cancelledAt: new Date(),
          cancelledBy: userId,
          cancelReason: '用户取消',
        })
        if (!moved) throw new Error('状态已变更，请刷新后重试')
        if (existing.orderNo) {
          await tx.appOrder.updateMany({
            where: { orderNo: existing.orderNo, status: { in: ['PENDING', 'PAYING'] } },
            data: { status: 'CANCELLED', failReason: '用户取消' },
          })
        }
      })
      res.json({ ok: true })
    } catch (err: any) {
      return res.status(400).json({ error: err.message })
    }
  })

  // ───── 附件上传（仅 DRAFT）─────
  // multer 单文件 50MB（SystemSetting 可调）；业务层校验单申请总上限 200MB
  // category: MAIN（必填材料）/ EXTRA（辅助材料）
  const ALLOWED_MIME = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/jpeg', 'image/png', 'image/webp',
    'application/zip', 'application/x-zip-compressed',
    'application/octet-stream', // 兜底（部分客户端 zip / docx 走这个）
  ])

  const uploadHandler = (() => {
    // multer 在 app 启动时实例化即可（fileSize 限制每次上传从 SystemSetting 校验，下面在中间件里再算一次）
    // 这里 50MB 上限作为外层硬闸，避免大于 50MB 的请求穿透到业务层
    const FALLBACK_FILE_MAX = 50 * 1024 * 1024
    return multer({
      storage: multer.diskStorage({
        destination: (req, _file, cb) => {
          const requestNo = String((req.params as any).no || 'unassigned')
          const dir = join(EXPERT_VOTE_UPLOAD_DIR, requestNo)
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          cb(null, dir)
        },
        filename: (_req, file, cb) => {
          // utf8 文件名修复（与 appRoutes.ts 同款）
          file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8')
          const ts = Date.now()
          const rand = Math.floor(Math.random() * 1e6).toString(36)
          // 保留原扩展名
          const dotIdx = file.originalname.lastIndexOf('.')
          const ext = dotIdx > 0 ? file.originalname.slice(dotIdx) : ''
          cb(null, `${ts}-${rand}${ext}`)
        },
      }),
      limits: { fileSize: FALLBACK_FILE_MAX },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_MIME.has(file.mimetype)) {
          return cb(new Error('不支持的文件类型'))
        }
        cb(null, true)
      },
    })
  })()

  app.post('/api/app/expert-votes/:no/attachments',
    requireAuth,
    (req, res, next) => uploadHandler.single('file')(req, res, (err: any) => {
      if (err) {
        if (err.message === 'File too large' || err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: '文件超过单文件大小限制' })
        }
        return res.status(400).json({ error: err.message || '上传失败' })
      }
      next()
    }),
    async (req: AuthRequest, res) => {
      const userId = getUserId(req)
      const requestNo = String(req.params.no || '')
      const file = (req as any).file as Express.Multer.File | undefined
      if (!file) return res.status(400).json({ error: '缺少 file 字段' })

      const existing = await prisma.expertVoteRequest.findUnique({
        where: { requestNo },
        include: { attachments: { where: { deletedAt: null } } },
      })
      if (!existing) {
        try { unlinkSync(file.path) } catch { /* ignore */ }
        return res.status(404).json({ error: '申请不存在' })
      }
      if (existing.userId !== userId) {
        try { unlinkSync(file.path) } catch { /* ignore */ }
        return res.status(403).json({ error: '无权操作此申请' })
      }
      if (existing.status !== 'DRAFT') {
        try { unlinkSync(file.path) } catch { /* ignore */ }
        return res.status(409).json({ error: '仅草稿状态可上传材料' })
      }

      // 单文件大小（业务侧再校验一次，以 SystemSetting 为准）
      const fileMax = await getExpertVoteFileMaxBytes()
      if (file.size > fileMax) {
        try { unlinkSync(file.path) } catch { /* ignore */ }
        return res.status(413).json({ error: '文件超过单文件大小限制' })
      }
      // 累计大小
      const totalMax = await getExpertVoteTotalMaxBytes()
      const used = existing.attachments.reduce((sum, a) => sum + a.size, 0)
      if (used + file.size > totalMax) {
        try { unlinkSync(file.path) } catch { /* ignore */ }
        return res.status(413).json({ error: '累计文件超过总上限' })
      }

      const category = (req.body?.category === 'EXTRA') ? 'EXTRA' : 'MAIN'
      const created = await prisma.expertVoteAttachment.create({
        data: {
          requestId: existing.id,
          category,
          originalName: file.originalname,
          storagePath: file.path,
          size: file.size,
          mimeType: file.mimetype,
          uploadedBy: userId,
        },
      })
      res.json({
        id: created.id,
        category: created.category,
        originalName: created.originalName,
        size: created.size,
        mimeType: created.mimeType,
        createdAt: created.createdAt,
      })
    },
  )

  app.delete('/api/app/expert-votes/:no/attachments/:aid', requireAuth, async (req: AuthRequest, res) => {
    const userId = getUserId(req)
    const requestNo = String(req.params.no || '')
    const aid = String(req.params.aid || '')
    const existing = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    if (!existing) return res.status(404).json({ error: '申请不存在' })
    if (existing.userId !== userId) return res.status(403).json({ error: '无权操作此申请' })
    if (existing.status !== 'DRAFT') return res.status(409).json({ error: '仅草稿状态可删除附件' })

    const att = await prisma.expertVoteAttachment.findUnique({ where: { id: aid } })
    if (!att || att.requestId !== existing.id || att.deletedAt) {
      return res.status(404).json({ error: '附件不存在' })
    }
    // 软删 + best-effort 物理删
    await prisma.expertVoteAttachment.update({
      where: { id: aid },
      data: { deletedAt: new Date() },
    })
    try { unlinkSync(att.storagePath) } catch { /* ignore */ }
    res.json({ ok: true })
  })

  // ════════════════════════════════════════════════════════════
  // 后台管理端（P0-2A）
  //   只做：列表 / 详情 / 录入专家名单 / 回填会议 / 确认会议安排（→ MEETING_SCHEDULED）
  //   不做：投票管理 / 签章 / 退款（P0-2B 才接）
  //   鉴权：requirePermission(admin.expertVotes.*) — 按 read/assignExperts/confirmMeeting/notifyExperts/manageVoting/manageDelivery 细分
  // ════════════════════════════════════════════════════════════

  // ───── 后台列表 ─────
  // 查询参数：status / page / pageSize / q（按 requestNo 或 projectName 模糊）
  // 默认过滤 DRAFT（草稿是用户私有阶段，admin 列表不展示，避免噪音；
  //   显式 ?includeDraft=true 才返回）
  app.get('/api/admin/expert-votes', requirePermission('admin.expertVotes.read'), async (req: AuthRequest, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const includeDraft = req.query.includeDraft === 'true'
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20))

    const where: any = {}
    if (status) {
      where.status = status
    } else if (!includeDraft) {
      where.status = { not: 'DRAFT' }
    }
    if (q) {
      where.OR = [
        { requestNo:    { contains: q, mode: 'insensitive' } },
        { projectName:  { contains: q, mode: 'insensitive' } },
        { targetName:   { contains: q, mode: 'insensitive' } },
        { contactName:  { contains: q, mode: 'insensitive' } },
        { contactPhone: { contains: q } },
      ]
    }

    const [items, total] = await Promise.all([
      prisma.expertVoteRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.expertVoteRequest.count({ where }),
    ])

    // 列表带申请人简要信息（小程序只有 phone，PC 后台需要展示申请单位）
    const userIds = Array.from(new Set(items.map((r) => r.userId)))
    const users = userIds.length
      ? await prisma.appUser.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, phone: true, organization: true },
        })
      : []
    const userMap = new Map(users.map((u) => [u.id, u]))

    res.json({
      items: items.map((r) => ({
        ...serializeRequest(r),
        applicant: userMap.get(r.userId) || null,
      })),
      total,
      page,
      pageSize,
    })
  })

  // ───── 后台详情 ─────
  // 详情包含：申请表全字段 / 申请人信息 / 附件 / 已录入专家名单 / 关联订单
  app.get('/api/admin/expert-votes/:no', requirePermission('admin.expertVotes.read'), async (req: AuthRequest, res) => {
    const requestNo = String(req.params.no || '')
    const r = await prisma.expertVoteRequest.findUnique({
      where: { requestNo },
      include: {
        attachments: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
        experts: { orderBy: { createdAt: 'asc' } },
        votes: { orderBy: { submittedAt: 'asc' } }, // 投票结果（ExpertVoteRecord），PostMeeting 组件回填用
      },
    })
    if (!r) return res.status(404).json({ error: '申请不存在' })

    const applicant = await prisma.appUser.findUnique({
      where: { id: r.userId },
      select: { id: true, name: true, phone: true, organization: true, email: true },
    })

    let order = null
    if (r.orderNo) {
      order = await prisma.appOrder.findUnique({ where: { orderNo: r.orderNo } })
    }

    res.json({
      ...serializeRequest(r),
      applicant,
      order,
    })
  })

  // ───── 录入 / 替换专家名单 ─────
  // 整体替换语义（PUT）：传入数组覆盖既有列表，原专家被删除（无投票记录时）。
  // 仅在 EXPERT_ARRANGING / MEETING_SCHEDULED 阶段允许操作；
  // 进入 VOTING 之后禁止替换（避免投票数据不一致）。
  const expertItemSchema = z.object({
    expertName: z.string().min(1).max(100),
    expertOrg: z.string().max(200).optional(),
    expertTitle: z.string().max(100).optional(),
    expertField: z.string().max(200).optional(),
    expertPhone: z.string().max(50).optional(),
    expertEmail: z.string().max(200).optional(),
    note: z.string().max(500).optional(),
  })
  const expertsBodySchema = z.object({
    experts: z.array(expertItemSchema).min(1).max(20),
    changeReason: z.string().max(500).optional(), // MEETING_SCHEDULED 状态下必填
  })
  const expertArrangementEditableStatus: ReadonlyArray<string> = ['EXPERT_ARRANGING', 'MEETING_SCHEDULED']

  app.put('/api/admin/expert-votes/:no/experts', requirePermission('admin.expertVotes.assignExperts'), async (req: AuthRequest, res) => {
    const requestNo = String(req.params.no || '')
    const parsed = expertsBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    }

    const existing = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    if (!existing) return res.status(404).json({ error: '申请不存在' })
    if (!expertArrangementEditableStatus.includes(existing.status)) {
      return res.status(409).json({ error: '当前状态不允许编辑专家名单' })
    }
    // 会议已确认后变更专家名单，必须说明原因
    if (existing.status === 'MEETING_SCHEDULED' && !parsed.data.changeReason?.trim()) {
      return res.status(400).json({ error: '会议已确认，变更专家名单须填写变更原因（changeReason）' })
    }

    const items = parsed.data.experts
    const operatorId = req.userId || ''
    const reason = parsed.data.changeReason?.trim() || null
    try {
      await prisma.$transaction(async (tx) => {
        // 重读 + CAS：状态可能在事务前被改写
        const fresh = await tx.expertVoteRequest.findUnique({ where: { requestNo } })
        if (!fresh) throw new Error('申请不存在')
        if (!expertArrangementEditableStatus.includes(fresh.status)) {
          throw new Error('状态已变更，请刷新')
        }
        // 删旧（CASCADE 会带走 ExpertVoteRecord，但当前阶段不应有投票记录）
        await tx.expertAssignment.deleteMany({ where: { requestId: fresh.id } })
        // 创建新
        for (const it of items) {
          await tx.expertAssignment.create({
            data: {
              requestId: fresh.id,
              expertName: it.expertName,
              expertOrg: it.expertOrg ?? null,
              expertTitle: it.expertTitle ?? null,
              expertField: it.expertField ?? null,
              expertPhone: it.expertPhone ?? null,
              expertEmail: it.expertEmail ?? null,
              note: it.note ?? null,
            },
          })
        }
        // 审计：EXPERT_ARRANGING 阶段记 EXPERT_ASSIGN（初次/覆盖录入）；
        // MEETING_SCHEDULED 阶段记 EXPERT_CHANGE（含变更原因）
        if (fresh.status === 'MEETING_SCHEDULED') {
          await tx.expertVoteSignLog.create({
            data: {
              requestId: fresh.id,
              action: 'EXPERT_CHANGE',
              operatorId,
              payloadJson: JSON.stringify({ changeReason: reason, count: items.length }),
            },
          })
        } else {
          await tx.expertVoteSignLog.create({
            data: {
              requestId: fresh.id,
              action: 'EXPERT_ASSIGN',
              operatorId,
              payloadJson: JSON.stringify({ count: items.length }),
            },
          })
        }
      })
    } catch (err: any) {
      return res.status(400).json({ error: err.message || '保存失败' })
    }

    const refreshed = await prisma.expertAssignment.findMany({
      where: { request: { requestNo } },
      orderBy: { createdAt: 'asc' },
    })
    res.json({ items: refreshed })
  })

  // ───── 回填腾讯会议信息（不迁移状态）─────
  // PATCH 语义：仅更新非空字段，未传字段保持不变（便于分步保存）。
  // 校验：仅 EXPERT_ARRANGING / MEETING_SCHEDULED 阶段允许编辑。
  const tencentMeetingUrlSchema = z.string()
    .trim()
    .max(500)
    .url('腾讯会议链接格式无效')
    .refine((v) => v.startsWith('http://') || v.startsWith('https://'), '腾讯会议链接仅支持 http/https')

  const meetingSchema = z.object({
    meetingTitle: z.string().min(1).max(200).optional(),
    meetingStartAt: z.string().optional(),
    meetingEndAt: z.string().optional(),
    tencentMeetingId: z.string().max(50).optional(),
    tencentMeetingUrl: tencentMeetingUrlSchema.optional(),
    tencentMeetingPwd: z.string().max(50).optional(),
    meetingHost: z.string().max(100).optional(),
    meetingHostContact: z.string().max(200).optional(),
    meetingNotes: z.string().max(2000).optional(),
    changeReason: z.string().max(500).optional(), // MEETING_SCHEDULED 状态下必填
  })
  const arrangementSchema = meetingSchema.extend({
    experts: z.array(expertItemSchema).min(1).max(20),
  })

  function buildMeetingUpdateData(p: z.infer<typeof meetingSchema>) {
    const data: any = {}
    if (p.meetingTitle !== undefined) data.meetingTitle = p.meetingTitle
    if (p.tencentMeetingId !== undefined) data.tencentMeetingId = p.tencentMeetingId
    if (p.tencentMeetingUrl !== undefined) data.tencentMeetingUrl = p.tencentMeetingUrl
    if (p.tencentMeetingPwd !== undefined) data.tencentMeetingPwd = p.tencentMeetingPwd
    if (p.meetingHost !== undefined) data.meetingHost = p.meetingHost
    if (p.meetingHostContact !== undefined) data.meetingHostContact = p.meetingHostContact
    if (p.meetingNotes !== undefined) data.meetingNotes = p.meetingNotes
    if (p.meetingStartAt !== undefined) {
      const d = new Date(p.meetingStartAt)
      if (isNaN(d.getTime())) throw new Error('meetingStartAt 格式无效')
      data.meetingStartAt = d
    }
    if (p.meetingEndAt !== undefined) {
      const d = new Date(p.meetingEndAt)
      if (isNaN(d.getTime())) throw new Error('meetingEndAt 格式无效')
      data.meetingEndAt = d
    }
    return data
  }

  // ───── 统一保存专家名单 + 会议字段（不迁移状态）─────
  // 单按钮保存必须原子：不能出现专家名单已改、会议字段失败或反向半保存。
  app.patch(
    '/api/admin/expert-votes/:no/arrangement',
    requirePermission('admin.expertVotes.assignExperts'),
    requirePermission('admin.expertVotes.confirmMeeting'),
    async (req: AuthRequest, res) => {
      const requestNo = String(req.params.no || '')
      const parsed = arrangementSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
      }

      const existing = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
      if (!existing) return res.status(404).json({ error: '申请不存在' })
      if (!expertArrangementEditableStatus.includes(existing.status)) {
        return res.status(409).json({ error: '当前状态不允许保存会议安排' })
      }
      if (existing.status === 'MEETING_SCHEDULED' && !parsed.data.changeReason?.trim()) {
        return res.status(400).json({ error: '会议已确认，变更安排须填写变更原因（changeReason）' })
      }

      const operatorId = req.userId || ''
      const reason = parsed.data.changeReason?.trim() || null
      let meetingData: any
      try {
        meetingData = buildMeetingUpdateData(parsed.data)
      } catch (err: any) {
        return res.status(400).json({ error: err.message })
      }

      try {
        await prisma.$transaction(async (tx) => {
          const fresh = await tx.expertVoteRequest.findUnique({ where: { requestNo } })
          if (!fresh) throw new Error('申请不存在')
          if (!expertArrangementEditableStatus.includes(fresh.status)) {
            throw new Error('状态已变更，请刷新')
          }
          if (fresh.status === 'MEETING_SCHEDULED' && !reason) {
            throw new Error('会议已确认，变更安排须填写变更原因（changeReason）')
          }

          await tx.expertAssignment.deleteMany({ where: { requestId: fresh.id } })
          for (const it of parsed.data.experts) {
            await tx.expertAssignment.create({
              data: {
                requestId: fresh.id,
                expertName: it.expertName,
                expertOrg: it.expertOrg ?? null,
                expertTitle: it.expertTitle ?? null,
                expertField: it.expertField ?? null,
                expertPhone: it.expertPhone ?? null,
                expertEmail: it.expertEmail ?? null,
                note: it.note ?? null,
              },
            })
          }
          await tx.expertVoteRequest.update({ where: { requestNo }, data: meetingData })

          if (fresh.status === 'MEETING_SCHEDULED') {
            await tx.expertVoteSignLog.create({
              data: {
                requestId: fresh.id,
                action: 'EXPERT_CHANGE',
                operatorId,
                payloadJson: JSON.stringify({ changeReason: reason, count: parsed.data.experts.length }),
              },
            })
            await tx.expertVoteSignLog.create({
              data: {
                requestId: fresh.id,
                action: 'MEETING_CHANGE',
                operatorId,
                payloadJson: JSON.stringify({ changeReason: reason, changedFields: Object.keys(meetingData) }),
              },
            })
          } else {
            await tx.expertVoteSignLog.create({
              data: {
                requestId: fresh.id,
                action: 'EXPERT_ASSIGN',
                operatorId,
                payloadJson: JSON.stringify({ count: parsed.data.experts.length }),
              },
            })
          }
        })
      } catch (err: any) {
        return res.status(400).json({ error: err.message || '保存失败' })
      }

      const [refreshed, refreshedExperts] = await Promise.all([
        prisma.expertVoteRequest.findUnique({ where: { requestNo } }),
        prisma.expertAssignment.findMany({
          where: { request: { requestNo } },
          orderBy: { createdAt: 'asc' },
        }),
      ])
      res.json({ request: serializeRequest(refreshed), experts: refreshedExperts })
    },
  )

  app.patch('/api/admin/expert-votes/:no/meeting', requirePermission('admin.expertVotes.confirmMeeting'), async (req: AuthRequest, res) => {
    const requestNo = String(req.params.no || '')
    const parsed = meetingSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    }
    const existing = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    if (!existing) return res.status(404).json({ error: '申请不存在' })
    if (!expertArrangementEditableStatus.includes(existing.status)) {
      return res.status(409).json({ error: '当前状态不允许编辑会议信息' })
    }
    // 会议已确认后变更会议信息，必须说明原因
    if (existing.status === 'MEETING_SCHEDULED' && !parsed.data.changeReason?.trim()) {
      return res.status(400).json({ error: '会议已确认，变更会议信息须填写变更原因（changeReason）' })
    }

    const p = parsed.data
    let data: any
    try {
      data = buildMeetingUpdateData(p)
    } catch (err: any) {
      return res.status(400).json({ error: err.message })
    }

    // 字段更新与 SignLog 写入必须原子：进程崩溃时不能出现"字段已改但审计无记录"
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.expertVoteRequest.update({ where: { requestNo }, data })
      if (existing.status === 'MEETING_SCHEDULED') {
        await tx.expertVoteSignLog.create({
          data: {
            requestId: existing.id,
            action: 'MEETING_CHANGE',
            operatorId: req.userId || '',
            payloadJson: JSON.stringify({
              changeReason: parsed.data.changeReason?.trim() || null,
              changedFields: Object.keys(data),
            }),
          },
        })
      }
      return u
    })
    res.json(serializeRequest(updated))
  })

  // ───── 确认会议安排（CAS EXPERT_ARRANGING → MEETING_SCHEDULED + 站内消息）─────
  // 必填：meetingTitle / meetingStartAt / tencentMeetingId / tencentMeetingUrl / meetingHost
  // body 中可一次性传完整会议信息（兼容"先 PATCH 再 confirm"和"一次性 confirm"两种姿势）
  // 站内消息：写入 Notification（type=EXPERT_VOTE，link 跳小程序会议详情页）
  app.post('/api/admin/expert-votes/:no/confirm-meeting', requirePermission('admin.expertVotes.confirmMeeting'), async (req: AuthRequest, res) => {
    const requestNo = String(req.params.no || '')
    const operatorId = req.userId || ''
    const parsed = meetingSchema.safeParse(req.body || {})
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    }

    const existing = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    if (!existing) return res.status(404).json({ error: '申请不存在' })
    if (existing.status !== 'EXPERT_ARRANGING') {
      return res.status(409).json({ error: '当前状态不允许确认会议安排' })
    }

    // 专家数校验：已录入专家数必须等于申请时确认的 expertCount
    const assignedCount = await prisma.expertAssignment.count({
      where: { requestId: existing.id },
    })
    if (assignedCount !== existing.expertCount) {
      return res.status(400).json({
        error: `专家名单不完整：申请需要 ${existing.expertCount} 位专家，当前已录入 ${assignedCount} 位，请先完善专家名单再确认会议`,
      })
    }

    // 合并 body 与现有字段，得到"将要落库的完整会议信息"，按必填项校验
    const p = parsed.data
    const final = {
      meetingTitle: p.meetingTitle ?? existing.meetingTitle,
      meetingStartAt: p.meetingStartAt ? new Date(p.meetingStartAt) : existing.meetingStartAt,
      meetingEndAt: p.meetingEndAt ? new Date(p.meetingEndAt) : existing.meetingEndAt,
      tencentMeetingId: p.tencentMeetingId ?? existing.tencentMeetingId,
      tencentMeetingUrl: p.tencentMeetingUrl ?? existing.tencentMeetingUrl,
      tencentMeetingPwd: p.tencentMeetingPwd ?? existing.tencentMeetingPwd,
      meetingHost: p.meetingHost ?? existing.meetingHost,
      meetingHostContact: p.meetingHostContact ?? existing.meetingHostContact,
      meetingNotes: p.meetingNotes ?? existing.meetingNotes,
    }
    // 必填：会议主题 / 开始 / 结束 / 链接 / 会议号；
    // 主持人 / 联系方式 / 密码 / 注意事项 一律选填（按真实腾讯会议邀请信息口径）
    const required: Array<[string, any]> = [
      ['meetingTitle', final.meetingTitle],
      ['meetingStartAt', final.meetingStartAt],
      ['meetingEndAt', final.meetingEndAt],
      ['tencentMeetingUrl', final.tencentMeetingUrl],
      ['tencentMeetingId', final.tencentMeetingId],
    ]
    for (const [k, v] of required) {
      if (v === null || v === undefined || v === '') {
        return res.status(400).json({ error: `缺少必填会议字段: ${k}` })
      }
    }
    if (final.meetingStartAt && isNaN(new Date(final.meetingStartAt).getTime())) {
      return res.status(400).json({ error: 'meetingStartAt 格式无效' })
    }

    try {
      await prisma.$transaction(async (tx) => {
        const moved = await transitionStatus(tx, requestNo, 'EXPERT_ARRANGING', 'MEETING_SCHEDULED', {
          meetingTitle: final.meetingTitle,
          meetingStartAt: final.meetingStartAt,
          meetingEndAt: final.meetingEndAt,
          tencentMeetingId: final.tencentMeetingId,
          tencentMeetingUrl: final.tencentMeetingUrl,
          tencentMeetingPwd: final.tencentMeetingPwd,
          meetingHost: final.meetingHost,
          meetingHostContact: final.meetingHostContact,
          meetingNotes: final.meetingNotes,
          meetingArrangedAt: new Date(),
          meetingArrangedBy: operatorId,
        })
        if (!moved) throw new Error('状态已变更，请刷新后重试')

        // 站内消息：标题 / 正文不暴露会议密码与完整链接（与 PRD §10 短信安全要求口径一致，
        // 站内消息虽然只在登录后可见，但 link 仍只指向小程序详情页，让用户进小程序看完整信息）
        await tx.notification.create({
          data: {
            userId: existing.userId,
            title: '专家评审会议安排已确认',
            body: `您提交的《${existing.projectName}》已完成专家评审会议安排，请进入小程序查看会议详情并按时参会。`,
            type: 'EXPERT_VOTE',
            link: `/pages/expert-vote/meeting/index?no=${existing.requestNo}`,
          },
        })
      })
    } catch (err: any) {
      return res.status(400).json({ error: err.message || '确认失败' })
    }

    const refreshed = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    res.json(serializeRequest(refreshed))
  })

  // ───── 后台下载附件 ─────
  // 任意状态，按 attachment id 直接 sendFile；权限只校验 admin 身份（不限定 requestNo 归属）
  app.get('/api/admin/expert-votes/:no/attachments/:aid/download', requirePermission('admin.expertVotes.read'), async (req: AuthRequest, res) => {
    const requestNo = String(req.params.no || '')
    const aid = String(req.params.aid || '')
    const att = await prisma.expertVoteAttachment.findUnique({
      where: { id: aid },
      include: { request: { select: { requestNo: true } } },
    })
    if (!att || att.deletedAt) return res.status(404).json({ error: '附件不存在' })
    if (att.request.requestNo !== requestNo) return res.status(404).json({ error: '附件不属于此申请' })
    res.download(att.storagePath, att.originalName)
  })

  // ───── 通知文本生成 ─────
  // 返回三套人工通知文案（专家邀请函 / 会议确认 / 会后提醒），供后台管理员复制后通过微信/邮件发送给专家。
  // 不发送任何消息，仅生成文本；notifiedAt/notifiedBy 由 mark-notified 单独写入。
  app.get('/api/admin/expert-votes/:no/notification-texts', requirePermission('admin.expertVotes.notifyExperts'), async (req: AuthRequest, res) => {
    const requestNo = String(req.params.no || '')
    const r = await prisma.expertVoteRequest.findUnique({
      where: { requestNo },
      include: { experts: { orderBy: { createdAt: 'asc' } } },
    })
    if (!r) return res.status(404).json({ error: '申请不存在' })

    const fmt = (d: Date | null | undefined) =>
      d ? d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '待确定'

    const expertListText = r.experts
      .map((e, i) => `${i + 1}. ${e.expertName}${e.expertOrg ? `（${e.expertOrg}）` : ''}${e.expertTitle ? ` ${e.expertTitle}` : ''}`)
      .join('\n')

    const expertInvite = `尊敬的专家，您好！

我们诚邀您参加以下专家评审会议，请确认是否能够出席：

【项目名称】${r.projectName}
【评审时间】${fmt(r.meetingStartAt)} — ${fmt(r.meetingEndAt)}
【会议主题】${r.meetingTitle ?? '待确定'}
【腾讯会议号】${r.tencentMeetingId ?? '待确定'}
【会议链接】${r.tencentMeetingUrl ?? '待确定'}
${r.tencentMeetingPwd ? `【会议密码】${r.tencentMeetingPwd}\n` : ''}
请收到此消息后回复确认，如有问题请联系我方工作人员。
感谢您的参与！`

    const meetingConfirm = `专家您好，

以下为本次评审会议的确认信息，请按时参会：

【项目名称】${r.projectName}
【会议时间】${fmt(r.meetingStartAt)} — ${fmt(r.meetingEndAt)}
【腾讯会议号】${r.tencentMeetingId ?? '待确定'}
【会议链接】${r.tencentMeetingUrl ?? '待确定'}
${r.tencentMeetingPwd ? `【会议密码】${r.tencentMeetingPwd}\n` : ''}${r.meetingHost ? `【主持人】${r.meetingHost}${r.meetingHostContact ? `（${r.meetingHostContact}）` : ''}\n` : ''}
${r.meetingNotes ? `【注意事项】${r.meetingNotes}\n` : ''}
参会专家名单：
${expertListText || '（待录入）'}

如需变更出席情况，请提前联系我方工作人员。`

    const voteRemind = `专家您好，

感谢您参加《${r.projectName}》专家评审会议。请在平台提交您的书面评审意见，以便我们完成正式评审报告。

申请编号：${r.requestNo}

如有任何问题，请联系我方工作人员。感谢配合！`

    res.json({
      notifiedAt: r.notifiedAt,
      notifiedBy: r.notifiedBy,
      texts: {
        expert_invite: expertInvite,
        meeting_confirm: meetingConfirm,
        vote_remind: voteRemind,
      },
    })
  })

  // ───── 标记已通知专家 ─────
  // 幂等保护：已标记则返回 409（避免重复写入造成时间戳被覆盖）。
  // 仅记录第一次通知时间，不触发任何消息发送。
  app.post('/api/admin/expert-votes/:no/mark-notified', requirePermission('admin.expertVotes.notifyExperts'), async (req: AuthRequest, res) => {
    const requestNo = String(req.params.no || '')
    const operatorId = req.userId || ''
    const r = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    if (!r) return res.status(404).json({ error: '申请不存在' })
    if (r.notifiedAt) {
      return res.status(409).json({
        error: '已标记通知，不允许重复标记',
        notifiedAt: r.notifiedAt,
        notifiedBy: r.notifiedBy,
      })
    }
    const updated = await prisma.expertVoteRequest.update({
      where: { requestNo },
      data: { notifiedAt: new Date(), notifiedBy: operatorId },
    })
    res.json({ ok: true, notifiedAt: updated.notifiedAt, notifiedBy: updated.notifiedBy })
  })

  // ════════════════════════════════════════════════════════════
  // 会后整理（VOTING 阶段）
  // ════════════════════════════════════════════════════════════

  // ───── 进入会后整理（MEETING_SCHEDULED → VOTING）─────
  app.post('/api/admin/expert-votes/:no/start-voting', requirePermission('admin.expertVotes.manageVoting'), async (req: AuthRequest, res) => {
    const requestNo = String(req.params.no || '')
    const operatorId = req.userId || ''
    const r = await prisma.expertVoteRequest.findUnique({
      where: { requestNo },
      include: { experts: { select: { id: true } } },
    })
    if (!r) return res.status(404).json({ error: '申请不存在' })
    if (r.status !== 'MEETING_SCHEDULED') {
      return res.status(409).json({ error: '当前状态不允许进入会后整理' })
    }
    const moved = await transitionStatus(prisma, requestNo, 'MEETING_SCHEDULED', 'VOTING', {
      voteStartedAt: new Date(),
    })
    if (!moved) return res.status(409).json({ error: '状态已变更，请刷新' })
    await prisma.expertVoteSignLog.create({
      data: {
        requestId: r.id,
        action: 'START_VOTING',
        operatorId,
        payloadJson: JSON.stringify({ expertCount: r.experts.length }),
      },
    })
    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    res.json(serializeRequest(fresh))
  })

  // ───── 保存投票结果草稿（不迁移状态）─────
  // upsert ExpertVoteRecord，按 assignmentId 唯一
  // 同时更新 ExpertVoteRequest.conclusion 与 voteResultJson 汇总
  const voteRecordSchema = z.object({
    assignmentId: z.string().min(1),
    voteResult: z.enum(['PASS', 'REJECT', 'PASS_WITH_MOD', 'ABSTAIN']),
    reviewOpinion: z.string().min(1).max(5000),
    modificationSuggestion: z.string().max(5000).optional(),
    riskWarning: z.string().max(5000).optional(),
  })
  const votingResultsSchema = z.object({
    conclusion: z.enum(['PASS', 'REJECT', 'PASS_WITH_MOD', 'NEED_SUPPLEMENT']).optional(),
    conclusionRemark: z.string().max(5000).optional(),
    votes: z.array(voteRecordSchema).default([]),
  })

  app.put('/api/admin/expert-votes/:no/voting-results', requirePermission('admin.expertVotes.manageVoting'), async (req: AuthRequest, res) => {
    const requestNo = String(req.params.no || '')
    const parsed = votingResultsSchema.safeParse(req.body || {})
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    }
    const operatorId = req.userId || ''
    const existing = await prisma.expertVoteRequest.findUnique({
      where: { requestNo },
      include: { experts: { select: { id: true } } },
    })
    if (!existing) return res.status(404).json({ error: '申请不存在' })
    if (existing.status !== 'VOTING') {
      return res.status(409).json({ error: '当前状态不允许保存投票结果' })
    }

    const validAssignmentIds = new Set(existing.experts.map((e) => e.id))
    for (const v of parsed.data.votes) {
      if (!validAssignmentIds.has(v.assignmentId)) {
        return res.status(400).json({ error: `非法的 assignmentId: ${v.assignmentId}` })
      }
    }

    try {
      await prisma.$transaction(async (tx) => {
        for (const v of parsed.data.votes) {
          await tx.expertVoteRecord.upsert({
            where: { assignmentId: v.assignmentId },
            update: {
              voteResult: v.voteResult,
              reviewOpinion: v.reviewOpinion,
              modificationSuggestion: v.modificationSuggestion ?? null,
              riskWarning: v.riskWarning ?? null,
              submittedBy: operatorId,
              submittedByMode: 'ADMIN_PROXY',
              confirmFlag: true,
              submittedAt: new Date(),
            },
            create: {
              requestId: existing.id,
              assignmentId: v.assignmentId,
              voteResult: v.voteResult,
              reviewOpinion: v.reviewOpinion,
              modificationSuggestion: v.modificationSuggestion ?? null,
              riskWarning: v.riskWarning ?? null,
              agreeConclusion: 'YES',
              submittedBy: operatorId,
              submittedByMode: 'ADMIN_PROXY',
              confirmFlag: true,
            },
          })
        }
        // 重新汇总
        const all = await tx.expertVoteRecord.findMany({ where: { requestId: existing.id } })
        const summary = {
          PASS: all.filter((r) => r.voteResult === 'PASS').length,
          REJECT: all.filter((r) => r.voteResult === 'REJECT').length,
          PASS_WITH_MOD: all.filter((r) => r.voteResult === 'PASS_WITH_MOD').length,
          ABSTAIN: all.filter((r) => r.voteResult === 'ABSTAIN').length,
          total: all.length,
        }
        await tx.expertVoteRequest.update({
          where: { id: existing.id },
          data: {
            voteResultJson: JSON.stringify(summary),
            ...(parsed.data.conclusion !== undefined ? { conclusion: parsed.data.conclusion } : {}),
            ...(parsed.data.conclusionRemark !== undefined ? { conclusionRemark: parsed.data.conclusionRemark } : {}),
          },
        })
        await tx.expertVoteSignLog.create({
          data: {
            requestId: existing.id,
            action: 'VOTING_RESULTS_UPDATED',
            operatorId,
            payloadJson: JSON.stringify({ recordCount: parsed.data.votes.length, summary }),
          },
        })
      })
    } catch (err: any) {
      return res.status(400).json({ error: err.message || '保存失败' })
    }

    const records = await prisma.expertVoteRecord.findMany({ where: { requestId: existing.id } })
    const refreshed = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    res.json({
      conclusion: refreshed?.conclusion,
      conclusionRemark: refreshed?.conclusionRemark,
      voteResultJson: refreshed?.voteResultJson,
      records,
    })
  })

  // ───── 关闭会后整理（VOTING → VOTED）─────
  // 校验：所有 ExpertAssignment 必须有对应的 ExpertVoteRecord（投票结果 + 评审意见齐全）
  app.post('/api/admin/expert-votes/:no/close-voting', requirePermission('admin.expertVotes.manageVoting'), async (req: AuthRequest, res) => {
    const requestNo = String(req.params.no || '')
    const operatorId = req.userId || ''
    const r = await prisma.expertVoteRequest.findUnique({
      where: { requestNo },
      include: { experts: { select: { id: true, expertName: true } } },
    })
    if (!r) return res.status(404).json({ error: '申请不存在' })
    if (r.status !== 'VOTING') {
      return res.status(409).json({ error: '当前状态不允许关闭整理' })
    }
    if (!r.conclusion) {
      return res.status(400).json({ error: '请先选择最终结论再关闭整理' })
    }
    const records = await prisma.expertVoteRecord.findMany({ where: { requestId: r.id } })
    const recordedAids = new Set(records.map((rec) => rec.assignmentId))
    const missing = r.experts.filter((e) => !recordedAids.has(e.id)).map((e) => e.expertName)
    if (missing.length > 0) {
      return res.status(400).json({
        error: `以下专家尚未录入意见和投票：${missing.join('、')}`,
      })
    }
    const moved = await transitionStatus(prisma, requestNo, 'VOTING', 'VOTED', {
      voteClosedAt: new Date(),
      voteClosedBy: operatorId,
    })
    if (!moved) return res.status(409).json({ error: '状态已变更，请刷新' })
    await prisma.expertVoteSignLog.create({
      data: {
        requestId: r.id,
        action: 'CLOSE_VOTING',
        operatorId,
        payloadJson: JSON.stringify({ conclusion: r.conclusion, voteResultJson: r.voteResultJson }),
      },
    })
    const fresh = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    res.json(serializeRequest(fresh))
  })

  // ════════════════════════════════════════════════════════════
  // 确认文件生成 + 签名上传（VOTED → SIGNING → COMPLETED）
  // 第一版生成 Word 确认文件（.docx）。旧 generate-pdf / download-result-pdf
  // URL 仅作兼容 alias，保留至 v1.1，下个大版本删除。
  // ════════════════════════════════════════════════════════════

  const RESULT_DOC_DIR = (no: string) => join(EXPERT_VOTE_UPLOAD_DIR, no)
  const ensureRequestDir = (no: string) => {
    const d = RESULT_DOC_DIR(no)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    return d
  }

  // ───── 生成 Word 结果确认件（VOTED → SIGNING）─────
  const handleGenerateResultDoc = async (req: AuthRequest, res: any) => {
    const requestNo = String(req.params.no || '')
    const operatorId = req.userId || ''
    const r = await prisma.expertVoteRequest.findUnique({
      where: { requestNo },
      include: {
        experts: { orderBy: { createdAt: 'asc' } },
      },
    })
    if (!r) return res.status(404).json({ error: '申请不存在' })
    if (r.status !== 'VOTED') {
      return res.status(409).json({ error: '当前状态不允许生成确认文件' })
    }

    const records = await prisma.expertVoteRecord.findMany({ where: { requestId: r.id } })
    const recordsByAid = new Map(records.map((rec) => [rec.assignmentId, rec]))

    const applicant = r.userId
      ? await prisma.appUser.findUnique({
          where: { id: r.userId },
          select: { name: true, organization: true },
        })
      : null

    const missing: string[] = []
    if (!r.projectName?.trim()) missing.push('评审项目名称')
    if (!r.meetingStartAt) missing.push('会议时间')
    if (!r.conclusion?.trim()) missing.push('最终结论')
    if (r.experts.length === 0) missing.push('专家名单')
    const incompleteExperts = r.experts.filter((e) => {
      const rec = recordsByAid.get(e.id)
      return !rec?.voteResult || !rec.reviewOpinion?.trim()
    })
    if (incompleteExperts.length > 0) missing.push('专家投票结果 / 评审意见')
    if (missing.length > 0) {
      return res.status(400).json({ error: `确认文件缺少必要数据：${missing.join('、')}` })
    }

    const summaryRaw = (() => {
      try { return r.voteResultJson ? JSON.parse(r.voteResultJson) : null } catch { return null }
    })()
    const summary = summaryRaw || { PASS: 0, REJECT: 0, PASS_WITH_MOD: 0, ABSTAIN: 0, total: records.length }

    const { buildResultConfirmationDocx } = await import('./services/expertVoteDocx.js')
    let buf: Buffer
    try {
      buf = await buildResultConfirmationDocx({
        requestNo: r.requestNo,
        projectName: r.projectName,
        applicantOrg: applicant?.organization || r.draftingOrgs || r.participatingOrgs,
        applicantName: r.contactName || applicant?.name,
        applicantPhone: r.contactPhone,
        meetingTitle: r.meetingTitle,
        meetingStartAt: r.meetingStartAt,
        meetingEndAt: r.meetingEndAt,
        conclusion: r.conclusion,
        conclusionRemark: r.conclusionRemark,
        voteSummary: summary,
        experts: r.experts.map((e) => {
          const rec = recordsByAid.get(e.id)
          return {
            expertName: e.expertName,
            expertOrg: e.expertOrg,
            expertTitle: e.expertTitle,
            expertField: e.expertField,
            voteResult: rec?.voteResult,
            reviewOpinion: rec?.reviewOpinion,
            modificationSuggestion: rec?.modificationSuggestion,
            riskWarning: rec?.riskWarning,
          }
        }),
      })
    } catch (err: any) {
      return res.status(500).json({ error: '文件生成失败：' + (err.message || 'unknown') })
    }

    const dir = ensureRequestDir(requestNo)
    const fname = `result-${Date.now()}.docx`
    const fpath = join(dir, fname)
    const { writeFileSync } = await import('fs')
    writeFileSync(fpath, buf)

    try {
      await prisma.$transaction(async (tx) => {
        await tx.expertVoteAttachment.create({
          data: {
            requestId: r.id,
            category: 'RESULT_PDF',
            originalName: `${r.requestNo}_专家评审意见与投票结果确认单.docx`,
            storagePath: fpath,
            size: buf.length,
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            uploadedBy: operatorId,
          },
        })
        await tx.expertVoteRequest.update({
          where: { id: r.id },
          data: { resultPdfPath: fpath, resultDocxPath: fpath },
        })
        await tx.expertVoteSignLog.create({
          data: {
            requestId: r.id,
            action: 'GENERATE_PDF',
            operatorId,
            payloadJson: JSON.stringify({ size: buf.length, ext: 'docx' }),
          },
        })
        const moved = await transitionStatus(tx, requestNo, 'VOTED', 'SIGNING')
        if (!moved) throw new Error('状态已变更，请刷新')
      })
    } catch (err: any) {
      return res.status(409).json({ error: err.message || '生成失败' })
    }

    res.json({
      ok: true,
      resultDocUrl: `/api/admin/expert-votes/${requestNo}/download-result-doc`,
      pdfUrl: `/api/admin/expert-votes/${requestNo}/download-result-pdf`,
    })
  }

  app.post('/api/admin/expert-votes/:no/generate-result-doc', requirePermission('admin.expertVotes.manageDelivery'), handleGenerateResultDoc)
  // Backward-compatible alias retained through v1.1; remove in the next major version.
  app.post('/api/admin/expert-votes/:no/generate-pdf', requirePermission('admin.expertVotes.manageDelivery'), handleGenerateResultDoc)

  // ───── 后台下载系统生成的 Word 结果确认件 ─────
  const handleDownloadResultDoc = async (req: AuthRequest, res: any) => {
    const requestNo = String(req.params.no || '')
    const r = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    if (!r) return res.status(404).json({ error: '申请不存在' })
    const resultDocPath = r.resultDocxPath || r.resultPdfPath
    if (!resultDocPath) return res.status(404).json({ error: '尚未生成确认文件' })
    if (!existsSync(resultDocPath)) return res.status(404).json({ error: '文件已不存在' })
    res.download(resultDocPath, `${r.requestNo}_专家评审意见与投票结果确认单.docx`)
  }

  app.get('/api/admin/expert-votes/:no/download-result-doc', requirePermission('admin.expertVotes.manageDelivery'), handleDownloadResultDoc)
  // Backward-compatible alias retained through v1.1; remove in the next major version.
  app.get('/api/admin/expert-votes/:no/download-result-pdf', requirePermission('admin.expertVotes.manageDelivery'), handleDownloadResultDoc)

  // ───── 后台下载最终交付文件（COMPLETED 后）─────
  // 优先 finalDeliverablePath，fallback signedPdfPath（双写过渡兼容）
  app.get('/api/admin/expert-votes/:no/download-final-deliverable', requirePermission('admin.expertVotes.manageDelivery'), async (req: AuthRequest, res) => {
    const requestNo = String(req.params.no || '')
    const r = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    if (!r) return res.status(404).json({ error: '申请不存在' })
    const path = r.finalDeliverablePath || r.signedPdfPath
    if (!path) return res.status(404).json({ error: '尚未生成最终交付文件' })
    if (!existsSync(path)) return res.status(404).json({ error: '文件已不存在' })
    const ext = path.endsWith('.pdf') ? '.pdf' : '.docx'
    res.download(path, `${r.requestNo}_专家评审最终交付文件${ext}`)
  })

  // ════════════════════════════════════════════════════════════
  // 确认文件交付（Path A + Path B）
  //
  // Path A：平台内自动合成 — 第一版未真合成，已禁用；
  //         待 v2 docx 嵌图 / PDF 拼接方案完善后再开放。
  // Path B：线下整理 — 下载 Word → 线下处理 → 上传最终 PDF → COMPLETED
  //
  // 不写"电子签 / 签章"语义；用 finalDeliverable / deliveryMode 命名。
  // 旧 signedPdfPath / signedPdfHash 双写保留作向后兼容。
  // ════════════════════════════════════════════════════════════

  // 后台签字材料 / 最终交付的 MIME 白名单：仅允许 PDF 与 Word 文档（含 docx / doc）
  // 用户端 ALLOWED_MIME 还含图片 / zip / xlsx，后台交付链路严格收窄
  const ADMIN_DELIVERY_MIME = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ])
  const adminDeliveryFileFilter = (_req: any, file: any, cb: any) => {
    if (!ADMIN_DELIVERY_MIME.has(file.mimetype)) {
      return cb(new Error('仅支持 PDF / DOC / DOCX 格式'))
    }
    cb(null, true)
  }

  // ───── Path A：上传专家签字材料（不迁状态；v2 自动合成预留）─────
  const sigMaterialUpload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const requestNo = String((req.params as any).no || 'unassigned')
        const dir = ensureRequestDir(requestNo)
        cb(null, dir)
      },
      filename: (_req, file, cb) => {
        file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8')
        cb(null, `signature-material-${Date.now()}-${file.originalname}`)
      },
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: adminDeliveryFileFilter,
  })

  app.post('/api/admin/expert-votes/:no/upload-signature-material',
    requirePermission('admin.expertVotes.manageDelivery'),
    (req, res, next) => sigMaterialUpload.single('file')(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件超过 50MB 上限' })
        return res.status(400).json({ error: err.message || '上传失败' })
      }
      next()
    }),
    async (req: AuthRequest, res) => {
      const requestNo = String(req.params.no || '')
      const operatorId = req.userId || ''
      const file = (req as any).file as Express.Multer.File | undefined
      if (!file) return res.status(400).json({ error: '缺少 file 字段' })
      const r = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
      if (!r) {
        try { unlinkSync(file.path) } catch {}
        return res.status(404).json({ error: '申请不存在' })
      }
      if (r.status !== 'SIGNING') {
        try { unlinkSync(file.path) } catch {}
        return res.status(409).json({ error: '当前状态不允许上传签字材料' })
      }
      await prisma.$transaction(async (tx) => {
        await tx.expertVoteAttachment.create({
          data: {
            requestId: r.id,
            category: 'SIGNATURE_MATERIAL',
            originalName: file.originalname,
            storagePath: file.path,
            size: file.size,
            mimeType: file.mimetype,
            uploadedBy: operatorId,
          },
        })
        await tx.expertVoteRequest.update({
          where: { id: r.id },
          data: { expertSignatureMaterialPath: file.path },
        })
        await tx.expertVoteSignLog.create({
          data: {
            requestId: r.id,
            action: 'UPLOAD_SIGNATURE_MATERIAL',
            operatorId,
            payloadJson: JSON.stringify({ size: file.size, name: file.originalname }),
          },
        })
      })
      // 不返回 file.path（磁盘绝对路径），避免内部目录结构泄露；前端走详情接口拉信息
      res.json({ ok: true })
    },
  )

  // ───── Path A：生成最终交付文件（SIGNING → COMPLETED）─────
  // Path A 第一版未真合成，已禁用；待 v2 docx 嵌图 / PDF 拼接方案完善后再开放。
  app.post('/api/admin/expert-votes/:no/generate-final-deliverable', requirePermission('admin.expertVotes.manageDelivery'), async (req: AuthRequest, res) => {
    const pathAEnabled = await getExpertVotePathAEnabled()
    if (!pathAEnabled) return res.status(403).json({ error: '本功能暂未开放' })

    const requestNo = String(req.params.no || '')
    const operatorId = req.userId || ''
    const r = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    if (!r) return res.status(404).json({ error: '申请不存在' })
    if (r.status !== 'SIGNING') {
      return res.status(409).json({ error: '当前状态不允许生成最终交付文件' })
    }
    const sourcePath = r.resultDocxPath || r.resultPdfPath
    if (!sourcePath || !existsSync(sourcePath)) {
      return res.status(400).json({ error: '系统 Word 确认文件不存在，请先生成确认文件' })
    }

    const { readFileSync } = await import('fs')
    const buf = readFileSync(sourcePath)
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex')

    try {
      await prisma.$transaction(async (tx) => {
        const now = new Date()
        await tx.expertVoteRequest.update({
          where: { id: r.id },
          data: {
            finalDeliverablePath: sourcePath,
            finalDeliverableHash: sha256,
            deliveryMode: 'PLATFORM_GENERATED',
            deliveredBy: operatorId,
            deliveredAt: now,
            // 双写：兼容旧 signed* 字段
            signedPdfPath: sourcePath,
            signedPdfHash: sha256,
            signedAt: now,
            signedBy: operatorId,
          },
        })
        await tx.expertVoteSignLog.create({
          data: {
            requestId: r.id,
            action: 'GENERATE_FINAL_DELIVERABLE',
            operatorId,
            payloadJson: JSON.stringify({ mode: 'PLATFORM_GENERATED', sha256 }),
          },
        })
        const moved = await transitionStatus(tx, requestNo, 'SIGNING', 'COMPLETED')
        if (!moved) throw new Error('状态已变更，请刷新')
        await tx.notification.create({
          data: {
            userId: r.userId,
            title: '专家评审确认文件已完成',
            body: `您提交的《${r.projectName}》专家评审意见与投票结果确认文件已完成，请进入平台下载。`,
            type: 'EXPERT_VOTE',
            link: `/expert-vote/${r.requestNo}`,
          },
        })
      })
    } catch (err: any) {
      return res.status(409).json({ error: err.message || '生成失败' })
    }
    res.json({ ok: true, sha256, deliveryMode: 'PLATFORM_GENERATED' })
  })

  // ───── Path B：上传最终交付 PDF（SIGNING → COMPLETED）─────
  const finalDelivUpload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const requestNo = String((req.params as any).no || 'unassigned')
        const dir = ensureRequestDir(requestNo)
        cb(null, dir)
      },
      filename: (_req, file, cb) => {
        file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8')
        cb(null, `final-${Date.now()}-${file.originalname}`)
      },
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: adminDeliveryFileFilter,
  })

  // 通用最终交付上传 handler（Path B），同时保留旧 URL 作为别名
  const handleUploadFinalDeliverable = async (req: AuthRequest, res: any) => {
    const requestNo = String(req.params.no || '')
    const operatorId = req.userId || ''
    const file = (req as any).file as Express.Multer.File | undefined
    if (!file) return res.status(400).json({ error: '缺少 file 字段' })
    const r = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    if (!r) {
      try { unlinkSync(file.path) } catch {}
      return res.status(404).json({ error: '申请不存在' })
    }
    if (r.status !== 'SIGNING') {
      try { unlinkSync(file.path) } catch {}
      return res.status(409).json({ error: '当前状态不允许上传最终交付文件' })
    }
    const { readFileSync } = await import('fs')
    const buf = readFileSync(file.path)
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex')

    try {
      await prisma.$transaction(async (tx) => {
        await tx.expertVoteAttachment.create({
          data: {
            requestId: r.id,
            category: 'FINAL_DELIVERABLE',
            originalName: file.originalname,
            storagePath: file.path,
            size: file.size,
            mimeType: file.mimetype,
            uploadedBy: operatorId,
          },
        })
        const now = new Date()
        await tx.expertVoteRequest.update({
          where: { id: r.id },
          data: {
            finalDeliverablePath: file.path,
            finalDeliverableHash: sha256,
            deliveryMode: 'OFFLINE_UPLOAD',
            deliveredBy: operatorId,
            deliveredAt: now,
            // 双写兼容
            signedPdfPath: file.path,
            signedPdfHash: sha256,
            signedAt: now,
            signedBy: operatorId,
          },
        })
        await tx.expertVoteSignLog.create({
          data: {
            requestId: r.id,
            action: 'UPLOAD_FINAL_DELIVERABLE',
            operatorId,
            payloadJson: JSON.stringify({ mode: 'OFFLINE_UPLOAD', size: file.size, sha256, name: file.originalname }),
          },
        })
        const moved = await transitionStatus(tx, requestNo, 'SIGNING', 'COMPLETED')
        if (!moved) throw new Error('状态已变更，请刷新')
        await tx.notification.create({
          data: {
            userId: r.userId,
            title: '专家评审确认文件已完成',
            body: `您提交的《${r.projectName}》专家评审意见与投票结果确认文件已完成，请进入平台下载。`,
            type: 'EXPERT_VOTE',
            link: `/expert-vote/${r.requestNo}`,
          },
        })
      })
    } catch (err: any) {
      return res.status(409).json({ error: err.message || '上传失败' })
    }
    res.json({ ok: true, sha256, deliveryMode: 'OFFLINE_UPLOAD' })
  }

  // 新接口（推荐）
  app.post('/api/admin/expert-votes/:no/upload-final-deliverable',
    requirePermission('admin.expertVotes.manageDelivery'),
    (req, res, next) => finalDelivUpload.single('file')(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件超过 50MB 上限' })
        return res.status(400).json({ error: err.message || '上传失败' })
      }
      next()
    }),
    handleUploadFinalDeliverable,
  )

  // 旧接口别名（向后兼容；前端逐步切到 upload-final-deliverable）
  app.post('/api/admin/expert-votes/:no/upload-signed-pdf',
    requirePermission('admin.expertVotes.manageDelivery'),
    (req, res, next) => finalDelivUpload.single('file')(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件超过 50MB 上限' })
        return res.status(400).json({ error: err.message || '上传失败' })
      }
      next()
    }),
    handleUploadFinalDeliverable,
  )

  // ───── 行级专家通知标记（PATCH /experts/:aid/notify）─────
  // 后台逐位标记"已通知"。再次调用以同样 aid 视为更新，不做幂等拒绝（业务允许重新通知）。
  app.patch('/api/admin/expert-votes/:no/experts/:aid/notify', requirePermission('admin.expertVotes.assignExperts'), async (req: AuthRequest, res) => {
    const requestNo = String(req.params.no || '')
    const aid = String(req.params.aid || '')
    const operatorId = req.userId || ''
    const r = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    if (!r) return res.status(404).json({ error: '申请不存在' })
    const exp = await prisma.expertAssignment.findUnique({ where: { id: aid } })
    if (!exp || exp.requestId !== r.id) return res.status(404).json({ error: '专家不存在或不属于此申请' })

    const updated = await prisma.expertAssignment.update({
      where: { id: aid },
      data: { notifiedAt: new Date(), notifiedBy: operatorId },
    })
    res.json({ ok: true, notifiedAt: updated.notifiedAt, notifiedBy: updated.notifiedBy })
  })

  // ───── 操作记录（COMPLETED 折叠区用）─────
  app.get('/api/admin/expert-votes/:no/sign-logs', requirePermission('admin.expertVotes.read'), async (req: AuthRequest, res) => {
    const requestNo = String(req.params.no || '')
    const r = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    if (!r) return res.status(404).json({ error: '申请不存在' })
    const logs = await prisma.expertVoteSignLog.findMany({
      where: { requestId: r.id },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ items: logs })
  })

  // ───── 用户端下载最终交付文件（COMPLETED 后）─────
  // 优先读 finalDeliverablePath，fallback signedPdfPath（旧数据兼容）
  // 旧 URL /download-signed 保留作别名（前端不变）
  const handleDownloadFinal = async (req: AuthRequest, res: any) => {
    const requestNo = String(req.params.no || '')
    const userId = getUserId(req)
    const r = await prisma.expertVoteRequest.findUnique({ where: { requestNo } })
    if (!r) return res.status(404).json({ error: '申请不存在' })
    if (r.userId !== userId) return res.status(403).json({ error: '无权下载此文件' })
    if (r.status !== 'COMPLETED') return res.status(409).json({ error: '文件尚未完成' })
    const path = r.finalDeliverablePath || r.signedPdfPath
    if (!path || !existsSync(path)) {
      return res.status(404).json({ error: '最终交付文件已不存在' })
    }
    // 文件名按扩展名给：.pdf 或 .docx
    const ext = path.endsWith('.pdf') ? '.pdf' : '.docx'
    res.download(path, `${r.requestNo}_专家评审最终交付文件${ext}`)
  }
  app.get('/api/app/expert-votes/:no/download-final', requireAuth, handleDownloadFinal)
  app.get('/api/app/expert-votes/:no/download-signed', requireAuth, handleDownloadFinal) // 旧别名
}
