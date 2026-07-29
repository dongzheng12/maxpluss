/**
 * 优惠券管理路由（阶段三）
 *
 * 管理员（requireAdmin）：
 *   - POST   /api/admin/coupons              — 创建模板
 *   - GET    /api/admin/coupons              — 列模板
 *   - PATCH  /api/admin/coupons/:id          — 改模板（仅 status / description / 时间窗）
 *   - POST   /api/admin/coupons/:id/issue    — 批量发给指定 user 列表
 *   - GET    /api/admin/coupons/:id/grants   — 看某模板已发的 UserCoupon
 *   - POST   /api/admin/user-coupons/:id/revoke — 撤销 UserCoupon（仅 AVAILABLE 可撤，LOCKED 拒绝）
 */
import type { Express } from 'express'
import { z } from 'zod'
import { createId } from '@paralleldrive/cuid2'
import { prisma } from './db.js'
import { requireAdmin, type AuthRequest } from './auth'
import { issueCoupon, couponsEnabled } from './coupons'

const ALLOWED_SCOPES = ['ALL', 'MEMBERSHIP', 'MEMBERSHIP_PERSONAL', 'MEMBERSHIP_PRO', 'STANDARD']
const ALLOWED_TYPES = ['FIXED', 'PERCENT']
const ALLOWED_SOURCES = ['ISSUED_REGISTER', 'ISSUED_REFERRAL', 'ISSUED_ADMIN', 'ISSUED_CAMPAIGN'] as const

