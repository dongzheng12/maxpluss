/**
 * 销售推广 Phase 2 扩展路由
 *
 * 涵盖：
 *   ① 销售自助注册      POST /api/app/sales/join           （无 auth，凭邀请码）
 *   ② 销售 me 系列      GET/PUT /api/app/sales/profile/me   （requireSales）
 *   ③ 销售 dashboard    GET /api/app/sales/dashboard/me     （requireSales）
 *   ④ 销售订单数据      GET /api/app/sales/data/me          （requireSales）
 *   ⑤ 公开落地页接口    GET /api/public/sales/:salesCode    （无 auth）
 *   ⑥ 管理员邀请码       POST/GET /api/admin/sales-invites
 *                       POST /api/admin/sales-invites/:id/disable
 *
 * 公开接口校验顺序（按用户明确约定）：
 *   1) profile.status !== 'ENABLED' → 404（管理员总开关优先）
 *   2) !profile.isPublic            → 404（销售自控开关）
 *   3) contactVisible=false         → 不返回 wechat/phone/qrcode
 */
import type { Express } from 'express'
import { z } from 'zod'
import { createId } from '@paralleldrive/cuid2'
import { prisma } from './db'
import { hashPassword, optionalAuth, requireAuth, requireAdmin, requireSales, signJwt, type AuthRequest } from './auth'
import { maskPhone } from './utils/pii'
import { logger } from './logger'
import { validateDisplayProducts, getProductByCode } from './services/salesProducts.js'
import { detectSensitiveWord } from './utils/sensitiveWords'
import { generateSalesScheme } from './internal/wxScheme.js'

// ─── 常量 ─────────────────────────────────────────
const DEFAULT_COMPANY_NAME = '通标中研标准化技术研究院'
const DEFAULT_DISPLAY_PRODUCTS_JSON = JSON.stringify([
  { code: 'xiaozhi', sort: 1 },
  { code: 'guan',    sort: 2 },
  { code: 'bian',    sort: 3 },
  { code: 'kong',    sort: 4 },
])
const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 天
const SALES_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

// ─── 工具 ────────────────────────────────────────
function genCode(len: number): string {
  let code = ''
  for (let i = 0; i < len; i++) code += SALES_CODE_CHARS[Math.floor(Math.random() * SALES_CODE_CHARS.length)]
  return code
}

async function allocateUniqueSalesCode(): Promise<string | null> {
  for (let i = 0; i < 10; i++) {
    const candidate = genCode(8)
    const dup = await prisma.salesProfile.findUnique({ where: { salesCode: candidate } })
    if (!dup) return candidate
  }
  return null
}

async function allocateUniqueInviteCode(): Promise<string | null> {
  for (let i = 0; i < 10; i++) {
    const candidate = genCode(8)
    const dup = await prisma.salesInvite.findUnique({ where: { inviteCode: candidate } })
    if (!dup) return candidate
  }
  return null
}

function parseDisplayProducts(raw: string | null | undefined): Array<{ code: string; sort: number }> {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p: any) => p && typeof p.code === 'string')
  } catch { return [] }
}

/** 公开落地页序列化（两层校验由调用方控制） */
function serializePublicProfile(profile: any) {
  const products = parseDisplayProducts(profile.displayProducts)
    .sort((a, b) => a.sort - b.sort)
    .map(p => {
      const meta = getProductByCode(p.code)
      if (!meta) return null
      return {
        code: meta.code,
        name: meta.name,
        slogan: meta.slogan,
        description: meta.description,
        targetUsers: meta.targetUsers,
        features: meta.features,
        actionType: meta.actionType,
        ctaLabel: meta.ctaLabel,
      }
    })
    .filter(Boolean)
  const contactVisible = profile.contactVisible !== false
  const companyVisible = profile.companyVisible !== false
  return {
    salesCode: profile.salesCode,
    realName: profile.realName,
    companyName: companyVisible ? profile.companyName : null,
    companyVisible,
    positionTitle: profile.positionTitle,
    avatar: profile.avatar,
    bio: profile.bio,
    contactVisible,
    contact: contactVisible
      ? { wechat: profile.wechat, phone: profile.phone, qrcode: profile.qrcode }
      : { wechat: null, phone: null, qrcode: null },
    products,
  }
}

