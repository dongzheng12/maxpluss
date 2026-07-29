import type { Express, Response } from 'express'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../db.js'
import { requireAuth, type AuthRequest } from '../auth.js'

const MatrixQuerySchema = z.object({
  sourceId: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})

const RecordCoverageCreateSchema = z.object({
  requirementIds: z.array(z.string().trim().min(1)).min(1).max(100),
})

const RequirementMappingCreateSchema = z.object({
  sourceRequirementId: z.string().trim().min(1),
  targetRequirementId: z.string().trim().min(1),
  mappingType: z.enum(['EQUIVALENT', 'PARTIAL', 'REFERENCE']).default('REFERENCE'),
})

async function resolveEnterpriseId(req: AuthRequest, res: Response): Promise<string | null> {
  if (req.userRole === 'admin') return req.userEnterpriseId || 'DEFAULT'
  const user = await prisma.appUser.findUnique({
    where: { id: req.userId! },
    select: { enterpriseId: true, enterpriseRole: true },
  })
  if (!user?.enterpriseId || !user.enterpriseRole) {
    res.status(403).json({ error: '当前账号未绑定企业，无权访问' })
    return null
  }
  return user.enterpriseId
}

async function resolveReviewerEnterpriseId(req: AuthRequest, res: Response): Promise<string | null> {
  if (req.userRole === 'admin') return req.userEnterpriseId || 'DEFAULT'
  const user = await prisma.appUser.findUnique({
    where: { id: req.userId! },
    select: { enterpriseId: true, enterpriseRole: true },
  })
  if (!user?.enterpriseId || !['ADMIN', 'MANAGER', 'REVIEWER'].includes(user.enterpriseRole || '')) {
    res.status(403).json({ error: '仅企业 ADMIN/MANAGER/REVIEWER 可维护证据复用' })
    return null
  }
  return user.enterpriseId
}

function addCoverage(
  map: Map<string, Map<string, { status: 'DIRECT' | 'REUSED'; recordIds: string[] }>>,
  requirementId: string,
  sourceId: string,
  status: 'DIRECT' | 'REUSED',
  recordId: string,
) {
  const bySource = map.get(requirementId) || new Map<string, { status: 'DIRECT' | 'REUSED'; recordIds: string[] }>()
  const current = bySource.get(sourceId)
  if (!current) {
    bySource.set(sourceId, { status, recordIds: [recordId] })
  } else {
    current.recordIds.push(recordId)
    if (status === 'DIRECT') current.status = 'DIRECT'
  }
  map.set(requirementId, bySource)
}

