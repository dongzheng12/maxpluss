/**
 * chatSearch — embedding cosine 重排单元测试
 *
 * mock getEmbedding，验证：
 * 1. related 态 + 合理向量 → 重排后最相似结果排第一
 * 2. getEmbedding 抛异常 → 保持原 BM25 顺序，不抛错
 * 3. exact 态不触发重排（getEmbedding 调用次数 = 0）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mock llm 模块（getEmbedding） ─────────────────────────────────────────
vi.mock('../src/services/llm.js', () => ({
  callLLM: vi.fn().mockResolvedValue(''),
  callLLMStream: vi.fn(async function* () { yield '' }),
  LLM_FALLBACK_REPLY: '抱歉，AI 服务暂时不可用，请稍后重试。如问题持续，请联系客服。',
  getEmbedding: vi.fn(),
}))

// ── mock pyapi fetch（让 searchStandards 能返回可控的 hits） ───────────────
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { searchStandards } from '../src/services/chatSearch.js'
import { getEmbedding } from '../src/services/llm.js'

// ── 工具函数 ────────────────────────────────────────────────────────────────

/** 构造 pyapi 返回的搜索结果 */
function makePyapiResponse(
  items: Array<{ code: string; name: string; score: number }>,
) {
  return {
    results: items.map(it => ({
      code: it.code,
      name: it.name,
      _score: it.score,
      status: '现行',
      pub_date: '2020-01-01',
      impl_date: '2020-06-01',
      industry: '机械',
      tc_committee: '',
      issuing_dept: '',
      replaces: '',
      replaced_by: '',
      scope: '',
    })),
  }
}

/** 构造一个单位向量（对应维度 i 置 1，其他 0）*/
function unitVec(dim: number, size = 8): number[] {
  return Array.from({ length: size }, (_, i) => (i === dim ? 1 : 0))
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── 用例 1：related 态 + 合理向量 → 第二条排到第一 ─────────────────────────
describe('chatSearch — embedding rerank', () => {
  it('related 态：按 cosine 重排，最相似结果排第一', async () => {
    // pyapi 返回 3 条 related 结果（score 10-99）
    const pyapiData = makePyapiResponse([
      { code: 'GB/T 100', name: '机械安全 A', score: 30 },
      { code: 'GB/T 200', name: '机械安全 B', score: 25 },
      { code: 'GB/T 300', name: '机械安全 C', score: 20 },
    ])
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => pyapiData,
      status: 200,
    })

    // query 向量：dim 0
    // GB/T 100 向量：dim 1（最远）
    // GB/T 200 向量：dim 0（最近）
    // GB/T 300 向量：dim 2
    const queryVec = unitVec(0)
    const vec100 = unitVec(1)   // cosine = 0
    const vec200 = unitVec(0)   // cosine = 1（最近）
    const vec300 = unitVec(2)   // cosine = 0
    ;(getEmbedding as ReturnType<typeof vi.fn>).mockResolvedValue(
      [queryVec, vec100, vec200, vec300],
    )

    const result = await searchStandards('机械安全', ['机械', '安全'])

    expect(result.matchQuality).toBe('related')
    // 重排后 GB/T 200 应排第一
    expect(result.searchResultsEvent.items[0].code).toBe('GB/T 200')
    expect(result.hits[0].code).toBe('GB/T 200')
    // getEmbedding 被调用一次，参数包含 query + 3 条 hits
    expect(getEmbedding).toHaveBeenCalledTimes(1)
    const callArg = (getEmbedding as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
    expect(callArg[0]).toBe('机械安全')
    expect(callArg).toHaveLength(4) // query + 3 hits
  })

  // ── 用例 2：getEmbedding 抛异常 → 保持原 BM25 顺序，不抛错 ─────────────
  it('getEmbedding 抛异常 → 保持原 BM25 顺序，不抛错', async () => {
    const pyapiData = makePyapiResponse([
      { code: 'GB/T 100', name: '机械安全 A', score: 30 },
      { code: 'GB/T 200', name: '机械安全 B', score: 25 },
    ])
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => pyapiData,
      status: 200,
    })

    ;(getEmbedding as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('embedding timeout'),
    )

    // 不应抛错
    const result = await searchStandards('机械安全', ['机械'])
    expect(result.matchQuality).toBe('related')
    // 保持 BM25 原顺序（GB/T 100 仍第一）
    expect(result.searchResultsEvent.items[0].code).toBe('GB/T 100')
    expect(result.hits[0].code).toBe('GB/T 100')
  })

  // ── 用例 3：exact 态不触发重排 ────────────────────────────────────────────
  it('exact 态不触发重排（getEmbedding 调用次数 = 0）', async () => {
    // exact：score >= 100
    const pyapiData = makePyapiResponse([
      { code: 'GB/T 100', name: '机械安全 A', score: 120 },
      { code: 'GB/T 200', name: '机械安全 B', score: 110 },
    ])
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => pyapiData,
      status: 200,
    })

    const result = await searchStandards('GB/T 100', ['GB/T 100'])
    expect(result.matchQuality).toBe('exact')
    expect(getEmbedding).not.toHaveBeenCalled()
  })
})
