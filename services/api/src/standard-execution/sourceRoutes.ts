/**
 * 标准来源（Source）后端接口 — Admin only
 *
 *   GET    /api/admin/standard-execution/sources           — 列表（分页 + 筛选）
 *   GET    /api/admin/standard-execution/sources/:id       — 详情
 *   POST   /api/admin/standard-execution/sources           — 新建
 *   PATCH  /api/admin/standard-execution/sources/:id       — 编辑
 *   PATCH  /api/admin/standard-execution/sources/:id/disable — 软停用（status=DISABLED）
 *
 * 所有查询 / 写入必须按 enterpriseId 隔离（getEnterpriseId）。
 *
 * @see 必读/02_技术架构.md §四.1 Source 模型 + §八 权限规则与路由结构
 */
import type { Express, Response } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { prisma } from '../db.js'
import { requireAdmin, requireAuth, type AuthRequest } from '../auth.js'
import { getEnterpriseId } from './utils.js'
import { extractStandardSourceText } from '../doc-extract.js'
import {
  SourceCreateSchema,
  SourceUpdateSchema,
  SourceListQuerySchema,
  BatchIdsSchema,
} from './types.js'
import { registerStandardExecutionRequirementRoutes } from './requirementRoutes.js'
import { registerStandardExecutionAutoGenerateRoute } from './autoGenerateRoute.js'
import { registerStandardExecutionTaskRoutes } from './taskRoutes.js'
import { registerStandardExecutionTaskGenerationRoutes } from './taskGenerationRoutes.js'
import { registerStandardExecutionMpTaskRoutes } from './mpTaskRoutes.js'
import { registerStandardExecutionMpSubmitRoutes } from './mpSubmitRoutes.js'
import { registerStandardExecutionReviewRoutes } from './reviewRoutes.js'
import { registerStandardExecutionRecordRoutes } from './recordRoutes.js'
import { registerStandardExecutionPackageRoutes } from './packageRoutes.js'
import { registerStandardExecutionRiskRoutes } from './riskRoutes.js'
import { registerStandardExecutionDashboardRoutes } from './dashboardRoutes.js'
import { registerStandardExecutionPlanRoutes } from './planRoutes.js'
import { registerQuestionBankRoutes } from './questionBankRoutes.js'
import { registerStandardExecutionIndustryTemplateRoutes } from './industryTemplateRoutes.js'
import { registerStandardExecutionMatrixRoutes } from './matrixRoutes.js'
import { registerStandardExecutionVectorRoutes } from './vectorRoutes.js'
import { registerStandardExecutionParseV2Routes } from './parseV2Routes.js'
import { enqueueSourceVectorIndex } from '../vectorIndexWorker.js'

function badRequest(res: Response, msg: string) {
  return res.status(400).json({ error: msg })
}

// ─── 上传：标准文件解析（PDF / Word / TXT）────────────
const standardFileUpload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => {
      const dir = path.resolve(process.cwd(), 'uploads', 'standard-sources')
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ['.pdf', '.docx', '.doc', '.txt', '.md']
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()))
  },
})

