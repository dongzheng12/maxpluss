/**
 * 30-sales: 销售身份基础校验（v3：不再因重复返回 409）
 *
 * 覆盖：
 *   - 已存在的 sales 账号：登录 + GET /api/app/sales/profile + GET /api/app/sales/codes
 *   - admin 调 set-sales 把自己当目标：应 403（管理员不能转销售）
 *   - admin 调 set-sales 把已是 sales 的人当目标：应 200 + created=false（v3 幂等）
 *   - 列表里能看到 sales 账号 + 主推码 + "销售"角色已分配
 */
import type { SmokeContext, SmokeModuleMeta, SmokeResult } from '../types'
import { login } from '../http'
import {
  arrayField,
  bodyPreview,
  errorMessage,
  field,
  listShape,
  objectAt,
  stringAt,
  stringField,
} from '../helpers/shape'

export const meta: SmokeModuleMeta = { name: 'sales', readonly: false }

async function timed(test: string, fn: () => Promise<{ ok: boolean; status?: number; error?: string }>) {
  const t0 = Date.now()
  try {
    const r = await fn()
    return { module: 'sales', test, ok: r.ok, status: r.status, error: r.error, durationMs: Date.now() - t0 }
  } catch (e: unknown) {
    return { module: 'sales', test, ok: false, error: errorMessage(e), durationMs: Date.now() - t0 }
  }
}

export default async function (ctx: SmokeContext): Promise<SmokeResult[]> {
  const env = ctx.env
  const results: SmokeResult[] = []

  const adminToken = await login(env, env.adminPhone, env.adminPassword)
  const adminClient = ctx.http(adminToken)

  const salesToken = await login(env, env.salesPhone, env.salesPassword)
  const salesClient = ctx.http(salesToken)

  // ── sales 自己读 profile / codes
  results.push(await timed('sales GET /api/app/sales/profile', async () => {
    const r = await salesClient.get('/api/app/sales/profile')
    const ok = r.ok && (!!stringField(r.body, 'salesCode') || !!objectAt(r.body, ['profile']))
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  results.push(await timed('sales GET /api/app/sales/codes', async () => {
    const r = await salesClient.get('/api/app/sales/codes')
    const items = arrayField(r.body, 'items') ?? []
    const ok = r.ok && items.length >= 1
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  // ── 找到 sales 与 admin 的 id
  let salesUserId = ''
  let adminUserId = ''
  await timed('搜 sales id', async () => {
    const r = await adminClient.get(`/api/admin/staff/search?phone=${env.salesPhone}`)
    salesUserId = stringAt(r.body, ['user', 'id'])
    return { ok: !!salesUserId, status: r.status }
  })
  await timed('搜 admin id', async () => {
    const r = await adminClient.get(`/api/admin/staff/search?phone=${env.adminPhone}`)
    adminUserId = stringAt(r.body, ['user', 'id'])
    return { ok: !!adminUserId, status: r.status }
  })

  // ── set-sales 对 admin 应 403
  if (adminUserId) {
    results.push(await timed('set-sales 对 admin 应 403', async () => {
      const r = await adminClient.post(`/api/admin/staff/${adminUserId}/set-sales`, { realName: 'should not happen' })
      const ok = r.status === 403
      return { ok, status: r.status, error: ok ? undefined : `期望 403，实际 ${r.status}` }
    }))
  }

  // ── set-sales 对已是 sales 的应 200 + created=false（v3 幂等）
  if (salesUserId) {
    results.push(await timed('set-sales 对 sales 应 200 + created=false（v3 幂等）', async () => {
      const r = await adminClient.post(
        `/api/admin/staff/${salesUserId}/set-sales`, { realName: '重复销售（应忽略）' },
      )
      const ok = r.status === 200 && field(r.body, 'success') === true && field(r.body, 'created') === false
        && !!stringField(r.body, 'salesCode')
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))
  }

  // ── staff 列表里 sales 应有 SalesProfile
  results.push(await timed('staff 列表含 sales SalesProfile', async () => {
    const r = await adminClient.get('/api/admin/staff')
    const found = listShape(r.body).data.find((s) => stringField(s, 'phone') === env.salesPhone)
    const ok = r.ok && !!found && !!objectAt(found, ['salesProfile'])
    return { ok, status: r.status, error: ok ? undefined : `没找到 sales 或 salesProfile 缺失` }
  }))

  // ── v3 §4：set-sales 后该 sales 应持有"销售"内置角色（角色信号）
  results.push(await timed('sales 用户已分配"销售"内置角色', async () => {
    const r = await adminClient.get('/api/admin/staff')
    const found = listShape(r.body).data.find((s) => stringField(s, 'phone') === env.salesPhone)
    const adminRoles = arrayField(found, 'adminRoles') ?? []
    const hasSalesRole = adminRoles.some((ar) => stringField(ar, 'name') === '销售' && stringField(ar, 'status') === 'ACTIVE')
    return { ok: r.ok && hasSalesRole, status: r.status,
      error: hasSalesRole ? undefined : `adminRoles=${JSON.stringify(adminRoles).slice(0, 200)}` }
  }))

  return results
}
