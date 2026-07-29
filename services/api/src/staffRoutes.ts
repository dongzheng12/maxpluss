/**
 * 后台管理人员管理 + 当前用户权限查询
 *
 * 包含 8 个接口：
 *   GET    /api/admin/me/permissions          - 当前用户后台权限（requireAuth）
 *   GET    /api/admin/staff                   - 管理人员列表（admin + sales + has AdminUserRole 的 user）
 *   GET    /api/admin/staff/search?phone=     - 按手机号查 AppUser（用于添加时查找）
 *   POST   /api/admin/staff/set-admin         - 提升为超管（phone → role:admin）
 *   DELETE /api/admin/staff/:id/unset-admin   - 移除超管（role:admin → user）
 *   POST   /api/admin/staff/:id/set-sales     - 设为销售（含 SalesProfile + 主推码）
 *   PATCH  /api/admin/staff/:id/roles         - 分配/撤销 AdminUserRole
 *   PATCH  /api/admin/staff/:id/toggle        - 停用/启用 AdminUserRole.status
 */
import type { Express, Response } from 'express'
import { z } from 'zod'
import { prisma } from './db'
import { hashPassword, requireAdmin, requireAuth, type AuthRequest } from './auth'
import { ensureSalesProfileAndPrimaryCode } from './services/salesIdentity'
import { ensureSalesBuiltInRole } from './services/builtInRoles'

// 后台首页路径（任何有 admin 访问权限的用户都能看到）
const ADMIN_HOME_PATH = '/admin'
// 销售工作台核心路径（v3 销售三信号任一为真都需要叠加这个菜单）
const SALES_CORE_MENU_PATH = '/admin/sales/workspace'

