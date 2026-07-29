/**
 * LLM 封装 — primary + fallback 双 provider
 * 使用 openai SDK（兼容 OpenAI-compatible API）
 */
import OpenAI from 'openai'

interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LLMOptions {
  model?: 'primary' | 'fallback'
  temperature?: number
  maxTokens?: number
  /** Non-stream hard timeout override in ms. Defaults to 30s. */
  timeoutMs?: number
  /** fallback 切换时的回调，用于调用方发 provider_switched SSE 事件 */
  onProviderSwitched?: (from: string, to: string, reason: string) => void
}

const PROVIDERS = {
  primary: {
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.SVC_LLM_PRIMARY_KEY || '',
    // deepseek-chat 别名 2026-07-24 15:59 UTC 废弃；当前别名已实际指向 v4-flash，改名零行为变化
    model: 'deepseek-v4-flash',
  },
  fallback: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.SVC_LLM_FALLBACK_KEY || '',
    model: 'qwen-plus',
  },
} as const

// 启动时校验：至少一个 provider 有 API Key
if (!PROVIDERS.primary.apiKey && !PROVIDERS.fallback.apiKey) {
  console.error('[SVC] LLM primary/fallback key 均未配置，AI 对话功能不可用')
}

function getClient(provider: 'primary' | 'fallback'): OpenAI {
  const cfg = PROVIDERS[provider]
  return new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey })
}

function shouldFallback(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    // 429 限流、5xx 服务端错误、401/403 Key 失效 → 全部尝试 fallback
    return err.status === 429 || err.status >= 500 || err.status === 401 || err.status === 403
  }
  // 网络错误、超时等非 API 错误也触发 fallback
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    return msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('fetch failed') || msg.includes('network')
  }
  return true
}

/** LLM HTTP 调用硬超时：非流式默认 30s（可由 timeoutMs 覆盖），流式 120s。 */
const LLM_TIMEOUT_MS = 30_000
const LLM_STREAM_TIMEOUT_MS = 120_000

/** 双 provider 均失败时返回此文案。export 给 extractKeywordsViaLLM 识别 fallback 结果 */
export const LLM_FALLBACK_REPLY = '抱歉，AI 服务暂时不可用，请稍后重试。如问题持续，请联系客服。'

/**
 * 普通（非流式）调用
 */
export async function callLLM(
  messages: LLMMessage[],
  options?: LLMOptions,
): Promise<string> {
  const pri: 'primary' | 'fallback' = options?.model || 'primary'
  const fb: 'primary' | 'fallback' = pri === 'primary' ? 'fallback' : 'primary'

  try {
    if (!PROVIDERS[pri].apiKey) throw new Error(`${pri} key 未配置`)
    return await doCall(pri, messages, options)
  } catch (err) {
    console.warn(`[SVC] ${pri} 调用失败:`, err instanceof Error ? err.message : err)
    if (shouldFallback(err) && PROVIDERS[fb].apiKey) {
      console.warn(`[SVC] fallback → ${fb}`)
      try {
        return await doCall(fb, messages, options)
      } catch (fbErr) {
        console.error(`[SVC] fallback ${fb} 也失败:`, fbErr instanceof Error ? fbErr.message : fbErr)
        return LLM_FALLBACK_REPLY
      }
    }
    return LLM_FALLBACK_REPLY
  }
}

