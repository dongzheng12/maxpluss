/**
 * salesProducts.ts 单元测试
 * 覆盖：
 *   - SALES_PRODUCTS 常量结构稳定（防 PR 误删字段）
 *   - isValidProductCode：合法/非法/空串/非字符串
 *   - getProductByCode：命中/未命中
 *   - validateDisplayProducts：
 *      * 非数组、超过 4 个、元素非对象、code 非法、sort 非整数、code 重复 → 抛错
 *      * 合法输入按 sort 升序输出
 *      * 空数组合法
 */
import { describe, it, expect } from 'vitest'
import {
  SALES_PRODUCTS,
  isValidProductCode,
  getProductByCode,
  validateDisplayProducts,
  type SalesProduct,
} from '../src/services/salesProducts.js'

describe('SALES_PRODUCTS 常量结构', () => {
  it('至少包含 4 个产品（xiaozhi/guan/bian/kong）', () => {
    const codes = SALES_PRODUCTS.map(p => p.code)
    expect(codes).toEqual(expect.arrayContaining(['xiaozhi', 'guan', 'bian', 'kong']))
  })

  it('每个产品都包含必填字段且类型正确', () => {
    for (const p of SALES_PRODUCTS) {
      expect(typeof p.code).toBe('string')
      expect(typeof p.name).toBe('string')
      expect(typeof p.slogan).toBe('string')
      expect(typeof p.description).toBe('string')
      expect(typeof p.targetUsers).toBe('string')
      expect(Array.isArray(p.features)).toBe(true)
      expect(p.features.length).toBeGreaterThan(0)
      expect(['REGISTER', 'CONTACT', 'INTRO_CONTACT']).toContain(p.actionType)
      expect(typeof p.ctaLabel).toBe('string')
    }
  })

  it('code 全局唯一', () => {
    const codes = SALES_PRODUCTS.map(p => p.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('xiaozhi 是 REGISTER 类型（小程序立即体验）', () => {
    const xz = SALES_PRODUCTS.find(p => p.code === 'xiaozhi') as SalesProduct
    expect(xz.actionType).toBe('REGISTER')
  })
})

describe('isValidProductCode', () => {
  it('合法 code → true', () => {
    expect(isValidProductCode('xiaozhi')).toBe(true)
    expect(isValidProductCode('guan')).toBe(true)
    expect(isValidProductCode('bian')).toBe(true)
    expect(isValidProductCode('kong')).toBe(true)
  })

  it('非法 code → false', () => {
    expect(isValidProductCode('not-a-product')).toBe(false)
    expect(isValidProductCode('')).toBe(false)
    expect(isValidProductCode('XIAOZHI')).toBe(false) // 大小写敏感
  })
})

describe('getProductByCode', () => {
  it('命中 → 返回完整对象', () => {
    const p = getProductByCode('xiaozhi')
    expect(p).toBeDefined()
    expect(p!.name).toBe('标准小智AI')
    expect(p!.actionType).toBe('REGISTER')
  })

  it('未命中 → undefined', () => {
    expect(getProductByCode('nope')).toBeUndefined()
    expect(getProductByCode('')).toBeUndefined()
  })
})

describe('validateDisplayProducts', () => {
  it('非数组 → 抛错', () => {
    expect(() => validateDisplayProducts(null)).toThrow('必须是数组')
    expect(() => validateDisplayProducts({})).toThrow('必须是数组')
    expect(() => validateDisplayProducts('xiaozhi')).toThrow('必须是数组')
  })

  it('空数组 → 合法返回 []', () => {
    expect(validateDisplayProducts([])).toEqual([])
  })

  it('> 4 个 → 抛错', () => {
    const tooMany = [
      { code: 'xiaozhi', sort: 1 },
      { code: 'guan', sort: 2 },
      { code: 'bian', sort: 3 },
      { code: 'kong', sort: 4 },
      { code: 'xiaozhi', sort: 5 }, // 超数（同时也会触发重复）
    ]
    expect(() => validateDisplayProducts(tooMany)).toThrow('最多 4 个')
  })

  it('元素非对象 → 抛错', () => {
    expect(() => validateDisplayProducts(['xiaozhi'])).toThrow('元素必须是对象')
    expect(() => validateDisplayProducts([null])).toThrow('元素必须是对象')
  })

  it('code 不在白名单 → 抛错', () => {
    expect(() => validateDisplayProducts([{ code: 'fake', sort: 1 }])).toThrow('code 不合法')
  })

  it('code 不是字符串 → 抛错', () => {
    expect(() => validateDisplayProducts([{ code: 123, sort: 1 }])).toThrow('code 不合法')
  })

  it('sort 不是整数 → 抛错', () => {
    expect(() => validateDisplayProducts([{ code: 'xiaozhi', sort: 1.5 }])).toThrow('sort 必须是整数')
    expect(() => validateDisplayProducts([{ code: 'xiaozhi', sort: '1' }])).toThrow('sort 必须是整数')
    expect(() => validateDisplayProducts([{ code: 'xiaozhi', sort: NaN }])).toThrow('sort 必须是整数')
  })

  it('code 重复 → 抛错', () => {
    expect(() =>
      validateDisplayProducts([
        { code: 'xiaozhi', sort: 1 },
        { code: 'xiaozhi', sort: 2 },
      ]),
    ).toThrow('重复')
  })

  it('合法输入 → 按 sort 升序输出', () => {
    const r = validateDisplayProducts([
      { code: 'guan', sort: 3 },
      { code: 'xiaozhi', sort: 1 },
      { code: 'bian', sort: 2 },
    ])
    expect(r).toEqual([
      { code: 'xiaozhi', sort: 1 },
      { code: 'bian', sort: 2 },
      { code: 'guan', sort: 3 },
    ])
  })

  it('合法输入 sort 可为负数', () => {
    const r = validateDisplayProducts([
      { code: 'xiaozhi', sort: -1 },
      { code: 'guan', sort: 0 },
    ])
    expect(r[0].code).toBe('xiaozhi')
    expect(r[1].code).toBe('guan')
  })

  it('返回数组与输入对象不同引用（保护原 props）', () => {
    const input = [{ code: 'xiaozhi', sort: 1, extra: 'ignored' } as any]
    const r = validateDisplayProducts(input)
    expect(r[0]).not.toBe(input[0])
    expect((r[0] as any).extra).toBeUndefined()
  })
})