export function registerStandardExecutionMatrixRoutes(app: Express) {
  app.get('/api/enterprise/standard-execution/compliance-matrix', requireAuth as never, async (req: AuthRequest, res) => {
    const parsed = MatrixQuerySchema.safeParse(req.query)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const enterpriseId = await resolveEnterpriseId(req, res)
    if (!enterpriseId) return

    const sourceWhere: Prisma.StandardExecutionSourceWhereInput = { enterpriseId, status: 'ACTIVE' }
    const requirementWhere: Prisma.StandardExecutionRequirementWhereInput = { enterpriseId, status: 'ACTIVE' }
    if (parsed.data.sourceId) requirementWhere.sourceId = parsed.data.sourceId

    const [sources, requirements, total] = await Promise.all([
      prisma.standardExecutionSource.findMany({
        where: sourceWhere,
        orderBy: [{ title: 'asc' }],
        select: { id: true, title: true, sourceNo: true, version: true },
      }),
      prisma.standardExecutionRequirement.findMany({
        where: requirementWhere,
        include: { source: { select: { id: true, title: true, sourceNo: true, version: true } } },
        orderBy: [{ sourceId: 'asc' }, { clauseNo: 'asc' }, { title: 'asc' }],
        skip: (parsed.data.page - 1) * parsed.data.pageSize,
        take: parsed.data.pageSize,
      }),
      prisma.standardExecutionRequirement.count({ where: requirementWhere }),
    ])

    const requirementIds = requirements.map((requirement) => requirement.id)
    const coverageMap = new Map<string, Map<string, { status: 'DIRECT' | 'REUSED'; recordIds: string[] }>>()
    if (requirementIds.length > 0) {
      const [directRecords, reuses] = await Promise.all([
        prisma.standardExecutionRecord.findMany({
          where: { enterpriseId, status: 'VALID', requirementId: { in: requirementIds } },
          select: { id: true, requirementId: true, sourceId: true },
        }),
        prisma.sERecordCoverage.findMany({
          where: { enterpriseId, requirementId: { in: requirementIds } },
        }),
      ])
      for (const record of directRecords) {
        addCoverage(coverageMap, record.requirementId, record.sourceId, 'DIRECT', record.id)
      }
      const reuseRecordIds = Array.from(new Set(reuses.map((reuse) => reuse.recordId)))
      const reuseRecords = reuseRecordIds.length > 0
        ? await prisma.standardExecutionRecord.findMany({
          where: { enterpriseId, id: { in: reuseRecordIds }, status: 'VALID' },
          select: { id: true, sourceId: true },
        })
        : []
      const recordSource = new Map(reuseRecords.map((record) => [record.id, record.sourceId]))
      for (const reuse of reuses) {
        const sourceId = recordSource.get(reuse.recordId)
        if (sourceId) addCoverage(coverageMap, reuse.requirementId, sourceId, 'REUSED', reuse.recordId)
      }
    }

    const rows = requirements.map((requirement) => ({
      id: requirement.id,
      sourceId: requirement.sourceId,
      clauseNo: requirement.clauseNo,
      title: requirement.title,
      requirementText: requirement.requirementText,
      source: requirement.source,
      coverageBySource: Object.fromEntries(coverageMap.get(requirement.id)?.entries() || []),
    }))

    res.json({ data: { sources, rows }, total, page: parsed.data.page, pageSize: parsed.data.pageSize })
  })

  app.get('/api/enterprise/standard-execution/records/:id/coverages', requireAuth as never, async (req: AuthRequest, res) => {
    const enterpriseId = await resolveEnterpriseId(req, res)
    if (!enterpriseId) return
    const id = String(req.params.id || '').trim()
    const record = await prisma.standardExecutionRecord.findFirst({ where: { id, enterpriseId } })
    if (!record) return res.status(404).json({ error: '记录不存在' })
    const rows = await prisma.sERecordCoverage.findMany({ where: { enterpriseId, recordId: id }, orderBy: { createdAt: 'desc' } })
    const requirements = rows.length
      ? await prisma.standardExecutionRequirement.findMany({
        where: { enterpriseId, id: { in: rows.map((row) => row.requirementId) } },
        include: { source: { select: { id: true, title: true, sourceNo: true, version: true } } },
      })
      : []
    res.json({ data: rows, requirements })
  })

  app.post('/api/enterprise/standard-execution/records/:id/coverages', requireAuth as never, async (req: AuthRequest, res) => {
    const parsed = RecordCoverageCreateSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const enterpriseId = await resolveReviewerEnterpriseId(req, res)
    if (!enterpriseId) return
    const id = String(req.params.id || '').trim()
    const record = await prisma.standardExecutionRecord.findFirst({ where: { id, enterpriseId, status: 'VALID' } })
    if (!record) return res.status(404).json({ error: '记录不存在或不可复用' })
    const requirementIds = Array.from(new Set(parsed.data.requirementIds.filter((requirementId) => requirementId !== record.requirementId)))
    if (requirementIds.length === 0) return res.status(201).json({ created: 0 })
    const requirements = await prisma.standardExecutionRequirement.findMany({
      where: { enterpriseId, id: { in: requirementIds }, status: 'ACTIVE' },
      select: { id: true },
    })
    if (requirements.length !== requirementIds.length) return res.status(400).json({ error: '部分目标控制点不存在或不可用' })
    const result = await prisma.sERecordCoverage.createMany({
      data: requirementIds.map((requirementId) => ({
        enterpriseId,
        recordId: id,
        requirementId,
        coverageType: 'REUSE',
        createdBy: req.userId!,
      })),
      skipDuplicates: true,
    })
    res.status(201).json({ created: result.count })
  })

  app.get('/api/enterprise/standard-execution/requirement-mappings', requireAuth as never, async (req: AuthRequest, res) => {
    const enterpriseId = await resolveEnterpriseId(req, res)
    if (!enterpriseId) return
    const data = await prisma.sERequirementMapping.findMany({ where: { enterpriseId }, orderBy: { createdAt: 'desc' } })
    res.json({ data })
  })

  app.post('/api/enterprise/standard-execution/requirement-mappings', requireAuth as never, async (req: AuthRequest, res) => {
    const parsed = RequirementMappingCreateSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    if (parsed.data.sourceRequirementId === parsed.data.targetRequirementId) {
      return res.status(400).json({ error: '不能映射到同一控制点' })
    }
    const enterpriseId = await resolveReviewerEnterpriseId(req, res)
    if (!enterpriseId) return
    const requirements = await prisma.standardExecutionRequirement.findMany({
      where: { enterpriseId, id: { in: [parsed.data.sourceRequirementId, parsed.data.targetRequirementId] }, status: 'ACTIVE' },
      select: { id: true },
    })
    if (requirements.length !== 2) return res.status(400).json({ error: '映射控制点不存在或不可用' })
    const data = await prisma.sERequirementMapping.upsert({
      where: {
        enterpriseId_sourceRequirementId_targetRequirementId: {
          enterpriseId,
          sourceRequirementId: parsed.data.sourceRequirementId,
          targetRequirementId: parsed.data.targetRequirementId,
        },
      },
      update: { mappingType: parsed.data.mappingType },
      create: { enterpriseId, ...parsed.data, createdBy: req.userId! },
    })
    res.status(201).json({ data })
  })
}
