/**
 * 要求项（Requirement）后端接口 — Admin only
 *
 *   GET    /api/admin/standard-execution/requirements           — 列表（按 sourceId/status/type/keyword 筛选 + 分页）
 *   GET    /api/admin/standard-execution/requirements/:id       — 详情（含 source 关联）
 *   POST   /api/admin/standard-execution/requirements           — 新建（默认 status=REVIEW_PENDING；可显式 DRAFT）
 *   PATCH  /api/admin/standard-execution/requirements/:id       — 编辑业务字段（ARCHIVED 拒绝）
 *   PATCH  /api/admin/standard-execution/requirements/:id/activate — REVIEW_PENDING|DISABLED → ACTIVE
 *   PATCH  /api/admin/standard-execution/requirements/:id/disable  — ACTIVE | REVIEW_PENDING | DRAFT → DISABLED
 *   PATCH  /api/admin/standard-execution/requirements/:id/archive  — ACTIVE|DISABLED → ARCHIVED
 *
 * 状态机详见 必读/02_技术架构.md §七.1 RequirementStatus：
 *   DRAFT → REVIEW_PENDING（auto-generate/manual create）
 *   REVIEW_PENDING → ACTIVE | DISABLED
 *   ACTIVE ↔ DISABLED
 *   ACTIVE | DISABLED → ARCHIVED
 *
 * @see 必读/02_技术架构.md §四.2 Requirement 模型 + §八 路由结构
 */
import type { Express, Response } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { requireAdmin, type AuthRequest } from '../auth.js'
import { getEnterpriseId, attachRequirementHealth, attachRequirementTaskStats, toPrismaJson } from './utils.js'
import type { RequirementStatus } from './enums.js'
import {
  RequirementCreateSchema,
  RequirementUpdateSchema,
  RequirementListQuerySchema,
  BatchIdsSchema,
} from './types.js'
import { deleteRequirementsByPolicy } from './requirementDelete.js'
import { enqueueRequirementVectorIndex } from '../vectorIndexWorker.js'

function badRequest(res: Response, msg: string) {
  return res.status(400).json({ error: msg })
}

// 合法跃迁表（doc §五.1）
const ALLOWED_TRANSITIONS: Record<string, RequirementStatus[]> = {
  activate: ['REVIEW_PENDING', 'DISABLED'],
  disable: ['ACTIVE', 'REVIEW_PENDING', 'DRAFT'],
  archive: ['ACTIVE', 'DISABLED'],
}

function checkTransition(
  action: 'activate' | 'disable' | 'archive',
  currentStatus: string,
): { ok: boolean; targetStatus: RequirementStatus } {
  const allowed = ALLOWED_TRANSITIONS[action]
  const target: RequirementStatus =
    action === 'activate' ? 'ACTIVE' : action === 'disable' ? 'DISABLED' : 'ARCHIVED'
  if (!allowed.includes(currentStatus as RequirementStatus)) {
    return { ok: false, targetStatus: target }
  }
  return { ok: true, targetStatus: target }
}

async function transitionStatus(
  req: AuthRequest,
  res: Response,
  action: 'activate' | 'disable' | 'archive',
) {
  const id = String(req.params.id || '').trim()
  if (!id) return badRequest(res, 'id 非法')
  const enterpriseId = getEnterpriseId(req as never)

  const exists = await prisma.standardExecutionRequirement.findFirst({
    where: { id, enterpriseId },
    select: { id: true, status: true },
  })
  if (!exists) return res.status(404).json({ error: '记录不存在' })

  // 幂等：目标状态已是当前状态，直接返回
  const { ok, targetStatus } = checkTransition(action, exists.status)
  if (exists.status === targetStatus) {
    const data = await prisma.standardExecutionRequirement.findFirst({
      where: { id, enterpriseId },
    })
    return res.json({ data, noop: true })
  }
  if (!ok) {
    return res
      .status(409)
      .json({ error: `非法状态跃迁：${exists.status} → ${targetStatus}` })
  }

  const data = await prisma.standardExecutionRequirement.update({
    where: { id },
    data: { status: targetStatus, updatedBy: req.userId! },
  })
  res.json({ data })
}

