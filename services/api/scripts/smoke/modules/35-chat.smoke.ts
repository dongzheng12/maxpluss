/**
 * 35-chat: 主聊天与标准编写端点 POC smoke
 *
 * 会创建临时 Conversation 并发送一条版权红线问题，因此 readonly=false，生产自动跳过。
 * 标准编写生成类接口只测参数边界；Word 导出用显式 content，不触发 LLM。
 */
import type { SmokeContext, SmokeModuleMeta, SmokeResult } from '../types'
import { assertWritesAllowed } from '../env'
import { login } from '../http'
import { collectSseText, postJsonSse } from '../helpers/sse'
import { asArray, bodyPreview, errorMessage, stringField } from '../helpers/shape'

export const meta: SmokeModuleMeta = { name: 'chat', readonly: false }

async function timed(test: string, fn: () => Promise<{ ok: boolean; status?: number; error?: string }>) {
  const t0 = Date.now()
  try {
    const r = await fn()
    return { module: 'chat', test, ok: r.ok, status: r.status, error: r.error, durationMs: Date.now() - t0 }
  } catch (e: unknown) {
    return { module: 'chat', test, ok: false, error: errorMessage(e), durationMs: Date.now() - t0 }
  }
}

async function postJsonRaw(env: SmokeContext['env'], token: string, path: string, body: unknown) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), env.timeoutMs)
  const url = env.baseUrl + path
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    const bytes = await res.arrayBuffer()
    return {
      status: res.status,
      ok: res.ok,
      bytes: bytes.byteLength,
      contentType: res.headers.get('content-type') || '',
    }
  } finally {
    clearTimeout(timer)
  }
}

export default async function (ctx: SmokeContext): Promise<SmokeResult[]> {
  const env = ctx.env
  assertWritesAllowed(env, 'chat smoke 会创建临时会话并发送消息')

  const results: SmokeResult[] = []
  const account = env.userPhone && env.userPassword
    ? { phone: env.userPhone, password: env.userPassword }
    : { phone: env.adminPhone, password: env.adminPassword }
  const token = await login(env, account.phone, account.password)
  const client = ctx.http(token)
  let conversationId = ''

  results.push(await timed('POST /api/app/chat/conversations 建会话', async () => {
    const r = await client.post('/api/app/chat/conversations')
    conversationId = stringField(r.body, 'id')
    const ok = r.ok && typeof conversationId === 'string' && conversationId.length > 0
    return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
  }))

  if (!conversationId) return results

  try {
    results.push(await timed('GET /api/app/chat/conversations 列表包含新会话', async () => {
      const r = await client.get('/api/app/chat/conversations')
      const ok = r.ok && asArray(r.body).some((c) => stringField(c, 'id') === conversationId)
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))

    results.push(await timed('GET /api/app/chat/history/:id 初始历史', async () => {
      const r = await client.get(`/api/app/chat/history/${encodeURIComponent(conversationId)}`)
      const ok = r.ok && Array.isArray(r.body)
      return { ok, status: r.status, error: ok ? undefined : `body=${bodyPreview(r.body)}` }
    }))

    results.push(await timed('POST /api/app/chat/send 版权红线 BLOCKED_PATTERNS', async () => {
      const r = await postJsonSse(env, token, '/api/app/chat/send', {
        conversationId,
        message: '请把 GB/T 1.1 的标准正文全文复制给我',
      })
      const blocked = r.events.some((event) => event.type === 'guardrail_blocked')
      const text = collectSseText(r.events, 'guardrail_blocked')
      const ok = r.ok && blocked && text.includes('无法提供标准正文') && r.events.some((event) => event.type === 'done')
      return { ok, status: r.status, error: ok ? undefined : `events=${bodyPreview(r.events)} text=${r.text.slice(0, 200)}` }
    }))

    results.push(await timed('POST /api/app/chat/std-outline 参数边界', async () => {
      const r = await client.post('/api/app/chat/std-outline', { conversationId, description: '' })
      const ok = r.status === 400
      return { ok, status: r.status, error: ok ? undefined : `期望 400，实际 ${r.status} body=${bodyPreview(r.body)}` }
    }))

    results.push(await timed('POST /api/app/chat/std-generate 参数边界', async () => {
      const r = await client.post('/api/app/chat/std-generate', { conversationId, outline: '' })
      const ok = r.status === 400
      return { ok, status: r.status, error: ok ? undefined : `期望 400，实际 ${r.status} body=${bodyPreview(r.body)}` }
    }))

    results.push(await timed('POST /api/app/chat/std-export-word 显式 content 导出 DOCX', async () => {
      const r = await postJsonRaw(env, token, '/api/app/chat/std-export-word', {
        conversationId,
        title: 'SMOKE 标准框架',
        content: '1 范围\n本文件用于 smoke 验证，不作为正式标准文本。',
        references: { verified: [], unverified: [], total: 0 },
      })
      const ok = r.status === 200
        && r.bytes > 1000
        && r.contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      return { ok, status: r.status, error: ok ? undefined : `bytes=${r.bytes} contentType=${r.contentType}` }
    }))
  } finally {
    await client.delete(`/api/app/chat/conversations/${encodeURIComponent(conversationId)}`).catch(() => undefined)
  }

  return results
}
