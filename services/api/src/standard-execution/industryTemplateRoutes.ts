import type { Express, Response } from 'express'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../db.js'
import { requireAdmin, requireAuth, type AuthRequest } from '../auth.js'

const DEFAULT_ENTERPRISE_ID = 'DEFAULT'

const IndustryCategorySchema = z.enum([
  'MANUFACTURING',
  'FOOD_SAFETY',
  'MEDICAL_DEVICE',
  'SECURITY',
  'GENERAL',
  'OTHER',
])
const TemplateStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'OFFLINE'])

const TemplateItemInputSchema = z.object({
  clauseNo: z.string().max(80).optional().nullable(),
  title: z.string().min(1).max(200),
  requirementText: z.string().min(1).max(10000),
  applicableDeptIds: z.array(z.string()).max(50).optional().nullable(),
  archiveTags: z.array(z.string()).max(50).optional().nullable(),
  recommendedTaskType: z.string().max(80).optional().nullable(),
  executionDescription: z.string().max(2000).optional().nullable(),
  submitRequirement: z.string().max(1000).optional().nullable(),
  requiredMaterials: z.array(z.string().min(1).max(200)).max(50).optional().nullable(),
})

const TemplateCreateSchema = z.object({
  industryCategory: IndustryCategorySchema,
  title: z.string().min(1).max(200),
  sourceNo: z.string().max(120).optional().nullable(),
  version: z.string().max(80).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  items: z.array(TemplateItemInputSchema).min(1).max(500),
})

const TemplateUpdateSchema = TemplateCreateSchema.partial().extend({
  items: z.array(TemplateItemInputSchema).min(1).max(500).optional(),
})

const TemplateListQuerySchema = z.object({
  industryCategory: IndustryCategorySchema.optional(),
  status: TemplateStatusSchema.optional(),
  keyword: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
})

const TemplateFromRequirementsSchema = z.object({
  enterpriseId: z.string().min(1).default(DEFAULT_ENTERPRISE_ID),
  requirementIds: z.array(z.string().min(1)).min(1).max(500),
  industryCategory: IndustryCategorySchema,
  title: z.string().min(1).max(200),
  sourceNo: z.string().max(120).optional().nullable(),
  version: z.string().max(80).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
})

const TemplateImportSchema = z.object({
  itemIds: z.array(z.string().min(1)).max(500).optional(),
})

function badRequest(res: Response, msg: string) {
  return res.status(400).json({ error: msg })
}

function toNullableJson(value: unknown) {
  return value == null ? Prisma.DbNull : value as Prisma.InputJsonValue
}

function mapTemplateItemInput(item: z.infer<typeof TemplateItemInputSchema>, sortOrder: number) {
  return {
    clauseNo: item.clauseNo ?? null,
    title: item.title,
    requirementText: item.requirementText,
    applicableDeptIds: item.applicableDeptIds === undefined ? undefined : toNullableJson(item.applicableDeptIds),
    archiveTags: item.archiveTags === undefined ? undefined : toNullableJson(item.archiveTags),
    recommendedTaskType: item.recommendedTaskType ?? null,
    executionDescription: item.executionDescription ?? null,
    submitRequirement: item.submitRequirement ?? null,
    requiredMaterials: item.requiredMaterials === undefined ? undefined : toNullableJson(item.requiredMaterials),
    sortOrder,
  }
}