export function registerStandardExecutionRequirementRoutes(app: Express) {
  // ─── 列表 ─────────────────────────────────────────
  app.get(
    '/api/admin/standard-execution/requirements',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = RequirementListQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const { sourceId, status, generateMode, keyword, sourceKeyword, page, pageSize } =
        parsed.data
      const enterpriseId = getEnterpriseId(req as never)

      const where: Prisma.StandardExecutionRequirementWhereInput = { enterpriseId }
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

  // ─── 详情 ─────────────────────────────────────────
  app.get(
    '/api/admin/standard-execution/requirements/:id',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)
      const data = await prisma.standardExecutionRequirement.findFirst({
        where: { id, enterpriseId },
        include: { source: true },
      })
      if (!data) return res.status(404).json({ error: '记录不存在' })
      const withTaskStats = await attachRequirementTaskStats(enterpriseId, [data])
      const [withHealth] = await attachRequirementHealth(enterpriseId, withTaskStats)
      res.json({ data: withHealth })
    },
  )

  // ─── 新建（默认 REVIEW_PENDING；E3 人工确认入库可显式 DRAFT）────
  app.post(
    '/api/admin/standard-execution/requirements',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = RequirementCreateSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)

      // sourceId FK 校验：source 必须存在且属于同企业
      const source = await prisma.standardExecutionSource.findFirst({
        where: { id: parsed.data.sourceId, enterpriseId },
        select: { id: true, status: true },
      })
      if (!source) {
        return badRequest(res, 'sourceId 对应的标准来源不存在')
      }

      const data = await prisma.standardExecutionRequirement.create({
        data: {
          enterpriseId,
          sourceId: parsed.data.sourceId,
          clauseNo: parsed.data.clauseNo ?? null,
          title: parsed.data.title,
          requirementText: parsed.data.requirementText,
          applicableDeptIds:
            parsed.data.applicableDeptIds === undefined
              ? undefined
              : toPrismaJson(parsed.data.applicableDeptIds),
          archiveTags:
            parsed.data.archiveTags === undefined
              ? undefined
              : toPrismaJson(parsed.data.archiveTags),
          recommendedTaskType: parsed.data.recommendedTaskType ?? null,
          executionDescription: parsed.data.executionDescription ?? null,
          submitRequirement: parsed.data.submitRequirement ?? null,
          requiredMaterials:
            parsed.data.requiredMaterials === undefined
              ? undefined
              : toPrismaJson(parsed.data.requiredMaterials),
          generateMode: parsed.data.generateMode ?? 'MANUAL',
          status: parsed.data.status ?? 'REVIEW_PENDING',
          createdBy: req.userId!,
        },
      })
      enqueueRequirementVectorIndex(data.id)
      res.status(201).json({ data })
    },
  )

  // ─── 编辑业务字段（ARCHIVED 拒绝）─────────────────────
  app.patch(
    '/api/admin/standard-execution/requirements/:id',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const parsed = RequirementUpdateSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)
      const exists = await prisma.standardExecutionRequirement.findFirst({
        where: { id, enterpriseId },
        select: { id: true, status: true },
      })
      if (!exists) return res.status(404).json({ error: '记录不存在' })
      if (exists.status === 'ARCHIVED') {
        return res.status(409).json({ error: '已归档要求项不可编辑' })
      }

      const updateData: Prisma.StandardExecutionRequirementUpdateInput = {
        updatedBy: req.userId!,
      }
      if (parsed.data.clauseNo !== undefined) updateData.clauseNo = parsed.data.clauseNo
      if (parsed.data.title !== undefined) updateData.title = parsed.data.title
      if (parsed.data.requirementText !== undefined)
        updateData.requirementText = parsed.data.requirementText
      if (parsed.data.applicableDeptIds !== undefined) {
        updateData.applicableDeptIds = toPrismaJson(parsed.data.applicableDeptIds)
      }
      if (parsed.data.archiveTags !== undefined) {
        updateData.archiveTags = toPrismaJson(parsed.data.archiveTags)
      }
      if (parsed.data.recommendedTaskType !== undefined) updateData.recommendedTaskType = parsed.data.recommendedTaskType
      if (parsed.data.executionDescription !== undefined) updateData.executionDescription = parsed.data.executionDescription
      if (parsed.data.submitRequirement !== undefined) updateData.submitRequirement = parsed.data.submitRequirement
      if (parsed.data.requiredMaterials !== undefined) {
        updateData.requiredMaterials = toPrismaJson(parsed.data.requiredMaterials)
      }

      const data = await prisma.standardExecutionRequirement.update({
        where: { id },
        data: updateData,
      })
      enqueueRequirementVectorIndex(data.id)
      res.json({ data })
    },
  )

  // ─── 状态机：activate / disable / archive ──────────────
  app.patch(
    '/api/admin/standard-execution/requirements/:id/activate',
    requireAdmin as never,
    (req, res) => transitionStatus(req as AuthRequest, res, 'activate'),
  )
  app.patch(
    '/api/admin/standard-execution/requirements/:id/disable',
    requireAdmin as never,
    (req, res) => transitionStatus(req as AuthRequest, res, 'disable'),
  )
  app.patch(
    '/api/admin/standard-execution/requirements/:id/archive',
    requireAdmin as never,
    (req, res) => transitionStatus(req as AuthRequest, res, 'archive'),
  )

  // ─── 批量归档：ACTIVE|DISABLED → ARCHIVED ────────────
  // 「批量删除」语义 = 批量归档（终态）。待审核/草稿要求项不在 archive 跃迁表内，
  // 会落入 skipped（与单条 archive 状态机一致）。
  app.post(
    '/api/admin/standard-execution/requirements/batch-archive',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)
      const result = await prisma.standardExecutionRequirement.updateMany({
        where: { id: { in: parsed.data.ids }, enterpriseId, status: { in: ['ACTIVE', 'DISABLED'] } },
        data: { status: 'ARCHIVED', updatedBy: req.userId! },
      })
      res.json({
        ok: result.count,
        requested: parsed.data.ids.length,
        skipped: parsed.data.ids.length - result.count,
      })
    },
  )

  // ─── 批量启用：REVIEW_PENDING|DISABLED → ACTIVE ───────
  app.post(
    '/api/admin/standard-execution/requirements/batch-activate',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      const enterpriseId = getEnterpriseId(req as never)
      const result = await prisma.standardExecutionRequirement.updateMany({
        where: { id: { in: parsed.data.ids }, enterpriseId, status: { in: ['REVIEW_PENDING', 'DISABLED'] } },
        data: { status: 'ACTIVE', updatedBy: req.userId! },
      })
      res.json({ updated: result.count })
    },
  )

  // ─── 批量停用：ACTIVE|REVIEW_PENDING|DRAFT → DISABLED ─
  app.post(
    '/api/admin/standard-execution/requirements/batch-disable',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      const enterpriseId = getEnterpriseId(req as never)
      const result = await prisma.standardExecutionRequirement.updateMany({
        where: { id: { in: parsed.data.ids }, enterpriseId, status: { in: ['ACTIVE', 'REVIEW_PENDING', 'DRAFT'] } },
        data: { status: 'DISABLED', updatedBy: req.userId! },
      })
      res.json({ updated: result.count })
    },
  )

  // ─── 批量删除：无历史关联物理删除；有关联任务/记录/审计包时转 ARCHIVED ───
  app.post(
    '/api/admin/standard-execution/requirements/batch-delete',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      const enterpriseId = getEnterpriseId(req as never)
      const result = await prisma.$transaction((tx) =>
        deleteRequirementsByPolicy(tx, {
          enterpriseId,
          ids: parsed.data.ids,
          updatedBy: req.userId!,
        }),
      )
      res.json(result)
    },
  )
}
