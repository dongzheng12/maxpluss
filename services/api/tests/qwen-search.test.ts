/**
 * Qwen DashScope 原生 enable_search 流式调用 + 触发判断 单元测试
 *
 * 覆盖：
 *  - shouldFallbackToWeb 5 类触发判断
 *  - callQwenWithSearchStream happy path: SSE 解析 + content yield + sources 回调
 *  - 错误路径: 无 key / HTTP 非 200 / 网络异常 / 超时
 *  - search_info 只回调一次（防重复 emit）
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldFallbackToWeb } from '../src/services/chatSearch.js'
import { callQwenWithSearchStream } from '../src/services/llm.js'

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_KEY = process.env.SVC_LLM_FALLBACK_KEY

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH
  if (ORIGINAL_KEY === undefined) delete process.env.SVC_LLM_FALLBACK_KEY
  else process.env.SVC_LLM_FALLBACK_KEY = ORIGINAL_KEY
})

beforeEach(() => {
  process.env.SVC_LLM_FALLBACK_KEY = 'test-key-for-vitest'
})

// ─── helper：把字符串数组转成 SSE 流 ReadableStream + 直接构造 mock response ─────
function mockSSEStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i >= events.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(events[i] + '\n\n'))
      i++
    },
  })
}

// 直接 mock 一个 { ok, status, body } 对象（绕开 new Response(stream) 在 vitest
// 里 body 不透传的兼容性问题）
function mockSSEResponse(events: string[]): { ok: boolean; status: number; body: ReadableStream<Uint8Array> } {
  return {
    ok: true,
    status: 200,
    body: mockSSEStream(events),
  }
}

// ════════════════════════════════════════════════════════════
// shouldFallbackToWeb
// ════════════════════════════════════════════════════════════

describe('shouldFallbackToWeb', () => {
  it('no_fallback_key: 未配置 SVC_LLM_FALLBACK_KEY → 不触发', () => {
    delete process.env.SVC_LLM_FALLBACK_KEY
    const r = shouldFallbackToWeb('GB 4806', 0, 'empty')
    expect(r.trigger).toBe(false)
    expect(r.reason).toBe('no_fallback_key')
  })

  it('user_explicit: 用户显式要求 → 即使本地命中也触发', () => {
    const r = shouldFallbackToWeb('帮我搜一下最新的食品安全标准', 5, 'exact')
    expect(r.trigger).toBe(true)
    expect(r.reason).toBe('user_explicit')
  })

  it('local_empty: 本地 0 命中 → 触发', () => {
    const r = shouldFallbackToWeb('某个很冷门的标准', 0, 'empty')
    expect(r.trigger).toBe(true)
    expect(r.reason).toBe('local_empty')
  })

  it('low_recall_with_code: 本地 < 3 + 带编号 → 触发（可能漏召回）', () => {
    const r = shouldFallbackToWeb('GB 50011-2010 的实施情况', 1, 'related')
    expect(r.trigger).toBe(true)
    expect(r.reason).toBe('low_recall_with_code')
  })

  it('time_sensitive: 时效词触发（即使本地够）', () => {
    const r = shouldFallbackToWeb('2026 年最新发布的食品标准', 5, 'exact')
    expect(r.trigger).toBe(true)
    expect(r.reason).toBe('time_sensitive')
  })

  it('sufficient_local: 本地够 + 无触发词 → 不触发', () => {
    const r = shouldFallbackToWeb('GB 1234 是什么标准', 5, 'exact')
    expect(r.trigger).toBe(false)
    expect(r.reason).toBe('sufficient_local')
  })
})

// ════════════════════════════════════════════════════════════
// callQwenWithSearchStream — happy / error paths
// ════════════════════════════════════════════════════════════

describe('callQwenWithSearchStream — error paths', () => {
  it('no_key: SVC_LLM_FALLBACK_KEY 为空 → 直接 yield 兜底文案', async () => {
    delete process.env.SVC_LLM_FALLBACK_KEY
    const chunks: string[] = []
    for await (const c of callQwenWithSearchStream([{ role: 'user', content: 'x' }])) {
      chunks.push(c)
    }
    expect(chunks.join('')).toMatch(/AI 服务暂时不可用/)
  })

  it('HTTP 非 200 → yield 兜底文案', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('rate limited', { status: 429 }),
    ) as never
    const chunks: string[] = []
    for await (const c of callQwenWithSearchStream([{ role: 'user', content: 'x' }])) {
      chunks.push(c)
    }
    expect(chunks.join('')).toMatch(/AI 服务暂时不可用/)
  })

  it('网络异常 → yield 兜底', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('econnrefused')) as never
    const chunks: string[] = []
    for await (const c of callQwenWithSearchStream([{ role: 'user', content: 'x' }])) {
      chunks.push(c)
    }
    expect(chunks.join('')).toMatch(/AI 服务暂时不可用/)
  })
})

describe('callQwenWithSearchStream — happy path + sources', () => {
  it('SSE 多 chunk 流式输出 content + search_info 回调一次', async () => {
    const events = [
      'data: ' + JSON.stringify({
        output: {
          search_info: {
            search_results: [
              { title: 'GB 4806.1-2016 食品安全国家标准', url: 'https://openstd.samr.gov.cn/x', site_name: 'samr', index: 0 },
              { title: '某博客文章', url: 'https://blog.example.com/y', index: 1 },
            ],
          },
          choices: [{ message: { content: '根据' } }],
        },
      }),
      'data: ' + JSON.stringify({ output: { choices: [{ message: { content: '联网搜索结果，' } }] } }),
      'data: ' + JSON.stringify({ output: { choices: [{ message: { content: 'GB 4806.1-2016 现行。' } }] } }),
      'data: [DONE]',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(mockSSEResponse(events)) as never

    const sources: unknown[] = []
    const chunks: string[] = []
    for await (const c of callQwenWithSearchStream(
      [{ role: 'user', content: 'GB 4806.1 是什么' }],
      { onSources: (s) => sources.push(s) },
    )) {
      chunks.push(c)
    }

    expect(chunks.join('')).toBe('根据联网搜索结果，GB 4806.1-2016 现行。')
    // sources 只回调一次（即使后续 chunk 仍然有 search_info，也只 emit 一次）
    expect(sources).toHaveLength(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = sources[0] as any[]
    expect(src).toHaveLength(2)
    expect(src[0].title).toBe('GB 4806.1-2016 食品安全国家标准')
    expect(src[0].url).toBe('https://openstd.samr.gov.cn/x')
    expect(src[0].site_name).toBe('samr')
  })

  it('过滤 search_info 里 url/title 空的条目', async () => {
    const events = [
      'data: ' + JSON.stringify({
        output: {
          search_info: {
            search_results: [
              { title: 'OK', url: 'https://gb688.cn/z' },
              { title: '', url: 'https://no-title.example' },         // 应过滤
              { title: 'no-url', url: '' },                            // 应过滤
            ],
          },
          choices: [{ message: { content: 'hi' } }],
        },
      }),
      'data: [DONE]',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(mockSSEResponse(events)) as never

    const sources: unknown[] = []
    for await (const _c of callQwenWithSearchStream(
      [{ role: 'user', content: 'x' }],
      { onSources: (s) => sources.push(s) },
    )) { void _c }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = sources[0] as any[]
    expect(src).toHaveLength(1)
    expect(src[0].title).toBe('OK')
  })

  it('search_info 缺失也能正常 yield content（不报错）', async () => {
    const events = [
      'data: ' + JSON.stringify({ output: { choices: [{ message: { content: 'plain reply' } }] } }),
      'data: [DONE]',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(mockSSEResponse(events)) as never

    const sources: unknown[] = []
    const chunks: string[] = []
    for await (const c of callQwenWithSearchStream(
      [{ role: 'user', content: 'x' }],
      { onSources: (s) => sources.push(s) },
    )) { chunks.push(c) }

    expect(chunks.join('')).toBe('plain reply')
    expect(sources).toHaveLength(0)
  })

  it('SSE 0 内容 chunk → yield 兜底文案', async () => {
    const events = ['data: [DONE]']
    globalThis.fetch = vi.fn().mockResolvedValue(mockSSEResponse(events)) as never

    const chunks: string[] = []
    for await (const c of callQwenWithSearchStream([{ role: 'user', content: 'x' }])) {
      chunks.push(c)
    }
    expect(chunks.join('')).toMatch(/AI 服务暂时不可用/)
  })

  it('单 chunk 解析失败 不影响后续 chunk', async () => {
    const events = [
      'data: not-valid-json',
      'data: ' + JSON.stringify({ output: { choices: [{ message: { content: 'ok' } }] } }),
      'data: [DONE]',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(mockSSEResponse(events)) as never

    const chunks: string[] = []
    for await (const c of callQwenWithSearchStream([{ role: 'user', content: 'x' }])) {
      chunks.push(c)
    }
    expect(chunks.join('')).toBe('ok')
  })
})
