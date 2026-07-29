/**
 * 证据库（Record）— Admin only
 *
 *   GET    /api/admin/standard-execution/records           — 列表
 *   GET    /api/admin/standard-execution/records/:id       — 详情（含 submission/task/requirement/source + attachments）
 *   POST   /api/admin/standard-execution/records/:id/void  — VALID → VOID + 同步刷 Package.hasInvalidRecord
 *
 * @see 必读/02_技术架构.md §四.10 Record + §七.5 RecordStatus + §十 审计包追溯链路
 */
import type { Express, Response } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { requireAdmin, type AuthRequest } from '../auth.js'
import { getEnterpriseId } from './utils.js'
import { RecordListQuerySchema, RecordVoidSchema, BatchIdsSchema } from './types.js'
import { resolveRequirementBasis } from './basisSnapshots.js'
import {
  buildRecordEvidencePdfBuffer,
  loadRecordEvidenceChain,
  recordEvidencePdfFilename,
} from './recordEvidence.js'

function badRequest(res: Response, msg: string) {
  return res.status(400).json({ error: msg })
}

export function registerStandardExecutionRecordRoutes(app: Express) {
  // ─── 列表 ─────────────────────────────────────────
  app.get(
    '/api/admin/standard-execution/records',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = RecordListQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const { status, sourceId, requirementId, taskId, assigneeId, departmentId, keyword, recordDateFrom, recordDateTo, page, pageSize } =
        parsed.data
      const enterpriseId = getEnterpriseId(req as never)

      const where: Prisma.StandardExecutionRecordWhereInput = { enterpriseId }
      if (status) where.status = status
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

  // ─── 证据链 ───────────────────────────────────────
  app.get(
    '/api/admin/standard-execution/records/:id/evidence-chain',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const chain = await loadRecordEvidenceChain(getEnterpriseId(req as never), id)
      if (!chain) return res.status(404).json({ error: '记录不存在' })
      res.json({ data: chain })
    },
  )

  app.get(
    '/api/admin/standard-execution/records/:id/export-pdf',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const chain = await loadRecordEvidenceChain(getEnterpriseId(req as never), id)
      if (!chain) return res.status(404).json({ error: '记录不存在' })
      const pdf = await buildRecordEvidencePdfBuffer(chain)
      res.type('application/pdf')
      res.attachment(recordEvidencePdfFilename(chain))
      res.send(pdf)
    },
  )

  // ─── 详情 ─────────────────────────────────────────
  app.get(
    '/api/admin/standard-execution/records/:id',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)

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

  // ─── 作废：VALID → VOID + 同步刷 Package.hasInvalidRecord ──
  app.post(
    '/api/admin/standard-execution/records/:id/void',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const parsed = RecordVoidSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)

      const exists = await prisma.standardExecutionRecord.findFirst({
        where: { id, enterpriseId },
        select: { id: true, status: true },
      })
      if (!exists) return res.status(404).json({ error: '记录不存在' })
      if (exists.status === 'VOID') {
        const full = await prisma.standardExecutionRecord.findFirst({ where: { id, enterpriseId } })
        return res.json({ data: full, noop: true })
      }
      // doc §五.5：VALID → VOID 和 EXPIRED → VOID 都合法
      if (exists.status !== 'VALID' && exists.status !== 'EXPIRED') {
        return res.status(409).json({ error: `当前状态 ${exists.status} 不可作废` })
      }

      const updated = await prisma.$transaction(async (tx) => {
        // 1. Record → VOID（voidReason 一期不落库，schema 没字段；保留 API 兼容，二期扩字段时落）
        const r = await tx.standardExecutionRecord.update({
          where: { id },
          data: { status: 'VOID' },
        })
        // 2. 同步刷 Package.hasInvalidRecord：所有含该 recordId 的 PackageItem 对应的 Package
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
        voidReason: parsed.data.voidReason ?? null, // 一期透传，未落库
      })
    },
  )

  // ─── 批量作废：VALID|EXPIRED → VOID + 同步刷 Package.hasInvalidRecord ──
  // 与单条 void 同语义；事务内先 updateMany 记录，再把含这些记录的审计包标脏。
  app.post(
    '/api/admin/standard-execution/records/batch-void',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)
      const result = await prisma.$transaction(async (tx) => {
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
      res.json({
        ok: result,
        requested: parsed.data.ids.length,
        skipped: parsed.data.ids.length - result,
      })
    },
  )
}
