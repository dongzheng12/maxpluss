/**
 * buildCompressedHistory 单元测试
 * - 短对话不压缩
 * - 长对话触发摘要压缩
 * - callLLM 返回 LLM_FALLBACK_REPLY 时降级到最近 4 条
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock llm 模块，必须在 import 目标模块前声明
vi.mock('../src/services/llm.js', () => ({
  LLM_FALLBACK_REPLY: '抱歉，AI 服务暂时不可用，请稍后重试。如问题持续，请联系客服。',
  callLLM: vi.fn(),
  callLLMStream: vi.fn(),
}))

// mock prisma，防止 chat.ts 路由模块在 import 时尝试连数据库
vi.mock('../src/db.js', () => ({
  prisma: {
    conversation: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    chatMessage: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  },
}))

import { buildCompressedHistory } from '../src/routes/chat.js'
import { callLLM, LLM_FALLBACK_REPLY } from '../src/services/llm.js'

const mockCallLLM = vi.mocked(callLLM)

// 生成指定字符数的内容
function makeContent(chars: number): string {
  return 'x'.repeat(chars)
}

function makeHistory(count: number, charsEach: number): Array<{ role: string; content: string }> {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: makeContent(charsEach),
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildCompressedHistory', () => {
  it('短对话（总字符 < 6000）不触发压缩，原样返回', async () => {
    // 4 条 × 100 字 = 400 字，远低于 6000
    const history = makeHistory(4, 100)
    const result = await buildCompressedHistory(history)

    expect(mockCallLLM).not.toHaveBeenCalled()
    expect(result).toHaveLength(4)
    expect(result).toEqual(history)
  })

  it('长对话（> 6000 字符）触发压缩，返回 1 条 system 摘要 + 最近 4 条原文', async () => {
    mockCallLLM.mockResolvedValue('这是摘要内容。')

    // 8 条 × 1000 字 = 8000 字，超过 6000 阈值
    const history = makeHistory(8, 1000)
    const result = await buildCompressedHistory(history)

    expect(mockCallLLM).toHaveBeenCalledOnce()
    // 1 条 system 摘要 + 4 条原文
    expect(result).toHaveLength(5)
    expect(result[0].role).toBe('system')
    expect(result[0].content).toContain('[历史摘要]')
    expect(result[0].content).toContain('这是摘要内容。')
    // 最近 4 条与原 history 最后 4 条一致
    expect(result.slice(1)).toEqual(history.slice(-4))
  })

  it('callLLM 返回 LLM_FALLBACK_REPLY → 降级，只返回最近 4 条原文', async () => {
    mockCallLLM.mockResolvedValue(LLM_FALLBACK_REPLY)

    // 10 条 × 800 字 = 8000 字
    const history = makeHistory(10, 800)
    const result = await buildCompressedHistory(history)

    expect(mockCallLLM).toHaveBeenCalledOnce()
    // 降级：只返回最近 4 条，无 system 摘要
    expect(result).toHaveLength(4)
    expect(result.every((m) => m.role !== 'system')).toBe(true)
    expect(result).toEqual(history.slice(-4))
  })
})
