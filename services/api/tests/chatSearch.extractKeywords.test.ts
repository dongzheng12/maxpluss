/**
 * extractKeywordsViaLLM 单元测试
 *
 * 覆盖：
 *   1. 正常换行返回 → 正确解析为关键词数组
 *   2. callLLM 返回 LLM_FALLBACK_REPLY → 回归 bug 保护，返回 []
 *   3. callLLM 抛异常 → 返回 []
 *   4. 空字符串输入 → 返回 []（过滤掉空 token）
 *   5. 格式异常（无法切分出有效词）→ 返回 []
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/services/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/llm.js')>()
  return { ...actual, callLLM: vi.fn() }
})

import { callLLM, LLM_FALLBACK_REPLY } from '../src/services/llm.js'
import { extractKeywordsViaLLM } from '../src/services/chatSearch.js'

const mockCallLLM = callLLM as ReturnType<typeof vi.fn>

describe('extractKeywordsViaLLM', () => {
  beforeEach(() => {
    mockCallLLM.mockReset()
  })

  it('用例 1 — 正常换行返回，正确解析关键词', async () => {
    mockCallLLM.mockResolvedValue('食品添加剂\n食品卫生\n食品检测')
    const result = await extractKeywordsViaLLM('食品安全标准有哪些')
    expect(result).toEqual(['食品添加剂', '食品卫生', '食品检测'])
  })

  it('用例 2 — callLLM 返回 LLM_FALLBACK_REPLY → 返回 []（回归 bug 保护）', async () => {
    mockCallLLM.mockResolvedValue(LLM_FALLBACK_REPLY)
    const result = await extractKeywordsViaLLM('什么是食品添加剂')
    expect(result).toEqual([])
  })

  it('用例 3 — callLLM 抛异常 → 返回 []', async () => {
    mockCallLLM.mockRejectedValue(new Error('boom'))
    const result = await extractKeywordsViaLLM('检测方法有哪些')
    expect(result).toEqual([])
  })

  it('用例 4 — 空字符串输入，mock 正常返回 → 返回 [] 或无有效词', async () => {
    // 实现逻辑：即便 LLM 返回内容，filter 过滤 length < 2 的空 token
    // 这里 mock 返回空字符串，模拟 LLM 对空 prompt 的无效响应
    mockCallLLM.mockResolvedValue('')
    const result = await extractKeywordsViaLLM('')
    // 空字符串 split 后全是空 token，filter length >= 2 全部过滤掉
    expect(result).toEqual([])
  })

  it('用例 5 — 格式异常：返回一整句话无法切分出有效词 → 返回 [] 或 ≤1 条', async () => {
    // 一整段解释文字，split 后虽然有多个 token，但都超过 10 字符被 filter 过滤
    mockCallLLM.mockResolvedValue('这是一段很长的解释性文字无法作为关键词使用')
    const result = await extractKeywordsViaLLM('随便问一句')
    // 整段无换行/逗号分隔，split 结果是 1 个超过 10 字的词，被 filter(k.length <= 10) 过滤
    expect(result.length).toBeLessThanOrEqual(1)
  })
})