async function resolveEnterpriseIdForEnterpriseRoute(req: AuthRequest, res: Response): Promise<string | null> {
  if (req.userRole === 'admin') {
    if (req.userEnterpriseId) return req.userEnterpriseId
    const admin = await prisma.appUser.findUnique({
      where: { id: req.userId! },
      select: { enterpriseId: true },
    })
    return admin?.enterpriseId ?? DEFAULT_ENTERPRISE_ID
  }
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

function templateInclude() {
  return {
    items: { orderBy: { sortOrder: 'asc' as const } },
  }
}

export function registerStandardExecutionIndustryTemplateRoutes(app: Express) {
  app.get(
    '/api/admin/standard-execution/industry-templates',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = TemplateListQuerySchema.safeParse(req.query)
      if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      const { industryCategory, status, keyword, page, pageSize } = parsed.data
      const where: Prisma.SEIndustryTemplateWhereInput = {}
      if (industryCategory) where.industryCategory = industryCategory
      if (status) where.status = status
      if (keyword) {
        where.OR = [
          { title: { contains: keyword, mode: 'insensitive' } },
          { sourceNo: { contains: keyword, mode: 'insensitive' } },
        ]
      }
      const [data, total] = await Promise.all([
        prisma.sEIndustryTemplate.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.sEIndustryTemplate.count({ where }),
      ])
      res.json({ data, total, page, pageSize })
    },
  )

  app.get(
    '/api/admin/standard-execution/industry-templates/:id',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const data = await prisma.sEIndustryTemplate.findUnique({
        where: { id: String(req.params.id) },
        include: templateInclude(),
      })
      if (!data) return res.status(404).json({ error: '模板不存在' })
      res.json({ data })
    },
  )

  app.post(
    '/api/admin/standard-execution/industry-templates',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = TemplateCreateSchema.safeParse(req.body)
      if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      const { items, ...data } = parsed.data
      const created = await prisma.sEIndustryTemplate.create({
        data: {
          ...data,
          sourceNo: data.sourceNo ?? null,
          version: data.version ?? null,
          description: data.description ?? null,
          controlPointCount: items.length,
          createdBy: req.userId!,
          items: { create: items.map((item, index) => mapTemplateItemInput(item, index + 1)) },
        },
        include: templateInclude(),
      })
      res.status(201).json({ data: created })
    },
  )

  app.patch(
    '/api/admin/standard-execution/industry-templates/:id',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = TemplateUpdateSchema.safeParse(req.body)
      if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      const id = String(req.params.id)
      const existing = await prisma.sEIndustryTemplate.findUnique({ where: { id } })
      if (!existing) return res.status(404).json({ error: '模板不存在' })
      const { items, ...data } = parsed.data
      const updated = await prisma.$transaction(async (tx) => {
        if (items) {
          await tx.sEIndustryTemplateItem.deleteMany({ where: { templateId: id } })
        }
        return tx.sEIndustryTemplate.update({
          where: { id },
          data: {
            ...data,
            sourceNo: data.sourceNo === undefined ? undefined : data.sourceNo ?? null,
            version: data.version === undefined ? undefined : data.version ?? null,
            description: data.description === undefined ? undefined : data.description ?? null,
            updatedBy: req.userId!,
            ...(items ? {
              controlPointCount: items.length,
              items: { create: items.map((item, index) => mapTemplateItemInput(item, index + 1)) },
            } : {}),
          },
          include: templateInclude(),
        })
      })
      res.json({ data: updated })
    },
  )

  app.patch(
    '/api/admin/standard-execution/industry-templates/:id/publish',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const updated = await prisma.sEIndustryTemplate.update({
        where: { id: String(req.params.id) },
        data: { status: 'PUBLISHED', updatedBy: req.userId! },
      }).catch(() => null)
      if (!updated) return res.status(404).json({ error: '模板不存在' })
      res.json({ data: updated })
    },
  )

  app.patch(
    '/api/admin/standard-execution/industry-templates/:id/offline',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const updated = await prisma.sEIndustryTemplate.update({
        where: { id: String(req.params.id) },
        data: { status: 'OFFLINE', updatedBy: req.userId! },
      }).catch(() => null)
      if (!updated) return res.status(404).json({ error: '模板不存在' })
      res.json({ data: updated })
    },
  )

  app.post(
    '/api/admin/standard-execution/industry-templates/from-requirements',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = TemplateFromRequirementsSchema.safeParse(req.body)
      if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      const requirements = await prisma.standardExecutionRequirement.findMany({
        where: {
          enterpriseId: parsed.data.enterpriseId,
          id: { in: parsed.data.requirementIds },
        },
        include: { source: { select: { sourceNo: true, version: true } } },
        orderBy: { createdAt: 'asc' },
      })
      if (requirements.length !== parsed.data.requirementIds.length) {
        return res.status(404).json({ error: '存在不属于该企业或不存在的控制点' })
      }
      const created = await prisma.sEIndustryTemplate.create({
        data: {
          industryCategory: parsed.data.industryCategory,
          title: parsed.data.title,
          sourceNo: parsed.data.sourceNo ?? requirements[0]?.source?.sourceNo ?? null,
          version: parsed.data.version ?? requirements[0]?.source?.version ?? null,
          description: parsed.data.description ?? null,
          controlPointCount: requirements.length,
          createdBy: req.userId!,
          items: {
            create: requirements.map((item, index) => ({
              clauseNo: item.clauseNo,
              title: item.title,
              requirementText: item.requirementText,
              applicableDeptIds: item.applicableDeptIds === null ? Prisma.DbNull : item.applicableDeptIds as Prisma.InputJsonValue,
              archiveTags: item.archiveTags === null ? Prisma.DbNull : item.archiveTags as Prisma.InputJsonValue,
              recommendedTaskType: item.recommendedTaskType,
              executionDescription: item.executionDescription,
              submitRequirement: item.submitRequirement,
              requiredMaterials: item.requiredMaterials === null ? Prisma.DbNull : item.requiredMaterials as Prisma.InputJsonValue,
              sortOrder: index + 1,
            })),
          },
        },
        include: templateInclude(),
      })
      res.status(201).json({ data: created })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/industry-templates',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const parsed = TemplateListQuerySchema.safeParse({ ...req.query, status: req.query.status ?? 'PUBLISHED' })
      if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      const enterpriseId = await resolveEnterpriseIdForEnterpriseRoute(req, res)
      if (!enterpriseId) return
      const { industryCategory, keyword, page, pageSize } = parsed.data
      const where: Prisma.SEIndustryTemplateWhereInput = { status: 'PUBLISHED' }
      if (industryCategory) where.industryCategory = industryCategory
      if (keyword) {
        where.OR = [
          { title: { contains: keyword, mode: 'insensitive' } },
          { sourceNo: { contains: keyword, mode: 'insensitive' } },
        ]
      }
      const [data, total] = await Promise.all([
        prisma.sEIndustryTemplate.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.sEIndustryTemplate.count({ where }),
      ])
      res.json({ data, total, page, pageSize })
    },
  )

  app.get(
    '/api/enterprise/standard-execution/industry-templates/:id',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const enterpriseId = await resolveEnterpriseIdForEnterpriseRoute(req, res)
      if (!enterpriseId) return
      const data = await prisma.sEIndustryTemplate.findFirst({
        where: { id: String(req.params.id), status: 'PUBLISHED' },
        include: templateInclude(),
      })
      if (!data) return res.status(404).json({ error: '模板不存在或未发布' })
      res.json({ data })
    },
  )

  app.post(
    '/api/enterprise/standard-execution/industry-templates/:id/import',
    requireAuth as never,
    async (req: AuthRequest, res) => {
      const parsed = TemplateImportSchema.safeParse(req.body)
      if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      const enterpriseId = await resolveEnterpriseIdForEnterpriseRoute(req, res)
      if (!enterpriseId) return
      const template = await prisma.sEIndustryTemplate.findFirst({
        where: { id: String(req.params.id), status: 'PUBLISHED' },
        include: templateInclude(),
      })
      if (!template) return res.status(404).json({ error: '模板不存在或未发布' })
      const selectedIds = parsed.data.itemIds?.length ? new Set(parsed.data.itemIds) : null
      const items = selectedIds ? template.items.filter((item) => selectedIds.has(item.id)) : template.items
      if (items.length === 0 || (selectedIds && items.length !== selectedIds.size)) {
        return badRequest(res, '导入条目为空或包含无效条目')
      }
      const result = await prisma.$transaction(async (tx) => {
        const source = await tx.standardExecutionSource.create({
          data: {
            enterpriseId,
            title: template.title,
            sourceType: 'CUSTOM',
            sourceNo: template.sourceNo,
            version: template.version,
            status: 'ACTIVE',
            createdBy: req.userId!,
          },
        })
        await tx.standardExecutionRequirement.createMany({
          data: items.map((item) => ({
            enterpriseId,
            sourceId: source.id,
            clauseNo: item.clauseNo,
            title: item.title,
            requirementText: item.requirementText,
            applicableDeptIds: item.applicableDeptIds === null ? Prisma.DbNull : item.applicableDeptIds as Prisma.InputJsonValue,
            archiveTags: item.archiveTags === null ? Prisma.DbNull : item.archiveTags as Prisma.InputJsonValue,
            recommendedTaskType: item.recommendedTaskType,
            executionDescription: item.executionDescription,
            submitRequirement: item.submitRequirement,
            requiredMaterials: item.requiredMaterials === null ? Prisma.DbNull : item.requiredMaterials as Prisma.InputJsonValue,
            generateMode: 'MANUAL',
            status: 'DRAFT',
            industryTemplateId: template.id,
            industryTemplateItemId: item.id,
            createdBy: req.userId!,
          })),
        })
        return { sourceId: source.id, imported: items.length }
      })
      res.status(201).json(result)
    },
  )
}