/** 销售自己 / 管理员看到的完整档案 */
function serializeMeProfile(profile: any) {
  return {
    id: profile.id,
    salesCode: profile.salesCode,
    userId: profile.userId,
    realName: profile.realName,
    companyName: profile.companyName,
    positionTitle: profile.positionTitle,
    avatar: profile.avatar,
    bio: profile.bio,
    wechat: profile.wechat,
    phone: profile.phone,
    qrcode: profile.qrcode,
    contactVisible: profile.contactVisible !== false,
    companyVisible: profile.companyVisible !== false,
    isPublic: profile.isPublic !== false,
    displayProducts: parseDisplayProducts(profile.displayProducts),
    status: profile.status,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}

// ═══════════════════════════════════════════════════════════
// 路由注册
// ═══════════════════════════════════════════════════════════
export function registerSalesV2Routes(app: Express) {

  // ═════════════════════════════════════════════════════════
  // ① 销售凭邀请码绑定（7 种场景）
  //   场景 1：邀请码无效 → 400
  //   场景 2：未登录 + 手机号未注册 → 注册新销售 + 直接发 token（201）
  //   场景 3：未登录 + 手机号已注册 → 409 + hint=login_and_bind
  //   场景 4：已登录 + 非销售 + 无 SalesProfile → 升级（200, note=upgraded）
  //   场景 5：已登录 + role=sales 但无 SalesProfile（异常态）→ 补建（200, note=profile_created）
  //   场景 6：已登录 + 已有 SalesProfile → 409
  //   场景 7：已登录 admin → 403
  // ═════════════════════════════════════════════════════════
  const joinSchema = z.object({
    inviteCode: z.string().min(4).max(20),
    phone: z.string().regex(/^1[3-9]\d{9}$/, '请输入有效手机号').optional(),
    password: z.string().min(6).max(64).optional(),
    realName: z.string().min(1).max(30).optional(),
    companyName: z.string().max(60).optional(),
  })
  app.post('/api/app/sales/join', optionalAuth, async (req: AuthRequest, res) => {
    const parsed = joinSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const { inviteCode, phone, password, realName, companyName } = parsed.data

    // 场景 1：邀请码校验（所有场景前置）
    const invite = await prisma.salesInvite.findUnique({ where: { inviteCode: inviteCode.toUpperCase() } })
    if (!invite) return res.status(400).json({ error: '邀请码无效' })
    if (invite.status === 'USED') return res.status(400).json({ error: '邀请码已被使用' })
    if (invite.status === 'DISABLED') return res.status(400).json({ error: '邀请码已被禁用' })
    if (invite.status === 'EXPIRED') return res.status(400).json({ error: '邀请码已过期' })
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      await prisma.salesInvite.update({ where: { id: invite.id }, data: { status: 'EXPIRED' } })
      return res.status(400).json({ error: '邀请码已过期，请联系管理员重新获取' })
    }

    // ── 已登录路径（场景 4/5/6/7）
    if (req.userId) {
      const currentUser = await prisma.appUser.findUnique({ where: { id: req.userId } })
      if (!currentUser) return res.status(401).json({ error: '会话失效，请重新登录' })

      // 场景 7：admin 拒绝
      if (currentUser.role === 'admin') {
        return res.status(403).json({ error: '管理员账号不支持转为销售' })
      }

      const existingProfile = await prisma.salesProfile.findUnique({ where: { userId: currentUser.id } })

      // 场景 6：已是完整销售
      if (existingProfile) {
        return res.status(409).json({ error: '该账号已开通销售身份，如需更换归属请联系管理员' })
      }

      // 场景 4/5：补建 SalesProfile（4 含 role 升级，5 仅补 profile）
      const isUpgrade = currentUser.role !== 'sales'
      const note = isUpgrade ? 'upgraded' : 'profile_created'

      const salesCode = await allocateUniqueSalesCode()
      if (!salesCode) return res.status(500).json({ error: '生成 salesCode 失败，请重试' })

      const result = await prisma.$transaction(async (tx) => {
        if (isUpgrade) {
          await tx.appUser.update({ where: { id: currentUser.id }, data: { role: 'sales' } })
        }
        const profile = await tx.salesProfile.create({
          data: {
            salesCode,
            userId: currentUser.id,
            realName: realName || currentUser.name || '销售顾问',
            companyName: companyName || DEFAULT_COMPANY_NAME,
            phone: currentUser.phone || '',
            isPublic: true,
            contactVisible: true,
            displayProducts: DEFAULT_DISPLAY_PRODUCTS_JSON,
            status: 'ENABLED',
          },
        })
        await tx.salesCode.create({
          data: { salesCode, profileId: profile.id, label: '主码', status: 'ACTIVE' },
        })
        await tx.salesInvite.update({
          where: { id: invite.id },
          data: { status: 'USED', usedBy: currentUser.id, usedAt: new Date() },
        })
        return profile
      })

      // 重发 JWT（role 可能变了），让前端覆盖旧 token
      const token = signJwt({ sub: currentUser.id, phone: currentUser.phone, role: 'sales' })
      logger.info({ module: 'sales-join', mode: note, userId: currentUser.id, salesCode, inviteId: invite.id }, '销售身份绑定成功（已登录路径）')
      return res.json({
        success: true,
        note,
        token,
        salesCode,
        user: { id: currentUser.id, phone: currentUser.phone, role: 'sales', name: currentUser.name },
      })
    }

    // ── 未登录路径（场景 2/3）
    if (!phone || !password || !realName) {
      return res.status(400).json({ error: '未登录场景下必须提供 phone / password / realName' })
    }

    // 场景 3：手机号已注册
    const existingByPhone = await prisma.appUser.findUnique({ where: { phone } })
    if (existingByPhone?.passwordHash) {
      return res.status(409).json({
        error: '该手机号已注册，请登录后再绑定邀请码',
        hint: 'login_and_bind',
      })
    }

    // 场景 2：注册新销售
    const salesCode = await allocateUniqueSalesCode()
    if (!salesCode) return res.status(500).json({ error: '生成 salesCode 失败，请重试' })

    const pwHash = await hashPassword(password)
    const userId = existingByPhone?.id || createId()

    const result = await prisma.$transaction(async (tx) => {
      // existingByPhone 但无 password（短信登录残留）→ update；否则 create
      const user = existingByPhone
        ? await tx.appUser.update({
            where: { id: existingByPhone.id },
            data: { passwordHash: pwHash, name: realName, role: 'sales' },
          })
        : await tx.appUser.create({
            data: { id: userId, phone, passwordHash: pwHash, name: realName, role: 'sales' },
          })
      const profile = await tx.salesProfile.create({
        data: {
          salesCode,
          userId: user.id,
          realName,
          companyName: companyName || DEFAULT_COMPANY_NAME,
          phone,
          isPublic: true,
          contactVisible: true,
          displayProducts: DEFAULT_DISPLAY_PRODUCTS_JSON,
          status: 'ENABLED',
        },
      })
      await tx.salesCode.create({
        data: { salesCode, profileId: profile.id, label: '主码', status: 'ACTIVE' },
      })
      await tx.salesInvite.update({
        where: { id: invite.id },
        data: { status: 'USED', usedBy: user.id, usedAt: new Date() },
      })
      return { user, profile }
    })

    const token = signJwt({ sub: result.user.id, phone: result.user.phone, role: 'sales' })
    logger.info({ module: 'sales-join', mode: 'register', userId: result.user.id, salesCode, inviteId: invite.id }, '销售自助注册成功')
    return res.status(201).json({
      success: true,
      note: 'register',
      token,
      salesCode,
      user: { id: result.user.id, phone: result.user.phone, role: 'sales', name: result.user.name },
    })
  })

  // ═════════════════════════════════════════════════════════
  // ② 销售 me 系列
  // ═════════════════════════════════════════════════════════
  app.get('/api/app/sales/profile/me', requireSales, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const profile = await prisma.salesProfile.findUnique({ where: { userId: req.userId! } })
    if (!profile) return res.status(404).json({ error: '您还未配置销售推广主页' })
    res.json(serializeMeProfile(profile))
  })

  const meUpdateSchema = z.object({
    realName: z.string().min(1).max(30).optional(),
    companyName: z.string().max(60).optional().nullable(),
    positionTitle: z.string().max(40).optional().nullable(),
    avatar: z.string().max(300).optional().nullable(),
    bio: z.string().max(300).optional().nullable(),
    wechat: z.string().max(50).optional().nullable(),
    phone: z.string().max(20).optional().nullable(),
    qrcode: z.string().max(300).optional().nullable(),
    contactVisible: z.boolean().optional(),
    companyVisible: z.boolean().optional(),
    isPublic: z.boolean().optional(),
    displayProducts: z.array(z.object({ code: z.string(), sort: z.number().int() })).max(4).optional(),
  })
  app.put('/api/app/sales/profile/me', requireSales, async (req: AuthRequest, res) => {
    const parsed = meUpdateSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const profile = await prisma.salesProfile.findUnique({ where: { userId: req.userId! } })
    if (!profile) return res.status(404).json({ error: '您还未配置销售推广主页' })

    // 敏感词检测：bio / companyName / realName / positionTitle 都过滤，防销售推广页出违禁文案
    const textFields: Array<[string, string | null | undefined]> = [
      ['个人介绍', parsed.data.bio],
      ['公司名称', parsed.data.companyName],
      ['展示姓名', parsed.data.realName],
      ['职位', parsed.data.positionTitle],
    ]
    for (const [label, val] of textFields) {
      const hit = detectSensitiveWord(val)
      if (hit) return res.status(400).json({ error: `${label}包含违禁词，请修改后重试` })
    }

    const data: any = { ...parsed.data }
    if (parsed.data.displayProducts) {
      try {
        data.displayProducts = JSON.stringify(validateDisplayProducts(parsed.data.displayProducts))
      } catch (err: any) {
        return res.status(400).json({ error: err.message })
      }
    }
    const updated = await prisma.salesProfile.update({ where: { id: profile.id }, data })
    res.json(serializeMeProfile(updated))
  })

  // ═════════════════════════════════════════════════════════
  // ③ dashboard 数据概览
  // ═════════════════════════════════════════════════════════
  app.get('/api/app/sales/dashboard/me', requireSales, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const profile = await prisma.salesProfile.findUnique({
      where: { userId: req.userId! },
      include: { codes: true },
    })
    if (!profile) return res.status(404).json({ error: '您还未配置销售推广主页' })

    // 归因兼容：合并主码 + 所有额外码（销售可能用多个码推广）
    const allCodes = Array.from(new Set([profile.salesCode, ...profile.codes.map(c => c.salesCode)]))

    const [registerCount, paidAgg, paidUserRows] = await Promise.all([
      prisma.appUser.count({ where: { salesCode: { in: allCodes } } }),
      prisma.appOrder.aggregate({
        where: { salesCode: { in: allCodes }, status: 'PAID' },
        _sum: { amount: true },
      }),
      prisma.appOrder.findMany({
        where: { salesCode: { in: allCodes }, status: 'PAID' },
        select: { userId: true },
      }),
    ])
    const paidUserSet = new Set(paidUserRows.map(r => r.userId).filter(Boolean) as string[])

    // 资料完成度（基础字段）
    const fields = {
      avatar: !!profile.avatar,
      realName: !!profile.realName,
      companyName: !!profile.companyName,
      positionTitle: !!profile.positionTitle,
      bio: !!profile.bio,
      phone: !!profile.phone,
      wechat: !!profile.wechat,
      qrcode: !!profile.qrcode,
    }
    const filledCount = Object.values(fields).filter(Boolean).length
    const totalCount = Object.keys(fields).length
    const completeness = Math.round((filledCount / totalCount) * 100)

    res.json({
      salesCode: profile.salesCode,
      landingUrl: `/s/${profile.salesCode}`,
      isPublic: profile.isPublic !== false,
      status: profile.status,
      profile: {
        completeness,                                              // 百分比
        filledCount,
        totalCount,
        missingFields: Object.entries(fields).filter(([, v]) => !v).map(([k]) => k),
      },
      stats: {
        visitCount: profile.visitCount || 0,                        // P2-B：从 SalesProfile.visitCount 读
        registerCount,
        paidCount: paidUserSet.size,
        paidAmount: paidAgg._sum.amount || 0,                      // 分
      },
    })
  })

  // ═════════════════════════════════════════════════════════
  // ④ 销售订单数据列表
  // ═════════════════════════════════════════════════════════
  app.get('/api/app/sales/data/me', requireSales, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const profile = await prisma.salesProfile.findUnique({
      where: { userId: req.userId! },
      include: { codes: true },
    })
    if (!profile) return res.status(404).json({ error: '您还未配置销售推广主页' })

    const allCodes = Array.from(new Set([profile.salesCode, ...profile.codes.map(c => c.salesCode)]))
    const { page = '1', pageSize = '20' } = req.query as any
    const skip = (Number(page) - 1) * Number(pageSize)

    const [total, orders] = await Promise.all([
      prisma.appOrder.count({
        where: { salesCode: { in: allCodes }, status: 'PAID' },
      }),
      prisma.appOrder.findMany({
        where: { salesCode: { in: allCodes }, status: 'PAID' },
        skip,
        take: Number(pageSize),
        orderBy: { paidAt: 'desc' },
        include: {
          user: { select: { phone: true } },
          plan: { select: { id: true, name: true } },
        },
      }),
    ])

    res.json({
      total,
      page: Number(page),
      pageSize: Number(pageSize),
      items: orders.map(o => ({
        id: o.id,
        orderNo: o.orderNo,
        title: o.title,
        amount: o.amount,
        status: o.status,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        planId: o.plan?.id || o.planId,
        planName: o.plan?.name || null,
        customerPhone: o.user?.phone ? maskPhone(o.user.phone) : null,
      })),
    })
  })

  // ═════════════════════════════════════════════════════════
  // ⑤ 公开落地页（两层校验：status → isPublic）
  // ═════════════════════════════════════════════════════════
  app.get('/api/public/sales/:salesCode', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const salesCode = String(req.params.salesCode || '').trim()
    if (!salesCode || salesCode.length > 16) return res.status(400).json({ error: '参数错误' })

    // 先查 SalesCode 表（销售自建的多码）→ 找到 profileId 拿到对应 profile
    let profile = null as any
    const codeRow = await prisma.salesCode.findUnique({ where: { salesCode } })
    if (codeRow) {
      if (codeRow.status !== 'ACTIVE') {
        return res.status(404).json({ error: '该推广链接已被禁用', status: 'DISABLED' })
      }
      profile = await prisma.salesProfile.findUnique({ where: { id: codeRow.profileId } })
    } else {
      // fallback：兼容主码（SalesProfile.salesCode）
      profile = await prisma.salesProfile.findUnique({ where: { salesCode } })
    }

    if (!profile) return res.status(404).json({ error: '该推广链接不存在', status: 'NOT_FOUND' })

    // 校验顺序：status 总开关优先
    if (profile.status !== 'ENABLED') {
      return res.status(404).json({ error: '该推广链接已被下线', status: 'DISABLED' })
    }
    if (profile.isPublic === false) {
      return res.status(404).json({ error: '该推广页尚未启用', status: 'NOT_PUBLIC' })
    }

    // P2-B：访问量原子自增（fire-and-forget，不 await，不阻塞响应）
    prisma.salesProfile.update({
      where: { id: profile.id },
      data: { visitCount: { increment: 1 } },
    }).catch((err: any) => {
      logger.warn({ module: 'sales-public', err: err?.message, profileId: profile.id }, 'visitCount 自增失败（不影响响应）')
    })

    // P3：微信 URL Scheme 懒生成（首次访问时生成并缓存到 SalesProfile.wxScheme）
    // 用于前端在普通微信浏览器内 location.href = wxScheme 拉起小程序，无需公众号配置
    let wxScheme: string | null = profile.wxScheme ?? null
    if (!wxScheme) {
      try {
        wxScheme = await generateSalesScheme(profile.salesCode)
        // 异步写库，不阻塞响应（已拿到 scheme 直接返回给本次请求）
        prisma.salesProfile.update({
          where: { id: profile.id },
          data: { wxScheme } as any, // prisma generate 后类型自动对齐（schema 已加 wxScheme 字段）
        }).catch((err: any) => {
          logger.warn({ module: 'sales-public', err: err?.message, profileId: profile.id }, 'wxScheme 写库失败（不影响响应）')
        })
      } catch (err: any) {
        // WX 未配置或小程序未发布时静默降级，前端走 H5 注册页
        logger.warn({ module: 'sales-public', err: err?.message, profileId: profile.id }, 'wxScheme 生成失败（降级返回 null）')
        wxScheme = null
      }
    }

    // 返回时把公开页用的 salesCode 替换成用户访问用的那个（归因链路一致）
    res.json({ ...serializePublicProfile(profile), salesCode, wxScheme })
  })

  // ═════════════════════════════════════════════════════════
  // ⑦ 销售多推广码管理
  // ═════════════════════════════════════════════════════════
  const MAX_CODES_PER_SALES = 10

  async function allocateUniqueSalesCodeV2(): Promise<string | null> {
    // 同时查 SalesCode 表和 SalesProfile.salesCode 确保全局唯一
    for (let i = 0; i < 10; i++) {
      const candidate = genCode(8)
      const [c1, c2] = await Promise.all([
        prisma.salesCode.findUnique({ where: { salesCode: candidate } }),
        prisma.salesProfile.findUnique({ where: { salesCode: candidate } }),
      ])
      if (!c1 && !c2) return candidate
    }
    return null
  }

  app.post('/api/app/sales/codes', requireSales, async (req: AuthRequest, res) => {
    const schema = z.object({ label: z.string().max(40).optional().nullable() })
    const parsed = schema.safeParse(req.body || {})
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })

    const profile = await prisma.salesProfile.findUnique({ where: { userId: req.userId! } })
    if (!profile) return res.status(404).json({ error: '您还未配置销售推广主页' })

    const count = await prisma.salesCode.count({ where: { profileId: profile.id } })
    if (count >= MAX_CODES_PER_SALES) {
      return res.status(400).json({ error: `推广码最多 ${MAX_CODES_PER_SALES} 个，如需新增请先禁用旧码` })
    }

    const salesCode = await allocateUniqueSalesCodeV2()
    if (!salesCode) return res.status(500).json({ error: '生成推广码失败，请重试' })

    const code = await prisma.salesCode.create({
      data: {
        salesCode,
        profileId: profile.id,
        label: parsed.data.label || null,
        status: 'ACTIVE',
      },
    })

    const publicUrl = process.env.VITE_PUBLIC_URL || process.env.PUBLIC_URL || ''
    const landingUrl = publicUrl
      ? `${publicUrl.replace(/\/$/, '')}/s/${salesCode}`
      : `/s/${salesCode}`

    logger.info({ module: 'sales-codes', action: 'create', userId: req.userId, codeId: code.id, salesCode }, '销售生成多推广码')
    res.status(201).json({
      id: code.id,
      salesCode: code.salesCode,
      label: code.label,
      status: code.status,
      createdAt: code.createdAt,
      landingUrl,
    })
  })

  app.get('/api/app/sales/codes', requireSales, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const profile = await prisma.salesProfile.findUnique({ where: { userId: req.userId! } })
    if (!profile) return res.status(404).json({ error: '您还未配置销售推广主页' })

    const codes = await prisma.salesCode.findMany({
      where: { profileId: profile.id },
      orderBy: { createdAt: 'asc' },
    })

    const publicUrl = process.env.VITE_PUBLIC_URL || process.env.PUBLIC_URL || ''
    const build = (code: string) => publicUrl
      ? `${publicUrl.replace(/\/$/, '')}/s/${code}`
      : `/s/${code}`

    res.json({
      items: codes.map(c => ({
        id: c.id,
        salesCode: c.salesCode,
        label: c.label,
        status: c.status,
        createdAt: c.createdAt,
        landingUrl: build(c.salesCode),
        isPrimary: c.salesCode === profile.salesCode,
      })),
    })
  })

  app.patch('/api/app/sales/codes/:id/disable', requireSales, async (req: AuthRequest, res) => {
    const profile = await prisma.salesProfile.findUnique({ where: { userId: req.userId! } })
    if (!profile) return res.status(404).json({ error: '您还未配置销售推广主页' })

    const code = await prisma.salesCode.findUnique({ where: { id: String(req.params.id) } })
    if (!code || code.profileId !== profile.id) return res.status(404).json({ error: '推广码不存在' })

    // 禁止禁用主码（防止意外把 /s/主码 链接全打死）
    if (code.salesCode === profile.salesCode) {
      return res.status(400).json({ error: '主码不可禁用，如需停用推广页请在"我的推广页"关闭发布开关' })
    }

    const updated = await prisma.salesCode.update({
      where: { id: code.id },
      data: { status: 'DISABLED' },
    })
    logger.info({ module: 'sales-codes', action: 'disable', userId: req.userId, codeId: code.id }, '销售禁用推广码')
    res.json({ id: updated.id, status: updated.status })
  })

  app.delete('/api/app/sales/codes/:id', requireSales, async (req: AuthRequest, res) => {
    const profile = await prisma.salesProfile.findUnique({ where: { userId: req.userId! } })
    if (!profile) return res.status(404).json({ error: '您还未配置销售推广主页' })

    const code = await prisma.salesCode.findUnique({ where: { id: String(req.params.id) } })
    if (!code || code.profileId !== profile.id) return res.status(404).json({ error: '推广码不存在' })

    // 主码禁止删除
    if (code.salesCode === profile.salesCode) {
      return res.status(400).json({ error: '主码不可删除' })
    }

    // 保护归因：已有订单的码拒绝删除（防止历史统计丢失）
    const orderCount = await prisma.appOrder.count({ where: { salesCode: code.salesCode } })
    if (orderCount > 0) {
      return res.status(400).json({ error: '该推广码已有归因订单，不可删除，可禁用' })
    }

    await prisma.salesCode.delete({ where: { id: code.id } })
    logger.info({ module: 'sales-codes', action: 'delete', userId: req.userId, codeId: code.id, salesCode: code.salesCode }, '销售删除推广码')
    res.json({ success: true })
  })

  // ═════════════════════════════════════════════════════════
  // ⑥ 管理员邀请码
  // ═════════════════════════════════════════════════════════
  app.post('/api/admin/sales-invites', requireAdmin, async (req: AuthRequest, res) => {
    // count=1 单个；count=2~50 批量
    const count = Math.min(50, Math.max(1, Number(req.body?.count) || 1))
    const publicUrl = process.env.VITE_PUBLIC_URL || process.env.PUBLIC_URL || ''
    const buildUrl = (code: string) => publicUrl
      ? `${publicUrl.replace(/\/$/, '')}/sales/join?invite=${code}`
      : `/sales/join?invite=${code}`

    const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
    const created: any[] = []

    for (let i = 0; i < count; i++) {
      const inviteCode = await allocateUniqueInviteCode()
      if (!inviteCode) break
      const invite = await prisma.salesInvite.create({
        data: { inviteCode, createdBy: req.userId!, status: 'UNUSED', expiresAt },
      })
      created.push({
        id: invite.id,
        inviteCode,
        status: invite.status,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
        inviteUrl: buildUrl(inviteCode),
      })
    }

    if (created.length === 0) return res.status(500).json({ error: '生成邀请码失败，请重试' })

    logger.info({ module: 'sales-invite', action: 'create', adminId: req.userId, count: created.length }, '生成销售邀请码')

    // 单个生成保持原有返回结构（兼容旧调用）
    if (count === 1) return res.status(201).json(created[0])

    // 批量返回列表
    res.status(201).json({ count: created.length, items: created })
  })

  app.get('/api/admin/sales-invites', requireAdmin, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const { status, page = '1', pageSize = '20' } = req.query as any
    const where: any = {}
    if (status && ['UNUSED', 'USED', 'DISABLED', 'EXPIRED'].includes(status)) where.status = status

    const skip = (Number(page) - 1) * Number(pageSize)
    const [total, items] = await Promise.all([
      prisma.salesInvite.count({ where }),
      prisma.salesInvite.findMany({
        where, skip, take: Number(pageSize),
        orderBy: { createdAt: 'desc' },
      }),
    ])

    // 附加 usedBy 的用户基础信息 + 关联的 SalesProfile（销售落地页 salesCode）
    const usedByIds = items.map(i => i.usedBy).filter(Boolean) as string[]
    const [usersList, profilesList] = usedByIds.length === 0
      ? [[] as any[], [] as any[]]
      : await Promise.all([
          prisma.appUser.findMany({
            where: { id: { in: usedByIds } },
            select: { id: true, phone: true, name: true },
          }),
          prisma.salesProfile.findMany({
            where: { userId: { in: usedByIds } },
            select: { userId: true, salesCode: true },
          }),
        ])
    const usersMap = new Map(usersList.map((u: any) => [u.id, u]))
    const profilesMap = new Map(profilesList.map((p: any) => [p.userId, p.salesCode]))

    const publicUrl = process.env.VITE_PUBLIC_URL || process.env.PUBLIC_URL || ''
    const buildLanding = (code: string) => publicUrl
      ? `${publicUrl.replace(/\/$/, '')}/s/${code}`
      : `/s/${code}`
    const enriched = items.map(i => {
      const user = i.usedBy ? usersMap.get(i.usedBy) : null
      const sc = i.usedBy ? profilesMap.get(i.usedBy) : null
      return {
        ...i,
        inviteUrl: publicUrl
          ? `${publicUrl.replace(/\/$/, '')}/sales/join?invite=${i.inviteCode}`
          : `/sales/join?invite=${i.inviteCode}`,
        usedByUser: user
          ? { ...user, salesCode: sc || null, landingUrl: sc ? buildLanding(sc) : null }
          : null,
      }
    })

    res.json({ total, page: Number(page), pageSize: Number(pageSize), items: enriched })
  })

  app.post('/api/admin/sales-invites/:id/disable', requireAdmin, async (req: AuthRequest, res) => {
    const id = String(req.params.id)
    const invite = await prisma.salesInvite.findUnique({ where: { id } })
    if (!invite) return res.status(404).json({ error: '邀请码不存在' })
    if (invite.status === 'USED') return res.status(400).json({ error: '已使用的邀请码无需禁用' })

    const updated = await prisma.salesInvite.update({
      where: { id },
      data: { status: 'DISABLED' },
    })
    logger.info({ module: 'sales-invite', action: 'disable', adminId: req.userId, inviteId: id }, '禁用销售邀请码')
    res.json({ id: updated.id, status: updated.status })
  })

  // 批量操作
  const bulkSchema = z.object({
    ids: z.array(z.string().min(1)).min(1).max(100),
    action: z.enum(['DISABLE', 'DELETE']),
  })
  app.post('/api/admin/sales-invites/bulk', requireAdmin, async (req: AuthRequest, res) => {
    const parsed = bulkSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const { ids, action } = parsed.data

    const invites = await prisma.salesInvite.findMany({ where: { id: { in: ids } } })
    if (invites.length === 0) return res.status(404).json({ error: '未找到任何邀请码' })

    let affected = 0
    let skipped = 0

    if (action === 'DISABLE') {
      // 只禁用 UNUSED 的（USED/已 DISABLED/EXPIRED 跳过）
      const targetIds = invites.filter(i => i.status === 'UNUSED').map(i => i.id)
      skipped = invites.length - targetIds.length
      if (targetIds.length > 0) {
        const r = await prisma.salesInvite.updateMany({
          where: { id: { in: targetIds } },
          data: { status: 'DISABLED' },
        })
        affected = r.count
      }
    } else {
      // DELETE：不允许删 USED（保留注册审计），其他可删
      const targetIds = invites.filter(i => i.status !== 'USED').map(i => i.id)
      skipped = invites.length - targetIds.length
      if (targetIds.length > 0) {
        const r = await prisma.salesInvite.deleteMany({
          where: { id: { in: targetIds } },
        })
        affected = r.count
      }
    }

    logger.info({ module: 'sales-invite', action: `bulk_${action.toLowerCase()}`, adminId: req.userId, affected, skipped }, '批量操作销售邀请码')
    res.json({ affected, skipped, total: invites.length })
  })

  // ═════════════════════════════════════════════════════════
  // ⑧ 销售推广素材（P2-A）
  //    模板写死在后端，用销售 realName / salesCode / landingUrl 填充变量
  //    前端 sales-material 页一键复制
  // ═════════════════════════════════════════════════════════
  app.get('/api/app/sales/materials', requireSales, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const profile = await prisma.salesProfile.findUnique({ where: { userId: req.userId! } })
    if (!profile) return res.status(404).json({ error: '您还未配置销售推广主页' })

    const publicUrl = process.env.VITE_PUBLIC_URL || process.env.PUBLIC_URL || ''
    const landingUrl = publicUrl
      ? `${publicUrl.replace(/\/$/, '')}/s/${profile.salesCode}`
      : `https://biaozhunxiaozhi.com/s/${profile.salesCode}`
    const realName = profile.realName || '标准小智顾问'

    res.json({
      wechatGroup:
`各位老师好👋
我是 ${realName}，标准小智的服务顾问。

如果你正在做企业标准化、标准查询、文档比对、标准编写或标准动态监测，欢迎用我的专属链接体验：
${landingUrl}

注册即送 7 天免费试用，有任何问题随时联系我。`,

      moments:
`📐 推荐一个标准人都在用的 AI 工具：标准小智

✅ 标准信息查询：公开标准信息快速检索，查找更方便
✅ 智能问答：直接问我"GB/T 1.1 怎么用"
✅ 文档比对：一对一 / 全库相似度 一站式

我的专属链接：${landingUrl}
注册即送 7 天免费试用 🎁`,

      intro:
`【标准小智 · 标准智能平台】产品介绍

📌 ${realName} 为您专属服务

四大产品矩阵：
1. 标准小智AI — 问标准、做任务、找服务、扫一扫，一站式智能助手
2. 标准管理 — 标准资产 100% 沉淀，全生命周期闭环
3. 标准编写 — GB/T 1.1-2020 合规，提效 40%+
4. 标准监测 — 全球动态检测，秒级风险预警

服务范围：
· 7 天免费试用，快速体验核心功能
· 一对一产品演示与培训
· 企业采购对接，定制化方案

体验入口：${landingUrl}`,
    })
  })
}
