/**
 * 60-enterprise-se: 企业版标准执行只读健康面
 *
 * 覆盖最近高风险区域：
 *   - 企业身份解析 / admin bypass
 *   - 标准来源 / 要求项 / 任务 / 审核 / 记录 / 材料包 / 风险 / 题库 / 计划
 *   - 有数据时追加详情 / 进度 / 下载 HEAD / 小程序员工只读入口
 *   - PR #12 schema 字段：Requirement.parseMode / Package.format
 */
import type { SmokeContext, SmokeModuleMeta, SmokeResult } from '../types'
import { login } from '../http'
import {
  arrayAt,
  bodyPreview,
  booleanField,
  errorMessage,
  field,
  firstId,
  firstNestedString,
  hasOwnField,
  listShape,
  objectAt,
  stringAt,
  stringField,
  type SmokeObject,
} from '../helpers/shape'

export const meta: SmokeModuleMeta = { name: 'enterprise-se', readonly: true }

async function timed(test: string, fn: () => Promise<{ ok: boolean; status?: number; error?: string }>) {
  const t0 = Date.now()
  try {
    const r = await fn()
    return { module: 'enterprise-se', test, ok: r.ok, status: r.status, error: r.error, durationMs: Date.now() - t0 }
  } catch (e: unknown) {
    return { module: 'enterprise-se', test, ok: false, error: errorMessage(e), durationMs: Date.now() - t0 }
  }
}

async function expectList(
  ctx: SmokeContext,
  token: string,
  test: string,
  path: string,
  itemCheck?: (item: SmokeObject) => boolean,
) {
  return timed(test, async () => {
    const r = await ctx.http(token).get(path)
    const list = listShape(r.body)
    const ok = r.ok && Array.isArray(list.data) && (list.data.length === 0 || !itemCheck || itemCheck(list.data[0]))
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  })
}