async function doCall(
  provider: 'primary' | 'fallback',
  messages: LLMMessage[],
  options?: LLMOptions,
): Promise<string> {
  const client = getClient(provider)
  const cfg = PROVIDERS[provider]
  const controller = new AbortController()
  const timeoutMs = options?.timeoutMs ?? LLM_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await client.chat.completions.create({
      model: cfg.model,
      messages,
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? 2048,
    }, { signal: controller.signal })
    return res.choices[0]?.message?.content ?? ''
  } catch (err: any) {
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      console.warn(`[LLM] ${provider} doCall timeout ${timeoutMs}ms → abort`)
      throw new Error(`LLM ${provider} timeout after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 流式调用 — 返回 AsyncGenerator，逐 chunk yield 文本
 * 双 provider 均失败时 yield 兜底文案（不抛异常，保证 SSE 不中断）
 *
 * primary 直接逐 chunk yield（真正的流式体验）。
 * - 第一个 chunk 前就报错 → 调用 options.onProviderSwitched 回调通知切换，
 *   然后用 fallback 流式返回（dashscope compatible-mode 支持 stream:true）
 * - 中途失败（已有内容 yield 出去）→ 追加错误提示，不拼接 fallback
 */
export async function* callLLMStream(
  messages: LLMMessage[],
  options?: LLMOptions,
): AsyncGenerator<string> {
  const pri: 'primary' | 'fallback' = options?.model || 'primary'
  const fb: 'primary' | 'fallback' = pri === 'primary' ? 'fallback' : 'primary'

  // 尝试 primary 流式：直接逐 chunk yield
  let yieldedAny = false
  try {
    if (!PROVIDERS[pri].apiKey) throw new Error(`${pri} key 未配置`)
    for await (const chunk of doStream(pri, messages, options)) {
      yield chunk
      yieldedAny = true
    }
    return
  } catch (err) {
    console.warn(`[SVC] ${pri} stream 失败:`, err instanceof Error ? err.message : err)

    if (yieldedAny) {
      // 已有部分内容输出，不拼接 fallback，只追加提示
      yield '\n\n[回复中断，请重新发送]'
      return
    }

    // 第一个 chunk 前就失败 → 尝试 fallback
    if (shouldFallback(err) && PROVIDERS[fb].apiKey) {
      const reason = err instanceof OpenAI.APIError
        ? `HTTP ${err.status}`
        : err instanceof Error ? err.message.slice(0, 80) : 'unknown error'
      console.warn(`[SVC] stream fallback → ${fb}，reason=${reason}`)

      // 通知调用方发 provider_switched SSE 事件
      options?.onProviderSwitched?.(pri, fb, reason)

      try {
        // dashscope compatible-mode 支持 stream:true，直接走流式
        for await (const chunk of doStream(fb, messages, options)) {
          yield chunk
        }
        return
      } catch (fbErr) {
        console.error(`[SVC] fallback ${fb} 也失败:`, fbErr instanceof Error ? fbErr.message : fbErr)
      }
    }
  }

  yield LLM_FALLBACK_REPLY
}

/**
 * 联网搜索源（来自 Qwen DashScope 原生 enable_search 的 search_info.search_results）
 */
export interface SearchSource {
  title: string
  url: string
  site_name?: string
  index?: number
}

/** Qwen DashScope 原生接口（与 compatible-mode 不同；compatible-mode 不支持 enable_search） */
const DASHSCOPE_NATIVE_ENDPOINT =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation'

/**
 * Qwen 原生 DashScope 流式调用 + enable_search。
 *
 * 与 callLLMStream 区别：
 *   - callLLMStream 走 OpenAI compatible-mode（compatible-mode 不支持 enable_search）
 *   - 本函数走 DashScope 原生 API（支持 enable_search + 返回 search_info 引用源）
 *
 * 用于呼叫小智本地标准库 empty 时的联网降级路径。引用源通过 options.onSources 回调
 * 透出（在流式过程中一旦 search_info 出现就回调一次）。
 *
 * 失败/超时/无 key → yield LLM_FALLBACK_REPLY，调用方按字符串比对判断是否兜底。
 */
export async function* callQwenWithSearchStream(
  messages: LLMMessage[],
  options?: {
    temperature?: number
    maxTokens?: number
    onSources?: (sources: SearchSource[]) => void
  },
): AsyncGenerator<string> {
  // 历史拼接说明：调用方需自行把历史插入 messages 数组（在 system 之后、最新 user
  // 之前）。本函数不再访问 DB，与 streamSearchSummary / streamWriteOutline 等
  // 保持同样的「纯函数 + history 透传」模式。
  // 注意：直接读 env 而非 PROVIDERS.fallback.apiKey，因为后者在模块加载时冻结，
  // 单测里 beforeEach 修改 process.env 不会反映到 PROVIDERS
  const apiKey = process.env.SVC_LLM_FALLBACK_KEY || ''
  if (!apiKey) {
    console.warn('[Qwen Search] fallback key 未配置，无法联网搜索')
    yield LLM_FALLBACK_REPLY
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LLM_STREAM_TIMEOUT_MS)
  let yieldedAny = false
  let sourcesEmitted = false

  try {
    const resp = await fetch(DASHSCOPE_NATIVE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-SSE': 'enable',
      },
      body: JSON.stringify({
        model: 'qwen-plus',
        input: { messages },
        parameters: {
          enable_search: true,
          search_options: {
            forced_search: true,   // 强制走搜索（避免 LLM 自判断不搜）
            enable_source: true,   // 返回引用源
          },
          incremental_output: true,
          result_format: 'message',
          temperature: options?.temperature ?? 0.3,
          max_tokens: options?.maxTokens ?? 2048,
        },
      }),
      signal: controller.signal,
    })

    if (!resp.ok || !resp.body) {
      console.warn(`[Qwen Search] HTTP ${resp.status} ${resp.statusText}`)
      yield LLM_FALLBACK_REPLY
      return
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE 协议按 \n\n 分隔事件，每事件可能有多行（id:/event:/data:）
      const events = buffer.split('\n\n')
      buffer = events.pop() || ''

      for (const evt of events) {
        // 取 data: 开头的行（可能多行 data，拼起来）
        const dataLines: string[] = []
        for (const line of evt.split('\n')) {
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (dataLines.length === 0) continue
        const data = dataLines.join('')
        if (data === '[DONE]' || data === '') continue
        try {
          const json = JSON.parse(data)
          const output = json.output
          const choice = output?.choices?.[0]
          const content = choice?.message?.content
          if (typeof content === 'string' && content.length > 0) {
            yieldedAny = true
            yield content
          }
          // search_info 通常在前几个 chunk 之一里到来
          if (!sourcesEmitted && output?.search_info?.search_results) {
            const arr = output.search_info.search_results
            if (Array.isArray(arr)) {
              sourcesEmitted = true
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const sources: SearchSource[] = arr.map((s: any, i: number) => ({
                title: String(s.title || ''),
                url: String(s.url || ''),
                site_name: s.site_name ? String(s.site_name) : undefined,
                index: typeof s.index === 'number' ? s.index : i,
              })).filter((s: SearchSource) => s.url && s.title)
              if (sources.length > 0 && options?.onSources) {
                try { options.onSources(sources) } catch { /* 回调异常不影响主流程 */ }
              }
            }
          }
        } catch { /* 单 chunk 解析失败不致命 */ }
      }
    }

    if (!yieldedAny) {
      // 0 内容 → 兜底
      yield LLM_FALLBACK_REPLY
    }
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || controller.signal.aborted)
    console.warn(`[Qwen Search] stream ${isAbort ? 'timeout' : 'failed'}: ${err instanceof Error ? err.message : err}`)
    if (!yieldedAny) yield LLM_FALLBACK_REPLY
    else yield '\n\n[联网搜索中断，请重新发送]'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Embedding — 走 fallback provider（通义千问 DashScope）
 * 模型：text-embedding-v3（1024 维）
 * 支持 batch 输入（string[]），一次调用返回所有向量。
 * 5s 超时，失败直接 throw，不走 LLM 兜底。
 */
export async function getEmbedding(texts: string | string[]): Promise<number[][]> {
  const client = getClient('fallback')
  const input = Array.isArray(texts) ? texts : [texts]
  const controller = new AbortController()
  const EMBEDDING_TIMEOUT_MS = 5_000
  const timer = setTimeout(() => {
    controller.abort()
    console.warn(`[LLM] embedding timeout ${EMBEDDING_TIMEOUT_MS}ms → abort`)
  }, EMBEDDING_TIMEOUT_MS)
  try {
    const res = await client.embeddings.create(
      { model: 'text-embedding-v3', input },
      { signal: controller.signal },
    )
    // OpenAI SDK 返回 data 数组，按 index 排序后取 embedding
    return res.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding)
  } finally {
    clearTimeout(timer)
  }
}

async function* doStream(
  provider: 'primary' | 'fallback',
  messages: LLMMessage[],
  options?: LLMOptions,
): AsyncGenerator<string> {
  const client = getClient(provider)
  const cfg = PROVIDERS[provider]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LLM_STREAM_TIMEOUT_MS)
  try {
    const stream = await client.chat.completions.create({
      model: cfg.model,
      messages,
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? 2048,
      stream: true,
    }, { signal: controller.signal })
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (delta) yield delta
    }
  } catch (err: any) {
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      console.warn(`[LLM] ${provider} doStream timeout ${LLM_STREAM_TIMEOUT_MS}ms → abort`)
      throw new Error(`LLM ${provider} stream timeout after ${LLM_STREAM_TIMEOUT_MS}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
