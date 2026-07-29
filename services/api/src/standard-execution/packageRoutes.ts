/**
 * 审计包（Package + PackageItem）— Admin only
 *
 *   GET    /api/admin/standard-execution/packages           — 列表
 *   POST   /api/admin/standard-execution/packages           — 创建（DRAFT）+ 批量 PackageItem
 *   GET    /api/admin/standard-execution/packages/:id       — 详情（树状目录：source→requirement→task→submission→reviewLogs+attachments）
 *   POST   /api/admin/standard-execution/packages/:id/preview — 生成前预览
 *   POST   /api/admin/standard-execution/packages/:id/generate — DRAFT|READY → READY（生成多文件目录）
 *   GET    /api/admin/standard-execution/packages/:id/files?path=... — 鉴权下载包内文件
 *   GET    /api/admin/standard-execution/packages/:id/download — 兼容旧单文件下载 / 新审计包 README
 *   POST   /api/admin/standard-execution/packages/:id/void  — DRAFT|READY → VOID
 *
 * 业务规则（doc §七.6）：
 *   - 只能从 status=VALID 的 Record 选
 *   - 生成可预览的多文件材料目录，包含主报告、证据附件、索引表和可选 V2 附录
 *   - Record void 时反向刷 hasInvalidRecord（由 recordRoutes 负责）
 *
 * @see 必读/02_技术架构.md §四.11 Package + §四.12 PackageItem + §七.6 PackageStatus + §十 审计包追溯链路
 */
import type { Express, Response } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { requireAdmin, type AuthRequest } from '../auth.js'
import { getEnterpriseId } from './utils.js'
import { PackageCreateSchema, PackageListQuerySchema, PackageGenerateSchema, PackagePreviewSchema, PackageAsyncGenerateSchema, BatchIdsSchema } from './types.js'
import { generatePackageFile, packageFilePathFromUrl } from './packageBundle.js'
import type { PackageFormat } from './enums.js'
import { resolveValidPackageRecords } from './packageSelection.js'
import { resolveRequirementBasis } from './basisSnapshots.js'
import { buildPackagePreview, generatePackageArtifacts, packageZipDownloadName, readPackageArtifactFile } from './packageArtifacts.js'
import { PACKAGE_TEMPLATES } from './packageTemplates.js'
import { getPackageGenerationJob, startPackageGenerationJob } from './packageJobs.js'

function badRequest(res: Response, msg: string) {
  return res.status(400).json({ error: msg })
}

function formatExt(format: string | null | undefined) {
  if (format === 'FOLDER') return 'txt'
  return format === 'PDF' ? 'pdf' : format === 'DOCX' ? 'docx' : 'zip'
}

function contentType(format: string | null | undefined) {
  if (format === 'FOLDER') return 'text/plain; charset=utf-8'
  if (format === 'PDF') return 'application/pdf'
  if (format === 'DOCX') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  return 'application/zip'
}

function downloadName(title: string | null | undefined, id: string, format: string | null | undefined) {
  const safeTitle = String(title || '审计包').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)
  return `${safeTitle || id}.${formatExt(format)}`
}

