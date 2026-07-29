/**
 * 00-health: 基础健康检查（runner 启动哨兵之外的字段断言）
 */
import type { SmokeContext, SmokeModuleMeta, SmokeResult } from '../types'
import { bodyPreview, errorMessage } from '../helpers/shape'

export const meta: SmokeModuleMeta = { name: 'health', readonly: true }

export default async function (ctx: SmokeContext): Promise<SmokeResult[]> {
  const results: SmokeResult[] = []
  const http = ctx.http()

  const t0 = Date.now()
  try {
    const r = await http.get<{ ok?: boolean; service?: string; commit?: string; pid?: number; startedAt?: string }>(
      '/health'
    )
    const ok = r.ok && r.body?.ok === true && typeof r.body?.service === 'string' && typeof r.body?.commit === 'string'
    results.push({
      module: 'health',
      test: 'GET /health 字段完整',
      ok,
      status: r.status,
      error: ok ? undefined : `body=${bodyPreview(r.body)}`,
      durationMs: Date.now() - t0,
    })
  } catch (e: unknown) {
    results.push({ module: 'health', test: 'GET /health 字段完整', ok: false, error: errorMessage(e), durationMs: Date.now() - t0 })
  }

  return results
}
