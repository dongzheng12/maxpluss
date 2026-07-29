/**
 * 销售赠送权益路由
 * 前台：查询赠送码 / 领取 / 注册并领取
 * 后台：创建 / 列表 / 作废 / 撤销权益
 */
import type { Express } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import multer from 'multer'
import xlsx from 'xlsx'
import { createId } from '@paralleldrive/cuid2'
import { prisma } from './db'
import { hashPassword, signJwt, requireAuth, requireAdmin, type AuthRequest } from './auth'
import { trackServerEvent, markUserActive } from './tracker'
import { maskEmail, maskPhone } from './utils/pii'
import { writeAuditLog } from './utils/auditLog.js'

// 销售赠送档位白名单（2026-04-14 收敛：只允许这 4 档）
// 7/30 天等同 personal 会员权益，复用 personal 配额逻辑（不做额外处理）
export const GIFT_TIERS = [
  { label: '7天体验',  planId: 'personal', durationDays: 7 },
  { label: '30天体验', planId: 'personal', durationDays: 30 },
  { label: '一年个人', planId: 'personal', durationDays: 365 },
  { label: '一年专业', planId: 'pro',      durationDays: 365 },
] as const

// ─── 辅助 ─────────────────────────────────────────────────

function generateGiftCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 排除易混淆字符
  let code = ''
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

function appendLog(existing: string | null, action: string, operator: string, note?: string): string {
  const logs = existing ? JSON.parse(existing) : []
  logs.push({ action, operator, time: new Date().toISOString(), note: note || '' })
  return JSON.stringify(logs)
}

function serializeMembership(m: any) {
  if (!m) return null
  return {
    id: m.id, planId: m.planId,
    plan: m.plan ? { id: m.plan.id, name: m.plan.name } : undefined,
    status: m.status, source: m.source, sourceRef: m.sourceRef,
    startAt: m.startAt, endAt: m.endAt,
  }
}

// ─── 权益发放核心逻辑 ─────────────────────────────────────

async function grantMembership(userId: string, gift: any): Promise<any> {
  // 查当前是否有活跃会员 — 如有则叠加在到期日之后
  const current = await prisma.userMembership.findFirst({
    where: { userId, status: 'ACTIVE', endAt: { gte: new Date() } },
    orderBy: { endAt: 'desc' },
  })

  const startAt = current ? current.endAt : new Date()
  const endAt = new Date(startAt.getTime() + gift.durationDays * 24 * 60 * 60 * 1000)

  const membership = await prisma.userMembership.create({
    data: {
      id: crypto.randomUUID(),
      userId,
      planId: gift.planId,
      source: 'SALES_GIFT',
      sourceRef: gift.code,
      status: 'ACTIVE',
      startAt,
      endAt,
    },
  })

  // 埋点：会员开通/续费（赠送路径），与购买路径共用事件名
  trackServerEvent('membership_activated', {
    planId: gift.planId,
    source: 'SALES_GIFT',
    sourceRef: gift.code,
    isRenewal: !!current,
    endAt: membership.endAt.toISOString(),
  }, userId)
  markUserActive(userId)

  await writeAuditLog({
    actor: userId,
    action: 'MEMBERSHIP_CREATED',
    targetType: 'UserMembership',
    targetId: membership.id,
    diff: {
      userId,
      planId: gift.planId,
      source: 'SALES_GIFT',
      sourceRef: gift.code,
      startAt: membership.startAt.toISOString(),
      endAt: membership.endAt.toISOString(),
      isRenewal: !!current,
    },
  })

  return membership
}

// ─── 路由注册 ─────────────────────────────────────────────

