/**
 * 标准编号验证器单测 — Phase C-2 / 方案 §3.3
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  extractStandardCodes,
  normalizeCode,
  verifyStandardCode,
  verifyStandardCodes,
  __clearReferenceValidatorCache,
} from '../src/services/stdReferenceValidator.js'

describe('extractStandardCodes', () => {
  it('抽取多种标准家族编号', () => {
    const text = `本文件按照 GB/T 1.1-2020 起草，引用 GB 50011-2010、HJ 25.1-2019 和 YY/T 0287-2017。`
    expect(extractStandardCodes(text)).toEqual([
      'GB/T 1.1-2020',
      'GB 50011-2010',
      'HJ 25.1-2019',
      'YY/T 0287-2017',
    ])
  })

  it('去重且保持首次出现顺序', () => {
    const text = `GB/T 1.1-2020 ... GB 50011-2010 ... GB/T 1.1-2020`
    expect(extractStandardCodes(text)).toEqual(['GB/T 1.1-2020', 'GB 50011-2010'])
  })

  it('归一化变体：GBT / 多空格 / 连字符变体 → 同一编号', () => {
    const text = `参见 GBT  1.1 - 2020、gb/t1.1-2020 和 GB/T 1.1-2020`
    const codes = extractStandardCodes(text)
    expect(codes).toContain('GB/T 1.1-2020')
    expect(codes.filter((c) => c === 'GB/T 1.1-2020')).toHaveLength(1)
  })

  it('忽略 [待核实：xxx] 占位包裹的编号', () => {
    const text = `[待核实：GB/T 9999-2099] 是占位符；正常引用 GB 50011-2010 应保留。`
    const codes = extractStandardCodes(text)
    expect(codes).toContain('GB 50011-2010')
    expect(codes).not.toContain('GB/T 9999-2099')
  })

  it('不命中字母数字混合的非编号串（如 SHA256ABC123）', () => {
    expect(extractStandardCodes('SHA256ABC123 / VERSION1234')).toEqual([])
  })

  it('支持不带年份的编号（如 HJ 25.1）', () => {
    const codes = extractStandardCodes('参考 HJ 25.1 和 GB 5749')
    expect(codes).toContain('HJ 25.1')
    expect(codes).toContain('GB 5749')
  })

  it('空文本返回空数组', () => {
    expect(extractStandardCodes('')).toEqual([])
  })
})

describe('normalizeCode', () => {
  it.each([
    ['GB/T 1.1-2020', 'GB/T 1.1-2020'],
    ['gb/t  1.1 - 2020', 'GB/T 1.1-2020'],
    ['GBT 1.1-2020', 'GB/T 1.1-2020'],
    ['gb-t1.1-2020', 'GB/T 1.1-2020'],
    ['GB 50011-2010', 'GB 50011-2010'],
    ['HJ 25.1', 'HJ 25.1'],
    ['YY/T 0287-2017', 'YY/T 0287-2017'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeCode(input)).toBe(expected)
  })

  it('无法识别返回空字符串', () => {
    expect(normalizeCode('hello')).toBe('')
    expect(normalizeCode('')).toBe('')
  })
})

describe('verifyStandardCode / verifyStandardCodes — 集成（mock fetch）', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    __clearReferenceValidatorCache()
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('单个：命中 → VerifiedItem', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [{ code: 'GB 50011-2010', name: '建筑抗震设计标准', status: '现行', impl_date: '2010-12-01' }],
      }),
    })) as any
    const r = await verifyStandardCode('GB 50011-2010')
    expect('title' in r).toBe(true)
    expect((r as any).title).toBe('建筑抗震设计标准')
    expect((r as any).status).toBe('现行')
  })

  it('单个：未命中（results 为空）→ UnverifiedItem reason=not_found', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [] }),
    })) as any
    const r = await verifyStandardCode('GB 99999-2099')
    expect('title' in r).toBe(false)
    expect((r as any).reason).toBe('not_found')
  })

  it('单个：返回结果但 code 不严格相等 → not_found（防 LLM 编号略写）', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [{ code: 'GB 50011.1-2010', name: '近似标准', status: '现行' }],
      }),
    })) as any
    const r = await verifyStandardCode('GB 50011-2010')
    expect((r as any).reason).toBe('not_found')
  })

  it('单个：5xx → reason=error', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as any
    const r = await verifyStandardCode('GB 50011-2010')
    expect((r as any).reason).toBe('error')
  })

  it('单个：AbortError → reason=timeout', async () => {
    globalThis.fetch = vi.fn(async () => {
      const err: any = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }) as any
    const r = await verifyStandardCode('GB 50011-2010')
    expect((r as any).reason).toBe('timeout')
  })

  it('批量：verified / unverified 各归位', async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url)
      if (u.includes('GB%2050011-2010')) {
        return {
          ok: true,
          json: async () => ({ results: [{ code: 'GB 50011-2010', name: '建筑抗震', status: '现行' }] }),
        } as any
      }
      return { ok: true, json: async () => ({ results: [] }) } as any
    }) as any

    const r = await verifyStandardCodes(['GB 50011-2010', 'GB 99999-2099'])
    expect(r.verified).toHaveLength(1)
    expect(r.verified[0].code).toBe('GB 50011-2010')
    expect(r.unverified).toHaveLength(1)
    expect(r.unverified[0].code).toBe('GB 99999-2099')
  })

  it('批量：空输入快返回', async () => {
    const r = await verifyStandardCodes([])
    expect(r).toEqual({ verified: [], unverified: [] })
  })

  it('缓存命中：第二次调用同编号不再 fetch', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [{ code: 'GB 50011-2010', name: '建筑抗震', status: '现行' }] }),
    })) as any
    globalThis.fetch = mockFetch
    await verifyStandardCode('GB 50011-2010')
    await verifyStandardCode('GB 50011-2010')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
