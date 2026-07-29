/**
 * 10-auth: 三账号登录 + /api/admin/me/permissions 形态校验
 *
 * - admin: hasAdminAccess=true, isAdmin=true, menuPaths含'*'
 * - sales: hasAdminAccess=true, isSales=true, menuPaths 含 /admin/sales/workspace
 * - user:  默认 hasAdminAccess=false, isStaff=false, menuPaths=[]
 *
 * 注意：login 接口要求 password 写动作（POST），但生成 token 不算业务写。
 * runner.ts 的 login() 已绕过 prod 写保护检查（prod 只读 smoke 不调 10-auth user 部分）。
 */
import type { SmokeContext, SmokeModuleMeta, SmokeResult } from '../types'
import { login } from '../http'
import { bodyPreview, errorMessage } from '../helpers/shape'

export const meta: SmokeModuleMeta = { name: 'auth', readonly: true }

interface PermResp {
  hasAdminAccess?: boolean
  isAdmin?: boolean
  isSales?: boolean
  isStaff?: boolean
  menuPaths?: string[]
  actionKeys?: string[]
}

async function timed(name: string, fn: () => Promise<{ ok: boolean; status?: number; error?: string }>) {
  const t0 = Date.now()
  try {
    const r = await fn()
    return { module: 'auth', test: name, ok: r.ok, status: r.status, error: r.error, durationMs: Date.now() - t0 }
  } catch (e: unknown) {
    return { module: 'auth', test: name, ok: false, error: errorMessage(e), durationMs: Date.now() - t0 }
  }
}

export default async function (ctx: SmokeContext): Promise<SmokeResult[]> {
  const results: SmokeResult[] = []
  const env = ctx.env

  // ── admin
  let adminToken = ''
  results.push(await timed('admin 登录', async () => {
    adminToken = await login(env, env.adminPhone, env.adminPassword)
    return { ok: !!adminToken }
  }))

  if (adminToken) {
    results.push(await timed('admin /me/permissions 全权限', async () => {
      const r = await ctx.http(adminToken).get<PermResp>('/api/admin/me/permissions')
      const ok = r.ok && r.body?.isAdmin === true && r.body?.hasAdminAccess === true
        && (r.body?.menuPaths || []).includes('*')
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))
  }

  // ── sales
  let salesToken = ''
  results.push(await timed('sales 登录', async () => {
    salesToken = await login(env, env.salesPhone, env.salesPassword)
    return { ok: !!salesToken }
  }))

  if (salesToken) {
    results.push(await timed('sales /me/permissions 含工作台白名单', async () => {
      const r = await ctx.http(salesToken).get<PermResp>('/api/admin/me/permissions')
      const ok = r.ok && r.body?.isSales === true && r.body?.hasAdminAccess === true
        && (r.body?.menuPaths || []).includes('/admin/sales/workspace')
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))
  }

  // ── user（prod 可缺）
  if (env.userPhone && env.userPassword) {
    let userToken = ''
    results.push(await timed('user 登录', async () => {
      userToken = await login(env, env.userPhone, env.userPassword)
      return { ok: !!userToken }
    }))
    if (userToken) {
      results.push(await timed('user /me/permissions 默认无后台权限', async () => {
        const r = await ctx.http(userToken).get<PermResp>('/api/admin/me/permissions')
        const ok = r.ok && r.body?.hasAdminAccess === false && r.body?.isStaff === false
          && (r.body?.menuPaths?.length ?? 0) === 0
        return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
      }))
    }
  }

  return results
}