export function registerStandardExecutionSourceRoutes(app: Express) {
  // ─── 上传 PDF / Word / TXT → 解析正文 ───────────────
  // 权限：requireAuth（admin + 企业用户都可上传；文件不写 DB，仅返回 fileUrl + rawText）
  app.post(
    '/api/admin/uploads/standard-file',
    requireAuth as never,
    standardFileUpload.single('file'),
    async (req: AuthRequest, res) => {
      if (!req.file) return badRequest(res, '未收到文件')
      try {
        const rawText = await extractStandardSourceText(req.file.path)
        const fileUrl = `/uploads/standard-sources/${req.file.filename}`
        res.json({ fileUrl, rawText })
      } catch (err) {
        console.error('[standard-file upload]', err)
        res.status(500).json({ error: '文件解析失败' })
      }
    },
  )

  // ─── 列表 ─────────────────────────────────────────
  app.get(
    '/api/admin/standard-execution/sources',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = SourceListQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const { sourceType, status, keyword, page, pageSize } = parsed.data
      const enterpriseId = getEnterpriseId(req as never)

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

  // ─── 详情 ─────────────────────────────────────────
  app.get(
    '/api/admin/standard-execution/sources/:id',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)
      const data = await prisma.standardExecutionSource.findFirst({
        where: { id, enterpriseId },
      })
      if (!data) return res.status(404).json({ error: '记录不存在' })
      res.json({ data })
    },
  )

  // ─── 新建 ─────────────────────────────────────────
  app.post(
    '/api/admin/standard-execution/sources',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = SourceCreateSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)
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
      enqueueSourceVectorIndex(data.id)
      res.status(201).json({ data })
    },
  )

  // ─── 编辑 ─────────────────────────────────────────
  app.patch(
    '/api/admin/standard-execution/sources/:id',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const parsed = SourceUpdateSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)
      const exists = await prisma.standardExecutionSource.findFirst({
        where: { id, enterpriseId },
        select: { id: true },
      })
      if (!exists) return res.status(404).json({ error: '记录不存在' })

      const data = await prisma.standardExecutionSource.update({
        where: { id },
        data: {
          ...parsed.data,
          updatedBy: req.userId!,
        },
      })
      enqueueSourceVectorIndex(data.id)
      res.json({ data })
    },
  )

  // ─── 软停用 ───────────────────────────────────────
  app.patch(
    '/api/admin/standard-execution/sources/:id/disable',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)
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

  // ─── 批量停用：ACTIVE → DISABLED ─────────────────────
  // 「批量删除」语义 = 批量软停用；updateMany 只命中本企业且 status=ACTIVE 的行，
  // 不存在 / 越权 / 已 DISABLED 的项自动落入 skipped。
  app.post(
    '/api/admin/standard-execution/sources/batch-disable',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)
      const result = await prisma.standardExecutionSource.updateMany({
        where: { id: { in: parsed.data.ids }, enterpriseId, status: 'ACTIVE' },
        data: { status: 'DISABLED', updatedBy: req.userId! },
      })
      res.json({
        ok: result.count,
        requested: parsed.data.ids.length,
        skipped: parsed.data.ids.length - result.count,
      })
    },
  )

  // ─── 批量删除（物理删除；有关联检查点/计划时被 FK 拦截，返回 400）───
  app.post(
    '/api/admin/standard-execution/sources/batch-delete',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)
      try {
        const result = await prisma.standardExecutionSource.deleteMany({
          where: { id: { in: parsed.data.ids }, enterpriseId },
        })
        res.json({ deleted: result.count })
      } catch {
        res.status(400).json({ error: '存在关联检查点/计划，无法删除（请先清理关联数据）' })
      }
    },
  )
}

/**
 * standard-execution 模块路由聚合入口。
 * 后续 slice（tasks / submissions ...）在此追加。
 */
export function registerStandardExecutionRoutes(app: Express) {
  registerStandardExecutionSourceRoutes(app)
  registerStandardExecutionRequirementRoutes(app)
  registerStandardExecutionAutoGenerateRoute(app)
  registerStandardExecutionParseV2Routes(app)
  registerStandardExecutionTaskRoutes(app)
  registerStandardExecutionTaskGenerationRoutes(app)
  registerStandardExecutionMpTaskRoutes(app)
  registerStandardExecutionMpSubmitRoutes(app)
  registerStandardExecutionReviewRoutes(app)
  registerStandardExecutionRecordRoutes(app)
  registerStandardExecutionPackageRoutes(app)
  registerStandardExecutionRiskRoutes(app)
  registerStandardExecutionDashboardRoutes(app)
  registerStandardExecutionPlanRoutes(app)
  registerQuestionBankRoutes(app)
  registerStandardExecutionIndustryTemplateRoutes(app)
  registerStandardExecutionMatrixRoutes(app)
  registerStandardExecutionVectorRoutes(app)
}
