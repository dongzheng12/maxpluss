/**
 * 50-orders: 订单只读检查（不创建订单 / 不触发支付链路）
 *
 * 覆盖：
 *   - admin GET /api/admin/orders 200 + items 数组
 *   - 未登录请求 admin 接口 401
 *   - sales 请求 admin 接口 403（兜底防越权）
 */
import type { SmokeContext, SmokeModuleMeta, SmokeResult } from '../types'
import { login } from '../http'
import { arrayField, bodyPreview, errorMessage } from '../helpers/shape'

export const meta: SmokeModuleMeta = { name: 'orders', readonly: true }

async function timed(test: string, fn: () => Promise<{ ok: boolean; status?: number; error?: string }>) {
  const t0 = Date.now()
  try {
    const r = await fn()
    return { module: 'orders', test, ok: r.ok, status: r.status, error: r.error, durationMs: Date.now() - t0 }
  } catch (e: unknown) {
    return { module: 'orders', test, ok: false, error: errorMessage(e), durationMs: Date.now() - t0 }
  }
}

export default async function (ctx: SmokeContext): Promise<SmokeResult[]> {
  const env = ctx.env
  const results: SmokeResult[] = []

  // ── admin
  const adminToken = await login(env, env.adminPhone, env.adminPassword)
  results.push(await timed('admin GET /api/admin/orders 200', async () => {
    const r = await ctx.http(adminToken).get('/api/admin/orders')
    const ok = r.ok && Array.isArray(arrayField(r.body, 'items'))
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  // ── 未登录访问 admin 接口 → 401
  results.push(await timed('未登录 GET /api/admin/orders 401', async () => {
    const r = await ctx.http().get('/api/admin/orders')
    const ok = r.status === 401
    return { ok, status: r.status, error: ok ? undefined : `期望 401，实际 ${r.status}` }
  }))

  // ── sales 越权访问 admin 接口 → 403
  const salesToken = await login(env, env.salesPhone, env.salesPassword)
  results.push(await timed('sales GET /api/admin/orders 403', async () => {
    const r = await ctx.http(salesToken).get('/api/admin/orders')
    const ok = r.status === 403
    return { ok, status: r.status, error: ok ? undefined : `期望 403，实际 ${r.status}` }
  }))

  return results
}
