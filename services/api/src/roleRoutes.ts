/**
 * 后台角色（AdminRole）管理
 *
 * 6 个接口（全部 requireAdmin）：
 *   GET    /api/admin/roles            - 角色列表（含人员数）
 *   POST   /api/admin/roles            - 创建角色
 *   PUT    /api/admin/roles/:id        - 更新（名称/权限/scope）
 *   PATCH  /api/admin/roles/:id/status - 启用/停用
 *   DELETE /api/admin/roles/:id        - 删除（isSystem 或有关联人员则拒绝）
 *   GET    /api/admin/roles/:id/users  - 该角色下的人员列表
 */
import type { Express, Response } from 'express'
import { z } from 'zod'
import { prisma } from './db'
import { requireAdmin, type AuthRequest } from './auth'
import { SALES_BUILT_IN_ROLE_NAME, SALES_CORE_MENU_PATH } from './services/builtInRoles'

const roleBodySchema = z.object({
  name: z.string().min(1).max(40),
  description: z.string().max(200).optional().nullable(),
  menuPermissions: z.array(z.string()).max(200).default([]),
  actionPermissions: z.array(z.string()).max(200).default([]),
  dataScope: z.enum(['ALL', 'SELF', 'TEAM']).default('SELF'),
})

export function registerRoleRoutes(app: Express) {
  // ─── 角色列表（含人员数） ────────────────────────────────────
  app.get('/api/admin/roles', requireAdmin, async (_req: AuthRequest, res: Response) => {
    const roles = await prisma.adminRole.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { userRoles: true } } },
    })
    res.json({
      items: roles.map((r: any) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        menuPermissions: r.menuPermissions,
        actionPermissions: r.actionPermissions,
        dataScope: r.dataScope,
        isSystem: r.isSystem,
        status: r.status,
        userCount: r._count.userRoles,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    })
  })

  // ─── 创建角色 ─────────────────────────────────────────────────
  app.post('/api/admin/roles', requireAdmin, async (req: AuthRequest, res: Response) => {
    const parsed = roleBodySchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const dup = await prisma.adminRole.findUnique({ where: { name: parsed.data.name } })
    if (dup) return res.status(409).json({ error: '角色名已存在' })
    const role = await prisma.adminRole.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        menuPermissions: parsed.data.menuPermissions,
        actionPermissions: parsed.data.actionPermissions,
        dataScope: parsed.data.dataScope,
        createdBy: req.userId!,
      },
    })
    res.json({ id: role.id })
  })

  // ─── 更新角色 ─────────────────────────────────────────────────
  app.put('/api/admin/roles/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
    const parsed = roleBodySchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const existing = await prisma.adminRole.findUnique({ where: { id: String(req.params.id) } })
    if (!existing) return res.status(404).json({ error: '角色不存在' })

    // v3 §6 销售内置角色保护：name 不可改 + 必含核心 menu
    let finalName = parsed.data.name
    let finalMenu = parsed.data.menuPermissions
    if (existing.isSystem && existing.name === SALES_BUILT_IN_ROLE_NAME) {
      // 锁定 name（即使前端传了改动，这里强制还原，避免破坏 ensureBuiltInRoles upsert by name 锚点）
      finalName = existing.name
      // 自动补核心菜单（避免运营误移除导致销售失去工作台）
      if (!finalMenu.includes(SALES_CORE_MENU_PATH)) {
        finalMenu = [SALES_CORE_MENU_PATH, ...finalMenu]
      }
    }

    if (existing.name !== finalName) {
      const dup = await prisma.adminRole.findUnique({ where: { name: finalName } })
      if (dup) return res.status(409).json({ error: '角色名已存在' })
    }
    await prisma.adminRole.update({
      where: { id: String(req.params.id) },
      data: {
        name: finalName,
        description: parsed.data.description ?? null,
        menuPermissions: finalMenu,
        actionPermissions: parsed.data.actionPermissions,
        dataScope: parsed.data.dataScope,
      },
    })
    res.json({ success: true })
  })

  // ─── 启用/停用角色 ────────────────────────────────────────────
  app.patch('/api/admin/roles/:id/status', requireAdmin, async (req: AuthRequest, res: Response) => {
    const schema = z.object({ active: z.boolean() })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || '参数错误' })
    const role = await prisma.adminRole.findUnique({ where: { id: String(req.params.id) } })
    if (!role) return res.status(404).json({ error: '角色不存在' })

    // v3 §6 销售内置角色保护：禁止停用（停用会让所有销售失去工作台权限）
    if (role.isSystem && role.name === SALES_BUILT_IN_ROLE_NAME && parsed.data.active === false) {
      return res.status(403).json({ error: '"销售"内置角色不可停用' })
    }

    await prisma.adminRole.update({
      where: { id: String(req.params.id) },
      data: { status: parsed.data.active ? 'ACTIVE' : 'DISABLED' },
    })
    res.json({ success: true })
  })

  // ─── 删除角色 ─────────────────────────────────────────────────
  app.delete('/api/admin/roles/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
    const role = await prisma.adminRole.findUnique({
      where: { id: String(req.params.id) },
      include: { _count: { select: { userRoles: true } } },
    })
    if (!role) return res.status(404).json({ error: '角色不存在' })
    if (role.isSystem) return res.status(403).json({ error: '内置角色不可删除' })
    if ((role as any)._count.userRoles > 0) {
      return res.status(409).json({ error: '该角色下仍有关联人员，请先撤销分配后再删除' })
    }
    await prisma.adminRole.delete({ where: { id: String(req.params.id) } })
    res.json({ success: true })
  })

  // ─── 查角色下的人员列表 ───────────────────────────────────────
  app.get('/api/admin/roles/:id/users', requireAdmin, async (req: AuthRequest, res: Response) => {
    const role = await prisma.adminRole.findUnique({ where: { id: String(req.params.id) } })
    if (!role) return res.status(404).json({ error: '角色不存在' })
    const userRoles = await prisma.adminUserRole.findMany({
      where: { roleId: String(req.params.id) },
      include: { user: { select: { id: true, phone: true, name: true, role: true } } },
      orderBy: { assignedAt: 'desc' },
    })
    res.json({
      items: userRoles.map((ur: any) => ({
        userId: ur.userId,
        phone: ur.user.phone,
        name: ur.user.name,
        userRole: ur.user.role,
        assignmentStatus: ur.status,
        assignedAt: ur.assignedAt,
      })),
    })
  })
}
