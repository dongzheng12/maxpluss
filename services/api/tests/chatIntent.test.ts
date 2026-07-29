/**
 * chatIntent 意图识别单元测试
 *
 * 覆盖：
 *   - 新增场景（解读/分析/理解 → search；区别/对比 → compare；核心要求/主要内容 → search）
 *   - 原有 8 个意图各 1 个回归 case
 *
 * 注意：正则命中路径不调 LLM，detectIntent 直接同步返回，无需 mock。
 */
import { describe, it, expect } from 'vitest'
import { detectIntent } from '../src/services/chatIntent.js'

// ─── 新增场景：解读/分析/理解 → search ──────────────────────────
describe('新增场景 — 解读/分析/理解 → search', () => {
  it('帮我解读这个标准', async () => {
    const r = await detectIntent('帮我解读这个标准')
    expect(r.intent).toBe('search')
  })

  it('帮我分析 GB/T 1.1 这个标准', async () => {
    const r = await detectIntent('帮我分析 GB/T 1.1 这个标准')
    expect(r.intent).toBe('search')
  })

  it('帮我理解这份标准的内容', async () => {
    const r = await detectIntent('帮我理解这份标准的内容')
    expect(r.intent).toBe('search')
  })
})

// ─── 新增场景：区别/对比 → compare ──────────────────────────────
describe('新增场景 — 区别/对比 → compare', () => {
  it('这个标准和那个标准有什么区别', async () => {
    const r = await detectIntent('这个标准和那个标准有什么区别')
    expect(r.intent).toBe('compare')
  })

  it('两个标准的区别是什么', async () => {
    const r = await detectIntent('两个标准的区别是什么')
    expect(r.intent).toBe('compare')
  })

  it('GB 2760 和 GB 14880 有何不同', async () => {
    const r = await detectIntent('GB 2760 和 GB 14880 有何不同')
    expect(r.intent).toBe('compare')
  })
})

// ─── 新增场景：核心要求/主要内容 → search ───────────────────────
describe('新增场景 — 核心要求/主要内容 → search', () => {
  it('这个标准的核心要求是什么', async () => {
    const r = await detectIntent('这个标准的核心要求是什么')
    expect(r.intent).toBe('search')
  })

  it('GB/T 1.1 的主要内容是什么', async () => {
    const r = await detectIntent('GB/T 1.1 的主要内容是什么')
    expect(r.intent).toBe('search')
  })

  it('主要规定有哪些', async () => {
    const r = await detectIntent('主要规定有哪些')
    expect(r.intent).toBe('search')
  })
})

// ─── 原有意图回归（各抽 1 个 case）────────────────────────────────
describe('原有意图回归', () => {
  it('compare：对比两个标准', async () => {
    const r = await detectIntent('帮我对比这两个标准')
    expect(r.intent).toBe('compare')
  })

  it('scan：扫一扫', async () => {
    const r = await detectIntent('扫一扫识别这本书')
    expect(r.intent).toBe('scan')
  })

  it('write：帮我写标准', async () => {
    const r = await detectIntent('帮我写一份标准大纲')
    expect(r.intent).toBe('write')
  })

  it('task_status：任务进度查询', async () => {
    const r = await detectIntent('查一下任务进度')
    expect(r.intent).toBe('task_status')
  })

  it('member：价格查询', async () => {
    const r = await detectIntent('会员价格多少钱')
    expect(r.intent).toBe('member')
  })

  it('search：查标准', async () => {
    const r = await detectIntent('查一下焊接相关标准')
    expect(r.intent).toBe('search')
  })

  it('search：标准号直接命中', async () => {
    const r = await detectIntent('GB/T 1.1-2020')
    expect(r.intent).toBe('search')
    expect(r.standardNo).toMatch(/GB/)
  })
})
