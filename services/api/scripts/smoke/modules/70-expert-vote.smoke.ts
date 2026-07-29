/**
 * 70-expert-vote: 专家评审投票只读健康面
 *
 * 覆盖：
 *   - 公开 pricing 配置
 *   - 用户端列表鉴权与响应形态
 *   - 后台列表权限与响应形态
 *   - 有数据时追加详情读取，并检查用户端不暴露内部敏感字段
 */
import type { SmokeContext, SmokeModuleMeta, SmokeResult } from '../types'
import { login } from '../http'
import {
  arrayAt,
  arrayField,
  bodyPreview,
  errorMessage,
  field,
  firstId,
  hasOwnField,
  listShape,
  stringField,
  valueAt,
} from '../helpers/shape'

export const meta: SmokeModuleMeta = { name: 'expert-vote', readonly: true }

const USER_STRIP_FIELDS = [
  'tencentMeetingPwd',
  'resultPdfPath',
  'resultDocxPath',
  'finalDeliverablePath',
  'signedPdfPath',
  'expertSignatureMaterialPath',
  'meetingArrangedBy',
  'voteClosedBy',
  'cancelledBy',
  'deliveredBy',
  'signedBy',
  'notifiedBy',
  'notifiedAt',
]

async function timed(test: string, fn: () => Promise<{ ok: boolean; status?: number; error?: string }>) {
  const t0 = Date.now()
  try {
    const r = await fn()
    return { module: 'expert-vote', test, ok: r.ok, status: r.status, error: r.error, durationMs: Date.now() - t0 }
  } catch (e: unknown) {
    return { module: 'expert-vote', test, ok: false, error: errorMessage(e), durationMs: Date.now() - t0 }
  }
}

function hasNoUserSensitiveFields(body: unknown): boolean {
  return USER_STRIP_FIELDS.every((key) => !hasOwnField(body, key))
}

export default async function (ctx: SmokeContext): Promise<SmokeResult[]> {
  const env = ctx.env
  const results: SmokeResult[] = []

  results.push(await timed('GET /api/app/expert-votes/pricing 公开配置', async () => {
    const r = await ctx.http().get('/api/app/expert-votes/pricing')
    const options = arrayField(r.body, 'expertCountOptions')
    const ok = r.ok
      && typeof field(r.body, 'unitPrice') === 'number'
      && typeof field(r.body, 'minLeadDays') === 'number'
      && Array.isArray(options)
      && options.length > 0
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  results.push(await timed('pricing expertCountOptions 作为用户端选项源', async () => {
    const r = await ctx.http().get('/api/app/expert-votes/pricing')
    const options = arrayField(r.body, 'expertCountOptions')
    const ok = r.ok && Array.isArray(options)
      && options.every((n: unknown) => typeof n === 'number' && n >= 3 && n % 2 === 1)
    return { ok, status: r.status, error: ok ? undefined : `expertCountOptions=${JSON.stringify(options)}` }
  }))

  results.push(await timed('未登录 GET /api/app/expert-votes 401', async () => {
    const r = await ctx.http().get('/api/app/expert-votes')
    const ok = r.status === 401
    return { ok, status: r.status, error: ok ? undefined : `期望 401，实际 ${r.status}` }
  }))

  results.push(await timed('未登录 GET /api/admin/expert-votes 401', async () => {
    const r = await ctx.http().get('/api/admin/expert-votes?page=1&pageSize=1')
    const ok = r.status === 401
    return { ok, status: r.status, error: ok ? undefined : `期望 401，实际 ${r.status}` }
  }))

  const adminToken = await login(env, env.adminPhone, env.adminPassword)
  const userToken = env.userPhone && env.userPassword ? await login(env, env.userPhone, env.userPassword) : ''
  const salesToken = await login(env, env.salesPhone, env.salesPassword)

  let userFirstNo = ''
  if (userToken) {
    results.push(await timed('用户端 GET /api/app/expert-votes list', async () => {
      const r = await ctx.http(userToken).get('/api/app/expert-votes')
      const list = listShape(r.body)
      const ok = r.ok && Array.isArray(arrayField(r.body, 'items'))
      userFirstNo = firstId(list.data, 'requestNo')
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))

    results.push(await timed('普通用户不能调后台 expert-votes', async () => {
      const r = await ctx.http(userToken).get('/api/admin/expert-votes?page=1&pageSize=1')
      const ok = r.status === 403
      return { ok, status: r.status, error: ok ? undefined : `期望 403，实际 ${r.status}` }
    }))

    if (userFirstNo) {
      results.push(await timed('用户端 expert vote detail 不暴露内部字段', async () => {
        const r = await ctx.http(userToken).get(`/api/app/expert-votes/${encodeURIComponent(userFirstNo)}`)
        const ok = r.ok && stringField(r.body, 'requestNo') === userFirstNo && hasNoUserSensitiveFields(r.body)
        return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
      }))

      results.push(await timed('用户端 download-final 状态守卫非 5xx', async () => {
        const r = await ctx.http(userToken).get(`/api/app/expert-votes/${encodeURIComponent(userFirstNo)}/download-final`)
        const ok = [200, 404, 409].includes(r.status)
        return { ok, status: r.status, error: ok ? undefined : `期望 200/404/409，实际 ${r.status}` }
      }))
    }
  } else {
    results.push({ module: 'expert-vote', test: '用户端 list/detail/admin 边界（缺 SMOKE_USER，跳过）', ok: true, durationMs: 0 })
  }

  let adminFirstNo = ''
  results.push(await timed('后台 GET /api/admin/expert-votes list', async () => {
    const r = await ctx.http(adminToken).get('/api/admin/expert-votes?page=1&pageSize=5&includeDraft=true')
    const list = listShape(r.body)
    const ok = r.ok && Array.isArray(arrayField(r.body, 'items')) && typeof field(r.body, 'total') === 'number'
    adminFirstNo = firstId(list.data, 'requestNo')
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  if (adminFirstNo) {
    results.push(await timed('后台 expert vote detail 可读', async () => {
      const r = await ctx.http(adminToken).get(`/api/admin/expert-votes/${encodeURIComponent(adminFirstNo)}`)
      const ok = r.ok && stringField(r.body, 'requestNo') === adminFirstNo
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))

    results.push(await timed('后台 expert vote notification-texts 可读', async () => {
      const r = await ctx.http(adminToken).get(`/api/admin/expert-votes/${encodeURIComponent(adminFirstNo)}/notification-texts`)
      const ok = r.ok && typeof valueAt(r.body, ['texts', 'expert_invite']) === 'string'
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))

    results.push(await timed('后台 expert vote sign-logs 可读', async () => {
      const r = await ctx.http(adminToken).get(`/api/admin/expert-votes/${encodeURIComponent(adminFirstNo)}/sign-logs`)
      const ok = r.ok && Array.isArray(arrayAt(r.body, ['items']))
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))
  }

  results.push(await timed('sales GET /api/admin/expert-votes 非 5xx', async () => {
    const r = await ctx.http(salesToken).get('/api/admin/expert-votes?page=1&pageSize=1')
    const ok = r.status === 200 || r.status === 403
    return { ok, status: r.status, error: ok ? undefined : `期望 200/403，实际 ${r.status}` }
  }))

  return results
}
