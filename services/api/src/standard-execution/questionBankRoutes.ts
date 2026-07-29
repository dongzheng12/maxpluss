/**
 * 题库管理 — Admin only
 *
 *   GET    /api/admin/standard-execution/question-banks          — 列表
 *   POST   /api/admin/standard-execution/question-banks          — 创建
 *   GET    /api/admin/standard-execution/question-banks/:id      — 详情（含题目）
 *   PATCH  /api/admin/standard-execution/question-banks/:id      — 编辑
 *   DELETE /api/admin/standard-execution/question-banks/:id      — 软删除
 *
 * 题目格式（存在 questions JSON 字段里）：
 *   Array<{
 *     id: string,
 *     type: 'single' | 'multi',
 *     text: string,
 *     opts: string[],      // 选项文字
 *     answer: number[],    // 正确选项 index（0-based）
 *     score: number,       // 该题分值
 *     exp?: string         // 解析说明（选填）
 *   }>
 */
import type { Express } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { requireAdmin, type AuthRequest } from '../auth.js'
import { getEnterpriseId } from './utils.js'

export const QuestionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['single', 'multi']),
  text: z.string().min(1).max(1000),
  opts: z.array(z.string().min(1).max(500)).min(2).max(8),
  answer: z.array(z.number().int().min(0)).min(1),
  score: z.number().int().min(1).max(100),
  exp: z.string().max(2000).optional(),
  relatedRequirementId: z.string().optional().nullable(), // P1-9: AI 出题来源检查点（选填）
})

export const BankCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional().nullable(),
  questions: z.array(QuestionSchema).min(1).max(200),
})

export const BankUpdateSchema = BankCreateSchema.partial()

export function registerQuestionBankRoutes(app: Express) {
  // ── 列表 ──────────────────────────────────────────────────────────────────
  app.get('/api/admin/standard-execution/question-banks', requireAdmin, async (req: AuthRequest, res) => {
    try {
      const enterpriseId = getEnterpriseId(req as never)
      const keyword = (req.query.keyword as string | undefined)?.trim()
      const page = Math.max(1, Number(req.query.page) || 1)
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20))

      const where = {
        enterpriseId,
        deletedAt: null,
        ...(keyword ? { title: { contains: keyword } } : {}),
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

      // 把 questions 转为只返回题数（列表不需要全量题目）
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
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ── 创建 ──────────────────────────────────────────────────────────────────
  app.post('/api/admin/standard-execution/question-banks', requireAdmin, async (req: AuthRequest, res) => {
    try {
      const enterpriseId = getEnterpriseId(req as never)
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
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ── 详情 ──────────────────────────────────────────────────────────────────
  app.get('/api/admin/standard-execution/question-banks/:id', requireAdmin, async (req: AuthRequest, res) => {
    try {
      const enterpriseId = getEnterpriseId(req as never)
      const id = String(req.params.id || '').trim()
      const bank = await prisma.sEQuestionBank.findFirst({
        where: { id, enterpriseId, deletedAt: null },
      })
      if (!bank) return res.status(404).json({ error: '题库不存在' })
      res.json(bank)
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ── 编辑 ──────────────────────────────────────────────────────────────────
  app.patch('/api/admin/standard-execution/question-banks/:id', requireAdmin, async (req: AuthRequest, res) => {
    try {
      const enterpriseId = getEnterpriseId(req as never)
      const id = String(req.params.id || '').trim()
      const existing = await prisma.sEQuestionBank.findFirst({
        where: { id, enterpriseId, deletedAt: null },
      })
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
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ── 软删除 ─────────────────────────────────────────────────────────────────
  app.delete('/api/admin/standard-execution/question-banks/:id', requireAdmin, async (req: AuthRequest, res) => {
    try {
      const enterpriseId = getEnterpriseId(req as never)
      const id = String(req.params.id || '').trim()
      const existing = await prisma.sEQuestionBank.findFirst({
        where: { id, enterpriseId, deletedAt: null },
      })
      if (!existing) return res.status(404).json({ error: '题库不存在' })

      // 如有正在使用的任务，拒绝删除
      const inUse = await prisma.standardExecutionTask.count({
        where: { quizBankId: id, deletedAt: null, status: { in: ['DRAFT', 'PUBLISHED'] } },
      })
      if (inUse > 0) return res.status(409).json({ error: `该题库还被 ${inUse} 个任务使用，无法删除` })

      await prisma.sEQuestionBank.update({
        where: { id },
        data: { deletedAt: new Date() },
      })
      res.json({ ok: true })
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message })
    }
  })
}
