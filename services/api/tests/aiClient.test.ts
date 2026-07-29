/**
 * #4 二轮：callStandardAI 必须传 maxTokens=8192，防 llm.ts 默认 2048 截断长 JSON。
 * 大文档解析还必须传 timeoutMs=120s，防 llm.ts 非流式默认 30s 先切断。
 * 根因：GB/T1032 单段提取输出超 2048 tokens → Unterminated string → AI_INVALID_JSON（7/8 段失败）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// 关掉本地 mock 分支，强制走 callLLM
vi.mock('../src/standard-execution/localAiMock.js', () => ({
  isLocalAiMockEnabled: () => false,
  buildLocalStandardAiMockResponse: () => '[]',
}))
// mock callLLM 捕获调用参数
vi.mock('../src/services/llm', () => ({ callLLM: vi.fn().mockResolvedValue('[]') }))

import { callLLM } from '../src/services/llm'
import { callStandardAI } from '../src/standard-execution/aiClient.js'

describe('callStandardAI LLM options', () => {
  beforeEach(() => vi.clearAllMocks())

  it('调 callLLM 时传 maxTokens=8192 与 timeoutMs=120s', async () => {
    await callStandardAI('提取所有可执行要求项的 prompt')
    expect(callLLM).toHaveBeenCalledTimes(1)
    expect(callLLM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxTokens: 8192, temperature: 0, timeoutMs: 120_000 }),
    )
  })

  it('maxTokens 远大于旧默认 2048，timeoutMs 远大于旧默认 30s', async () => {
    await callStandardAI('x')
    const opts = (callLLM as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as { maxTokens: number; timeoutMs: number }
    expect(opts.maxTokens).toBeGreaterThanOrEqual(8192)
    expect(opts.maxTokens).toBeGreaterThan(2048)
    expect(opts.timeoutMs).toBe(120_000)
    expect(opts.timeoutMs).toBeGreaterThan(30_000)
  })
})
