/**
 * 销售专属推广主页路由
 *
 * 分三段：
 *   ① 销售自服务    /api/app/sales/*    （requireAuth，只能操作自己）
 *   ② 公开落地页    /api/app/s/:code    （无需登录）
 *   ③ 管理后台     /api/admin/sales/*  （requireAdmin）
 *
 * salesCode 由后台生成（8 位大写字母数字，去易混淆 IO01），唯一。
 * 销售用户 role='sales'，跟 user/admin 区别开。
 */
import type { Express } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import multer from 'multer'
import { parse as csvParse } from 'csv-parse/sync'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createId } from '@paralleldrive/cuid2'
import { prisma } from './db'
import { hashPassword, requireAuth, requireAdmin, type AuthRequest } from './auth'
import { maskPhone } from './utils/pii'
import { logger } from './logger'
import {
  SALES_PRODUCTS,
  validateDisplayProducts,
  getProductByCode,
} from './services/salesProducts.js'

// ─── 上传目录 ────────────────────────────────────────────────
const SALES_UPLOAD_DIR = join(process.cwd(), 'uploads', 'sales')
if (!existsSync(SALES_UPLOAD_DIR)) mkdirSync(SALES_UPLOAD_DIR, { recursive: true })

// ─── 常量 ────────────────────────────────────────────────────
const DEFAULT_COMPANY_NAME = '通标中研标准化技术研究院'
/** 批量导入时的默认初始密码（管理员应立即让销售改密码） */
const DEFAULT_IMPORT_PASSWORD = 'Sales@2026'
/** 新销售默认展示产品（4 个全展示，销售可在自己的后台调整） */
const DEFAULT_DISPLAY_PRODUCTS_JSON = JSON.stringify([
  { code: 'xiaozhi', sort: 1 },
  { code: 'guan',    sort: 2 },
  { code: 'bian',    sort: 3 },
  { code: 'kong',    sort: 4 },
])

// ─── 工具 ────────────────────────────────────────────────────
const SALES_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去 I O 0 1
function generateSalesCode(): string {
  let code = ''
  for (let i = 0; i < 8; i++) code += SALES_CODE_CHARS[Math.floor(Math.random() * SALES_CODE_CHARS.length)]
  return code
}

