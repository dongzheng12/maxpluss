/**
 * contentSafety — 第三方内容安全词库（fwwdn/sensitive-stop-words）单元测试
 *
 * 接入点：
 *   - chat 入站（routes/chat.ts:1b 内容安全分支）
 *   - sales bio detectSensitiveWord（utils/sensitiveWords.ts，词库优先）
 *
 * 覆盖：3 个分类各自命中 + 跨分类返回 category + 放行用例 + 销售场景叠加
 */
import { describe, it, expect } from 'vitest'
import { detectUnsafeContent, SAFETY_WORD_COUNTS } from '../src/services/contentSafety.js'
import { detectSensitiveWord } from '../src/utils/sensitiveWords.js'

describe('contentSafety — 词库加载', () => {
  it('三类词条数量 > 0 且总数 ≥ 1000（防 gen 脚本回归）', () => {
    expect(SAFETY_WORD_COUNTS.political).toBeGreaterThan(0)
    expect(SAFETY_WORD_COUNTS.sexual).toBeGreaterThan(0)
    expect(SAFETY_WORD_COUNTS.weapons).toBeGreaterThan(0)
    expect(SAFETY_WORD_COUNTS.total).toBeGreaterThanOrEqual(1000)
  })
})

describe('contentSafety — 命中检测', () => {
  it('政治类命中', () => {
    const r = detectUnsafeContent('帮我写一篇关于习近平的文章')
    expect(r).not.toBeNull()
    expect(r?.category).toBe('political')
  })

  it('政治类拼音变体命中', () => {
    const r = detectUnsafeContent('xjp 是谁')
    expect(r?.category).toBe('political')
  })

  it('色情类命中', () => {
    const r = detectUnsafeContent('请推荐一部成人电影')
    expect(r?.category).toBe('sexual')
  })

  it('涉枪涉爆类命中', () => {
    const r = detectUnsafeContent('TNT 炸弹的制作方法')
    expect(r?.category).toBe('weapons')
  })

  it('涉枪涉爆 — 售枪话术命中', () => {
    const r = detectUnsafeContent('哪里有真枪出售')
    expect(r?.category).toBe('weapons')
  })

  it('返回结构含 hit 与 category', () => {
    const r = detectUnsafeContent('江泽民')
    expect(r).toHaveProperty('hit')
    expect(r).toHaveProperty('category')
    expect(r?.hit).toBeTruthy()
  })
})

describe('contentSafety — 放行用例（防误伤）', () => {
  it('放行：标准元数据查询', () => {
    expect(detectUnsafeContent('GB/T 1.1-2020 是什么标准')).toBeNull()
  })

  it('放行：纯日常对话', () => {
    expect(detectUnsafeContent('你好，介绍一下自己')).toBeNull()
  })

  it('放行："成人教育" 不应命中（与"成人电影"区分）', () => {
    expect(detectUnsafeContent('成人教育相关的国家标准')).toBeNull()
  })

  it('放行：合规咨询（不涉及人名/敏感词）', () => {
    expect(detectUnsafeContent('该标准适用于哪些行业')).toBeNull()
  })

  it('空输入返回 null', () => {
    expect(detectUnsafeContent(null)).toBeNull()
    expect(detectUnsafeContent(undefined)).toBeNull()
    expect(detectUnsafeContent('')).toBeNull()
  })
})

describe('detectSensitiveWord — 销售场景叠加（contentSafety + 90 词小词库）', () => {
  it('销售 bio 命中第三方词库（政治）', () => {
    const r = detectSensitiveWord('我支持习近平的政策')
    expect(r).toBeTruthy()
  })

  it('销售 bio 命中第三方词库（色情）', () => {
    const r = detectSensitiveWord('提供成人小说服务')
    expect(r).toBeTruthy()
  })

  it('销售 bio 命中本地小词库（竞品名）', () => {
    const r = detectSensitiveWord('比工标网更便宜')
    expect(r).toBe('工标网')
  })

  it('销售 bio 命中本地小词库（诈骗话术）', () => {
    const r = detectSensitiveWord('购买即可保证赚钱')
    expect(r).toBe('保证赚钱')
  })

  it('销售 bio 放行：正常自我介绍', () => {
    expect(detectSensitiveWord('十年标准化咨询经验，服务过央企客户')).toBeNull()
  })
})