export function registerStaffRoutes(app: Express) {
  // ─── 当前用户后台权限（requireAuth，所有已登录用户都可查） ───────
  app.get('/api/admin/me/permissions', requireAuth, async (req: AuthRequest, res: Response) => {
    const role = req.userRole
    if (role === 'admin') {
      return res.json({
        hasAdminAccess: true,
        isAdmin: true,
        isSales: false,
        isStaff: false,
        menuPaths: ['*'], // 通配符 = 全部菜单
        actionKeys: ['*'],
      })
    }

    // v3 §5：销售三信号（任一为真即视为销售）
    //   1. 历史 AppUser.role === 'sales'
    //   2. 持有 ACTIVE AdminUserRole 关联到 ACTIVE "销售"内置角色
    //   3. SalesProfile 存在且 status != 'DISABLED'
    const isSalesByRole = (role === 'sales')

    // 同时拉 ACTIVE AdminUserRole 详情 + SalesProfile（一次往返）
    const [userRoles, salesProfile] = await Promise.all([
      prisma.adminUserRole.findMany({
        where: { userId: req.userId!, status: 'ACTIVE' },
        include: { role: true },
      }),
      prisma.salesProfile.findUnique({ where: { userId: req.userId! } }),
    ])

    const activeRoles = userRoles.filter((ur: any) => ur.role && ur.role.status === 'ACTIVE')
    const isSalesByGrant = activeRoles.some((ur: any) => ur.role.name === '销售')
    const isSalesByProfile = !!salesProfile && salesProfile.status !== 'DISABLED'
    const isSales = isSalesByRole || isSalesByGrant || isSalesByProfile

    // 合并所有 ACTIVE AdminUserRole 的 menu / action
    const menuPathsSet = new Set<string>()
    const actionKeysSet = new Set<string>()
    for (const ur of activeRoles) {
      const mp = (ur as any).role.menuPermissions
      const ak = (ur as any).role.actionPermissions
      if (Array.isArray(mp)) for (const p of mp) menuPathsSet.add(p)
      if (Array.isArray(ak)) for (const k of ak) actionKeysSet.add(k)
    }

    // 销售三信号：补 admin 首页 + 销售工作台核心菜单
    if (isSales) {
      menuPathsSet.add(ADMIN_HOME_PATH)
      menuPathsSet.add(SALES_CORE_MENU_PATH)
    }

    const menuPaths = Array.from(menuPathsSet)
    const actionKeys = Array.from(actionKeysSet)
    const isStaff = activeRoles.length > 0 && !isSalesByRole // role=sales 历史用户不算 staff
    const hasAdminAccess = menuPaths.length > 0

    res.json({
      hasAdminAccess,
      isAdmin: false,
      isSales,
      isStaff,
      menuPaths,
      actionKeys,
    })
  })

  // ─── 管理人员列表（admin + sales + has AdminUserRole 的 user） ───
  app.get('/api/admin/staff', requireAdmin, async (_req: AuthRequest, res: Response) => {
    // 1) admin 与 sales 系统身份
    const sysStaff = await prisma.appUser.findMany({
      where: { role: { in: ['admin', 'sales'] } },
      select: { id: true, phone: true, name: true, role: true, createdAt: true,
                salesProfile: { select: { salesCode: true, status: true } } },
      orderBy: { createdAt: 'desc' },
    })
    // 2) role=user 但有 AdminUserRole 的（去重）
    const staffUserIds = await prisma.adminUserRole.findMany({
      distinct: ['userId'],
      select: { userId: true },
    })
    const staffUsers = staffUserIds.length === 0 ? [] : await prisma.appUser.findMany({
      where: { id: { in: staffUserIds.map((s: any) => s.userId) }, role: 'user' },
      select: { id: true, phone: true, name: true, role: true, createdAt: true,
                salesProfile: { select: { salesCode: true, status: true } } },
      orderBy: { createdAt: 'desc' },
    })
    // 3) 为所有人查 adminRoles 详情
    const allIds = [...sysStaff.map((u: any) => u.id), ...staffUsers.map((u: any) => u.id)]
    const allRoles = allIds.length === 0 ? [] : await prisma.adminUserRole.findMany({
      where: { userId: { in: allIds } },
      include: { role: { select: { id: true, name: true, status: true } } },
    })
    const rolesByUser: Record<string, any[]> = {}
    for (const ur of allRoles as any[]) {
      if (!rolesByUser[ur.userId]) rolesByUser[ur.userId] = []
      rolesByUser[ur.userId].push({
        id: ur.role.id, name: ur.role.name, status: ur.status, roleStatus: ur.role.status,
      })
    }
    const items = [...sysStaff, ...staffUsers].map((u: any) => ({
      id: u.id, phone: u.phone, name: u.name, role: u.role, createdAt: u.createdAt,
      salesProfile: u.salesProfile || null,
      adminRoles: rolesByUser[u.id] || [],
    }))
    res.json({ items, total: items.length })
  })

  // ─── 按手机号搜索 AppUser ────────────────────────────────────────
  // 返回结构与 GET /api/admin/staff 单条一致：补 salesProfile / adminRoles，
  // 让「添加管理人员」抽屉能直接列出已分配角色并基于其做增量分配（不丢销售内置角色）。
  app.get('/api/admin/staff/search', requireAdmin, async (req: AuthRequest, res: Response) => {
    const phone = String(req.query.phone || '').trim()
    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: '请输入有效手机号' })
    }
    const user = await prisma.appUser.findUnique({
      where: { phone },
      select: {
        id: true, phone: true, name: true, role: true, createdAt: true,
        salesProfile: { select: { salesCode: true, status: true } },
      },
    })
    if (!user) return res.status(404).json({ error: '用户不存在' })
    const userRoles = await prisma.adminUserRole.findMany({
      where: { userId: user.id },
      include: { role: { select: { id: true, name: true, status: true } } },
    })
    const adminRoles = (userRoles as any[]).map((ur) => ({
      id: ur.role.id, name: ur.role.name, status: ur.status, roleStatus: ur.role.status,
    }))
    res.json({ user: { ...user, salesProfile: user.salesProfile || null, adminRoles } })
  })

  // ─── 提升为超管（phone → role:admin） ─────────────────────────
  app.post('/api/admin/staff/set-admin', requireAdmin, async (req: AuthRequest, res: Response) => {
    const schema = z.object({ phone: z.string().regex(/^1[3-9]\d{9}$/) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const user = await prisma.appUser.findUnique({ where: { phone: parsed.data.phone } })
    if (!user) return res.status(404).json({ error: '用户不存在' })
    if (user.role === 'admin') return res.status(409).json({ error: '该用户已是超管' })
    await prisma.appUser.update({ where: { id: user.id }, data: { role: 'admin' } })
    res.json({ success: true, userId: user.id })
  })

  // ─── 移除超管（admin → user） ─────────────────────────────────
  app.delete('/api/admin/staff/:id/unset-admin', requireAdmin, async (req: AuthRequest, res: Response) => {
    const targetId = String(req.params.id)
    if (targetId === req.userId) {
      return res.status(403).json({ error: '不能移除自己的超管权限' })
    }
    const user = await prisma.appUser.findUnique({ where: { id: targetId } })
    if (!user) return res.status(404).json({ error: '用户不存在' })
    if (user.role !== 'admin') return res.status(409).json({ error: '该用户不是超管' })
    await prisma.appUser.update({ where: { id: user.id }, data: { role: 'user' } })
    res.json({ success: true })
  })

  // ─── 设为销售（含 SalesProfile + 主推码） ─────────────────────
  /**
   * v3 §4 新行为：分配销售身份 = 分配"销售"内置角色 + ensure SalesProfile + 主推码。
   *
   * - 不再修改 AppUser.role（解耦；旧逻辑通过 /me/permissions 三信号兼容）
   * - 重复调用幂等：返回 200 + created=false（不再 409）
   * - admin 系统身份仍 403（管理员不能转销售）
   */
  app.post('/api/admin/staff/:id/set-sales', requireAdmin, async (req: AuthRequest, res: Response) => {
    const schema = z.object({
      realName: z.string().min(1).max(40).optional(),
      companyName: z.string().max(80).optional().nullable(),
    })
    const parsed = schema.safeParse(req.body || {})
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const user = await prisma.appUser.findUnique({ where: { id: String(req.params.id) } })
    if (!user) return res.status(404).json({ error: '用户不存在' })
    if (user.role === 'admin') return res.status(403).json({ error: '管理员不能转为销售' })

    let result
    try {
      // 1) ensure 销售档案 + 主推码（幂等）
      result = await ensureSalesProfileAndPrimaryCode(user.id, {
        realName: parsed.data.realName,
        companyName: parsed.data.companyName ?? undefined,
      })
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || '初始化销售档案失败' })
    }

    // 2) ensure"销售"内置角色存在（按需 upsert，与 Step 3 启动 seed 互为兜底）
    const salesRole = await ensureSalesBuiltInRole(req.userId || 'system')

    // 3) 分配销售角色（幂等）
    const existingAssign = await prisma.adminUserRole.findUnique({
      where: { userId_roleId: { userId: user.id, roleId: salesRole.id } },
    })
    let roleAssigned = false
    if (!existingAssign) {
      await prisma.adminUserRole.create({
        data: { userId: user.id, roleId: salesRole.id, status: 'ACTIVE', assignedBy: req.userId || 'system' },
      })
      roleAssigned = true
    }

    res.json({
      success: true,
      salesCode: result.primaryCode,
      profileId: result.profile.id,
      created: result.created,             // 销售档案是否本次新建
      primaryCodeCreated: result.primaryCodeCreated,
      roleAssigned,                        // 销售角色是否本次分配
    })
  })

  // ─── 分配/撤销 AdminUserRole（按 roleIds 全量替换） ─────────────
  app.patch('/api/admin/staff/:id/roles', requireAdmin, async (req: AuthRequest, res: Response) => {
    const schema = z.object({ roleIds: z.array(z.string()).max(50) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const user = await prisma.appUser.findUnique({ where: { id: String(req.params.id) } })
    if (!user) return res.status(404).json({ error: '用户不存在' })
    // 校验 roleIds 都存在且 ACTIVE
    if (parsed.data.roleIds.length > 0) {
      const validCount = await prisma.adminRole.count({
        where: { id: { in: parsed.data.roleIds }, status: 'ACTIVE' },
      })
      if (validCount !== parsed.data.roleIds.length) {
        return res.status(400).json({ error: '存在无效或已停用的角色 ID' })
      }
    }
    await prisma.$transaction(async (tx: any) => {
      // 全量替换：先删旧，再批量插新
      await tx.adminUserRole.deleteMany({ where: { userId: user.id } })
      if (parsed.data.roleIds.length > 0) {
        await tx.adminUserRole.createMany({
          data: parsed.data.roleIds.map((roleId) => ({
            userId: user.id,
            roleId,
            status: 'ACTIVE',
            assignedBy: req.userId!,
          })),
        })
      }
    })
    res.json({ success: true, count: parsed.data.roleIds.length })
  })

  // ─── 停用/启用：将该用户所有 AdminUserRole.status 切换 ───────────
  app.patch('/api/admin/staff/:id/toggle', requireAdmin, async (req: AuthRequest, res: Response) => {
    const schema = z.object({ active: z.boolean() })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    if (String(req.params.id) === req.userId) {
      return res.status(403).json({ error: '不能停用自己的后台访问' })
    }
    const status = parsed.data.active ? 'ACTIVE' : 'DISABLED'
    const result = await prisma.adminUserRole.updateMany({
      where: { userId: String(req.params.id) },
      data: { status },
    })
    res.json({ success: true, affected: result.count })
  })

  // ─── 批量分配销售角色 ─────────────────────────────────────
  // 本期仅支持 roleType='sales'（与 set-sales 单条接口对齐：建 SalesProfile + 主推码 + 分配"销售"内置角色）
  // 已有"销售"角色 / 已有 SalesProfile 视为 skipped（幂等）
  // 未注册手机号进 notFound,不自动建 user
  // 非法格式手机号进 invalid（与 notFound 区分）
  app.post('/api/admin/roles/batch-assign', requireAdmin, async (req: AuthRequest, res: Response) => {
    const schema = z.object({
      phones: z.array(z.string()).min(1).max(100),
      roleType: z.literal('sales'),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    }

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

    const salesRole = await ensureSalesBuiltInRole(req.userId || 'system')
    const assigned: Array<{ id: string; phone: string; name: string | null; salesCode: string }> = []
    const skipped: Array<{ id: string; phone: string; name: string | null; reason: string }> = []
    const failed: Array<{ phone: string; reason: string }> = []

    for (const u of resolved.found) {
      try {
        // 不能给 admin 转销售（与 set-sales 单条对齐）
        const fullUser = await prisma.appUser.findUnique({ where: { id: u.id }, select: { role: true } })
        if (fullUser?.role === 'admin') {
          skipped.push({ id: u.id, phone: u.phone, name: u.name, reason: '管理员不能转为销售' })
          continue
        }

        // 1) 幂等建 SalesProfile + 主推码（批量场景默认 isPublic=false）
        const profileResult = await ensureSalesProfileAndPrimaryCode(u.id, { isPublic: false })

        // 2) 幂等分配"销售"内置角色
        const existingAssign = await prisma.adminUserRole.findUnique({
          where: { userId_roleId: { userId: u.id, roleId: salesRole.id } },
        })
        let roleNewlyAssigned = false
        if (!existingAssign) {
          await prisma.adminUserRole.create({
            data: { userId: u.id, roleId: salesRole.id, status: 'ACTIVE', assignedBy: req.userId || 'system' },
          })
          roleNewlyAssigned = true
        }

        // 已有档案 + 已有角色 → skipped；其它 → assigned
        if (!profileResult.created && !roleNewlyAssigned) {
          skipped.push({ id: u.id, phone: u.phone, name: u.name, reason: '已是销售' })
        } else {
          assigned.push({ id: u.id, phone: u.phone, name: u.name, salesCode: profileResult.primaryCode })
        }
      } catch (e: any) {
        failed.push({ phone: u.phone, reason: e?.message || '未知错误' })
      }
    }

    res.json({
      assigned,
      skipped,
      notFound: resolved.notFound,
      invalid: resolved.invalid,
      failed,
    })
  })

  // 占位避免 unused import 警告（hashPassword 留给后续"新建管理人员含密码"扩展）
  void hashPassword
}
