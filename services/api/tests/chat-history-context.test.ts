/**
 * 对话历史拼接测试 — 验证所有 5 个 stream 函数都把 history 透传给 LLM
 *
 * 覆盖：
 *  - streamSearchSummary / streamRelatedSummary / streamWriteOutline /
 *    streamWriteFramework：history 参数透传到 callLLMStream 的 messages
 *  - callQwenWithSearchStream：history 直接由调用方插到 messages 数组
 *  - 缺省 history（undefined）→ 仅 [system, user]
 *  - 空数组 history → 仅 [system, user]
 *  - 有 history → [system, ...history, user]
 */
import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'
import * as llm from '../src/services/llm.js'

const ORIGINAL_callLLMStream = llm.callLLMStream

afterAll(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.restoreAllMocks()
})

/** 捕获最后一次 callLLMStream 的 messages 参数 */
function spyOnCallLLMStream(): { lastMessages?: llm.LLMMessage[] } {
  const captured: { lastMessages?: llm.LLMMessage[] } = {}
  vi.spyOn(llm, 'callLLMStream').mockImplementation(async function* (messages, _options) {
    captured.lastMessages = messages
    yield 'mocked-output'
  })
  return captured
}

// ════════════════════════════════════════════════════════════
// streamSearchSummary / streamRelatedSummary（chatSearch.ts）
// ════════════════════════════════════════════════════════════

describe('streamSearchSummary — history 透传', () => {
  it('无 history（undefined）→ [system, user] 两条', async () => {
    const captured = spyOnCallLLMStream()
    const { streamSearchSummary } = await import('../src/services/chatSearch.js')
    for await (const _c of streamSearchSummary([], 'GB 4806 是什么？', 0)) { void _c }
    expect(captured.lastMessages).toHaveLength(2)
    expect(captured.lastMessages?.[0].role).toBe('system')
    expect(captured.lastMessages?.[1].role).toBe('user')
    expect(captured.lastMessages?.[1].content).toBe('GB 4806 是什么？')
  })

  it('有 history → [system, ...history, user] 顺序正确', async () => {
    const captured = spyOnCallLLMStream()
    const { streamSearchSummary } = await import('../src/services/chatSearch.js')
    const history: llm.LLMMessage[] = [
      { role: 'user', content: '上一条用户' },
      { role: 'assistant', content: '上一条助手' },
    ]
    for await (const _c of streamSearchSummary([], '它最新版是哪个？', 0, history)) { void _c }
    expect(captured.lastMessages).toHaveLength(4)
    expect(captured.lastMessages?.[0].role).toBe('system')
    expect(captured.lastMessages?.[1].content).toBe('上一条用户')
    expect(captured.lastMessages?.[2].content).toBe('上一条助手')
    expect(captured.lastMessages?.[3]).toEqual({ role: 'user', content: '它最新版是哪个？' })
  })

  it('空 history 数组 → 等价 undefined', async () => {
    const captured = spyOnCallLLMStream()
    const { streamSearchSummary } = await import('../src/services/chatSearch.js')
    for await (const _c of streamSearchSummary([], 'x', 0, [])) { void _c }
    expect(captured.lastMessages).toHaveLength(2)
  })
})

describe('streamRelatedSummary — history 透传', () => {
  it('history 顺序正确', async () => {
    const captured = spyOnCallLLMStream()
    const { streamRelatedSummary } = await import('../src/services/chatSearch.js')
    const history: llm.LLMMessage[] = [
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
    ]
    for await (const _c of streamRelatedSummary([], 'Q2', 0, history)) { void _c }
    expect(captured.lastMessages?.length).toBe(4)
    expect(captured.lastMessages?.[1].content).toBe('Q1')
    expect(captured.lastMessages?.[3].content).toBe('Q2')
  })
})

// ════════════════════════════════════════════════════════════
// streamWriteOutline / streamWriteFramework（chatStdWriting.ts）
// ════════════════════════════════════════════════════════════

describe('streamWriteOutline — history 透传', () => {
  it('history 顺序正确', async () => {
    const captured = spyOnCallLLMStream()
    const { streamWriteOutline } = await import('../src/services/chatStdWriting.js')
    const history: llm.LLMMessage[] = [
      { role: 'user', content: '前置 Q' },
      { role: 'assistant', content: '前置 A' },
    ]
    for await (const _c of streamWriteOutline('帮我起草一份食品标准', history)) { void _c }
    expect(captured.lastMessages).toHaveLength(4)
    expect(captured.lastMessages?.[0].role).toBe('system')
    expect(captured.lastMessages?.[1].content).toBe('前置 Q')
    expect(captured.lastMessages?.[3]).toEqual({ role: 'user', content: '帮我起草一份食品标准' })
  })

  it('缺省 history（向后兼容）→ [system, user]', async () => {
    const captured = spyOnCallLLMStream()
    const { streamWriteOutline } = await import('../src/services/chatStdWriting.js')
    for await (const _c of streamWriteOutline('帮我起草一份食品标准')) { void _c }
    expect(captured.lastMessages).toHaveLength(2)
  })
})

describe('streamWriteFramework — history 透传', () => {
  it('history 顺序正确', async () => {
    const captured = spyOnCallLLMStream()
    const { streamWriteFramework } = await import('../src/services/chatStdWriting.js')
    const history: llm.LLMMessage[] = [
      { role: 'user', content: '前置 Q' },
      { role: 'assistant', content: '前置 A' },
    ]
    for await (const _c of streamWriteFramework('1. 范围\n2. 术语', history)) { void _c }
    expect(captured.lastMessages).toHaveLength(4)
    expect(captured.lastMessages?.[1].content).toBe('前置 Q')
    // user 消息以"请根据以下大纲..."开头（chatStdWriting 内部包装）
    expect(captured.lastMessages?.[3].role).toBe('user')
    expect(captured.lastMessages?.[3].content).toContain('1. 范围')
  })
})

// ════════════════════════════════════════════════════════════
// callQwenWithSearchStream — history 走 messages 参数（调用方自拼）
// ════════════════════════════════════════════════════════════

describe('callQwenWithSearchStream — history 由调用方拼到 messages', () => {
  beforeEach(() => {
    process.env.SVC_LLM_FALLBACK_KEY = 'test'
  })

  it('messages 参数原样作为 input.messages 发到 DashScope', async () => {
    let capturedBody: Record<string, unknown> = {}
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder()
            controller.enqueue(enc.encode('data: {"output":{"choices":[{"message":{"content":"ok"}}]}}\n\n'))
            controller.close()
          },
        }),
      }
    }) as never

    const messages: llm.LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ]
    const chunks: string[] = []
    for await (const c of llm.callQwenWithSearchStream(messages)) { chunks.push(c) }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input = (capturedBody as any).input
    expect(input.messages).toEqual(messages)
    expect(chunks.join('')).toBe('ok')
  })
})