export function registerCouponRoutes(app: Express) {
  const featureGate = (_req: any, res: any, next: any) => {
    if (!couponsEnabled()) return res.status(404).json({ error: '优惠券功能未启用' })
    next()
  }

  // ─── 创建模板 ─────────────────────────────────────────
  const createCouponSchema = z.object({
    code: z.string().regex(/^[A-Z0-9_-]{2,32}$/, 'code 必须是 2-32 位大写字母/数字/-/_'),
    name: z.string().min(1).max(40),
    description: z.string().max(200).optional(),
    discountType: z.enum(['FIXED', 'PERCENT']),
    discountValue: z.number().int().min(1),
    minAmount: z.number().int().min(0).default(0),
    maxDiscount: z.number().int().min(1).optional(),
    applicableScope: z.string().refine(s => ALLOWED_SCOPES.includes(s), '非法 scope').default('ALL'),
    validFrom: z.string().or(z.date()),
    validTo: z.string().or(z.date()),
    totalQuota: z.number().int().min(1).optional(),
  })

  app.post('/api/admin/coupons', featureGate, requireAdmin as any, async (req: AuthRequest, res) => {
    const parsed = createCouponSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const d = parsed.data

    if (d.discountType === 'PERCENT' && (d.discountValue < 1 || d.discountValue > 99)) {
      return res.status(400).json({ error: 'PERCENT 折扣 discountValue 须 1-99' })
    }
    const validFrom = new Date(d.validFrom)
    const validTo = new Date(d.validTo)
    if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validTo.getTime())) {
      return res.status(400).json({ error: '时间格式不合法' })
    }
    if (validTo.getTime() <= validFrom.getTime()) {
      return res.status(400).json({ error: 'validTo 必须晚于 validFrom' })
    }

    const exists = await prisma.coupon.findUnique({ where: { code: d.code } })
    if (exists) return res.status(409).json({ error: '该 code 已存在' })

    const created = await prisma.coupon.create({
      data: {
        code: d.code,
        name: d.name,
        description: d.description,
        discountType: d.discountType,
        discountValue: d.discountValue,
        minAmount: d.minAmount,
        maxDiscount: d.maxDiscount ?? null,
        applicableScope: d.applicableScope,
        validFrom,
        validTo,
        totalQuota: d.totalQuota ?? null,
        createdBy: req.userId!,
      },
    })
    res.status(201).json(created)
  })

  // ─── 列模板 ──────────────────────────────────────────
  app.get('/api/admin/coupons', featureGate, requireAdmin as any, async (req: AuthRequest, res) => {
    const status = req.query.status ? String(req.query.status) : undefined
    const where = status ? { status } : {}
    const items = await prisma.coupon.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    res.json({ items })
  })

  // ─── 模板下拉(批量发券 Modal 用)─────────────────────────
  // 仅返回 status=ACTIVE 且未过期的模板,展示券名称/类型/面额/scope/有效期
  app.get('/api/admin/coupons/templates', featureGate, requireAdmin as any, async (_req: AuthRequest, res) => {
    const items = await prisma.coupon.findMany({
      where: {
        status: 'ACTIVE',
        validTo: { gte: new Date() },
      },
      select: {
        id: true,
        code: true,
        name: true,
        discountType: true,
        discountValue: true,
        minAmount: true,
        maxDiscount: true,
        applicableScope: true,
        validFrom: true,
        validTo: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    res.json({ items })
  })

  // ─── 改模板（保守，只允许改 status / description / 时间窗 / 配额） ────
  const updateCouponSchema = z.object({
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    description: z.string().max(200).optional(),
    validTo: z.string().or(z.date()).optional(),
    totalQuota: z.number().int().min(1).nullable().optional(),
  })
  app.patch('/api/admin/coupons/:id', featureGate, requireAdmin as any, async (req: AuthRequest, res) => {
    const id = String(req.params.id)
    const parsed = updateCouponSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const data: any = { ...parsed.data }
    if (data.validTo) data.validTo = new Date(data.validTo)
    const updated = await prisma.coupon.update({ where: { id }, data }).catch(() => null)
    if (!updated) return res.status(404).json({ error: '券模板不存在' })
    res.json(updated)
  })

  // ─── 批量发券 ─────────────────────────────────────────
  // body: { userIds: string[], expiresAt?: Date }
  // 用 source=ISSUED_ADMIN，sourceRef=adminBatchId（自动生成）保证幂等
  const issueSchema = z.object({
    userIds: z.array(z.string().min(1)).min(1).max(500),
    expiresAt: z.string().or(z.date()).optional(),
  })
  app.post('/api/admin/coupons/:id/issue', featureGate, requireAdmin as any, async (req: AuthRequest, res) => {
    const couponId = String(req.params.id)
    const parsed = issueSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const { userIds } = parsed.data
    const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined

    const adminBatchId = createId()
    const results = { batchId: adminBatchId, success: 0, skipped: 0, failed: 0, errors: [] as Array<{ userId: string; reason: string }> }

    for (const userId of userIds) {
      try {
        // isolationLevel: 'Serializable' — PG 下显式声明避免 READ COMMITTED 在并发批量发券
        // 时发生 (userId, couponId) unique 漏锁。SQLite 不支持选项，会被静默忽略。
        const r = await prisma.$transaction(async (tx) => {
          return issueCoupon(tx, {
            userId,
            couponId,
            source: 'ISSUED_ADMIN',
            sourceRef: adminBatchId,
            expiresAt,
          })
        }, { isolationLevel: 'Serializable' })
        if (r.issued) results.success++
        else results.skipped++
      } catch (err: any) {
        results.failed++
        results.errors.push({ userId, reason: err?.message || '未知错误' })
      }
    }
    res.json(results)
  })

  // ─── 批量发券(phone-based)── 给 admin/admins 页「手动下发优惠券」用
  // body: { phones: string[], couponId?: string, templateCode?: string }
  // couponId 优先;为空则按 templateCode 查 Coupon.code
  // 复用现有 issueCoupon() + ISSUED_ADMIN + adminBatchId 幂等
  // 已持有同模板 AVAILABLE 的 user 进 skipped(issueCoupon 内部四元组 UNIQUE 兜底)
  const batchIssueSchema = z.object({
    phones: z.array(z.string()).min(1).max(100),
    couponId: z.string().optional(),
    templateCode: z.string().optional(),
  }).refine(d => d.couponId || d.templateCode, {
    message: '必须提供 couponId 或 templateCode',
  })

  app.post('/api/admin/coupons/batch-issue', featureGate, requireAdmin as any, async (req: AuthRequest, res) => {
    const parsed = batchIssueSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })

    // 解析 couponId
    let coupon
    if (parsed.data.couponId) {
      coupon = await prisma.coupon.findUnique({ where: { id: parsed.data.couponId } })
    } else if (parsed.data.templateCode) {
      coupon = await prisma.coupon.findUnique({ where: { code: parsed.data.templateCode } })
    }
    if (!coupon) return res.status(404).json({ error: '优惠券模板不存在' })
    if (coupon.status !== 'ACTIVE') return res.status(400).json({ error: '券模板已下线，不能批量发放' })
    if (coupon.validTo.getTime() <= Date.now()) return res.status(400).json({ error: '券模板已过期' })

    const { phonesToUsers, PhoneBatchLimitError } = await import('./services/phoneResolver')
    let resolved
    try {
      resolved = await phonesToUsers(parsed.data.phones)
    } catch (e: any) {
      if (e instanceof PhoneBatchLimitError) {
        return res.status(400).json({ error: e.message })
      }
      throw e
    }

    const adminBatchId = createId()
    const issued: Array<{ id: string; phone: string; name: string | null }> = []
    const skipped: Array<{ id: string; phone: string; name: string | null; reason: string }> = []
    const failed: Array<{ phone: string; reason: string }> = []

    for (const u of resolved.found) {
      try {
        // 用户语义保护：已持有同模板 AVAILABLE → 跳过(不依赖 issueCoupon 内部四元组幂等,
        // 因为每次批量都生成新 adminBatchId,四元组会变,不视为已发)
        const existingAvail = await prisma.userCoupon.findFirst({
          where: { userId: u.id, couponId: coupon.id, status: 'AVAILABLE' },
          select: { id: true },
        })
        if (existingAvail) {
          skipped.push({ id: u.id, phone: u.phone, name: u.name, reason: '已持有该券（AVAILABLE）' })
          continue
        }

        const r = await prisma.$transaction(async (tx) => {
          return issueCoupon(tx, {
            userId: u.id,
            couponId: coupon.id,
            source: 'ISSUED_ADMIN',
            sourceRef: adminBatchId,
            // 不传 expiresAt → issueCoupon 用 Coupon.validTo
          })
        }, { isolationLevel: 'Serializable' })
        if (r.issued) {
          issued.push({ id: u.id, phone: u.phone, name: u.name })
        } else {
          // 兜底：四元组冲突也算 skipped（罕见，前一查询遗漏的并发情况）
          skipped.push({ id: u.id, phone: u.phone, name: u.name, reason: '已发放（幂等命中）' })
        }
      } catch (err: any) {
        failed.push({ phone: u.phone, reason: err?.message || '未知错误' })
      }
    }

    res.json({
      batchId: adminBatchId,
      coupon: { id: coupon.id, code: coupon.code, name: coupon.name },
      issued,
      skipped,
      notFound: resolved.notFound,
      invalid: resolved.invalid,
      failed,
    })
  })

  // ─── 看某模板已发明细 ──────────────────────────────────
  app.get('/api/admin/coupons/:id/grants', featureGate, requireAdmin as any, async (req: AuthRequest, res) => {
    const couponId = String(req.params.id)
    const status = req.query.status ? String(req.query.status) : undefined
    const where: any = { couponId }
    if (status) where.status = status
    const items = await prisma.userCoupon.findMany({
      where,
      include: { user: { select: { id: true, phone: true, name: true } } },
      orderBy: { issuedAt: 'desc' },
      take: 500,
    })
    res.json({ items })
  })

  // ─── 撤销 UserCoupon（仅 AVAILABLE 可撤；LOCKED 拒绝避免破坏支付中订单） ──
  const revokeSchema = z.object({
    reason: z.string().min(1).max(200),
  })
  app.post('/api/admin/user-coupons/:id/revoke', featureGate, requireAdmin as any, async (req: AuthRequest, res) => {
    const id = String(req.params.id)
    const parsed = revokeSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })

    const uc = await prisma.userCoupon.findUnique({ where: { id } })
    if (!uc) return res.status(404).json({ error: '优惠券不存在' })
    if (uc.status === 'LOCKED') {
      return res.status(409).json({ error: '该券正在用于支付中订单，禁止撤销' })
    }
    if (uc.status !== 'AVAILABLE') {
      return res.status(409).json({ error: `当前状态(${uc.status})不可撤销` })
    }

    const updated = await prisma.userCoupon.updateMany({
      where: { id, status: 'AVAILABLE' },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedBy: req.userId!,
        revokeReason: parsed.data.reason,
      },
    })
    if (updated.count !== 1) {
      return res.status(409).json({ error: '撤销失败，券状态可能已变更' })
    }
    res.json({ ok: true })
  })
}
