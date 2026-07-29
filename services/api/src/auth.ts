/**
 * 真实认证模块：手机号+密码注册/登录，bcrypt + JWT
 */
import crypto from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import { prisma } from './db'

// ─── bcrypt-like hashing（纯 Node.js，不依赖 native addon）─────
// 使用 scrypt 作为密码 hash，避免 bcryptjs 在某些环境下的兼容性问题

const SALT_LEN = 16
const KEY_LEN = 64

export async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SALT_LEN).toString('hex')
    crypto.scrypt(password, salt, KEY_LEN, (err, derived) => {
      if (err) reject(err)
      else resolve(`${salt}:${derived.toString('hex')}`)
    })
  })
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [salt, key] = hash.split(':')
    if (!salt || !key) return resolve(false)
    crypto.scrypt(password, salt, KEY_LEN, (err, derived) => {
      if (err) reject(err)
      else resolve(crypto.timingSafeEqual(Buffer.from(key, 'hex'), derived))
    })
  })
}

// ─── JWT（纯 Node.js HMAC-SHA256 实现）───────────────────────

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET 环境变量未设置，拒绝启动。请在 .env 中配置 JWT_SECRET')
}
const JWT_SECRET: string = process.env.JWT_SECRET
const JWT_EXPIRES_IN = 7 * 24 * 60 * 60 // 7 days in seconds

function base64url(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data
  return buf.toString('base64url')
}

function base64urlDecode(s: string): string {
  return Buffer.from(s, 'base64url').toString()
}

interface JwtPayload {
  sub: string       // user id
  phone?: string    // 手机号（手机注册用户）
  email?: string    // 邮箱（邮箱注册用户）
  role: string
  enterpriseId?: string | null    // 企业成员所属企业（多租户隔离 key）
  enterpriseRole?: string | null  // ADMIN | MANAGER | REVIEWER | EMPLOYEE
  iat: number
  exp: number
}

export function signJwt(payload: { sub: string; phone?: string | null; email?: string | null; role: string; enterpriseId?: string | null; enterpriseRole?: string | null }): string {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const claims: Record<string, unknown> = {
    sub: payload.sub,
    role: payload.role,
    iat: now,
    exp: now + JWT_EXPIRES_IN,
  }
  if (payload.phone) claims.phone = payload.phone
  if (payload.email) claims.email = payload.email
  if (payload.enterpriseId) claims.enterpriseId = payload.enterpriseId
  if (payload.enterpriseRole) claims.enterpriseRole = payload.enterpriseRole
  const body = base64url(JSON.stringify(claims))
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url')
  return `${header}.${body}.${signature}`
}

export function verifyJwt(token: string): JwtPayload | null {
  try {
    const [header, body, sig] = token.split('.')
    if (!header || !body || !sig) return null

    const expected = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${header}.${body}`)
      .digest('base64url')

    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null

    const payload = JSON.parse(base64urlDecode(body)) as JwtPayload
    if (payload.exp < Math.floor(Date.now() / 1000)) return null

    return payload
  } catch {
    return null
  }
}

// ─── Express 中间件 ──────────────────────────────────────────

export interface AuthRequest extends Request {
  userId?: string
  userPhone?: string
  userEmail?: string
  userRole?: string
  userEnterpriseId?: string | null
  userEnterpriseRole?: string | null
}

/**
 * JWT 鉴权中间件 —— 必须登录
 *
 * isBlocked 拦截：role !== 'admin' 的用户每次受保护请求都 select isBlocked，
 * 命中 true 返回 403。admin 豁免，避免管理员锁死自己 + 跳过额外 DB 查询。
 */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录' })
  }
  const token = authHeader.slice(7)
  const payload = verifyJwt(token)
  if (!payload) {
    return res.status(401).json({ error: '登录已过期，请重新登录' })
  }
  req.userId = payload.sub
  req.userPhone = payload.phone
  req.userEmail = payload.email
  req.userRole = payload.role
  req.userEnterpriseId = payload.enterpriseId ?? null
  req.userEnterpriseRole = payload.enterpriseRole ?? null
  if (payload.role === 'admin') return next()
  prisma.appUser.findUnique({ where: { id: payload.sub }, select: { isBlocked: true } })
    .then((u) => {
      if (u?.isBlocked) return res.status(403).json({ error: '账号已被禁用' })
      next()
    })
    .catch((err) => {
      console.error('[requireAuth] DB error:', err)
      return res.status(500).json({ error: '鉴权失败' })
    })
}

/**
 * 可选鉴权 —— 有 token 就解析，没有也放行
 */
export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const payload = verifyJwt(token)
    if (payload) {
      req.userId = payload.sub
      req.userPhone = payload.phone
      req.userEmail = payload.email
      req.userRole = payload.role
      req.userEnterpriseId = payload.enterpriseId ?? null
      req.userEnterpriseRole = payload.enterpriseRole ?? null
    }
  }
  next()
}

/**
 * 管理员鉴权
 */
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ error: '需要管理员权限' })
    }
    next()
  })
}

/**
 * 销售鉴权（sales 或 admin 直接放行；
 * role='user' 的 RBAC 批量分配销售角色用户通过 AdminUserRole 动态检查放行）
 */
export function requireSales(req: AuthRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, async () => {
    // 快路径：JWT role 直接匹配
    if (req.userRole === 'sales' || req.userRole === 'admin') return next()
    // RBAC fallback：查 AdminUserRole 是否含"销售"内置角色
    try {
      const grant = await prisma.adminUserRole.findFirst({
        where: {
          userId: req.userId!,
          status: 'ACTIVE',
          role: { name: '销售', status: 'ACTIVE' },
        },
      })
      if (grant) return next()
    } catch {
      // DB 查询异常：降级拒绝，不暴露内部错误
    }
    return res.status(403).json({ error: '需要销售权限' })
  })
}

/**
 * 操作权限鉴权（按 RBAC actionPermissions key）。
 *
 * - role === 'admin'：超管直接放行
 * - 其它：查 AdminUserRole（status=ACTIVE）合并所有角色的 actionPermissions，命中 permKey 才放行
 *
 * 第一版仅在新接口上挂载，不影响现有 requireAdmin / requireSales 的兜底语义。
 */
export function requirePermission(permKey: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    requireAuth(req, res, async () => {
      try {
        if (req.userRole === 'admin') return next()
        const { prisma } = await import('./db')
        const userRoles = await prisma.adminUserRole.findMany({
          where: { userId: req.userId!, status: 'ACTIVE' },
          include: { role: true },
        })
        const allActions = userRoles
          .filter((ur: any) => ur.role && ur.role.status === 'ACTIVE')
          .flatMap((ur: any) => Array.isArray(ur.role.actionPermissions) ? (ur.role.actionPermissions as string[]) : [])
        if (!allActions.includes(permKey)) {
          return res.status(403).json({ error: '无操作权限' })
        }
        next()
      } catch (e: any) {
        return res.status(500).json({ error: '权限校验失败' })
      }
    })
  }
}
