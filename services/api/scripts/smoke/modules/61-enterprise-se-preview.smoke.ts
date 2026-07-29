/**
 * 61-enterprise-se-preview: 企业版标准执行 POC 预览/边界动作
 *
 * 这些接口使用 POST/PATCH，但 smoke 只测 dryRun 或不存在资源的边界，不应写入业务数据。
 * 仍声明 readonly:false，让生产环境自动跳过，避免 prod 出现任何业务写方法。
 */
import type { SmokeContext, SmokeModuleMeta, SmokeResult } from '../types'
import { assertWritesAllowed } from '../env'
import { login } from '../http'
import { bodyPreview, errorMessage, field, firstId, listShape, numberField } from '../helpers/shape'

export const meta: SmokeModuleMeta = { name: 'enterprise-se-preview', readonly: false }

async function timed(test: string, fn: () => Promise<{ ok: boolean; status?: number; error?: string }>) {
  const t0 = Date.now()
  try {
    const r = await fn()
    return { module: 'enterprise-se-preview', test, ok: r.ok, status: r.status, error: r.error, durationMs: Date.now() - t0 }
  } catch (e: unknown) {
    return { module: 'enterprise-se-preview', test, ok: false, error: errorMessage(e), durationMs: Date.now() - t0 }
  }
}

export default async function (ctx: SmokeContext): Promise<SmokeResult[]> {
  const env = ctx.env
  assertWritesAllowed(env, 'enterprise-se-preview smoke 使用 POST/PATCH 边界动作')

  const results: SmokeResult[] = []
  const adminToken = await login(env, env.adminPhone, env.adminPassword)
  const client = ctx.http(adminToken)

  let sourceId = ''
  let beforeTotal = 0

  results.push(await timed('前置：取 enterprise sourceId', async () => {
    const r = await client.get('/api/enterprise/standard-execution/sources?page=1&pageSize=1&status=ACTIVE')
    const list = listShape(r.body)
    sourceId = firstId(list.data)
    const ok = r.ok && Array.isArray(list.data)
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  if (sourceId) {
    results.push(await timed('auto-generate dryRun=true 不落库', async () => {
      const before = await client.get(`/api/enterprise/standard-execution/requirements?sourceId=${encodeURIComponent(sourceId)}&page=1&pageSize=1`)
      beforeTotal = numberField(before.body, 'total') ?? 0
      const r = await client.post('/api/enterprise/standard-execution/requirements/auto-generate', {
        sourceId,
        parseMode: 'RULE',
        dryRun: true,
      })
      const after = await client.get(`/api/enterprise/standard-execution/requirements?sourceId=${encodeURIComponent(sourceId)}&page=1&pageSize=1`)
      const afterTotal = numberField(after.body, 'total') ?? -1
      const data = field(r.body, 'data')
      const ok = before.ok && r.ok && after.ok
        && field(data, 'dryRun') === true
        && field(data, 'sourceId') === sourceId
        && typeof field(data, 'createdCount') === 'number'
        && field(data, 'createdCount') === 0
        && Array.isArray(field(data, 'drafts'))
        && beforeTotal === afterTotal
      return { ok, status: r.status, error: ok ? undefined : `before=${beforeTotal} after=${afterTotal} body=${bodyPreview(r.body)}` }
    }))
  } else {
    results.push({ module: 'enterprise-se-preview', test: 'auto-generate dryRun=true 不落库（无 ACTIVE source，跳过）', ok: true, durationMs: 0 })
  }

  results.push(await timed('requirements 状态流转 no-such-id 返回 404/400 且不写数据', async () => {
    const r = await client.patch('/api/enterprise/standard-execution/requirements/no-such-smoke-id/activate', {})
    const ok = r.status === 404 || r.status === 400
    return { ok, status: r.status, error: ok ? undefined : `期望 404/400，实际 ${r.status} body=${bodyPreview(r.body)}` }
  }))

  return results
}
