/**
 * 20-rbac: RBAC 端到端
 *
 * 流程：
 *   1. admin 登录 → 创建带 prefix 的角色 (菜单权限 [/admin/announcements, /admin/content-config])
 *   2. user 登录 → /me/permissions 应仍 hasAdminAccess=false
 *   3. admin 把角色分配给 user
 *   4. user 重新调 /me/permissions → 应 isStaff=true + menuPaths 含两条配置的路径
 *   5. admin 把 user 的角色撤销（PATCH /staff/:id/roles roleIds=[]）
 *   6. user 再调 /me/permissions → 应 hasAdminAccess=false
 *   7. admin 删除该角色（DELETE /roles/:id）—— 此时人员数已为 0，应允许
 *
 * cleanup 在 runner 末尾兜底；本模块也尽力清理。
 *
 * 全程通过 HTTP，绝不直连 prisma。
 */
import type { SmokeContext, SmokeModuleMeta, SmokeResult } from '../types'
import { login } from '../http'
import { assertWritesAllowed } from '../env'
import { rolePrefixed } from '../helpers/prefix'
import { bodyPreview, errorMessage, field, listShape, stringAt, stringField } from '../helpers/shape'

export const meta: SmokeModuleMeta = { name: 'rbac', readonly: false }

interface PermResp {
  hasAdminAccess?: boolean
  isAdmin?: boolean
  isStaff?: boolean
  menuPaths?: string[]
  actionKeys?: string[]
}

async function timed(test: string, fn: () => Promise<{ ok: boolean; status?: number; error?: string }>) {
  const t0 = Date.now()
  try {
    const r = await fn()
    return { module: 'rbac', test, ok: r.ok, status: r.status, error: r.error, durationMs: Date.now() - t0 }
  } catch (e: unknown) {
    return { module: 'rbac', test, ok: false, error: errorMessage(e), durationMs: Date.now() - t0 }
  }
}

export default async function (ctx: SmokeContext): Promise<SmokeResult[]> {
  const env = ctx.env
  assertWritesAllowed(env, 'rbac smoke 需要写动作')
  if (!env.userPhone || !env.userPassword) {
    return [{ module: 'rbac', test: '前置 user 账号', ok: false, error: 'SMOKE_USER_PHONE/PASSWORD 缺失', durationMs: 0 }]
  }

  const results: SmokeResult[] = []

  const adminToken = await login(env, env.adminPhone, env.adminPassword)
  const adminClient = ctx.http(adminToken)

  // ── v3 §4：启动 ensureAppSeed 后"销售"内置角色应已存在
  results.push(await timed('"销售"内置角色已 seed', async () => {
    const r = await adminClient.get('/api/admin/roles')
    const found = listShape(r.body).data.find((x) => stringField(x, 'name') === '销售')
    const ok = r.ok && !!found && field(found, 'isSystem') === true && stringField(found, 'status') === 'ACTIVE'
    return { ok, status: r.status, error: ok ? undefined : `没找到"销售"内置角色或字段不对：${JSON.stringify(found)}` }
  }))

  const userToken = await login(env, env.userPhone, env.userPassword)
  // ⚠ user token 在分配角色后仍然有效，直接复用
  const userClient = ctx.http(userToken)
  const roleName = rolePrefixed(env, 'announcement_ops')
  let createdRoleId = ''
  let userId = ''

  // ── 1. 创建角色
  results.push(await timed('admin 创建测试角色', async () => {
    const r = await adminClient.post<{ id?: string; error?: string }>('/api/admin/roles', {
      name: roleName,
      description: 'smoke 测试角色（自动生成，会被 cleanup 清掉）',
      menuPermissions: ['/admin/announcements', '/admin/content-config'],
      actionPermissions: ['admin.announcements.manage', 'admin.content.manage'],
      dataScope: 'SELF',
    })
    createdRoleId = stringField(r.body, 'id')
    return { ok: r.ok && !!createdRoleId, status: r.status, error: r.ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))
  if (!createdRoleId) return results

  // ── 2. user 初始权限：无后台
  results.push(await timed('user 初始无后台权限', async () => {
    const r = await userClient.get<PermResp>('/api/admin/me/permissions')
    const ok = r.ok && r.body?.hasAdminAccess === false
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  // ── 3. 找到 user.id（搜索接口）
  results.push(await timed('搜索 user 取 id', async () => {
    const r = await adminClient.get(`/api/admin/staff/search?phone=${env.userPhone}`)
    userId = stringAt(r.body, ['user', 'id'])
    return { ok: r.ok && !!userId, status: r.status, error: r.ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))
  if (!userId) {
    // 即使失败也尝试清理已创建的角色
    await adminClient.delete(`/api/admin/roles/${createdRoleId}`)
    return results
  }

  // ── 4. 分配角色
  results.push(await timed('admin 分配角色给 user', async () => {
    const r = await adminClient.patch(`/api/admin/staff/${userId}/roles`, { roleIds: [createdRoleId] })
    return { ok: r.ok, status: r.status, error: r.ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  // ── 5. user 再查权限：应有菜单
  results.push(await timed('user 获得菜单权限', async () => {
    const r = await userClient.get<PermResp>('/api/admin/me/permissions')
    const expected = ['/admin/announcements', '/admin/content-config']
    const got = r.body?.menuPaths || []
    const ok = r.ok && r.body?.hasAdminAccess === true && r.body?.isStaff === true
      && expected.every((p) => got.includes(p))
    return { ok, status: r.status, error: ok ? undefined : `menuPaths=${JSON.stringify(got)}` }
  }))

  // ── 6. 撤销角色
  results.push(await timed('admin 撤销 user 角色', async () => {
    const r = await adminClient.patch(`/api/admin/staff/${userId}/roles`, { roleIds: [] })
    return { ok: r.ok, status: r.status, error: r.ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  // ── 7. user 再查权限：应失效
  results.push(await timed('user 撤销后无后台权限', async () => {
    const r = await userClient.get<PermResp>('/api/admin/me/permissions')
    const ok = r.ok && r.body?.hasAdminAccess === false && r.body?.isStaff === false
    return { ok, status: r.status, error: ok ? undefined : `body=${JSON.stringify(r.body).slice(0, 200)}` }
  }))

  // ── 8. 删除角色（人员数应已为 0）
  results.push(await timed('admin 删除测试角色', async () => {
    const r = await adminClient.delete(`/api/admin/roles/${createdRoleId}`)
    return { ok: r.ok, status: r.status, error: r.ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  return results
}