export function registerGiftRoutes(app: Express) {

  // ═══════════════════════════════════════════════════════════
  // 前台接口
  // ═══════════════════════════════════════════════════════════

  // ── GET /api/app/gifts/:code — 查询赠送码信息
  // IP 限速防暴力枚举（8 字符码熵 ~43 bits）
  const giftQueryBuckets = new Map<string, { count: number; resetAt: number }>()
  setInterval(() => { const now = Date.now(); for (const [k, v] of giftQueryBuckets.entries()) if (now > v.resetAt) giftQueryBuckets.delete(k) }, 5 * 60 * 1000)
  app.get('/api/app/gifts/:code', (req, res, next) => {
    const ip = (Array.isArray(req.headers['x-forwarded-for']) ? req.headers['x-forwarded-for'][0] : req.headers['x-forwarded-for']?.split(',')[0]) || req.socket.remoteAddress || 'unknown'
    const now = Date.now(); const e = giftQueryBuckets.get(ip)
    if (!e || now > e.resetAt) { giftQueryBuckets.set(ip, { count: 1, resetAt: now + 60_000 }); return next() }
    if (e.count >= 5) return res.status(429).json({ error: '查询过于频繁，请稍后再试' })
    e.count++; next()
  }, async (req, res) => {
    const gift = await prisma.salesGift.findUnique({ where: { code: String(req.params.code) } })
    if (!gift) return res.status(404).json({ error: '赠送链接无效' })

    // 检查状态
    if (gift.status === 'CLAIMED') return res.status(410).json({ error: '该赠送权益已被领取', status: 'CLAIMED' })
    if (gift.status === 'REVOKED') return res.status(410).json({ error: '该赠送资格已失效，请联系销售', status: 'REVOKED' })
    if (gift.status === 'EXPIRED' || gift.expiresAt < new Date()) {
      return res.status(410).json({ error: '该赠送资格已过期，请联系销售获取新链接', status: 'EXPIRED' })
    }

    // 查询 plan 名称
    const plan = await prisma.membershipPlan.findUnique({ where: { id: gift.planId } })

    res.json({
      code: gift.code,
      planName: plan?.name || gift.planId,
      planId: gift.planId,
      durationDays: gift.durationDays,
      expiresAt: gift.expiresAt,
      note: gift.note,
      createdByName: gift.createdByName,
      phone: maskPhone(gift.phone),
      email: maskEmail(gift.email),
    })
  })

  // ── POST /api/app/gifts/:code/claim — 已登录用户领取（乐观锁防竞态）
  app.post('/api/app/gifts/:code/claim', requireAuth, async (req: AuthRequest, res) => {
    const code = String(req.params.code)

    // 查用户
    const user = await prisma.appUser.findUnique({ where: { id: req.userId } })
    if (!user) return res.status(401).json({ error: '用户不存在' })

    // 乐观锁：原子更新 status = PENDING → CLAIMED，防止并发重复领取
    const updated = await prisma.salesGift.updateMany({
      where: { code, status: 'PENDING', expiresAt: { gte: new Date() } },
      data: { status: 'CLAIMED', claimedAt: new Date(), claimedBy: user.id },
    })
    if (updated.count === 0) {
      // 查原因
      const gift = await prisma.salesGift.findUnique({ where: { code } })
      if (!gift) return res.status(404).json({ error: '赠送链接无效' })
      if (gift.status === 'CLAIMED') return res.status(400).json({ error: '该赠送码已被领取' })
      if (gift.expiresAt < new Date()) return res.status(400).json({ error: '该赠送资格已过期' })
      return res.status(400).json({ error: '该赠送码已被使用或已失效' })
    }

    const gift = await prisma.salesGift.findUnique({ where: { code } })
    if (!gift) return res.status(404).json({ error: '赠送链接无效' })

    // 校验手机号+邮箱匹配
    const phoneMatch = !gift.phone || user.phone === gift.phone
    const emailMatch = !gift.email || user.email === gift.email
    if (!phoneMatch || !emailMatch) {
      // 回滚状态
      await prisma.salesGift.update({ where: { code }, data: { status: 'PENDING', claimedAt: null, claimedBy: null } })
      return res.status(403).json({ error: '您的账号信息与赠送记录不一致，请使用指定手机号/邮箱的账号' })
    }

    // 发放权益
    const membership = await grantMembership(user.id, gift)

    // 更新赠送记录（补充 membershipId 和日志）
    await prisma.salesGift.update({
      where: { id: gift.id },
      data: {
        membershipId: membership.id,
        logs: appendLog(gift.logs, 'CLAIMED', user.id, '用户领取'),
      },
    })

    await writeAuditLog({
      actor: user.id,
      action: 'GIFT_CLAIMED',
      targetType: 'SalesGift',
      targetId: gift.id,
      diff: {
        code: gift.code,
        claimedBy: user.id,
        membershipId: membership.id,
        mode: 'logged_in',
      },
    })

    res.json({
      message: '领取成功',
      membership: {
        planId: membership.planId,
        startAt: membership.startAt,
        endAt: membership.endAt,
      },
    })
  })

  // ── POST /api/app/gifts/:code/claim-with-register — 注册并领取（手机短信验证码）
  const claimRegisterSchema = z.object({
    phone: z.string().regex(/^1[3-9]\d{9}$/, '请输入有效手机号'),
    smsCode: z.string().length(6, '短信验证码为6位'),
    password: z.string().min(6, '密码至少6位').max(64),
    name: z.string().optional(),
    organization: z.string().optional(),
  })

  app.post('/api/app/gifts/:code/claim-with-register', async (req, res) => {
    const code = String(req.params.code)

    // 乐观锁：原子抢占
    const locked = await prisma.salesGift.updateMany({
      where: { code, status: 'PENDING', expiresAt: { gte: new Date() } },
      data: { status: 'CLAIMED', claimedAt: new Date() },
    })
    if (locked.count === 0) {
      const gift = await prisma.salesGift.findUnique({ where: { code } })
      if (!gift) return res.status(404).json({ error: '赠送链接无效' })
      if (gift.status === 'CLAIMED') return res.status(400).json({ error: '该赠送码已被领取' })
      if (gift.expiresAt < new Date()) return res.status(400).json({ error: '该赠送资格已过期' })
      return res.status(400).json({ error: '该赠送码已被使用或已失效' })
    }

    const gift = await prisma.salesGift.findUnique({ where: { code } })
    if (!gift) return res.status(404).json({ error: '赠送链接无效' })

    const parsed = claimRegisterSchema.safeParse(req.body)
    if (!parsed.success) {
      await prisma.salesGift.update({ where: { code }, data: { status: 'PENDING', claimedAt: null } })
      return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    }

    const { phone, smsCode, password, name, organization } = parsed.data

    // 校验与赠送记录匹配
    if (gift.phone && gift.phone !== phone) {
      await prisma.salesGift.update({ where: { code }, data: { status: 'PENDING', claimedAt: null } })
      return res.status(403).json({ error: '手机号与赠送记录不一致，请使用赠送指定的手机号注册' })
    }

    // 验证手机短信验证码
    const codeRecord = await prisma.verificationCode.findFirst({
      where: { target: phone, type: 'phone', usedAt: null, expiresAt: { gte: new Date() } },
      orderBy: { createdAt: 'desc' },
    })
    if (!codeRecord || codeRecord.code !== smsCode) {
      await prisma.salesGift.update({ where: { code }, data: { status: 'PENDING', claimedAt: null } })
      return res.status(400).json({ error: '短信验证码无效或已过期' })
    }
    await prisma.verificationCode.update({ where: { id: codeRecord.id }, data: { usedAt: new Date() } })

    // 检查手机号是否已注册
    const existingByPhone = await prisma.appUser.findUnique({ where: { phone } })
    if (existingByPhone?.passwordHash) {
      await prisma.salesGift.update({ where: { code }, data: { status: 'PENDING', claimedAt: null } })
      return res.status(409).json({ error: '该手机号已注册，请登录后领取' })
    }

    // 创建用户
    const pwHash = await hashPassword(password)
    const userId = createId()
    const user = existingByPhone
      ? await prisma.appUser.update({
          where: { phone },
          data: { passwordHash: pwHash, name: name || existingByPhone.name, organization: organization || existingByPhone.organization },
        })
      : await prisma.appUser.create({
          data: { id: userId, phone, passwordHash: pwHash, name: name || `用户${phone.slice(-4)}`, organization, role: 'user' },
        })

    // 发放权益
    const membership = await grantMembership(user.id, gift)

    // 更新赠送记录
    await prisma.salesGift.update({
      where: { id: gift.id },
      data: {
        status: 'CLAIMED', claimedAt: new Date(), claimedBy: user.id, membershipId: membership.id,
        logs: appendLog(gift.logs, 'CLAIMED', user.id, '注册并领取'),
      },
    })

    await writeAuditLog({
      actor: user.id,
      action: 'GIFT_CLAIMED',
      targetType: 'SalesGift',
      targetId: gift.id,
      diff: {
        code: gift.code,
        claimedBy: user.id,
        membershipId: membership.id,
        mode: 'register_and_claim',
      },
    })

    const token = signJwt({ sub: user.id, phone: user.phone, role: user.role })

    res.status(201).json({
      message: '注册并领取成功',
      token,
      user: { id: user.id, phone: user.phone, name: user.name, role: user.role },
      membership: { planId: membership.planId, startAt: membership.startAt, endAt: membership.endAt },
    })
  })

  // ═══════════════════════════════════════════════════════════
  // 管理后台接口
  // ═══════════════════════════════════════════════════════════

  // ── POST /api/admin/gifts — 创建赠送资格
  // 允许 4 档（2026-04-14 收敛）：7天体验 / 30天体验 / 一年个人 / 一年专业
  // 7/30 天必须配 planId=personal；一年个人=personal；一年专业=pro
  const createGiftSchema = z.object({
    phone: z.string().regex(/^1[3-9]\d{9}$/, '请输入有效手机号'),
    email: z.string().email('请输入有效邮箱').optional(),
    planId: z.enum(['personal', 'pro']),
    durationDays: z.number().int().refine((d) => [7, 30, 365].includes(d), {
      message: '赠送天数仅支持 7 / 30 / 365',
    }),
    expiresAt: z.string().optional(),
    note: z.string().optional(),
  }).refine(
    (d) => GIFT_TIERS.some((t) => t.planId === d.planId && t.durationDays === d.durationDays),
    { message: '档位组合不合法：7/30 天必须是个人档，专业档仅支持 365 天' },
  )

  app.post('/api/admin/gifts', requireAdmin, async (req: AuthRequest, res) => {
    const parsed = createGiftSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })

    const { phone, email = '', planId, durationDays, note } = parsed.data
    const expiresAt = parsed.data.expiresAt
      ? new Date(parsed.data.expiresAt)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 默认30天

    // 获取管理员信息
    const admin = await prisma.appUser.findUnique({ where: { id: req.userId } })
    const adminName = admin?.name || '管理员'

    // 检查是否已有未领取的赠送记录
    const existing = await prisma.salesGift.findFirst({
      where: { phone, email, status: 'PENDING' },
    })
    // 不阻止，只提醒

    // 生成唯一赠送码
    let code: string
    let attempts = 0
    do {
      code = generateGiftCode()
      attempts++
      const exists = await prisma.salesGift.findUnique({ where: { code } })
      if (!exists) break
    } while (attempts < 10)

    const gift = await prisma.salesGift.create({
      data: {
        id: crypto.randomUUID(),
        code, phone, email, planId, durationDays, expiresAt, note,
        createdBy: req.userId!, createdByName: adminName,
        logs: appendLog(null, 'CREATED', req.userId!, '创建赠送'),
      },
    })

    await writeAuditLog({
      actor: req.userId,
      action: 'GIFT_CREATED',
      targetType: 'SalesGift',
      targetId: gift.id,
      diff: {
        code: gift.code,
        phone: gift.phone,
        planId: gift.planId,
        durationDays: gift.durationDays,
        createdBy: req.userId,
        createdByName: adminName,
        source: 'admin_single',
      },
    })

    res.status(201).json({
      id: gift.id,
      code: gift.code,
      claimUrl: `/claim/${gift.code}`,
      warning: existing ? '注意：该客户已有未领取的赠送资格' : undefined,
    })
  })

  // ── GET /api/admin/gifts — 赠送记录列表
  app.get('/api/admin/gifts', requireAdmin, async (req: AuthRequest, res) => {
    const { status, phone, email, page = '1', pageSize = '20' } = req.query as any

    const where: any = {}
    if (status) where.status = status
    if (phone) where.phone = { contains: phone }
    if (email) where.email = { contains: email }

    const skip = (Number(page) - 1) * Number(pageSize)
    const [total, items] = await Promise.all([
      prisma.salesGift.count({ where }),
      prisma.salesGift.findMany({
        where, skip, take: Number(pageSize),
        orderBy: { createdAt: 'desc' },
      }),
    ])

    res.json({
      total, page: Number(page), pageSize: Number(pageSize),
      items: items.map((g) => ({
        ...g,
        phone: maskPhone(g.phone),
        email: maskEmail(g.email),
        logs: g.logs ? JSON.parse(g.logs) : [],
      })),
    })
  })

  // ── 固定路径路由必须在 :id 之前注册（Express 路由优先级）──

  // ── GET /api/admin/gifts/template — 下载批量导入模板
  app.get('/api/admin/gifts/template', requireAdmin, (_req2: AuthRequest, res2) => {
    const wb2 = xlsx.utils.book_new()
    const ws2 = xlsx.utils.aoa_to_sheet([
      ['手机号', '权益类型', '赠送时长(天)', '备注'],
      ['13800138001', 'personal', 365, '示例：个人版1年'],
      ['13800138002', 'pro', 365, '示例：专业版1年'],
    ])
    ws2['!cols'] = [{ wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 30 }]
    xlsx.utils.book_append_sheet(wb2, ws2, '赠送导入模板')
    const buf2 = xlsx.write(wb2, { type: 'buffer', bookType: 'xlsx' })
    res2.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res2.setHeader('Content-Disposition', 'attachment; filename=gift_import_template.xlsx')
    res2.send(buf2)
  })

  // ── GET /api/admin/gifts/export — 导出赠送记录 Excel
  app.get('/api/admin/gifts/export', requireAdmin, async (req: AuthRequest, res) => {
    const { status: qs, phone: qp } = req.query as any
    const w: any = {}
    if (qs) w.status = qs
    if (qp) w.phone = { contains: qp }
    const items = await prisma.salesGift.findMany({ where: w, orderBy: { createdAt: 'desc' } })
    const rows = items.map(g => ({
      '赠送码': g.code, '客户手机号': maskPhone(g.phone),
      '权益类型': g.planId === 'pro' ? '专业包年' : g.planId === 'enterprise' ? '企业版' : '个人包年',
      '赠送时长(天)': g.durationDays,
      '状态': g.status === 'PENDING' ? '未领取' : g.status === 'CLAIMED' ? '已领取' : g.status === 'EXPIRED' ? '已过期' : '已作废',
      '发放人': g.createdByName || '', '创建时间': g.createdAt?.toISOString().slice(0, 19).replace('T', ' '),
      '领取时间': g.claimedAt?.toISOString().slice(0, 19).replace('T', ' ') || '', '备注': g.note || '',
    }))
    const wb3 = xlsx.utils.book_new()
    const ws3 = xlsx.utils.json_to_sheet(rows)
    ws3['!cols'] = [{ wch: 12 }, { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 20 }, { wch: 20 }, { wch: 30 }]
    xlsx.utils.book_append_sheet(wb3, ws3, '赠送记录')
    const buf3 = xlsx.write(wb3, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename=gifts_export_${new Date().toISOString().slice(0, 10)}.xlsx`)
    res.send(buf3)
  })

  // ── GET /api/admin/gifts/stats — 赠送统计看板
  app.get('/api/admin/gifts/stats', requireAdmin, async (_req: AuthRequest, res) => {
    const [totalGifts, pendingGifts, claimedGifts, expiredGifts, revokedGifts] = await Promise.all([
      prisma.salesGift.count(), prisma.salesGift.count({ where: { status: 'PENDING' } }),
      prisma.salesGift.count({ where: { status: 'CLAIMED' } }), prisma.salesGift.count({ where: { status: 'EXPIRED' } }),
      prisma.salesGift.count({ where: { status: 'REVOKED' } }),
    ])
    const allGifts = await prisma.salesGift.findMany({ select: { createdByName: true, status: true, createdAt: true } })
    const bySales: Record<string, { total: number; claimed: number; pending: number }> = {}
    for (const g of allGifts) {
      const nm = g.createdByName || '未知'
      if (!bySales[nm]) bySales[nm] = { total: 0, claimed: 0, pending: 0 }
      bySales[nm].total++
      if (g.status === 'CLAIMED') bySales[nm].claimed++
      if (g.status === 'PENDING') bySales[nm].pending++
    }
    const salesRanking = Object.entries(bySales).map(([nm, s]) => ({ name: nm, ...s, claimRate: s.total > 0 ? Math.round(s.claimed / s.total * 100) : 0 })).sort((a, b) => b.total - a.total)
    const monthlyStats: { month: string; created: number; claimed: number }[] = []
    for (let i = 11; i >= 0; i--) {
      const d = new Date(); d.setMonth(d.getMonth() - i)
      const y = d.getFullYear(), mo = d.getMonth()
      const start = new Date(y, mo, 1), end = new Date(y, mo + 1, 1)
      const monthStr = `${y}-${String(mo + 1).padStart(2, '0')}`
      monthlyStats.push({ month: monthStr, created: allGifts.filter(g => g.createdAt >= start && g.createdAt < end).length, claimed: allGifts.filter(g => g.status === 'CLAIMED' && g.createdAt >= start && g.createdAt < end).length })
    }
    const claimRate = totalGifts > 0 ? Math.round(claimedGifts / totalGifts * 100) : 0
    res.json({ overview: { total: totalGifts, pending: pendingGifts, claimed: claimedGifts, expired: expiredGifts, revoked: revokedGifts, claimRate }, salesRanking, monthlyStats })
  })

  // ── POST /api/admin/gifts/batch — 批量导入赠送
  const batchUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })
  app.post('/api/admin/gifts/batch', requireAdmin, batchUpload.single('file'), async (req: AuthRequest, res) => {
    const file = (req as any).file
    if (!file) return res.status(400).json({ error: '请上传 Excel 文件' })
    const admin = await prisma.appUser.findUnique({ where: { id: req.userId } })
    const adminName = admin?.name || '管理员'
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    try {
      const wb4 = xlsx.read(file.buffer, { type: 'buffer' })
      const ws4 = wb4.Sheets[wb4.SheetNames[0]]
      const dataRows: any[] = xlsx.utils.sheet_to_json(ws4)
      const results: { phone: string; code?: string; error?: string }[] = []
      for (const row of dataRows) {
        const ph = String(row['手机号'] || '').trim()
        const pl = String(row['权益类型'] || 'personal').trim()
        const dur = Number(row['赠送时长(天)']) || 365
        const nt = String(row['备注'] || '').trim()
        if (!/^1[3-9]\d{9}$/.test(ph)) { results.push({ phone: ph, error: '手机号格式无效' }); continue }
        if (!['personal', 'pro'].includes(pl)) { results.push({ phone: ph, error: '权益类型无效' }); continue }
        if (!GIFT_TIERS.some((t) => t.planId === pl && t.durationDays === dur)) {
          results.push({ phone: ph, error: '档位组合不合法（仅允许 personal/7、personal/30、personal/365、pro/365）' })
          continue
        }
        let cd: string; let att = 0
        do { cd = generateGiftCode(); att++; const ex = await prisma.salesGift.findUnique({ where: { code: cd } }); if (!ex) break } while (att < 10)
        const batchGift = await prisma.salesGift.create({ data: { id: crypto.randomUUID(), code: cd, phone: ph, email: '', planId: pl, durationDays: dur, expiresAt, note: nt, createdBy: req.userId!, createdByName: adminName, logs: appendLog(null, 'CREATED', req.userId!, `批量导入: ${nt}`) } })
        await writeAuditLog({
          actor: req.userId,
          action: 'GIFT_CREATED',
          targetType: 'SalesGift',
          targetId: batchGift.id,
          diff: {
            code: batchGift.code,
            phone: batchGift.phone,
            planId: batchGift.planId,
            durationDays: batchGift.durationDays,
            createdBy: req.userId,
            createdByName: adminName,
            source: 'admin_batch',
          },
        })
        results.push({ phone: ph, code: cd })
      }
      res.json({ total: dataRows.length, success: results.filter(r => !r.error).length, failed: results.filter(r => r.error).length, results })
    } catch (e: any) { res.status(400).json({ error: `解析失败: ${e.message}` }) }
  })

  // ── :id 路由（必须在所有固定路径之后）──

  // ── GET /api/admin/gifts/:id — 单条详情
  app.get('/api/admin/gifts/:id', requireAdmin, async (req: AuthRequest, res) => {
    const gift = await prisma.salesGift.findUnique({ where: { id: String(req.params.id) } })
    if (!gift) return res.status(404).json({ error: '赠送记录不存在' })

    res.json({
      ...gift,
      logs: gift.logs ? JSON.parse(gift.logs) : [],
    })
  })

  // ── POST /api/admin/gifts/:id/revoke — 作废未领取的赠送
  app.post('/api/admin/gifts/:id/revoke', requireAdmin, async (req: AuthRequest, res) => {
    const gift = await prisma.salesGift.findUnique({ where: { id: String(req.params.id) } })
    if (!gift) return res.status(404).json({ error: '赠送记录不存在' })
    if (gift.status !== 'PENDING') return res.status(400).json({ error: '只能作废未领取的赠送资格' })

    const reason = (req.body as any)?.reason || ''

    await prisma.salesGift.update({
      where: { id: gift.id },
      data: {
        status: 'REVOKED', revokedAt: new Date(), revokedBy: req.userId,
        revokeReason: reason,
        logs: appendLog(gift.logs, 'REVOKED', req.userId!, reason || '管理员作废'),
      },
    })

    await writeAuditLog({
      actor: req.userId,
      action: 'GIFT_REVOKED',
      targetType: 'SalesGift',
      targetId: gift.id,
      diff: {
        code: gift.code,
        revokedBy: req.userId,
        reason: reason || '管理员作废',
        scope: 'pending_only',
      },
    })

    res.json({ message: '已作废' })
  })

  // ── POST /api/admin/gifts/:id/revoke-membership — 撤销已发放的权益
  app.post('/api/admin/gifts/:id/revoke-membership', requireAdmin, async (req: AuthRequest, res) => {
    const gift = await prisma.salesGift.findUnique({ where: { id: String(req.params.id) } })
    if (!gift) return res.status(404).json({ error: '赠送记录不存在' })
    if (gift.status !== 'CLAIMED') return res.status(400).json({ error: '只能撤销已领取的赠送' })
    if (!gift.membershipId) return res.status(400).json({ error: '关联的权益记录不存在' })

    const reason = (req.body as any)?.reason || ''

    // 撤销 membership
    await prisma.userMembership.update({
      where: { id: gift.membershipId },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedBy: req.userId, revokeReason: reason },
    })

    // 更新赠送记录
    await prisma.salesGift.update({
      where: { id: gift.id },
      data: {
        status: 'REVOKED', revokedAt: new Date(), revokedBy: req.userId, revokeReason: reason,
        logs: appendLog(gift.logs, 'REVOKED_MEMBERSHIP', req.userId!, reason || '撤销权益'),
      },
    })

    await writeAuditLog({
      actor: req.userId,
      action: 'MEMBERSHIP_REVOKED',
      targetType: 'UserMembership',
      targetId: gift.membershipId,
      diff: {
        userId: gift.claimedBy,
        revokedBy: req.userId,
        reason: reason || '撤销权益',
        source: 'admin_gift_revoke',
        giftId: gift.id,
        giftCode: gift.code,
      },
    })
    await writeAuditLog({
      actor: req.userId,
      action: 'GIFT_REVOKED',
      targetType: 'SalesGift',
      targetId: gift.id,
      diff: {
        code: gift.code,
        revokedBy: req.userId,
        reason: reason || '撤销权益',
        scope: 'claimed_with_membership',
        membershipId: gift.membershipId,
      },
    })

    res.json({ message: '已撤销权益' })
  })

}