export default async function (ctx: SmokeContext): Promise<SmokeResult[]> {
  const env = ctx.env
  const results: SmokeResult[] = []
  const adminToken = await login(env, env.adminPhone, env.adminPassword)
  const userToken = env.userPhone && env.userPassword
    ? await login(env, env.userPhone, env.userPassword)
    : ''

  let sourceId = ''
  let requirementId = ''
  let taskId = ''
  let submissionId = ''
  let recordId = ''
  let packageId = ''
  let readyPackageId = ''
  let questionBankId = ''
  let planId = ''
  let appTaskId = ''

  results.push(await timed('GET /api/enterprise/me 企业身份可解析', async () => {
    const r = await ctx.http(adminToken).get('/api/enterprise/me')
    const ok = r.ok
      && !!stringField(r.body, 'enterpriseId')
      && (booleanField(r.body, 'isAdminBypass') === true || !!stringField(r.body, 'enterpriseRole'))
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  results.push(await timed('GET enterprise dashboard 200 + counts', async () => {
    const r = await ctx.http(adminToken).get('/api/enterprise/standard-execution/dashboard')
    const counts = objectAt(r.body, ['counts']) ?? objectAt(r.body, ['data', 'counts'])
    const ok = r.ok && !!counts
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  results.push(await expectList(ctx, adminToken, 'GET enterprise members list', '/api/enterprise/members?page=1&pageSize=5'))

  results.push(await timed('GET enterprise sources list', async () => {
    const r = await ctx.http(adminToken).get('/api/enterprise/standard-execution/sources?page=1&pageSize=5')
    const list = listShape(r.body)
    sourceId = firstId(list.data)
    const ok = r.ok && Array.isArray(list.data)
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  results.push(await timed('GET enterprise requirements list + parseMode 字段', async () => {
    const r = await ctx.http(adminToken).get('/api/enterprise/standard-execution/requirements?page=1&pageSize=5')
    const list = listShape(r.body)
    requirementId = firstId(list.data)
    const ok = r.ok && Array.isArray(list.data)
      && (list.data.length === 0 || hasOwnField(list.data[0], 'parseMode'))
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  results.push(await expectList(ctx, adminToken, 'GET enterprise active requirements list', '/api/enterprise/standard-execution/requirements?status=ACTIVE&pageSize=200'))

  results.push(await timed('GET enterprise tasks list', async () => {
    const r = await ctx.http(adminToken).get('/api/enterprise/standard-execution/tasks?page=1&pageSize=5')
    const list = listShape(r.body)
    taskId = firstId(list.data)
    const ok = r.ok && Array.isArray(list.data)
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  if (taskId) {
    results.push(await timed('GET enterprise task progress', async () => {
      const r = await ctx.http(adminToken).get(`/api/enterprise/standard-execution/tasks/${encodeURIComponent(taskId)}/progress`)
      const ok = r.ok
        && stringAt(r.body, ['data', 'taskId']) === taskId
        && !!objectAt(r.body, ['data', 'byStatus'])
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))
  }

  results.push(await timed('GET enterprise reviews list', async () => {
    const r = await ctx.http(adminToken).get('/api/enterprise/standard-execution/reviews?page=1&pageSize=5&status=all')
    const list = listShape(r.body)
    submissionId = firstNestedString(list.data, ['submission', 'id'])
    const ok = r.ok && Array.isArray(list.data)
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  if (submissionId) {
    results.push(await timed('GET enterprise review detail', async () => {
      const r = await ctx.http(adminToken).get(`/api/enterprise/standard-execution/reviews/${encodeURIComponent(submissionId)}`)
      const ok = r.ok
        && stringAt(r.body, ['data', 'submission', 'id']) === submissionId
        && Array.isArray(arrayAt(r.body, ['data', 'reviewLogs']))
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))
  }

  results.push(await timed('GET enterprise records list', async () => {
    const r = await ctx.http(adminToken).get('/api/enterprise/standard-execution/records?page=1&pageSize=5')
    const list = listShape(r.body)
    recordId = firstId(list.data)
    const ok = r.ok && Array.isArray(list.data)
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  if (recordId) {
    results.push(await timed('GET enterprise record detail', async () => {
      const r = await ctx.http(adminToken).get(`/api/enterprise/standard-execution/records/${encodeURIComponent(recordId)}`)
      const ok = r.ok
        && stringAt(r.body, ['data', 'id']) === recordId
        && Array.isArray(arrayAt(r.body, ['data', 'attachments']))
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))
  }

  results.push(await timed('GET enterprise packages list + format 字段', async () => {
    const r = await ctx.http(adminToken).get('/api/enterprise/standard-execution/packages?page=1&pageSize=5')
    const list = listShape(r.body)
    packageId = firstId(list.data)
    readyPackageId = firstId(list.data.filter((item) => stringField(item, 'status') === 'READY' && !!stringField(item, 'fileUrl')))
    const ok = r.ok && Array.isArray(list.data)
      && (list.data.length === 0 || typeof field(list.data[0], 'format') === 'string')
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  if (packageId) {
    results.push(await timed('GET enterprise package detail tree', async () => {
      const r = await ctx.http(adminToken).get(`/api/enterprise/standard-execution/packages/${encodeURIComponent(packageId)}`)
      const ok = r.ok
        && stringAt(r.body, ['data', 'id']) === packageId
        && Array.isArray(arrayAt(r.body, ['data', 'tree']))
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))
  }

  if (readyPackageId) {
    results.push(await timed('HEAD enterprise READY package download', async () => {
      const r = await ctx.http(adminToken).head(`/api/enterprise/standard-execution/packages/${encodeURIComponent(readyPackageId)}/download`)
      const ok = r.status === 200
      return { ok, status: r.status, error: ok ? undefined : `READY package download HEAD 期望 200，实际 ${r.status}` }
    }))
  } else {
    results.push({ module: 'enterprise-se', test: 'HEAD enterprise READY package download（无 READY 包，跳过）', ok: true, durationMs: 0 })
  }

  results.push(await timed('GET enterprise question banks list', async () => {
    const r = await ctx.http(adminToken).get('/api/enterprise/standard-execution/question-banks?page=1&pageSize=5')
    const list = listShape(r.body)
    questionBankId = firstId(list.data)
    const ok = r.ok && Array.isArray(list.data)
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  if (questionBankId) {
    results.push(await timed('GET enterprise question bank detail', async () => {
      const r = await ctx.http(adminToken).get(`/api/enterprise/standard-execution/question-banks/${encodeURIComponent(questionBankId)}`)
      const ok = r.ok && stringField(r.body, 'id') === questionBankId
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))
  }

  results.push(await timed('GET enterprise plans list', async () => {
    const r = await ctx.http(adminToken).get('/api/enterprise/standard-execution/plans?page=1&pageSize=5')
    const list = listShape(r.body)
    planId = firstId(list.data)
    const ok = r.ok && Array.isArray(list.data)
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  if (planId) {
    results.push(await timed('GET enterprise plan detail + tasks', async () => {
      const r = await ctx.http(adminToken).get(`/api/enterprise/standard-execution/plans/${encodeURIComponent(planId)}`)
      const ok = r.ok
        && stringAt(r.body, ['data', 'id']) === planId
        && Array.isArray(arrayAt(r.body, ['data', 'tasks']))
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))
  }

  results.push(await timed('GET enterprise risks list', async () => {
    const r = await ctx.http(adminToken).get('/api/enterprise/standard-execution/risks')
    const list = listShape(r.body)
    const ok = r.ok && Array.isArray(list.data)
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  if (userToken) {
    results.push(await timed('GET app SE my-tasks list（员工端只读入口）', async () => {
      const r = await ctx.http(userToken).get('/api/app/standard-execution/tasks?tab=todo&page=1&pageSize=5')
      const list = listShape(r.body)
      appTaskId = firstNestedString(list.data, ['task', 'id'])
      const ok = r.ok && Array.isArray(list.data)
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))

    if (appTaskId) {
      results.push(await timed('GET app SE task detail/items', async () => {
        const detail = await ctx.http(userToken).get(`/api/app/standard-execution/tasks/${encodeURIComponent(appTaskId)}`)
        const items = await ctx.http(userToken).get(`/api/app/standard-execution/tasks/${encodeURIComponent(appTaskId)}/items`)
        const ok = detail.ok
          && items.ok
          && stringAt(detail.body, ['data', 'task', 'id']) === appTaskId
          && Array.isArray(arrayAt(items.body, ['data']))
        return { ok, status: ok ? 200 : (detail.status || items.status), error: ok ? undefined : `detail=${bodyPreview(detail.body)} items=${bodyPreview(items.body)}` }
      }))
    }
  } else {
    results.push({ module: 'enterprise-se', test: 'GET app SE my-tasks list（缺 SMOKE_USER，跳过）', ok: true, durationMs: 0 })
  }

  return results
}