/** 生成唯一 salesCode（最多重试 10 次；全部冲突返回 null） */
async function allocateUniqueSalesCode(): Promise<string | null> {
  for (let i = 0; i < 10; i++) {
    const candidate = generateSalesCode()
    const dup = await prisma.salesProfile.findUnique({ where: { salesCode: candidate } })
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

/** 公开接口序列化：屏蔽内部字段，给前端展示用 */
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
  // contactVisible=false 时不返回联系方式；兼容历史数据（undefined 视为 true）
  const visible = profile.contactVisible !== false
  return {
    salesCode: profile.salesCode,
    realName: profile.realName,
    companyName: profile.companyName,
    positionTitle: profile.positionTitle,
    avatar: profile.avatar,
    bio: profile.bio,
    contactVisible: visible,
    contact: visible ? {
      wechat: profile.wechat,
      phone: profile.phone,
      qrcode: profile.qrcode,
    } : {
      wechat: null,
      phone: null,
      qrcode: null,
    },
    products,
  }
}

/** 管理后台 / 销售自服务序列化（比公开接口多几个字段） */
function serializePrivateProfile(profile: any) {
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
    displayProducts: parseDisplayProducts(profile.displayProducts),
    status: profile.status,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}

// ─── 公共字段 schema（销售 + 管理员可编辑交集）──────────────
const profileEditableSchema = z.object({
  realName: z.string().min(1).max(30).optional(),
  companyName: z.string().max(60).optional().nullable(),
  positionTitle: z.string().max(40).optional().nullable(),
  avatar: z.string().max(300).optional().nullable(),
  bio: z.string().max(300).optional().nullable(),
  wechat: z.string().max(50).optional().nullable(),
  phone: z.string().max(20).optional().nullable(),
  qrcode: z.string().max(300).optional().nullable(),
  contactVisible: z.boolean().optional(),
  displayProducts: z.array(z.object({ code: z.string(), sort: z.number().int() })).max(4).optional(),
})

// ═══════════════════════════════════════════════════════════
// 注册路由（唯一导出）
// ═══════════════════════════════════════════════════════════
export function registerSalesRoutes(app: Express) {
  // ── upload multer（共享给 /sales/upload）──
  const salesUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, SALES_UPLOAD_DIR),
      filename: (_req, file, cb) => {
        const hash = crypto.randomBytes(8).toString('hex')
        const ext = (file.originalname.toLowerCase().match(/\.(jpe?g|png|webp)$/) || [''])[0]
        cb(null, `sales-${Date.now()}-${hash}${ext}`)
      },
    }),
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB 头像/二维码不需要大
    defParamCharset: 'utf8',
    fileFilter: (_req, file, cb) => {
      const allowedMime = ['image/jpeg', 'image/png', 'image/webp']
      const allowedExt = /\.(jpe?g|png|webp)$/i
      if (allowedMime.includes(file.mimetype) && allowedExt.test(file.originalname)) {
        cb(null, true)
      } else {
        cb(new Error(`仅支持 jpg/png/webp 图片（当前：${file.mimetype}）`))
      }
    },
  })

  // ═════════════════════════════════════════════════════════
  // ① 销售自服务
  // ═════════════════════════════════════════════════════════

  /**
   * GET /api/app/sales/profile — 当前登录用户的销售主页（需 role=sales 且有 profile）
   */
  app.get('/api/app/sales/profile', requireAuth, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    let profile = await prisma.salesProfile.findUnique({ where: { userId: req.userId! } })
    if (!profile) {
      // v3 §3 兜底初始化：用户已通过角色或历史 role=sales 拥有销售身份但 SalesProfile 没建时，
      // 进入销售工作台触发自动 ensure。判断信号同 /me/permissions 三信号。
      const hasSalesSignal = await detectSalesSignal(req.userId!, req.userRole)
      if (hasSalesSignal) {
        try {
          const { ensureSalesProfileAndPrimaryCode } = await import('./services/salesIdentity.js')
          const r = await ensureSalesProfileAndPrimaryCode(req.userId!)
          profile = r.profile
        } catch (e: any) {
          return res.status(500).json({ error: e?.message || '初始化销售档案失败' })
        }
      } else {
        return res.status(404).json({ error: '您还未配置销售推广主页，请联系管理员开通' })
      }
    }
    res.json(serializePrivateProfile(profile))
  })

  /**
   * POST /api/app/sales/profile/init — 自助开通推广主页
   *
   * 放行规则（与用户决策 5 边界一致：普通用户不能自助开通）：
   *   - role=admin / superAdmin：放行
   *   - 已被分配 ACTIVE 销售内置角色的 user：放行（兜底批量分配后死锁）
   *   - 普通 user（无销售角色）：403
   *
   * 已有档案 → 200 + created=false（幂等）
   * isPublic 默认 true（自助场景：用户主动想公开）
   */
  app.post('/api/app/sales/profile/init', requireAuth, async (req: AuthRequest, res) => {
    let allowed = req.userRole === 'admin'
    if (!allowed) {
      // 检查是否有 ACTIVE 销售内置角色（batch-assign / set-sales 分配的）
      const { SALES_BUILT_IN_ROLE_NAME } = await import('./services/builtInRoles.js')
      const hasSalesRole = await prisma.adminUserRole.findFirst({
        where: {
          userId: req.userId!,
          status: 'ACTIVE',
          role: { name: SALES_BUILT_IN_ROLE_NAME, status: 'ACTIVE' },
        },
        select: { id: true },
      })
      allowed = !!hasSalesRole
    }
    if (!allowed) {
      return res.status(403).json({ error: '仅管理员或已分配销售角色的用户可自助开通推广主页' })
    }
    try {
      const { ensureSalesProfileAndPrimaryCode } = await import('./services/salesIdentity.js')
      const r = await ensureSalesProfileAndPrimaryCode(req.userId!, {
        isPublic: true,
      })
      res.json({
        profileId: r.profile.id,
        salesCode: r.primaryCode,
        created: r.created,
        primaryCodeCreated: r.primaryCodeCreated,
      })
    } catch (e: any) {
      res.status(500).json({ error: e?.message || '开通推广主页失败' })
    }
  })

  /** 检测用户是否拥有销售身份（v3 三信号：role=sales / "销售"角色 / SalesProfile 已存在） */
  async function detectSalesSignal(userId: string, role: string | undefined): Promise<boolean> {
    if (role === 'sales') return true
    const { SALES_BUILT_IN_ROLE_NAME } = await import('./services/builtInRoles.js')
    const has = await prisma.adminUserRole.findFirst({
      where: { userId, status: 'ACTIVE', role: { name: SALES_BUILT_IN_ROLE_NAME, status: 'ACTIVE' } },
    })
    return !!has
  }

  /**
   * PUT /api/app/sales/profile — 编辑自己的主页（salesCode / userId / status 不允许改）
   */
  app.put('/api/app/sales/profile', requireAuth, async (req: AuthRequest, res) => {
    const parsed = profileEditableSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })

    const profile = await prisma.salesProfile.findUnique({ where: { userId: req.userId! } })
    if (!profile) return res.status(404).json({ error: '您还未配置销售推广主页' })

    const data: any = { ...parsed.data }
    if (parsed.data.displayProducts) {
      try {
        const normalized = validateDisplayProducts(parsed.data.displayProducts)
        data.displayProducts = JSON.stringify(normalized)
      } catch (err: any) {
        return res.status(400).json({ error: err.message })
      }
    }

    const updated = await prisma.salesProfile.update({ where: { id: profile.id }, data })
    res.json(serializePrivateProfile(updated))
  })

  /**
   * POST /api/app/sales/upload — 上传头像或二维码（2MB / jpg|png|webp）
   *   body: form-data  field=file  query?field=avatar|qrcode（可选，前端决定挂哪个字段）
   *   返回：{ url: '/uploads/sales/xxx.jpg' }
   */
  app.post('/api/app/sales/upload', requireAuth, salesUpload.single('file'), async (req: AuthRequest, res) => {
    const file = (req as any).file
    if (!file) return res.status(400).json({ error: '请选择图片文件' })
    // 放行：admin / 历史 role='sales' / 新角色系统挂"销售"内置角色（与 detectSalesSignal 三信号对齐）
    const user = await prisma.appUser.findUnique({ where: { id: req.userId! } })
    const hasSales = user ? await detectSalesSignal(req.userId!, user.role) : false
    if (!user || (user.role !== 'admin' && !hasSales)) {
      // 已落盘的文件删掉，避免孤儿
      try { (await import('fs/promises')).unlink(file.path) } catch {}
      return res.status(403).json({ error: '无权上传' })
    }
    const url = `/uploads/sales/${file.filename}`
    res.json({ url, filename: file.filename })
  })

  /**
   * GET /api/app/sales/products — 可展示产品列表（给销售端选择用）
   */
  app.get('/api/app/sales/products', requireAuth, async (_req, res) => {
    res.json({ products: SALES_PRODUCTS })
  })

  // ═════════════════════════════════════════════════════════
  // ② 公开落地页
  // ═════════════════════════════════════════════════════════

  /**
   * GET /api/app/s/:salesCode — 公开展示销售信息和产品卡片
   *   - salesCode 不存在或 DISABLED 返回 404 + { status: 'DISABLED' | 'NOT_FOUND' }
   *   - 不返回 userId、phone 明文（contact 内的 phone 直接返回，由销售自愿公开）
   */
  app.get('/api/app/s/:salesCode', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const salesCode = String(req.params.salesCode || '').trim()
    if (!salesCode || salesCode.length > 16) {
      return res.status(400).json({ error: '参数错误' })
    }
    const profile = await prisma.salesProfile.findUnique({ where: { salesCode } })
    if (!profile) return res.status(404).json({ error: '该推广链接不存在', status: 'NOT_FOUND' })
    if (profile.status === 'DISABLED') return res.status(410).json({ error: '该推广链接已失效', status: 'DISABLED' })
    res.json(serializePublicProfile(profile))
  })

  // ═════════════════════════════════════════════════════════
  // ③ 管理后台
  // ═════════════════════════════════════════════════════════

  const createSalesSchema = z.object({
    // 必填：销售账号（一起新建 AppUser；手机号已注册时 password 可不传，系统升级角色）
    phone: z.string().regex(/^1[3-9]\d{9}$/, '请输入有效手机号'),
    password: z.string().min(6).max(64).optional(),
    realName: z.string().min(1).max(30),
    // 可选 profile 字段
    companyName: z.string().max(60).optional(),
    positionTitle: z.string().max(40).optional(),
    avatar: z.string().max(300).optional(),
    bio: z.string().max(300).optional(),
    wechat: z.string().max(50).optional(),
    contactPhone: z.string().max(20).optional(),  // 对外展示用的 phone，可与登录 phone 不同
    qrcode: z.string().max(300).optional(),
    contactVisible: z.boolean().optional(),
    displayProducts: z.array(z.object({ code: z.string(), sort: z.number().int() })).max(4).optional(),
  })

  /**
   * POST /api/admin/sales — 新增销售（同时建 AppUser + SalesProfile）
   */
  app.post('/api/admin/sales', requireAdmin, async (req: AuthRequest, res) => {
    const parsed = createSalesSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })

    const { phone, password, realName, companyName, positionTitle, avatar, bio, wechat, contactPhone, qrcode, contactVisible, displayProducts } = parsed.data

    // displayProducts 校验（公共逻辑，两条分支都用）
    let displayProductsJson: string = DEFAULT_DISPLAY_PRODUCTS_JSON
    if (displayProducts && displayProducts.length > 0) {
      try {
        displayProductsJson = JSON.stringify(validateDisplayProducts(displayProducts))
      } catch (err: any) {
        return res.status(400).json({ error: err.message })
      }
    }

    // ── 检查手机号是否已注册 ──────────────────────────────────
    const existing = await prisma.appUser.findUnique({ where: { phone } })

    if (existing) {
      // 已有 SalesProfile → 不允许重复绑定
      const existingProfile = await prisma.salesProfile.findUnique({ where: { userId: existing.id } })
      if (existingProfile) return res.status(409).json({ error: '该手机号已配置销售主页' })

      // admin 账号不允许降级为销售
      if (existing.role === 'admin') return res.status(409).json({ error: '该手机号是管理员账号，不可转为销售' })

      // 存在普通用户 → 升级角色、创建 SalesProfile
      const salesCode = await allocateUniqueSalesCode()
      if (!salesCode) return res.status(500).json({ error: '生成 salesCode 失败，请重试' })

      const result = await prisma.$transaction(async (tx) => {
        await tx.appUser.update({
          where: { id: existing.id },
          data: { role: 'sales', name: realName },
        })
        const profile = await tx.salesProfile.create({
          data: {
            salesCode,
            userId: existing.id,
            realName,
            companyName: companyName || DEFAULT_COMPANY_NAME,
            positionTitle,
            avatar,
            bio,
            wechat,
            phone: contactPhone || phone,
            qrcode,
            contactVisible: contactVisible ?? true,
            displayProducts: displayProductsJson,
            status: 'ENABLED',
          },
        })
        await tx.salesCode.create({
          data: { salesCode, profileId: profile.id, label: '主码', status: 'ACTIVE' },
        })
        return profile
      })

      logger.info({ module: 'sales', action: 'upgrade', adminId: req.userId, salesCode, userId: existing.id }, '已有用户升级为销售')
      return res.status(201).json({
        ...serializePrivateProfile(result),
        loginPhone: phone,
        note: '已有账号已升级为销售角色，原密码不变',
      })
    }

    // ── 全新用户 → 必须提供密码 ──────────────────────────────
    if (!password) return res.status(400).json({ error: '新用户必须设置初始密码' })

    const salesCode = await allocateUniqueSalesCode()
    if (!salesCode) return res.status(500).json({ error: '生成 salesCode 失败，请重试' })

    const pwHash = await hashPassword(password)
    const userId = createId()

    // 事务：创建销售账号 + profile
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.appUser.create({
        data: {
          id: userId,
          phone,
          passwordHash: pwHash,
          name: realName,
          role: 'sales',
        },
      })
      const profile = await tx.salesProfile.create({
        data: {
          salesCode,
          userId: user.id,
          realName,
          companyName: companyName || DEFAULT_COMPANY_NAME,
          positionTitle,
          avatar,
          bio,
          wechat,
          phone: contactPhone || phone,
          qrcode,
          contactVisible: contactVisible ?? true,
          displayProducts: displayProductsJson,
          status: 'ENABLED',
        },
      })
      await tx.salesCode.create({
        data: { salesCode, profileId: profile.id, label: '主码', status: 'ACTIVE' },
      })
      return { user, profile }
    })

    logger.info({ module: 'sales', action: 'create', adminId: req.userId, salesCode, userId: result.user.id }, '销售主页新建')
    res.status(201).json({
      ...serializePrivateProfile(result.profile),
      loginPhone: phone,
    })
  })

  // ── POST /api/admin/sales/import — CSV 批量导入
  // 字段：手机号(phone), 姓名(name)，其他列忽略。表头中英文均接受。
  const importUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  })
  app.post('/api/admin/sales/import', requireAdmin, importUpload.single('file'), async (req: AuthRequest, res) => {
    const file = (req as any).file
    if (!file) return res.status(400).json({ error: '请上传 CSV 文件' })

    // 解析 CSV（支持带 BOM 的 utf-8，常见于 Excel 导出）
    let rows: Record<string, string>[] = []
    try {
      const text = file.buffer.toString('utf8').replace(/^﻿/, '')
      rows = csvParse(text, { columns: true, skip_empty_lines: true, trim: true })
    } catch (e: any) {
      return res.status(400).json({ error: `CSV 解析失败: ${e.message}` })
    }
    if (rows.length === 0) return res.status(400).json({ error: 'CSV 没有有效数据行' })
    if (rows.length > 500) return res.status(400).json({ error: '单次最多导入 500 条，请拆批' })

    const pwHash = await hashPassword(DEFAULT_IMPORT_PASSWORD)

    const results = {
      total: rows.length,
      success: 0,
      skipped: 0,
      failed: 0,
      details: [] as Array<{ row: number; phone?: string; status: 'SUCCESS' | 'SKIPPED' | 'FAILED'; salesCode?: string; reason?: string }>,
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const rowNo = i + 2 // +1 表头 +1 转 1-based

      // 列名兼容：中文 "手机号/姓名" + 英文 "phone/name"
      const phone = String(row['手机号'] ?? row['phone'] ?? row['Phone'] ?? '').trim()
      const name = String(row['姓名'] ?? row['name'] ?? row['Name'] ?? row['realName'] ?? '').trim()

      if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
        results.failed++
        results.details.push({ row: rowNo, phone, status: 'FAILED', reason: '手机号格式无效' })
        continue
      }
      if (!name || name.length > 30) {
        results.failed++
        results.details.push({ row: rowNo, phone, status: 'FAILED', reason: '姓名为空或超长' })
        continue
      }

      // phone 已存在 → 跳过（不报错，按 PRD 要求）
      const existing = await prisma.appUser.findUnique({ where: { phone } })
      if (existing) {
        results.skipped++
        results.details.push({ row: rowNo, phone, status: 'SKIPPED', reason: '手机号已注册' })
        continue
      }

      // 生成 salesCode
      const salesCode = await allocateUniqueSalesCode()
      if (!salesCode) {
        results.failed++
        results.details.push({ row: rowNo, phone, status: 'FAILED', reason: 'salesCode 生成失败' })
        continue
      }

      try {
        await prisma.$transaction(async (tx) => {
          const user = await tx.appUser.create({
            data: {
              id: createId(),
              phone,
              passwordHash: pwHash,
              name,
              role: 'sales',
            },
          })
          const createdProfile = await tx.salesProfile.create({
            data: {
              salesCode,
              userId: user.id,
              realName: name,
              companyName: DEFAULT_COMPANY_NAME,
              phone,
              displayProducts: DEFAULT_DISPLAY_PRODUCTS_JSON,
              status: 'ENABLED',
            },
          })
          await tx.salesCode.create({
            data: { salesCode, profileId: createdProfile.id, label: '主码', status: 'ACTIVE' },
          })
        })
        results.success++
        results.details.push({ row: rowNo, phone, status: 'SUCCESS', salesCode })
      } catch (e: any) {
        results.failed++
        results.details.push({ row: rowNo, phone, status: 'FAILED', reason: e.message || '写入失败' })
      }
    }

    logger.info({
      module: 'sales', action: 'import', adminId: req.userId,
      total: results.total, success: results.success, skipped: results.skipped, failed: results.failed,
    }, '销售批量导入')

    res.json({
      ...results,
      defaultPassword: DEFAULT_IMPORT_PASSWORD,
      hint: `导入的销售初始密码为 ${DEFAULT_IMPORT_PASSWORD}，请通知销售尽快修改`,
    })
  })

  // ── GET /api/admin/sales/template — 下载 CSV 模板
  app.get('/api/admin/sales/template', requireAdmin, (_req: AuthRequest, res) => {
    // BOM + utf-8 头，Excel 打开中文不乱码
    const csv = '﻿手机号,姓名\n13800138001,张三\n13800138002,李四\n'
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename=sales_import_template.csv')
    res.send(csv)
  })

  /** GET /api/admin/sales/check-phone — 创建表单 phone 实时检查
   *  ⚠️ 必须在 /api/admin/sales/:id 之前注册（Express 按顺序匹配，否则 :id 会吃掉 check-phone）
   */
  app.get('/api/admin/sales/check-phone', requireAdmin, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const phone = String(req.query.phone || '').trim()
    if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式错误' })
    const user = await prisma.appUser.findUnique({ where: { phone } })
    if (!user) return res.json({ exists: false, role: null, hasSalesProfile: false })
    const profile = await prisma.salesProfile.findFirst({ where: { userId: user.id, deletedAt: null } })
    return res.json({ exists: true, role: user.role, hasSalesProfile: !!profile })
  })

  /**
   * GET /api/admin/sales — 列表 + 统计
   *   query: status?, keyword? (match realName/phone/salesCode), page, pageSize
   *   返回：{ total, items: [{ ...profile, stats: { registerCount, paidCount, paidAmount, lastRegisterAt, lastPaidAt } }] }
   */
  app.get('/api/admin/sales', requireAdmin, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const { status, keyword, page = '1', pageSize = '20' } = req.query as any
    const where: any = { deletedAt: null }   // 软删除的销售不出现在列表
    if (status && ['ENABLED', 'DISABLED'].includes(status)) where.status = status
    if (keyword) {
      where.OR = [
        { realName: { contains: String(keyword) } },
        { salesCode: { contains: String(keyword) } },
        { phone: { contains: String(keyword) } },
      ]
    }
    const skip = (Number(page) - 1) * Number(pageSize)
    const [total, items] = await Promise.all([
      prisma.salesProfile.count({ where }),
      prisma.salesProfile.findMany({
        where, skip, take: Number(pageSize),
        orderBy: { createdAt: 'desc' },
      }),
    ])

    // 统计 — 批量查，避免 N+1
    const codes = items.map(i => i.salesCode)
    const [regRows, paidRows] = await Promise.all([
      codes.length === 0 ? [] : prisma.appUser.groupBy({
        by: ['salesCode'],
        where: { salesCode: { in: codes } },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      codes.length === 0 ? [] : prisma.appOrder.groupBy({
        by: ['salesCode'],
        where: { salesCode: { in: codes }, status: 'PAID' },
        _count: { userId: true },
        _sum: { amount: true },
        _max: { paidAt: true },
      }),
    ])

    // 付费人数需要去重（同一用户多单只算 1 人）
    const paidUserSetMap = codes.length === 0 ? new Map<string, Set<string>>() : await (async () => {
      const rows = await prisma.appOrder.findMany({
        where: { salesCode: { in: codes }, status: 'PAID' },
        select: { salesCode: true, userId: true },
      })
      const m = new Map<string, Set<string>>()
      for (const r of rows) {
        if (!r.salesCode || !r.userId) continue
        if (!m.has(r.salesCode)) m.set(r.salesCode, new Set())
        m.get(r.salesCode)!.add(r.userId)
      }
      return m
    })()

    const regMap = new Map(regRows.map(r => [r.salesCode!, r]))
    const paidMap = new Map(paidRows.map(r => [r.salesCode!, r]))

    const enriched = items.map(item => ({
      ...serializePrivateProfile(item),
      stats: {
        registerCount: regMap.get(item.salesCode)?._count._all || 0,
        paidCount: paidUserSetMap.get(item.salesCode)?.size || 0,
        paidAmount: paidMap.get(item.salesCode)?._sum.amount || 0,
        lastRegisterAt: regMap.get(item.salesCode)?._max.createdAt || null,
        lastPaidAt: paidMap.get(item.salesCode)?._max.paidAt || null,
      },
    }))

    res.json({ total, page: Number(page), pageSize: Number(pageSize), items: enriched })
  })

  /**
   * GET /api/admin/sales/overview — 销售数据看板（admin / superAdmin only）
   *   返回 { summary: {totalRegistered, totalPaidUsers, totalPaidAmount}, items: [...] }
   *   ⚠️ 必须在 /api/admin/sales/:id 之前注册,否则 'overview' 字面量被 :id 匹配吞掉
   *   数据口径与 GET /api/admin/sales 一致(避免两套口径漂移)
   *   commission 字段 schema 不存在,本期不返回
   */
  app.get('/api/admin/sales/overview', requireAdmin, async (_req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')

    // 1) 拉所有非软删销售（暂不分页，看板就是看全量）
    const profiles = await prisma.salesProfile.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, salesCode: true, realName: true, status: true, isPublic: true, companyName: true },
    })

    if (profiles.length === 0) {
      return res.json({
        summary: { totalRegistered: 0, totalPaidUsers: 0, totalPaidAmount: 0, salesCount: 0 },
        items: [],
      })
    }

    const codes = profiles.map(p => p.salesCode)

    // 2) 批量统计（与 /api/admin/sales 同口径）
    const [regRows, paidGroupRows, paidUserRows] = await Promise.all([
      prisma.appUser.groupBy({
        by: ['salesCode'],
        where: { salesCode: { in: codes } },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      prisma.appOrder.groupBy({
        by: ['salesCode'],
        where: { salesCode: { in: codes }, status: 'PAID' },
        _sum: { amount: true },
        _max: { paidAt: true },
      }),
      // 付费人数去重需要逐行
      prisma.appOrder.findMany({
        where: { salesCode: { in: codes }, status: 'PAID' },
        select: { salesCode: true, userId: true },
      }),
    ])

    const paidUserSetMap = new Map<string, Set<string>>()
    for (const r of paidUserRows) {
      if (!r.salesCode || !r.userId) continue
      if (!paidUserSetMap.has(r.salesCode)) paidUserSetMap.set(r.salesCode, new Set())
      paidUserSetMap.get(r.salesCode)!.add(r.userId)
    }

    const regMap = new Map(regRows.map(r => [r.salesCode!, r]))
    const paidMap = new Map(paidGroupRows.map(r => [r.salesCode!, r]))

    const items = profiles.map(p => ({
      profileId: p.id,
      salesCode: p.salesCode,
      realName: p.realName,
      companyName: p.companyName,
      status: p.status,
      isPublic: p.isPublic,
      registerCount: regMap.get(p.salesCode)?._count._all || 0,
      paidUserCount: paidUserSetMap.get(p.salesCode)?.size || 0,
      paidAmount: paidMap.get(p.salesCode)?._sum.amount || 0,
      lastRegisterAt: regMap.get(p.salesCode)?._max.createdAt || null,
      lastPaidAt: paidMap.get(p.salesCode)?._max.paidAt || null,
    }))

    // 3) 顶部汇总
    let totalRegistered = 0
    let totalPaidAmount = 0
    const allPaidUsers = new Set<string>()
    for (const it of items) {
      totalRegistered += it.registerCount
      totalPaidAmount += it.paidAmount
    }
    for (const set of paidUserSetMap.values()) {
      for (const uid of set) allPaidUsers.add(uid)
    }

    res.json({
      summary: {
        salesCount: profiles.length,
        totalRegistered,
        totalPaidUsers: allPaidUsers.size,
        totalPaidAmount,
        // 佣金字段 schema 缺失,前端展示"暂未配置"
      },
      items,
    })
  })

  /**
   * GET /api/admin/sales/overview/:salesCode/orders — 看板里点"查看订单明细"
   *   返回该销售名下所有 PAID 订单（admin only,只读）
   */
  app.get('/api/admin/sales/overview/:salesCode/orders', requireAdmin, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const salesCode = String(req.params.salesCode || '').trim()
    if (!salesCode) return res.status(400).json({ error: 'salesCode 必填' })

    const profile = await prisma.salesProfile.findUnique({ where: { salesCode }, select: { id: true, realName: true } })
    if (!profile) return res.status(404).json({ error: '销售不存在' })

    const orders = await prisma.appOrder.findMany({
      where: { salesCode, status: 'PAID' },
      select: {
        orderNo: true, productType: true, title: true, amount: true,
        userId: true, paidAt: true, createdAt: true,
        user: { select: { phone: true, name: true } },
      },
      orderBy: { paidAt: 'desc' },
      take: 500,
    })

    res.json({ profileId: profile.id, realName: profile.realName, items: orders })
  })

  /**
   * GET /api/admin/sales/:id — 单条详情 + 统计
   */
  app.get('/api/admin/sales/:id', requireAdmin, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const profile = await prisma.salesProfile.findUnique({ where: { id: String(req.params.id) } })
    if (!profile) return res.status(404).json({ error: '销售不存在' })

    const [regCount, regLatest, paidAgg, paidUsersRaw] = await Promise.all([
      prisma.appUser.count({ where: { salesCode: profile.salesCode } }),
      prisma.appUser.findFirst({ where: { salesCode: profile.salesCode }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      prisma.appOrder.aggregate({
        where: { salesCode: profile.salesCode, status: 'PAID' },
        _sum: { amount: true },
        _max: { paidAt: true },
      }),
      prisma.appOrder.findMany({
        where: { salesCode: profile.salesCode, status: 'PAID' },
        select: { userId: true },
      }),
    ])
    const paidUserSet = new Set(paidUsersRaw.map(o => o.userId).filter(Boolean) as string[])

    res.json({
      ...serializePrivateProfile(profile),
      loginPhone: (await prisma.appUser.findUnique({ where: { id: profile.userId }, select: { phone: true } }))?.phone,
      stats: {
        registerCount: regCount,
        paidCount: paidUserSet.size,
        paidAmount: paidAgg._sum.amount || 0,
        lastRegisterAt: regLatest?.createdAt || null,
        lastPaidAt: paidAgg._max.paidAt || null,
      },
    })
  })

  /**
   * PUT /api/admin/sales/:id — 管理员编辑销售主页（任意 profile 字段）
   */
  app.put('/api/admin/sales/:id', requireAdmin, async (req: AuthRequest, res) => {
    const parsed = profileEditableSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })

    const profile = await prisma.salesProfile.findUnique({ where: { id: String(req.params.id) } })
    if (!profile) return res.status(404).json({ error: '销售不存在' })

    const data: any = { ...parsed.data }
    if (parsed.data.displayProducts) {
      try {
        data.displayProducts = JSON.stringify(validateDisplayProducts(parsed.data.displayProducts))
      } catch (err: any) {
        return res.status(400).json({ error: err.message })
      }
    }

    const updated = await prisma.salesProfile.update({ where: { id: profile.id }, data })
    logger.info({ module: 'sales', action: 'admin_update', adminId: req.userId, salesId: profile.id }, '销售主页管理员编辑')
    res.json(serializePrivateProfile(updated))
  })

  /**
   * PATCH /api/admin/sales/:id/status — 启用 / 停用
   */
  app.patch('/api/admin/sales/:id/status', requireAdmin, async (req: AuthRequest, res) => {
    const schema = z.object({ status: z.enum(['ENABLED', 'DISABLED']) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: '参数错误' })

    const profile = await prisma.salesProfile.findUnique({ where: { id: String(req.params.id) } })
    if (!profile) return res.status(404).json({ error: '销售不存在' })

    const updated = await prisma.salesProfile.update({
      where: { id: profile.id },
      data: { status: parsed.data.status },
    })
    logger.info({ module: 'sales', action: 'status_change', adminId: req.userId, salesId: profile.id, status: parsed.data.status }, '销售状态调整')
    res.json({ id: updated.id, status: updated.status })
  })

  /**
   * DELETE /api/admin/sales/:id — 删除销售
   *   - 有归因注册用户或订单时拒绝删除（数据不可失联），改为停用
   *   - 删除：SalesCode 记录 → SalesProfile → AppUser 降级回 user 角色
   */
  app.delete('/api/admin/sales/:id', requireAdmin, async (req: AuthRequest, res) => {
    const profile = await prisma.salesProfile.findUnique({ where: { id: String(req.params.id) } })
    if (!profile) return res.status(404).json({ error: '销售不存在' })
    if (profile.deletedAt) return res.status(404).json({ error: '销售已删除' })

    const [regCount, orderCount] = await Promise.all([
      prisma.appUser.count({ where: { salesCode: profile.salesCode } }),
      prisma.appOrder.count({ where: { salesCode: profile.salesCode } }),
    ])

    if (regCount > 0 || orderCount > 0) {
      // 软删除：有归因数据，保留 SalesProfile 行供历史查询，但停用 + 标记 deletedAt
      await prisma.salesProfile.update({
        where: { id: profile.id },
        data: { deletedAt: new Date(), status: 'DISABLED' },
      })
      logger.info({ module: 'sales', action: 'soft-delete', adminId: req.userId, salesId: profile.id, salesCode: profile.salesCode, regCount, orderCount }, '销售软删除（有业务数据）')
      return res.json({ success: true, mode: 'soft', regCount, orderCount })
    }

    // 物理删除：无归因数据
    await prisma.$transaction(async (tx) => {
      await tx.salesCode.deleteMany({ where: { profileId: profile.id } })
      await tx.salesProfile.delete({ where: { id: profile.id } })
      await tx.appUser.update({ where: { id: profile.userId }, data: { role: 'user' } })
    })

    logger.info({ module: 'sales', action: 'hard-delete', adminId: req.userId, salesId: profile.id, salesCode: profile.salesCode }, '销售物理删除（无业务数据）')
    res.json({ success: true, mode: 'hard' })
  })

  // ═════════════════════════════════════════════════════════
  // 新增：销售归因明细（check-phone 因路由顺序原因移到 list 之前注册）
  // ═════════════════════════════════════════════════════════

  /** GET /api/admin/sales/:id/registrations — 归因注册用户列表（分页） */
  app.get('/api/admin/sales/:id/registrations', requireAdmin, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const profile = await prisma.salesProfile.findUnique({ where: { id: String(req.params.id) } })
    if (!profile) return res.status(404).json({ error: '销售不存在' })

    const { page = '1', pageSize = '20' } = req.query as any
    const skip = (Number(page) - 1) * Number(pageSize)

    const [total, users] = await Promise.all([
      prisma.appUser.count({ where: { salesCode: profile.salesCode } }),
      prisma.appUser.findMany({
        where: { salesCode: profile.salesCode },
        skip, take: Number(pageSize),
        orderBy: { createdAt: 'desc' },
        select: { id: true, phone: true, createdAt: true },
      }),
    ])

    // 标记 hasPaid（批量查 PAID 订单）
    const userIds = users.map(u => u.id)
    const paidUserSet = userIds.length === 0 ? new Set<string>() : new Set(
      (await prisma.appOrder.findMany({
        where: { userId: { in: userIds }, status: 'PAID' },
        select: { userId: true },
      })).map((o: any) => o.userId)
    )

    res.json({
      total,
      page: Number(page),
      pageSize: Number(pageSize),
      items: users.map(u => ({
        id: u.id,
        phone: u.phone ? maskPhone(u.phone) : null,
        createdAt: u.createdAt,
        hasPaid: paidUserSet.has(u.id),
      })),
    })
  })

  /** GET /api/admin/sales/:id/orders — 归因订单列表（分页） */
  app.get('/api/admin/sales/:id/orders', requireAdmin, async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store')
    const profile = await prisma.salesProfile.findUnique({ where: { id: String(req.params.id) } })
    if (!profile) return res.status(404).json({ error: '销售不存在' })

    const { page = '1', pageSize = '20' } = req.query as any
    const skip = (Number(page) - 1) * Number(pageSize)

    const [total, orders] = await Promise.all([
      prisma.appOrder.count({ where: { salesCode: profile.salesCode, status: 'PAID' } }),
      prisma.appOrder.findMany({
        where: { salesCode: profile.salesCode, status: 'PAID' },
        skip, take: Number(pageSize),
        orderBy: { paidAt: 'desc' },
        include: {
          user: { select: { phone: true } },
          plan: { select: { name: true } },
        },
      }),
    ])

    res.json({
      total,
      page: Number(page),
      pageSize: Number(pageSize),
      items: orders.map(o => ({
        orderNo: o.orderNo,
        phone: o.user?.phone ? maskPhone(o.user.phone) : null,
        planName: o.plan?.name || o.title,
        amount: o.amount,
        paidAt: o.paidAt,
      })),
    })
  })
}