function artifactContentType(fileName: string) {
  if (/\.docx$/i.test(fileName)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (/\.xlsx$/i.test(fileName)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (/\.pdf$/i.test(fileName)) return 'application/pdf'
  if (/\.zip$/i.test(fileName)) return 'application/zip'
  if (/\.json$/i.test(fileName)) return 'application/json; charset=utf-8'
  if (/\.txt$/i.test(fileName)) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

export function registerStandardExecutionPackageRoutes(app: Express) {
  // ─── 列表 ─────────────────────────────────────────
  app.get(
    '/api/admin/standard-execution/packages',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = PackageListQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const { status, packageScene, keyword, page, pageSize } = parsed.data
      const enterpriseId = getEnterpriseId(req as never)

      const where: Prisma.StandardExecutionPackageWhereInput = { enterpriseId }
      if (status) where.status = status
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
    '/api/admin/standard-execution/packages/templates',
    requireAdmin as never,
    async (_req: AuthRequest, res) => {
      res.json({ data: PACKAGE_TEMPLATES })
    },
  )

  // ─── 创建 ─────────────────────────────────────────
  app.post(
    '/api/admin/standard-execution/packages',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = PackageCreateSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)

      let selection: Awaited<ReturnType<typeof resolveValidPackageRecords>>
      try {
        selection = await resolveValidPackageRecords(enterpriseId, parsed.data)
      } catch (e) {
        return badRequest(res, e instanceof Error ? e.message : '审计包记录选择无效')
      }

      // 事务：建 Package(DRAFT) + 批量 PackageItem
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
            // status 默认 DRAFT
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

  // ─── 详情（树状目录）─────────────────────────────────
  app.get(
    '/api/admin/standard-execution/packages/:id',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)

      const pkg = await prisma.standardExecutionPackage.findFirst({
        where: { id, enterpriseId },
        include: {
          items: { orderBy: { sortNo: 'asc' } },
        },
      })
      if (!pkg) return res.status(404).json({ error: '记录不存在' })

      // 拉所有关联实体（按 ID 集合一次性查；树状目录组装）
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

      // 索引
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

      // 树状组装：source → requirement[] → task[] → submission[] → reviewLogs[] + attachments[]
      // 每层用 Map 去重 + 保留出现顺序
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
      const reqIdx = new Map<string, Map<string, number>>() // sourceId → reqId → idx
      const taskIdx = new Map<string, Map<string, number>>() // reqId → taskId → idx

      for (const item of pkg.items) {
        const req = requirementMap.get(item.requirementId)
        const task = taskMap.get(item.taskId)
        const sub = submissionMap.get(item.submissionId)
        const rec = recordMap.get(item.recordId)
        if (!task || !sub || !rec) continue
        const basis = resolveRequirementBasis(task.basisSnapshots, item.requirementId, req)
        if (!basis) continue
        const source = basis.source
        const sourceId = basis.snapshot?.sourceId ?? (req as { sourceId: string } | undefined)?.sourceId
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

  // ─── preview：不生成文件，仅返回生成前摘要与输出树 ───────────────
  app.post(
    '/api/admin/standard-execution/packages/:id/preview',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const parsed = PackagePreviewSchema.safeParse(req.body ?? {})
      if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      const enterpriseId = getEnterpriseId(req as never)

      try {
        const data = await buildPackagePreview(enterpriseId, id, parsed.data)
        res.json({ data })
      } catch (e) {
        const status = (e as { status?: number })?.status || 500
        res.status(status).json({ error: e instanceof Error ? e.message : '生成预览失败' })
      }
    },
  )

  // ─── generate：DRAFT|READY → READY（doc §五.6 允许重新生成）─
  app.post(
    '/api/admin/standard-execution/packages/:id/generate',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const parsed = PackageGenerateSchema.safeParse(req.body ?? {})
      if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      const enterpriseId = getEnterpriseId(req as never)

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
    '/api/admin/standard-execution/packages/:id/generate-async',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const parsed = PackageAsyncGenerateSchema.safeParse(req.body ?? {})
      if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      const enterpriseId = getEnterpriseId(req as never)

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
    '/api/admin/standard-execution/packages/:id/generation-status',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)
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
    '/api/admin/standard-execution/packages/:id/files',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const relativePath = typeof req.query.path === 'string' ? req.query.path : ''
      const enterpriseId = getEnterpriseId(req as never)
      try {
        const file = await readPackageArtifactFile(enterpriseId, id, relativePath)
        res.type(artifactContentType(file.downloadName))
        res.attachment(file.downloadName)
        res.send(file.content)
      } catch (e) {
        const status = (e as { status?: number })?.status || 500
        res.status(status).json({ error: e instanceof Error ? e.message : '审计包文件读取失败' })
      }
    },
  )

  app.get(
    '/api/admin/standard-execution/packages/:id/download',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)

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
          res.type(artifactContentType(file.downloadName))
          res.attachment(downloadName(pkg.title, pkg.id, pkg.format))
          return res.send(file.content)
        } catch (e) {
          const status = (e as { status?: number })?.status || 500
          return res.status(status).json({ error: e instanceof Error ? e.message : '审计包文件读取失败' })
        }
      }
      const filePath = packageFilePathFromUrl(pkg.fileUrl)
      if (!filePath) return res.status(409).json({ error: '审计包文件地址非法' })
      res.type(contentType(pkg.format))
      res.download(filePath, downloadName(pkg.title, pkg.id, pkg.format), (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: '审计包文件不存在，请重新生成' })
      })
    },
  )

  app.get(
    '/api/admin/standard-execution/packages/:id/download-zip',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)
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

  // ─── void：DRAFT|READY → VOID ───────────────────────
  app.post(
    '/api/admin/standard-execution/packages/:id/void',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const id = String(req.params.id || '').trim()
      if (!id) return badRequest(res, 'id 非法')
      const enterpriseId = getEnterpriseId(req as never)

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

  // ─── 批量作废：DRAFT|READY → VOID ────────────────────
  app.post(
    '/api/admin/standard-execution/packages/batch-void',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = BatchIdsSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)
      const result = await prisma.standardExecutionPackage.updateMany({
        where: { id: { in: parsed.data.ids }, enterpriseId, status: { in: ['DRAFT', 'READY'] } },
        data: { status: 'VOID' },
      })
      res.json({
        ok: result.count,
        requested: parsed.data.ids.length,
        skipped: parsed.data.ids.length - result.count,
      })
    },
  )
}
