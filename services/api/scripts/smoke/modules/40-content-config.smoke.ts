/**
 * 40-content-config: 公开内容配置 + pricing
 *
 * 仅只读，不需要 token。
 */
import type { SmokeContext, SmokeModuleMeta, SmokeResult } from '../types'
import { arrayField, bodyPreview, errorMessage } from '../helpers/shape'

export const meta: SmokeModuleMeta = { name: 'content-config', readonly: true }

async function timed(test: string, fn: () => Promise<{ ok: boolean; status?: number; error?: string }>) {
  const t0 = Date.now()
  try {
    const r = await fn()
    return { module: 'content-config', test, ok: r.ok, status: r.status, error: r.error, durationMs: Date.now() - t0 }
  } catch (e: unknown) {
    return { module: 'content-config', test, ok: false, error: errorMessage(e), durationMs: Date.now() - t0 }
  }
}

export default async function (ctx: SmokeContext): Promise<SmokeResult[]> {
  const http = ctx.http()
  const results: SmokeResult[] = []

  results.push(await timed('GET /api/app/config 200', async () => {
    const r = await http.get('/api/app/config')
    return { ok: r.ok, status: r.status, error: r.ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  results.push(await timed('GET /api/app/pricing 200', async () => {
    const r = await http.get('/api/app/pricing')
    const ok = r.ok && (Array.isArray(r.body) ? r.body.length > 0 : Array.isArray(arrayField(r.body, 'plans')))
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  return results
}
